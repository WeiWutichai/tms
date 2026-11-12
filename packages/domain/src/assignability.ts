/**
 * รถร่วมแบบย่อ: เอกสารบังคับก่อนรับงาน (ST2-T20) — docs/04 B2.1 แถว "รถร่วม (SUBCONTRACT)":
 * "เอกสารบังคับก่อนรับงาน (ประกันภัย, พ.ร.บ., ใบขับขี่คนขับ) — หมดอายุ → เตือนบน planning board และบล็อก assign
 *  จนกว่าจะอัปเดต (override โดย admin พร้อมเหตุผล)" + B2.3 D "ทั้งหมดเตือนไม่บล็อก ยกเว้นรถร่วมที่เอกสารบังคับหมดอายุ"
 * + docs/01 §3.8 `vehicle_document.is_required_for_dispatch` "หมดอายุบล็อก assign รถร่วม / เตือนรถบริษัท"
 *
 * ฟังก์ชันล้วน ไม่มี I/O — ผู้ใช้: `AssignabilityService` (API) และ ST3-T14 (constraint ตอนจัดรถ + override)
 *
 * กฎ (ช่วงวิ่ง `{from, to}` ตามเวลาไทย YYYY-MM-DD — `date` = ช่วงวันเดียว; เอกสารใช้ได้ถึงสิ้นวันหมด — เหมือน `expiry.ts`):
 * - เอกสารประเมินเป็น "ชุด" (series): ประเภททั่วไป = 1 ชุดต่อประเภท; `OTHER` = 1 ชุดต่อสายต่ออายุ (ราก `renewsId`)
 *   — ชุดต้องครอบคลุม **ทั้งช่วงวิ่ง** ต่อเนื่อง (ฉบับในชุด รวมที่ต่ออายุแล้ว ต่อกันได้)
 * - **รถร่วม** (`ownership = SUBCONTRACT`) → ผลเป็น **บล็อก** (`blocks`) override ได้โดย admin พร้อมเหตุผล
 *   - ประกันภัย + พ.ร.บ. บังคับเสมอ (docs/04 — ธง `isRequiredForDispatch` ปิดไม่ได้สำหรับ 2 ประเภทนี้):
 *     ไม่มีเลย → `DOC_MISSING` · ไม่ครอบคลุมช่วงวิ่ง: ฉบับล่าสุดหมดก่อน `to` → `DOC_INSURANCE_EXPIRED`/`DOC_CMI_EXPIRED`,
 *     มีช่องว่าง/ฉบับใหม่ยังไม่เริ่ม → `DOC_NOT_YET_VALID`
 *   - เอกสารประเภทอื่นที่ฉบับปัจจุบันตั้ง `isRequiredForDispatch` (docs/01 §3.8) ไม่ครอบคลุมช่วงวิ่ง → `DOC_TAX_EXPIRED` /
 *     `DOC_INSPECTION_EXPIRED` / `DOC_OTHER_EXPIRED`
 *   - ใบขับขี่คนขับ (ถ้าส่งคนขับ): ไม่มีวันหมด → `DRIVER_LICENCE_MISSING`, หมดก่อน `to` → `DRIVER_LICENCE_EXPIRED`
 * - **รถบริษัท** (`OWN`) → ไม่บล็อก (`assignable` = true เสมอ); ชุดเอกสารที่ตั้ง `isRequiredForDispatch` ที่ไม่ครอบคลุม
 *   (หมด/ช่องว่าง) หรือใบขับขี่ที่**หมดอายุ** คืนเป็น `warnings` (ST3-T14 แสดง badge + ขอเหตุผล) — ไม่มีข้อมูลเอกสาร/ใบขับขี่ไม่เตือน (ข้อมูลรถบริษัท
 *   อาจยังไม่กรอก — spec/03 §6 ข้อ 8 ให้ tenant ตั้งภายหลัง)
 * - สถานะรถ/รถร่วม (ซ่อม จอด ปลดระวาง ระงับ) **ไม่ตรวจที่นี่** — docs/04 ไม่ได้ผูกกับเอกสารบังคับ; ST3-T14 ทำตาม spec/03 §6
 * - รหัสใช้ชุดหลักของ spec/03 §6 (`DOC_*_EXPIRED`, `DRIVER_LICENCE_EXPIRED`) + 3 รหัสใหม่ (`DOC_MISSING`,
 *   `DOC_NOT_YET_VALID`, `DRIVER_LICENCE_MISSING`)
 * - ผลเรียงแน่นอน: ประเภทเอกสารตามลำดับมาตรฐาน → ใบขับขี่
 */

