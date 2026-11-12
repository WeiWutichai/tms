import { Injectable } from '@nestjs/common';
import { Prisma, type StoredDocument, type Vehicle, type VehicleDocument } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { likeEscape } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import { emitMasterEvent, lockKey } from '../master/master-kit';
import { plateNorm } from '../vehicles/vehicles.service';
import {
  addDays,
  bangkokToday,
  CURRENT_DB_STATUSES,
  expiryStatus,
  EXPIRING_DAYS,
  isRealDate,
} from './expiry';
import type {
  CreateVehicleDocumentDto,
  RenewVehicleDocumentDto,
  VehicleDocTypeKey,
  VehicleDocumentDto,
  VehicleDocumentListQuery,
  VehicleDocumentPageDto,
  VehicleDocumentSummaryDto,
} from './vehicle-document.dto';

type DocRow = VehicleDocument & {
  vehicle: Vehicle;
  renewedBy: Pick<VehicleDocument, 'id' | 'status'>[];
};
const INCLUDE = {
  vehicle: true,
  renewedBy: { select: { id: true, status: true } },
} as const;

/** ลำดับประเภทในโปรไฟล์/drawer (ตามต้นแบบ: ประกันภัย พ.ร.บ. ภาษี ตรอ. ใบอนุญาตขนส่ง GPS DLT) */
export const DOC_TYPE_ORDER: VehicleDocTypeKey[] = [
  'INSURANCE',
  'COMPULSORY_ACT',
  'ANNUAL_TAX',
  'INSPECTION',
  'TRANSPORT_LICENSE',
  'GPS_DLT_CERT',
  'OTHER',
];
/** docs/01 §3.8: ค่าเริ่มต้น is_required_for_dispatch = true สำหรับ INSURANCE, COMPULSORY_ACT */
const REQUIRED_BY_DEFAULT: VehicleDocTypeKey[] = ['INSURANCE', 'COMPULSORY_ACT'];
const INSURANCE_ONLY = ['insuranceClass', 'sumInsured', 'premiumAmount'] as const;
const FILE_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

/** ชื่อประเภทภาษาไทย (หมายเหตุใน vehicle_cost — ต้นแบบ) */
const DOC_TYPE_TH: Record<VehicleDocTypeKey, string> = {
  INSURANCE: 'ประกันภัย',
  COMPULSORY_ACT: 'พ.ร.บ.',
  ANNUAL_TAX: 'ภาษี',
  INSPECTION: 'ตรวจสภาพ ตรอ.',
  TRANSPORT_LICENSE: 'ใบอนุญาตขนส่ง',
  GPS_DLT_CERT: 'GPS DLT',
  OTHER: 'เอกสารอื่น',
};
const costNote = (verb: string, d: VehicleDocument) =>
  `${verb}${d.docType === 'OTHER' && d.title ? d.title : DOC_TYPE_TH[d.docType]} ${d.refNo ?? ''}`.trim();
/** วันที่ที่รับ (กันพิมพ์ปีผิด เช่น 0026 / 25690) */
const DATE_MIN = '1980-01-01';
const DATE_MAX = '2100-12-31';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** สถานะที่เก็บในฐานของฉบับปัจจุบัน ตามวันหมด ณ วันนี้ (job ST2-T18 ตั้งซ้ำรายวัน) */
export function currentDbStatus(expiresOn: string, today = bangkokToday()): string {
  const s = expiryStatus('ACTIVE', expiresOn, today).status;
  return s === 'expired' ? 'EXPIRED' : s === 'expiring' ? 'EXPIRING' : 'ACTIVE';
}

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);
const fileInUse = () =>
  field422('fileDocumentIds', 'file_in_use', 'file is already attached to another document');
const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const enc = (id: string) => encodeId('vehicleDocument', id);

