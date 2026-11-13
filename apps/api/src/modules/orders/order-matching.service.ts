import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  buildMatchIndex,
  isLearnableKey,
  keyOwners,
  matchKey,
  matchText,
  scopeAllows,
  type MatchIndex,
  type MatchMethod,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { cleanLine, lockKey, lockReferenced } from '../master/master-kit';
import { SitesService } from '../sites/sites.service';

/** รายการแนะนำ (เก็บใน `match_candidates` / `customer_candidates` — id เป็น uuid; API แปลงเป็น public id) */
export interface MatchSuggestion {
  id: string;
  code: string;
  name: string;
  score: number;
}

export interface CustomerMatch {
  customerId: string | null;
  method: 'EXTERNAL_ID' | 'ALIAS' | null;
  candidates: MatchSuggestion[];
}

export interface SiteMatch {
  siteId: string | null;
  method: MatchMethod | null;
  score: number | null;
  candidates: MatchSuggestion[];
}

interface ScopeSite {
  id: string;
  code: string;
  name: string;
  aliases: string[];
  customerId: string | null;
}

/** สถานที่ในขอบเขต + ดัชนีคีย์ (สร้างครั้งเดียวต่อการประเมินใบ ใช้กับทุกจุด) */
export interface SiteScope {
  customerId: string | null;
  sites: Map<string, ScopeSite>;
  index: MatchIndex;
}

/** เพดานข้อมูลหลักที่โหลดมาเทียบต่อครั้ง (บริษัท 10–200 คัน — สถานที่/ลูกค้าหลักร้อยถึงพัน) — ถึงเพดาน = log เตือน */
const SCOPE_LIMIT = 5000;
/** สิทธิ์แก้ข้อมูลหลักสถานที่ (docs/04 A3) — ต้องมีจึงสอน alias ให้สถานที่ของบริษัท (ใช้กับทุกลูกค้า) */
const SITE_WRITE_SCOPE = 'master:write';

export type AliasLearnResult =
  | 'learned'
  | 'exists'
  | 'name'
  | 'full'
  | 'too_long'
  | 'empty'
  | 'generic'
  | 'conflict'
  | 'not_permitted';

/**
 * จับคู่อัตโนมัติ (ST3-T06; docs/04 C) — **อ่านอย่างเดียว** สำหรับ order (ไม่เขียน sales_order* — คนเขียนคือ
 * OrderIntakeService ที่เดียว) · เขียนเฉพาะ alias ที่เรียนรู้ (customer_site.aliases ผ่าน SitesService / customer_alias)
 *
 * ลูกค้า: alias รหัสของช่องทางนี้ที่คนจับคู่ไว้ (`customer_alias` EXTERNAL_ID — **ชนะ** `customer.external_id` เพราะคนตัดสินแล้ว)
 *   → `customer.external_id` ตรงตัว → (ไม่มีรหัส) alias ชื่อ (NAME) · **ไม่จับคู่เองด้วยความคล้ายของชื่อ** (ลูกค้าผิด = บิลผิด)
 * สถานที่: ขอบเขต = สถานที่ของลูกค้าของ order + สถานที่ของบริษัท (customer_id null) ที่ใช้งานอยู่ (กติกาเดียวกับ T01/T13)
 *   → `matchText` (alias/ชื่อตรงตัว — ชื่อซ้ำ: ของลูกค้าเองชนะของบริษัท → ความคล้ายเกินเกณฑ์และไม่กำกวม) · ไม่ถึงเกณฑ์ = แนะนำ
 */
@Injectable()
export class OrderMatchingService {
  private readonly logger = new Logger(OrderMatchingService.name);

  constructor(
    private readonly sites: SitesService,
    private readonly audit: AuditService,
  ) {}

