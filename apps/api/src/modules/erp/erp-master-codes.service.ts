import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type Connector, type ErpMasterCode, Prisma } from '@prisma/client';
import {
  ERP_MASTER_CODE_KINDS,
  type ErpItemMappingStatus,
  type ErpMasterCodeKind,
  type ErpOperation,
  erpItemMappingStatus,
  resolveErpMasterCode,
} from '@tms/domain';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { ImportRegistry } from '../imports/import-spec';
import { ConnectorsService, redactSecrets } from './connectors.service';
import { erpMasterCodeImportSpec } from './erp-master-code.import';
import { chunks, lockKind, rethrowUniqueAsConflict } from './erp-master-code.util';
import type {
  ErpItemMappingDto,
  ErpItemMappingListDto,
  ErpMasterCodeDto,
  ErpMasterCodeListQuery,
  ErpMasterSyncDto,
  ErpMasterSyncKindResultDto,
  ErpMasterSyncResultDto,
  SetErpItemMappingDto,
} from './erp-master-code.dto';
import type {
  CanonicalDocument,
  ErpAdapter,
  ErpContext,
  ErpMasterCodeEntry,
  MasterCodeRef,
  ResolvedMasterCodes,
} from './erp-adapter';
import { ErpAdapterRegistry } from './erp-adapter.registry';

/** เพดานเวลาดึงผังรหัส 1 ชนิด */
const FETCH_TIMEOUT_MS = 30_000;
/** เพดานจำนวนรหัสต่อชนิด (กัน adapter คืนข้อมูลล้น) */
export const MAX_MASTER_CODES_PER_KIND = 20_000;
/** รหัส ERP: 1–64 ตัว ไม่มีอักขระควบคุม ไม่ขึ้นต้น/ลงท้ายด้วยช่องว่าง */
export const ERP_CODE_RE = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,62}[^\s\p{Cc}])?$/u;
const RATE_RE = /^\d{1,3}(\.\d{1,2})?$/;
/** transaction ของการซิงก์ (เขียนได้หลายหมื่นแถว) */
const SYNC_TX_TIMEOUT_MS = 120_000;
const WRITE_CHUNK = 2_000;

/** หน้า mapping ในเว็บ (ลิงก์ในผลของคำสั่งที่ถูกกัน — docs/01 §7.4 "พร้อมลิงก์ไปหน้า mapping") */
export function mappingPageLink(connectorId: string): string {
  return `/settings?sec=conn&connector=${encodeId('connector', connectorId)}`;
}

/** ค่าบริการที่ทำให้เอกสารส่งเข้า ERP ไม่ได้ */
export interface MappingGap {
  serviceItemId: string;
  code: string | null;
  nameTh: string | null;
  itemCode: string | null;
  status: Exclude<ErpItemMappingStatus, 'MAPPED'> | 'NOT_FOUND';
}

export interface MappingCheck {
  /** service_item uuid → รหัสสินค้า ERP (ตามตัวพิมพ์ในผังรหัสถ้ามี) — เฉพาะที่ครบ */
  codes: Map<string, string>;
  gaps: MappingGap[];
}

/** ผลของประตูก่อนส่ง ERP เมื่อ mapping ไม่ครบ (เก็บใน last_error ของคำสั่ง — ST7-T19 แสดงในคิว) */
export interface MappingIncompleteProblem {
  code: 'erp_mapping_incomplete';
  message: string;
  link: string;
  missing: {
    serviceItemId: string;
    code: string | null;
    nameTh: string | null;
    itemCode: string | null;
    status: string;
  }[];
}

/** service_item ที่บรรทัดของ canonical document อ้าง (`lines[].serviceItem.id` — docs/01 §7.2) · id ได้ทั้งแบบ `svc_…` และ uuid */
export function documentServiceItemIds(doc: unknown): string[] {
  const lines = (doc as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines)) return [];
  const out = new Set<string>();
  for (const l of lines) {
    const raw = (l as { serviceItem?: { id?: unknown } } | null)?.serviceItem?.id;
    if (typeof raw !== 'string' || !raw) continue;
    out.add(tryDecodeId('serviceItem', raw) ?? raw);
  }
  return [...out];
}

