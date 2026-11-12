import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { matchKey, matchText, type MatchMethod } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { cleanLine, lockReferenced } from '../master/master-kit';
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

/** เพดานข้อมูลหลักที่โหลดมาเทียบต่อครั้ง (บริษัท 10–200 คัน — สถานที่/ลูกค้าหลักร้อยถึงพัน) */
const SCOPE_LIMIT = 5000;
export type AliasLearnResult = 'learned' | 'exists' | 'name' | 'full' | 'too_long' | 'empty';

/**
 * จับคู่อัตโนมัติ (ST3-T06; docs/04 C) — **อ่านอย่างเดียว** สำหรับ order (ไม่เขียน sales_order* — คนเขียนคือ
 * OrderIntakeService ที่เดียว) · เขียนเฉพาะ alias ที่เรียนรู้ (customer_site.aliases ผ่าน SitesService / customer_alias)
 *
 * ลูกค้า: `customer.external_id` ตรงตัว → alias รหัสของช่องทางนี้ (`customer_alias` EXTERNAL_ID) → (ไม่มีรหัส) alias ชื่อ
 *   (NAME, ไม่สนช่องว่าง/คำนิติบุคคล) · **ไม่จับคู่เองด้วยความคล้ายของชื่อ** (ลูกค้าผิด = บิลผิด) — ใช้แนะนำเท่านั้น
 * สถานที่: ขอบเขต = สถานที่ของลูกค้าของ order + สถานที่ของบริษัท (customer_id null) ที่ใช้งานอยู่ (กติกาเดียวกับ T01/T13)
 *   → `matchText` (alias ตรงตัว → ชื่อตรงตัว → ความคล้ายเกินเกณฑ์และไม่กำกวม) · ไม่ถึงเกณฑ์ = รายการแนะนำ
 */
@Injectable()
export class OrderMatchingService {
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
      const byExt = await tx.customer.findFirst({
        where: { externalId: q.externalId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      const id = await active(byExt?.id);
      if (id) return { customerId: id, method: 'EXTERNAL_ID', candidates: [] };
      const alias = await tx.customerAlias.findFirst({
        where: { kind: 'EXTERNAL_ID', source: q.source, valueKey: q.externalId },
        select: { customerId: true },
      });
      const viaAlias = await active(alias?.customerId);
      if (viaAlias) return { customerId: viaAlias, method: 'ALIAS', candidates: [] };
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

  /** ลูกค้าที่ชื่อคล้ายข้อความต้นทาง (แนะนำเท่านั้น) — ใช้ชื่อตามกฎหมาย + alias ชื่อที่เคยเรียนรู้ */
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
    // ตรงตัวกับชื่อ/รหัส (method != null) ก็ยังเป็นแค่คำแนะนำ — ลูกค้าต้องให้คนยืนยัน
    const list = r.id ? [{ id: r.id, score: 1 }] : r.candidates;
    return list.map(({ id, score }) => ({
      id,
      code: byId.get(id)!.code,
      name: byId.get(id)!.legalName,
      score,
    }));
  }

  /** สถานที่ในขอบเขตของ order (ลูกค้า + ของบริษัท) ที่ใช้งานอยู่ — โหลดครั้งเดียวต่อการประเมิน */
  async siteScope(tx: Tx, customerId: string | null): Promise<ScopeSite[]> {
    return tx.customerSite.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        OR: [{ customerId: null }, ...(customerId ? [{ customerId }] : [])],
      },
      select: { id: true, code: true, name: true, aliases: true, customerId: true },
      orderBy: { code: 'asc' },
      take: SCOPE_LIMIT,
    });
  }

  matchSite(text: string, scope: ScopeSite[]): SiteMatch {
    const r = matchText(text, scope);
    const byId = new Map(scope.map((s) => [s.id, s]));
    return {
      siteId: r.id,
      method: r.method,
      score: r.score,
      candidates: r.id
        ? []
        : r.candidates.map(({ id, score }) => ({
            id,
            code: byId.get(id)!.code,
            name: byId.get(id)!.name,
            score,
          })),
    };
  }

  /**
   * คนจับคู่ข้อความสถานที่ → สถานที่ — เรียนรู้ alias บนสถานที่นั้น (ขอบเขตตามเจ้าของสถานที่: ของลูกค้า = ใช้กับลูกค้านั้น,
   * ของบริษัท = ทุกลูกค้า) · ชื่อซ้ำในขอบเขต → บังคับเพิ่ม alias เพื่อชี้ขาด
   */
  async learnSiteAlias(
    tx: Tx,
    siteId: string,
    text: string,
    scope: ScopeSite[],
  ): Promise<AliasLearnResult> {
    const key = matchKey(text);
    const sameName = scope.filter((s) => matchKey(s.name) === key).length;
    return this.sites.learnAlias(tx, siteId, text, { disambiguate: sameName > 1 });
  }

  /**
   * คนจับคู่ลูกค้าของ order — มีรหัสต้นทาง = alias รหัสของช่องทางนั้น (EXTERNAL_ID) · ไม่มีรหัส = alias ชื่อ (NAME)
   * เคยผูกกับลูกค้าอื่น → ย้ายมาลูกค้าที่คนเลือกล่าสุด (audit before/after) · unique (tenant, kind, source, key) + upsert กันชนพร้อมกัน
   */
  async learnCustomerAlias(
    tx: Tx,
    q: { customerId: string; externalId: string | null; text: string | null; source: string },
  ): Promise<AliasLearnResult> {
    const ctx = requestContext.require();
    const kind = q.externalId ? 'EXTERNAL_ID' : 'NAME';
    const value = cleanLine(q.externalId ?? q.text ?? '');
    const valueKey = q.externalId ? value : matchKey(value);
    if (!valueKey) return 'empty';
    if (value.length > 500) return 'too_long';
    const source = kind === 'EXTERNAL_ID' ? q.source : '';
    const prev = await tx.$queryRaw<{ customer_id: string }[]>`
      SELECT customer_id::text FROM customer_alias
       WHERE kind = ${kind} AND source = ${source} AND value_key = ${valueKey} FOR UPDATE`;
    if (prev[0]?.customer_id === q.customerId) return 'exists';
    await tx.$executeRaw`
      INSERT INTO customer_alias (id, tenant_id, customer_id, kind, source, value, value_key, created_by)
      VALUES (gen_random_uuid(), ${ctx.tenantId!}::uuid, ${q.customerId}::uuid, ${kind}, ${source}, ${value},
              ${valueKey}, ${ctx.actorId ?? null})
      ON CONFLICT (tenant_id, kind, source, value_key)
      DO UPDATE SET customer_id = EXCLUDED.customer_id, value = EXCLUDED.value,
                    created_by = EXCLUDED.created_by, updated_at = now()`;
    await this.audit.record({
      action: 'customer.alias_learned',
      entityType: 'customer',
      entityId: q.customerId,
      before: prev[0] ? { aliasOf: encodeId('customer', prev[0].customer_id) } : undefined,
      after: { kind, source: source || null, value },
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
