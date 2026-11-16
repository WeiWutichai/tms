import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  cheapestReasonTh,
  computeDocumentTax,
  decimalFromSatang,
  decideSelection,
  satangFromDecimal,
  SELECTION_REASON_MIN_LENGTH,
  toCalcVatType,
  toCalcWhtRate,
  type PricingStatus,
  type SelectionKind,
  type ServiceItemVatType,
} from '@tms/domain';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { cleanLine } from '../master/master-kit';
import { PricingService } from '../pricing/pricing.service';
import { RateCardsService } from '../rate-cards/rate-cards.service';
import type { HireOptionsDto } from './trip.dto';
import { TripService, type TripRecord } from './trip.service';

const field422 = (field: string, code: string, message: string, detail?: string) =>
  new ProblemException('validation_failed', detail, [{ field, code, message }]);

/** ผลคิดราคาขาซื้อของรถร่วมหนึ่งรายสำหรับเที่ยวนี้ (เก็บเป็น `subcon_offer.rate_quote`) */
export interface BuyQuote {
  status: PricingStatus;
  /** ยอดก่อน VAT — null เมื่อคิดไม่ได้ */
  total: string | null;
  rateCardId: string | null;
  rateCardCode: string | null;
  revision: number | null;
  /** ธงภาษีของบรรทัดค่าขนส่ง (ทุกบรรทัดของผลคิดต้องตรงกัน — ไม่ตรง = null) */
  vatType: ServiceItemVatType | null;
  whtRate: string | null;
  serviceItemId: string | null;
  reasons: string[];
}

/** บริบทเที่ยวที่ใช้คิดราคาขาซื้อ (ต้นทาง = จุดแรก, ปลายทาง = จุดสุดท้าย — แบบเดียวกับ rate card เฟส 0) */
export interface HireContext {
  originSiteId: string | null;
  destSiteId: string | null;
  vehicleTypeId: string | null;
  vehicleTypeName: string | null;
  date: string;
  stops: number;
  quantities: { qty: string; unitId: string; productId: string | null }[];
  /** รายได้ของเที่ยว (ผลรวมรายได้ DO ก่อน VAT) — null = ยังไม่มีราคา */
  sellAmount: string | null;
}

export interface HireCarrierOption {
  carrier: {
    id: string;
    code: string;
    legalName: string;
    whtRateDefault: Prisma.Decimal;
    paymentTermDays: number;
    requirePodToPay: boolean;
  };
  quote: BuyQuote;
}

export interface HireInput {
  carrierId: string;
  /** ราคาซื้อที่ตกลง (ไม่ส่ง = ตาม rate card ขาซื้อของรายนี้) */
  cost?: string | null;
  selectionReason?: string | null;
  /** ประเภทรถที่จ้าง (ไม่ส่ง = ตามเที่ยว/ใบสั่ง) */
  vehicleTypeId?: string | null;
}

const NO_QUOTE = (reason: string): BuyQuote => ({
  status: 'RATE_MISSING',
  total: null,
  rateCardId: null,
  rateCardCode: null,
  revision: null,
  vatType: null,
  whtRate: null,
  serviceItemId: null,
  reasons: [reason],
});

const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * จ้างรถร่วม (ST3-T22; docs/04 D3 "เลือก carrier + ราคาซื้อ" + "บันทึกเหตุผลการเลือก", spec/03 §8)
 * - ตัวเลือก: รถร่วมที่ใช้งานอยู่ทุกราย + ราคาขาซื้อจาก rate card (pricing engine ST2-T15) + ราคา 5 ครั้งล่าสุด (ST2-T14)
 * - จ้าง = `/offer` (PLANNING → OFFERED) + `subcon_offer` + `trip_cost` CARRIER_FEE ในล็อกเดียวกัน
 * - ไม่ใช่ราคาถูกสุด (หรือไม่มีราคาให้เทียบ) → ต้องมีเหตุผล ≥ 10 ตัว · ถูกสุด → ระบบเขียนเหตุผลให้ (`selectionReason` ไม่ว่างเสมอ)
 * - ส่งลิงก์ให้รถร่วม = ST3-T23 · หมดเวลา = ST3-T24 · เปลี่ยนรถร่วม = ST3-T25 (บรรทัดค่าจ้างเดิมกลับรายการ — มีตัวช่วยแล้ว)
 */
