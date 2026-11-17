import { Injectable } from '@nestjs/common';
import type { Prisma, RateSide, Unit } from '@prisma/client';
import {
  priceShipment,
  type PricingProduct,
  type PricingQuantity,
  type PricingRate,
  type PricingResult,
  type PricingUnit,
  type UnitKind,
} from '@tms/domain';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { RateCardsService } from '../rate-cards/rate-cards.service';
import { RoutesService } from '../routes/routes.service';
import type { ServiceItemSide } from '../service-items/service-item.dto';
import { RESERVED_SYSTEM_KEYS } from '../service-items/service-items.service';
import {
  sideAllows,
  snapshotServiceItem,
  type ServiceItemSnapshot,
} from '../service-items/snapshot';
import { isRealDate } from '../vehicle-documents/expiry';

/** คำขอคิดราคา — id ทั้งหมดเป็น uuid (ไม่ใช่ public id) */
export interface QuoteInput {
  side: RateSide;
  /** ลูกค้า (SELL) หรือรถร่วม (BUY) */
  partyId: string;
  originSiteId: string;
  destSiteId: string;
  vehicleTypeId: string;
  /** YYYY-MM-DD วันรับของ (MD-110) */
  date: string;
  /** จำนวนสินค้า (PER_TON/PER_CBM/PER_UNIT) — `productId` ใส่เมื่อต้องแปลงหน่วยผ่านข้อมูลสินค้า */
  quantities?: { qty: string; unitId: string; productId?: string | null }[];
  /** จำนวนจุดทั้งหมด (รับ + ส่ง) */
  stops?: number | null;
  /** ค่าบริการเสริมที่เกิดกับงาน */
  accessorials?: { serviceItemId: string; qty: string }[];
}

export type Quote = PricingResult<ServiceItemSnapshot> & {
  /** เส้นทางที่ใช้ระยะทาง (null = ไม่มีเส้นทางที่ใช้งาน) */
  routeId: string | null;
};

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/** Decimal → สตริงทศนิยม (ไม่ใช้รูป exponent) */
const dec = (d: Prisma.Decimal | null | undefined) =>
  d === null || d === undefined ? null : d.toFixed();

const unitOf = (u: Unit): PricingUnit => ({
  id: u.id,
  code: u.code,
  kind: u.kind as UnitKind,
  toKg: dec(u.toKg),
  toCbm: dec(u.toCbm),
});

