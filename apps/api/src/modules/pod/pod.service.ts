import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type DeliveryOrderPod, type StoredDocument } from '@prisma/client';
import {
  checkActualLines,
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
  type ActualLineErrorCode,
  type ActualLineValue,
  type PodSubmission,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { FieldCipher } from '../../common/crypto';
import { encodeId, tryDecodeId } from '../../common/ids';
import { assertDeliveryUnlocked } from '../invoices/billing-lock';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { ReasonCodesService, toReasonUuid } from '../reason-codes/reason-codes.service';
import type { ReasonSnapshot } from '../reason-codes/snapshot';
import { actorNames } from '../stops/actor-names';
import { PodChecklistService } from './pod-checklist.service';
import type {
  DeliveryOrderPodDto,
  PodDocumentDto,
  PodLineDto,
  PodRecordDto,
  SubmitPodDto,
} from './pod.dto';

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
    private readonly reasons: ReasonCodesService,
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
    const eff = await this.effectiveStatus(tx, d.id, d.status as DoStatus);
    const cl = await this.checklist.forCustomer(d.customerId, podSetForDo(eff));
    const missing = validatePod(cl, cur ? this.submissionOf(cur) : EMPTY).missing;
    const names = await this.userNames(rows.map((r) => r.createdBy));
    const docs = cur ? await this.documents(tx, docIdsOf(cur)) : new Map<string, StoredDocument>();
    const doLines = await tx.deliveryOrderLine.findMany({
      where: { deliveryOrderId },
      orderBy: { lineNo: 'asc' },
      select: {
        lineNo: true,
        description: true,
        unit: true,
        qtyPlanned: true,
        salesOrderLine: { select: { unitRef: { select: { nameTh: true } } } },
      },
    });
    return {
      deliveryOrderId: encodeId('deliveryOrder', d.id),
      doNo: d.doNo ?? '',
      doStatus: d.status,
      podStatus: d.podStatus,
      editable: isPodEditable(eff),
      plannedWeightKg: dec(d.weightKg),
      checklist: cl,
      missing,
      current: cur ? this.recordDto(cur, docs, names) : null,
      versions: rows.map((r) => this.versionDto(r, names)),
      lines: linesDto(doLines, cur ? storedLines(cur) : []),
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
    const status = await this.effectiveStatus(tx, d.id, d.status as DoStatus);
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

    // ST4-T10 ยอดส่งจริงต่อรายการ — ไม่ส่ง = คงค่าเดิมของฉบับก่อน · เฉพาะชุดสำเร็จ (DO ส่งแล้ว)
    const prevLines = latest ? storedLines(latest) : [];
    let lines: StoredLine[] = prevLines;
    const doLines = await tx.deliveryOrderLine.findMany({
      where: { deliveryOrderId },
      orderBy: { lineNo: 'asc' },
      select: { id: true, lineNo: true, qtyPlanned: true },
    });
    if (input.lines !== undefined && input.lines.length && set !== 'SUCCESS')
      errors.push({
        field: 'lines',
        code: 'not_applicable',
        message: 'actual quantities are recorded for delivered orders only',
      });
    else if (input.lines?.length) {
      const checked = checkActualLines(
        doLines.map((l) => ({ lineNo: l.lineNo, qtyPlanned: l.qtyPlanned.toFixed() })),
        input.lines,
        prevLines.map(valueOf),
      );
      for (const e of checked.errors)
        errors.push({
          field: `lines.${e.index}.${e.field}`,
          code: e.code,
          message: LINE_MESSAGES[e.code],
        });
      if (!checked.errors.length) {
        // เหตุผล: ตรวจหมวด/ใช้งาน + snapshot เฉพาะบรรทัดที่ส่งมา (บรรทัดที่คงเดิมใช้ snapshot เดิม)
        const sent = new Map(input.lines.map((l, i) => [l.lineNo, i]));
        const prevBy = new Map(prevLines.map((l) => [l.lineNo, l]));
        lines = [];
        for (const v of checked.lines) {
          const i = sent.get(v.lineNo);
          if (i === undefined) {
            lines.push(prevBy.get(v.lineNo)!);
            continue;
          }
          // เหตุผลเดิมของบรรทัด (ส่งซ้ำ/ฉบับแก้) ใช้ snapshot เดิม — ปิดใช้ภายหลังไม่ทำให้ส่งซ้ำล้ม (ตรวจเฉพาะเมื่อเปลี่ยนเหตุผล)
          const prevReason = prevBy.get(v.lineNo)?.reason ?? null;
          const reason = !v.rejectReasonCodeId
            ? null
            : prevReason && toReasonUuid(v.rejectReasonCodeId) === prevReason.sourceId
              ? prevReason
              : await this.reasons.snapshotFor(
                  v.rejectReasonCodeId,
                  'REJECTED_BY_RECEIVER',
                  `lines.${i}.rejectReasonCodeId`,
                );
          lines.push({
            lineNo: v.lineNo,
            qtyPlanned: v.qtyPlanned,
            qtyActual: v.qtyActual,
            rejectQty: v.rejectQty,
            reason: reason ? { ...reason, flags: { ...reason.flags } } : null,
            note: v.note,
          });
        }
      }
    }
    // ธงของเหตุผล (ทุกบรรทัดที่มีปฏิเสธ รวมที่คงเดิม): บังคับโน้ต / บังคับรูป (รูปของหลักฐานส่งฉบับนี้)
    lines.forEach((l) => {
      if (!l.reason) return;
      const i = input.lines?.findIndex((x) => x.lineNo === l.lineNo) ?? -1;
      if (l.reason.flags.requiresNote && !l.note)
        errors.push({
          field: i >= 0 ? `lines.${i}.note` : 'lines',
          code: 'note_required',
          message: `reason ${l.reason.code} requires a note`,
        });
      if (l.reason.flags.requiresPhoto && photoIds.length === 0)
        errors.push({
          field: 'photoDocumentIds',
          code: 'photo_required',
          message: `reason ${l.reason.code} requires at least one photo`,
        });
    });

    // ST4-T11: ของที่ปฏิเสธรับซึ่งส่งซ้ำ/คืนคลังไปแล้ว — ฉบับแก้ต้องคงยอดปฏิเสธ ≥ ที่จัดการแล้ว (ยกเลิกใบส่งซ้ำก่อน)
    if (input.lines?.length && set === 'SUCCESS') {
      const doRec = await this.dos.get(deliveryOrderId, tx);
      const bal = (await this.dos.rejectionBalance(tx, [doRec])).get(deliveryOrderId) ?? [];
      for (const b of bal) {
        const done = b.redelivered.add(b.returned);
        if (done.lte(0)) continue;
        const l = lines.find((x) => x.lineNo === b.line.lineNo);
        if (l && new Prisma.Decimal(l.rejectQty).lt(done)) {
          const i = input.lines.findIndex((x) => x.lineNo === b.line.lineNo);
          errors.push({
            field: i >= 0 ? `lines.${i}.qtyActual` : 'lines',
            code: 'reject_resolved',
            message: `rejected quantity already redelivered/returned (${done.toFixed()}) — cancel the redelivery first`,
          });
        }
      }
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

    // ST5-T06 (docs/04 F4 RELEASED "แก้ stop/qty ไม่ได้"): ยอดส่งจริง/ปฏิเสธรับเปลี่ยน หลังส่งบัญชี/อยู่ในใบแจ้งหนี้ → 409
    // (แนบรูป/เอกสารเพิ่มโดยยอดเดิมยังได้)
    const qtyChanged =
      stableLines(lines) !== stableLines(prevLines) || (!latest && lines.length > 0);
    if (qtyChanged) assertDeliveryUnlocked(d, 'lines');

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
        lines: lines as unknown as Prisma.InputJsonValue,
        createdBy: ctx.actorId ?? null,
      },
    });
    // ฉายยอดส่งจริงลงบรรทัด DO (ค่าปัจจุบันสำหรับวางบิล/ตีกลับ — ST5-T01, ST4-T11)
    if (qtyChanged)
      await this.dos.applyActualQty(
        tx,
        deliveryOrderId,
        lines.map((l) => ({
          lineNo: l.lineNo,
          qtyActual: l.qtyActual,
          rejectQty: l.rejectQty,
          rejectReasonCodeId: l.reason?.sourceId ?? null,
        })),
      );

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
        // ST7-T06 (QA): data.object = รูปเดียวกับ `GET /v1/delivery-orders/{id}/pod` (ไม่มี URL ไฟล์/ราคา; PIN แบบปิดบัง)
        snapshot: JSON.parse(
          JSON.stringify(await this.view(deliveryOrderId, tx)),
        ) as Prisma.InputJsonValue,
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
  /**
   * ST4-T12 (review H2): ใบที่ยกเลิกด้วย redeliver (นัดส่งใหม่) = ส่งไม่สำเร็จ สำหรับหลักฐาน — ยังบันทึก/แก้หลักฐานชุด
   * "ไม่สำเร็จ" ได้ (รูปหน้าร้านปิด ฯลฯ ที่จุดนั้น) · สถานะ DO ไม่เปลี่ยน (`podDoEvent(FAILED)` = ไม่มี transition)
   */
  private async effectiveStatus(tx: Tx, id: string, status: DoStatus): Promise<DoStatus> {
    return status === 'CANCELLED' && (await this.dos.isRedeliverCancelled(tx, id, status))
      ? 'FAILED'
      : status;
  }

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

  /**
   * ST5-T04 (ส่งต่อจาก ST4-T07): หลักฐานฉบับล่าสุดผ่าน checklist ชุดสำเร็จของลูกค้า **ปัจจุบัน** ไหม
   * (ไม่มีหลักฐาน = ตรวจกับชุดว่าง — ลูกค้าที่ไม่บังคับอะไรผ่าน) — ใช้ตอนส่งบัญชี ไม่เขียนอะไร
   */
  async checkCurrent(
    tx: Tx,
    d: { id: string; customerId: string },
  ): Promise<{ ok: boolean; missing: PodMissing[] }> {
    const latest = await tx.deliveryOrderPod.findFirst({
      where: { deliveryOrderId: d.id },
      orderBy: { version: 'desc' },
    });
    const r = await this.checklist.check(
      d.customerId,
      'SUCCESS',
      latest ? this.submissionOf(latest) : EMPTY,
    );
    return { ok: r.ok, missing: r.missing };
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

  /** ผู้ใช้ภายใน + ST4-T09 `link:{id}` = ชื่อรถร่วมของลิงก์ */
  private userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    return actorNames(this.db.tx, ids);
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
      lines: storedLines(r).map((l) => ({
        lineNo: l.lineNo,
        qtyActual: l.qtyActual,
        rejectQty: l.rejectQty,
        reason: l.reason?.code ?? null,
        note: l.note,
      })),
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

/** ยอดส่งจริงของบรรทัดหนึ่งที่เก็บในฉบับ (`delivery_order_pod.lines`) */
interface StoredLine {
  lineNo: number;
  qtyPlanned: string;
  qtyActual: string;
  rejectQty: string;
  reason: ReasonSnapshot | null;
  note: string | null;
}

const storedLines = (r: DeliveryOrderPod): StoredLine[] =>
  Array.isArray(r.lines) ? (r.lines as unknown as StoredLine[]) : [];

const valueOf = (l: StoredLine): ActualLineValue => ({
  lineNo: l.lineNo,
  qtyPlanned: l.qtyPlanned,
  qtyActual: l.qtyActual,
  rejectQty: l.rejectQty,
  rejectReasonCodeId: l.reason?.sourceId ?? null,
  note: l.note,
});

const stableLines = (ls: StoredLine[]) =>
  JSON.stringify(
    ls.map((l) => [l.lineNo, l.qtyActual, l.rejectQty, l.reason?.sourceId ?? null, l.note]),
  );

const LINE_MESSAGES: Record<ActualLineErrorCode, string> = {
  unknown_line: 'line not found on this delivery order',
  duplicate: 'line is listed more than once',
  invalid: 'quantity must be a decimal ≥ 0 with up to 3 places',
  exceeds_planned: 'actual quantity exceeds the planned quantity',
  reason_required: 'a reject reason (REJECTED_BY_RECEIVER) is required when actual < planned',
  reason_not_applicable: 'no reject reason when the full planned quantity was delivered',
  reject_qty_mismatch: 'rejectQty must equal planned − actual',
  too_long: 'note is too long',
};

/** บรรทัด DO + ค่าปัจจุบัน (ไม่มีในฉบับ = ยังไม่บันทึก) */
function linesDto(
  doLines: {
    lineNo: number;
    description: string;
    unit: string;
    qtyPlanned: Prisma.Decimal;
    salesOrderLine: { unitRef: { nameTh: string } | null } | null;
  }[],
  stored: StoredLine[],
): PodLineDto[] {
  const by = new Map(stored.map((l) => [l.lineNo, l]));
  return doLines.map((d) => {
    const l = by.get(d.lineNo);
    return {
      lineNo: d.lineNo,
      description: d.description,
      // ชื่อหน่วยที่ผู้ใช้เห็น (ตัน ถุง …) — ไม่มีหน่วยใน master = ข้อความหน่วย snapshot
      unit: d.salesOrderLine?.unitRef?.nameTh ?? d.unit,
      qtyPlanned: dec(d.qtyPlanned)!,
      qtyActual: l?.qtyActual ?? null,
      rejectQty: l?.rejectQty ?? null,
      rejectReason: l?.reason
        ? {
            id: encodeId('reasonCode', l.reason.sourceId),
            code: l.reason.code,
            label: l.reason.label,
          }
        : null,
      note: l?.note ?? null,
    };
  });
}
