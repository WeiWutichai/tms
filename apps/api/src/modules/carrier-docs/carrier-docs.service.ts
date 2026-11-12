import { Injectable } from '@nestjs/common';
import type { CarrierDocSubmission, MagicLink, Prisma, StoredDocument } from '@prisma/client';
import { SUBCON_REQUIRED_DOC_TYPES } from '@tms/domain';
import { webBaseUrl } from '../../auth/password-reset.controller';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { signDocumentUrl, UPLOAD_TTL_S } from '../documents/signed-url';
import { MagicLinkService, type ResolvedLink } from '../links/magic-link.service';

/** ลิงก์ที่ยืนยันแล้ว (entityId = carrier) */
export type LinkRef = Pick<ResolvedLink, 'id' | 'tenantId' | 'entityId'>;
import { emitMasterEvent, lockKey } from '../master/master-kit';
import { DriversService } from '../drivers/drivers.service';
import { LICENCE_NO_RE } from '../drivers/driver.dto';
import {
  addDays,
  bangkokToday,
  CURRENT_DB_STATUSES,
  isRealDate,
} from '../vehicle-documents/expiry';
import { VehicleDocumentsService } from '../vehicle-documents/vehicle-documents.service';
import type { VehicleDocTypeKey } from '../vehicle-documents/vehicle-document.dto';
import type {
  CarrierDocSubmissionDto,
  CarrierDocsLinkViewDto,
  CreateSubmissionDto,
  IssuedUploadLinkDto,
  LinkFileDto,
  LinkFileReserveDto,
  LinkItemDto,
  SubmissionDocType,
  SubmissionListQuery,
  SubmissionStatusKey,
  UploadLinkDto,
} from './carrier-docs.dto';

/** magic link ของรถร่วม (ST2-T21) — ดูรายการ + ส่งเอกสาร */
export const LINK_PURPOSE = 'carrier_docs' as const;
export const LINK_ACTIONS = { view: 'docs.view', upload: 'docs.upload' } as const;
export const DEFAULT_TTL_DAYS = 7;
/** จองไฟล์ต่อลิงก์ไม่เกิน N ไฟล์ / ชั่วโมง (กันใช้ลิงก์เป็นที่ฝากไฟล์) — นอกจาก rate limit ต่อ IP ของ /public/* */
export const LINK_FILES_PER_HOUR = 30;
/** จองไฟล์ตลอดอายุลิงก์ไม่เกิน N ไฟล์ (เพดานพื้นที่ — review ST2-T21) */
export const LINK_FILES_LIFETIME = 200;
/** ลิงก์ที่ยังใช้ได้ต่อผู้รับเหมาไม่เกิน N ลิงก์ — เกิน → 409 `link_limit` (ยกเลิกลิงก์เก่าก่อน; ไม่เพิกถอนให้อัตโนมัติ) */
export const MAX_ACTIVE_LINKS = 5;
/** หน้าอัปโหลดใช้ "ใกล้หมด" ≤ 30 วัน เหมือนป้ายเอกสารรถ (ต้นแบบ) */
const SOON_DAYS = 30;
const ENTITY = 'carrier_doc_submission';

