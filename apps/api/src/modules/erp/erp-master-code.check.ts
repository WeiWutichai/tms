import { ERP_MASTER_CODE_KINDS, type ErpMasterCodeKind, resolveErpMasterCode } from '@tms/domain';
import { encodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import type {
  MasterCodeRef,
  MasterCodeRefKind,
  ResolvedMasterCode,
  ResolvedMasterCodes,
} from './erp-adapter';

/**
 * ST8-T06 ตรวจค่าที่ adapter ประกาศกับผังรหัส ERP ของ connector (ไม่ผูก ERP ใด) — ใช้ทั้งประตูก่อนส่ง (`ErpMasterCodesService.prepareForPush`)
 * และความพร้อมตอนเปิด capability / ทดสอบการเชื่อมต่อ (`ConnectorsService`) · แยกไฟล์เพื่อไม่ให้ service สองตัวพึ่งกันเป็นวง
 */

/** หน้า mapping ในเว็บ (ลิงก์ในผลของคำสั่งที่ถูกกัน — docs/01 §7.4 "พร้อมลิงก์ไปหน้า mapping") */
export function mappingPageLink(connectorId: string): string {
  return `/settings?sec=conn&connector=${encodeId('connector', connectorId)}`;
}

/** ค่าที่ไม่ผ่าน (รวมค่าเดียวกันหลายบรรทัดเป็นรายการเดียว) */
export interface MasterCodeGap {
  kind: MasterCodeRefKind;
  value: string | null;
  /** ช่องที่ใช้ค่านี้ (สูงสุด 5) */
  fields: string[];
  /** MISSING = ไม่มีค่า · UNKNOWN = ไม่อยู่ในผัง · AMBIGUOUS = ตรงหลายรหัส · NO_CATALOGUE = ยังไม่มีผังรหัสชนิดนี้ */
  status: 'MISSING' | 'UNKNOWN' | 'AMBIGUOUS' | 'NO_CATALOGUE';
}

/** ผลของประตูก่อนส่ง ERP เมื่อค่าไม่อยู่ในผังรหัส (เก็บใน last_error ของคำสั่ง) */
export interface MasterCodeUnknownProblem {
  code: 'erp_master_code_unknown';
  message: string;
  link: string;
  missing: MasterCodeGap[];
}

export const MASTER_CODE_KIND_TH: Record<MasterCodeRefKind, string> = {
  UNIT: 'หน่วย',
  SALESPERSON: 'พนักงานขาย',
  ACCOUNT: 'ผังบัญชี',
  ITEM: 'รหัสสินค้า/บริการ',
  VAT_RATE: 'อัตรา VAT',
  CUSTOMER: 'รหัสลูกค้าในระบบบัญชี',
};
const KNOWN_KINDS = new Set<string>([...ERP_MASTER_CODE_KINDS, 'CUSTOMER']);
const MAX_FIELDS_PER_GAP = 5;
const isMasterKind = (k: string): k is ErpMasterCodeKind =>
  (ERP_MASTER_CODE_KINDS as readonly string[]).includes(k);

/**
 * หาค่าในผังรหัสของ connector (ใช้ใน tx ของ tenant) — กฎ `resolveErpMasterCode`
 * - strict: ต้องมีค่า + อยู่ในผังที่ใช้งาน · ไม่ strict: ตรวจเมื่อมีค่าและ connector เคยมีผังชนิดนั้น (ไม่ตรวจ = ค่าดิบใน resolved)
 * - `CUSTOMER`: ตรวจแค่มีค่า (external_mapping = ST7-T15) — มี = ค่าดิบ
 * - `catalogues`: ชนิดที่ต้องมีผังแล้ว (ใช้ตรวจความพร้อม) — ไม่มีแถวที่ใช้งานเลย = NO_CATALOGUE
 * - ref ชนิดที่ไม่รู้จัก = ข้าม (adapter ผิด — ไม่ทำให้ข้อความมี "undefined")
 */
export async function checkMasterCodeRefs(
  tx: Tx,
  connectorId: string,
  refs: readonly MasterCodeRef[],
  catalogues: readonly ErpMasterCodeKind[] = [],
): Promise<{ resolved: ResolvedMasterCodes; gaps: MasterCodeGap[] }> {
  const resolved: Partial<Record<MasterCodeRefKind, Map<string, ResolvedMasterCode>>> = {};
  const list = refs.filter((r) => KNOWN_KINDS.has(r?.kind));
  const kinds = [
    ...new Set([
      ...list.map((r) => r.kind).filter(isMasterKind),
      ...catalogues.filter(isMasterKind),
    ]),
  ];
  if (!list.length && !kinds.length) return { resolved, gaps: [] };
  const rows = kinds.length
    ? await tx.erpMasterCode.findMany({
        where: { connectorId, kind: { in: kinds } },
        select: { kind: true, code: true, name: true, active: true },
        orderBy: [{ kind: 'asc' }, { code: 'asc' }, { id: 'asc' }],
      })
    : [];
  const active = new Map<string, { code: string; name: string | null }[]>();
  const exists = new Set<string>();
  for (const r of rows) {
    exists.add(r.kind);
    if (r.active) active.set(r.kind, [...(active.get(r.kind) ?? []), r]);
  }
  const gaps = new Map<string, MasterCodeGap>();
  const put = (kind: MasterCodeRefKind, value: string, hit: ResolvedMasterCode) =>
    (resolved[kind] ??= new Map()).set(value.toLowerCase(), hit);
  const gap = (
    ref: Pick<MasterCodeRef, 'kind' | 'field'>,
    value: string | null,
    status: MasterCodeGap['status'],
  ) => {
    const key = `${ref.kind}|${value?.toLowerCase() ?? ''}`;
    const g = gaps.get(key) ?? { kind: ref.kind, value, fields: [], status };
    const field = String(ref.field ?? '').slice(0, 120);
    if (field && g.fields.length < MAX_FIELDS_PER_GAP && !g.fields.includes(field))
      g.fields.push(field);
    gaps.set(key, g);
  };
  for (const ref of list) {
    const value = typeof ref.value === 'string' && ref.value.trim() ? ref.value.trim() : null;
    if (ref.kind === 'CUSTOMER') {
      if (value) put('CUSTOMER', value, { code: value, name: null });
      else if (ref.strict) gap(ref, null, 'MISSING');
      continue;
    }
    if (!ref.strict && (!value || !exists.has(ref.kind))) {
      // ช่องไม่บังคับที่ไม่ได้ตรวจ → ค่าดิบ (payload builder ส่งตามที่เอกสารมี)
      if (value) put(ref.kind, value, { code: value, name: null });
      continue;
    }
    const r = resolveErpMasterCode(value, active.get(ref.kind) ?? [], {
      matchByName: ref.matchByName === true,
    });
    if (r.status === 'FOUND') {
      put(ref.kind, value!, { code: r.code, name: r.name });
      continue;
    }
    gap(
      ref,
      value,
      r.status === 'MISSING' ? 'MISSING' : !exists.has(ref.kind) ? 'NO_CATALOGUE' : r.status,
    );
  }
  for (const k of catalogues)
    if (isMasterKind(k) && !active.get(k)?.length)
      gap({ kind: k, field: '' }, null, 'NO_CATALOGUE');
  return { resolved, gaps: [...gaps.values()] };
}

/** ปัญหา `erp_master_code_unknown` — ข้อความไทยสำหรับคิวเชื่อมระบบบัญชี */
export function masterCodeProblem(
  connectorId: string,
  gaps: MasterCodeGap[],
): MasterCodeUnknownProblem {
  const label = (k: MasterCodeRefKind) => MASTER_CODE_KIND_TH[k] ?? 'รหัส';
  const what = (g: MasterCodeGap) =>
    g.status === 'MISSING'
      ? `ไม่ได้ระบุ${label(g.kind)}`
      : g.status === 'NO_CATALOGUE' && g.value === null
        ? `ยังไม่มีผังรหัส${label(g.kind)}`
        : g.status === 'NO_CATALOGUE'
          ? `ยังไม่มีผังรหัส${label(g.kind)} ("${String(g.value).slice(0, 40)}")`
          : `${label(g.kind)} "${String(g.value).slice(0, 40)}"`;
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
