import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  bangkokDay,
  decimalFromSatang,
  estimateSettlementWht,
  eventDefinition,
  satangFromDecimal,
  type SettlementLineKind,
  type SettlementWhtEstimate,
} from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { resolveActors } from '../../common/actors';
import { encodeId, tryDecodeId } from '../../common/ids';
import { redactPrices } from '../../common/price-fields';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { ErpSyncService } from '../erp/erp-sync.service';
import { issueNumber } from '../sequences/sequences.service';
import { TripService } from '../trips/trip.service';
import { readSettings } from '../settings/settings.service';
import type {
  CreateSettlementDto,
  SettlementCarrierDto,
  SettlementDto,
  SettlementItemsInput,
  SettlementLineDto,
  SettlementListQuery,
  SettlementPageDto,
  SettlementPayDto,
  SettlementStatus,
  SettlementKpiDto,
  SettlementSummaryDto,
  UpdateSettlementDto,
} from './settlement.dto';
import { resolvePayer } from './settlement-payer';
import { payableLines, SettlementQueueService } from './settlement-queue.service';
import { disputedCount, disputedLines, latestBy, lineStatus } from './settlement-dispute';
import type { SettlementSentDto, SettlementReviewLinkDto } from './settlement-review.dto';
import {
  latestReviews,
  REVIEW_ORDER,
  REVIEW_REVOKE_REASON,
  SettlementReviewService,
} from './settlement-review.service';

const ENTITY = 'carrier_settlement';
/** ผู้อนุมัติได้ = ผู้ใช้ที่ login (`dev` = token ทดสอบ — production ปฏิเสธ) — ไม่ใช่ API key / ลิงก์ (review H1) */
const HUMAN_PRINCIPALS = new Set(['user', 'dev']);
/** เพดาน numeric(14,2) */
const MAX_AMOUNT = '999999999999.99';

type SettlementRow = Prisma.CarrierSettlementGetPayload<{
  include: {
    carrier: { select: { whtRateDefault: true } };
    lines: {
      include: { tripCost: { select: { costType: true } }; trip: { select: { tripNo: true } } };
    };
    reviews: true;
    disputes: true;
  };
}>;

interface CarrierSnapshot {
  code: string;
  legalName: string;
  entityType: string;
  taxId: string | null;
  taxIdLast4: string | null;
  branchCode: string | null;
  address: unknown;
}

/** บรรทัดต้นทุนที่จะใส่ใบ (ผ่านกฎคิวจ่ายแล้ว) */
interface CostPick {
  id: string;
  tripId: string;
  costType: string;
  amount: Prisma.Decimal;
  description: string | null;
  vatType: string | null;
  whtRate: Prisma.Decimal | null;
}

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isRealDay = (s: string) => !Number.isNaN(day(s).getTime()) && ymd(day(s)) === s;

/**
 * ใบสำคัญจ่ายรถร่วม — ร่าง (ST6-T03; docs/04 F6 "ติ๊กเที่ยว → ใบสำคัญจ่าย", docs/01 §3.6/§4.5, spec/05 §11)
 *
 * - ติ๊กเที่ยว (`tripIds`) หรือบรรทัดต้นทุน (`tripCostIds`) ที่อยู่ในคิวจ่าย (กฎเดียวกับ `GET /settlements/queue`: เที่ยว COSTED ของรถร่วมรายปัจจุบัน,
 *   "ไม่มี POD ไม่จ่าย", บรรทัด CONFIRMED ที่ยังไม่อยู่ในใบ, คู่กลับรายการที่ยังไม่จ่ายไม่นับ) → บรรทัด FREIGHT (CARRIER_FEE) / SURCHARGE (อื่น ๆ)
 * - บรรทัดหัก (DEDUCTION) กรอกมือ ยอดติดลบ + เอกสารอ้างอิง
 * - กันจ่ายซ้ำ (K11): ล็อกบรรทัดต้นทุนของเที่ยว (FOR UPDATE) แล้วตรวจ `settlement_line_id` → 409 `trip_cost_already_settled` ·
 *   ชั้น DB = partial unique index `settlement_line_active_trip_cost_key` (บรรทัดที่ยังใช้) — ชนกันพร้อมกัน = 409 เดียวกัน
 * - ยอด: gross = Σ บรรทัดเที่ยวที่ยังใช้ · deduction = Σ |บรรทัดหัก| · net = gross − deduction (CHECK ใน DB) · ไม่คิด VAT ขาซื้อ (#58)
 * - หัก ณ ที่จ่ายประมาณการ (ST6-T08): `estimateSettlementWht` (@tms/domain → computeDocumentTax ของ ST5-T02) — คำนวณสดจนอนุมัติ แล้วตรึง
 * - ร่างไม่มีเลขเอกสาร (เลข STL ออกตอนอนุมัติ — ST6-T07) · นำบรรทัดออก / ยกเลิกใบ = void + เหตุผล + audit → บรรทัดต้นทุนกลับคิว
 */