/**
 * ตัวห่อบาง ๆ ของ pricing engine (ST2-T15 — `priceShipment` ใน @tms/domain) สำหรับโมดูลเอกสาร:
 * ST3 บรรทัดรายได้ของ order (`pricingStatus`), ST3-T22/ST6 cost line ขาซื้อ
 * หา rate (`findApplicableRate`) → ระยะทาง (`getRouteDistance`) → หน่วย/สินค้า/รายการบริการ (snapshot) → engine
 * - **ไม่มี endpoint** ในงานนี้ (backlog ไม่ได้กำหนด — API-first: ไม่เปิด endpoint ที่ UI ใช้ลับ ๆ)
 * - ไม่เขียนฐานข้อมูล · `tx` ต้องเป็น transaction ที่ตั้ง tenant แล้ว (ค่าเริ่มต้น = ของ request; นอก request ใช้ `withTenant`)
 * - อ้างอิงที่ไม่พบ (หน่วย/สินค้า/รายการบริการ) = ข้อผิดพลาดของผู้เรียก → 422 · ข้อมูลไม่พอคิดราคา = `CALCULATION_FAILURE`
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly db: DbService,
    private readonly rateCards: RateCardsService,
    private readonly routes: RoutesService,
  ) {}

  async quote(input: QuoteInput, tx: Tx = this.db.tx): Promise<Quote> {
    if (typeof input.date !== 'string' || !isRealDate(input.date))
      throw field422('date', 'invalid_date', 'date must be YYYY-MM-DD');
    const rate = await this.rateCards.findApplicableRate(
      {
        side: input.side,
        partyId: input.partyId,
        originSiteId: input.originSiteId,
        destSiteId: input.destSiteId,
        vehicleTypeId: input.vehicleTypeId,
        date: input.date,
      },
      tx,
    );
    const route = await this.routes.getRouteDistance(input.originSiteId, input.destSiteId, tx);

    // รายการบริการ: ค่าขนส่งของ rate + EXTRA_STOP (รายการสงวน — ลบ/ปิดใช้ไม่ได้) + ค่าบริการเสริมที่ขอ
    const accIds = (input.accessorials ?? []).map((a) => a.serviceItemId);
    const items = await tx.serviceItem.findMany({
      where: {
        deletedAt: null,
        OR: [
          { id: { in: [...accIds, ...(rate ? [rate.serviceItemId] : [])] } },
          { systemKey: 'EXTRA_STOP' },
        ],
      },
    });
    const snap = new Map(items.map((s) => [s.id, snapshotServiceItem(s)]));
    // ค่าบริการเสริม: สัญญาเดียวกับ ServiceItemsService.snapshotFor — ใช้งานอยู่ + ใช้กับฝั่งนี้ได้ + ไม่ใช่รายการสงวน
    const accessorials = (input.accessorials ?? []).map((a, i) => {
      const field = `accessorials[${i}].serviceItemId`;
      const row = items.find((x) => x.id === a.serviceItemId);
      if (!row) throw field422(field, 'service_item_not_found', 'service item not found');
      if (row.status !== 'ACTIVE')
        throw field422(field, 'service_item_inactive', `service item ${row.code} is inactive`);
      if (!sideAllows(row.side as ServiceItemSide, input.side))
        throw field422(
          field,
          'service_item_side',
          `service item ${row.code} is for ${row.side} documents only`,
        );
      if (row.systemKey && (RESERVED_SYSTEM_KEYS as readonly string[]).includes(row.systemKey))
        throw field422(
          field,
          'service_item_reserved',
          `service item ${row.code} is priced by the rate card, not as an accessorial`,
        );
      return { serviceItem: snap.get(row.id)!, qty: a.qty };
    });

    const { quantities, unitMap } = await this.loadQuantities(
      input.quantities ?? [],
      rate?.unitId ?? null,
      tx,
    );

    const extraStop = items.find((s) => s.systemKey === 'EXTRA_STOP');
    let engineRate: PricingRate<ServiceItemSnapshot> | null = null;
    if (rate) {
      const freight = snap.get(rate.serviceItemId);
      // FK service_item_id → แถวมีเสมอ (ลบแบบ soft แล้วก็ยังอ่านได้ — ใช้ค่าตามที่ rate อ้าง)
      const freightSnap =
        freight ??
        snapshotServiceItem(
          await tx.serviceItem.findUniqueOrThrow({ where: { id: rate.serviceItemId } }),
        );
      // FSC (P1) ยังไม่คิด — อ่านเพื่อเตือนเท่านั้น (ApplicableRate ของ T13 ไม่มีช่องนี้)
      const fsc = await tx.rateCard.findUnique({
        where: { id: rate.id },
        select: { fuelSurchargePct: true },
      });
      engineRate = {
        rateCardId: rate.id,
        code: rate.code,
        revision: rate.revision,
        pricingModel: rate.pricingModel,
        unitPrice: rate.unitPrice.toFixed(2),
        minCharge: rate.minCharge?.toFixed(2) ?? null,
        extraStopPrice: rate.extraStopPrice?.toFixed(2) ?? null,
        includedStops: rate.includedStops,
        unit: rate.unitId ? (unitMap.get(rate.unitId) ?? null) : null,
        serviceItem: freightSnap,
        extraStopItem: extraStop ? snap.get(extraStop.id)! : null,
        fuelSurchargePct: dec(fsc?.fuelSurchargePct),
        accessorials: rate.accessorials.map((a) => ({
          serviceItemId: a.serviceItemId,
          price: a.price.toFixed(2),
        })),
      };
    }

    const result = priceShipment(engineRate, {
      distanceKm: route ? route.distanceKm.toFixed() : null,
      quantities,
      stops: input.stops ?? null,
      accessorials,
    });
    return { ...result, routeId: route?.routeId ?? null };
  }

  /** หน่วย + สินค้า (แปลงหน่วย) ของจำนวนที่ส่งมา — หน่วยของ rate อ่านแม้ถูกลบแบบ soft · หน่วย/สินค้าของงานต้องยังไม่ถูกลบ (422) */
  private async loadQuantities(
    list: NonNullable<QuoteInput['quantities']>,
    rateUnitId: string | null,
    tx: Tx,
  ): Promise<{ quantities: PricingQuantity[]; unitMap: Map<string, PricingUnit> }> {
    // หน่วย + สินค้า (แปลงหน่วย)
    const qIn = list;
    const unitIds = [...qIn.map((x) => x.unitId), ...(rateUnitId ? [rateUnitId] : [])];
    const productIds = qIn.flatMap((x) => (x.productId ? [x.productId] : []));
    // หน่วยของ rate อ่านแม้ถูกลบแบบ soft (ใช้ตามที่ rate อ้าง) · หน่วยของงานต้องยังไม่ถูกลบ
    const [units, products] = await Promise.all([
      unitIds.length
        ? tx.unit.findMany({
            where: {
              id: { in: unitIds },
              OR: [{ deletedAt: null }, ...(rateUnitId ? [{ id: rateUnitId }] : [])],
            },
          })
        : Promise.resolve([]),
      productIds.length
        ? tx.product.findMany({
            where: { id: { in: productIds }, deletedAt: null },
            include: { baseUnit: true, altUnits: true },
          })
        : Promise.resolve([]),
    ]);
    const unitMap = new Map(units.map((u) => [u.id, unitOf(u)]));
    const productMap = new Map(
      products.map((p): [string, PricingProduct] => [
        p.id,
        {
          baseUnit: unitOf(p.baseUnit),
          weightPerUnitKg: dec(p.weightPerUnitKg),
          volumePerUnitCbm: dec(p.volumePerUnitCbm),
          altUnits: p.altUnits.map((a) => ({
            unitId: a.unitId,
            factorToBase: a.factorToBase.toFixed(),
          })),
        },
      ]),
    );
    const quantities: PricingQuantity[] = qIn.map((x, i) => {
      const unit = unitMap.get(x.unitId);
      const live = units.find((u) => u.id === x.unitId)?.deletedAt === null;
      if (!unit || !live)
        throw field422(`quantities[${i}].unitId`, 'reference_not_found', 'unit not found');
      const product = x.productId ? productMap.get(x.productId) : null;
      if (x.productId && !product)
        throw field422(`quantities[${i}].productId`, 'reference_not_found', 'product not found');
      return { value: x.qty, unit, product };
    });

    return { quantities, unitMap };
  }

  /**
   * ST4-T10 วางบิลตามยอดส่งจริง: คิดบรรทัดค่าขนส่งใหม่ด้วย **engine เดิม** จาก rate card ฉบับที่บรรทัดอ้าง
   * (ฉบับที่อนุมัติแล้วแก้ไม่ได้ — ได้ผลเดิมทุกครั้ง) + ราคาต่อหน่วย/รายการบริการตาม snapshot ของบรรทัด (vat_type/wht_rate ไม่เปลี่ยน)
   * ไม่คิดค่าจุดเพิ่ม/ค่าบริการเสริม (ไม่ขึ้นกับจำนวนสินค้า — ผู้เรียกคงบรรทัดเดิม) · ไม่เขียนฐานข้อมูล
   */
  async repriceFreight(
    input: {
      rateCardId: string;
      unitPrice: string;
      serviceItem: ServiceItemSnapshot;
      quantities: NonNullable<QuoteInput['quantities']>;
    },
    tx: Tx = this.db.tx,
  ): Promise<PricingResult<ServiceItemSnapshot>> {
    const rc = await tx.rateCard.findUniqueOrThrow({
      where: { id: input.rateCardId },
      select: {
        id: true,
        code: true,
        revision: true,
        pricingModel: true,
        minCharge: true,
        unitId: true,
        includedStops: true,
      },
    });
    const { quantities, unitMap } = await this.loadQuantities(input.quantities, rc.unitId, tx);
    return priceShipment(
      {
        rateCardId: rc.id,
        code: rc.code,
        revision: rc.revision,
        pricingModel: rc.pricingModel,
        unitPrice: input.unitPrice,
        minCharge: rc.minCharge?.toFixed(2) ?? null,
        extraStopPrice: null,
        includedStops: rc.includedStops,
        unit: rc.unitId ? (unitMap.get(rc.unitId) ?? null) : null,
        serviceItem: input.serviceItem,
        extraStopItem: null,
        fuelSurchargePct: null,
        accessorials: [],
      },
      { quantities, stops: null, accessorials: [] },
    );
  }
}