/** ใส่รหัส ERP ที่จับคู่ลง `lines[].serviceItem.externalId` (docs/01 §7.2 "service_item + mapping") — คืนสำเนา */
export function withMappedItemCodes<T extends CanonicalDocument>(
  doc: T,
  codes: Map<string, string>,
): T {
  if (!Array.isArray((doc as { lines?: unknown }).lines)) return doc;
  const copy = structuredClone(doc) as T & {
    lines: Array<{ serviceItem?: Record<string, unknown> }>;
  };
  for (const l of copy.lines) {
    const raw = l?.serviceItem?.id;
    if (typeof raw !== 'string') continue;
    const code = codes.get(tryDecodeId('serviceItem', raw) ?? raw);
    if (code) l.serviceItem!.externalId = code;
  }
  return copy;
}

/** ST8-T06 ค่าในเอกสารที่ไม่ผ่านผังรหัส ERP (รวมค่าเดียวกันหลายบรรทัดเป็นรายการเดียว) */
export interface MasterCodeGap {
  kind: ErpMasterCodeKind;
  value: string | null;
  /** ช่องที่ใช้ค่านี้ (สูงสุด 5) */
  fields: string[];
  /** MISSING = ไม่มีค่า · UNKNOWN = ไม่อยู่ในผัง · AMBIGUOUS = ชื่อตรงหลายรหัส · NO_CATALOGUE = ยังไม่มีผังรหัสชนิดนี้ */
  status: 'MISSING' | 'UNKNOWN' | 'AMBIGUOUS' | 'NO_CATALOGUE';
}

/** ผลของประตูก่อนส่ง ERP เมื่อค่าในเอกสารไม่อยู่ในผังรหัส (เก็บใน last_error ของคำสั่ง) */
export interface MasterCodeUnknownProblem {
  code: 'erp_master_code_unknown';
  message: string;
  link: string;
  missing: MasterCodeGap[];
}

/** ผลรวมของประตูก่อนส่ง ERP (ST7-T18 mapping ค่าบริการ + ST8-T06 ผังรหัสที่ adapter ประกาศ) */
export type PushPreparation =
  | { ok: true; document: CanonicalDocument; masterCodes: ResolvedMasterCodes }
  | { ok: false; problem: MappingIncompleteProblem | MasterCodeUnknownProblem };