/** ชุดเดียวกับ enum `vehicle_doc_type` (docs/01 §3.8) — ลำดับ = ลำดับแสดงผล */
export const VEHICLE_DOC_TYPES = [
  'INSURANCE',
  'COMPULSORY_ACT',
  'ANNUAL_TAX',
  'INSPECTION',
  'TRANSPORT_LICENSE',
  'GPS_DLT_CERT',
  'OTHER',
] as const;
export type VehicleDocType = (typeof VEHICLE_DOC_TYPES)[number];

/** เอกสารรถบังคับของรถร่วม (docs/04 B2.1) — ค่าคงที่ ไม่ตั้งค่าต่อ tenant (docs ไม่ได้ให้ตั้ง) */
export const SUBCON_REQUIRED_DOC_TYPES: readonly VehicleDocType[] = ['INSURANCE', 'COMPULSORY_ACT'];

export const ASSIGNABILITY_CODES = [
  'DOC_MISSING',
  'DOC_NOT_YET_VALID',
  'DOC_INSURANCE_EXPIRED',
  'DOC_CMI_EXPIRED',
  'DOC_TAX_EXPIRED',
  'DOC_INSPECTION_EXPIRED',
  'DOC_OTHER_EXPIRED',
  'DRIVER_LICENCE_MISSING',
  'DRIVER_LICENCE_EXPIRED',
] as const;
export type AssignabilityCode = (typeof ASSIGNABILITY_CODES)[number];

/**
 * ผู้ override บล็อกได้ (ST3-T14 ใช้): docs/04 B2.1 "override โดย admin พร้อมเหตุผล"
 * - A3 ไม่มีสิทธิ์ "ยกเว้นกฎ" แยก → ชั่วคราวใช้ `users:write` (มีเฉพาะ owner + admin — แนวเดียวกับ PROGRESS #30) [OPEN #42]
 *   ST3-T14 ควรกำหนด scope เฉพาะ (เช่น `trips:override`) แทนการผูก `users:write`
 * - เหตุผล ≥ 10 ตัวอักษร + หมวดเหตุผล `OVERRIDE` (ยกเว้นกฎ) + audit (CLAUDE.md)
 */
export const ASSIGNABILITY_OVERRIDE = {
  permission: 'users:write',
  roles: ['owner', 'admin'],
  reasonCategory: 'OVERRIDE',
  reasonMinLength: 10,
} as const;

export interface AssignDocument {
  id?: string;
  docType: VehicleDocType | string;
  /**
   * สถานะในฐาน: ACTIVE / EXPIRING / EXPIRED / SUPERSEDED / CANCELLED
   * + เอกสารที่รถร่วมส่งผ่านลิงก์แต่ admin ยังไม่อนุมัติ (ST2-T21) `PENDING_REVIEW` / ไม่อนุมัติ `REJECTED` — **ไม่นับ** (เหมือนไม่มี)
   */
  status: string;
  /** YYYY-MM-DD */
  startsOn: string;
  /** YYYY-MM-DD (ใช้ได้ถึงสิ้นวันนี้) */
  expiresOn: string;
  isRequiredForDispatch: boolean;
  /** ฉบับก่อนหน้า (ต่ออายุ) — ใช้แยกชุดของ `OTHER` */
  renewsId?: string | null;
  /** ชื่อเอกสาร (`OTHER`) */
  title?: string | null;
}

/** ช่วงวิ่งตามเวลาไทย (รวมทั้งสองวัน) */
export interface AssignWindow {
  from: string;
  to: string;
}

export interface AssignabilityInput {
  vehicle: { ownership: 'OWN' | 'SUBCONTRACT' | string };
  /** เอกสารรถทุกฉบับของคัน (รวมฉบับที่ถูกต่ออายุแล้ว; ฉบับยกเลิกถูกข้าม) */
  documents: readonly AssignDocument[];
  /** ไม่ส่ง/null = ยังไม่กำหนดคนขับ (รถร่วมกรอกตอนรับงาน — PLN-152) → ไม่ตรวจใบขับขี่ */
  driver?: { id?: string; licenceExpiresOn: string | null } | null;
  /** ช่วงวิ่ง (ST3: วันเริ่ม–วันสิ้นสุดแผนของเที่ยว) — ส่งอย่างใดอย่างหนึ่งกับ `date` */
  window?: AssignWindow;
  /** วันวิ่งวันเดียว = `window {from: date, to: date}` */
  date?: string;
}

