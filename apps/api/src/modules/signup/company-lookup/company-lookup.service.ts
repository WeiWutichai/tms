import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { thaiTaxIdKind } from '@tms/domain';
import { isLocalEnv } from '../../../auth/tokens';
import { PrismaService } from '../../../db/prisma.service';
import { MockRegistry } from './fixtures';
import { RD_TIN_URL, RD_VAT_URL, RdSoapRegistry } from './rd-soap';
import { type CompanyRegistry, type RegistryCompany, RegistryUnavailable } from './types';

/**
 * ค้นข้อมูลบริษัทตอนสมัคร (P1-ST2-T04; spec/01 PLT-021/023; research/company-verification §7.1–7.2)
 *
 * ลำดับ: (บุคคลธรรมดา → ไม่ส่งเลขออก) → cache → circuit breaker → RD VAT Service → (ไม่พบ) RD TIN Service
 * - cache `company_lookup`: พบ (vat_found / tin_exists) 24 ชม. · ไม่พบ 1 ชม. · ล้มเหลวไม่ cache
 * - log ทุกการส่งเลขออก `company_lookup_log` (หน่วยงาน, บริการ, เลข, ผล, เวลา) — PDPA accountability · append-only
 * - circuit breaker: 5 ครั้งล่าสุดที่ส่งไปหน่วยงานเดียวกันล้มเหลวทั้งหมด → เปิดวงจร 5 นาทีนับจากครั้งล่าสุด
 *   (นับจาก log ในฐาน — ทุก instance เห็นสถานะเดียวกัน) · ระหว่างเปิด = `unavailable` (ทุกเคส → pending_verification)
 * - เรียกจาก server เท่านั้น · concurrency ≤ 2 ต่อ process (`RD_LOOKUP_CONCURRENCY` 1–2)
 *
 * ผู้ให้บริการ `COMPANY_LOOKUP_PROVIDER`: `rd` (SOAP กรมสรรพากร — `RD_VAT_URL`/`RD_TIN_URL`) · `mock` (ข้อมูลตัวอย่าง) · `disabled`
 * ไม่ตั้ง = `mock` ใน dev/test · `disabled` นอกนั้น — เปิด `rd` ตอน go-live หลังทดสอบ WSDL จริง (research §8 ข้อ 1)
 *
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้]
 * - เลขบุคคลธรรมดา (หลักแรก ≠ 0) ไม่ส่งออกไป RD จนกว่าฐาน PDPA ชัด (spec/01 PLT-022 [OPEN: PDPA], X-06) → `individual`
 * - "ล้มเหลว" = timeout / HTTP ไม่ใช่ 2xx / เครือข่าย / SOAP Fault / ตอบผิดรูป — "ไม่พบ" ไม่นับ
 * - timeout ต่อคำขอ 5 วินาที (`RD_LOOKUP_TIMEOUT_MS`) · รอคิว concurrency ได้ 15 วินาที (เกิน = unavailable ไม่นับเป็นล้มเหลว)
 * - concurrency นับต่อ process — ถ้า deploy API หลาย instance ให้ตั้ง `RD_LOOKUP_CONCURRENCY=1` (ยังไม่มีตัวนับกลาง)
 */
export const LOOKUP_FOUND_TTL_MS = 24 * 3_600_000;
export const LOOKUP_NOT_FOUND_TTL_MS = 3_600_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 5 * 60_000;
export const LOOKUP_RAW_RETENTION_MS = 90 * 86_400_000;
const QUEUE_WAIT_MS = 15_000;
const AGENCY = 'RD';

export type LookupResult = 'vat_found' | 'tin_exists' | 'not_found' | 'unavailable' | 'individual';

export interface LookupOutcome {
  result: LookupResult;
  source: 'rd_vat' | 'rd_tin' | null;
  company: RegistryCompany | null;
  lookupId: string | null;
  cached: boolean;
  /** เหตุที่ unavailable: breaker_open / disabled / timeout / http_error / … */
  reason: string | null;
}

export function lookupProvider(env = process.env): 'rd' | 'mock' | 'disabled' {
  const v = env.COMPANY_LOOKUP_PROVIDER?.trim().toLowerCase();
  if (v === 'rd' || v === 'mock' || v === 'disabled') return v;
  return isLocalEnv() ? 'mock' : 'disabled';
}

function registry(env = process.env): CompanyRegistry | null {
  const p = lookupProvider(env);
  if (p === 'mock') return new MockRegistry();
  if (p === 'rd')
    return new RdSoapRegistry({
      vatUrl: env.RD_VAT_URL || RD_VAT_URL,
      tinUrl: env.RD_TIN_URL || RD_TIN_URL,
    });
  return null;
}