export function toVehicleDocumentDto(
  d: DocRow,
  files: Map<string, StoredDocument>,
  today = bangkokToday(),
): VehicleDocumentDto {
  const { status, daysToExpiry } = expiryStatus(d.status, day(d.expiresOn), today);
  const next = d.renewedBy.find((r) => r.status !== 'CANCELLED');
  return {
    id: enc(d.id),
    vehicle: {
      id: encodeId('vehicle', d.vehicle.id),
      plate: d.vehicle.plate,
      plateProvince: d.vehicle.plateProvince,
      ownership: d.vehicle.ownership,
    },
    docType: d.docType,
    title: d.title,
    docNo: d.refNo,
    issuer: d.issuer,
    startsOn: day(d.startsOn),
    expiresOn: day(d.expiresOn),
    status,
    daysToExpiry,
    insuranceClass: d.coverageClass,
    sumInsured: money(d.sumInsured),
    premiumAmount: money(d.premium),
    costAmount: money(d.costAmount),
    files: d.fileDocumentIds.flatMap((fid) => {
      const f = files.get(fid);
      return f
        ? [
            {
              id: encodeId('document', f.id),
              filename: f.filename,
              mime: f.mimeType,
              bytes: f.sizeBytes,
            },
          ]
        : [];
    }),
    isRequiredForDispatch: d.isRequiredForDispatch,
    renewsDocumentId: d.renewsId ? enc(d.renewsId) : null,
    renewedByDocumentId: next ? enc(next.id) : null,
    note: d.note,
    cancelReason: d.cancelReason,
    cancelledAt: d.cancelledAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** ค่าที่ลง audit (ไม่มีข้อมูลลับ) */
function auditView(d: VehicleDocument): Record<string, unknown> {
  return {
    vehicleId: d.vehicleId,
    docType: d.docType,
    title: d.title,
    docNo: d.refNo,
    issuer: d.issuer,
    startsOn: day(d.startsOn),
    expiresOn: day(d.expiresOn),
    insuranceClass: d.coverageClass,
    sumInsured: money(d.sumInsured),
    premiumAmount: money(d.premium),
    costAmount: money(d.costAmount),
    fileDocumentIds: d.fileDocumentIds,
    renewsId: d.renewsId,
    isRequiredForDispatch: d.isRequiredForDispatch,
    status: d.status,
    note: d.note,
  };
}

/**
 * เอกสารรถ (ST2-T17; docs/04 B2.1 ส่วน 2, docs/01 §3.8, spec/06 FLT-C)
 * - เพิ่ม: ฉบับปัจจุบันได้ 1 ฉบับต่อรถต่อประเภท (OTHER หลายฉบับได้) — มีอยู่แล้ว → 409 `current_exists` (ให้ต่ออายุแทน)
 * - ต่ออายุ: แถวใหม่ `renews_id` → ฉบับเดิม; ฉบับเดิมเป็น SUPERSEDED (ไม่แก้ข้อมูลอื่น ไม่ลบ)
 * - ค่าใช้จ่าย: รถบริษัท → `vehicle_cost` หมวด DOCUMENT 1 แถวต่อฉบับ ใน transaction เดียวกัน (docs/01 §3.8)
 *   รถร่วมเก็บยอดไว้ที่เอกสารแต่ไม่ลง ledger (ต้นทุนของผู้รับเหมา ไม่ใช่ของเรา) [OPEN spec/12 §3]
 * - ยกเลิก (บันทึกผิด): เหตุผล ≥ 10 + audit; ฉบับเดิมที่ถูกต่อกลับเป็นฉบับปัจจุบัน; ค่าใช้จ่ายลงแถวกลับรายการ (ledger append-only)
 */
@Injectable()
export class VehicleDocumentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private async files(rows: VehicleDocument[]): Promise<Map<string, StoredDocument>> {
    const ids = [...new Set(rows.flatMap((r) => r.fileDocumentIds))];
    if (!ids.length) return new Map();
    const docs = await this.db.tx.storedDocument.findMany({ where: { id: { in: ids } } });
    return new Map(docs.map((d) => [d.id, d]));
  }

  async toDtos(rows: DocRow[]): Promise<VehicleDocumentDto[]> {
    const files = await this.files(rows);
    const today = bangkokToday();
    return rows.map((r) => toVehicleDocumentDto(r, files, today));
  }

  async get(id: string): Promise<DocRow> {
    const d = await this.db.tx.vehicleDocument.findFirst({
      where: { id, vehicle: { deletedAt: null } },
      include: INCLUDE,
    });
    if (!d) throw new ProblemException('not_found');
    return d;
  }

  /** เอกสารทั้งหมดของรถ 1 คัน (ฉบับปัจจุบัน + ประวัติ) — เรียงตามประเภท แล้ววันเริ่มใหม่สุดก่อน */
  async listForVehicle(vehicleId: string): Promise<VehicleDocumentDto[]> {
    const rows = await this.db.tx.vehicleDocument.findMany({
      where: { vehicleId },
      include: INCLUDE,
      orderBy: [{ startsOn: 'desc' }, { createdAt: 'desc' }],
    });
    rows.sort((a, b) => DOC_TYPE_ORDER.indexOf(a.docType) - DOC_TYPE_ORDER.indexOf(b.docType));
    return this.toDtos(rows);
  }

  /**
   * เงื่อนไขร่วมของรายการ/ส่งออก (ST2-T17 + T19) — วันนับตามเวลาไทย (`expiry.ts`)
   * ค่าเริ่มต้นไม่รวมรถปลดระวาง (เหมือนป้าย docAlert ของทะเบียนรถ — ต่ออายุไม่ได้อยู่แล้ว)
   * ยกเว้นระบุ `vehicleId` (ดูเอกสารของคันเดียว = พฤติกรรม T17 เดิม รวมรถปลดระวาง)
   */
  private where(q: VehicleDocumentListQuery, today: string): Prisma.VehicleDocumentWhereInput[] {
    const and: Prisma.VehicleDocumentWhereInput[] = [
      q.includeRetired === 'true' || q.vehicleId
        ? { vehicle: { deletedAt: null } }
        : { vehicle: { deletedAt: null, status: { not: 'RETIRED' } } },
    ];
    if (q.docType) and.push({ docType: { in: q.docType.split(',') as VehicleDocTypeKey[] } });
    const statuses = (q.status ?? 'active,expiring,expired').split(',');
    const current = { status: { in: [...CURRENT_DB_STATUSES] } };
    const soon = addDays(today, EXPIRING_DAYS);
    const or: Prisma.VehicleDocumentWhereInput[] = [];
    if (statuses.includes('expired')) or.push({ ...current, expiresOn: { lt: asDate(today) } });
    if (statuses.includes('expiring'))
      or.push({ ...current, expiresOn: { gte: asDate(today), lte: asDate(soon) } });
    if (statuses.includes('active')) or.push({ ...current, expiresOn: { gt: asDate(soon) } });
    if (statuses.includes('superseded')) or.push({ status: 'SUPERSEDED' });
    if (statuses.includes('cancelled')) or.push({ status: 'CANCELLED' });
    and.push({ OR: or });
    if (q.expiresWithinDays !== undefined)
      and.push({
        expiresOn: { gte: asDate(today), lte: asDate(addDays(today, q.expiresWithinDays)) },
      });
    if (q.vehicleId) {
      const vid = tryDecodeId('vehicle', q.vehicleId);
      and.push({ vehicleId: vid ?? '00000000-0000-0000-0000-000000000000' });
    }
    if (q.dueWithinDays !== undefined)
      and.push({ expiresOn: { lte: asDate(addDays(today, q.dueWithinDays)) } });
    if (q.docNo?.trim())
      and.push({ refNo: { contains: likeEscape(q.docNo.trim()), mode: 'insensitive' } });
    if (q.issuer?.trim())
      and.push({ issuer: { contains: likeEscape(q.issuer.trim()), mode: 'insensitive' } });
    if (q.expiresBeyondDays !== undefined)
      and.push({ expiresOn: { gt: asDate(addDays(today, q.expiresBeyondDays)) } });
    if (q.plate) {
      const p = plateNorm(q.plate);
      if (p) and.push({ vehicle: { plateNorm: { contains: likeEscape(p) } } });
    }
    return and;
  }

  /** รายการทั้ง tenant เรียงวันหมดก่อน (หน้าเอกสารรถรวม ST2-T19) — keyset (expiresOn, id) */
  async list(q: VehicleDocumentListQuery): Promise<VehicleDocumentPageDto> {
    const limit = q.limit ?? 50;
    const today = bangkokToday();
    const and = this.where(q, today);
    if (q.cursor) {
      let c: { k: string; i: string };
      try {
        c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as typeof c;
        if (!isRealDate(String(c.k)) || typeof c.i !== 'string' || !UUID_RE.test(c.i))
          throw new Error();
      } catch {
        throw field422('cursor', 'invalid_cursor', 'cursor is invalid');
      }
      const k = asDate(c.k);
      and.push({ OR: [{ expiresOn: { gt: k } }, { expiresOn: k, id: { gt: c.i } }] });
    }
    const rows = await this.db.tx.vehicleDocument.findMany({
      where: { AND: and },
      include: INCLUDE,
      orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];
    return {
      data: await this.toDtos(slice),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ k: day(last.expiresOn), i: last.id })).toString(
              'base64url',
            )
          : null,
      hasMore,
    };
  }

  /** ส่งออก (ST2-T19) — ตัวกรองเดียวกับรายการ + เลือกเฉพาะ id · เรียงวันหมดใกล้สุดก่อน · สูงสุด 10,000 แถว */
  async exportRows(q: VehicleDocumentListQuery & { ids?: string }): Promise<VehicleDocumentDto[]> {
    const and = this.where(q, bangkokToday());
    if (q.ids)
      and.push({ id: { in: q.ids.split(',').map((x) => tryDecodeId('vehicleDocument', x)!) } });
    const rows = await this.db.tx.vehicleDocument.findMany({
      where: { AND: and },
      include: INCLUDE,
      orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }],
      take: EXPORT_MAX_ROWS + 1,
    });
    if (rows.length > EXPORT_MAX_ROWS)
      throw field422(
        'query',
        'too_many_rows',
        `export is limited to ${EXPORT_MAX_ROWS} rows — narrow the filter`,
      );
    return this.toDtos(rows);
  }

  /** ตัวนับหน้าเอกสารรถรวม (ST2-T19 ต้นแบบ kpisF('fdoc')) — ฉบับปัจจุบันของรถที่ไม่ปลดระวาง */
  async summary(): Promise<VehicleDocumentSummaryDto> {
    const today = bangkokToday();
    const base: Prisma.VehicleDocumentWhereInput = {
      vehicle: { deletedAt: null, status: { not: 'RETIRED' } },
      status: { in: [...CURRENT_DB_STATUSES] },
    };
    const count = (expiresOn?: Prisma.DateTimeFilter) =>
      this.db.tx.vehicleDocument.count({ where: expiresOn ? { ...base, expiresOn } : base });
    const within = (n: number) => count({ gte: asDate(today), lte: asDate(addDays(today, n)) });
    // ทีละ query ใน transaction เดียวกัน (RLS) — 5 count บน index (tenant, vehicle, type, expires_on)
    return {
      total: await count(),
      expired: await count({ lt: asDate(today) }),
      within7: await within(7),
      within30: await within(30),
      within60: await within(60),
    };
  }

  // ---------- เขียน ----------

  /** ไฟล์แนบ: ของ tenant นี้ (RLS), อัปโหลดเสร็จแล้ว, kind VEHICLE_DOC, PDF/รูป */
  private async resolveFiles(ids: string[]): Promise<string[]> {
    const uuids = [...new Set(ids.map((d) => tryDecodeId('document', d)))];
    if (uuids.some((u) => !u)) throw field422('fileDocumentIds', 'not_found', 'document not found');
    const docs = await this.db.tx.storedDocument.findMany({
      where: { id: { in: uuids as string[] } },
    });
    if (docs.length !== uuids.length)
      throw field422('fileDocumentIds', 'not_found', 'document not found');
    if (
      docs.some(
        (d) => d.status !== 'READY' || d.kind !== 'VEHICLE_DOC' || !FILE_MIME.includes(d.mimeType),
      )
    )
      throw field422(
        'fileDocumentIds',
        'invalid_file',
        'files must be uploaded VEHICLE_DOC PDF/image documents',
      );
    if (
      docs.some(
        (d) => d.entityId !== null || (d.entityType ?? 'vehicle_document') !== 'vehicle_document',
      )
    )
      throw fileInUse();
    return uuids as string[];
  }

  /**
   * ผูกไฟล์กับเอกสารรถ (stored_document.entity_*) — 1 ไฟล์ = 1 ฉบับ (ต่ออายุต้องแนบไฟล์ใหม่ของฉบับใหม่;
   * ไฟล์ของฉบับเดิมอยู่กับฉบับเดิมในประวัติ) · updateMany มีเงื่อนไข entity_id IS NULL → คำขอพร้อมกันที่ใช้ไฟล์เดียวกัน ได้ฉบับเดียว
   */
  private async linkFiles(fileIds: string[], docId: string) {
    const r = await this.db.tx.storedDocument.updateMany({
      where: { id: { in: fileIds }, entityId: null },
      data: { entityType: 'vehicle_document', entityId: docId },
    });
    if (r.count !== fileIds.length) throw fileInUse();
  }

  private checkFields(
    docType: VehicleDocTypeKey,
    input: RenewVehicleDocumentDto & { title?: string },
  ) {
    for (const k of ['startsOn', 'expiresOn'] as const)
      if (!isRealDate(input[k])) throw field422(k, 'invalid_date', `${k} is not a valid date`);
      else if (input[k] < DATE_MIN || input[k] > DATE_MAX)
        throw field422(k, 'out_of_range', `${k} must be between ${DATE_MIN} and ${DATE_MAX}`);
    if (input.expiresOn <= input.startsOn)
      throw field422('expiresOn', 'expires_before_start', 'expiresOn must be after startsOn');
    if (docType !== 'OTHER' && !input.docNo)
      throw field422('docNo', 'required', 'docNo is required');
    if (docType === 'OTHER' && !input.title)
      throw field422('title', 'required', 'title is required for OTHER');
    if (docType !== 'OTHER' && input.title !== undefined)
      throw field422('title', 'not_allowed', 'title is only for OTHER');
    if (docType !== 'INSURANCE')
      for (const k of INSURANCE_ONLY)
        if (input[k] !== undefined && input[k] !== null)
          throw field422(k, 'not_allowed', `${k} is only for INSURANCE`);
  }

  private assertWritable(v: Vehicle) {
    if (v.status === 'RETIRED')
      throw new ProblemException('conflict', 'vehicle is retired (read-only)', [
        { field: 'vehicleId', code: 'vehicle_retired', message: 'a retired vehicle cannot change' },
      ]);
  }

  /** รถบริษัท + มีค่าใช้จ่าย > 0 → vehicle_cost หมวด DOCUMENT (วันที่ = วันที่บันทึก เวลาไทย) */
  private async writeCost(v: Vehicle, d: VehicleDocument, kind: 'created' | 'renewed') {
    if (v.ownership !== 'OWN' || !d.costAmount || d.costAmount.isZero()) return;
    const ctx = requestContext.require();
    await this.db.tx.vehicleCost.create({
      data: {
        tenantId: ctx.tenantId!,
        vehicleId: v.id,
        category: 'DOCUMENT',
        amount: d.costAmount,
        occurredOn: asDate(bangkokToday()),
        sourceType: 'vehicle_document',
        sourceId: d.id,
        note: costNote(kind === 'renewed' ? 'ต่ออายุ' : 'เพิ่ม', d),
        createdBy: ctx.actorId ?? null,
      },
    });
  }

  private async lockCurrent(vehicleId: string, docType: string) {
    await lockKey(this.db.tx, `vehicle_document.current:${vehicleId}:${docType}`);
  }

  async create(vehicle: Vehicle, input: CreateVehicleDocumentDto): Promise<DocRow> {
    const tx = this.db.tx;
    this.assertWritable(vehicle);
    this.checkFields(input.docType, input);
    const fileIds = await this.resolveFiles(input.fileDocumentIds);
    if (input.docType !== 'OTHER') {
      await this.lockCurrent(vehicle.id, input.docType);
      const cur = await tx.vehicleDocument.findFirst({
        where: {
          vehicleId: vehicle.id,
          docType: input.docType,
          status: { in: [...CURRENT_DB_STATUSES] },
        },
      });
      if (cur)
        throw new ProblemException(
          'conflict',
          'a current document of this type exists — renew it instead',
          [{ field: 'docType', code: 'current_exists', message: 'renew the current document' }],
          { currentDocumentId: enc(cur.id) },
        );
    }
    const ctx = requestContext.require();
    const created = await tx.vehicleDocument.create({
      data: {
        tenantId: ctx.tenantId!,
        vehicleId: vehicle.id,
        docType: input.docType,
        title: input.title ?? null,
        refNo: input.docNo ?? null,
        issuer: input.issuer ?? null,
        coverageClass: input.insuranceClass ?? null,
        sumInsured: input.sumInsured ?? null,
        premium: input.premiumAmount ?? null,
        costAmount: input.costAmount ?? null,
        startsOn: asDate(input.startsOn),
        expiresOn: asDate(input.expiresOn),
        fileDocumentIds: fileIds,
        isRequiredForDispatch:
          input.isRequiredForDispatch ?? REQUIRED_BY_DEFAULT.includes(input.docType),
        status: currentDbStatus(input.expiresOn),
        note: input.note ?? null,
        createdBy: ctx.actorId ?? null,
      },
    });
    await this.linkFiles(fileIds, created.id);
    await this.writeCost(vehicle, created, 'created');
    await this.audit.record({
      action: 'vehicle_document.created',
      entityType: 'vehicle_document',
      entityId: created.id,
      after: auditView(created),
    });
    const row = await this.get(created.id);
    const [dto] = await this.toDtos([row]);
    await emitMasterEvent(tx, 'vehicle.document_created', 'vehicle_document', created.id, dto);
    return row;
  }

  async renew(
    id: string,
    input: RenewVehicleDocumentDto,
  ): Promise<{ document: DocRow; previous: DocRow }> {
    const tx = this.db.tx;
    const first = await this.get(id);
    await this.lockCurrent(first.vehicleId, first.docType === 'OTHER' ? first.id : first.docType);
    await tx.$queryRaw`SELECT id FROM vehicle_document WHERE id = ${id}::uuid FOR UPDATE`;
    const old = await this.get(id);
    this.assertWritable(old.vehicle);
    if (!(CURRENT_DB_STATUSES as readonly string[]).includes(old.status))
      throw new ProblemException(
        'invalid_state_transition',
        old.status === 'SUPERSEDED'
          ? 'document was already renewed'
          : 'cancelled document cannot be renewed',
        [
          {
            field: 'id',
            code: old.status === 'SUPERSEDED' ? 'already_renewed' : 'cancelled',
            message: 'only the current document can be renewed',
          },
        ],
      );
    const merged = {
      ...input,
      // OTHER: ชื่อเอกสารคัดลอกจากฉบับเดิม (ส่ง title มาแทนได้) · ประเภทอื่นไม่มี title
      title: old.docType === 'OTHER' ? (input.title ?? old.title ?? undefined) : input.title,
      issuer: input.issuer !== undefined ? input.issuer : old.issuer,
      insuranceClass: input.insuranceClass !== undefined ? input.insuranceClass : old.coverageClass,
      sumInsured: input.sumInsured !== undefined ? input.sumInsured : money(old.sumInsured),
    };
    this.checkFields(old.docType, merged);
    if (input.expiresOn <= day(old.expiresOn))
      throw field422(
        'expiresOn',
        'not_after_previous',
        'renewal must expire after the previous document',
      );
    const fileIds = await this.resolveFiles(input.fileDocumentIds);
    const ctx = requestContext.require();
    const before = { ...old };
    await tx.vehicleDocument.update({ where: { id: old.id }, data: { status: 'SUPERSEDED' } });
    const created = await tx.vehicleDocument.create({
      data: {
        tenantId: ctx.tenantId!,
        vehicleId: old.vehicleId,
        docType: old.docType,
        title: merged.title ?? null,
        refNo: merged.docNo ?? null,
        issuer: merged.issuer ?? null,
        coverageClass: merged.insuranceClass ?? null,
        sumInsured: merged.sumInsured ?? null,
        premium: input.premiumAmount ?? null,
        costAmount: input.costAmount ?? null,
        startsOn: asDate(input.startsOn),
        expiresOn: asDate(input.expiresOn),
        fileDocumentIds: fileIds,
        renewsId: old.id,
        isRequiredForDispatch: old.isRequiredForDispatch,
        status: currentDbStatus(input.expiresOn),
        note: input.note ?? null,
        createdBy: ctx.actorId ?? null,
      },
    });
    await this.linkFiles(fileIds, created.id);
    await this.writeCost(old.vehicle, created, 'renewed');
    await this.audit.changed(
      'vehicle_document.superseded',
      'vehicle_document',
      old.id,
      auditView(before),
      { ...auditView(before), status: 'SUPERSEDED' },
    );
    await this.audit.record({
      action: 'vehicle_document.renewed',
      entityType: 'vehicle_document',
      entityId: created.id,
      after: auditView(created),
    });
    const [document, previous] = [await this.get(created.id), await this.get(old.id)];
    const [dto] = await this.toDtos([document]);
    await emitMasterEvent(tx, 'vehicle.document_renewed', 'vehicle_document', created.id, dto, {
      renewsDocumentId: enc(old.id),
    });
    return { document, previous };
  }

  async cancel(id: string, reason: string): Promise<DocRow> {
    const tx = this.db.tx;
    const first = await this.get(id);
    await this.lockCurrent(first.vehicleId, first.docType === 'OTHER' ? first.id : first.docType);
    await tx.$queryRaw`SELECT id FROM vehicle_document WHERE id = ${id}::uuid FOR UPDATE`;
    const d = await this.get(id);
    this.assertWritable(d.vehicle);
    if (!(CURRENT_DB_STATUSES as readonly string[]).includes(d.status))
      throw new ProblemException(
        'invalid_state_transition',
        'only the current document can be cancelled',
        [{ field: 'id', code: d.status.toLowerCase(), message: 'not a current document' }],
      );
    const now = new Date();
    await tx.vehicleDocument.update({
      where: { id: d.id },
      data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason },
    });
    // ฉบับที่ถูกต่ออายุโดยฉบับนี้ → กลับเป็นฉบับปัจจุบัน (สถานะตามวันหมด) + audit ของฉบับนั้นด้วยเหตุผลเดียวกัน
    let restored: VehicleDocument | null = null;
    if (d.renewsId) {
      const prev = await tx.vehicleDocument.findUnique({ where: { id: d.renewsId } });
      if (prev?.status === 'SUPERSEDED') {
        restored = await tx.vehicleDocument.update({
          where: { id: prev.id },
          data: { status: currentDbStatus(day(prev.expiresOn)) },
        });
        await this.audit.changed(
          'vehicle_document.restored',
          'vehicle_document',
          prev.id,
          auditView(prev),
          auditView(restored),
          reason,
        );
      }
    }
    // ledger append-only: ค่าใช้จ่ายของฉบับนี้ → แถวกลับรายการ
    const costs = await tx.vehicleCost.findMany({
      where: { sourceType: 'vehicle_document', sourceId: d.id },
    });
    const net = costs.reduce((s, c) => s.add(c.amount), new Prisma.Decimal(0));
    if (!net.isZero()) {
      const ctx = requestContext.require();
      await tx.vehicleCost.create({
        data: {
          tenantId: ctx.tenantId!,
          vehicleId: d.vehicleId,
          category: 'DOCUMENT',
          amount: net.negated(),
          occurredOn: asDate(bangkokToday()),
          sourceType: 'vehicle_document',
          sourceId: d.id,
          note: costNote('ยกเลิก', d),
          createdBy: ctx.actorId ?? null,
        },
      });
    }
    const after = await this.get(d.id);
    await this.audit.changed(
      'vehicle_document.cancelled',
      'vehicle_document',
      d.id,
      auditView(d),
      auditView(after),
      reason,
    );
    const [dto] = await this.toDtos([after]);
    await emitMasterEvent(
      tx,
      'vehicle.document_cancelled',
      'vehicle_document',
      d.id,
      dto,
      restored ? { restoredDocumentId: enc(restored.id) } : undefined,
    );
    return after;
  }
}