@Injectable()
export class SubconHireService {
  constructor(
    private readonly db: DbService,
    private readonly trips: TripService,
    private readonly pricing: PricingService,
    private readonly rateCards: RateCardsService,
  ) {}

  /** บริบทคิดราคาของเที่ยว — ประเภทรถ: ที่ระบุ → ของเที่ยว → ของใบสั่ง (ทุกใบตรงกัน) */
  async context(tx: Tx, trip: TripRecord, vehicleTypeId?: string | null): Promise<HireContext> {
    const stops = trip.stops;
    const doIds = trip.deliveryOrders.map((d) => d.id);
    const [dos, lines] = await Promise.all([
      tx.deliveryOrder.findMany({
        where: { id: { in: doIds } },
        select: { revenueAmount: true, salesOrder: { select: { vehicleTypeId: true } } },
      }),
      tx.deliveryOrderLine.findMany({
        where: { deliveryOrderId: { in: doIds } },
        select: {
          qtyPlanned: true,
          salesOrderLine: { select: { unitId: true, productId: true } },
        },
      }),
    ]);
    let vt = vehicleTypeId ?? trip.vehicleTypeId ?? null;
    if (!vt) {
      const set = new Set(dos.map((d) => d.salesOrder.vehicleTypeId));
      if (set.size === 1) vt = [...set][0] ?? null;
    }
    const vtRow = vt
      ? await tx.vehicleType.findFirst({
          where: { id: vt, deletedAt: null },
          select: { id: true, nameTh: true },
        })
      : null;
    if (vehicleTypeId && !vtRow)
      throw field422('vehicleTypeId', 'invalid_reference', 'vehicle type not found');
    const revenue = dos.map((d) => d.revenueAmount);
    const sell =
      revenue.length && revenue.every((r) => r !== null)
        ? revenue.reduce<Prisma.Decimal>((a, r) => a.add(r!), new Prisma.Decimal(0)).toFixed(2)
        : null;
    return {
      originSiteId: stops[0]?.siteId ?? null,
      destSiteId: stops[stops.length - 1]?.siteId ?? null,
      vehicleTypeId: vtRow?.id ?? null,
      vehicleTypeName: vtRow?.nameTh ?? null,
      date: trip.tripDate.toISOString().slice(0, 10),
      stops: stops.length,
      quantities: lines.flatMap((l) =>
        l.salesOrderLine?.unitId
          ? [
              {
                qty: l.qtyPlanned.toFixed(),
                unitId: l.salesOrderLine.unitId,
                productId: l.salesOrderLine.productId,
              },
            ]
          : [],
      ),
      sellAmount: sell,
    };
  }

  /** คิดราคาขาซื้อของรายเดียว (ไม่มี rate card / ข้อมูลไม่พอ = RATE_MISSING) */
  async quote(tx: Tx, ctx: HireContext, carrierId: string, hasRate = true): Promise<BuyQuote> {
    if (!ctx.originSiteId || !ctx.destSiteId) return NO_QUOTE('ยังไม่มีจุดรับ/ส่งในเที่ยว');
    if (!ctx.vehicleTypeId) return NO_QUOTE('ไม่ทราบประเภทรถของงาน');
    if (!hasRate) return NO_QUOTE('ไม่มี rate card ขาซื้อของเส้นทาง/ประเภทรถนี้');
    const q = await this.pricing.quote(
      {
        side: 'BUY',
        partyId: carrierId,
        originSiteId: ctx.originSiteId,
        destSiteId: ctx.destSiteId,
        vehicleTypeId: ctx.vehicleTypeId,
        date: ctx.date,
        quantities: ctx.quantities,
        stops: ctx.stops,
      },
      tx,
    );
    const freight = q.lines.find((l) => l.kind === 'FREIGHT') ?? null;
    const same = (k: 'vatType' | 'whtRate') =>
      q.lines.length && q.lines.every((l) => l[k] === q.lines[0]![k]) ? q.lines[0]![k] : null;
    return {
      status: q.pricingStatus,
      total: q.pricingStatus === 'AVAILABLE' ? q.total : null,
      rateCardId: q.params.rateCardId,
      rateCardCode: q.params.rateCode,
      revision: q.params.rateRevision,
      vatType: same('vatType') as ServiceItemVatType | null,
      whtRate: same('whtRate') as string | null,
      serviceItemId: freight?.serviceItem.sourceItemId ?? null,
      reasons: q.reasons.map((r) => r.message),
    };
  }

