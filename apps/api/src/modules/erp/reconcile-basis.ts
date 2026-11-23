import type { Connector } from '@prisma/client';
import type {
  CanonicalDocument,
  ErpContext,
  MasterCodeRefKind,
  ResolvedMasterCode,
  ResolvedMasterCodes,
} from './erp-adapter';
import { withMappedItemCodes } from './erp-master-codes.service';

/**
 * ST8-T11 (review 3) "ฐานของการเทียบ" — ค่าที่ใส่ ณ ตอนส่งจริง เก็บไว้ในผลของคำสั่งส่ง (`result.reconcileBasis`) ไม่มีข้อมูลลับ:
 * รหัสคู่ค้าฝั่ง ERP · รหัสสินค้าต่อค่าบริการ · ผังรหัสที่ adapter ใช้ (`ctx.masterCodes`) · ค่าตั้งของ connector ที่ไม่ใช่ credential ·
 * รหัสบริษัทฝั่ง ERP · `canonicalVersion` ของ canonical ที่ส่ง
 * reconcile สร้างเอกสารที่คาดจาก payload ฉบับที่ออก + ฐานนี้ — **ไม่ resolve รหัส/ค่าตั้งปัจจุบันใหม่** (แก้ mapping หลังส่ง ≠ ERP ต่าง)
 */

/** รุ่นของรูป canonical — เพิ่มช่องใหม่ใน canonical ให้เพิ่มเลขนี้ (ช่องที่ฉบับเก่าไม่มีจะไม่ถูกเทียบ) */
export const CANONICAL_VERSION = 1;

export interface ReconcileBasis {
  canonicalVersion: number;
  parties: Record<string, string | null>;
  itemCodes: Record<string, string>;
  masterCodes: Partial<Record<string, [string, ResolvedMasterCode][]>>;
  config: Record<string, string>;
  erpCompanyCode: string | null;
}

export function buildReconcileBasis(
  connector: Pick<Connector, 'credentialKeys'>,
  ctx: Pick<ErpContext, 'config' | 'erpCompanyCode'>,
  masterCodes: ResolvedMasterCodes,
  doc: CanonicalDocument,
  parties: Record<string, string | null>,
): ReconcileBasis {
  const secret = new Set(connector.credentialKeys);
  const itemCodes: Record<string, string> = {};
  for (const l of Array.isArray(doc.lines) ? doc.lines : []) {
    const si = (l as { serviceItem?: { id?: unknown; externalId?: unknown } } | null)?.serviceItem;
    if (typeof si?.id === 'string' && typeof si.externalId === 'string')
      itemCodes[si.id] = si.externalId;
  }
  const mc: ReconcileBasis['masterCodes'] = {};
  for (const [kind, m] of Object.entries(masterCodes))
    if (m) mc[kind] = [...(m as ReadonlyMap<string, ResolvedMasterCode>).entries()];
  return {
    canonicalVersion: CANONICAL_VERSION,
    parties,
    itemCodes,
    masterCodes: mc,
    config: Object.fromEntries(Object.entries(ctx.config).filter(([k]) => !secret.has(k))),
    erpCompanyCode: ctx.erpCompanyCode ?? null,
  };
}

export function parseReconcileBasis(v: unknown): ReconcileBasis | null {
  const b = v as Partial<ReconcileBasis> | null;
  if (!b || typeof b !== 'object' || typeof b.canonicalVersion !== 'number') return null;
  if (!b.parties || !b.itemCodes || !b.masterCodes || !b.config) return null;
  return b as ReconcileBasis;
}

/** เอกสาร + ctx ตามที่ส่งจริง (จาก payload ฉบับที่ออก + ฐาน) */
export function applyReconcileBasis(
  doc: CanonicalDocument,
  basis: ReconcileBasis,
  ctx: ErpContext,
): { doc: CanonicalDocument; ctx: ErpContext } {
  let out = structuredClone(doc) as CanonicalDocument & Record<string, unknown>;
  for (const [field, key] of [
    ['customer', 'customerExternalId'],
    ['carrier', 'carrierExternalId'],
  ] as const) {
    const p = out[field];
    if (p && typeof p === 'object' && key in basis.parties)
      out[field] = { ...(p as object), externalId: basis.parties[key] ?? null };
  }
  out = withMappedItemCodes(out, new Map(Object.entries(basis.itemCodes)));
  const masterCodes: Partial<Record<MasterCodeRefKind, ReadonlyMap<string, ResolvedMasterCode>>> =
    {};
  for (const [kind, entries] of Object.entries(basis.masterCodes))
    if (entries) masterCodes[kind as MasterCodeRefKind] = new Map(entries);
  return {
    doc: out,
    ctx: {
      ...ctx,
      config: Object.freeze({ ...ctx.config, ...basis.config }),
      erpCompanyCode: basis.erpCompanyCode ?? ctx.erpCompanyCode,
      masterCodes,
    },
  };
}
