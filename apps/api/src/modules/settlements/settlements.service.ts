import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { eventDefinition } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { resolveActors } from '../../common/actors';
import { encodeId, tryDecodeId } from '../../common/ids';
import { redactPrices } from '../../common/price-fields';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { issueNumber } from '../sequences/sequences.service';
import { readSettings } from '../settings/settings.service';
import type {
  CreateSettlementDto,
  SettlementCarrierDto,
  SettlementDto,
  SettlementItemsInput,
  SettlementLineDto,
  SettlementListQuery,
  SettlementPageDto,
  SettlementStatus,
  SettlementSummaryDto,
  UpdateSettlementDto,
} from './settlement.dto';
import { SettlementQueueService } from './settlement-queue.service';

const ENTITY = 'carrier_settlement';
/** ผู้อนุมัติได้ = ผู้ใช้ที่ login (`dev` = token ทดสอบ — production ปฏิเสธ) — ไม่ใช่ API key / ลิงก์ (review H1) */
const HUMAN_PRINCIPALS = new Set(['user', 'dev']);
/** เพดาน numeric(14,2) */
const MAX_AMOUNT = '999999999999.99';

type SettlementRow = Prisma.CarrierSettlementGetPayload<{
  include: {
    lines: {
      include: { tripCost: { select: { costType: true } }; trip: { select: { tripNo: true } } };
    };
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
 * - ยอด: gross = Σ บรรทัดเที่ยวที่ยังใช้ · deduction = Σ |บรรทัดหัก| · net = gross − deduction (CHECK ใน DB) · ไม่คำนวณ VAT/WHT (ST6-T08)
 * - ร่างไม่มีเลขเอกสาร (เลข STL ออกตอนอนุมัติ — ST6-T07) · นำบรรทัดออก / ยกเลิกใบ = void + เหตุผล + audit → บรรทัดต้นทุนกลับคิว
 */
@Injectable()
export class SettlementsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly queue: SettlementQueueService,
  ) {}

  // ---------- อ่าน ----------

  async list(q: SettlementListQuery): Promise<SettlementPageDto> {
    const tx = this.db.tx;
    const k = keysetArgs(q);
    const and: Prisma.CarrierSettlementWhereInput[] = [
      k.where as Prisma.CarrierSettlementWhereInput,
    ];
    if (q.status) and.push({ status: q.status });
    if (q.carrierId !== undefined) {
      const carrierId = await this.carrierRef(tx, q.carrierId);
      and.push({ carrierId: carrierId ?? '00000000-0000-0000-0000-000000000000' });
    }
    const rows = await tx.carrierSettlement.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.CarrierSettlementOrderByWithRelationInput[],
      take: k.take,
      include: {
        lines: {
          where: { voidedAt: null, lineType: { not: 'DEDUCTION' } },
          select: { tripId: true },
        },
      },
    });
    const page = toPage(
      rows,
      k,
      (r): SettlementSummaryDto => ({
        id: encodeId('settlement', r.id),
        settlementNo: r.settlementNo,
        status: r.status as SettlementStatus,
        carrier: carrierDto(r.carrierId, r.carrierSnapshot),
        periodFrom: ymd(r.periodFrom),
        periodTo: ymd(r.periodTo),
        carrierInvoiceNo: r.carrierInvoiceNo,
        tripCount: new Set(r.lines.map((l) => l.tripId)).size,
        buyGrossAmount: r.grossAmount.toFixed(2),
        buyDeductionAmount: r.deductionAmount.toFixed(2),
        buyNetPayable: r.netPayable.toFixed(2),
        approvedAt: r.approvedAt?.toISOString() ?? null,
        createdBy: r.createdBy,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }),
      q.fields,
    );
    return page as SettlementPageDto;
  }

  async get(id: string): Promise<SettlementDto> {
    const r = await this.load(this.db.tx, id);
    if (!r) throw new ProblemException('not_found');
    return toDto(r);
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
   * - ผู้ใช้ที่ login เท่านั้น · ผู้เตรียมใบ (ผู้สร้าง/ผู้เพิ่ม/ผู้นำบรรทัดออก; key = ผู้ออก key; ระบุไม่ได้ = ปฏิเสธ) อนุมัติไม่ได้ → 403 `settlement_self_approval` (trigger 0125 ใน DB ด้วย)
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
    // ST6-T05 จะเพิ่ม SENT_TO_CARRIER เป็นสถานะที่อนุมัติได้ (docs/01 §4.5) — ตอนนี้ DRAFT → APPROVED (tenant ข้ามขั้นรถร่วมตรวจ)
    const s = await this.lockDraft(tx, id, expected);
    const actor = ctx.actorId;
    // อนุมัติ = คนที่ login เท่านั้น (review H1) — API key / OAuth client ไม่มี scope นี้อยู่แล้ว (API_KEY_DENIED_SCOPES) กันอีกชั้นที่นี่
    if (!actor || !HUMAN_PRINCIPALS.has(ctx.principalType ?? ''))
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'settlements',
        action: 'approve',
        required: ['settlements:approve'],
      });
    await this.assertNotPreparer(tx, id, s.createdBy, actor);
    await this.assertNoOpenDisputes(tx, id);
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

    const settlementNo = await issueNumber(tx, ctx.tenantId!, { docType: 'STL' });
    await tx.carrierSettlement.update({
      where: { id },
      data: {
        status: 'APPROVED',
        settlementNo,
        approvedAt: new Date(),
        approvedBy: actor,
        version: { increment: 1 },
      },
    });
    const out = await this.get(id);
    await this.audit.record({
      action: 'settlement.approved',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { status: 'DRAFT', settlementNo: null },
      after: {
        status: 'APPROVED',
        settlementNo,
        stepUp: needStepUp,
        buyNetPayable: out.buyNetPayable,
      },
    });
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type: 'settlement.approved',
        entityType: ENTITY,
        localId: id,
        snapshot: settlementEventObject(out) as Prisma.InputJsonValue,
        previousAttributes: { status: 'DRAFT', settlementNo: null },
        requestId: ctx.requestId ?? null,
        actorId: actor,
      },
    });
    return out;
  }

  /**
   * separation of duties (A3; review H1/M2): ผู้อนุมัติต้องไม่ใช่ผู้เตรียมใบ — ผู้สร้างหัวใบ + ผู้เพิ่มบรรทัด + ผู้นำบรรทัดออก
   * actor ที่เป็น API key (`apikey:<id>`) = ผู้ออก key · ผู้เตรียมที่ระบุตัวไม่ได้ (ว่าง/key หาไม่พบ/ไม่มีผู้ออก) = ปฏิเสธ (fail closed)
   */
  private async assertNotPreparer(
    tx: Tx,
    id: string,
    createdBy: string | null,
    actor: string,
  ): Promise<void> {
    const lines = await tx.settlementLine.findMany({
      where: { settlementId: id },
      select: { createdBy: true, voidedAt: true, voidedBy: true },
    });
    const raw = [
      createdBy,
      ...lines.map((l) => l.createdBy),
      ...lines.filter((l) => l.voidedAt).map((l) => l.voidedBy),
    ];
    const [me, ...preparers] = await resolveActors(tx, [actor, ...raw]);
    if (me === null || preparers.some((p) => p === null || p === me))
      throw new ProblemException('settlement_self_approval');
  }

  /**
   * จุดต่อ ST6-T06 (Dispute — docs/01 §4.5 "dispute ใด ๆ บล็อก approve", spec/05 BIL-136):
   * เมื่อมีบรรทัด DISPUTED ให้ throw 409 ที่นี่ ("มีรายการโต้แย้ง n รายการ") — ตอนนี้ยังไม่มีข้อมูล dispute จึงผ่านเสมอ
   */
  private async assertNoOpenDisputes(_tx: Tx, _id: string): Promise<void> {
    return;
  }

  // ---------- ภายใน ----------

  private load(tx: Tx, id: string): Promise<SettlementRow | null> {
    return tx.carrierSettlement.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { tripCost: { select: { costType: true } }, trip: { select: { tripNo: true } } },
        },
      },
    });
  }

  /** ล็อกใบ (FOR UPDATE) + ตรวจ If-Match + ต้องเป็นร่าง */
  private async lockDraft(tx: Tx, id: string, expected: number | undefined) {
    const [r] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM carrier_settlement WHERE id = ${id}::uuid FOR UPDATE`;
    if (!r) throw new ProblemException('not_found');
    const s = await tx.carrierSettlement.findUniqueOrThrow({ where: { id } });
    if (expected !== undefined && expected !== s.version)
      throw new ProblemException('precondition_failed');
    if (s.status !== 'DRAFT')
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

function lineDto(l: SettlementRow['lines'][number]): SettlementLineDto {
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
    active: l.voidedAt === null,
    voidedAt: l.voidedAt?.toISOString() ?? null,
    voidedBy: l.voidedBy,
    voidReason: l.voidReason,
    createdBy: l.createdBy,
    createdAt: l.createdAt.toISOString(),
  };
}

function toDto(r: SettlementRow): SettlementDto {
  const tripLines = r.lines.filter((l) => !l.voidedAt && l.lineType !== 'DEDUCTION');
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
    lines: r.lines.map(lineDto),
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedBy: r.approvedBy,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelledBy: r.cancelledBy,
    cancelReason: r.cancelReason,
    createdBy: r.createdBy,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