/** semaphore ง่าย ๆ ต่อ process (รอคิวได้ไม่เกิน waitMs) */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: () => number) {}
  get inFlight() {
    return this.active;
  }
  async acquire(waitMs: number): Promise<(() => void) | null> {
    if (this.active < this.max()) {
      this.active++;
      return this.releaser();
    }
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(null);
      }, waitMs);
      this.queue.push(grant);
    });
  }
  private releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

const concurrency = () => Math.min(2, Math.max(1, Number(process.env.RD_LOOKUP_CONCURRENCY) || 2));
const timeoutMs = () => Math.max(100, Number(process.env.RD_LOOKUP_TIMEOUT_MS) || 5_000);

@Injectable()
export class CompanyLookupService {
  private readonly log = new Logger('CompanyLookup');
  /** concurrency ≤ 2 ต่อ process — ทุกคำขอไปหน่วยงานภายนอกผ่านตัวนี้ */
  static readonly gate = new Semaphore(concurrency);

  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.platform;
  }

  /** วงจรเปิดอยู่ไหม — 5 ครั้งล่าสุดของผู้ให้บริการนี้ล้มเหลวทั้งหมด และครั้งล่าสุดไม่เกิน 5 นาที */
  async breakerOpenUntil(provider: string, now = Date.now()): Promise<Date | null> {
    const last = await this.db.companyLookupLog.findMany({
      where: { agency: AGENCY, provider },
      orderBy: { createdAt: 'desc' },
      take: BREAKER_FAILURES,
      select: { outcome: true, createdAt: true },
    });
    if (last.length < BREAKER_FAILURES || last.some((r) => r.outcome !== 'error')) return null;
    const until = new Date(last[0]!.createdAt.getTime() + BREAKER_OPEN_MS);
    return until.getTime() > now ? until : null;
  }

  private async cached(taxId: string, branchCode: string, now: number) {
    return this.db.companyLookup.findFirst({
      where: { taxId, branchCode, expiresAt: { gt: new Date(now) } },
      orderBy: { fetchedAt: 'desc' },
    });
  }

  /** เรียกปลายทาง 1 ครั้ง (ผ่าน gate + timeout) และลง log ทุกครั้งที่ส่งเลขออก */
  private async call<T>(
    reg: CompanyRegistry,
    service: 'vat' | 'tin',
    taxId: string,
    branchCode: string | null,
    sessionId: string | null,
    fn: (signal: AbortSignal) => Promise<T & { httpStatus: number | null }>,
    found: (r: T) => boolean,
  ): Promise<T | RegistryUnavailable> {
    const release = await CompanyLookupService.gate.acquire(QUEUE_WAIT_MS);
    if (!release) return new RegistryUnavailable('timeout');
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs());
    let out: T | RegistryUnavailable;
    try {
      out = await fn(ac.signal);
    } catch (e) {
      out =
        e instanceof RegistryUnavailable
          ? e
          : new RegistryUnavailable(ac.signal.aborted ? 'timeout' : 'bad_response');
    } finally {
      clearTimeout(timer);
      release();
    }
    const err = out instanceof RegistryUnavailable ? out : null;
    await this.db.companyLookupLog.create({
      data: {
        agency: AGENCY,
        service,
        provider: reg.provider,
        taxId,
        branchCode,
        outcome: err ? 'error' : found(out as T) ? 'found' : 'not_found',
        httpStatus: err ? err.httpStatus : (out as T & { httpStatus: number | null }).httpStatus,
        durationMs: Math.max(0, Date.now() - started),
        errorCode: err?.code ?? null,
        signupSessionId: sessionId,
      },
    });
    if (err)
      this.log.warn(
        `RD ${service} lookup failed: ${err.code}${err.httpStatus ? ` ${err.httpStatus}` : ''}`,
      );
    return out;
  }

  private async store(
    taxId: string,
    branchCode: string,
    result: 'vat_found' | 'tin_exists' | 'not_found',
    source: 'rd_vat' | 'rd_tin',
    provider: string,
    company: RegistryCompany | null,
    raw: string,
    now: number,
  ) {
    return this.db.companyLookup.create({
      data: {
        taxId,
        branchCode,
        result,
        source,
        provider,
        data: (company ?? undefined) as Prisma.InputJsonValue | undefined,
        rawResponse: raw,
        fetchedAt: new Date(now),
        expiresAt: new Date(
          now + (result === 'not_found' ? LOOKUP_NOT_FOUND_TTL_MS : LOOKUP_FOUND_TTL_MS),
        ),
      },
    });
  }

  async lookup(
    taxId: string,
    branchCode: string,
    ctx: { sessionId?: string | null } = {},
  ): Promise<LookupOutcome> {
    const none = (result: LookupResult, reason: string | null = null): LookupOutcome => ({
      result,
      source: null,
      company: null,
      lookupId: null,
      cached: false,
      reason,
    });
    if (thaiTaxIdKind(taxId) === 'individual') return none('individual');
    const now = Date.now();
    const hit = await this.cached(taxId, branchCode, now);
    if (hit)
      return {
        result: hit.result as LookupOutcome['result'],
        source: hit.source as LookupOutcome['source'],
        company: (hit.data as unknown as RegistryCompany | null) ?? null,
        lookupId: hit.id,
        cached: true,
        reason: null,
      };
    const reg = registry();
    if (!reg) return none('unavailable', 'disabled');
    if (await this.breakerOpenUntil(reg.provider, now)) return none('unavailable', 'breaker_open');
    const sid = ctx.sessionId ?? null;
    const branchNumber = Number(branchCode);
    const vat = await this.call(
      reg,
      'vat',
      taxId,
      branchCode,
      sid,
      (signal) => reg.vat(taxId, branchNumber, signal),
      (r) => r.found,
    );
    if (vat instanceof RegistryUnavailable) return none('unavailable', vat.code);
    if (vat.found) {
      const row = await this.store(
        taxId,
        branchCode,
        'vat_found',
        'rd_vat',
        reg.provider,
        vat.company,
        vat.raw,
        Date.now(),
      );
      return {
        result: 'vat_found',
        source: 'rd_vat',
        company: vat.company,
        lookupId: row.id,
        cached: false,
        reason: null,
      };
    }
    const tin = await this.call(
      reg,
      'tin',
      taxId,
      null,
      sid,
      (signal) => reg.tin(taxId, signal),
      (r) => r.exists,
    );
    if (tin instanceof RegistryUnavailable) return none('unavailable', tin.code);
    const result = tin.exists ? 'tin_exists' : 'not_found';
    const row = await this.store(
      taxId,
      branchCode,
      result,
      'rd_tin',
      reg.provider,
      null,
      `${vat.raw}\n${tin.raw}`,
      Date.now(),
    );
    return {
      result,
      source: 'rd_tin',
      company: null,
      lookupId: row.id,
      cached: false,
      reason: null,
    };
  }

  /**
   * เลขซ้ำ tenant เดิม (PLT-021 ขั้นแรก, PLT-022) — นิติบุคคล (`company`) ของ tenant จริง (ไม่นับ sandbox) ที่ใช้เลขนี้
   * - สาขา 00000: มีนิติบุคคลเลขนี้ = ซ้ำ · สาขาอื่น: มีสาขารหัสนี้ใต้นิติบุคคลนั้น = ซ้ำ ไม่งั้น = "เลขเดียวกันสาขาต่าง" (สร้างได้ + ธง)
   * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] นับทุกสถานะ tenant/นิติบุคคล (รวมยกเลิก/ปิด) — ส่งให้ทีมดูแทนสร้างซ้ำ
   */
  async duplicate(
    taxId: string,
    branchCode: string,
  ): Promise<{
    duplicate: { tenantId: string; companyName: string; branchLabel: string | null } | null;
    sameTaxOtherBranch: boolean;
  }> {
    const rows = await this.db.$queryRaw<
      { tenant_id: string; legal_name: string; branch_label: string | null; has_branch: boolean }[]
    >`
      SELECT c.tenant_id::text, c.legal_name, b.branch_label, (b.id IS NOT NULL) AS has_branch
        FROM company c
        JOIN tenant t ON t.id = c.tenant_id AND t.mode = 'live'
        LEFT JOIN branch b ON b.company_id = c.id AND b.branch_code = ${branchCode}
       WHERE c.tax_id = ${taxId}
       ORDER BY c.created_at ASC`;
    const hit =
      branchCode === '00000'
        ? (rows.find((r) => r.has_branch) ?? rows[0])
        : rows.find((r) => r.has_branch);
    return {
      duplicate: hit
        ? { tenantId: hit.tenant_id, companyName: hit.legal_name, branchLabel: hit.branch_label }
        : null,
      sameTaxOtherBranch: !hit && rows.length > 0,
    };
  }
}

/** งานรายวัน: ล้าง raw response ที่เก่ากว่า 90 วัน (PLT-023) + ลบแถว cache ที่หมดอายุและล้าง raw แล้ว */
export async function companyLookupMaintenance(
  db: PrismaService['platform'],
  now = Date.now(),
): Promise<{ rawPurged: number }> {
  const r = await db.companyLookup.updateMany({
    where: {
      rawResponse: { not: null },
      fetchedAt: { lte: new Date(now - LOOKUP_RAW_RETENTION_MS) },
    },
    data: { rawResponse: null, rawPurgedAt: new Date(now) },
  });
  return { rawPurged: r.count };
}