  async matchCustomer(
    tx: Tx,
    q: { externalId: string | null; text: string | null; source: string },
  ): Promise<CustomerMatch> {
    const active = async (id: string | undefined) =>
      id && (await lockReferenced(tx, 'customer', [id]))[0]?.status === 'ACTIVE' ? id : null;
    if (q.externalId) {
      const alias = await tx.customerAlias.findFirst({
        where: { kind: 'EXTERNAL_ID', source: q.source, valueKey: q.externalId },
        select: { customerId: true },
      });
      const viaAlias = await active(alias?.customerId);
      if (viaAlias) return { customerId: viaAlias, method: 'ALIAS', candidates: [] };
      const byExt = await tx.customer.findFirst({
        where: { externalId: q.externalId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      const id = await active(byExt?.id);
      if (id) return { customerId: id, method: 'EXTERNAL_ID', candidates: [] };
    } else if (q.text) {
      const key = matchKey(q.text);
      const alias = key
        ? await tx.customerAlias.findFirst({
            where: { kind: 'NAME', source: '', valueKey: key },
            select: { customerId: true },
          })
        : null;
      const viaAlias = await active(alias?.customerId);
      if (viaAlias) return { customerId: viaAlias, method: 'ALIAS', candidates: [] };
    }
    return { customerId: null, method: null, candidates: await this.customerSuggestions(tx, q) };
  }

  /** ลูกค้าที่ชื่อคล้ายข้อความต้นทาง (แนะนำเท่านั้น) — ใช้ชื่อตามกฎหมาย + รหัส + alias ชื่อที่เคยเรียนรู้ */
  private async customerSuggestions(
    tx: Tx,
    q: { externalId: string | null; text: string | null },
  ): Promise<MatchSuggestion[]> {
    const text = q.text ?? q.externalId;
    if (!text || !matchKey(text)) return [];
    const rows = await tx.customer.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true, code: true, legalName: true, aliases: { select: { value: true } } },
      orderBy: { code: 'asc' },
      take: SCOPE_LIMIT,
    });
    if (rows.length >= SCOPE_LIMIT)
      this.logger.warn(`customer suggestions: scope limit ${SCOPE_LIMIT} reached — list truncated`);
    const r = matchText(
      text,
      rows.map((c) => ({
        id: c.id,
        name: c.legalName,
        aliases: [c.code, ...c.aliases.map((a) => a.value)],
      })),
      { allowFuzzy: false },
    );
    const byId = new Map(rows.map((c) => [c.id, c]));
    // ตรงตัวกับชื่อ/รหัส ก็ยังเป็นแค่คำแนะนำ — ลูกค้าต้องให้คนยืนยัน
    const list = r.id ? [{ id: r.id, score: 1 }] : r.candidates;
    return list.map(({ id, score }) => ({
      id,
      code: byId.get(id)!.code,
      name: byId.get(id)!.legalName,
      score,
    }));
  }

