import { Injectable } from '@nestjs/common';
import {
  ASSIGNABILITY_OVERRIDE,
  checkAssignability,
  type AssignabilityIssue,
  type VehicleDocType,
} from '@tms/domain';
import { encodeId } from '../../common/ids';
import { notFound, ProblemException } from '../../common/problem';
import { docDate } from '../../pdf/thai-date';
import { DbService, type Tx } from '../../db/db.service';
import { bangkokToday, isRealDate } from '../vehicle-documents/expiry';

/**
 * ST2-T20 รถร่วมแบบย่อ: เอกสารบังคับก่อนรับงาน — ตัวห่อ `checkAssignability()` (@tms/domain) ที่อ่านข้อมูลจากฐาน
 * ผู้เรียก: ST3-T14 (จัดรถ: รถร่วมเอกสารบังคับหมด = บล็อก, override โดย admin พร้อมเหตุผล + audit) —
 * ฟังก์ชันนี้ **อ่านอย่างเดียว ไม่เขียนอะไร** และไม่มี endpoint ของตัวเอง (API-first: ST3 เปิดผลผ่าน endpoint จัดรถ)
 *
 * - รับ uuid ภายใน + `tx` ที่ตั้ง tenant แล้ว → RLS กันข้าม tenant; รถ/คนขับไม่พบ (รวมของ tenant อื่น, ไม่ใช่ uuid) → 404
 * - `date` = วันวิ่งตามเวลาไทย (YYYY-MM-DD หรือ Date → แปลงเป็นวันไทย); ไม่ส่ง = วันนี้ (เวลาไทย)
 *   ST3 ควรส่งวันสิ้นสุดแผนของเที่ยว (spec/03 §6 "หมดก่อน plannedEnd")
 * - อ่านเอกสารทุกฉบับของคัน (รวมที่ต่ออายุแล้ว) → เทียบวันวิ่งกับช่วงคุ้มครอง ไม่พึ่งคอลัมน์ status ที่ job ตั้ง
 */
export interface AssignabilityCheckInput {
  vehicleId: string;
  driverId?: string | null;
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
  /** วันวิ่งที่ใช้ตรวจ (YYYY-MM-DD เวลาไทย) */
  date: string;
  assignable: boolean;
  blocks: AssignabilityIssueView[];
  warnings: AssignabilityIssueView[];
  overridable: true;
  /** ใครยกเว้นได้ (docs/04 B2.1 "override โดย admin พร้อมเหตุผล") — ST3-T14 ตรวจสิทธิ์ + เหตุผล + audit */
  override: typeof ASSIGNABILITY_OVERRIDE;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOC_TH: Record<VehicleDocType, string> = {
  INSURANCE: 'ประกันภัย',
  COMPULSORY_ACT: 'พ.ร.บ.',
  ANNUAL_TAX: 'ภาษีประจำปี',
  INSPECTION: 'ตรวจสภาพ ตรอ.',
  TRANSPORT_LICENSE: 'ใบอนุญาตขนส่ง',
  GPS_DLT_CERT: 'ใบรับรอง GPS DLT',
  OTHER: 'เอกสารอื่น',
};

const thDay = (d: string | null | undefined) =>
  d ? docDate(new Date(`${d}T00:00:00+07:00`), 'BE') : '';

/** ข้อความไทยของแต่ละ messageKey */
export function assignabilityMessageTh(i: AssignabilityIssue): string {
  const doc = i.docType ? DOC_TH[i.docType] : '';
  switch (i.messageKey) {
    case 'assign.docMissing':
      return `ยังไม่มี${doc}ในระบบ — รถร่วมต้องมีเอกสารนี้ก่อนรับงาน`;
    case 'assign.docExpired':
      return `${doc}หมดอายุ ${thDay(i.expiredOn)}`;
    case 'assign.docNotYetValid':
      return `${doc}ฉบับใหม่เริ่มคุ้มครอง ${thDay(i.params.startsOn)} — ยังไม่ครอบคลุมวันวิ่ง`;
    case 'assign.licenceExpired':
      return `ใบขับขี่คนขับหมดอายุ ${thDay(i.expiredOn)}`;
    case 'assign.licenceMissing':
      return 'ยังไม่มีวันหมดอายุใบขับขี่ของคนขับ';
    default:
      return i.code;
  }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class AssignabilityService {
  constructor(private readonly db: DbService) {}

  async isAssignable(
    input: AssignabilityCheckInput,
    tx: Tx = this.db.tx,
  ): Promise<AssignabilityView> {
    const date =
      input.date === undefined
        ? bangkokToday()
        : typeof input.date === 'string'
          ? input.date
          : bangkokToday(input.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'date', code: 'invalid_date', message: 'date must be YYYY-MM-DD' },
      ]);
    if (!UUID_RE.test(input.vehicleId)) throw notFound();
    const driverId = input.driverId ?? null;
    if (driverId !== null && !UUID_RE.test(driverId)) throw notFound();

    const [vehicle, driver] = await Promise.all([
      tx.vehicle.findFirst({
        where: { id: input.vehicleId },
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
            },
          },
        },
      }),
      driverId === null
        ? null
        : tx.driver.findFirst({
            where: { id: driverId },
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
      })),
      driver: driver
        ? { licenceExpiresOn: driver.licenceExpiresAt ? ymd(driver.licenceExpiresAt) : null }
        : null,
      date,
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
      date,
      assignable: r.assignable,
      blocks: r.blocks.map(view),
      warnings: r.warnings.map(view),
      overridable: true,
      override: ASSIGNABILITY_OVERRIDE,
    };
  }
}
