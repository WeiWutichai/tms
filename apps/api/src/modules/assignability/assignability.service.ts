import { Injectable } from '@nestjs/common';
import {
  ASSIGNABILITY_OVERRIDE,
  checkAssignability,
  type AssignabilityIssue,
  type AssignWindow,
} from '@tms/domain';
import { encodeId } from '../../common/ids';
import { notFound, ProblemException } from '../../common/problem';
import { docDate } from '../../common/thai-date';
import { DbService, type Tx } from '../../db/db.service';
import { DOC_TYPE_TH } from '../vehicle-documents/doc-labels';
import { bangkokToday, isRealDate } from '../vehicle-documents/expiry';

/**
 * ST2-T20 รถร่วมแบบย่อ: เอกสารบังคับก่อนรับงาน — ตัวห่อ `checkAssignability()` (@tms/domain) ที่อ่านข้อมูลจากฐาน
 * ผู้เรียก: ST3-T14 (จัดรถ: รถร่วมเอกสารบังคับหมด = บล็อก, override โดย admin พร้อมเหตุผล + audit) —
 * ฟังก์ชันนี้ **อ่านอย่างเดียว ไม่เขียนอะไร** และไม่มี endpoint ของตัวเอง (API-first: ST3 เปิดผลผ่าน endpoint จัดรถ)
 *
 * - รับ uuid ภายใน + `tx` ที่ตั้ง tenant แล้ว → RLS กันข้าม tenant; รถ/คนขับไม่พบ (รวมของ tenant อื่น, ลบแล้ว, ไม่ใช่ uuid) → 404
 * - `window {from, to}` = ช่วงวิ่ง (YYYY-MM-DD หรือ Date → แปลงเป็นวันไทย) — เอกสารต้องครอบคลุมทั้งช่วง;
 *   `date` = ช่วงวันเดียว; ไม่ส่งทั้งคู่ = วันนี้ (เวลาไทย) · ST3 ส่ง {plannedStart, plannedEnd} (spec/03 §6 "หมดก่อน plannedEnd")
 * - อ่านเอกสารทุกฉบับของคัน (รวมที่ต่ออายุแล้ว) → เทียบวันวิ่งกับช่วงคุ้มครอง ไม่พึ่งคอลัมน์ status ที่ job ตั้ง
 */
export interface AssignabilityCheckInput {
  vehicleId: string;
  driverId?: string | null;
  /** ช่วงวิ่ง (รวมสองวัน) */
  window?: { from: string | Date; to: string | Date };
  /** วันวิ่งวันเดียว (= window from = to) */
  date?: string | Date;
}

export interface AssignabilityIssueView extends Omit<AssignabilityIssue, 'documentId'> {
  /** id public ของเอกสารรถ (`vdoc_…`) */
  documentId?: string;
  /** ข้อความไทยพร้อมแสดง (ลูกค้า API เห็นข้อความเดียวกับ UI) */
  message: string;
}