@Injectable()
export class SettlementsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly queue: SettlementQueueService,
    private readonly review: SettlementReviewService,
    private readonly trips: TripService,
    private readonly erpSync: ErpSyncService,
  ) {}

  // ---------- อ่าน ----------

  async list(q: SettlementListQuery): Promise<SettlementPageDto> {
    const tx = this.db.tx;
    const k = keysetArgs(q);
    const and: Prisma.CarrierSettlementWhereInput[] = [
      k.where as Prisma.CarrierSettlementWhereInput,
    ];
    // คั่นด้วย , ได้ (แท็บหน้า `settle` — เช่น DRAFT,DISPUTED)
    if (q.status) and.push({ status: { in: q.status.split(',') as SettlementStatus[] } });
    if (q.carrierId !== undefined) {
      const carrierId = await this.carrierRef(tx, q.carrierId);
      and.push({ carrierId: carrierId ?? '00000000-0000-0000-0000-000000000000' });
    }
    const rows = await tx.carrierSettlement.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.CarrierSettlementOrderByWithRelationInput[],
      take: k.take,
      include: {
        carrier: { select: { whtRateDefault: true } },
        lines: {
          where: { voidedAt: null },
          select: { tripId: true, lineType: true, amount: true, whtRate: true, voidedAt: true },
        },
      },
    });
    const minimum = await this.liveWhtMinimum(tx);
    const page = toPage(
      rows,
      k,
      (r): SettlementSummaryDto => {
        // ใบที่ snapshot รถร่วมไม่มีประเภท (บุคคล/นิติบุคคล) จัดแบบยื่นไม่ได้ → แถวนั้น whtForm = null และไม่มียอดประมาณการ
        // (ยกเว้นยอดที่ตรึงแล้ว) — ไม่เดากฎภาษี และแถวเดียวไม่ทำให้ทั้งรายการ 500
        const known = hasWhtEntityType(r.carrierSnapshot);
        const wht = known ? whtOf(r, r.lines, minimum) : null;
        return {
          id: encodeId('settlement', r.id),
          settlementNo: r.settlementNo,
          status: r.status as SettlementStatus,
          carrier: carrierDto(r.carrierId, r.carrierSnapshot),
          periodFrom: ymd(r.periodFrom),
          periodTo: ymd(r.periodTo),
          carrierInvoiceNo: r.carrierInvoiceNo,
          tripCount: new Set(r.lines.filter((l) => l.lineType !== 'DEDUCTION').map((l) => l.tripId))
            .size,
          buyGrossAmount: r.grossAmount.toFixed(2),
          buyDeductionAmount: r.deductionAmount.toFixed(2),
          buyNetPayable: r.netPayable.toFixed(2),
          ...(wht ? whtTotals(r, wht) : frozenTotals(r)),
          whtForm: wht?.form ?? null,
          approvedAt: r.approvedAt?.toISOString() ?? null,
          paidDate: r.paidDate ? ymd(r.paidDate) : null,
          sentAt: r.sentAt?.toISOString() ?? null,
          createdBy: r.createdBy,
          version: r.version,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      },
      q.fields,
    );
    return page as SettlementPageDto;
  }

  /**
   * KPI + จำนวนต่อแท็บของหน้า `settle` (ต้นแบบ kpisX('settle'): รอตรวจ · รออนุมัติ · อนุมัติแล้ว · จ่ายแล้วเดือนนี้ ฿)
   * จ่ายแล้วเดือนนี้ = Σ (ยอดสุทธิ − หัก ณ ที่จ่ายที่ตรึง) ของใบ PAID ที่ `paid_date` อยู่ในเดือนนี้ (เวลาไทย) — ใบ PAID ต้องตรึง WHT (CHECK 0139)
   */
  async kpi(): Promise<SettlementKpiDto> {
    const tx = this.db.tx;
    const today = bangkokDay(new Date().toISOString());
    const monthStart = `${today.slice(0, 7)}-01`;
    const rows = await tx.$queryRaw<
      {
        total: bigint;
        draft: bigint;
        sent: bigint;
        disputed: bigint;
        approved: bigint;
        paid: bigint;
        cancelled: bigint;
        paid_month: Prisma.Decimal;
      }[]
    >`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'DRAFT') AS draft,
             COUNT(*) FILTER (WHERE status = 'SENT_TO_CARRIER') AS sent,
             COUNT(*) FILTER (WHERE status = 'DISPUTED') AS disputed,
             COUNT(*) FILTER (WHERE status = 'APPROVED') AS approved,
             COUNT(*) FILTER (WHERE status = 'PAID') AS paid,
             COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
             COALESCE(SUM(net_payable - COALESCE(wht_amount, 0))
               FILTER (WHERE status = 'PAID' AND paid_date >= ${monthStart}::date AND paid_date <= ${today}::date), 0) AS paid_month
        FROM carrier_settlement`;
    const r = rows[0]!;
    return {
      total: Number(r.total),
      draft: Number(r.draft),
      sentToCarrier: Number(r.sent),
      disputed: Number(r.disputed),
      approved: Number(r.approved),
      paid: Number(r.paid),
      cancelled: Number(r.cancelled),
      buyPaidThisMonth: new Prisma.Decimal(r.paid_month).toFixed(2),
    };
  }

  async get(id: string): Promise<SettlementDto> {
    const tx = this.db.tx;
    const r = await this.load(tx, id);
    if (!r) throw new ProblemException('not_found');
    // รายการโต้แย้งค้าง — นิยามเดียวกับ trigger ที่บล็อกอนุมัติ (ST6-T06)
    // snapshot รถร่วมไม่มีประเภท → ไม่มีผลประมาณการ (whtEstimate null) แทน 500 — ดู hasWhtEntityType
    const wht = hasWhtEntityType(r.carrierSnapshot)
      ? whtOf(r, r.lines, await this.liveWhtMinimum(tx))
      : null;
    return toDto(r, await disputedLines(tx, id, r.reviewRound), wht);
  }

  /**
   * ST6-T11 ยอดจ่ายสุทธิหลังหัก ณ ที่จ่ายของหลายใบในครั้งเดียว (ลิงก์ "ค่าเที่ยวของฉัน") — สูตรเดียวกับ `get`/`list`
   * (ตรึงแล้ว = netPayable − wht_amount · ยังไม่ตรึง = `whtOf` ประมาณการ) · ไม่รู้ประเภทรถร่วมและยังไม่ตรึง = null (ไม่เดา)
   */
  async netAfterWhtMany(
    ids: string[],
  ): Promise<Map<string, { amount: string | null; frozen: boolean }>> {
    const out = new Map<string, { amount: string | null; frozen: boolean }>();
    if (!ids.length) return out;
    const tx = this.db.tx;
    const rows = await tx.carrierSettlement.findMany({
      where: { id: { in: ids } },
      include: {
        carrier: { select: { whtRateDefault: true } },
        lines: {
          where: { voidedAt: null },
          select: { lineType: true, amount: true, whtRate: true, voidedAt: true },
        },
      },
    });
    const unfrozen = rows.filter((r) => r.whtAmount === null);
    const minimum = unfrozen.length ? await this.liveWhtMinimum(tx) : 0;
    for (const r of rows) {
      if (r.whtAmount !== null) {
        out.set(r.id, { amount: r.netPayable.minus(r.whtAmount).toFixed(2), frozen: true });
        continue;
      }
      const wht = hasWhtEntityType(r.carrierSnapshot) ? whtOf(r, r.lines, minimum) : null;
      out.set(r.id, {
        amount: wht ? whtTotals(r, wht).buyNetAfterWht : null,
        frozen: false,
      });
    }
    return out;
  }

  /** ค่าตั้ง `tax.whtMinimumAmount` (บาท) ปัจจุบัน — ใช้กับใบที่ยังไม่ตรึง (ยังไม่อนุมัติ) */
  private async liveWhtMinimum(tx: Tx): Promise<number> {
    const ctx = requestContext.require();
    return (await readSettings(tx, ctx.tenantId!, ['tax.whtMinimumAmount']))[
      'tax.whtMinimumAmount'
    ] as number;
  }

  // ---------- เขียน ----------

  async create(body: CreateSettlementDto): Promise<SettlementDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const carrierId = await this.carrierRef(tx, body.carrierId);
    if (!carrierId)
      throw invalid([
        { field: 'carrierId', code: 'invalid_reference', message: 'carrier not found' },
      ]);
    const carrier = await tx.carrier.findFirst({ where: { id: carrierId, deletedAt: null } });
    if (!carrier)
      throw invalid([
        { field: 'carrierId', code: 'invalid_reference', message: 'carrier not found' },
      ]);
    if (!body.tripIds?.length && !body.tripCostIds?.length)
      throw invalid([
        { field: 'tripIds', code: 'required', message: 'tick at least one trip or trip cost line' },
      ]);
    this.checkDates(body);
    const picks = await this.pickCosts(tx, carrierId, body);
    const deductions = await this.checkDeductions(tx, carrierId, body);
    const period = await this.defaultPeriod(tx, picks, body.periodFrom, body.periodTo);

    const snapshot: CarrierSnapshot = {
      code: carrier.code,
      legalName: carrier.legalName,
      entityType: carrier.entityType,
      taxId: carrier.entityType === 'JURISTIC' ? carrier.taxId : null,
      taxIdLast4: carrier.entityType === 'JURISTIC' ? null : carrier.taxIdLast4,
      branchCode: carrier.branchCode,
      address: carrier.address ?? null,
    };
    const s = await tx.carrierSettlement.create({
      data: {
        tenantId: ctx.tenantId!,
        carrierId,
        carrierSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        payingCompanyId: carrier.billingCompanyId,
        periodFrom: day(period.from),
        periodTo: day(period.to),
        carrierInvoiceNo: body.carrierInvoiceNo ?? null,
        carrierInvoiceDate: body.carrierInvoiceDate ? day(body.carrierInvoiceDate) : null,
        carrierReceiptNo: body.carrierReceiptNo ?? null,
        note: body.note ?? null,
        createdBy: ctx.actorId ?? null,
        // ST6-T08: ค่าตั้งต้นอัตราหัก ณ ที่จ่ายของรถร่วม ณ วันสร้างใบ (บรรทัดที่ไม่มีธง)
        whtRateDefault: carrier.whtRateDefault,
      },
    });
    const added = await this.insertLines(tx, s.id, 0, picks, deductions);
    await this.recompute(tx, s.id, false);
    const out = await this.get(s.id);
    await this.audit.record({
      action: 'settlement.created',
      entityType: ENTITY,
      entityId: s.id,
      after: {
        carrierId: out.carrier.id,
        periodFrom: out.periodFrom,
        periodTo: out.periodTo,
        carrierInvoiceNo: out.carrierInvoiceNo,
        lines: added,
        buyGrossAmount: out.buyGrossAmount,
        buyDeductionAmount: out.buyDeductionAmount,
        buyNetPayable: out.buyNetPayable,
      },
    });
    return out;
  }

  async update(
    id: string,
    body: UpdateSettlementDto,
    expected: number | undefined,
  ): Promise<SettlementDto> {
    const tx = this.db.tx;
    const s = await this.lockDraft(tx, id, expected);
    this.checkDates(body);
    const from = body.periodFrom ?? ymd(s.periodFrom);
    const to = body.periodTo ?? ymd(s.periodTo);
    if (from > to)
      throw invalid([
        { field: 'periodTo', code: 'before_period_from', message: 'periodTo must be ≥ periodFrom' },
      ]);
    const before = headerOf(s);
    const data: Prisma.CarrierSettlementUpdateInput = {
      periodFrom: day(from),
      periodTo: day(to),
      // ผู้แก้หัวใบ = ผู้เตรียมใบ (อนุมัติใบนี้ไม่ได้ — SoD ST6-T07)
      updatedBy: requestContext.require().actorId ?? null,
      version: { increment: 1 },
    };
    if (body.carrierInvoiceNo !== undefined) data.carrierInvoiceNo = body.carrierInvoiceNo || null;
    if (body.carrierInvoiceDate !== undefined)
      data.carrierInvoiceDate = body.carrierInvoiceDate ? day(body.carrierInvoiceDate) : null;
    if (body.carrierReceiptNo !== undefined) data.carrierReceiptNo = body.carrierReceiptNo || null;
    if (body.note !== undefined) data.note = body.note || null;
    const after = await tx.carrierSettlement.update({ where: { id }, data });
    await this.audit.changed('settlement.updated', ENTITY, id, before, headerOf(after));
    return this.get(id);
  }

  async addLines(
    id: string,
    body: SettlementItemsInput,
    expected: number | undefined,
  ): Promise<SettlementDto> {
    const tx = this.db.tx;
    const s = await this.lockDraft(tx, id, expected);
    if (!body.tripIds?.length && !body.tripCostIds?.length && !body.deductions?.length)
      throw invalid([{ field: 'tripIds', code: 'required', message: 'nothing to add' }]);
    const picks =
      body.tripIds?.length || body.tripCostIds?.length
        ? await this.pickCosts(tx, s.carrierId, body)
        : [];
    const deductions = await this.checkDeductions(tx, s.carrierId, body);
    const last = await tx.settlementLine.aggregate({
      where: { settlementId: id },
      _max: { lineNo: true },
    });
    const added = await this.insertLines(tx, id, last._max.lineNo ?? 0, picks, deductions);
    await this.recompute(tx, id, true);
    const out = await this.get(id);
    await this.audit.record({
      action: 'settlement.lines_added',
      entityType: ENTITY,
      entityId: id,
      after: {
        lines: added,
        buyGrossAmount: out.buyGrossAmount,
        buyDeductionAmount: out.buyDeductionAmount,
        buyNetPayable: out.buyNetPayable,
      },
    });
    return out;
  }

  async removeLine(
    id: string,
    lineId: string,
    reason: string,
    expected: number | undefined,
  ): Promise<SettlementDto> {
    const tx = this.db.tx;
    await this.lockDraft(tx, id, expected);
    const line = await tx.settlementLine.findFirst({ where: { id: lineId, settlementId: id } });
    if (!line) throw new ProblemException('not_found');
    if (line.voidedAt)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        lineStatus: 'VOIDED',
      });
    const actor = requestContext.require().actorId ?? 'system';
    await this.voidLines(tx, [line.id], actor, reason);
    await this.recompute(tx, id, true);
    const out = await this.get(id);
    await this.audit.record({
      action: 'settlement.line_removed',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: {
        line: {
          id: encodeId('settlementLine', line.id),
          lineNo: line.lineNo,
          lineType: line.lineType,
          tripCostId: line.tripCostId ? encodeId('tripCost', line.tripCostId) : null,
          deductionType: line.deductionType,
          buyAmount: line.amount.toFixed(2),
        },
      },
      after: { buyNetPayable: out.buyNetPayable },
    });
    return out;
  }

  async cancel(id: string, reason: string, expected: number | undefined): Promise<SettlementDto> {
    const tx = this.db.tx;
    await this.lockDraft(tx, id, expected);
    const actor = requestContext.require().actorId ?? 'system';
    const active = await tx.settlementLine.findMany({
      where: { settlementId: id, voidedAt: null },
      select: { id: true, tripCostId: true },
    });
    await this.voidLines(
      tx,
      active.map((l) => l.id),
      actor,
      reason,
    );
    // ยอดของใบที่ยกเลิก = ยอด ณ เวลายกเลิก (ไม่คิดใหม่ — เก็บเป็นประวัติ)
    await tx.carrierSettlement.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: actor,
        cancelReason: reason,
        version: { increment: 1 },
      },
    });
    await this.audit.record({
      action: 'settlement.cancelled',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { status: 'DRAFT' },
      after: {
        status: 'CANCELLED',
        releasedTripCostIds: active
          .filter((l) => l.tripCostId)
          .map((l) => encodeId('tripCost', l.tripCostId!)),
      },
    });
    return this.get(id);
  }

  /**
   * อนุมัติ (ST6-T07; docs/04 F6 "Approve (separation of duties)", docs/01 §4.5 DRAFT → APPROVED, spec/05 §11.5–11.6)
   * - ผู้ใช้ที่ login เท่านั้น · ผู้เตรียมใบ (ผู้สร้าง/ผู้เพิ่ม/ผู้นำบรรทัดออก; key = ผู้ออก key; ระบุไม่ได้ = ปฏิเสธ) อนุมัติไม่ได้ → 403 `settlement_self_approval` (trigger 0126 ใน DB ด้วย)
   * - ยอดสุทธิ > วงเงิน (0 = ทุกใบ) `settlement.approvalStepUpAmount` → ต้องยืนยัน 2FA ซ้ำ (`X-Step-Up` ของผู้อนุมัติเอง) ไม่งั้น 403 `step_up_required`
   * - ไม่มีบรรทัดค่าขนส่ง (FREIGHT) → 409 `settlement_empty` · ยอดสุทธิติดลบ → 409 `settlement_net_negative` (BIL-133 — ยกยอดหักส่วนเกินไปงวดถัดไป)
   * - ออกเลข STL (`issueNumber` — แถวตัวนับล็อกจน commit, rollback = ไม่กินเลข) ใน transaction เดียวกับการเปลี่ยนสถานะ · ใบ APPROVED แก้ไม่ได้ (trigger 0124)
   * - เหตุผล ≥ 10 ตัวอักษร + audit `settlement.approved` + webhook `settlement.approved`
   * - ไม่คำนวณ VAT/WHT (ST6-T08) — ยอดสุทธิ = ยอดรวม − รายการหัก
   */
  async approve(
    id: string,
    reason: string,
    expected: number | undefined,
    steppedUp: boolean,
  ): Promise<SettlementDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    // docs/01 §4.5: SENT_TO_CARRIER → APPROVED · DRAFT → APPROVED เฉพาะบริษัทที่ไม่บังคับให้รถร่วมตรวจ (ST6-T05) ·
    // DISPUTED → 409 `settlement_disputed` (ไม่ใช่ invalid_state_transition — ST6-T06 เกณฑ์ตรวจรับ)
    const s = await this.lockFor(tx, id, expected, ['DRAFT', 'SENT_TO_CARRIER', 'DISPUTED']);
    // อนุมัติต้องอ้าง version ที่ผู้อนุมัติเห็น (review L5) — ไม่ส่ง If-Match = 422 `if_match_required` (แบบ ST4-T11)
    // ตรวจหลังหาใบเจอ (ใบของบริษัทอื่น/ไม่มี = 404 ก่อน)
    if (expected === undefined)
      throw invalid([
        {
          field: 'If-Match',
          code: 'if_match_required',
          message: 'send If-Match (ETag of the settlement)',
        },
      ]);
    const actor = ctx.actorId;
    // อนุมัติ = คนที่ login เท่านั้น (review H1) — API key / OAuth client ไม่มี scope นี้อยู่แล้ว (API_KEY_DENIED_SCOPES) กันอีกชั้นที่นี่
    if (!actor || !HUMAN_PRINCIPALS.has(ctx.principalType ?? ''))
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'settlements',
        action: 'approve',
        required: ['settlements:approve'],
      });
    if (s.status === 'DRAFT') {
      const required = (
        await readSettings(tx, ctx.tenantId!, ['settlement.carrierReviewRequired'])
      )['settlement.carrierReviewRequired'];
      if (required === true) throw new ProblemException('settlement_review_required');
    }
    await this.assertNotPreparer(tx, id, s.createdBy, s.updatedBy, actor, [
      ...(s.sentBy ? [s.sentBy] : []),
      ...s.preparers,
    ]);
    // ไม่รู้ประเภทรถร่วม → ตรึง WHT/จัดแบบยื่นไม่ได้ → 409 แทน 500 (หลังสิทธิ์/SoD — แถวเขียนฐานตรงเท่านั้น)
    requireWhtEntityType(s.carrierSnapshot);
    await this.assertNoOpenDisputes(tx, s);
    // ต้องมีบรรทัดค่าขนส่ง (FREIGHT) อย่างน้อย 1 — ค่าใช้จ่ายเพิ่ม (SURCHARGE) อย่างเดียวไม่นับเป็นใบ (review L4)
    const trips = await tx.settlementLine.count({
      where: { settlementId: id, voidedAt: null, lineType: 'FREIGHT' },
    });
    if (trips === 0) throw new ProblemException('settlement_empty');
    if (s.netPayable.isNegative()) throw new ProblemException('settlement_net_negative');
    const limit = (await readSettings(tx, ctx.tenantId!, ['settlement.approvalStepUpAmount']))[
      'settlement.approvalStepUpAmount'
    ] as number | null;
    // 0 = ทุกใบ (รวมยอด 0.00) · > 0 = ยอดสุทธิเกินวงเงิน (review L3)
    const needStepUp = limit !== null && (limit === 0 || s.netPayable.greaterThan(limit));
    if (needStepUp && !steppedUp) throw new ProblemException('step_up_required');

    // ST6-T08: ตรึงหัก ณ ที่จ่ายประมาณการ + ขั้นต่ำที่ใช้ ในคำสั่งเดียวกับการอนุมัติ (หัวใบแข็งระหว่างรอตรวจ — trigger 0136 ยกเว้นสองช่องนี้)
    const row = (await this.load(tx, id))!;
    const minimum = await this.liveWhtMinimum(tx);
    const wht = whtOf(row, row.lines, minimum);
    // ตามแนว D-61 (lead — ย้อนได้): sandbox → TEST-STL-… (issueNumber ตรวจ tenant.mode ในฐานเอง)
    const settlementNo = await issueNumber(tx, ctx.tenantId!, {
      docType: 'STL',
      markSandbox: true,
    });
    await tx.carrierSettlement.update({
      where: { id },
      data: {
        status: 'APPROVED',
        settlementNo,
        approvedAt: new Date(),
        approvedBy: actor,
        whtAmount: decimalFromSatang(wht.wht),
        whtMinimumAmount: minimum,
        // ใบที่สร้างก่อน ST6-T08: ตรึงค่าตั้งต้นของรถร่วมที่ใช้คำนวณ → ทุกตัวเลข (แยกอัตรา/รายบรรทัด) ทำซ้ำได้
        whtRateDefault: row.whtRateDefault ?? row.carrier.whtRateDefault,
        // ST6-T04 (review L1): ผู้จ่ายบนใบสำคัญจ่าย ตรึง ณ วันอนุมัติ (PDF ไม่อ่านชื่อบริษัทปัจจุบัน)
        payerSnapshot: (await resolvePayer(
          tx,
          row.payingCompanyId,
        )) as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    const out = await this.get(id);
    await this.audit.record({
      action: 'settlement.approved',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { status: s.status, settlementNo: null },
      after: {
        status: 'APPROVED',
        settlementNo,
        stepUp: needStepUp,
        buyNetPayable: out.buyNetPayable,
        buyWhtAmount: out.buyWhtAmount,
        // requireWhtEntityType ข้างบน → มีผลประมาณการเสมอ
        whtMinimumAmount: out.whtEstimate!.minimumAmount,
        whtForm: out.whtEstimate!.form,
      },
    });
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type: 'settlement.approved',
        entityType: ENTITY,
        localId: id,
        snapshot: settlementEventObject(out) as Prisma.InputJsonValue,
        previousAttributes: { status: s.status, settlementNo: null },
        requestId: ctx.requestId ?? null,
        actorId: actor,
      },
    });
    return out;
  }

  /**
   * บันทึกจ่าย (ST6-T09; docs/04 F6 "จ่าย" — วันโอน/เลขอ้างอิง/ธนาคาร, docs/01 §4.5 APPROVED → PAID, D-58 บัญชีเบา)
   * - เฉพาะใบ APPROVED (อื่น ๆ รวม PAID แล้ว → 409 `invalid_state_transition`) · If-Match บังคับ · สิทธิ์ `settlements:pay` (A3: owner/admin/accounting)
   * - จ่ายเต็มยอดครั้งเดียว (ยอดที่จ่าย = ยอดสุทธิ − หัก ณ ที่จ่ายที่ตรึงตอนอนุมัติ) — ไม่มีแบ่งจ่าย (docs/01 §4.5 ไม่มี PARTIALLY_PAID)
   * - หัก ณ ที่จ่ายที่ตรึง (`wht_amount` / `wht_minimum_amount` / `wht_rate_default`) คงเดิม (trigger 0139) · ใบที่อนุมัติก่อน ST6-T08 → ตรึงตอนนี้
   * - เที่ยวในใบ: COSTED → SETTLED เมื่อบรรทัดต้นทุนที่จ่ายรถร่วมได้ทุกบรรทัดอยู่ในใบที่จ่ายแล้ว (docs/01 §4.2) → ไม่กลับเข้าคิวจ่าย
   * - audit `settlement.paid` + webhook `settlement.paid` (ST8-T16 ส่ง AP ร่างจาก event นี้ — D-58; 50 ทวิ ออกที่ระบบบัญชี)
   */
  async markPaid(
    id: string,
    body: SettlementPayDto,
    expected: number | undefined,
  ): Promise<SettlementDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const reference = body.reference?.trim() || null;
    const bank = body.bank?.trim() || null;
    const bad: FieldError[] = [];
    if (!isRealDay(body.paidDate))
      bad.push({
        field: 'paidDate',
        code: 'invalid_date',
        message: 'must be a real date (YYYY-MM-DD)',
      });
    else if (body.paidDate > bangkokDay(new Date().toISOString()))
      bad.push({
        field: 'paidDate',
        code: 'future_date',
        message: 'paidDate cannot be in the future',
      });
    if (body.method !== 'CASH' && !reference)
      bad.push({
        field: 'reference',
        code: 'required',
        message:
          'reference (transfer reference / cheque number) is required for TRANSFER and CHEQUE',
      });
    // สถานะก่อน version (review QA): ใบที่จ่ายแล้ว/ไม่ใช่ APPROVED → 409 เสมอ (คำขอซ้ำพร้อมกัน — ผู้แพ้ได้ 409 ไม่ใช่ 412)
    const s = await this.lockFor(tx, id, undefined, ['APPROVED']);
    requireIfMatch(expected);
    if (expected !== s.version) throw new ProblemException('precondition_failed');
    // D-60 (PO 21 พ.ย. 2569) แบ่งหน้าที่: ผู้บันทึกจ่ายต้องไม่ใช่ผู้อนุมัติใบนี้ (key = ผู้ออก key; ระบุตัวไม่ได้ = ปฏิเสธ)
    // owner ปิดกฎได้ด้วย `settlement.allowApproverMarkPaid` (audit `sodWaived`)
    const sodWaived = await this.assertNotApprover(tx, s.approvedBy, ctx.actorId);
    // วันที่จ่าย = วันที่หักภาษี (spec/05 §11.7 — วันที่บน 50 ทวิ / เดือนยื่น ภ.ง.ด. ที่ ST8-T16 ส่ง) — ต้องไม่ก่อนวันอนุมัติ (เวลาไทย)
    const approvedDay = s.approvedAt ? bangkokDay(s.approvedAt.toISOString()) : null;
    if (!bad.some((e) => e.field === 'paidDate') && approvedDay && body.paidDate < approvedDay)
      bad.push({
        field: 'paidDate',
        code: 'before_approval',
        message: `paidDate must be on or after the approval date (${approvedDay})`,
      });
    if (bad.length) throw invalid(bad);
    const actor = ctx.actorId ?? 'system';
    // ใบที่อนุมัติก่อน ST6-T08 (ยังไม่ตรึง WHT) → ตรึงในคำสั่งเดียวกับการบันทึกจ่าย (trigger 0139 ยอมครั้งเดียว)
    let freeze: Prisma.CarrierSettlementUpdateInput = {};
    if (s.whtAmount === null) {
      const row = (await this.load(tx, id))!;
      requireWhtEntityType(row.carrierSnapshot);
      const minimum = await this.liveWhtMinimum(tx);
      freeze = {
        whtAmount: decimalFromSatang(whtOf(row, row.lines, minimum).wht),
        whtMinimumAmount: minimum,
        whtRateDefault: row.whtRateDefault ?? row.carrier.whtRateDefault,
      };
    }
    await tx.carrierSettlement.update({
      where: { id },
      data: {
        status: 'PAID',
        paidDate: day(body.paidDate),
        paidAt: new Date(),
        paidBy: actor,
        paymentMethod: body.method,
        paymentReference: reference,
        paymentBank: bank,
        ...freeze,
        version: { increment: 1 },
      },
    });
    const settledTrips = await this.settleTrips(tx, id);
    const out = await this.get(id);
    // ยอดใน audit จากแถวจริง (ไม่ผ่านการตัดราคาตามสิทธิ์ผู้เรียก — review QA L3)
    const paidRow = await tx.carrierSettlement.findUniqueOrThrow({
      where: { id },
      select: { netPayable: true, whtAmount: true },
    });
    await this.audit.record({
      action: 'settlement.paid',
      entityType: ENTITY,
      entityId: id,
      before: { status: s.status },
      after: {
        status: 'PAID',
        settlementNo: out.settlementNo,
        paidDate: out.paidDate,
        paymentMethod: out.paymentMethod,
        paymentReference: out.paymentReference,
        paymentBank: out.paymentBank,
        buyNetPayable: paidRow.netPayable.toFixed(2),
        buyWhtAmount: paidRow.whtAmount!.toFixed(2),
        buyNetAfterWht: paidRow.netPayable.minus(paidRow.whtAmount!).toFixed(2),
        whtFrozenNow: s.whtAmount === null,
        ...(sodWaived ? { sodWaived: true } : {}),
        settledTripIds: settledTrips.map((t) => encodeId('trip', t)),
      },
    });
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type: 'settlement.paid',
        entityType: ENTITY,
        localId: id,
        snapshot: settlementEventObject(out) as Prisma.InputJsonValue,
        previousAttributes: {
          status: s.status,
          paidDate: null,
          paidAt: null,
          paymentMethod: null,
          paymentReference: null,
          paymentBank: null,
        },
        requestId: ctx.requestId ?? null,
        actorId: actor,
      },
    });
    // ST8-T16 (D-58) connector ที่เปิด pushSettlement → ส่งเป็นเจ้าหนี้ร่าง + WHT ประมาณการ (outbox — หลัง commit)
    await this.erpSync.settlementPaid(tx, out);
    return out;
  }

  /**
   * เที่ยวของใบที่เพิ่งจ่าย: COSTED → SETTLED (docs/01 §4.2 "(รถร่วม) cost line ถูกจ่ายใน settlement") เมื่อ
   * (ก) ไม่มีบรรทัดต้นทุนรอจ่าย (กฎเดียวกับคิวจ่าย — `payableLines`) และ (ข) บรรทัดเที่ยวที่ยังใช้ทุกใบของเที่ยวนั้นอยู่ในใบ PAID แล้ว
   * — เที่ยวที่ยังมีบรรทัดรอจ่าย/อยู่ในใบอื่นที่ยังไม่จ่าย คง COSTED (เปลี่ยนเป็น SETTLED เมื่อจ่ายใบสุดท้าย) · ล็อกเที่ยวเรียงตาม id
   */
  private async settleTrips(tx: Tx, id: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM trip t
       WHERE t.id IN (SELECT l.trip_id FROM settlement_line l
                       WHERE l.settlement_id = ${id}::uuid AND l.voided_at IS NULL
                         AND l.line_type <> 'DEDUCTION' AND l.trip_id IS NOT NULL)
       ORDER BY t.id
         FOR UPDATE OF t`;
    const ids = rows.map((r) => r.id);
    if (!ids.length) return [];
    const done = await tx.$queryRaw<{ id: string }[]>`
      WITH tp AS NOT MATERIALIZED (SELECT t.id, t.carrier_id FROM trip t WHERE t.id = ANY(${ids}::uuid[]))
      SELECT t.id FROM trip t
       WHERE t.id = ANY(${ids}::uuid[]) AND t.status = 'COSTED'
         AND NOT EXISTS (SELECT 1 FROM (${payableLines(Prisma.sql`tp`)}) x WHERE x.trip_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM settlement_line l JOIN carrier_settlement s ON s.id = l.settlement_id
                          WHERE l.trip_id = t.id AND l.voided_at IS NULL AND l.line_type <> 'DEDUCTION'
                            AND s.status <> 'PAID')
       ORDER BY t.id`;
    for (const t of done) await this.trips.settle(tx, t.id);
    return done.map((t) => t.id);
  }

  /**
   * separation of duties (A3; review H1/M2): ผู้อนุมัติต้องไม่ใช่ผู้เตรียมใบ — ผู้สร้างหัวใบ + ผู้แก้หัวใบล่าสุด + ผู้เพิ่มบรรทัด + ผู้นำบรรทัดออก
   * actor ที่เป็น API key (`apikey:<id>`) = ผู้ออก key · ผู้เตรียมที่ระบุตัวไม่ได้ (ว่าง/key หาไม่พบ/ไม่มีผู้ออก) = ปฏิเสธ (fail closed)
   */
  private async assertNotPreparer(
    tx: Tx,
    id: string,
    createdBy: string | null,
    updatedBy: string | null,
    actor: string,
    reviewPreparers: string[] = [],
  ): Promise<void> {
    const lines = await tx.settlementLine.findMany({
      where: { settlementId: id },
      select: { createdBy: true, voidedAt: true, voidedBy: true },
    });
    const raw = [
      createdBy,
      // ผู้แก้หัวใบล่าสุด (ไม่เคยแก้ = ไม่นับ)
      ...(updatedBy ? [updatedBy] : []),
      // ขั้นรถร่วมตรวจ (ST6-T05): ผู้ส่งทุกรอบ + ผู้เรียกกลับ + ผู้ออกลิงก์ใหม่ = ผู้เตรียมใบ ·
      // รถร่วม (`link:`) ไม่ได้สร้าง/แก้บรรทัด จึงไม่อยู่ในรายการนี้
      ...reviewPreparers,
      ...lines.map((l) => l.createdBy),
      ...lines.filter((l) => l.voidedAt).map((l) => l.voidedBy),
    ];
    const [me, ...preparers] = await resolveActors(tx, [actor, ...raw]);
    if (me === null || preparers.some((p) => p === null || p === me))
      throw new ProblemException('settlement_self_approval');
  }

  /**
   * D-60 separation of duties ของการจ่าย: ผู้บันทึกจ่ายต้องไม่ใช่ผู้อนุมัติ (`approvedBy`) — API key = ผู้ออก key ·
   * ผู้บันทึกที่ระบุตัวไม่ได้ = ปฏิเสธเสมอ (fail closed — ปิดกฎก็ไม่ผ่าน) · tenant ที่ owner ปิดกฎ (`settlement.allowApproverMarkPaid`) → ผู้อนุมัติผ่าน
   * @returns true = เป็นผู้อนุมัติแต่ผ่านเพราะปิดกฎ (ลง audit)
   */
  private async assertNotApprover(
    tx: Tx,
    approvedBy: string | null,
    actor: string | null | undefined,
  ): Promise<boolean> {
    const [me, approver] = await resolveActors(tx, [actor, approvedBy]);
    // ผู้บันทึกจ่ายที่ระบุตัวไม่ได้ (key หาไม่พบ/ไม่มีผู้ออก) = ปฏิเสธเสมอ แม้ปิดกฎ (fail closed — review D-60)
    if (me === null) throw new ProblemException('settlement_self_payment');
    if (approver === null || approver !== me) return false;
    const allowed = (
      await readSettings(tx, requestContext.require().tenantId!, [
        'settlement.allowApproverMarkPaid',
      ])
    )['settlement.allowApproverMarkPaid'];
    if (allowed === true) return true;
    throw new ProblemException('settlement_self_payment');
  }

  /**
   * dispute บล็อกการอนุมัติ (docs/01 §4.5 "disputed_count = 0", spec/05 BIL-136) — รายการโต้แย้งค้างในรอบตรวจล่าสุด
   * (รถร่วมโต้แย้ง/บัญชีติด dispute ที่ยังไม่เคลียร์ — `tms_settlement_disputed_count` เดียวกับ trigger 0130) → 409 `settlement_disputed`
   * (+ `disputedCount`) — ทั้งใบ DISPUTED และร่างที่เรียกกลับ (review M1 ของ T05) · ทางเคลียร์ = ยืนยันยอดเดิมพร้อมเหตุผล (`/resolve`),
   * รถร่วมเปลี่ยนเป็นยอมรับ, นำบรรทัดออก (ร่าง) หรือส่งตรวจรอบใหม่
   */
  private async assertNoOpenDisputes(
    tx: Tx,
    s: { id: string; status: string; reviewRound: number },
  ): Promise<void> {
    const n = await disputedCount(tx, s.id, s.reviewRound);
    if (n > 0 || s.status === 'DISPUTED')
      throw new ProblemException('settlement_disputed', undefined, undefined, {
        disputedCount: n,
      });
  }

  // ---------- รถร่วมตรวจ (ST6-T05) ----------

  /**
   * ส่งให้รถร่วมตรวจ (docs/01 §4.5 DRAFT → SENT_TO_CARRIER) — ต้องมีบรรทัดค่าขนส่งและยอดสุทธิไม่ติดลบ
   * อนุมัติได้เมื่อไม่มีบรรทัดที่รถร่วมโต้แย้ง (บรรทัดที่ยังไม่ตอบไม่บล็อก — [OPEN PO] spec/12 §3) · ค่าตั้ง `carrierReviewRequired`
   * บังคับแค่ว่าต้องส่งตรวจก่อนอนุมัติ · รอบตรวจ +1 · ผู้ส่ง = ผู้เตรียมใบ (SoD) · ออกลิงก์ 7 วัน (เพิกถอนลิงก์เดิม) — URL แสดงในคำตอบนี้ครั้งเดียว · หัวใบ/บรรทัดแข็งจนเรียกกลับ
   */
  async send(id: string, expected: number | undefined): Promise<SettlementSentDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const s = await this.lockDraft(tx, id, expected);
    requireIfMatch(expected);
    const trips = await tx.settlementLine.count({
      where: { settlementId: id, voidedAt: null, lineType: 'FREIGHT' },
    });
    if (trips === 0) throw new ProblemException('settlement_empty');
    if (s.netPayable.isNegative()) throw new ProblemException('settlement_net_negative');
    const actor = ctx.actorId ?? 'system';
    await tx.carrierSettlement.update({
      where: { id },
      data: {
        status: 'SENT_TO_CARRIER',
        sentAt: new Date(),
        sentBy: actor,
        preparers: { push: actor },
        reviewRound: { increment: 1 },
        version: { increment: 1 },
      },
    });
    const link = await this.review.issueLink(tx, id);
    const out = await this.get(id);
    await this.audit.record({
      action: 'settlement.sent',
      entityType: ENTITY,
      entityId: id,
      before: { status: 'DRAFT' },
      after: {
        status: 'SENT_TO_CARRIER',
        round: out.carrierReview.round,
        linkId: link.id,
        linkExpiresAt: link.expiresAt,
        buyNetPayable: out.buyNetPayable,
      },
    });
    return { settlement: out, link };
  }

  /**
   * ออกลิงก์ตรวจใหม่ (ลิงก์หมดอายุ/หาย — spec/05 §11.9) · เพิกถอนลิงก์เดิม · คำตอบที่มีแล้วของรอบนี้คงอยู่
   * - SENT_TO_CARRIER / DISPUTED: ลิงก์ตรวจ (ดู + ตอบ) · ผู้ออกลิงก์ใหม่ = ผู้เตรียมใบ (review L3)
   * - APPROVED / PAID (D-59 — PO 21 พ.ย. 2569): ลิงก์**ดูอย่างเดียว** ให้รถร่วมดูสถานะ/ใบจ่ายเงินหลังลิงก์เดิมหมดอายุ ·
   *   **ไม่เพิ่มผู้เตรียม** (อนุมัติไปแล้ว — ไม่แตะ SoD ย้อนหลัง และหัวใบไม่เปลี่ยน/version คงเดิม)
   * - DRAFT / CANCELLED → 409
   */
  async reissueLink(id: string): Promise<SettlementReviewLinkDto> {
    const tx = this.db.tx;
    const [r] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM carrier_settlement WHERE id = ${id}::uuid FOR UPDATE`;
    if (!r) throw new ProblemException('not_found');
    const s = await tx.carrierSettlement.findUniqueOrThrow({ where: { id } });
    // ST6-T06: ใบ DISPUTED ยังรอรถร่วมตรวจ — ออกลิงก์ใหม่ได้ · D-59: APPROVED/PAID = ลิงก์ดูอย่างเดียว
    const underReview = s.status === 'SENT_TO_CARRIER' || s.status === 'DISPUTED';
    const viewOnly = s.status === 'APPROVED' || s.status === 'PAID';
    if (!underReview && !viewOnly)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        status: s.status,
      });
    // ผู้ออกลิงก์ใหม่ระหว่างรอตรวจ = ผู้เตรียมใบ (review L3)
    if (underReview)
      await tx.carrierSettlement.update({
        where: { id },
        data: { preparers: { push: requestContext.require().actorId ?? 'system' } },
      });
    const link = await this.review.issueLink(tx, id, { viewOnly });
    await this.audit.record({
      action: 'settlement.review_link_reissued',
      entityType: ENTITY,
      entityId: id,
      after: {
        status: s.status,
        round: s.reviewRound,
        viewOnly,
        linkId: link.id,
        linkExpiresAt: link.expiresAt,
      },
    });
    return link;
  }

  /**
   * เรียกกลับมาแก้ (SENT_TO_CARRIER → DRAFT — เหตุผลบังคับ) เช่น รถร่วมโต้แย้ง/พบรายการผิด · เพิกถอนลิงก์ ·
   * คำตอบของรอบนี้เก็บเป็นประวัติ (ส่งใหม่ = รอบใหม่ เริ่มนับใหม่)
   */
  async recall(id: string, reason: string, expected: number | undefined): Promise<SettlementDto> {
    const tx = this.db.tx;
    // SENT_TO_CARRIER → DRAFT (ST6-T05) · DISPUTED → DRAFT "แก้รายการ" (docs/01 §4.5 — ST6-T06)
    const s = await this.lockFor(tx, id, expected, ['SENT_TO_CARRIER', 'DISPUTED']);
    requireIfMatch(expected);
    await tx.carrierSettlement.update({
      where: { id },
      // ผู้เรียกกลับ = ผู้เตรียมใบ (review M1/L3)
      data: {
        status: 'DRAFT',
        preparers: { push: requestContext.require().actorId ?? 'system' },
        version: { increment: 1 },
      },
    });
    const revoked = await this.review.revokeActive(tx, id, REVIEW_REVOKE_REASON.RECALLED);
    const out = await this.get(id);
    await this.audit.record({
      action: 'settlement.recalled',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { status: s.status, round: s.reviewRound },
      after: {
        status: 'DRAFT',
        revokedLinks: revoked,
        accepted: out.carrierReview.accepted,
        disputed: out.carrierReview.disputed,
      },
    });
    return out;
  }

  // ---------- Dispute (ST6-T06) ----------

  /**
   * บริษัท (บัญชี) ติด dispute รายการเอง (docs/01 §4.5 "รถร่วม/บัญชีติด dispute รายการ") — ใบ SENT_TO_CARRIER/DISPUTED · เหตุผล ≥ 10 ·
   * If-Match บังคับ · บรรทัดที่โต้แย้งค้างอยู่แล้ว → 409 · หัวใบ → DISPUTED · ไม่แสดงให้รถร่วม · audit `settlement.line_flagged`
   * ผู้ติด dispute ไม่นับเป็นผู้เตรียมใบ (ไม่ได้เตรียมยอด — แค่ทำให้อนุมัติยากขึ้น)
   */
  async disputeLine(
    id: string,
    lineRef: string,
    reason: string,
    expected: number | undefined,
  ): Promise<SettlementDto> {
    const tx = this.db.tx;
    const s = await this.lockFor(tx, id, expected, ['SENT_TO_CARRIER', 'DISPUTED']);
    requireIfMatch(expected);
    const actor = this.person();
    const line = await this.activeLine(tx, id, lineRef);
    if ((await disputedLines(tx, id, s.reviewRound)).has(line.id))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        lineStatus: 'DISPUTED',
      });
    await tx.settlementLineDispute.create({
      data: {
        tenantId: s.tenantId,
        settlementId: id,
        lineId: line.id,
        round: s.reviewRound,
        action: 'DISPUTED',
        reason,
        createdBy: actor,
      },
    });
    await tx.carrierSettlement.update({ where: { id }, data: { version: { increment: 1 } } });
    await this.review.syncDisputeStatus(tx, id);
    const out = await this.get(id);
    await this.audit.record({
      action: 'settlement.line_flagged',
      entityType: ENTITY,
      entityId: id,
      reason,
      after: {
        lineId: encodeId('settlementLine', line.id),
        round: s.reviewRound,
        lineStatus: 'DISPUTED',
        status: out.status,
        disputedCount: out.dispute.disputed,
      },
    });
    return out;
  }

  /**
   * เคลียร์ dispute = ยืนยันยอดเดิมพร้อมเหตุผล (spec/05 BIL-136 "RESOLVED — ยืนยันยอดเดิมพร้อมเหตุผล") — ใบ DISPUTED / ร่างที่เรียกกลับ /
   * SENT_TO_CARRIER ที่มีโต้แย้งค้าง (ข้อมูลก่อน T06) · บรรทัดต้องโต้แย้งค้าง (ไม่งั้น 409) · ปิดทุก dispute ก่อนหน้าของบรรทัดในรอบนี้ (รถร่วม + บัญชี) —
   * ถ้าปิดข้อโต้แย้งของรถร่วม: รถร่วมตอบบรรทัดนี้ในรอบนี้ไม่ได้อีก + เห็นเหตุผล · ถ้าปิดแค่ธงภายใน: รถร่วมยังตอบได้ ไม่เห็นเหตุผล ·
   * **ผู้เคลียร์ = ผู้เตรียมใบ (อนุมัติใบนี้ไม่ได้ — SoD)** · เคลียร์ครบ → DISPUTED กลับเป็น SENT_TO_CARRIER · audit `settlement.line_resolved`
   * แก้ยอด = เรียกกลับ (DISPUTED → DRAFT) แล้วนำบรรทัดออก/เพิ่มใหม่ (ยอดบรรทัดมาจากต้นทุนของเที่ยว — แก้ในใบไม่ได้)
   */
  async resolveLine(
    id: string,
    lineRef: string,
    reason: string,
    expected: number | undefined,
  ): Promise<SettlementDto> {
    const tx = this.db.tx;
    // + SENT_TO_CARRIER ที่ยังมีโต้แย้งค้าง (ใบก่อน T06 ที่ยังไม่ถูกปรับเป็น DISPUTED — review L3; บรรทัดต้องโต้แย้งค้างอยู่ดี)
    const s = await this.lockFor(tx, id, expected, ['DISPUTED', 'DRAFT', 'SENT_TO_CARRIER']);
    requireIfMatch(expected);
    const actor = this.person();
    const line = await this.activeLine(tx, id, lineRef);
    if (!(await disputedLines(tx, id, s.reviewRound)).has(line.id))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        lineStatus: 'NOT_DISPUTED',
      });
    const before = await this.disputeSnapshot(tx, id, line.id, s.reviewRound);
    await tx.settlementLineDispute.create({
      data: {
        tenantId: s.tenantId,
        settlementId: id,
        lineId: line.id,
        round: s.reviewRound,
        action: 'RESOLVED',
        reason,
        createdBy: actor,
      },
    });
    await tx.carrierSettlement.update({
      where: { id },
      data: { preparers: { push: actor }, version: { increment: 1 } },
    });
    await this.review.syncDisputeStatus(tx, id);
    const out = await this.get(id);
    await this.audit.record({
      action: 'settlement.line_resolved',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { lineId: encodeId('settlementLine', line.id), lineStatus: 'DISPUTED', ...before },
      after: {
        lineStatus: 'APPROVED',
        buyAmount: line.amount.toFixed(2),
        round: s.reviewRound,
        status: out.status,
        disputedCount: out.dispute.disputed,
      },
    });
    return out;
  }

  /** ผู้ทำรายการ dispute ต้องระบุตัวได้ (ไม่ใช่ว่าง) — ลง `created_by` + preparers */
  private person(): string {
    const actor = requestContext.require().actorId;
    if (!actor)
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'settlements',
        action: 'dispute',
      });
    return actor;
  }

  /** บรรทัดที่ยังใช้ของใบ — ไม่ใช่ของใบนี้ = 404 · นำออกแล้ว = 409 */
  private async activeLine(tx: Tx, settlementId: string, lineId: string) {
    const line = await tx.settlementLine.findFirst({ where: { id: lineId, settlementId } });
    if (!line) throw new ProblemException('not_found');
    if (line.voidedAt)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        lineStatus: 'VOIDED',
      });
    return line;
  }

  /** dispute ที่กำลังเคลียร์ (คำตอบล่าสุดของรถร่วม + การติด dispute ล่าสุดของบัญชี) — ลง audit */
  private async disputeSnapshot(tx: Tx, settlementId: string, lineId: string, round: number) {
    const [rv, fl] = await Promise.all([
      tx.settlementLineReview.findFirst({
        where: { settlementId, lineId, round },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      tx.settlementLineDispute.findFirst({
        where: { settlementId, lineId, round, action: 'DISPUTED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    return {
      carrier: rv
        ? {
            response: rv.response,
            reason: rv.reason,
            buyClaimedAmount: rv.claimedAmount?.toFixed(2) ?? null,
            reviewId: rv.id,
          }
        : null,
      company: fl ? { reason: fl.reason, by: fl.createdBy, disputeId: fl.id } : null,
    };
  }

  // ---------- ภายใน ----------

  private load(tx: Tx, id: string): Promise<SettlementRow | null> {
    return tx.carrierSettlement.findUnique({
      where: { id },
      include: {
        carrier: { select: { whtRateDefault: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { tripCost: { select: { costType: true } }, trip: { select: { tripNo: true } } },
        },
        reviews: { orderBy: REVIEW_ORDER },
        disputes: { orderBy: REVIEW_ORDER },
      },
    });
  }

  /** ล็อกใบ (FOR UPDATE) + ตรวจ If-Match + ต้องเป็นร่าง */
  private lockDraft(tx: Tx, id: string, expected: number | undefined) {
    return this.lockFor(tx, id, expected, ['DRAFT']);
  }

  /** ล็อกใบ (FOR UPDATE) + ตรวจ If-Match + สถานะต้องอยู่ใน `allowed` */
  private async lockFor(tx: Tx, id: string, expected: number | undefined, allowed: string[]) {
    const [r] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM carrier_settlement WHERE id = ${id}::uuid FOR UPDATE`;
    if (!r) throw new ProblemException('not_found');
    const s = await tx.carrierSettlement.findUniqueOrThrow({ where: { id } });
    if (expected !== undefined && expected !== s.version)
      throw new ProblemException('precondition_failed');
    if (!allowed.includes(s.status))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        status: s.status,
      });
    return s;
  }

  /** `{id}` / `ext:{externalId}` ของรถร่วม → uuid (ไม่พบ = null) */
  private async carrierRef(tx: Tx, ref: string): Promise<string | null> {
    if (ref.startsWith(EXT_PREFIX)) {
      const ext = ref.slice(EXT_PREFIX.length);
      if (!EXTERNAL_ID_RE.test(ext)) return null;
      const c = await tx.carrier.findFirst({
        where: { externalId: ext, deletedAt: null },
        select: { id: true },
      });
      return c?.id ?? null;
    }
    return tryDecodeId('carrier', ref);
  }

  private checkDates(body: {
    periodFrom?: string;
    periodTo?: string;
    carrierInvoiceDate?: string | null;
  }) {
    const bad: FieldError[] = [];
    for (const f of ['periodFrom', 'periodTo', 'carrierInvoiceDate'] as const) {
      const v = body[f];
      if (v && !isRealDay(v))
        bad.push({ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' });
    }
    if (!bad.length && body.periodFrom && body.periodTo && body.periodFrom > body.periodTo)
      bad.push({
        field: 'periodTo',
        code: 'before_period_from',
        message: 'periodTo must be ≥ periodFrom',
      });
    if (bad.length) throw invalid(bad);
  }

  /**
   * บรรทัดต้นทุนที่จะใส่ใบ: ถอดรหัส → ล็อกบรรทัดต้นทุนทุกบรรทัดของเที่ยวที่เกี่ยว (FOR UPDATE ตามลำดับ id — กันสองคำขอหยิบพร้อมกัน) →
   * อยู่ในใบอื่นแล้ว = 409 `trip_cost_already_settled` · ไม่อยู่ในคิวจ่าย = 409 `trip_cost_not_payable`
   */
  private async pickCosts(
    tx: Tx,
    carrierId: string,
    body: SettlementItemsInput,
  ): Promise<CostPick[]> {
    const bad: FieldError[] = [];
    const tripIds = (body.tripIds ?? []).map((ref, i) => {
      const u = tryDecodeId('trip', ref);
      if (!u)
        bad.push({ field: `tripIds[${i}]`, code: 'invalid_reference', message: 'trip not found' });
      return u;
    });
    const costIds = (body.tripCostIds ?? []).map((ref, i) => {
      const u = tryDecodeId('tripCost', ref);
      if (!u)
        bad.push({
          field: `tripCostIds[${i}]`,
          code: 'invalid_reference',
          message: 'trip cost not found',
        });
      return u;
    });
    if (bad.length) throw invalid(bad);
    const wantTrips = [...new Set(tripIds as string[])];
    const wantCosts = [...new Set(costIds as string[])];
    const trips = await tx.trip.findMany({
      where: { id: { in: wantTrips } },
      select: { id: true },
    });
    const costs = await tx.tripCost.findMany({
      where: { id: { in: wantCosts } },
      select: { id: true, tripId: true },
    });
    (body.tripIds ?? []).forEach((ref, i) => {
      if (!trips.some((t) => t.id === tripIds[i]))
        bad.push({ field: `tripIds[${i}]`, code: 'invalid_reference', message: 'trip not found' });
    });
    (body.tripCostIds ?? []).forEach((ref, i) => {
      if (!costs.some((c) => c.id === costIds[i]))
        bad.push({
          field: `tripCostIds[${i}]`,
          code: 'invalid_reference',
          message: 'trip cost not found',
        });
    });
    if (bad.length) throw invalid(bad);

    const allTrips = [...new Set([...wantTrips, ...costs.map((c) => c.tripId)])].sort();
    // ล็อกบรรทัดต้นทุนของเที่ยวทั้งหมดที่เกี่ยว (ลำดับ id เดียวกันทุกคำขอ — ไม่ deadlock)
    const locked = await tx.$queryRaw<
      {
        id: string;
        trip_id: string;
        carrier_id: string | null;
        settlement_line_id: string | null;
      }[]
    >`
      SELECT id, trip_id, carrier_id, settlement_line_id FROM trip_cost
       WHERE trip_id = ANY(${allTrips}::uuid[]) ORDER BY id FOR UPDATE`;
    const payable = await this.queue.payableCostLines(tx, carrierId, allTrips);
    const payableIds = new Set(payable.map((p) => p.id));

    const settled: string[] = [];
    const notPayable: { tripIds: string[]; tripCostIds: string[] } = {
      tripIds: [],
      tripCostIds: [],
    };
    for (const c of wantCosts) {
      const row = locked.find((l) => l.id === c)!;
      if (row.settlement_line_id) settled.push(c);
      else if (!payableIds.has(c)) notPayable.tripCostIds.push(c);
    }
    for (const t of wantTrips) {
      if (payable.some((p) => p.trip_id === t)) continue;
      // ไม่เหลือบรรทัดรอจ่าย: มีบรรทัดของรถร่วมรายนี้อยู่ในใบแล้ว = จ่ายซ้ำ · อื่น ๆ = ไม่อยู่ในคิว
      const inSettlement = locked.filter(
        (l) => l.trip_id === t && l.carrier_id === carrierId && l.settlement_line_id,
      );
      if (inSettlement.length) settled.push(...inSettlement.map((l) => l.id));
      else notPayable.tripIds.push(t);
    }
    if (settled.length) await this.throwSettled(tx, settled);
    if (notPayable.tripIds.length || notPayable.tripCostIds.length)
      throw new ProblemException('trip_cost_not_payable', undefined, undefined, {
        tripIds: notPayable.tripIds.map((t) => encodeId('trip', t)),
        tripCostIds: notPayable.tripCostIds.map((c) => encodeId('tripCost', c)),
      });

    const pickIds = new Set([
      ...payable.filter((p) => wantTrips.includes(p.trip_id)).map((p) => p.id),
      ...wantCosts,
    ]);
    const rows = await tx.tripCost.findMany({
      where: { id: { in: [...pickIds] } },
      select: {
        id: true,
        tripId: true,
        costType: true,
        amount: true,
        description: true,
        vatType: true,
        whtRate: true,
        createdAt: true,
      },
    });
    const tripNo = new Map(
      (
        await tx.trip.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.tripId))] } },
          select: { id: true, tripNo: true, tripDate: true },
        })
      ).map((t) => [t.id, `${ymd(t.tripDate)}|${t.tripNo ?? ''}|${t.id}`]),
    );
    // เรียงตามเที่ยว (วันที่ → เลขเที่ยว) แล้วตามลำดับบรรทัดต้นทุนของเที่ยว
    return rows.sort(
      (a, b) =>
        tripNo.get(a.tripId)!.localeCompare(tripNo.get(b.tripId)!) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  }

  /** 409 จ่ายซ้ำ — บอกใบที่มีบรรทัดนั้นอยู่ (ไม่ใส่ยอดเงินใน extra — กฎ price-fields ข้อ 5) */
  private async throwSettled(tx: Tx, costIds: string[]): Promise<never> {
    const lines = await tx.settlementLine.findMany({
      where: { tripCostId: { in: costIds }, voidedAt: null },
      select: { settlementId: true },
    });
    throw new ProblemException('trip_cost_already_settled', undefined, undefined, {
      tripCostIds: [...new Set(costIds)].map((c) => encodeId('tripCost', c)),
      settlementIds: [...new Set(lines.map((l) => l.settlementId))].map((s) =>
        encodeId('settlement', s),
      ),
    });
  }

  private async checkDeductions(tx: Tx, carrierId: string, body: SettlementItemsInput) {
    const ds = body.deductions ?? [];
    const bad: FieldError[] = [];
    const out: { d: (typeof ds)[number]; tripId: string | null }[] = [];
    for (const [i, d] of ds.entries()) {
      if (!d.tripId) {
        out.push({ d, tripId: null });
        continue;
      }
      const u = tryDecodeId('trip', d.tripId);
      const t = u
        ? await tx.trip.findUnique({ where: { id: u }, select: { id: true, carrierId: true } })
        : null;
      if (!t)
        bad.push({
          field: `deductions[${i}].tripId`,
          code: 'invalid_reference',
          message: 'trip not found',
        });
      else if (t.carrierId !== carrierId)
        bad.push({
          field: `deductions[${i}].tripId`,
          code: 'carrier_mismatch',
          message: 'trip is not hired from this carrier',
        });
      else out.push({ d, tripId: t.id });
    }
    if (bad.length) throw invalid(bad);
    return out;
  }

  /** งวดเริ่มต้น = ช่วงวันที่เที่ยวจบ (เวลาไทย) ของเที่ยวในใบ — ส่งมาเองใช้ค่าที่ส่ง */
  private async defaultPeriod(tx: Tx, picks: CostPick[], from?: string, to?: string) {
    if (from && to) return { from, to };
    const ids = [...new Set(picks.map((p) => p.tripId))];
    const [r] = await tx.$queryRaw<{ lo: Date; hi: Date }[]>`
      SELECT min(coalesce((completed_at AT TIME ZONE 'Asia/Bangkok')::date, trip_date)) AS lo,
             max(coalesce((completed_at AT TIME ZONE 'Asia/Bangkok')::date, trip_date)) AS hi
        FROM trip WHERE id = ANY(${ids}::uuid[])`;
    const p = { from: from ?? ymd(r!.lo), to: to ?? ymd(r!.hi) };
    if (p.from > p.to)
      throw invalid([
        {
          field: from ? 'periodFrom' : 'periodTo',
          code: 'before_period_from',
          message: 'periodTo must be ≥ periodFrom',
        },
      ]);
    return p;
  }

  /** สร้างบรรทัด + ผูก trip_cost (เงื่อนไข `settlement_line_id IS NULL`) — ชน partial unique index = 409 จ่ายซ้ำ */
  private async insertLines(
    tx: Tx,
    settlementId: string,
    lastNo: number,
    picks: CostPick[],
    deductions: {
      d: NonNullable<SettlementItemsInput['deductions']>[number];
      tripId: string | null;
    }[],
  ) {
    const ctx = requestContext.require();
    let no = lastNo;
    const added: Record<string, unknown>[] = [];
    for (const p of picks) {
      let lineId: string;
      try {
        lineId = (
          await tx.settlementLine.create({
            data: {
              tenantId: ctx.tenantId!,
              settlementId,
              lineNo: ++no,
              lineType: p.costType === 'CARRIER_FEE' ? 'FREIGHT' : 'SURCHARGE',
              tripCostId: p.id,
              tripId: p.tripId,
              description: p.description?.trim() || p.costType,
              amount: p.amount,
              vatType: p.vatType,
              whtRate: p.whtRate,
              createdBy: ctx.actorId ?? null,
            },
            select: { id: true },
          })
        ).id;
      } catch (e) {
        if (isUniqueViolation(e)) await this.throwSettledAfterRace(p.id);
        throw e;
      }
      const n = await tx.$executeRaw`
        UPDATE trip_cost SET settlement_line_id = ${lineId}::uuid, version = version + 1, updated_at = now()
         WHERE id = ${p.id}::uuid AND settlement_line_id IS NULL`;
      if (n !== 1) await this.throwSettled(tx, [p.id]);
      added.push({
        id: encodeId('settlementLine', lineId),
        tripCostId: encodeId('tripCost', p.id),
        buyAmount: p.amount.toFixed(2),
      });
    }
    for (const { d, tripId } of deductions) {
      const l = await tx.settlementLine.create({
        data: {
          tenantId: ctx.tenantId!,
          settlementId,
          lineNo: ++no,
          lineType: 'DEDUCTION',
          tripId,
          deductionType: d.deductionType,
          description: d.description.trim(),
          amount: new Prisma.Decimal(d.amount),
          reference: d.reference.trim(),
          createdBy: ctx.actorId ?? null,
        },
        select: { id: true },
      });
      added.push({
        id: encodeId('settlementLine', l.id),
        deductionType: d.deductionType,
        reference: d.reference.trim(),
        buyAmount: new Prisma.Decimal(d.amount).toFixed(2),
      });
    }
    return added;
  }

  /** ชน unique index ระหว่างทาง (transaction ถูกยกเลิกแล้ว — อ่านต่อไม่ได้) → 409 โดยไม่บอกเลขใบ */
  private throwSettledAfterRace(costId: string): never {
    throw new ProblemException('trip_cost_already_settled', undefined, undefined, {
      tripCostIds: [encodeId('tripCost', costId)],
      settlementIds: [],
    });
  }

  private async voidLines(tx: Tx, ids: string[], actor: string, reason: string) {
    if (!ids.length) return;
    // ล็อกบรรทัดต้นทุนก่อน (ลำดับ id เดียวกับตอนสร้าง/เพิ่ม — ไม่ deadlock กับคำขอที่หยิบเที่ยวเดียวกันพร้อมกัน)
    await tx.$queryRaw`
      SELECT id FROM trip_cost WHERE settlement_line_id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    await tx.settlementLine.updateMany({
      where: { id: { in: ids }, voidedAt: null },
      data: { voidedAt: new Date(), voidedBy: actor, voidReason: reason },
    });
    // บรรทัดต้นทุนกลับคิวจ่าย
    await tx.$executeRaw`
      UPDATE trip_cost SET settlement_line_id = NULL, version = version + 1, updated_at = now()
       WHERE settlement_line_id = ANY(${ids}::uuid[])`;
  }

  /** ยอดหัวใบจากบรรทัดที่ยังใช้ (SQL numeric — ไม่ใช้ float) */
  private async recompute(tx: Tx, id: string, bump: boolean) {
    // ยอดต้องอยู่ในช่วง numeric(14,2) — เกิน = 422 (ไม่ปล่อยให้ DB ตอบ 22003 เป็น 500)
    const [t] = await tx.$queryRaw<{ out: boolean }[]>`
      SELECT greatest(abs(gross), abs(ded), abs(gross - ded)) > ${MAX_AMOUNT}::numeric AS out
        FROM (SELECT coalesce(sum(amount) FILTER (WHERE line_type <> 'DEDUCTION'), 0) AS gross,
                     coalesce(-sum(amount) FILTER (WHERE line_type = 'DEDUCTION'), 0) AS ded
                FROM settlement_line WHERE settlement_id = ${id}::uuid AND voided_at IS NULL) x`;
    if (t?.out)
      throw invalid([
        {
          field: 'deductions',
          code: 'amount_out_of_range',
          message: 'settlement totals exceed 999,999,999,999.99',
        },
      ]);
    await tx.$executeRaw`
      UPDATE carrier_settlement s
         SET gross_amount = t.gross, deduction_amount = t.ded, net_payable = t.gross - t.ded,
             version = s.version + ${bump ? 1 : 0}, updated_at = now()
        FROM (SELECT coalesce(sum(amount) FILTER (WHERE line_type <> 'DEDUCTION'), 0) AS gross,
                     coalesce(-sum(amount) FILTER (WHERE line_type = 'DEDUCTION'), 0) AS ded
                FROM settlement_line WHERE settlement_id = ${id}::uuid AND voided_at IS NULL) t
       WHERE s.id = ${id}::uuid`;
  }
}

/**
 * `data.object` ของ webhook `settlement.approved` (ทะเบียน event ST7-T06) = SettlementDto เดียวกับ `GET /v1/settlements/{id}`
 * − ยอดเงิน (`buy*` — webhook ระดับ tenant ไม่ผ่านสิทธิ์ราคา) − `omit` ของทะเบียน (บรรทัด, id ผู้ใช้ — ดูรายละเอียดผ่าน REST)
 */
function settlementEventObject(dto: SettlementDto): Record<string, unknown> {
  const o = JSON.parse(JSON.stringify(redactPrices(dto, []))) as Record<string, unknown>;
  for (const k of eventDefinition('settlement.approved')!.object!.omit) delete o[k];
  return o;
}

/** If-Match บังคับ (แบบ approve — review L5 ของ T07 / QA L1 ของ T05) — ตรวจหลังหาใบเจอ (ใบของบริษัทอื่น = 404 ก่อน) */
function requireIfMatch(expected: number | undefined): void {
  if (expected === undefined)
    throw invalid([
      {
        field: 'If-Match',
        code: 'if_match_required',
        message: 'send If-Match (ETag of the settlement)',
      },
    ]);
}

function invalid(errors: FieldError[]) {
  return new ProblemException('validation_failed', undefined, errors);
}

function isUniqueViolation(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code === 'P2002';
  return e instanceof Error && /23505|unique constraint/i.test(e.message);
}

function headerOf(s: {
  periodFrom: Date;
  periodTo: Date;
  carrierInvoiceNo: string | null;
  carrierInvoiceDate: Date | null;
  carrierReceiptNo: string | null;
  note: string | null;
}): Record<string, unknown> {
  return {
    periodFrom: ymd(s.periodFrom),
    periodTo: ymd(s.periodTo),
    carrierInvoiceNo: s.carrierInvoiceNo,
    carrierInvoiceDate: s.carrierInvoiceDate ? ymd(s.carrierInvoiceDate) : null,
    carrierReceiptNo: s.carrierReceiptNo,
    note: s.note,
  };
}

function carrierDto(carrierId: string, snap: Prisma.JsonValue): SettlementCarrierDto {
  const c = snap as unknown as CarrierSnapshot;
  return {
    id: encodeId('carrier', carrierId),
    code: c.code,
    legalName: c.legalName,
    entityType: c.entityType,
    taxId: c.taxId,
    taxIdLast4: c.taxIdLast4,
    branchCode: c.branchCode,
  };
}

function lineDto(
  l: SettlementRow['lines'][number],
  r: SettlementRow['reviews'][number] | undefined,
  co: SettlementRow['disputes'][number] | undefined,
  status: SettlementLineDto['status'],
  wht: SettlementWhtEstimate['lines'][number] | undefined,
): SettlementLineDto {
  return {
    id: encodeId('settlementLine', l.id),
    lineNo: l.lineNo,
    lineType: l.lineType,
    tripCostId: l.tripCostId ? encodeId('tripCost', l.tripCostId) : null,
    tripId: l.tripId ? encodeId('trip', l.tripId) : null,
    tripNo: l.trip?.tripNo ?? null,
    costType: l.tripCost?.costType ?? null,
    deductionType: l.deductionType,
    description: l.description,
    buyAmount: l.amount.toFixed(2),
    reference: l.reference,
    vatType: l.vatType,
    whtRate: l.whtRate?.toFixed(2) ?? null,
    whtRateApplied: wht?.ratePercent ?? null,
    whtRateSource: wht?.rateSource ?? null,
    buyWhtAmount: wht && wht.ratePercent !== null ? decimalFromSatang(wht.wht) : null,
    active: l.voidedAt === null,
    voidedAt: l.voidedAt?.toISOString() ?? null,
    voidedBy: l.voidedBy,
    voidReason: l.voidReason,
    createdBy: l.createdBy,
    createdAt: l.createdAt.toISOString(),
    carrierReview: r
      ? {
          response: r.response as 'ACCEPTED' | 'DISPUTED',
          reason: r.reason,
          photoIds: r.photoIds.map((p) => encodeId('document', p)),
          buyClaimedAmount: r.claimedAmount?.toFixed(2) ?? null,
          round: r.round,
          respondedAt: r.createdAt.toISOString(),
        }
      : null,
    status,
    companyReview: co
      ? {
          action: co.action as 'DISPUTED' | 'RESOLVED',
          reason: co.reason,
          round: co.round,
          by: co.createdBy,
          at: co.createdAt.toISOString(),
        }
      : null,
  };
}

/**
 * หัก ณ ที่จ่ายประมาณการของใบ (ST6-T08) จากบรรทัดที่ยังใช้ — ใบที่ตรึงแล้ว (อนุมัติ) ใช้ขั้นต่ำที่ตรึงไว้
 * อัตราบรรทัดว่าง → `wht_rate_default` ของใบ (ค่าตั้งต้นรถร่วม ณ วันสร้าง/ตรึงตอนอนุมัติ) · ใบเก่าที่ยังไม่อนุมัติ = ค่าปัจจุบันของรถร่วม
 * ใบที่ตรึงแล้ว: บรรทัดแข็ง + อัตราตั้งต้น + ขั้นต่ำที่ตรึง → ผลแยกอัตรา/รายบรรทัดเท่ากับตอนอนุมัติเสมอ
 */
/**
 * snapshot รถร่วมมีประเภทที่จัดแบบยื่นได้ (INDIVIDUAL/JURISTIC) — ใช้กันรายการ/รายละเอียดล้มทั้งหน้า (500)
 * ปกติเกิดไม่ได้: `create` คัดลอก `carrier.entity_type` (enum NOT NULL) ลง snapshot เสมอ — แถวแบบนี้มาจากการเขียนฐานตรง
 * (fixture กติกา DB ใน test, ข้อมูลย้าย/แก้มือ) เท่านั้น · ไม่เดาประเภท = ไม่คำนวณ/ไม่ตรึงหัก ณ ที่จ่ายให้แถวนั้น
 */
function hasWhtEntityType(snap: Prisma.JsonValue): boolean {
  const t = (snap as { entityType?: unknown } | null)?.entityType;
  return t === 'INDIVIDUAL' || t === 'JURISTIC';
}

/** อนุมัติ/บันทึกจ่าย (ตรึง WHT) ใบที่ไม่รู้ประเภทรถร่วมไม่ได้ → 409 แทน 500 */
export function requireWhtEntityType(snap: Prisma.JsonValue): void {
  if (!hasWhtEntityType(snap)) throw new ProblemException('settlement_carrier_type_missing');
}

function whtOf(
  r: {
    carrierSnapshot: Prisma.JsonValue;
    carrier: { whtRateDefault: Prisma.Decimal };
    whtMinimumAmount: Prisma.Decimal | null;
    whtRateDefault: Prisma.Decimal | null;
  },
  lines: readonly {
    lineType: string;
    amount: Prisma.Decimal;
    whtRate: Prisma.Decimal | null;
    voidedAt: Date | null;
  }[],
  liveMinimum: number,
): SettlementWhtEstimate {
  const snap = r.carrierSnapshot as unknown as CarrierSnapshot;
  return estimateSettlementWht({
    lines: lines
      .filter((l) => !l.voidedAt)
      .map((l) => ({
        lineType: l.lineType as SettlementLineKind,
        amount: satangFromDecimal(l.amount.toFixed(2)),
        whtRate: l.whtRate?.toFixed(2) ?? null,
      })),
    carrierWhtRateDefault: (r.whtRateDefault ?? r.carrier.whtRateDefault).toFixed(2),
    entityType: snap.entityType,
    whtMinimumAmount: r.whtMinimumAmount ? Number(r.whtMinimumAmount.toFixed(0)) : liveMinimum,
  });
}

/** ยอดรวม WHT ของใบ — ตรึงแล้ว (`wht_amount`) ใช้ค่าที่ตรึง: สุทธิหลังหัก = ยอดสุทธิ − wht_amount */
/** ไม่มีผลประมาณการ (ไม่รู้ประเภทรถร่วม): ใช้เฉพาะยอดที่ตรึงแล้ว — ยังไม่ตรึง = ไม่ส่งยอด WHT */
function frozenTotals(r: { whtAmount: Prisma.Decimal | null; netPayable: Prisma.Decimal }): {
  buyWhtAmount?: string;
  buyNetAfterWht?: string;
} {
  return r.whtAmount !== null
    ? {
        buyWhtAmount: r.whtAmount.toFixed(2),
        buyNetAfterWht: r.netPayable.minus(r.whtAmount).toFixed(2),
      }
    : {};
}

function whtTotals(
  r: { whtAmount: Prisma.Decimal | null; netPayable: Prisma.Decimal },
  wht: SettlementWhtEstimate,
): { buyWhtAmount: string; buyNetAfterWht: string } {
  if (r.whtAmount !== null)
    return {
      buyWhtAmount: r.whtAmount.toFixed(2),
      buyNetAfterWht: r.netPayable.minus(r.whtAmount).toFixed(2),
    };
  return {
    buyWhtAmount: decimalFromSatang(wht.wht),
    buyNetAfterWht: decimalFromSatang(wht.netAfterWht),
  };
}

function toDto(
  r: SettlementRow,
  disputed: Set<string>,
  wht: SettlementWhtEstimate | null,
): SettlementDto {
  // ผล WHT ของบรรทัดที่ยังใช้ เรียงตามลำดับบรรทัด (whtOf กรองบรรทัดที่นำออกแล้ว) · null = ไม่รู้ประเภทรถร่วม (hasWhtEntityType)
  const activeIds = r.lines.filter((l) => !l.voidedAt).map((l) => l.id);
  const whtLine = new Map(wht ? activeIds.map((id, i) => [id, wht.lines[i]!]) : []);
  const tripLines = r.lines.filter((l) => !l.voidedAt && l.lineType !== 'DEDUCTION');
  // คำตอบของรถร่วม = รอบตรวจปัจจุบันเท่านั้น (เรียกกลับแล้วส่งใหม่ = เริ่มนับใหม่ · รอบก่อนเก็บเป็นประวัติ)
  const latest = latestReviews(r.reviews, r.reviewRound);
  const active = r.lines.filter((l) => !l.voidedAt);
  const count = (resp: string) => active.filter((l) => latest.get(l.id)?.response === resp).length;
  // ST6-T06 สถานะรายการ: โต้แย้งค้าง (DB) / ยอมรับหรือเคลียร์แล้ว / ยังไม่มีคำตอบ
  const company = latestBy(r.disputes, r.reviewRound);
  const resolved = latestBy(r.disputes, r.reviewRound, (d) => d.action === 'RESOLVED');
  const statusOf = (l: SettlementRow['lines'][number]) =>
    l.voidedAt
      ? null
      : lineStatus(disputed.has(l.id), latest.get(l.id)?.response, resolved.has(l.id));
  const statuses = active.map(statusOf);
  return {
    id: encodeId('settlement', r.id),
    settlementNo: r.settlementNo,
    status: r.status as SettlementStatus,
    carrier: carrierDto(r.carrierId, r.carrierSnapshot),
    payingCompanyId: r.payingCompanyId ? encodeId('company', r.payingCompanyId) : null,
    periodFrom: ymd(r.periodFrom),
    periodTo: ymd(r.periodTo),
    carrierInvoiceNo: r.carrierInvoiceNo,
    carrierInvoiceDate: r.carrierInvoiceDate ? ymd(r.carrierInvoiceDate) : null,
    carrierReceiptNo: r.carrierReceiptNo,
    note: r.note,
    tripCount: new Set(tripLines.map((l) => l.tripId)).size,
    buyGrossAmount: r.grossAmount.toFixed(2),
    buyDeductionAmount: r.deductionAmount.toFixed(2),
    buyNetPayable: r.netPayable.toFixed(2),
    ...(wht ? whtTotals(r, wht) : frozenTotals(r)),
    whtEstimate: wht
      ? {
          review: wht.review,
          form: wht.form,
          frozen: r.whtAmount !== null,
          minimumAmount: decimalFromSatang(wht.minimum),
          belowMinimum: wht.belowMinimum,
          byRate: wht.byRate.map((g) => ({
            whtRate: g.ratePercent,
            buyBaseAmount: decimalFromSatang(g.base),
            buyWhtAmount: decimalFromSatang(g.wht),
          })),
        }
      : null,
    lines: r.lines.map((l) =>
      lineDto(l, latest.get(l.id), company.get(l.id), statusOf(l), whtLine.get(l.id)),
    ),
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedBy: r.approvedBy,
    paidDate: r.paidDate ? ymd(r.paidDate) : null,
    paidAt: r.paidAt?.toISOString() ?? null,
    paidBy: r.paidBy,
    paymentMethod: r.paymentMethod as SettlementDto['paymentMethod'],
    paymentReference: r.paymentReference,
    paymentBank: r.paymentBank,
    sentAt: r.sentAt?.toISOString() ?? null,
    sentBy: r.sentBy,
    carrierReview: {
      round: r.reviewRound,
      accepted: count('ACCEPTED'),
      disputed: count('DISPUTED'),
      pending: r.reviewRound > 0 ? active.filter((l) => !latest.has(l.id)).length : 0,
    },
    dispute: {
      disputed: statuses.filter((x) => x === 'DISPUTED').length,
      approved: statuses.filter((x) => x === 'APPROVED').length,
      open: statuses.filter((x) => x === 'OPEN').length,
    },
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelledBy: r.cancelledBy,
    cancelReason: r.cancelReason,
    createdBy: r.createdBy,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
