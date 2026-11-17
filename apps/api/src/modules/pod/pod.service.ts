import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type DeliveryOrderPod, type StoredDocument } from '@prisma/client';
import {
  isPodEditable,
  normalizeBarcodes,
  podDoEvent,
  podSetForDo,
  podStatusOf,
  POD_REASON_MIN,
  validatePod,
  type DoStatus,
  type PodMissing,
  type PodSource,
  type PodSubmission,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { FieldCipher } from '../../common/crypto';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { PodChecklistService } from './pod-checklist.service';
import type { DeliveryOrderPodDto, PodDocumentDto, PodRecordDto, SubmitPodDto } from './pod.dto';

const IMAGE = ['image/png', 'image/jpeg', 'image/webp'];
const FILE = ['application/pdf', ...IMAGE];

const dec = (v: { toFixed: (n: number) => string } | null) =>
  v === null ? null : v.toFixed(3).replace(/\.?0+$/, '') || '0';

interface SubmitOptions {
  source: PodSource;
  /** If-Match = เลขฉบับปัจจุบัน (ยังไม่มี = 0) · undefined = ไม่ตรวจ */
  expectedVersion?: number;
}

/**
 * หลักฐานส่ง (ePOD) ต่อ DO (ST4-T07; docs/04 E2 "ePOD ผ่านเว็บ", docs/01 §3.3 / §4.3 / §5.3, spec/04 §13 DRV-160/164)
 *
 * - **ทางเดียว** ที่เขียน `delivery_order_pod` — เว็บ (T07), ลิงก์รถร่วม (T09 `source = LINK`), แอปคนขับ (P1) เรียก `submit`
 * - บันทึกเป็นฉบับ (append-only): แก้ = ฉบับใหม่ + เหตุผล (≥ 10) + audit · If-Match = เลขฉบับ
 * - ไม่ปฏิเสธหลักฐานที่ยังไม่ครบ (ได้ `pod_status = PARTIAL` → DO POD_PENDING) — ปฏิเสธเฉพาะค่าผิดรูปแบบ
 *   (`missing[].code = invalid` เช่น PIN ไม่ครบหลัก) และไฟล์ที่ไม่ใช่ของหลักฐานส่ง/ยังอัปโหลดไม่เสร็จ
 * - DO: DELIVERED → UNBILLED / POD_PENDING · POD_PENDING → UNBILLED (`DeliveryOrderService.applyPodResult`)
 * - ไล่ตอน DO เพิ่งเป็น DELIVERED (StopProjectionService → `settleDelivered`) — ลูกค้าที่ไม่บังคับอะไร = UNBILLED ทันที
 * - checklist ของลูกค้าเปลี่ยนภายหลัง **ไม่** ไล่ DO เดิมใหม่อัตโนมัติ (คำนวณใหม่เมื่อบันทึกหลักฐานครั้งถัดไป)
 * - PIN เข้ารหัส (FieldCipher) ไม่ออกใน response / audit / domain_event / log
 */
@Injectable()
export class PodService {
  private readonly log = new Logger(PodService.name);
  private cipherInstance?: FieldCipher;
  constructor(
    private readonly db: DbService,
    private readonly dos: DeliveryOrderService,
    private readonly checklist: PodChecklistService,
    private readonly audit: AuditService,
  ) {}

  private get cipher(): FieldCipher {
    return (this.cipherInstance ??= new FieldCipher());
  }

  // ---------------------------------------------------------------------------------------------
  // อ่าน

  async view(deliveryOrderId: string, tx: Tx = this.db.tx): Promise<DeliveryOrderPodDto> {
    const d = await tx.deliveryOrder.findUnique({
      where: { id: deliveryOrderId },
      select: {
        id: true,
        doNo: true,
        status: true,
        podStatus: true,
        customerId: true,
        weightKg: true,
      },
    });
    if (!d) throw new ProblemException('not_found');
    const rows = await tx.deliveryOrderPod.findMany({
      where: { deliveryOrderId },
      orderBy: { version: 'desc' },
    });
    const cur = rows[0] ?? null;
    const cl = await this.checklist.forCustomer(d.customerId, podSetForDo(d.status as DoStatus));
    const missing = validatePod(cl, cur ? this.submissionOf(cur) : EMPTY).missing;
    const names = await this.userNames(rows.map((r) => r.createdBy));
    const docs = cur ? await this.documents(tx, docIdsOf(cur)) : new Map<string, StoredDocument>();
    return {
      deliveryOrderId: encodeId('deliveryOrder', d.id),
      doNo: d.doNo ?? '',
      doStatus: d.status,
      podStatus: d.podStatus,
      editable: isPodEditable(d.status as DoStatus),
      plannedWeightKg: dec(d.weightKg),
      checklist: cl,
      missing,
      current: cur ? this.recordDto(cur, docs, names) : null,
      versions: rows.map((r) => this.versionDto(r, names)),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // บันทึก

  async submit(
    deliveryOrderId: string,
    input: SubmitPodDto,
    opts: SubmitOptions,
  ): Promise<DeliveryOrderPodDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const head = await tx.deliveryOrder.findUnique({
      where: { id: deliveryOrderId },
      select: { id: true },
    });
    if (!head) throw new ProblemException('not_found');
    // ลำดับล็อกเดียวกับงานเที่ยว/ไล่สถานะ (SO → DO) — กัน deadlock กับ StopProjectionService
    const [d] = await this.dos.lockForTrip(tx, [deliveryOrderId]);
    if (!d) throw new ProblemException('not_found');
    const status = d.status as DoStatus;
    if (!isPodEditable(status))
      throw new ProblemException('pod_not_allowed', undefined, undefined, {
        doStatus: status,
      });
    const latest = await tx.deliveryOrderPod.findFirst({
      where: { deliveryOrderId },
      orderBy: { version: 'desc' },
    });
    const curVersion = latest?.version ?? 0;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== curVersion)
      throw new ProblemException('precondition_failed', undefined, undefined, {
        currentVersion: curVersion,
      });

    const errors: FieldError[] = [];
    const reason = input.reason?.trim() || null;
    if (latest && (!reason || reason.length < POD_REASON_MIN))
      errors.push({
        field: 'reason',
        code: 'required',
        message: `reason (≥ ${POD_REASON_MIN} chars) is required to amend an existing proof of delivery`,
      });

    // ไฟล์: ของบริษัทนี้ (RLS) อัปโหลดเสร็จแล้ว ชนิดตรงช่อง ไม่ซ้ำกัน
    const photoIds = this.decodeDocs(input.photoDocumentIds, 'photoDocumentIds', errors);
    const fileIds = this.decodeDocs(input.fileDocumentIds, 'fileDocumentIds', errors);
    const sigIds = this.decodeDocs(
      input.signatureDocumentId ? [input.signatureDocumentId] : [],
      'signatureDocumentId',
      errors,
    );
    const all = [...photoIds, ...fileIds, ...sigIds];
    if (new Set(all).size !== all.length)
      errors.push({
        field: 'photoDocumentIds',
        code: 'duplicate',
        message: 'the same document is used more than once',
      });
    const docs = await this.documents(tx, all);
    const checkDocs = (ids: string[], field: string, kind: string, mimes: string[]) =>
      ids.forEach((id, i) => {
        const doc = docs.get(id);
        const f = field === 'signatureDocumentId' ? field : `${field}.${i}`;
        if (!doc) errors.push({ field: f, code: 'not_found', message: 'document not found' });
        else if (doc.status !== 'READY')
          errors.push({ field: f, code: 'not_ready', message: 'document upload is not complete' });
        else if (doc.kind !== kind || !mimes.includes(doc.mimeType))
          errors.push({
            field: f,
            code: 'invalid_kind',
            message: `document must be kind ${kind} (${mimes.join(', ')})`,
          });
      });
    checkDocs(photoIds, 'photoDocumentIds', 'POD_PHOTO', IMAGE);
    checkDocs(fileIds, 'fileDocumentIds', 'POD_FILE', FILE);
    checkDocs(sigIds, 'signatureDocumentId', 'POD_SIGNATURE', IMAGE);
    // เจ้าของไฟล์: ผูกกับ DO นี้ครั้งแรกที่ใช้ — ไฟล์ที่ผูกกับเอกสารอื่น/ถูกใช้ใน POD ของ DO อื่น (ฉบับใดก็ได้) ใช้ไม่ได้
    const elsewhere = all.length
      ? await tx.deliveryOrderPod.findMany({
          where: {
            deliveryOrderId: { not: deliveryOrderId },
            OR: [
              { photoDocumentIds: { hasSome: all } },
              { fileDocumentIds: { hasSome: all } },
              { signatureDocumentId: { in: all } },
            ],
          },
          select: { photoDocumentIds: true, fileDocumentIds: true, signatureDocumentId: true },
        })
      : [];
    const taken = new Set(
      elsewhere.flatMap((r) => [
        ...r.photoDocumentIds,
        ...r.fileDocumentIds,
        ...(r.signatureDocumentId ? [r.signatureDocumentId] : []),
      ]),
    );
    const owned = (ids: string[], field: string) =>
      ids.forEach((id, i) => {
        const doc = docs.get(id);
        if (!doc) return;
        const foreign =
          taken.has(id) ||
          (doc.entityId !== null &&
            (doc.entityType !== POD_ENTITY || doc.entityId !== deliveryOrderId));
        if (foreign)
          errors.push({
            field: field === 'signatureDocumentId' ? field : `${field}.${i}`,
            code: 'document_in_use',
            message: 'document belongs to another record',
          });
      });
    owned(photoIds, 'photoDocumentIds');
    owned(fileIds, 'fileDocumentIds');
    owned(sigIds, 'signatureDocumentId');

    const bc = normalizeBarcodes(input.barcodes, input.scanCodes);
    if (bc.conflict)
      errors.push({
        field: 'scanCodes',
        code: 'conflict',
        message: 'barcodes and scanCodes differ — send one of them',
      });

    // checklist ตามสถานะ DO (ส่งไม่สำเร็จ = ชุดไม่สำเร็จ) — key ของข้อยืนยัน/คำถามต้องอยู่ใน checklist
    const set = podSetForDo(status);
    const cl = await this.checklist.forCustomer(d.customerId, set);
    const keysOf = (type: string) =>
      new Set(cl.fields.filter((f) => f.type === type && f.level !== 'DISABLED').map((f) => f.key));
    const checks: Record<string, boolean> = {};
    const boolKeys = keysOf('BOOLEAN');
    for (const [k, v] of Object.entries(input.checks ?? {})) {
      if (!boolKeys.has(k))
        errors.push({ field: `checks.${k}`, code: 'unknown_key', message: 'not in checklist' });
      else if (typeof v !== 'boolean')
        errors.push({ field: `checks.${k}`, code: 'invalid', message: 'must be true or false' });
      else checks[k] = v;
    }
    const choices: Record<string, string> = {};
    const choiceKeys = keysOf('SINGLE_CHOICE');
    for (const [k, v] of Object.entries(input.choices ?? {})) {
      if (!choiceKeys.has(k))
        errors.push({ field: `choices.${k}`, code: 'unknown_key', message: 'not in checklist' });
      else if (typeof v !== 'string')
        errors.push({ field: `choices.${k}`, code: 'invalid', message: 'must be a string' });
      else if (v.trim()) choices[k] = v.trim();
    }

    // PIN: ไม่ส่ง (undefined) = คงค่าเดิมของฉบับก่อน (อ่านค่าจริงผ่าน API ไม่ได้ จึงส่งซ้ำไม่ได้) · null/ว่าง = ล้าง
    const keepPin = input.pin === undefined && !!latest?.pinEnc;
    const pin = keepPin ? (this.submissionOf(latest!).pin ?? null) : input.pin?.trim() || null;
    const submission: PodSubmission = {
      photoCount: photoIds.length,
      hasSignature: sigIds.length > 0,
      note: input.note ?? null,
      checks,
      choices,
      scanCodes: bc.value,
      pin,
      rating: input.rating ?? null,
    };
    const check = validatePod(cl, submission);
    // ค่าผิดรูปแบบไม่เก็บ (ST4-T06) — ปฏิเสธ · ของที่ "ขาด" ไม่ปฏิเสธ (PARTIAL)
    for (const m of check.missing.filter((x) => x.code === 'invalid'))
      errors.push({
        field: FIELD_OF[m.type] ?? `${m.type === 'BOOLEAN' ? 'checks' : 'choices'}.${m.key}`,
        code: 'invalid',
        message: `${m.type} value is not valid`,
      });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
    // ด่านวางบิล: DO ที่รอวางบิลแล้ว (UNBILLED) แก้หลักฐานจนไม่ครบไม่ได้ (POD_PENDING ยังบันทึกบางส่วนได้)
    if (mustStayComplete(status) && !check.ok)
      throw new ProblemException(
        'pod_incomplete',
        undefined,
        check.missing.map((m) => ({
          field:
            FIELD_OF_MISSING[m.type] ?? `${m.type === 'BOOLEAN' ? 'checks' : 'choices'}.${m.key}`,
          code: m.code,
          message: `${m.type} is ${m.code}`,
        })),
        { missing: check.missing, doStatus: status },
      );

    // ผูกไฟล์กับ DO นี้ (ล็อกแถวไฟล์ — สองคำขอแย่งไฟล์เดียวกันได้ผลเดียว)
    if (all.length) {
      const bound = await tx.storedDocument.updateMany({
        where: {
          id: { in: all },
          OR: [{ entityId: null }, { entityType: POD_ENTITY, entityId: deliveryOrderId }],
        },
        data: { entityType: POD_ENTITY, entityId: deliveryOrderId },
      });
      if (bound.count !== all.length)
        throw new ProblemException('validation_failed', undefined, [
          {
            field: 'photoDocumentIds',
            code: 'document_in_use',
            message: 'document belongs to another record',
          },
        ]);
    }

    const podStatus = podStatusOf(true, check.ok);
    const row = await tx.deliveryOrderPod.create({
      data: {
        tenantId: ctx.tenantId!,
        deliveryOrderId,
        tripStopId: d.tripStopId,
        version: curVersion + 1,
        outcome: set,
        source: opts.source,
        receiverName: input.receiverName ?? null,
        receiverRelation: input.receiverRelation ?? null,
        signatureDocumentId: sigIds[0] ?? null,
        photoDocumentIds: photoIds,
        fileDocumentIds: fileIds,
        weighedKg: input.weighedKg ?? null,
        customerRef: input.customerRef ?? null,
        note: input.note ?? null,
        checks,
        choices,
        barcodes: bc.value,
        pinEnc: keepPin ? latest!.pinEnc : pin ? this.cipher.encrypt(pin) : null,
        pinLength: keepPin ? latest!.pinLength : pin ? pin.length : null,
        rating: input.rating ?? null,
        podStatus,
        missing: check.missing as unknown as Prisma.InputJsonValue,
        reason: latest ? reason : null,
        createdBy: ctx.actorId ?? null,
      },
    });

    await this.dos.applyPodResult(
      tx,
      d,
      podStatus,
      podDoEvent(status, check.ok),
      latest ? reason : null,
    );
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type: 'pod.captured',
        entityType: 'delivery_order',
        localId: deliveryOrderId,
        snapshot: {
          deliveryOrderId: encodeId('deliveryOrder', deliveryOrderId),
          doNo: d.doNo,
          version: row.version,
          podStatus,
          source: opts.source,
          outcome: set,
          photoCount: photoIds.length,
          fileCount: fileIds.length,
          hasSignature: sigIds.length > 0,
          receiverName: row.receiverName,
          weighedKg: dec(row.weighedKg),
          missing: check.missing.map((m) => ({ key: m.key, type: m.type, code: m.code })),
        } as Prisma.InputJsonValue,
        requestId: ctx.requestId ?? null,
        actorId: ctx.actorId ?? null,
      },
    });
    await this.audit.record({
      action: latest ? 'pod.amended' : 'pod.recorded',
      entityType: 'delivery_order',
      entityId: deliveryOrderId,
      before: latest
        ? { version: latest.version, podStatus: latest.podStatus, ...this.auditView(latest) }
        : { podStatus: d.podStatus },
      after: { version: row.version, podStatus, doStatus: status, ...this.auditView(row) },
      ...(latest && reason ? { reason } : {}),
    });
    return this.view(deliveryOrderId, tx);
  }

  /**
   * DO เพิ่งเป็น DELIVERED จากการปิดจุด (ST4-T03 projection — ผู้เรียกถือล็อก SO → DO → trip แล้ว):
   * เทียบหลักฐานที่มี (ไม่มี = ว่าง) กับ checklist ชุดสำเร็จ → UNBILLED / POD_PENDING
   */
  async settleDelivered(tx: Tx, deliveryOrderId: string): Promise<void> {
    const d = await tx.deliveryOrder.findUniqueOrThrow({
      where: { id: deliveryOrderId },
      select: { id: true, status: true, version: true, podStatus: true, customerId: true },
    });
    if (d.status !== 'DELIVERED') return;
    const latest = await tx.deliveryOrderPod.findFirst({
      where: { deliveryOrderId },
      orderBy: { version: 'desc' },
    });
    const r = await this.checklist.check(
      d.customerId,
      'SUCCESS',
      latest ? this.submissionOf(latest) : EMPTY,
    );
    await this.dos.applyPodResult(
      tx,
      d,
      podStatusOf(!!latest, r.ok),
      podDoEvent('DELIVERED', r.ok),
      null,
    );
  }

  // ---------------------------------------------------------------------------------------------

  /** หลักฐานที่เก็บ → รูปที่ตัวตรวจใช้ (PIN ถอดในหน่วยความจำเพื่อตรวจรูปแบบเท่านั้น) */
  private submissionOf(r: DeliveryOrderPod): PodSubmission {
    let pin: string | null = null;
    if (r.pinEnc)
      try {
        pin = this.cipher.decrypt(r.pinEnc);
      } catch (e) {
        // กุญแจหาย/หมุนผิด — ไม่ลดสถานะเงียบ ๆ: นับว่ากรอกแล้ว (ตรวจรูปแบบตอนบันทึก) + log error + ธง pinUnreadable
        this.log.error(
          `pod ${r.id}: cannot decrypt PIN (${(e as Error).message}) — treated as entered; check FIELD_ENCRYPTION_KEYS`,
        );
        pin = '0'.repeat(r.pinLength ?? 4);
      }
    return {
      photoCount: r.photoDocumentIds.length,
      hasSignature: !!r.signatureDocumentId,
      note: r.note,
      checks: (r.checks ?? {}) as Record<string, boolean>,
      choices: (r.choices ?? {}) as Record<string, string>,
      scanCodes: r.barcodes,
      pin,
      rating: r.rating,
    };
  }

  private canDecrypt(v: string): boolean {
    try {
      this.cipher.decrypt(v);
      return true;
    } catch {
      return false;
    }
  }

  private decodeDocs(ids: string[] | undefined, field: string, errors: FieldError[]): string[] {
    const out: string[] = [];
    (ids ?? []).forEach((v, i) => {
      const id = tryDecodeId('document', v);
      if (!id)
        errors.push({
          field: field === 'signatureDocumentId' ? field : `${field}.${i}`,
          code: 'not_found',
          message: 'document not found',
        });
      else out.push(id);
    });
    return out;
  }

  private async documents(tx: Tx, ids: string[]): Promise<Map<string, StoredDocument>> {
    if (!ids.length) return new Map();
    const rows = await tx.storedDocument.findMany({ where: { id: { in: ids } } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const uuids = [...new Set(ids.filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
    if (!uuids.length) return new Map();
    const users = await this.db.tx.appUser.findMany({
      where: { id: { in: uuids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private versionDto(r: DeliveryOrderPod, names: Map<string, string>) {
    return {
      version: r.version,
      podStatus: r.podStatus,
      source: r.source,
      reason: r.reason,
      recordedBy: r.createdBy,
      recordedByName: (r.createdBy && names.get(r.createdBy)) ?? null,
      recordedAt: r.createdAt.toISOString(),
    };
  }

  private recordDto(
    r: DeliveryOrderPod,
    docs: Map<string, StoredDocument>,
    names: Map<string, string>,
  ): PodRecordDto {
    const doc = (id: string): PodDocumentDto[] => {
      const x = docs.get(id);
      return x
        ? [
            {
              id: encodeId('document', x.id),
              kind: x.kind,
              mime: x.mimeType,
              bytes: x.sizeBytes,
              filename: x.filename,
              createdAt: x.createdAt.toISOString(),
            },
          ]
        : [];
    };
    return {
      ...this.versionDto(r, names),
      outcome: r.outcome,
      receiverName: r.receiverName,
      receiverRelation: r.receiverRelation,
      signature: r.signatureDocumentId ? (doc(r.signatureDocumentId)[0] ?? null) : null,
      photos: r.photoDocumentIds.flatMap(doc),
      files: r.fileDocumentIds.flatMap(doc),
      weighedKg: dec(r.weighedKg),
      customerRef: r.customerRef,
      note: r.note,
      checks: (r.checks ?? {}) as Record<string, boolean>,
      choices: (r.choices ?? {}) as Record<string, string>,
      barcodes: r.barcodes,
      pinMasked: r.pinLength ? '•'.repeat(r.pinLength) : null,
      pinUnreadable: !!r.pinEnc && !this.canDecrypt(r.pinEnc),
      rating: r.rating,
      missing: (r.missing ?? []) as unknown as PodMissing[],
    };
  }

  /** ค่าใน audit (ไม่มี PIN) */
  private auditView(r: DeliveryOrderPod) {
    return {
      receiverName: r.receiverName,
      receiverRelation: r.receiverRelation,
      photos: r.photoDocumentIds.length,
      files: r.fileDocumentIds.length,
      signature: !!r.signatureDocumentId,
      weighedKg: dec(r.weighedKg),
      customerRef: r.customerRef,
      pinEntered: !!r.pinEnc,
    };
  }
}

const EMPTY: PodSubmission = { photoCount: 0, hasSignature: false };

/** entity_type ของ stored_document ที่ผูกกับหลักฐานส่ง (entity_id = DO) */
const POD_ENTITY = 'delivery_order';
/** DO ที่ต้องคงหลักฐานครบ (ผ่านด่านวางบิลแล้ว) */
const mustStayComplete = (s: DoStatus) => s === 'UNBILLED';

const FIELD_OF_MISSING: Record<string, string> = {
  PHOTO: 'photoDocumentIds',
  SIGNATURE: 'signatureDocumentId',
  NOTE: 'note',
  BARCODE: 'barcodes',
  PIN: 'pin',
  RATING: 'rating',
};

const FIELD_OF: Record<string, string> = {
  BARCODE: 'barcodes',
  PIN: 'pin',
  RATING: 'rating',
};

const docIdsOf = (r: DeliveryOrderPod) => [
  ...r.photoDocumentIds,
  ...r.fileDocumentIds,
  ...(r.signatureDocumentId ? [r.signatureDocumentId] : []),
];
