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
import { snapshotServiceItem, type ServiceItemSnapshot } from '../service-items/snapshot';

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
    const accessorials = (input.accessorials ?? []).map((a, i) => {
      const s = snap.get(a.serviceItemId);
      if (!s)
        throw field422(
          `accessorials[${i}].serviceItemId`,
          'service_item_not_found',
          'service item not found',
        );
      return { serviceItem: s, qty: a.qty };
    });

    // หน่วย + สินค้า (แปลงหน่วย)
    const qIn = input.quantities ?? [];
    const unitIds = [...qIn.map((x) => x.unitId), ...(rate?.unitId ? [rate.unitId] : [])];
    const productIds = qIn.flatMap((x) => (x.productId ? [x.productId] : []));
    const [units, products] = await Promise.all([
      unitIds.length
        ? tx.unit.findMany({ where: { id: { in: unitIds }, deletedAt: null } })
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
      if (!unit) throw field422(`quantities[${i}].unitId`, 'reference_not_found', 'unit not found');
      const product = x.productId ? productMap.get(x.productId) : null;
      if (x.productId && !product)
        throw field422(`quantities[${i}].productId`, 'reference_not_found', 'product not found');
      return { value: x.qty, unit, product };
    });

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
}