  /** รถร่วมที่ใช้งานอยู่ทุกราย + ราคาขาซื้อของเที่ยวนี้ (คิดเฉพาะรายที่มี rate card ตรงเส้นทาง/ประเภทรถ/วันที่) */
  async candidates(tx: Tx, ctx: HireContext): Promise<HireCarrierOption[]> {
    const carriers = await tx.carrier.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: {
        id: true,
        code: true,
        legalName: true,
        whtRateDefault: true,
        paymentTermDays: true,
        requirePodToPay: true,
      },
      orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
    });
    const priced = new Set<string>();
    if (ctx.originSiteId && ctx.destSiteId && ctx.vehicleTypeId) {
      const d = new Date(`${ctx.date}T00:00:00Z`);
      const rows = await tx.rateCard.findMany({
        where: {
          side: 'BUY',
          originSiteId: ctx.originSiteId,
          destSiteId: ctx.destSiteId,
          vehicleTypeId: ctx.vehicleTypeId,
          status: 'APPROVED',
          deletedAt: null,
          validFrom: { lte: d },
          OR: [{ validTo: null }, { validTo: { gte: d } }],
        },
        select: { carrierId: true },
        distinct: ['carrierId'],
      });
      for (const r of rows) if (r.carrierId) priced.add(r.carrierId);
    }
    const out: HireCarrierOption[] = [];
    for (const c of carriers)
      out.push({ carrier: c, quote: await this.quote(tx, ctx, c.id, priced.has(c.id)) });
    // ราคาถูกก่อน → รายที่คิดราคาไม่ได้ตามชื่อ
    return out.sort((a, b) => {
      const x = a.quote.total;
      const y = b.quote.total;
      if (x !== null && y !== null) {
        const dx = satangFromDecimal(x) - satangFromDecimal(y);
        if (dx !== 0n) return dx < 0n ? -1 : 1;
      }
      if (x === null && y !== null) return 1;
      if (x !== null && y === null) return -1;
      return a.carrier.legalName.localeCompare(b.carrier.legalName, 'th');
    });
  }

  /** ราคา 5 ครั้งล่าสุดที่จ้างรายนี้ในเส้นทาง/ประเภทรถเดียวกัน (ST2-T14 — ใหม่สุดก่อน) */
  async recent(carrierId: string, ctx: HireContext): Promise<string[]> {
    const rows = await this.rateCards.recentCarrierPrices(carrierId, {
      originId: ctx.originSiteId ? encodeId('site', ctx.originSiteId) : undefined,
      destinationId: ctx.destSiteId ? encodeId('site', ctx.destSiteId) : undefined,
      vehicleTypeId: ctx.vehicleTypeId ? encodeId('vehicleType', ctx.vehicleTypeId) : undefined,
    });
    return rows.map((r) => r.buyAmount);
  }

  /** GET /trips/{id}/hire-options — ตัวเลือก + ราคา 5 ครั้งล่าสุด + รายที่ถูกสุด (อ่านอย่างเดียว) */
  async optionsDto(trip: TripRecord, vehicleTypeId?: string | null): Promise<HireOptionsDto> {
    const tx = this.db.tx;
    const ctx = await this.context(tx, trip, vehicleTypeId);
    const options = await this.candidates(tx, ctx);
    const decision = decideSelection(
      '0.00',
      options.map((o) => ({ carrierId: o.carrier.id, amount: o.quote.total })),
    );
    const cheapest = new Set(decision.cheapestCarrierIds);
    const sites = await tx.customerSite.findMany({
      where: { id: { in: [ctx.originSiteId, ctx.destSiteId].filter((x): x is string => !!x) } },
      select: { id: true, code: true, name: true },
    });
    const site = (id: string | null) => {
      const x = id ? sites.find((y) => y.id === id) : null;
      return x ? { id: encodeId('site', x.id), code: x.code, name: x.name } : null;
    };
    const out: HireOptionsDto['options'] = [];
    for (const o of options)
      out.push({
        carrier: {
          id: encodeId('carrier', o.carrier.id),
          code: o.carrier.code,
          name: o.carrier.legalName,
          whtRateDefault: o.carrier.whtRateDefault.toFixed(2),
          paymentTermDays: o.carrier.paymentTermDays,
          requirePodToPay: o.carrier.requirePodToPay,
        },
        pricingStatus: o.quote.status,
        buyRateAmount: o.quote.total,
        rateCardCode: o.quote.rateCardCode,
        pricingReasons: o.quote.reasons,
        vatType: o.quote.vatType,
        whtRate: o.quote.whtRate,
        cheapest: cheapest.has(o.carrier.id),
        buyRecentAmounts: await this.recent(o.carrier.id, ctx),
      });
    return {
      tripId: encodeId('trip', trip.id),
      tripNo: trip.tripNo!,
      origin: site(ctx.originSiteId),
      destination: site(ctx.destSiteId),
      vehicleTypeId: ctx.vehicleTypeId ? encodeId('vehicleType', ctx.vehicleTypeId) : null,
      vehicleTypeName: ctx.vehicleTypeName,
      sellAmount: ctx.sellAmount,
      buyCheapestAmount: decision.cheapestAmount,
      options: out,
    };
  }

  /**
   * จ้างรถร่วม = เสนองาน (`/offer`): ตรวจราคา/เหตุผล → `subcon_offer` + `trip_cost` CARRIER_FEE + snapshot ราคาซื้อบนเที่ยว
   * ทั้งหมดในล็อกเที่ยวเดียวกับ transition (ไม่ผ่าน = ไม่มีอะไรถูกเขียน)
   */
  async hire(id: string, input: HireInput, expectedVersion?: number): Promise<TripRecord> {
    const cost = input.cost === undefined || input.cost === null ? null : String(input.cost).trim();
    if (cost !== null && (!MONEY_RE.test(cost) || satangFromDecimal(cost) <= 0n))
      throw field422('cost', 'invalid_amount', 'cost must be a positive amount with ≤ 2 decimals');
    const typed = input.selectionReason ? cleanLine(String(input.selectionReason)).trim() : '';
    const actor = requestContext.require().actorId ?? null;
    return this.trips.offer(
      id,
      input.carrierId,
      this.db.tx,
      expectedVersion,
      async (tx, trip, carrier) => {
        const ctx = await this.context(tx, trip, input.vehicleTypeId);
        const options = await this.candidates(tx, ctx);
        const mine =
          options.find((o) => o.carrier.id === carrier.id)?.quote ??
          (await this.quote(tx, ctx, carrier.id));
        const amount = cost ?? mine.total;
        if (amount === null)
          throw field422(
            'cost',
            'cost_required',
            'no applicable buy rate card for this carrier — enter the agreed cost',
            `ไม่มี rate card ขาซื้อของ ${carrier.legalName} สำหรับงานนี้ — กรอกราคาซื้อเอง`,
          );
        const buy = decimalFromSatang(satangFromDecimal(amount));
        const priced = options.filter((o) => o.quote.total !== null);
        const decision = decideSelection(
          buy,
          options.map((o) => ({ carrierId: o.carrier.id, amount: o.quote.total })),
        );
        if (decision.reasonRequired && [...typed].length < SELECTION_REASON_MIN_LENGTH)
          throw field422(
            'selectionReason',
            'selection_reason_required',
            `selection reason (≥ ${SELECTION_REASON_MIN_LENGTH} characters) is required when not hiring the cheapest carrier`,
            decision.cheapestAmount === null
              ? 'ไม่มีราคาจาก rate card ขาซื้อให้เทียบ — ระบุเหตุผลที่เลือกรายนี้ (อย่างน้อย 10 ตัวอักษร)'
              : 'รายนี้ไม่ใช่ราคาถูกสุด — ระบุเหตุผลที่เลือก (อย่างน้อย 10 ตัวอักษร)',
          );
        const kind: SelectionKind = decision.kind;
        const reason =
          kind === 'CHEAPEST'
            ? typed.length >= SELECTION_REASON_MIN_LENGTH
              ? typed
              : cheapestReasonTh(priced.length)
            : typed;
        // ตรงกับราคา rate card ของรายนี้ = RATE_CARD · แก้ราคา/ไม่มี rate card = MANUAL
        const priceSource =
          mine.total !== null && satangFromDecimal(mine.total) === satangFromDecimal(buy)
            ? 'RATE_CARD'
            : 'MANUAL';
        const comparison = {
          cheapestAmount: decision.cheapestAmount,
          cheapestCarrierIds: decision.cheapestCarrierIds,
          candidates: priced.map((o) => ({
            carrierId: o.carrier.id,
            code: o.carrier.code,
            name: o.carrier.legalName,
            amount: o.quote.total,
            rateCardCode: o.quote.rateCardCode,
          })),
        };
        // บรรทัดค่าจ้างของการจ้างครั้งก่อนที่จบไปแล้ว (ปฏิเสธ/หมดเวลา — ST3-T23/T24) และยังไม่จ่าย → กลับรายการ
        const reversed = await this.reversePriorFees(tx, trip.id, actor);
        const offer = await tx.subconOffer.create({
          data: {
            tenantId: trip.tenantId,
            tripId: trip.id,
            carrierId: carrier.id,
            carrierNameSnapshot: carrier.legalName,
            buyAmount: buy,
            priceSource,
            rateQuote: mine as unknown as Prisma.InputJsonValue,
            comparison: comparison as unknown as Prisma.InputJsonValue,
            selectionKind: kind,
            selectionReason: reason,
            vehicleTypeId: ctx.vehicleTypeId,
            sellAmount: ctx.sellAmount,
            offeredBy: actor,
          },
        });
        // ภาษีของบรรทัด = ธงที่คัดลอกจากรายการบริการค่าขนส่งของ rate card (ไม่ตัดสินเอง) · ไม่มี rate card = ว่าง [OPEN spec/12 §3]
        const vat =
          mine.vatType && mine.whtRate
            ? decimalFromSatang(
                computeDocumentTax([
                  {
                    amount: satangFromDecimal(buy),
                    vatType: toCalcVatType(mine.vatType),
                    whtRate: toCalcWhtRate(mine.whtRate),
                  },
                ]).vat,
              )
            : '0.00';
        await tx.tripCost.create({
          data: {
            tenantId: trip.tenantId,
            tripId: trip.id,
            costType: 'CARRIER_FEE',
            amount: buy,
            vatAmount: vat,
            source: priceSource,
            carrierId: carrier.id,
            serviceItemId: mine.serviceItemId,
            vatType: mine.vatType,
            whtRate: mine.whtRate,
            description: 'ค่าจ้างรถร่วม',
            subconOfferId: offer.id,
            createdBy: actor,
          },
        });
        return {
          trip: {
            vehicleTypeId: ctx.vehicleTypeId,
            vehicleTypeSnapshot: ctx.vehicleTypeName,
            buyRateSnapshot: {
              subconOfferId: offer.id,
              buyAmount: buy,
              priceSource,
              rateCardId: mine.rateCardId,
              rateCardCode: mine.rateCardCode,
              revision: mine.revision,
              quoteTotal: mine.total,
              vatType: mine.vatType,
              whtRate: mine.whtRate,
            },
          },
          audit: {
            buyAmount: buy,
            priceSource,
            rateCardCode: mine.rateCardCode,
            selectionKind: kind,
            selectionReason: reason,
            ...(reversed ? { reversedFees: reversed } : {}),
          },
          reason,
        };
      },
    );
  }

  /**
   * กลับรายการบรรทัด CARRIER_FEE ของการจ้างที่ปิดแล้ว (ไม่ใช่ OFFERED/ACCEPTED) ที่ยังไม่จ่ายและยังไม่ถูกกลับ —
   * ยอดติดลบ อ้าง `reversal_of_id` (ไม่ลบ/ไม่แก้ยอดเดิม) · ใช้ตอนจ้างใหม่ และ ST3-T25 เปลี่ยนรถร่วม
   */
  async reversePriorFees(tx: Tx, tripId: string, actor: string | null): Promise<number> {
    const rows = await tx.tripCost.findMany({
      where: {
        tripId,
        costType: 'CARRIER_FEE',
        amount: { gt: 0 },
        settlementLineId: null,
        reversedBy: null,
        OR: [
          { subconOfferId: null },
          { subconOffer: { status: { notIn: ['OFFERED', 'ACCEPTED'] } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const r of rows)
      await tx.tripCost.create({
        data: {
          tenantId: r.tenantId,
          tripId,
          costType: 'CARRIER_FEE',
          amount: r.amount.neg(),
          vatAmount: r.vatAmount.neg(),
          source: r.source,
          carrierId: r.carrierId,
          serviceItemId: r.serviceItemId,
          vatType: r.vatType,
          whtRate: r.whtRate,
          description: 'กลับรายการค่าจ้างรถร่วม (จ้างใหม่)',
          subconOfferId: r.subconOfferId,
          reversalOfId: r.id,
          createdBy: actor,
        },
      });
    return rows.length;
  }
}