const KIND_TH: Record<ErpMasterCodeKind, string> = {
  UNIT: 'หน่วย',
  SALESPERSON: 'พนักงานขาย',
  ACCOUNT: 'ผังบัญชี',
  ITEM: 'รหัสสินค้า/บริการ',
  VAT_RATE: 'อัตรา VAT',
};
const MAX_FIELDS_PER_GAP = 5;

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * ผังรหัส ERP + การจับคู่ค่าบริการ ↔ รหัสสินค้า ERP ต่อ connector (ST7-T18; docs/04 G3 "Sync master ลงมา" + B; docs/01 §7.4)
 * - ผังรหัสมาจาก adapter (`fetchMasterCodes` — ผู้ดูแลกดซิงก์) หรือนำเข้าไฟล์ (import kind `erp_master_code`)
 * - ไม่มี hard delete: ซิงก์แล้วรหัสไม่อยู่ในชุด = active false · ยกเลิกการจับคู่ = item_code null
 * - **ประตูก่อนส่ง ERP** (`checkMapping`): ค่าบริการในเอกสารที่ยังไม่จับคู่/รหัสไม่รู้จัก → คำสั่ง push FAILED_FINAL(VALIDATION)
 *   `erp_mapping_incomplete` + ลิงก์หน้า mapping — ไม่กันการออกเอกสาร (plan/11 #9 standalone-first)
 * - อัตรา VAT ฝั่ง ERP เป็นข้อมูลให้ adapter เท่านั้น ไม่เปลี่ยนการคำนวณภาษีของ TMS
 */
@Injectable()
export class ErpMasterCodesService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly connectors: ConnectorsService,
    private readonly adapters: ErpAdapterRegistry,
    private readonly imports: ImportRegistry,
  ) {}

  onModuleInit() {
    const spec = erpMasterCodeImportSpec((tx, tenantId, connectorId, kind, rows, at) =>
      this.apply(tx, tenantId, connectorId, kind, rows, 'IMPORT', at, { replaceAll: false }),
    );
    if (!this.imports.get(spec.kind)) this.imports.register(spec);
  }

  toDto(r: ErpMasterCode): ErpMasterCodeDto {
    return {
      kind: r.kind,
      code: r.code,
      name: r.name,
      rate: r.rate === null ? null : r.rate.toFixed(2),
      source: r.source,
      active: r.active,
      syncedAt: r.syncedAt.toISOString(),
    };
  }

  /** ชนิดรหัสที่ adapter ของ connector ดึงได้ */
  fetchableKinds(c: Connector): ErpMasterCodeKind[] {
    const a = this.adapters.get(c.adapterKey);
    if (!a?.fetchMasterCodes) return [];
    const k = new Set(a.masterCodeKinds ?? []);
    return ERP_MASTER_CODE_KINDS.filter((x) => k.has(x));
  }

  async list(connectorId: string, q: ErpMasterCodeListQuery): Promise<ErpMasterCodeDto[]> {
    await this.connectors.get(connectorId);
    const rows = await this.db.tx.erpMasterCode.findMany({
      where: {
        connectorId,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.includeInactive ? {} : { active: true }),
      },
      orderBy: [{ kind: 'asc' }, { code: 'asc' }, { id: 'asc' }],
      take: MAX_MASTER_CODES_PER_KIND * ERP_MASTER_CODE_KINDS.length,
    });
    return rows.map((r) => this.toDto(r));
  }

  // ---------- ซิงก์จาก adapter ----------

  /** ตรวจรายการที่ adapter คืน — ข้ามแถวผิดรูป/ซ้ำ (ไม่สนตัวพิมพ์) */
  private clean(
    kind: ErpMasterCodeKind,
    list: unknown,
  ): { rows: ErpMasterCodeEntry[]; skipped: number } {
    if (!Array.isArray(list))
      throw new ProblemException('master_sync_failed', undefined, undefined, {
        kind,
        reason: 'invalid_response',
        message: 'adapter returned a non-array master code list',
      });
    const seen = new Set<string>();
    const rows: ErpMasterCodeEntry[] = [];
    let skipped = 0;
    for (const e of list.slice(0, MAX_MASTER_CODES_PER_KIND)) {
      const code = typeof e?.code === 'string' ? e.code.trim() : '';
      if (!ERP_CODE_RE.test(code) || seen.has(code.toLowerCase())) {
        skipped++;
        continue;
      }
      let rate: string | null = null;
      if (kind === 'VAT_RATE' && e.rate !== null && e.rate !== undefined) {
        if (typeof e.rate !== 'string' || !RATE_RE.test(e.rate) || Number(e.rate) > 100) {
          skipped++;
          continue;
        }
        rate = e.rate;
      }
      seen.add(code.toLowerCase());
      const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 200) : null;
      rows.push({ code, name, rate });
    }
    skipped += Math.max(0, list.length - MAX_MASTER_CODES_PER_KIND);
    return { rows, skipped };
  }

  /**
   * ซิงก์ผังรหัสจาก ERP (route @NoTransaction) — เรียก adapter นอก transaction ทุกชนิดก่อน แล้วบันทึกในรอบเดียว
   * ล้มชนิดใดชนิดหนึ่ง = ไม่เปลี่ยนอะไรเลย (409 `master_sync_failed`)
   */
  async sync(connectorId: string, body: ErpMasterSyncDto): Promise<ErpMasterSyncResultDto> {
    this.connectors.assertHuman();
    const tenantId = requestContext.require().tenantId!;
    const c = await this.db.withTenant(tenantId, (tx) => this.connectors.get(connectorId, tx));
    if (c.status === 'DISCONNECTED') throw new ProblemException('invalid_state_transition');
    const adapter = this.adapters.get(c.adapterKey);
    const can = this.fetchableKinds(c);
    if (!adapter?.fetchMasterCodes || !can.length)
      throw new ProblemException('master_sync_not_supported');
    const kinds = body.kinds?.length ? [...new Set(body.kinds)] : can;
    const bad = kinds.filter((k) => !can.includes(k as ErpMasterCodeKind));
    if (bad.length)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'kinds',
          code: 'kind_not_supported',
          message: `ระบบบัญชีนี้ดึงรหัสชนิด ${bad.join(', ')} ไม่ได้ — นำเข้าจากไฟล์แทน`,
        },
      ]);

    const ctx = this.connectors.contextOf(c);
    const secrets = c.credentialKeys.map((k) => ctx.config[k] ?? '');
    const fetched = new Map<ErpMasterCodeKind, { rows: ErpMasterCodeEntry[]; skipped: number }>();
    for (const kind of kinds as ErpMasterCodeKind[]) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const list = await Promise.race([
          adapter.fetchMasterCodes(ctx, kind),
          new Promise<never>((_, no) => {
            timer = setTimeout(
              () => no(new Error(`no answer within ${FETCH_TIMEOUT_MS} ms`)),
              FETCH_TIMEOUT_MS,
            );
          }),
        ]);
        fetched.set(kind, this.clean(kind, list));
      } catch (e) {
        if (e instanceof ProblemException) throw e;
        throw new ProblemException('master_sync_failed', undefined, undefined, {
          kind,
          message: redactSecrets(String((e as Error)?.message ?? e), secrets).slice(0, 300),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const at = new Date();
    const results = await this.db
      .withTenant(
        tenantId,
        async (tx) => {
          const out: ErpMasterSyncKindResultDto[] = [];
          for (const [kind, { rows, skipped }] of fetched)
            out.push({
              ...(await this.apply(tx, tenantId, c.id, kind, rows, 'ADAPTER', at, {
                replaceAll: true,
                allowEmpty: body.confirmEmpty === true,
              })),
              skipped,
            });
          await tx.auditLog.create({
            data: {
              tenantId,
              actorId: requestContext.require().actorId ?? null,
              actAs: requestContext.require().actAs ?? null,
              action: 'connector.master_codes_synced',
              entityType: 'connector',
              entityId: c.id,
              after: { results: out } as unknown as Prisma.InputJsonValue,
              requestId: requestContext.require().requestId,
              ip: requestContext.require().ip ?? null,
            },
          });
          return out;
        },
        SYNC_TX_TIMEOUT_MS,
      )
      .catch(rethrowUniqueAsConflict);
    return { results, syncedAt: at.toISOString() };
  }

  /**
   * เขียนรหัสของชนิดหนึ่ง (ใช้ทั้งซิงก์และนำเข้าไฟล์) — รหัสเดิมจับด้วย lower(code)
   * - ล็อก (connector, ชนิด) ด้วย advisory lock ของ transaction — ซิงก์/นำเข้าพร้อมกันไม่ชนกัน (รอคิว)
   * - เขียนแบบชุด: createMany + UPDATE … FROM unnest เฉพาะแถวที่เปลี่ยน + synced_at ของแถวที่ไม่เปลี่ยนในคำสั่งเดียว
   * - `replaceAll` (ซิงก์จาก adapter) = รหัสที่ไม่อยู่ในชุดถูกปิดใช้ · ชุดว่างทั้งที่เคยมีรหัสใช้งาน = ล้ม
   *   (`master_sync_failed` reason `empty_catalogue`) เว้นแต่ยืนยัน `allowEmpty` · นำเข้าไฟล์ไม่ปิดของอื่น
   */
  async apply(
    tx: Tx,
    tenantId: string,
    connectorId: string,
    kind: ErpMasterCodeKind,
    rows: (ErpMasterCodeEntry & { active?: boolean })[],
    source: 'ADAPTER' | 'IMPORT',
    at: Date,
    opts: { replaceAll: boolean; allowEmpty?: boolean },
  ): Promise<Omit<ErpMasterSyncKindResultDto, 'skipped'>> {
    await lockKind(tx, connectorId, kind);
    const existing = await tx.erpMasterCode.findMany({
      where: { connectorId, kind },
      select: { id: true, code: true, name: true, rate: true, active: true, source: true },
    });
    if (opts.replaceAll && !rows.length && !opts.allowEmpty && existing.some((r) => r.active))
      throw new ProblemException('master_sync_failed', undefined, undefined, {
        kind,
        reason: 'empty_catalogue',
        message:
          'ERP returned no codes for a kind that has active codes — resend with confirmEmpty',
      });
    const byCode = new Map(existing.map((r) => [r.code.toLowerCase(), r]));
    const seen = new Set<string>();
    const fresh: Prisma.ErpMasterCodeCreateManyInput[] = [];
    const changed: {
      id: string;
      code: string;
      name: string | null;
      rate: string | null;
      active: boolean;
    }[] = [];
    const same: string[] = [];
    for (const e of rows) {
      const key = e.code.toLowerCase();
      seen.add(key);
      const active = e.active ?? true;
      const rate = kind === 'VAT_RATE' && e.rate ? new Prisma.Decimal(e.rate).toFixed(2) : null;
      const name = e.name ?? null;
      const cur = byCode.get(key);
      if (!cur) {
        fresh.push({
          tenantId,
          connectorId,
          kind,
          code: e.code,
          name,
          rate,
          source,
          active,
          syncedAt: at,
        });
        continue;
      }
      const diff =
        cur.code !== e.code ||
        (cur.name ?? null) !== name ||
        (cur.rate === null ? null : cur.rate.toFixed(2)) !== rate ||
        cur.active !== active ||
        cur.source !== source;
      if (diff) changed.push({ id: cur.id, code: e.code, name, rate, active });
      else same.push(cur.id);
    }
    for (const part of chunks(fresh, WRITE_CHUNK))
      await tx.erpMasterCode.createMany({ data: part });
    for (const part of chunks(changed, WRITE_CHUNK))
      await tx.$executeRaw`
        UPDATE erp_master_code AS m
           SET code = v.code, name = v.name, rate = v.rate, active = v.active,
               source = ${source}, synced_at = ${at}, updated_at = now()
          FROM unnest(${part.map((x) => x.id)}::uuid[], ${part.map((x) => x.code)}::text[],
                      ${part.map((x) => x.name)}::text[], ${part.map((x) => x.rate)}::numeric[],
                      ${part.map((x) => x.active)}::boolean[]) AS v(id, code, name, rate, active)
         WHERE m.id = v.id`;
    if (same.length)
      await tx.$executeRaw`UPDATE erp_master_code SET synced_at = ${at} WHERE id = ANY(${same}::uuid[])`;
    let deactivated = 0;
    if (opts.replaceAll) {
      const gone = existing
        .filter((r) => r.active && !seen.has(r.code.toLowerCase()))
        .map((r) => r.id);
      if (gone.length)
        deactivated = await tx.$executeRaw`
          UPDATE erp_master_code SET active = false, synced_at = ${at}, updated_at = now()
           WHERE id = ANY(${gone}::uuid[])`;
    }
    return {
      kind,
      fetched: rows.length,
      created: fresh.length,
      updated: changed.length,
      deactivated,
    };
  }

  // ---------- mapping ค่าบริการ ↔ รหัสสินค้า ERP ----------

  /** รหัสสินค้า (ITEM) ที่ใช้งาน + เคยมีผังรหัสสินค้าไหม (แถวใดก็ได้ — ผังที่ถูกปิดหมดยังนับว่า "มีผัง") */
  private async itemCatalogue(
    tx: Tx,
    connectorId: string,
  ): Promise<{ active: Map<string, ErpMasterCode>; exists: boolean }> {
    const [rows, any] = await Promise.all([
      tx.erpMasterCode.findMany({ where: { connectorId, kind: 'ITEM', active: true } }),
      tx.erpMasterCode.findFirst({ where: { connectorId, kind: 'ITEM' }, select: { id: true } }),
    ]);
    return { active: new Map(rows.map((r) => [r.code.toLowerCase(), r])), exists: !!any };
  }

  private mappingDto(
    s: { id: string; code: string; nameTh: string; vatType: string; side: string; status: string },
    m: { itemCode: string | null; updatedAt: Date; version: number } | null | undefined,
    cat: { active: Map<string, ErpMasterCode>; exists: boolean },
  ): ErpItemMappingDto {
    const itemCode = m?.itemCode ?? null;
    return {
      serviceItem: {
        id: encodeId('serviceItem', s.id),
        code: s.code,
        nameTh: s.nameTh,
        vatType: s.vatType,
        side: s.side,
        status: s.status,
      },
      itemCode,
      itemName: itemCode ? (cat.active.get(itemCode.toLowerCase())?.name ?? null) : null,
      status: erpItemMappingStatus(itemCode, new Set(cat.active.keys()), cat.exists),
      updatedAt: m ? m.updatedAt.toISOString() : null,
      version: m?.version ?? 0,
    };
  }

  /**
   * ทุกค่าบริการที่ยังไม่ลบ (ทุกฝั่ง — ฝั่งซื้อใช้กับ settlement รถร่วม · ที่ปิดใช้ยังอยู่บนเอกสารเก่า) + สถานะการจับคู่
   * เรียง: ใช้งานก่อน แล้วตามรหัส
   */
  async mappings(connectorId: string): Promise<ErpItemMappingListDto> {
    const tx = this.db.tx;
    await this.connectors.get(connectorId, tx);
    const [items, maps, cat] = await Promise.all([
      tx.serviceItem.findMany({
        where: { deletedAt: null },
        orderBy: [{ status: 'asc' }, { code: 'asc' }, { id: 'asc' }],
        select: { id: true, code: true, nameTh: true, vatType: true, side: true, status: true },
      }),
      tx.erpCodeMapping.findMany({ where: { connectorId } }),
      this.itemCatalogue(tx, connectorId),
    ]);
    const byItem = new Map(maps.map((m) => [m.serviceItemId, m]));
    const data = items.map((s) => this.mappingDto(s, byItem.get(s.id), cat));
    const mapped = data.filter((d) => d.status === 'MAPPED').length;
    return {
      data,
      summary: {
        total: data.length,
        mapped,
        missing: data.length - mapped,
        itemCodes: cat.active.size,
      },
    };
  }

  /**
   * ตั้ง/ยกเลิกรหัสสินค้า ERP ของค่าบริการ 1 รายการ — audit `connector.mapping_changed`
   * If-Match (`version` ของแถว — ยังไม่มีแถว = 0) ไม่ตรง → 412 · ไม่ส่ง = เขียนทับได้ (last write wins)
   * สร้างแถวแรกพร้อมกัน = upsert (ไม่ 409)
   */
  async setMapping(
    connectorId: string,
    serviceItemRef: string,
    body: SetErpItemMappingDto,
    expected?: number,
  ): Promise<ErpItemMappingDto> {
    this.connectors.assertHuman();
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const c = await this.connectors.get(connectorId, tx);
    if (c.status === 'DISCONNECTED') throw new ProblemException('invalid_state_transition');
    const serviceItemId = tryDecodeId('serviceItem', serviceItemRef);
    const item = serviceItemId
      ? await tx.serviceItem.findFirst({
          where: { id: serviceItemId, deletedAt: null },
          select: { id: true, code: true, nameTh: true, vatType: true, side: true, status: true },
        })
      : null;
    if (!item) throw new ProblemException('not_found');
    if (body.itemCode === undefined)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'itemCode', code: 'required', message: 'ระบุรหัสสินค้า หรือ null เพื่อยกเลิก' },
      ]);
    const raw = body.itemCode?.trim() ?? '';
    const cat = await this.itemCatalogue(tx, connectorId);
    let itemCode: string | null = null;
    if (raw) {
      if (!ERP_CODE_RE.test(raw))
        throw new ProblemException('validation_failed', undefined, [
          {
            field: 'itemCode',
            code: 'invalid_format',
            message: 'รหัสยาว 1–64 ตัว ไม่มีอักขระควบคุม',
          },
        ]);
      const known = cat.active.get(raw.toLowerCase());
      if (cat.exists && !known)
        throw new ProblemException('validation_failed', undefined, [
          {
            field: 'itemCode',
            code: 'erp_code_unknown',
            message: 'ไม่พบรหัสนี้ในผังรหัสสินค้าของระบบบัญชี — ซิงก์หรือนำเข้าผังรหัสก่อน',
          },
        ]);
      itemCode = known?.code ?? raw;
    }
    const key = { connectorId_serviceItemId: { connectorId, serviceItemId: item.id } };
    const before = await tx.erpCodeMapping.findUnique({ where: key });
    if (expected !== undefined && (before?.version ?? 0) !== expected)
      throw new ProblemException('precondition_failed');
    if (before && before.itemCode === itemCode) return this.mappingDto(item, before, cat);
    const data = { itemCode, updatedBy: ctx.actorId ?? null };
    let row;
    if (before) {
      const n = await tx.erpCodeMapping.updateMany({
        where: { id: before.id, ...(expected !== undefined ? { version: expected } : {}) },
        data: { ...data, version: { increment: 1 } },
      });
      if (!n.count) throw new ProblemException('precondition_failed');
      row = await tx.erpCodeMapping.findUniqueOrThrow({ where: { id: before.id } });
    } else {
      row = await tx.erpCodeMapping.upsert({
        where: key,
        create: { ...data, tenantId: ctx.tenantId!, connectorId, serviceItemId: item.id },
        update: { ...data, version: { increment: 1 } },
      });
    }
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId!,
        actorId: ctx.actorId ?? null,
        actAs: ctx.actAs ?? null,
        action: 'connector.mapping_changed',
        entityType: 'connector',
        entityId: connectorId,
        before: { serviceItemId: item.id, itemCode: before?.itemCode ?? null },
        after: { serviceItemId: item.id, itemCode },
        requestId: ctx.requestId,
        ip: ctx.ip ?? null,
      },
    });
    return this.mappingDto(item, row, cat);
  }

  // ---------- ประตูก่อนส่ง ERP (docs/01 §7.4; plan/11 #9) ----------

  /**
   * ตรวจว่าค่าบริการทุกตัวที่เอกสารใช้จับคู่รหัสสินค้า ERP ของ connector ครบไหม (ใช้ใน tx ของ tenant)
   * งานที่สร้างคำสั่ง push (ST7-T15/T16) และ ErpAdapterSink เรียกตัวนี้ — ไม่ครบ = ห้ามส่ง (VALIDATION) แต่เอกสารยังออกได้
   */
  async checkMapping(tx: Tx, connectorId: string, serviceItemIds: string[]): Promise<MappingCheck> {
    const ids = [...new Set(serviceItemIds)];
    const codes = new Map<string, string>();
    if (!ids.length) return { codes, gaps: [] };
    const valid = ids.filter(isUuid);
    const [items, maps, master] = await Promise.all([
      tx.serviceItem.findMany({
        where: { id: { in: valid } },
        select: { id: true, code: true, nameTh: true },
      }),
      tx.erpCodeMapping.findMany({ where: { connectorId, serviceItemId: { in: valid } } }),
      this.itemCatalogue(tx, connectorId),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const mapById = new Map(maps.map((m) => [m.serviceItemId, m]));
    const keys = new Set(master.active.keys());
    const gaps: MappingGap[] = [];
    for (const id of ids) {
      const item = itemById.get(id);
      if (!item) {
        gaps.push({
          serviceItemId: id,
          code: null,
          nameTh: null,
          itemCode: null,
          status: 'NOT_FOUND',
        });
        continue;
      }
      const itemCode = mapById.get(id)?.itemCode ?? null;
      const st = erpItemMappingStatus(itemCode, keys, master.exists);
      if (st === 'MAPPED')
        codes.set(id, master.active.get(itemCode!.toLowerCase())?.code ?? itemCode!);
      else
        gaps.push({
          serviceItemId: id,
          code: item.code,
          nameTh: item.nameTh,
          itemCode,
          status: st,
        });
    }
    return { codes, gaps };
  }

  // ---------- ST8-T06 ผังรหัสที่ adapter ประกาศ (หน่วย/พนักงานขาย/บัญชี …) ----------

  /**
   * หาค่าจากเอกสารในผังรหัส ERP ของ connector (ใช้ใน tx ของ tenant) — กฎ `resolveErpMasterCode` (ตรงรหัส หรือชื่อของรหัสเดียว)
   * strict: ต้องมีค่า + อยู่ในผังที่ใช้งาน · ไม่ strict: ตรวจเมื่อมีค่าและ connector เคยมีผังชนิดนั้น
   */
  async checkMasterCodes(
    tx: Tx,
    connectorId: string,
    refs: readonly MasterCodeRef[],
  ): Promise<{ resolved: ResolvedMasterCodes; gaps: MasterCodeGap[] }> {
    const resolved: Partial<Record<ErpMasterCodeKind, Map<string, string>>> = {};
    if (!refs.length) return { resolved, gaps: [] };
    const kinds = [...new Set(refs.map((r) => r.kind))].filter((k) =>
      (ERP_MASTER_CODE_KINDS as readonly string[]).includes(k),
    );
    const rows = await tx.erpMasterCode.findMany({
      where: { connectorId, kind: { in: kinds } },
      select: { kind: true, code: true, name: true, active: true },
    });
    const active = new Map<string, { code: string; name: string | null }[]>();
    const exists = new Set<string>();
    for (const r of rows) {
      exists.add(r.kind);
      if (r.active) active.set(r.kind, [...(active.get(r.kind) ?? []), r]);
    }
    const gaps = new Map<string, MasterCodeGap>();
    for (const ref of refs) {
      const value = typeof ref.value === 'string' && ref.value.trim() ? ref.value.trim() : null;
      if (!ref.strict && (!value || !exists.has(ref.kind))) continue;
      const opts = active.get(ref.kind) ?? [];
      const r = resolveErpMasterCode(value, opts);
      if (r.status === 'FOUND') {
        (resolved[ref.kind] ??= new Map()).set(value!.toLowerCase(), r.code);
        continue;
      }
      const status: MasterCodeGap['status'] =
        r.status === 'MISSING' ? 'MISSING' : !exists.has(ref.kind) ? 'NO_CATALOGUE' : r.status;
      const key = `${ref.kind}|${value?.toLowerCase() ?? ''}`;
      const g = gaps.get(key) ?? { kind: ref.kind, value, fields: [], status };
      const field = String(ref.field).slice(0, 120);
      if (g.fields.length < MAX_FIELDS_PER_GAP && !g.fields.includes(field)) g.fields.push(field);
      gaps.set(key, g);
    }
    return { resolved, gaps: [...gaps.values()] };
  }

  /** ปัญหา `erp_master_code_unknown` — ข้อความไทยสำหรับคิวเชื่อมระบบบัญชี */
  masterCodeProblem(connectorId: string, gaps: MasterCodeGap[]): MasterCodeUnknownProblem {
    const what = (g: MasterCodeGap) =>
      g.status === 'MISSING'
        ? `ไม่ได้ระบุ${KIND_TH[g.kind]}`
        : g.status === 'NO_CATALOGUE'
          ? `ยังไม่มีผังรหัส${KIND_TH[g.kind]}`
          : `${KIND_TH[g.kind]} "${String(g.value).slice(0, 40)}"`;
    const names = [...new Set(gaps.map(what))];
    return {
      code: 'erp_master_code_unknown',
      message: `ค่าที่ไม่อยู่ในผังรหัสของระบบบัญชี: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` และอีก ${names.length - 5} รายการ` : ''}`,
      link: mappingPageLink(connectorId),
      missing: gaps.slice(0, 50).map((g) => ({
        ...g,
        value: g.value === null ? null : g.value.slice(0, 200),
      })),
    };
  }

  /**
   * ประตูก่อนส่ง ERP ทั้งชุด (ใช้ใน tx ของ tenant) — ErpAdapterSink เรียกก่อนเรียก adapter และงานสร้างคำสั่ง push (ST7-T15/T16) เรียกซ้ำได้
   * 1) ค่าบริการ ↔ รหัสสินค้า ERP (ST7-T18 `checkMapping`) → ใส่ `serviceItem.externalId`
   * 2) ค่าที่ adapter ประกาศใน `masterCodeRefs` (ST8-T06) ต้องอยู่ใน `erp_master_code` → ผลใน `masterCodes` (ใส่ลง ctx)
   * ไม่ผ่าน = `{ok:false, problem}` (VALIDATION — เอกสารยังออกได้ plan/11 #9) · ไม่แก้ `doc` ที่ส่งเข้ามา
   */
  async prepareForPush(
    tx: Tx,
    connectorId: string,
    adapter: Pick<ErpAdapter, 'masterCodeRefs'>,
    ctx: ErpContext,
    operation: ErpOperation,
    doc: CanonicalDocument,
  ): Promise<PushPreparation> {
    let document = doc;
    const itemIds = documentServiceItemIds(doc);
    if (itemIds.length) {
      const check = await this.checkMapping(tx, connectorId, itemIds);
      if (check.gaps.length)
        return { ok: false, problem: this.incompleteProblem(connectorId, check.gaps) };
      document = withMappedItemCodes(doc, check.codes);
    }
    const refs = adapter.masterCodeRefs?.(ctx, operation, document) ?? [];
    const { resolved, gaps } = await this.checkMasterCodes(tx, connectorId, refs);
    if (gaps.length) return { ok: false, problem: this.masterCodeProblem(connectorId, gaps) };
    return { ok: true, document, masterCodes: resolved };
  }

  /** ปัญหา `erp_mapping_incomplete` (เก็บใน outbox last_error) — ข้อความไทยสำหรับคิวเชื่อมระบบบัญชี */
  incompleteProblem(connectorId: string, gaps: MappingGap[]): MappingIncompleteProblem {
    const names = gaps.map((g) => g.nameTh ?? g.code ?? 'ไม่พบรายการ').slice(0, 5);
    return {
      code: 'erp_mapping_incomplete',
      message: `ยังไม่ได้จับคู่รหัสสินค้าในระบบบัญชีของ ${names.join(', ')}${gaps.length > 5 ? ` และอีก ${gaps.length - 5} รายการ` : ''}`,
      link: mappingPageLink(connectorId),
      missing: gaps.slice(0, 50).map((g) => ({
        serviceItemId: isUuid(g.serviceItemId)
          ? encodeId('serviceItem', g.serviceItemId)
          : g.serviceItemId.slice(0, 64),
        code: g.code,
        nameTh: g.nameTh,
        itemCode: g.itemCode,
        status: g.status,
      })),
    };
  }
}
