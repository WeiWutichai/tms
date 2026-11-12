/**
 * รถร่วมแบบย่อ: เอกสารบังคับก่อนรับงาน (ST2-T20) — docs/04 B2.1 แถว "รถร่วม (SUBCONTRACT)":
 * "เอกสารบังคับก่อนรับงาน (ประกันภัย, พ.ร.บ., ใบขับขี่คนขับ) — หมดอายุ → เตือนบน planning board และบล็อก assign
 *  จนกว่าจะอัปเดต (override โดย admin พร้อมเหตุผล)" + B2.3 D "ทั้งหมดเตือนไม่บล็อก ยกเว้นรถร่วมที่เอกสารบังคับหมดอายุ"
 * + docs/01 §3.8 `vehicle_document.is_required_for_dispatch` "หมดอายุบล็อก assign รถร่วม / เตือนรถบริษัท"
 *
 * ฟังก์ชันล้วน ไม่มี I/O — ผู้ใช้: `AssignabilityService` (API) และ ST3-T14 (constraint ตอนจัดรถ + override)
 *
 * กฎ (วันที่ = วันวิ่งตามเวลาไทย YYYY-MM-DD; เอกสารใช้ได้ถึงสิ้นวันหมด — เหมือน `expiry.ts` ของเอกสารรถ):
 * - **รถร่วม** (`ownership = SUBCONTRACT`) → ผลเป็น **บล็อก** (`blocks`) override ได้โดย admin พร้อมเหตุผล
 *   - ประกันภัย + พ.ร.บ. บังคับเสมอ (docs/04 — ธง `isRequiredForDispatch` ปิดไม่ได้สำหรับ 2 ประเภทนี้):
 *     ไม่มีเลย → `DOC_MISSING` · ไม่มีฉบับที่ครอบคลุมวันวิ่ง: หมดแล้ว → `DOC_INSURANCE_EXPIRED`/`DOC_CMI_EXPIRED`,
 *     ยังไม่เริ่ม → `DOC_NOT_YET_VALID`
 *   - เอกสารประเภทอื่นที่ฉบับปัจจุบันตั้ง `isRequiredForDispatch` (docs/01 §3.8) หมดก่อนวันวิ่ง → `DOC_TAX_EXPIRED` /
 *     `DOC_INSPECTION_EXPIRED` / `DOC_OTHER_EXPIRED`
 *   - ใบขับขี่คนขับ (ถ้าส่งคนขับ): ไม่มีวันหมด → `DRIVER_LICENCE_MISSING`, หมดก่อนวันวิ่ง → `DRIVER_LICENCE_EXPIRED`
 * - **รถบริษัท** (`OWN`) → ไม่บล็อก (`assignable` = true เสมอ); เอกสารที่ตั้ง `isRequiredForDispatch` หรือใบขับขี่ที่
 *   **หมดอายุ** คืนเป็น `warnings` (ST3-T14 แสดง badge + ขอเหตุผล) — ไม่มีข้อมูลเอกสาร/ใบขับขี่ไม่เตือน (ข้อมูลรถบริษัท
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
 * - A3 ไม่มีสิทธิ์ "ยกเว้นกฎ" แยก → ใช้ `users:write` (มีเฉพาะ owner + admin — แนวเดียวกับ PROGRESS #30) [OPEN #42]
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
  /** สถานะในฐาน: ACTIVE / EXPIRING / EXPIRED / SUPERSEDED / CANCELLED */
  status: string;
  /** YYYY-MM-DD */
  startsOn: string;
  /** YYYY-MM-DD (ใช้ได้ถึงสิ้นวันนี้) */
  expiresOn: string;
  isRequiredForDispatch: boolean;
}

export interface AssignabilityInput {
  vehicle: { ownership: 'OWN' | 'SUBCONTRACT' | string };
  /** เอกสารรถทุกฉบับของคัน (รวมฉบับที่ถูกต่ออายุแล้ว — ใช้ตัดสินว่าวันวิ่งมีฉบับครอบคลุมไหม; ฉบับยกเลิกถูกข้าม) */
  documents: readonly AssignDocument[];
  /** ไม่ส่ง/null = ยังไม่กำหนดคนขับ (รถร่วมกรอกตอนรับงาน — PLN-152) → ไม่ตรวจใบขับขี่ */
  driver?: { id?: string; licenceExpiresOn: string | null } | null;
  /** วันวิ่งตามเวลาไทย YYYY-MM-DD */
  date: string;
}