export type AssignabilitySeverity = 'block' | 'warning';

export interface AssignabilityIssue {
  code: AssignabilityCode;
  severity: AssignabilitySeverity;
  /** key ข้อความ (`assign.*`) — ข้อความไทยอยู่ที่ผู้แสดงผล */
  messageKey: string;
  params: Record<string, string | null>;
  docType?: VehicleDocType;
  /** วันหมดของฉบับล่าสุดในชุด (หมดก่อนสิ้นช่วงวิ่ง) — YYYY-MM-DD */
  expiredOn?: string;
  /** id ของเอกสารรถฉบับล่าสุดในชุด */
  documentId?: string;
}

export interface AssignabilityResult {
  /** false = มีบล็อกอย่างน้อย 1 ข้อ (ต้อง override จึงจะจัดได้) */
  assignable: boolean;
  blocks: AssignabilityIssue[];
  /** รถบริษัท: เอกสาร/ใบขับขี่ไม่ครอบคลุม = เตือนไม่บล็อก */
  warnings: AssignabilityIssue[];
  /** บล็อกของ ST2-T20 ทุกข้อ override ได้ (โดย `ASSIGNABILITY_OVERRIDE`) */
  overridable: true;
}

const EXPIRED_CODE: Record<VehicleDocType, AssignabilityCode> = {
  INSURANCE: 'DOC_INSURANCE_EXPIRED',
  COMPULSORY_ACT: 'DOC_CMI_EXPIRED',
  ANNUAL_TAX: 'DOC_TAX_EXPIRED',
  INSPECTION: 'DOC_INSPECTION_EXPIRED',
  TRANSPORT_LICENSE: 'DOC_OTHER_EXPIRED',
  GPS_DLT_CERT: 'DOC_OTHER_EXPIRED',
  OTHER: 'DOC_OTHER_EXPIRED',
};

const CURRENT = new Set(['ACTIVE', 'EXPIRING', 'EXPIRED']);
/**
 * สถานะที่ไม่ใช่เอกสารที่ใช้ได้: ยกเลิก (บันทึกผิด) + รอ admin ตรวจ/ไม่อนุมัติ (ST2-T21 — รถร่วมอัปโหลดผ่านลิงก์
 * ต้องรอ admin อนุมัติก่อนจึงปลดบล็อกได้; ฝั่ง API เก็บที่ `carrier_doc_submission` แยกอยู่แล้ว ตัวนี้กันอีกชั้น)
 */