export interface AssignabilityView {
  vehicle: { id: string; plate: string; ownership: string; carrierId: string | null };
  driver: { id: string; name: string } | null;
  /** ช่วงวิ่งที่ใช้ตรวจ (YYYY-MM-DD เวลาไทย) */
  window: AssignWindow;
  assignable: boolean;
  blocks: AssignabilityIssueView[];
  warnings: AssignabilityIssueView[];
  overridable: true;
  /** ใครยกเว้นได้ (docs/04 B2.1 "override โดย admin พร้อมเหตุผล") — ST3-T14 ตรวจสิทธิ์ + เหตุผล + audit */
  override: typeof ASSIGNABILITY_OVERRIDE;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const thDay = (d: string | null | undefined) =>
  d ? docDate(new Date(`${d}T00:00:00+07:00`), 'BE') : '';

/** ข้อความไทยของแต่ละ messageKey */
export function assignabilityMessageTh(i: AssignabilityIssue): string {
  const doc =
    i.docType === 'OTHER' && i.params.title
      ? i.params.title
      : i.docType
        ? DOC_TYPE_TH[i.docType]
        : '';
  switch (i.messageKey) {
    case 'assign.docMissing':
      return `ยังไม่มี ${doc} ในระบบ — รถร่วมต้องมีเอกสารนี้ก่อนรับงาน`;
    case 'assign.docExpired':
      return `${doc} หมดอายุ ${thDay(i.expiredOn)}`;
    case 'assign.docNotYetValid':
      return `${doc} ฉบับใหม่เริ่มคุ้มครอง ${thDay(i.params.startsOn)} — ยังไม่ครอบคลุมช่วงวิ่ง`;
    case 'assign.licenceExpired':
      return `ใบขับขี่คนขับหมดอายุ ${thDay(i.expiredOn)}`;
    case 'assign.licenceMissing':
      return 'ยังไม่มีวันหมดอายุใบขับขี่ของคนขับ';
    default:
      return i.code;
  }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Date ที่ไม่ถูกต้อง (Invalid Date) → '' (ตกที่ 422) */
const day = (v: string | Date) =>
  typeof v === 'string' ? v : Number.isNaN(v.getTime()) ? '' : bangkokToday(v);
const invalid = (field: string) =>
  new ProblemException('validation_failed', undefined, [
    { field, code: 'invalid_date', message: `${field} must be YYYY-MM-DD` },
  ]);

@Injectable()
export class AssignabilityService {
  constructor(private readonly db: DbService) {}

  async isAssignable(
    input: AssignabilityCheckInput,
    tx: Tx = this.db.tx,
  ): Promise<AssignabilityView> {
    const window: AssignWindow = input.window
      ? { from: day(input.window.from), to: day(input.window.to) }
      : (() => {
          const d = input.date === undefined ? bangkokToday() : day(input.date);
          return { from: d, to: d };
        })();
    const field = input.window ? 'window' : 'date';
    for (const d of [window.from, window.to])
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isRealDate(d)) throw invalid(field);
    if (window.from > window.to) throw invalid(field);
    if (!UUID_RE.test(input.vehicleId)) throw notFound();
    const driverId = input.driverId ?? null;
    if (driverId !== null && !UUID_RE.test(driverId)) throw notFound();

    const [vehicle, driver] = await Promise.all([
      tx.vehicle.findFirst({
        where: { id: input.vehicleId, deletedAt: null },
        select: {
          id: true,
          plate: true,
          ownership: true,
          carrierId: true,
          documents: {
            select: {
              id: true,
              docType: true,
              status: true,
              startsOn: true,
              expiresOn: true,
              isRequiredForDispatch: true,
              renewsId: true,
              title: true,
            },
          },
        },
      }),
      driverId === null
        ? null
        : tx.driver.findFirst({
            where: { id: driverId, deletedAt: null },
            select: { id: true, name: true, licenceExpiresAt: true },
          }),
    ]);
    if (!vehicle || (driverId !== null && !driver)) throw notFound();

    const r = checkAssignability({
      vehicle: { ownership: vehicle.ownership },
      documents: vehicle.documents.map((d) => ({
        id: d.id,
        docType: d.docType,
        status: d.status,
        startsOn: ymd(d.startsOn),
        expiresOn: ymd(d.expiresOn),
        isRequiredForDispatch: d.isRequiredForDispatch,
        renewsId: d.renewsId,
        title: d.title,
      })),
      driver: driver
        ? { licenceExpiresOn: driver.licenceExpiresAt ? ymd(driver.licenceExpiresAt) : null }
        : null,
      window,
    });
    const view = (i: AssignabilityIssue): AssignabilityIssueView => {
      const { documentId, ...rest } = i;
      return {
        ...rest,
        ...(documentId !== undefined
          ? { documentId: encodeId('vehicleDocument', documentId) }
          : {}),
        message: assignabilityMessageTh(i),
      };
    };
    return {
      vehicle: {
        id: encodeId('vehicle', vehicle.id),
        plate: vehicle.plate,
        ownership: vehicle.ownership,
        carrierId: vehicle.carrierId ? encodeId('carrier', vehicle.carrierId) : null,
      },
      driver: driver ? { id: encodeId('driver', driver.id), name: driver.name } : null,
      window,
      assignable: r.assignable,
      blocks: r.blocks.map(view),
      warnings: r.warnings.map(view),
      overridable: true,
      override: ASSIGNABILITY_OVERRIDE,
    };
  }
}