const STATUS_KEY: Record<string, SubmissionStatusKey> = {
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

type SubRow = CarrierDocSubmission & {
  carrier: { id: string; code: string; legalName: string };
  vehicle: { id: string; plate: string; plateProvince: string | null } | null;
  driver: { id: string; name: string } | null;
};
const SUB_INCLUDE = {
  carrier: { select: { id: true, code: true, legalName: true } },
  vehicle: { select: { id: true, plate: true, plateProvince: true } },
  driver: { select: { id: true, name: true } },
} as const;

function linkStatus(l: MagicLink, now = Date.now()): 'active' | 'expired' | 'revoked' {
  if (l.revokedAt) return 'revoked';
  return l.expiresAt.getTime() <= now ? 'expired' : 'active';
}
function toLinkDto(l: MagicLink): UploadLinkDto {
  return {
    id: encodeId('magicLink', l.id),
    status: linkStatus(l),
    expiresAt: l.expiresAt.toISOString(),
    createdAt: l.createdAt.toISOString(),
    lastUsedAt: l.lastUsedAt?.toISOString() ?? null,
    revokedAt: l.revokedAt?.toISOString() ?? null,
    revokedReason: l.revokedReason,
  };
}

/** ค่าที่ลง audit */
function auditView(s: CarrierDocSubmission): Record<string, unknown> {
  return {
    carrierId: s.carrierId,
    vehicleId: s.vehicleId,
    driverId: s.driverId,
    docType: s.docType,
    targetDocumentId: s.targetDocumentId,
    title: s.title,
    docNo: s.docNo,
    issuer: s.issuer,
    startsOn: s.startsOn ? day(s.startsOn) : null,
    expiresOn: day(s.expiresOn),
    fileDocumentIds: s.fileDocumentIds,
    status: s.status,
    resultDocumentId: s.resultDocumentId,
  };
}

/**
 * รถร่วมส่งเอกสารรถ/ใบขับขี่เองผ่านลิงก์ (ST2-T21; docs/04 B2.1 แถวรถร่วม)
 * - admin ออกลิงก์ต่อผู้รับเหมา (magic link ST1-T06 purpose `carrier_docs`, entity = carrier) — ระบบไม่ส่งข้อความเอง
 *   (คัดลอกลิงก์ไปส่งทาง LINE/SMS เอง; ช่องส่งจริงคือ ST3-T21) · เพิกถอนได้ (เหตุผล + audit)
 * - ลิงก์เห็น/ส่งได้เฉพาะรถ (SUBCONTRACT ไม่ปลดระวาง) และคนขับ (ไม่ปิดใช้งาน) ของผู้รับเหมารายนั้น
 * - ที่ส่งมา = `carrier_doc_submission` สถานะ PENDING_REVIEW — **ยังไม่ใช่เอกสารรถ** จึงไม่ปลดบล็อก isAssignable
 * - admin อนุมัติ (เหตุผล + audit) → เอกสารรถฉบับใหม่ / ต่ออายุฉบับปัจจุบัน (ผ่าน VehicleDocumentsService เดิม) หรือ
 *   อัปเดตเลข/วันหมดใบขับขี่ (ผ่าน DriversService เดิม) · ไม่อนุมัติ = เหตุผลบังคับ + audit (รถร่วมเห็นเหตุผลบนหน้าลิงก์)
 */
@Injectable()
export class CarrierDocsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly links: MagicLinkService,
    private readonly docs: VehicleDocumentsService,
    private readonly drivers: DriversService,
  ) {}

  // ---------- ลิงก์ (admin) ----------

  private async carrier(id: string) {
    const c = await this.db.tx.carrier.findFirst({ where: { id, deletedAt: null } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  async issueLink(carrierId: string, ttlDays = DEFAULT_TTL_DAYS): Promise<IssuedUploadLinkDto> {
    const c = await this.carrier(carrierId);
    const ctx = requestContext.require();
    await lockKey(this.db.tx, `carrier_docs.links:${c.id}`);
    const active = await this.db.tx.magicLink.count({
      where: {
        purpose: LINK_PURPOSE,
        entityType: 'carrier',
        entityId: c.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (active >= MAX_ACTIVE_LINKS)
      throw new ProblemException(
        'conflict',
        `at most ${MAX_ACTIVE_LINKS} active links per carrier — revoke an older link first`,
        [{ field: 'id', code: 'link_limit', message: 'too many active links' }],
      );
    const issued = await this.links.issue(this.db.tx, ctx.tenantId!, {
      purpose: LINK_PURPOSE,
      entityType: 'carrier',
      entityId: c.id,
      actions: [LINK_ACTIONS.view, LINK_ACTIONS.upload],
      ttlSeconds: ttlDays * 86_400,
      ...(ctx.actorId ? { createdBy: ctx.actorId } : {}),
    });
    const row = await this.db.tx.magicLink.findUniqueOrThrow({ where: { id: issued.id } });
    return {
      ...toLinkDto(row),
      token: issued.token,
      url: `${webBaseUrl()}/link/carrier-docs/${issued.token}`,
    };
  }

  async listLinks(carrierId: string): Promise<UploadLinkDto[]> {
    const c = await this.carrier(carrierId);
    const rows = await this.db.tx.magicLink.findMany({
      where: { purpose: LINK_PURPOSE, entityType: 'carrier', entityId: c.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(toLinkDto);
  }

  async revokeLink(id: string, reason: string): Promise<UploadLinkDto> {
    const tx = this.db.tx;
    const row = await tx.magicLink.findFirst({ where: { id, purpose: LINK_PURPOSE } });
    if (!row) throw new ProblemException('not_found');
    if (row.revokedAt)
      throw new ProblemException('invalid_state_transition', 'link was already revoked', [
        { field: 'id', code: 'already_revoked', message: 'link was already revoked' },
      ]);
    await this.links.revoke(tx, id, reason, requestContext.require().actorId);
    return toLinkDto(await tx.magicLink.findUniqueOrThrow({ where: { id } }));
  }

  // ---------- หน้าลิงก์ (public) ----------

  /** รถ + คนขับของผู้รับเหมาที่ลิงก์ชี้ (ใต้ RLS ของ tenant ลิงก์) */
  private async scope(carrierId: string) {
    const tx = this.db.tx;
    const [vehicles, drivers] = await Promise.all([
      tx.vehicle.findMany({
        where: {
          carrierId,
          ownership: 'SUBCONTRACT',
          deletedAt: null,
          status: { not: 'RETIRED' },
        },
        select: {
          id: true,
          plate: true,
          plateProvince: true,
          documents: {
            where: { status: { in: [...CURRENT_DB_STATUSES] } },
            select: {
              id: true,
              docType: true,
              title: true,
              expiresOn: true,
              isRequiredForDispatch: true,
            },
          },
        },
        orderBy: [{ plate: 'asc' }, { id: 'asc' }],
      }),
      tx.driver.findMany({
        where: {
          carrierId,
          employmentType: 'CARRIER_DRIVER',
          deletedAt: null,
          status: { not: 'INACTIVE' },
        },
        select: { id: true, name: true, licenceExpiresAt: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return { vehicles, drivers };
  }

  /**
   * ช่องเอกสารของรถ 1 คัน: ประกันภัย + พ.ร.บ. (บังคับเสมอ — SUBCON_REQUIRED_DOC_TYPES) แล้วเอกสารประเภทอื่นที่ฉบับปัจจุบัน
   * ตั้ง "หมดอายุแล้วห้ามจ่ายงาน" (docs/01 §3.8) — OTHER แยกตามฉบับ
   */
  private vehicleSlots(
    docs: {
      id: string;
      docType: VehicleDocTypeKey;
      title: string | null;
      expiresOn: Date;
      isRequiredForDispatch: boolean;
    }[],
  ) {
    const slots: {
      docType: VehicleDocTypeKey;
      title: string | null;
      targetId: string | null;
      currentExpiresOn: string | null;
    }[] = [];
    for (const t of SUBCON_REQUIRED_DOC_TYPES) {
      const cur = docs.find((d) => d.docType === t);
      slots.push({
        docType: t,
        title: null,
        targetId: null,
        currentExpiresOn: cur ? day(cur.expiresOn) : null,
      });
    }
    const order: VehicleDocTypeKey[] = [
      'ANNUAL_TAX',
      'INSPECTION',
      'TRANSPORT_LICENSE',
      'GPS_DLT_CERT',
      'OTHER',
    ];
    for (const t of order)
      for (const d of docs.filter((x) => x.docType === t && x.isRequiredForDispatch))
        slots.push({
          docType: t,
          title: t === 'OTHER' ? d.title : null,
          targetId: t === 'OTHER' ? d.id : null,
          currentExpiresOn: day(d.expiresOn),
        });
    return slots;
  }

  private state(current: string | null, pending: boolean, today: string): string {
    if (pending) return 'pending_review';
    if (!current) return 'missing';
    if (current < today) return 'expired';
    return current <= addDays(today, SOON_DAYS) ? 'expiring' : 'ok';
  }

  async view(link: LinkRef): Promise<CarrierDocsLinkViewDto> {
    const tx = this.db.tx;
    const carrier = await tx.carrier.findFirst({
      where: { id: link.entityId, deletedAt: null },
      select: { id: true, legalName: true },
    });
    if (!carrier) throw new ProblemException('not_found');
    const [tenant, row, { vehicles, drivers }, pending, recent] = await Promise.all([
      tx.tenant.findFirst({ where: { id: link.tenantId }, select: { name: true } }),
      tx.magicLink.findUniqueOrThrow({ where: { id: link.id } }),
      this.scope(carrier.id),
      tx.carrierDocSubmission.findMany({
        where: { carrierId: carrier.id, status: 'PENDING_REVIEW' },
        select: {
          vehicleId: true,
          driverId: true,
          docType: true,
          targetDocumentId: true,
          createdAt: true,
        },
      }),
      tx.carrierDocSubmission.findMany({
        where: { carrierId: carrier.id },
        include: SUB_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 30,
      }),
    ]);
    const today = bangkokToday();
    const pendingOf = (
      vehicleId: string | null,
      driverId: string | null,
      t: string,
      target: string | null,
    ) =>
      pending.find(
        (p) =>
          p.vehicleId === vehicleId &&
          p.driverId === driverId &&
          p.docType === t &&
          (p.targetDocumentId ?? null) === target,
      );
    const item = (
      docType: SubmissionDocType,
      title: string | null,
      target: string | null,
      current: string | null,
      p: { createdAt: Date } | undefined,
    ): LinkItemDto => ({
      docType,
      title,
      targetDocumentId: target ? encodeId('vehicleDocument', target) : null,
      currentExpiresOn: current,
      state: this.state(current, !!p, today),
      pendingSince: p?.createdAt.toISOString() ?? null,
    });
    return {
      company: tenant?.name ?? '',
      carrierName: carrier.legalName,
      expiresAt: row.expiresAt.toISOString(),
      vehicles: vehicles.map((v) => ({
        id: encodeId('vehicle', v.id),
        plate: v.plate,
        plateProvince: v.plateProvince,
        items: this.vehicleSlots(v.documents).map((s) =>
          item(
            s.docType,
            s.title,
            s.targetId,
            s.currentExpiresOn,
            pendingOf(v.id, null, s.docType, s.targetId),
          ),
        ),
      })),
      drivers: drivers.map((d) => {
        const cur = d.licenceExpiresAt ? day(d.licenceExpiresAt) : null;
        return {
          id: encodeId('driver', d.id),
          name: d.name,
          licence: item(
            'DRIVER_LICENCE',
            null,
            null,
            cur,
            pendingOf(null, d.id, 'DRIVER_LICENCE', null),
          ),
        };
      }),
      submissions: recent.map((s) => ({
        id: encodeId('carrierDocSubmission', s.id),
        subject: s.vehicle?.plate ?? s.driver?.name ?? '',
        docType: s.docType as SubmissionDocType,
        title: s.title,
        expiresOn: day(s.expiresOn),
        fileCount: s.fileDocumentIds.length,
        status: STATUS_KEY[s.status]!,
        rejectReason: s.status === 'REJECTED' ? s.reviewReason : null,
        submittedAt: s.createdAt.toISOString(),
      })),
    };
  }

  /** จองไฟล์ 1 ไฟล์ให้ลิงก์ → URL อัปโหลดที่มีลายเซ็น (PUT /v1/documents/{id}/content ตรวจขนาด + MIME จริงเหมือนเดิม) */
  async reserveFile(link: LinkRef, body: LinkFileReserveDto, origin: string): Promise<LinkFileDto> {
    const tx = this.db.tx;
    const actor = `link:${link.id}`;
    // ลิงก์เดียวกันจองพร้อมกันได้ทีละคำขอ (นับเพดานถูก)
    await lockKey(tx, `carrier_docs.files:${link.id}`);
    const recent = await tx.storedDocument.count({
      where: { createdBy: actor, createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= LINK_FILES_PER_HOUR)
      throw new ProblemException('rate_limited', 'too many files for this link — try again later');
    const total = await tx.storedDocument.count({ where: { createdBy: actor } });
    if (total >= LINK_FILES_LIFETIME)
      throw new ProblemException(
        'rate_limited',
        'file limit of this link reached — ask for a new link',
      );
    const doc = await tx.storedDocument.create({
      data: {
        tenantId: link.tenantId,
        status: 'PENDING',
        kind: 'VEHICLE_DOC',
        mimeType: body.mime,
        sizeBytes: body.bytes,
        filename: body.filename ?? null,
        entityType: ENTITY,
        createdBy: actor,
      },
    });
    const s = signDocumentUrl('upload', doc.tenantId, doc.id, UPLOAD_TTL_S);
    const id = encodeId('document', doc.id);
    return {
      id,
      uploadUrl: `${origin.replace(/\/+$/, '')}/v1/documents/${id}/content?${s.query}`,
      urlExpiresAt: s.expiresAt.toISOString(),
    };
  }

  async submit(
    link: LinkRef,
    body: CreateSubmissionDto,
  ): Promise<{ id: string; status: SubmissionStatusKey }> {
    const tx = this.db.tx;
    const carrierId = link.entityId;
    const carrier = await tx.carrier.findFirst({ where: { id: carrierId, deletedAt: null } });
    if (!carrier) throw new ProblemException('not_found');
    if (!!body.vehicleId === !!body.driverId)
      throw field422('vehicleId', 'target_required', 'send exactly one of vehicleId / driverId');
    const today = bangkokToday();
    const checkDate = (k: 'startsOn' | 'expiresOn', v: string) => {
      if (!isRealDate(v) || v < '1980-01-01' || v > '2100-12-31')
        throw field422(k, 'invalid_date', `${k} is not a valid date`);
    };
    checkDate('expiresOn', body.expiresOn);
    if (body.expiresOn < today)
      throw field422('expiresOn', 'already_expired', 'document is already expired');

    let vehicleId: string | null = null;
    let driverId: string | null = null;
    let targetId: string | null = null;
    let title: string | null = null;
    let lockTarget: string;
    let currentExpires: string | null = null;
    if (body.vehicleId) {
      vehicleId = tryDecodeId('vehicle', body.vehicleId);
      if (body.docType === 'DRIVER_LICENCE')
        throw field422('docType', 'not_allowed', 'DRIVER_LICENCE needs driverId');
      // รถต้องเป็นของผู้รับเหมาที่ลิงก์ชี้ — ไม่ใช่ = 404 (ไม่บอกใบ้ว่ามีอยู่)
      const { vehicles } = await this.scope(carrierId);
      const v = vehicles.find((x) => x.id === vehicleId);
      if (!v) throw new ProblemException('not_found');
      if (body.targetDocumentId) targetId = tryDecodeId('vehicleDocument', body.targetDocumentId);
      const slot = this.vehicleSlots(v.documents).find(
        (s) =>
          s.docType === body.docType && s.targetId === (body.docType === 'OTHER' ? targetId : null),
      );
      if (!slot)
        throw field422(
          'docType',
          'not_requested',
          'this document is not requested for the vehicle',
        );
      if (body.docType !== 'OTHER') targetId = null;
      title = slot.title;
      currentExpires = slot.currentExpiresOn;
      if (!body.startsOn) throw field422('startsOn', 'required', 'startsOn is required');
      checkDate('startsOn', body.startsOn);
      if (body.expiresOn <= body.startsOn)
        throw field422('expiresOn', 'expires_before_start', 'expiresOn must be after startsOn');
      if (body.docType !== 'OTHER' && !body.docNo)
        throw field422('docNo', 'required', 'docNo is required');
      lockTarget = `v:${vehicleId}:${body.docType}:${targetId ?? ''}`;
    } else {
      driverId = tryDecodeId('driver', body.driverId!);
      if (body.docType !== 'DRIVER_LICENCE')
        throw field422('docType', 'not_allowed', 'driverId takes DRIVER_LICENCE only');
      const { drivers } = await this.scope(carrierId);
      const d = drivers.find((x) => x.id === driverId);
      if (!d) throw new ProblemException('not_found');
      if (!body.docNo) throw field422('docNo', 'required', 'docNo is required');
      // รูปแบบเดียวกับเลขใบขับขี่ของคนขับ (T08) — กันอนุมัติแล้ว PATCH คนขับไม่ผ่าน
      if (!LICENCE_NO_RE.test(body.docNo))
        throw field422('docNo', 'matches', 'docNo is not a valid licence number');
      if (body.startsOn !== undefined)
        throw field422('startsOn', 'not_allowed', 'startsOn is not used for DRIVER_LICENCE');
      if (body.issuer)
        throw field422('issuer', 'not_allowed', 'issuer is not used for DRIVER_LICENCE');
      currentExpires = d.licenceExpiresAt ? day(d.licenceExpiresAt) : null;
      lockTarget = `d:${driverId}`;
    }
    // ต่ออายุต้องหมดหลังฉบับเดิม (กฎเดียวกับ POST /vehicle-documents/{id}/renew — ส่งผิดตั้งแต่ต้น ไม่ต้องรอ admin)
    if (currentExpires && body.expiresOn <= currentExpires)
      throw field422('expiresOn', 'not_after_previous', 'must expire after the current document');

    await lockKey(tx, `carrier_docs.target:${lockTarget}`);
    const dup = await tx.carrierDocSubmission.findFirst({
      where: {
        vehicleId,
        driverId,
        docType: body.docType,
        targetDocumentId: targetId,
        status: 'PENDING_REVIEW',
      },
    });
    if (dup)
      throw new ProblemException(
        'conflict',
        'a submission for this document is waiting for review',
        [{ field: 'docType', code: 'pending_exists', message: 'already waiting for review' }],
      );

    // ไฟล์: ต้องจองด้วยลิงก์นี้ อัปโหลดเสร็จแล้ว และยังไม่ผูกกับรายการอื่น
    const fileIds = [...new Set(body.fileDocumentIds.map((f) => tryDecodeId('document', f)))];
    if (fileIds.some((f) => !f))
      throw field422('fileDocumentIds', 'not_found', 'document not found');
    const files = await tx.storedDocument.findMany({
      where: { id: { in: fileIds as string[] }, createdBy: `link:${link.id}`, entityType: ENTITY },
    });
    if (files.length !== fileIds.length)
      throw field422('fileDocumentIds', 'not_found', 'document not found');
    if (files.some((f) => f.status !== 'READY'))
      throw field422('fileDocumentIds', 'not_uploaded', 'upload the file content first');
    if (files.some((f) => f.entityId !== null))
      throw field422('fileDocumentIds', 'file_in_use', 'file is already attached');

    const created = await tx.carrierDocSubmission.create({
      data: {
        tenantId: link.tenantId,
        carrierId,
        magicLinkId: link.id,
        vehicleId,
        driverId,
        docType: body.docType,
        targetDocumentId: targetId,
        title,
        docNo: body.docNo ?? null,
        issuer: body.issuer ?? null,
        startsOn: body.startsOn ? asDate(body.startsOn) : null,
        expiresOn: asDate(body.expiresOn),
        fileDocumentIds: fileIds as string[],
        note: body.note ?? null,
      },
    });
    const bound = await tx.storedDocument.updateMany({
      where: { id: { in: fileIds as string[] }, entityId: null },
      data: { entityId: created.id },
    });
    if (bound.count !== fileIds.length)
      throw field422('fileDocumentIds', 'file_in_use', 'file is already attached');
    await this.audit.record({
      action: 'carrier_doc_submission.submitted',
      entityType: ENTITY,
      entityId: created.id,
      after: { ...auditView(created), linkId: link.id },
    });
    await emitMasterEvent(tx, 'carrier.document_submitted', ENTITY, created.id, {
      id: encodeId('carrierDocSubmission', created.id),
      carrierId: encodeId('carrier', carrierId),
      docType: created.docType,
      status: 'pending_review',
    });
    return { id: encodeId('carrierDocSubmission', created.id), status: 'pending_review' };
  }

  // ---------- admin: ตรวจ ----------

  private async files(rows: CarrierDocSubmission[]): Promise<Map<string, StoredDocument>> {
    const ids = [...new Set(rows.flatMap((r) => r.fileDocumentIds))];
    if (!ids.length) return new Map();
    const docs = await this.db.tx.storedDocument.findMany({ where: { id: { in: ids } } });
    return new Map(docs.map((d) => [d.id, d]));
  }

  async toDtos(rows: SubRow[]): Promise<CarrierDocSubmissionDto[]> {
    const files = await this.files(rows);
    return rows.map((s) => ({
      id: encodeId('carrierDocSubmission', s.id),
      status: STATUS_KEY[s.status]!,
      carrier: {
        id: encodeId('carrier', s.carrier.id),
        code: s.carrier.code,
        legalName: s.carrier.legalName,
      },
      vehicle: s.vehicle
        ? {
            id: encodeId('vehicle', s.vehicle.id),
            plate: s.vehicle.plate,
            plateProvince: s.vehicle.plateProvince,
          }
        : null,
      driver: s.driver ? { id: encodeId('driver', s.driver.id), name: s.driver.name } : null,
      docType: s.docType as SubmissionDocType,
      title: s.title,
      targetDocumentId: s.targetDocumentId ? encodeId('vehicleDocument', s.targetDocumentId) : null,
      docNo: s.docNo,
      issuer: s.issuer,
      startsOn: s.startsOn ? day(s.startsOn) : null,
      expiresOn: day(s.expiresOn),
      files: s.fileDocumentIds.flatMap((fid) => {
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
      note: s.note,
      submittedAt: s.createdAt.toISOString(),
      reviewedAt: s.reviewedAt?.toISOString() ?? null,
      reviewReason: s.reviewReason,
      resultDocumentId: s.resultDocumentId ? encodeId('vehicleDocument', s.resultDocumentId) : null,
    }));
  }

  async list(q: SubmissionListQuery): Promise<CarrierDocSubmissionDto[]> {
    const where: Prisma.CarrierDocSubmissionWhereInput = {};
    if (q.carrierId)
      where.carrierId =
        tryDecodeId('carrier', q.carrierId) ?? '00000000-0000-0000-0000-000000000000';
    if (q.status) where.status = q.status.toUpperCase();
    const rows = await this.db.tx.carrierDocSubmission.findMany({
      where,
      include: SUB_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit ?? 100,
    });
    // รอตรวจขึ้นก่อน (ใหม่สุดก่อนในแต่ละกลุ่ม — sort ของ JS คงลำดับเดิม)
    rows.sort(
      (a, b) => Number(b.status === 'PENDING_REVIEW') - Number(a.status === 'PENDING_REVIEW'),
    );
    return this.toDtos(rows);
  }

  async get(id: string): Promise<SubRow> {
    const s = await this.db.tx.carrierDocSubmission.findUnique({
      where: { id },
      include: SUB_INCLUDE,
    });
    if (!s) throw new ProblemException('not_found');
    return s;
  }

  private async lockPending(id: string): Promise<SubRow> {
    await this.get(id);
    await this.db.tx
      .$queryRaw`SELECT id FROM carrier_doc_submission WHERE id = ${id}::uuid FOR UPDATE`;
    const s = await this.get(id);
    if (s.status !== 'PENDING_REVIEW')
      throw new ProblemException('invalid_state_transition', 'submission was already reviewed', [
        {
          field: 'id',
          code: s.status.toLowerCase(),
          message: 'only a pending submission can be reviewed',
        },
      ]);
    return s;
  }

  private async finish(
    s: SubRow,
    status: 'APPROVED' | 'REJECTED',
    reason: string,
    resultId: string | null,
  ) {
    const ctx = requestContext.require();
    const after = await this.db.tx.carrierDocSubmission.update({
      where: { id: s.id },
      data: {
        status,
        reviewedAt: new Date(),
        reviewedBy: ctx.actorId ?? 'system',
        reviewReason: reason,
        resultDocumentId: resultId,
      },
      include: SUB_INCLUDE,
    });
    await this.audit.changed(
      status === 'APPROVED' ? 'carrier_doc_submission.approved' : 'carrier_doc_submission.rejected',
      ENTITY,
      s.id,
      auditView(s),
      auditView(after),
      reason,
    );
    return after;
  }

  /**
   * อนุมัติ → เอกสารจริง (ใน transaction เดียว):
   * - เอกสารรถ: มีฉบับปัจจุบัน (ประเภทนั้น / OTHER = ฉบับที่ระบุ) → ต่ออายุ, ไม่มี → เพิ่มใหม่ (กฎ/ค่าใช้จ่าย/event ของ T17 เดิม)
   * - ใบขับขี่: อัปเดต licenceNo + licenceExpiresOn ของคนขับ (audit/event/version ของ T08 เดิม)
   * รถ/คนขับไม่อยู่กับผู้รับเหมานี้แล้ว (ย้าย/ลบ/ปลดระวาง) → 409 `target_changed` (ให้ไม่อนุมัติแทน)
   */
  async approve(id: string, reason: string): Promise<SubRow> {
    const tx = this.db.tx;
    const s = await this.lockPending(id);
    const changed = () =>
      new ProblemException('conflict', 'vehicle/driver no longer belongs to this carrier', [
        { field: 'id', code: 'target_changed', message: 'reject this submission instead' },
      ]);
    let resultId: string | null = null;
    if (s.vehicleId) {
      const v = await tx.vehicle.findFirst({
        where: {
          id: s.vehicleId,
          carrierId: s.carrierId,
          ownership: 'SUBCONTRACT',
          deletedAt: null,
        },
      });
      if (!v || v.status === 'RETIRED') throw changed();
      // ไฟล์ย้ายจากรายการที่ส่ง → เอกสารรถ (1 ไฟล์ = 1 ฉบับ — linkFiles ของ T17 ผูกให้)
      await tx.storedDocument.updateMany({
        where: { id: { in: s.fileDocumentIds }, entityType: ENTITY, entityId: s.id },
        data: { entityType: 'vehicle_document', entityId: null },
      });
      const fileDocumentIds = s.fileDocumentIds.map((f) => encodeId('document', f));
      const type = s.docType as VehicleDocTypeKey;
      const current = await tx.vehicleDocument.findFirst({
        where: {
          vehicleId: v.id,
          docType: type,
          status: { in: [...CURRENT_DB_STATUSES] },
          ...(type === 'OTHER'
            ? { id: s.targetDocumentId ?? '00000000-0000-0000-0000-000000000000' }
            : {}),
        },
      });
      const common = {
        ...(s.docNo ? { docNo: s.docNo } : {}),
        startsOn: day(s.startsOn!),
        expiresOn: day(s.expiresOn),
        fileDocumentIds,
        note: s.note,
      };
      if (current) {
        const r = await this.docs.renew(current.id, {
          ...common,
          ...(s.issuer !== null ? { issuer: s.issuer } : {}),
        });
        resultId = r.document.id;
      } else {
        if (type === 'OTHER') throw changed();
        const r = await this.docs.create(v, { ...common, docType: type, issuer: s.issuer });
        resultId = r.id;
      }
    } else {
      // ล็อกคนขับแล้วอ่านใหม่ — ใบขับขี่อาจถูกแก้หลังรถร่วมส่ง (กันเขียนทับฉบับที่ใหม่กว่า — review ST2-T21)
      await tx.$queryRaw`SELECT id FROM driver WHERE id = ${s.driverId!}::uuid FOR UPDATE`;
      const d = await tx.driver.findFirst({
        where: { id: s.driverId!, carrierId: s.carrierId, deletedAt: null },
      });
      if (!d || d.status === 'INACTIVE') throw changed();
      if (d.licenceExpiresAt && day(s.expiresOn) <= day(d.licenceExpiresAt))
        throw new ProblemException('conflict', 'driver licence is already newer', [
          {
            field: 'expiresOn',
            code: 'not_after_previous',
            message: 'current licence expires on or after this one — reject instead',
          },
        ]);
      // ไฟล์ย้ายจากรายการที่ส่ง → คนขับ (ยังไม่มีแท็บไฟล์ของคนขับ — ไฟล์ยังเปิดจากรายการที่ส่งได้)
      await tx.storedDocument.updateMany({
        where: { id: { in: s.fileDocumentIds }, entityType: ENTITY, entityId: s.id },
        data: { entityType: 'driver_licence', entityId: d.id },
      });
      await this.drivers.update(d.id, {
        licenceNo: s.docNo!,
        licenceExpiresOn: day(s.expiresOn),
      });
    }
    return this.finish(s, 'APPROVED', reason, resultId);
  }

  async reject(id: string, reason: string): Promise<SubRow> {
    const s = await this.lockPending(id);
    return this.finish(s, 'REJECTED', reason, null);
  }
}