export const NOT_A_DOCUMENT_STATUSES: readonly string[] = [
  'CANCELLED',
  'PENDING_REVIEW',
  'REJECTED',
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isDocType = (t: string): t is VehicleDocType =>
  (VEHICLE_DOC_TYPES as readonly string[]).includes(t);

/** วันที่ถูกต้องจริง (กัน 2026-02-30) */
const isRealDate = (d: string): boolean => {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};

const nextDay = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * ชุดเอกสารครอบคลุม [from, to] ต่อเนื่องไหม — คืน null = ครอบคลุม, มิฉะนั้นคืนวันแรกที่ไม่ครอบคลุม
 */
function firstUncovered(docs: readonly AssignDocument[], w: AssignWindow): string | null {
  let cursor = w.from;
  for (;;) {
    let reach: string | null = null;
    for (const d of docs)
      if (d.startsOn <= cursor && cursor <= d.expiresOn && (reach === null || d.expiresOn > reach))
        reach = d.expiresOn;
    if (reach === null) return cursor;
    if (reach >= w.to) return null;
    cursor = nextDay(reach);
  }
}

/** แยกชุด: ประเภททั่วไป = ประเภท; OTHER = รากของสายต่ออายุ (`renewsId`) */
function seriesOf(docs: readonly AssignDocument[]): Map<string, AssignDocument[]> {
  const byId = new Map(docs.flatMap((d) => (d.id !== undefined ? [[d.id, d] as const] : [])));
  const root = (d: AssignDocument, i: number): string => {
    let cur = d;
    const seen = new Set<string>();
    while (cur.renewsId && byId.has(cur.renewsId) && !seen.has(cur.renewsId)) {
      seen.add(cur.renewsId);
      cur = byId.get(cur.renewsId)!;
    }
    return cur.id ?? `#${i}`;
  };
  const out = new Map<string, AssignDocument[]>();
  docs.forEach((d, i) => {
    const key = d.docType === 'OTHER' ? `OTHER:${root(d, i)}` : d.docType;
    out.set(key, [...(out.get(key) ?? []), d]);
  });
  return out;
}

function resolveWindow(input: AssignabilityInput): AssignWindow {
  const w =
    input.window ?? (input.date !== undefined ? { from: input.date, to: input.date } : null);
  if (!w || !isRealDate(w.from) || !isRealDate(w.to) || w.from > w.to)
    throw new RangeError('window/date must be YYYY-MM-DD with from <= to');
  return w;
}

/** ตรวจว่ารถ (+ คนขับ) รับงานในช่วงวิ่งได้ไหม — ดูหัวไฟล์ */
export function checkAssignability(input: AssignabilityInput): AssignabilityResult {
  const w = resolveWindow(input);
  const subcon = input.vehicle.ownership === 'SUBCONTRACT';
  const severity: AssignabilitySeverity = subcon ? 'block' : 'warning';
  const issues: AssignabilityIssue[] = [];

  const docs = input.documents.filter(
    (d) => !NOT_A_DOCUMENT_STATUSES.includes(d.status) && isDocType(d.docType),
  );
  const series = seriesOf(docs);
  for (const type of VEHICLE_DOC_TYPES) {
    const mandatory = subcon && SUBCON_REQUIRED_DOC_TYPES.includes(type);
    const groups = [...series.entries()]
      .filter(([, ds]) => ds[0]!.docType === type)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, ds]) => ds);
    if (mandatory && groups.length === 0) {
      issues.push({
        code: 'DOC_MISSING',
        severity,
        messageKey: 'assign.docMissing',
        params: { docType: type },
        docType: type,
      });
      continue;
    }
    for (const ds of groups) {
      const flagged = ds.some((d) => CURRENT.has(d.status) && d.isRequiredForDispatch);
      if (!mandatory && !flagged) continue;
      const gap = firstUncovered(ds, w);
      if (gap === null) continue;

      // ฉบับล่าสุดในชุด (วันหมดมากสุด; เท่ากันใช้ฉบับปัจจุบัน)
      const latest = [...ds].sort(
        (a, b) =>
          (a.expiresOn < b.expiresOn ? 1 : a.expiresOn > b.expiresOn ? -1 : 0) ||
          Number(CURRENT.has(b.status)) - Number(CURRENT.has(a.status)),
      )[0]!;
      const ref = latest.id !== undefined ? { documentId: latest.id } : {};
      const title = type === 'OTHER' && latest.title ? { title: latest.title } : {};
      if (latest.expiresOn < w.to) {
        issues.push({
          code: EXPIRED_CODE[type],
          severity,
          messageKey: 'assign.docExpired',
          params: { docType: type, expiredOn: latest.expiresOn, ...title },
          docType: type,
          expiredOn: latest.expiresOn,
          ...ref,
        });
      } else {
        // ฉบับล่าสุดครอบคลุมสิ้นช่วง แต่มีช่องว่างก่อนนั้น (ฉบับใหม่ยังไม่เริ่ม)
        const startsOn = ds
          .filter((d) => d.startsOn > gap)
          .map((d) => d.startsOn)
          .sort()[0]!;
        issues.push({
          code: 'DOC_NOT_YET_VALID',
          severity,
          messageKey: 'assign.docNotYetValid',
          params: { docType: type, startsOn, ...title },
          docType: type,
          ...ref,
        });
      }
    }
  }

  const drv = input.driver;
  if (drv) {
    const exp = drv.licenceExpiresOn;
    if (exp === null || exp === '') {
      if (subcon)
        issues.push({
          code: 'DRIVER_LICENCE_MISSING',
          severity,
          messageKey: 'assign.licenceMissing',
          params: {},
        });
    } else if (exp < w.to) {
      issues.push({
        code: 'DRIVER_LICENCE_EXPIRED',
        severity,
        messageKey: 'assign.licenceExpired',
        params: { expiredOn: exp },
        expiredOn: exp,
      });
    }
  }

  const blocks = issues.filter((i) => i.severity === 'block');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { assignable: blocks.length === 0, blocks, warnings, overridable: true };
}

/** `isAssignable()` แบบย่อ (backlog ST2-T20) */
export function isAssignable(input: AssignabilityInput): boolean {
  return checkAssignability(input).assignable;
}