  /**
   * สถานที่ในขอบเขต (ใช้งานอยู่) + ดัชนี — `customerId` = สถานที่ของลูกค้านั้น (ชนะเมื่อชื่อซ้ำกับของบริษัท) + ของบริษัท
   * `allSites` = ทุกสถานที่ของ tenant (ใช้ตรวจ alias ชนเมื่อสอนสถานที่ของบริษัท ซึ่งมีผลกับทุกลูกค้า)
   */
  async siteScope(tx: Tx, customerId: string | null, allSites = false): Promise<SiteScope> {
    const rows = await tx.customerSite.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        ...(allSites
          ? {}
          : { OR: [{ customerId: null }, ...(customerId ? [{ customerId }] : [])] }),
      },
      select: { id: true, code: true, name: true, aliases: true, customerId: true },
      orderBy: { code: 'asc' },
      take: SCOPE_LIMIT,
    });
    if (rows.length >= SCOPE_LIMIT)
      this.logger.warn(
        `site matching: scope limit ${SCOPE_LIMIT} reached (customer ${customerId ?? 'none'}) — some sites not compared`,
      );
    return {
      customerId,
      sites: new Map(rows.map((r) => [r.id, r])),
      index: buildMatchIndex(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          aliases: r.aliases,
          preferred: !!customerId && r.customerId === customerId,
        })),
      ),
    };
  }

  matchSite(text: string, scope: SiteScope): SiteMatch {
    const r = matchText(text, scope.index);
    return {
      siteId: r.id,
      method: r.method,
      score: r.score,
      candidates: r.id
        ? []
        : r.candidates.map(({ id, score }) => ({
            id,
            code: scope.sites.get(id)!.code,
            name: scope.sites.get(id)!.name,
            score,
          })),
    };
  }

  /**
   * คนจับคู่ข้อความสถานที่ → สถานที่ — เรียนรู้ alias บนสถานที่นั้น (ขอบเขตตามเจ้าของสถานที่: ของลูกค้า = ใช้กับลูกค้านั้น)
   * ไม่เรียนรู้ (แต่ยังจับคู่ใบนี้) เมื่อ:
   * - ข้อความทั่วไป/สั้นเกิน (`generic` — "คลัง", "ร้าน" …)
   * - สถานที่ของบริษัท (มีผลกับทุกลูกค้า) และผู้ทำไม่มีสิทธิ์แก้ข้อมูลหลักสถานที่ (`not_permitted`) [OPEN #54]
   * - คีย์เดียวกันเป็นชื่อ/alias ของสถานที่อื่นในขอบเขตที่ alias นี้มีผล (`conflict` — กัน alias "วางยา" ให้ใบอื่นวิ่งผิดที่)
   */
  async learnSiteAlias(tx: Tx, siteId: string, text: string): Promise<AliasLearnResult> {
    const key = matchKey(text);
    if (!key) return 'empty';
    if (!isLearnableKey(key, 'site')) return 'generic';
    const site = await tx.customerSite.findUniqueOrThrow({
      where: { id: siteId },
      select: { customerId: true },
    });
    if (!site.customerId && !scopeAllows(requestContext.require().scopes ?? [], SITE_WRITE_SCOPE))
      return 'not_permitted';
    // ล็อกตามคีย์ (ต่อ tenant) ก่อนตรวจชน — สองคำขอสอนข้อความเดียวกันให้คนละแห่งพร้อมกัน: แห่งแรกจำ แห่งหลังเห็นแล้ว = conflict
    await lockKey(tx, `site_alias:${key}`);
    const scope = await this.siteScope(tx, site.customerId, !site.customerId);
    if (keyOwners(scope.index, key, siteId).length) return 'conflict';
    return this.sites.learnAlias(tx, siteId, text);
  }

  /**
   * คนจับคู่ลูกค้าของ order — มีรหัสต้นทาง = alias รหัสของช่องทางนั้น (EXTERNAL_ID) · ไม่มีรหัส = alias ชื่อ (NAME — ต้องมีสาระ)
   * เคยผูกกับลูกค้าอื่น → **ไม่ย้ายเอง**: 409 `alias_conflict` จนกว่าจะส่ง `confirmReassign` + เหตุผล (audit เหตุผล + ลูกค้าเดิม)
   * ต้องเรียกก่อนแก้ใบ (409 แล้วใบไม่เปลี่ยน) · insert ON CONFLICT DO NOTHING แล้วอ่านซ้ำ — สองคำขอพร้อมกันไม่ย้ายกันเงียบ ๆ
   */
  async learnCustomerAlias(
    tx: Tx,
    q: {
      customerId: string;
      externalId: string | null;
      text: string | null;
      source: string;
      confirmReassign?: boolean;
      reason?: string | null;
    },
  ): Promise<AliasLearnResult> {
    const ctx = requestContext.require();
    const kind = q.externalId ? 'EXTERNAL_ID' : 'NAME';
    const value = cleanLine(q.externalId ?? q.text ?? '');
    const valueKey = q.externalId ? value : matchKey(value);
    if (!valueKey) return 'empty';
    if (value.length > 500) return 'too_long';
    if (kind === 'NAME' && !isLearnableKey(valueKey, 'customer')) return 'generic';
    const source = kind === 'EXTERNAL_ID' ? q.source : '';
    await lockKey(tx, `customer_alias:${kind}:${source}:${valueKey}`);
    const owner = async () =>
      (
        await tx.$queryRaw<{ customer_id: string }[]>`
          SELECT customer_id::text FROM customer_alias
           WHERE kind = ${kind} AND source = ${source} AND value_key = ${valueKey} FOR UPDATE`
      )[0]?.customer_id;
    let prev = await owner();
    if (!prev) {
      const n = await tx.$executeRaw`
        INSERT INTO customer_alias (id, tenant_id, customer_id, kind, source, value, value_key, created_by)
        VALUES (gen_random_uuid(), ${ctx.tenantId!}::uuid, ${q.customerId}::uuid, ${kind}, ${source}, ${value},
                ${valueKey}, ${ctx.actorId ?? null})
        ON CONFLICT (tenant_id, kind, source, value_key) DO NOTHING`;
      if (n === 1) {
        await this.audit.record({
          action: 'customer.alias_learned',
          entityType: 'customer',
          entityId: q.customerId,
          after: { kind, source: source || null, value },
        });
        return 'learned';
      }
      prev = await owner(); // อีกคำขอเพิ่งเพิ่ม — ตัดสินแบบเดียวกับมีอยู่แล้ว
    }
    if (prev === q.customerId) return 'exists';
    if (!q.confirmReassign || !q.reason)
      throw new ProblemException('alias_conflict', undefined, undefined, {
        aliasKind: kind,
        aliasValue: value,
        mappedCustomerId: encodeId('customer', prev!),
      });
    await tx.$executeRaw`
      UPDATE customer_alias SET customer_id = ${q.customerId}::uuid, value = ${value},
             created_by = ${ctx.actorId ?? null}, updated_at = now()
       WHERE kind = ${kind} AND source = ${source} AND value_key = ${valueKey}`;
    await this.audit.record({
      action: 'customer.alias_reassigned',
      entityType: 'customer',
      entityId: q.customerId,
      before: { aliasOf: encodeId('customer', prev!) },
      after: { kind, source: source || null, value },
      reason: q.reason,
    });
    return 'learned';
  }
}

/** รายการแนะนำ → JSON ที่เก็บ (null = ไม่มี) */
export function suggestionsJson(
  list: MatchSuggestion[],
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return list.length ? (list as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
}