export type AssignabilitySeverity = 'block' | 'warning';

export interface AssignabilityIssue {
  code: AssignabilityCode;
  severity: AssignabilitySeverity;
  /** key ข้อความ (`assign.*`) — ข้อความไทยอยู่ที่ผู้แสดงผล */
  messageKey: string;
  params: Record<string, string | null>;
  docType?: VehicleDocType;
  /** วันหมดของฉบับล่าสุด (หมดอายุ) — YYYY-MM-DD */
  expiredOn?: string;
  /** id ของเอกสารรถฉบับที่เกี่ยวข้อง (ฉบับล่าสุดของประเภทนั้น) */
  documentId?: string;
}

export interface AssignabilityResult {
  /** false = มีบล็อกอย่างน้อย 1 ข้อ (ต้อง override จึงจะจัดได้) */
  assignable: boolean;
  blocks: AssignabilityIssue[];
  /** รถบริษัท: เอกสาร/ใบขับขี่หมดอายุ = เตือนไม่บล็อก */
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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isDocType = (t: string): t is VehicleDocType =>
  (VEHICLE_DOC_TYPES as readonly string[]).includes(t);

/** ตรวจว่ารถ (+ คนขับ) รับงานในวันวิ่งได้ไหม — ดูหัวไฟล์ */
export function checkAssignability(input: AssignabilityInput): AssignabilityResult {
  if (!DATE_RE.test(input.date)) throw new RangeError(`date must be YYYY-MM-DD: ${input.date}`);
  const date = input.date;
  const subcon = input.vehicle.ownership === 'SUBCONTRACT';
  const severity: AssignabilitySeverity = subcon ? 'block' : 'warning';
  const issues: AssignabilityIssue[] = [];

  const docs = input.documents.filter((d) => d.status !== 'CANCELLED' && isDocType(d.docType));
  for (const type of VEHICLE_DOC_TYPES) {
    const ofType = docs.filter((d) => d.docType === type);
    const current = ofType.filter((d) => CURRENT.has(d.status));
    const mandatory = subcon && SUBCON_REQUIRED_DOC_TYPES.includes(type);
    const flagged = current.some((d) => d.isRequiredForDispatch);
    if (!mandatory && !flagged) continue;

    if (ofType.length === 0) {
      // ไม่มีเอกสารเลย — รถร่วมบล็อก; รถบริษัทไม่เตือน (ถึงที่นี่ได้เฉพาะ mandatory)
      issues.push({
        code: 'DOC_MISSING',
        severity,
        messageKey: 'assign.docMissing',
        params: { docType: type },
        docType: type,
      });
      continue;
    }
    if (ofType.some((d) => d.startsOn <= date && date <= d.expiresOn)) continue;

    // ฉบับล่าสุด (วันหมดมากสุด; เท่ากันใช้ฉบับปัจจุบัน)
    const latest = [...ofType].sort(
      (a, b) =>
        (a.expiresOn < b.expiresOn ? 1 : a.expiresOn > b.expiresOn ? -1 : 0) ||
        Number(CURRENT.has(b.status)) - Number(CURRENT.has(a.status)),
    )[0]!;
    const ref = latest.id !== undefined ? { documentId: latest.id } : {};
    if (latest.expiresOn < date) {
      issues.push({
        code: EXPIRED_CODE[type],
        severity,
        messageKey: 'assign.docExpired',
        params: { docType: type, expiredOn: latest.expiresOn },
        docType: type,
        expiredOn: latest.expiresOn,
        ...ref,
      });
    } else if (subcon) {
      // ทุกฉบับเริ่มหลังวันวิ่ง (เช่น ต่ออายุล่วงหน้าแต่ฉบับเดิมหมดไปแล้วช่วงหนึ่ง) — รถบริษัทไม่เตือนกรณีนี้
      const startsOn = ofType
        .filter((d) => d.startsOn > date)
        .map((d) => d.startsOn)
        .sort()[0]!;
      issues.push({
        code: 'DOC_NOT_YET_VALID',
        severity,
        messageKey: 'assign.docNotYetValid',
        params: { docType: type, startsOn },
        docType: type,
        ...ref,
      });
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
    } else if (exp < date) {
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
