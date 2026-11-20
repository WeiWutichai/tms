import { Injectable } from '@nestjs/common';
import { type Connector, Prisma } from '@prisma/client';
import { tryDecodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import { PaymentsService } from '../payments/payments.service';
import type { InboundEffect } from './erp-adapter';
import { ERP_ENTITY } from './erp-sync.service';

const MONEY_RE = /^\d{1,12}\.\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ปัญหาที่ต้องให้คนตัดสิน (event ขึ้นคิว FAILED พร้อมรหัสนี้ — ไม่แก้เอกสาร TMS เอง) */
export interface InboundReview {
  code: string;
  message: string;
}

export interface InboundEffectsResult {
  applied: Record<string, unknown>[];
  review: InboundReview | null;
}

/**
 * ST8-T16 บันทึกผลทางธุรกิจของ webhook ขาเข้า (ไม่ผูก ERP ใด — adapter แปลง event เป็น `InboundEffect` แล้ว core ทำที่นี่)
 * ทำใน transaction เดียวกับการปิด event (rollback = ไม่มีผลและ event คง RECEIVED) · ต้องมี request context ของงานระบบ
 * - เอกสารลงบัญชี/ยกเลิกฝั่ง ERP → `external_mapping` (เลข + สถานะ) · ยกเลิกฝั่ง ERP แต่ใบ TMS ยังใช้อยู่ = คิวตรวจ (ไม่ยกเลิกใบ TMS)
 * - ลูกค้าชำระใน ERP (D-57) → `payment` source CONNECTOR + สถานะใบ (ST5-T18) · กันซ้ำด้วย mapping (payment, externalId)
 * - ERP จ่ายเจ้าหนี้ → เก็บเลขใบจ่าย/50 ทวิ ใน mapping ของใบสำคัญจ่าย
 */
@Injectable()
export class ErpInboundEffects {
  constructor(private readonly payments: PaymentsService) {}

  async apply(
    tx: Tx,
    c: Connector,
    effects: readonly InboundEffect[],
  ): Promise<InboundEffectsResult> {
    const out: InboundEffectsResult = { applied: [], review: null };
    const review = (code: string, message: string) => {
      out.review ??= { code, message: message.slice(0, 500) };
    };
    for (const e of effects.slice(0, 20)) {
      switch (e?.kind) {
        case 'externalDocument':
          await this.externalDocument(tx, c, e, out, review);
          break;
        case 'paymentReceived':
          await this.paymentReceived(tx, c, e, out, review);
          break;
        case 'paymentMade':
          await this.paymentMade(tx, c, e, out, review);
          break;
        default:
          review('unknown_effect', 'adapter returned an unknown effect');
      }
    }
    return out;
  }

  /** mapping ของเอกสารที่ TMS ส่งไป — หาจาก id ฝั่ง ERP ก่อน แล้วจึงเลข TMS */
  private async findMapping(
    tx: Tx,
    c: Connector,
    entityType: string,
    externalId: string | null | undefined,
    localNumber: string | null | undefined,
  ) {
    if (externalId) {
      const m = await tx.externalMapping.findFirst({
        where: { connectorId: c.id, entityType, externalId: externalId.slice(0, 200) },
      });
      if (m) return m;
    }
    if (localNumber)
      return tx.externalMapping.findFirst({
        where: { connectorId: c.id, entityType, localNumber: localNumber.slice(0, 60) },
      });
    return null;
  }

  private async externalDocument(
    tx: Tx,
    c: Connector,
    e: Extract<InboundEffect, { kind: 'externalDocument' }>,
    out: InboundEffectsResult,
    review: (code: string, message: string) => void,
  ) {
    if (e.entityType !== 'invoice' && e.entityType !== 'settlement')
      return review('unknown_entity', 'unknown entity type');
    const m = await this.findMapping(tx, c, e.entityType, e.externalId, e.localNumber);
    if (!m) {
      // เอกสารที่ไม่ได้มาจาก TMS (ไม่มีเลข TMS) = ไม่ใช่ของเรา ข้าม · มีเลข TMS แต่หาไม่เจอ = ให้คนดู
      if (!e.localNumber) {
        out.applied.push({ kind: e.kind, skipped: 'not_from_tms' });
        return;
      }
      return review(
        'mapping_not_found',
        `${e.entityType} ${e.localNumber} was not sent from TMS to this connector`,
      );
    }
    await tx.externalMapping.update({
      where: { id: m.id },
      data: {
        externalDocNo: e.externalDocNo?.slice(0, 100) ?? m.externalDocNo,
        externalStatus: e.status,
        ...(e.externalId && !m.externalId ? { externalId: e.externalId.slice(0, 200) } : {}),
        ...(e.status === 'VOIDED'
          ? {
              detail: {
                ...((m.detail as Record<string, unknown> | null) ?? {}),
                voidReason: e.reason?.slice(0, 300) ?? null,
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    out.applied.push({
      kind: e.kind,
      entityType: e.entityType,
      number: m.localNumber,
      status: e.status,
      externalDocNo: e.externalDocNo ?? null,
    });
    if (e.status !== 'VOIDED') return;
    // ERP ยกเลิกเอกสาร — ใบ TMS ที่ยังใช้อยู่ไม่ถูกยกเลิกอัตโนมัติ (acceptance ST8-T16 ข้อ 3) → คิวให้คนตัดสิน
    const tmsCancelled =
      e.entityType === 'invoice'
        ? (await tx.invoice.findUnique({ where: { id: m.localId }, select: { status: true } }))
            ?.status === 'CANCELLED'
        : (
            await tx.carrierSettlement.findUnique({
              where: { id: m.localId },
              select: { status: true },
            })
          )?.status === 'CANCELLED';
    if (!tmsCancelled)
      review(
        'external_document_voided',
        `${e.entityType} ${m.localNumber ?? m.localId} was voided in the accounting system${
          e.externalDocNo ? ` (${e.externalDocNo})` : ''
        } — decide in TMS`,
      );
  }

  private async paymentReceived(
    tx: Tx,
    c: Connector,
    e: Extract<InboundEffect, { kind: 'paymentReceived' }>,
    out: InboundEffectsResult,
    review: (code: string, message: string) => void,
  ) {
    if (!e.externalId || !DATE_RE.test(e.receivedDate))
      return review('invalid_effect', 'payment without id/date');
    const dup = await tx.externalMapping.findFirst({
      where: { connectorId: c.id, entityType: ERP_ENTITY.payment, externalId: e.externalId },
    });
    if (dup) {
      out.applied.push({ kind: e.kind, skipped: 'already_recorded' });
      return;
    }
    const allocations: { invoiceId: string; amount: Prisma.Decimal; whtAmount: Prisma.Decimal }[] =
      [];
    for (const a of e.allocations.slice(0, 200)) {
      if (!MONEY_RE.test(a.amount) || !MONEY_RE.test(a.whtAmount))
        return review('invalid_effect', 'payment amount is not a money string');
      const m = await this.findMapping(tx, c, ERP_ENTITY.invoice, a.externalId, a.localNumber);
      if (!m) {
        if (!a.localNumber) continue; // ใบที่ไม่ได้มาจาก TMS
        return review(
          'payment_unmatched',
          `payment ${e.externalDocNo ?? e.externalId}: invoice ${a.localNumber} not found in TMS`,
        );
      }
      allocations.push({
        invoiceId: m.localId,
        amount: new Prisma.Decimal(a.amount),
        whtAmount: new Prisma.Decimal(a.whtAmount),
      });
    }
    if (!allocations.length) {
      out.applied.push({ kind: e.kind, skipped: 'not_from_tms' });
      return;
    }
    const r = await this.payments.recordFromConnector(tx, {
      receivedDate: e.receivedDate,
      reference: e.externalDocNo,
      note: e.externalDocNo ? `${e.externalDocNo}` : null,
      allocations,
    });
    if (!r.ok)
      return review(
        r.code === 'payment_exceeds_outstanding' ? 'payment_mismatch' : r.code,
        `payment ${e.externalDocNo ?? e.externalId}: ${r.message}`,
      );
    const paymentId = r.payment.id;
    const localId = tryDecodeId('payment', paymentId)!;
    await tx.externalMapping.create({
      data: {
        tenantId: c.tenantId,
        connectorId: c.id,
        entityType: ERP_ENTITY.payment,
        localId,
        localNumber: r.payment.paymentNo,
        externalId: e.externalId.slice(0, 200),
        externalDocNo: e.externalDocNo?.slice(0, 100) ?? null,
        externalStatus: 'POSTED',
        syncedAt: new Date(),
      },
    });
    out.applied.push({ kind: e.kind, paymentId, paymentNo: r.payment.paymentNo });
  }

  private async paymentMade(
    tx: Tx,
    c: Connector,
    e: Extract<InboundEffect, { kind: 'paymentMade' }>,
    out: InboundEffectsResult,
    review: (code: string, message: string) => void,
  ) {
    let matched = 0;
    for (const a of e.allocations.slice(0, 200)) {
      const m = await this.findMapping(tx, c, ERP_ENTITY.settlement, a.externalId, null);
      if (!m) continue; // บิลที่ไม่ได้มาจาก TMS
      matched++;
      const s = await tx.carrierSettlement.findUnique({
        where: { id: m.localId },
        select: { status: true },
      });
      await tx.externalMapping.update({
        where: { id: m.id },
        data: {
          externalStatus: 'PAID',
          detail: {
            ...((m.detail as Record<string, unknown> | null) ?? {}),
            paymentExternalId: e.externalId.slice(0, 200),
            paymentDocNo: e.externalDocNo?.slice(0, 100) ?? null,
            paidAmount: MONEY_RE.test(a.amount) ? a.amount : null,
            whtAmount: MONEY_RE.test(a.whtAmount) ? a.whtAmount : null,
            whtCertificates: e.certificates.slice(0, 20).map((x) => String(x).slice(0, 60)),
          } as Prisma.InputJsonValue,
        },
      });
      out.applied.push({ kind: e.kind, settlement: m.localNumber, paymentDocNo: e.externalDocNo });
      if (s?.status !== 'PAID')
        review(
          'settlement_not_paid_in_tms',
          `settlement ${m.localNumber ?? m.localId} was paid in the accounting system but is ${s?.status ?? 'missing'} in TMS`,
        );
    }
    if (!matched) out.applied.push({ kind: e.kind, skipped: 'not_from_tms' });
  }
}
