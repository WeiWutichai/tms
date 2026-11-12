import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type PricingModel,
  type RateCard,
  type RateSide,
  type RateStatus,
} from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { redactPrices } from '../../common/price-fields';
import { scopeAllows } from '@tms/domain';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import {
  emitMasterEvent,
  iEquals,
  likeEscape,
  lockKey,
  lockReferenced,
  masterKeyset,
  stableStringify,
  upsertByExternalId,
} from '../master/master-kit';
import { addDays, bangkokToday, daysBetween, isRealDate } from '../vehicle-documents/expiry';
import {
  NEAR_EXPIRY_DAYS,
  type CreateRateCardDto,
  type RateCardDto,
  type RateCardListQuery,
  type RateCardSummaryDto,
  type RateCardTermsDto,
  type RateServiceItemRefDto,
  type RateStatusKey,
  type ReviseRateCardDto,
  type UpdateRateCardDto,
  type UpsertRateCardDto,
} from './rate-card.dto';

const ENTITY = 'rate_card';
/** รหัสตามฝั่ง (spec/02 §5: RC-S-0001 ขาย / RC-B-0001 ซื้อ) */
const CODE_PREFIX: Record<RateSide, string> = { SELL: 'RC-S', BUY: 'RC-B' };
/** ค่าบริการเสริมที่กำหนดราคาเฉพาะ rate ไม่ได้: ค่าขนส่ง/ค่าจุดเพิ่ม (มีช่องของตัวเอง) และ FSC (P1) */
const NOT_ACCESSORIAL_KEYS = ['FREIGHT', 'EXTRA_STOP', 'FSC'];
/** ช่วงวันที่รับ (กันพิมพ์ปีผิด เช่น 0026 / ปี พ.ศ.) */
const MIN_DATE = '2000-01-01';
const MAX_DATE = '2100-12-31';

type RateEvent = 'approve' | 'cancel' | 'supersede' | 'restore';
/**
 * state machine ของ rate card (spec/02 §5 ข้อ 6 ย่อสำหรับเฟส 0 — plan/11 ข้อ 3 ใช้ชื่อ enum ของ docs/01)
 * เฟส 0: Admin อนุมัติร่างได้ทันที (docs/04 B "P0 ใช้ ACTIVE ทันทีโดย Admin") · ส่งขออนุมัติ (PENDING_APPROVAL) = P1
 * หมดอายุ = APPROVED ที่ valid_to < วันนี้ (คำนวณ ไม่ใช่ transition)
 */
export const RATE_CARD_TRANSITIONS: TransitionTable<RateStatus, RateEvent> = {
  DRAFT: { approve: 'APPROVED' },
  PENDING_APPROVAL: { approve: 'APPROVED', cancel: 'RETIRED' },
  APPROVED: { cancel: 'RETIRED', supersede: 'RETIRED' },
  /** ยกเลิกฉบับแก้ไขที่แทนทั้งช่วง → ฉบับเดิมกลับมาใช้ (ระบบทำ — cancel) */
  RETIRED: { restore: 'APPROVED' },
};

const INCLUDE = {
  customer: { select: { id: true, code: true, legalName: true, status: true } },
  carrier: { select: { id: true, code: true, legalName: true, status: true } },
  origin: { select: { id: true, code: true, name: true, status: true } },
  dest: { select: { id: true, code: true, name: true, status: true } },
  vehicleType: { select: { id: true, code: true, nameTh: true, status: true } },
  unit: { select: { id: true, code: true, nameTh: true } },
  serviceItem: true,
  accessorials: { include: { serviceItem: true }, orderBy: { serviceItemId: 'asc' as const } },
} satisfies Prisma.RateCardInclude;

export type RateRow = Prisma.RateCardGetPayload<{ include: typeof INCLUDE }>;

/** rate ที่ใช้ได้ ณ วันหนึ่ง — สำหรับ pricing engine (ST2-T15) · เงินเป็น Prisma.Decimal (ห้ามแปลงเป็น float) */
export interface ApplicableRate {
  id: string;
  code: string;
  revision: number;
  side: RateSide;
  pricingModel: PricingModel;
  unitPrice: Prisma.Decimal;
  unitId: string | null;
  minCharge: Prisma.Decimal | null;
  extraStopPrice: Prisma.Decimal | null;
  includedStops: number;
  serviceItemId: string;
  validFrom: string;
  validTo: string | null;
  accessorials: { serviceItemId: string; price: Prisma.Decimal }[];
}

export interface RateLookup {
  side: RateSide;
  /** uuid ของลูกค้า (SELL) หรือรถร่วม (BUY) */
  partyId: string;
  originSiteId: string;
  destSiteId: string;
  vehicleTypeId: string;
  /** YYYY-MM-DD (วันรับของ — MD-110) */
  date: string;
}

/** ค่าที่ใช้บันทึก (หลังรวม input กับค่าเดิม) — id เป็น uuid, เงินเป็นสตริง */
interface Resolved {
  side: RateSide;
  customerId: string | null;
  carrierId: string | null;
  originSiteId: string | null;
  destSiteId: string | null;
  vehicleTypeId: string | null;
  pricingModel: PricingModel | null;
  unitId: string | null;
  unitPrice: string | null;
  minCharge: string | null;
  extraStopPrice: string | null;
  includedStops: number;
  serviceItemId: string | null;
  validFrom: string | null;
  validTo: string | null;
  notes: string | null;
  accessorials: { serviceItemId: string; price: string }[];
}
type Complete = {
  [K in keyof Resolved]: K extends
    'customerId' | 'carrierId' | 'unitId' | 'minCharge' | 'extraStopPrice' | 'validTo' | 'notes'
    ? Resolved[K]
    : NonNullable<Resolved[K]>;
};

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);
const conflict = (field: string, code: string, message: string, extra?: Record<string, unknown>) =>
  new ProblemException('conflict', message, [{ field, code, message }], extra);

const day = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));
/** เงินจาก input → รูปแบบเดียวกับที่ฐานคืน (เทียบ no-op ได้) */
const normMoney = (s: string | null) => (s === null ? null : new Prisma.Decimal(s).toFixed(2));
const st = (s: string) => s.toLowerCase() as 'active' | 'inactive';

/** ชื่อ field ราคาตามฝั่ง — ขาขาย `sell*` / ขาซื้อ `buy*` (ตัดตามสิทธิ์ `prices.{sell|buy}:read` ที่ serializer) */
const PX = {
  SELL: { rate: 'sellRate', min: 'sellMinCharge', ex: 'sellExtraStopRate', acc: 'sellPrice' },
  BUY: { rate: 'buyRate', min: 'buyMinCharge', ex: 'buyExtraStopRate', acc: 'buyPrice' },
} as const satisfies Record<RateSide, Record<string, string>>;
const other = (side: RateSide): RateSide => (side === 'SELL' ? 'BUY' : 'SELL');

/**
 * สิทธิ์เขียน/อนุมัติ rate ตามฝั่ง: ขาขาย `prices.sell:write` · ขาซื้อ `prices.buy:write` (ST2-T14)
 * route ประกาศ scope ใดก็ได้ของสองตัวนี้ — ฝั่งจริงรู้จาก body (สร้าง) หรือแถว (ที่เหลือ) จึงตรวจที่นี่ → 403
 */
export function assertSideWrite(side: RateSide) {
  const scope = side === 'SELL' ? 'prices.sell:write' : 'prices.buy:write';
  if (!scopeAllows(requestContext.require().scopes ?? [], scope))
    throw new ProblemException('permission_denied', undefined, undefined, {
      module: scope.split(':')[0],
      action: 'write',
      required: [scope],
    });
}

/** สถานะที่แสดง — APPROVED พ้นวันหมด (เวลาไทย) = expired */
export function rateStatus(r: Pick<RateCard, 'status' | 'validTo'>, today: string): RateStatusKey {
  if (r.status === 'DRAFT') return 'draft';
  if (r.status === 'PENDING_APPROVAL') return 'pending_approval';
  if (r.status === 'RETIRED') return 'retired';
  return r.validTo && day(r.validTo) < today ? 'expired' : 'active';
}

const svcRef = (s: RateRow['serviceItem']): RateServiceItemRefDto => ({
  id: encodeId('serviceItem', s.id),
  code: s.code,
  name: s.nameTh,
  unitLabel: s.unitLabel,
  calcUnit: s.calcUnit,
  vatType: s.vatType,
  whtRate: s.whtRate.toFixed(2),
});

export function toRateCardDto(r: RateRow, today = bangkokToday()): RateCardDto {
  const status = rateStatus(r, today);
  const daysToExpiry = r.validTo ? daysBetween(today, day(r.validTo)) : null;
  // ราคาใช้ชื่อตามฝั่ง sell* / buy* (ตัดตามสิทธิ์ที่ serializer — common/price-fields)
  const px = PX[r.side];
  const party = (p: RateRow['customer'] | RateRow['carrier'], kind: 'customer' | 'carrier') =>
    p ? { id: encodeId(kind, p.id), code: p.code, name: p.legalName, status: st(p.status) } : null;
  return {
    id: encodeId('rateCard', r.id),
    code: r.code,
    revision: r.revision,
    parentId: r.parentId ? encodeId('rateCard', r.parentId) : null,
    side: r.side,
    customer: party(r.customer, 'customer'),
    carrier: party(r.carrier, 'carrier'),
    origin: {
      id: encodeId('site', r.origin!.id),
      code: r.origin!.code,
      name: r.origin!.name,
      status: st(r.origin!.status),
    },
    destination: {
      id: encodeId('site', r.dest!.id),
      code: r.dest!.code,
      name: r.dest!.name,
      status: st(r.dest!.status),
    },
    vehicleType: {
      id: encodeId('vehicleType', r.vehicleType.id),
      code: r.vehicleType.code,
      name: r.vehicleType.nameTh,
      status: st(r.vehicleType.status),
    },
    pricingModel: r.pricingModel,
    unit: r.unit
      ? { id: encodeId('unit', r.unit.id), code: r.unit.code, name: r.unit.nameTh }
      : null,
    [px.rate]: r.unitPrice.toFixed(2),
    [px.min]: money(r.minCharge),
    [px.ex]: money(r.extraStopPrice),
    includedStops: r.includedStops,
    serviceItem: svcRef(r.serviceItem),
    accessorials: r.accessorials.map((a) => ({
      serviceItem: svcRef(a.serviceItem),
      [px.acc]: a.price.toFixed(2),
    })),
    validFrom: day(r.validFrom),
    validTo: r.validTo ? day(r.validTo) : null,
    status,
    nearExpiry: status === 'active' && daysToExpiry !== null && daysToExpiry <= NEAR_EXPIRY_DAYS,
    daysToExpiry,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    notes: r.notes,
    externalId: r.externalId,
    ...(r.deletedAt ? { deletedAt: r.deletedAt.toISOString() } : {}),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  } as RateCardDto;
}

/**
 * snapshot ของ domain event — ตัดราคา (sell…, buy…) ออกเสมอ: event ถูกส่งต่อ webhook/outbox ที่ไม่ผ่านตัวตัดราคาของ response
 * (common/price-fields ข้อ 3) · ผู้รับที่มีสิทธิ์ดึงราคาจาก `GET /v1/rate-cards/{id}`
 */
export function eventView(r: RateRow): Record<string, unknown> {
  return redactPrices(toRateCardDto(r), []) as Record<string, unknown>;
}

/**
 * snapshot สำหรับ audit — อ้างด้วย id (ชื่อลูกค้า/สถานที่เปลี่ยนได้ ไม่นับเป็น diff) · สถานะในฐาน (ไม่ใช่ที่คำนวณจากวันที่)
 * เงินใช้ชื่อ sell* / buy* ตามฝั่ง → ประวัติถูกตัดราคาตามสิทธิ์เหมือน response (PriceFieldInterceptor เดิน before/after)
 */
function auditView(r: RateRow): Record<string, unknown> {
  const px = PX[r.side];
  return {
    code: r.code,
    revision: r.revision,
    side: r.side,
    customerId: r.customerId ? encodeId('customer', r.customerId) : null,
    carrierId: r.carrierId ? encodeId('carrier', r.carrierId) : null,
    originId: r.originSiteId ? encodeId('site', r.originSiteId) : null,
    destinationId: r.destSiteId ? encodeId('site', r.destSiteId) : null,
    vehicleTypeId: encodeId('vehicleType', r.vehicleTypeId),
    pricingModel: r.pricingModel,
    unitId: r.unitId ? encodeId('unit', r.unitId) : null,
    [px.rate]: r.unitPrice.toFixed(2),
    [px.min]: money(r.minCharge),
    [px.ex]: money(r.extraStopPrice),
    includedStops: r.includedStops,
    serviceItemId: encodeId('serviceItem', r.serviceItemId),
    accessorials: r.accessorials.map((a) => ({
      serviceItemId: encodeId('serviceItem', a.serviceItemId),
      [px.acc]: a.price.toFixed(2),
    })),
    validFrom: day(r.validFrom),
    validTo: r.validTo ? day(r.validTo) : null,
    status: r.status,
    notes: r.notes,
    externalId: r.externalId,
  };
}

function fromRow(r: RateRow): Resolved {
  return {
    side: r.side,
    customerId: r.customerId,
    carrierId: r.carrierId,
    originSiteId: r.originSiteId,
    destSiteId: r.destSiteId,
    vehicleTypeId: r.vehicleTypeId,
    pricingModel: r.pricingModel,
    unitId: r.unitId,
    unitPrice: r.unitPrice.toFixed(2),
    minCharge: money(r.minCharge),
    extraStopPrice: money(r.extraStopPrice),
    includedStops: r.includedStops,
    serviceItemId: r.serviceItemId,
    validFrom: day(r.validFrom),
    validTo: r.validTo ? day(r.validTo) : null,
    notes: r.notes,
    accessorials: r.accessorials.map((a) => ({
      serviceItemId: a.serviceItemId,
      price: a.price.toFixed(2),
    })),
  };
}

/** id จาก API → uuid · รูปแบบถูกแต่ prefix/ฐานไม่พบ → 422 `reference_not_found` */
function ref(kind: Parameters<typeof tryDecodeId>[0], value: string, field: string): string {
  const id = tryDecodeId(kind, value);
  if (!id) throw field422(field, 'reference_not_found', `${field} not found`);
  return id;
}

type TermsInput = RateCardTermsDto & Partial<UpdateRateCardDto>;

/**
 * ส่งข้อมูลของอีกฝั่งมา (ลูกค้าใน rate ขาซื้อ, รถร่วมใน rate ขาขาย, ราคา sell* ใน rate ขาซื้อ …) → 422 `wrong_side`
 * (ไม่เงียบทิ้ง — ผู้เรียกจะเข้าใจผิดว่าบันทึกแล้ว)
 */
function assertSideFields(side: RateSide, input: TermsInput) {
  const o = PX[other(side)];
  const wrong: string[] = [
    ...(side === 'SELL' ? ['carrierId'] : ['customerId']),
    o.rate,
    o.min,
    o.ex,
  ];
  const rec = input as Record<string, unknown>;
  for (const f of wrong)
    if (rec[f] !== undefined)
      throw field422(f, 'wrong_side', `${f} does not apply to a ${side} rate`);
  input.accessorials?.forEach((a, i) => {
    if ((a as unknown as Record<string, unknown>)[o.acc] !== undefined)
      throw field422(
        `accessorials.${i}.${o.acc}`,
        'wrong_side',
        `${o.acc} does not apply to a ${side} rate`,
      );
  });
}

/** รวม input เข้ากับค่าเดิม (undefined = คงเดิม, null = ล้าง) */
function merge(base: Resolved, input: TermsInput): Resolved {
  assertSideFields(base.side, input);
  const px = PX[base.side];
  const rec = input as Record<string, string | null | undefined>;
  const out: Resolved = { ...base, accessorials: [...base.accessorials] };
  if (input.customerId !== undefined)
    out.customerId = ref('customer', input.customerId, 'customerId');
  if (input.carrierId !== undefined) out.carrierId = ref('carrier', input.carrierId, 'carrierId');
  if (input.originId !== undefined) out.originSiteId = ref('site', input.originId, 'originId');
  if (input.destinationId !== undefined)
    out.destSiteId = ref('site', input.destinationId, 'destinationId');
  if (input.vehicleTypeId !== undefined)
    out.vehicleTypeId = ref('vehicleType', input.vehicleTypeId, 'vehicleTypeId');
  if (input.serviceItemId !== undefined)
    out.serviceItemId = ref('serviceItem', input.serviceItemId, 'serviceItemId');
  if (input.pricingModel !== undefined) {
    out.pricingModel = input.pricingModel;
    // เปลี่ยนสูตรเป็นอย่างอื่นที่ไม่ใช่ต่อหน่วยนับ → หน่วยเดิมไม่ใช้แล้ว (ไม่ต้องให้ client ส่ง null เอง)
    if (input.pricingModel !== 'PER_UNIT' && input.unitId === undefined) out.unitId = null;
  }
  if (input.unitId !== undefined)
    out.unitId = input.unitId === null ? null : ref('unit', input.unitId, 'unitId');
  if (rec[px.rate] !== undefined) out.unitPrice = normMoney(rec[px.rate]!);
  if (rec[px.min] !== undefined) out.minCharge = normMoney(rec[px.min]!);
  if (rec[px.ex] !== undefined) out.extraStopPrice = normMoney(rec[px.ex]!);
  if (input.includedStops !== undefined) out.includedStops = input.includedStops;
  if (input.validFrom !== undefined) out.validFrom = input.validFrom;
  if (input.validTo !== undefined) out.validTo = input.validTo;
  if (input.notes !== undefined) out.notes = input.notes === '' ? null : input.notes;
  if (input.accessorials !== undefined)
    out.accessorials = input.accessorials
      .map((a, i) => {
        const price = (a as unknown as Record<string, string | undefined>)[px.acc];
        if (price === undefined)
          throw field422(`accessorials.${i}.${px.acc}`, 'required', `${px.acc} is required`);
        return {
          serviceItemId: ref('serviceItem', a.serviceItemId, `accessorials.${i}.serviceItemId`),
          price: normMoney(price)!,
        };
      })
      .sort((a, b) => a.serviceItemId.localeCompare(b.serviceItemId));
  return out;
}

/** ตรวจค่าที่ไม่ต้องอ่านฐาน: ช่องบังคับ, สูตร × หน่วย, วันที่, ค่าบริการเสริมซ้ำ */
function validateShape(r: Resolved): Complete {
  const required: [keyof Resolved, string][] = [
    ['originSiteId', 'originId'],
    ['destSiteId', 'destinationId'],
    ['vehicleTypeId', 'vehicleTypeId'],
    ['pricingModel', 'pricingModel'],
    ['unitPrice', PX[r.side].rate],
    ['validFrom', 'validFrom'],
    ['serviceItemId', 'serviceItemId'],
  ];
  required.unshift(r.side === 'SELL' ? ['customerId', 'customerId'] : ['carrierId', 'carrierId']);
  for (const [k, field] of required)
    if (r[k] === null || r[k] === undefined)
      throw field422(field, 'required', `${field} is required`);
  if (r.originSiteId === r.destSiteId)
    throw field422('destinationId', 'same_site', 'origin and destination must differ');
  if (r.pricingModel === 'PER_UNIT' && !r.unitId)
    throw field422('unitId', 'required', 'unitId is required for PER_UNIT');
  if (r.pricingModel !== 'PER_UNIT' && r.unitId)
    throw field422('unitId', 'not_applicable', 'unitId is only for PER_UNIT');
  for (const [k, v] of [
    ['validFrom', r.validFrom],
    ['validTo', r.validTo],
  ] as const)
    if (v !== null && (!isRealDate(v) || v < MIN_DATE || v > MAX_DATE))
      throw field422(
        k,
        'invalid_date',
        `${k} must be a real date between ${MIN_DATE} and ${MAX_DATE}`,
      );
  if (r.validTo !== null && r.validTo < r.validFrom!)
    throw field422('validTo', 'before_start', 'validTo must be on or after validFrom');
  const seen = new Set<string>();
  r.accessorials.forEach((a, i) => {
    if (seen.has(a.serviceItemId))
      throw field422(`accessorials.${i}.serviceItemId`, 'duplicate', 'service item listed twice');
    seen.add(a.serviceItemId);
  });
  return r as Complete;
}

/** ค่าเทียบ no-op (ทุกช่องที่บันทึก) */
const fingerprint = (r: Resolved) => stableStringify(r);

/**
 * Rate card (ST2-T13 ขาขาย — ST2-T14 ขาซื้อใช้ service นี้ด้วย `side = BUY`)
 * docs/04 B Rate card + B1, docs/01 §3.2, spec/02 §5 (MD-110–123 ส่วนที่เป็นเฟส 0)
 * - key = ฝั่ง + ลูกค้า + ต้นทาง + ปลายทาง + ประเภทรถ (สถานที่เท่านั้น — โซน P1/เฟส 2)
 * - ช่วงวันใน key เดียวกันห้ามทับ → 422 `overlap` (ร่างตรวจกับทุกรายการที่ยังไม่ยกเลิก ยกเว้นฉบับเดิมของตัวเอง;
 *   ตอนอนุมัติตรวจกับรายการที่ใช้งาน + exclusion constraint ในฐานข้อมูล) — ล็อก advisory ต่อ key กันคำขอพร้อมกัน
 * - ร่างแก้ได้ · อนุมัติแล้วแก้ตรงไม่ได้ → ออกฉบับแก้ไข (MD-118) เมื่ออนุมัติฉบับใหม่ ฉบับเดิมสิ้นสุดวันก่อนหน้า (หรือถูกแทนทั้งช่วง)
 * - หมดอายุคำนวณจากวันที่ (ไม่รอ job) · `findApplicableRate()` = จุดที่ pricing (ST2-T15) เรียก
 */
@Injectable()
export class RateCardsService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  // ---------- read ----------

  private statusWhere(keys: RateStatusKey[], today: Date): Prisma.RateCardWhereInput {
    const or: Prisma.RateCardWhereInput[] = [];
    for (const k of keys) {
      if (k === 'draft') or.push({ status: 'DRAFT' });
      if (k === 'pending_approval') or.push({ status: 'PENDING_APPROVAL' });
      if (k === 'retired') or.push({ status: 'RETIRED' });
      if (k === 'active')
        or.push({ status: 'APPROVED', OR: [{ validTo: null }, { validTo: { gte: today } }] });
      if (k === 'expired') or.push({ status: 'APPROVED', validTo: { lt: today } });
    }
    return { OR: or };
  }

  private nearExpiryWhere(today: string): Prisma.RateCardWhereInput {
    return {
      status: 'APPROVED',
      validTo: { gte: toDate(today), lte: toDate(addDays(today, NEAR_EXPIRY_DAYS)) },
    };
  }

  private where(q: RateCardListQuery): Prisma.RateCardWhereInput {
    const today = bangkokToday();
    const and: Prisma.RateCardWhereInput[] = [{ side: q.side ?? 'SELL' }];
    if (q.includeDeleted !== 'true') and.push({ deletedAt: null });
    if (q.status) and.push(this.statusWhere(q.status.split(',') as RateStatusKey[], toDate(today)));
    if (q.nearExpiry === 'true') and.push(this.nearExpiryWhere(today));
    if (q.nearExpiry === 'false') and.push({ NOT: this.nearExpiryWhere(today) });
    if (q.externalId) and.push({ externalId: q.externalId });
    // id ที่ผ่าน regex แล้ว decode ได้เสมอ
    if (q.customerId) and.push({ customerId: tryDecodeId('customer', q.customerId)! });
    if (q.carrierId) and.push({ carrierId: tryDecodeId('carrier', q.carrierId)! });
    if (q.originId) and.push({ originSiteId: tryDecodeId('site', q.originId)! });
    if (q.destinationId) and.push({ destSiteId: tryDecodeId('site', q.destinationId)! });
    if (q.vehicleTypeId) and.push({ vehicleTypeId: tryDecodeId('vehicleType', q.vehicleTypeId)! });
    if (q.pricingModel) and.push({ pricingModel: q.pricingModel });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    const partyLike = (v: string): Prisma.RateCardWhereInput[] => [
      { customer: { legalName: like(v) } },
      { customer: { code: like(v) } },
      { carrier: { legalName: like(v) } },
      { carrier: { code: like(v) } },
    ];
    const siteLike = (v: string): Prisma.RateCardWhereInput[] => [
      { origin: { name: like(v) } },
      { origin: { code: like(v) } },
      { dest: { name: like(v) } },
      { dest: { code: like(v) } },
    ];
    if (q.party) and.push({ OR: partyLike(q.party) });
    if (q.route) and.push({ OR: siteLike(q.route) });
    if (q.q)
      and.push({
        OR: [{ code: like(q.q) }, { externalId: like(q.q) }, ...partyLike(q.q), ...siteLike(q.q)],
      });
    return { AND: and };
  }

  async list(q: RateCardListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.rateCard.findMany({
      where: { AND: [this.where(q), k.where] },
      // รหัสเดียวกันหลายฉบับ: ฉบับใหม่ก่อน (keyset ยังเสถียรด้วย id)
      orderBy: k.orderBy,
      take: k.take,
      include: INCLUDE,
    });
    const today = bangkokToday();
    return k.page(rows, (r) => toRateCardDto(r, today));
  }

  async exportRows(q: RateCardListQuery & { ids?: string }) {
    const ids = q.ids?.split(',').map((x) => tryDecodeId('rateCard', x)!);
    const where = ids ? { AND: [this.where(q), { id: { in: ids } }] } : this.where(q);
    const rows = await this.db.tx.rateCard.findMany({
      where,
      orderBy: [{ code: 'asc' }, { revision: 'asc' }],
      take: EXPORT_MAX_ROWS + 1,
      include: INCLUDE,
    });
    if (rows.length > EXPORT_MAX_ROWS)
      throw field422(
        'query',
        'too_many_rows',
        `export is limited to ${EXPORT_MAX_ROWS} rows — narrow the filter`,
      );
    const today = bangkokToday();
    return rows.map((r) => toRateCardDto(r, today));
  }

  async summary(
    side: RateSide = 'SELL',
    customerId?: string,
    carrierId?: string,
  ): Promise<RateCardSummaryDto> {
    const tx = this.db.tx;
    const today = bangkokToday();
    const base: Prisma.RateCardWhereInput = {
      side,
      deletedAt: null,
      ...(customerId ? { customerId: tryDecodeId('customer', customerId)! } : {}),
      ...(carrierId ? { carrierId: tryDecodeId('carrier', carrierId)! } : {}),
    };
    const g = await tx.rateCard.groupBy({ by: ['status'], where: base, _count: { _all: true } });
    const n = (s: RateStatus) => g.find((x) => x.status === s)?._count._all ?? 0;
    const [expired, nearExpiry] = await Promise.all([
      tx.rateCard.count({ where: { ...base, status: 'APPROVED', validTo: { lt: toDate(today) } } }),
      tx.rateCard.count({ where: { AND: [base, this.nearExpiryWhere(today)] } }),
    ]);
    return {
      total: g.reduce((a, x) => a + x._count._all, 0),
      draft: n('DRAFT'),
      pendingApproval: n('PENDING_APPROVAL'),
      active: n('APPROVED') - expired,
      nearExpiry,
      expired,
      retired: n('RETIRED'),
    };
  }

  async get(id: string): Promise<RateRow> {
    const r = await this.db.tx.rateCard.findFirst({
      where: { id, deletedAt: null },
      include: INCLUDE,
    });
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  async getByExternalId(externalId: string): Promise<RateRow> {
    const r = await this.db.tx.rateCard.findFirst({
      where: { externalId, deletedAt: null },
      include: INCLUDE,
    });
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  /**
   * rate ที่ใช้คิดราคาได้ ณ วันที่ (MD-110/111 ส่วนเฟส 0: ลูกค้า/รถร่วม + ต้นทาง + ปลายทาง + ประเภทรถตรงตัว)
   * เฉพาะที่อนุมัติแล้ว ไม่ถูกลบ และ validFrom ≤ date ≤ validTo — ร่าง/ยกเลิก/หมดอายุ ไม่ถูกเลือก (เกณฑ์ตรวจรับ ST2-T13)
   * ช่วงวันใน key เดียวกันทับกันไม่ได้ (exclusion constraint) จึงได้อย่างมาก 1 แถว — เรียงกันไว้ให้ผลคงที่เสมอ
   * ไม่พบ = null (pricing แสดง RATE_MISSING — ST2-T15)
   * **`tx` ต้องเป็น transaction ที่ตั้ง tenant แล้ว** (ค่าเริ่มต้น = transaction ของ request; นอก request ใช้ `DbService.withTenant()`)
   */
  async findApplicableRate(input: RateLookup, tx: Tx = this.db.tx): Promise<ApplicableRate | null> {
    if (!isRealDate(input.date)) throw new Error(`findApplicableRate: invalid date ${input.date}`);
    const d = toDate(input.date);
    const r = await tx.rateCard.findFirst({
      where: {
        side: input.side,
        ...(input.side === 'SELL' ? { customerId: input.partyId } : { carrierId: input.partyId }),
        originSiteId: input.originSiteId,
        destSiteId: input.destSiteId,
        vehicleTypeId: input.vehicleTypeId,
        status: 'APPROVED',
        deletedAt: null,
        validFrom: { lte: d },
        OR: [{ validTo: null }, { validTo: { gte: d } }],
      },
      orderBy: [{ validFrom: 'desc' }, { revision: 'desc' }, { id: 'asc' }],
      include: { accessorials: { orderBy: { serviceItemId: 'asc' } } },
    });
    if (!r) return null;
    return {
      id: r.id,
      code: r.code,
      revision: r.revision,
      side: r.side,
      pricingModel: r.pricingModel,
      unitPrice: r.unitPrice,
      unitId: r.unitId,
      minCharge: r.minCharge,
      extraStopPrice: r.extraStopPrice,
      includedStops: r.includedStops,
      serviceItemId: r.serviceItemId,
      validFrom: day(r.validFrom),
      validTo: r.validTo ? day(r.validTo) : null,
      accessorials: r.accessorials.map((a) => ({ serviceItemId: a.serviceItemId, price: a.price })),
    };
  }

  /**
   * ราคา 5 ครั้งล่าสุดที่จ้างรถร่วมรายนี้ (ST2-T14; docs/04 B "Rate card ขาซื้อ" + D2 PL4 "เลือก carrier + ราคาซื้อ")
   * "จ้างแล้ว" (review ST2-T14 — ST3-T22 ต้องเขียนข้อมูลให้ตรงกฎนี้): `trip.carrier_id` = รถร่วมรายนี้ · สถานะ ASSIGNED…SETTLED
   *   · `assignment_status` ว่างหรือ ACCEPTED (OFFERED/REJECTED/EXPIRED ไม่นับ) · `trip_date` ≤ วันนี้ (เวลาไทย)
   * ค่าจ้าง = ผลรวม `trip_cost` CARRIER_FEE ของเที่ยวนั้นที่ `carrier_id` ว่างหรือเท่ากับรถร่วมของเที่ยว (บรรทัดของรายอื่นไม่นับ)
   * ต้นทาง/ปลายทาง = จุดแรก/จุดสุดท้ายของเที่ยว
   * ประเภทรถกรองด้วยรถที่ใช้ (`vehicle.vehicle_type_id`) · แสดงชื่อจาก snapshot ตอนจ่ายงาน
   * rate card ที่ใช้ = `trip.buy_rate_snapshot.rateCardCode` (ST3 จ่ายงานต้องเขียนลง snapshot) · ยังไม่เคยจ้าง = []
   * เงินคืนเป็นสตริง (`buyAmount` ตัดตามสิทธิ์ `prices.buy:read` — route บังคับสิทธิ์นี้อยู่แล้ว)
   */
  async recentCarrierPrices(
    carrierId: string,
    q: { originId?: string; destinationId?: string; vehicleTypeId?: string },
  ) {
    const tx = this.db.tx;
    const carrier = await tx.carrier.findFirst({
      where: { id: carrierId, deletedAt: null },
      select: { id: true },
    });
    if (!carrier) throw new ProblemException('not_found');
    const origin = q.originId ? tryDecodeId('site', q.originId) : null;
    const dest = q.destinationId ? tryDecodeId('site', q.destinationId) : null;
    const vt = q.vehicleTypeId ? tryDecodeId('vehicleType', q.vehicleTypeId) : null;
    const rows = await tx.$queryRaw<
      {
        trip_id: string;
        trip_no: string | null;
        trip_date: Date;
        vehicle_type: string | null;
        rate_code: string | null;
        amount: Prisma.Decimal;
        o_id: string | null;
        o_code: string | null;
        o_name: string | null;
        d_id: string | null;
        d_code: string | null;
        d_name: string | null;
      }[]
    >`
      WITH hired AS (
        -- "จ้างแล้ว" = เที่ยวที่ผู้รับเหมารายนี้ถูกมอบงาน/รับงานจริง (ไม่นับข้อเสนอที่ยังรอ/ปฏิเสธ/หมดเวลา) และวันเที่ยวไม่เกินวันนี้
        SELECT t.id FROM trip t
         WHERE t.carrier_id = ${carrierId}::uuid
           AND t.status IN ('ASSIGNED', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'COSTED', 'SETTLED')
           AND (t.assignment_status IS NULL OR t.assignment_status = 'ACCEPTED')
           AND t.trip_date <= ${toDate(bangkokToday())}::date
      ), fee AS (
        -- ค่าจ้างของเที่ยว = CARRIER_FEE ที่ผูกผู้รับเหมาเดียวกับเที่ยว (บรรทัดที่ระบุผู้รับเหมาอื่นไม่นับ)
        SELECT tc.trip_id, sum(tc.amount) AS amount, max(tc.created_at) AS last_at
          FROM trip_cost tc JOIN hired h ON h.id = tc.trip_id
         WHERE tc.cost_type = 'CARRIER_FEE'
           AND (tc.carrier_id IS NULL OR tc.carrier_id = ${carrierId}::uuid)
         GROUP BY tc.trip_id
      ), ends AS (
        SELECT t.id AS trip_id,
          (SELECT s.site_id FROM trip_stop s WHERE s.trip_id = t.id ORDER BY s.sequence ASC LIMIT 1) AS o,
          (SELECT s.site_id FROM trip_stop s WHERE s.trip_id = t.id ORDER BY s.sequence DESC LIMIT 1) AS d
          FROM trip t WHERE t.id IN (SELECT trip_id FROM fee)
      )
      SELECT t.id::text AS trip_id, t.trip_no, t.trip_date, t.vehicle_type_snapshot AS vehicle_type,
             COALESCE(t.buy_rate_snapshot->>'rateCardCode', t.buy_rate_snapshot->>'code') AS rate_code,
             fee.amount,
             os.id::text AS o_id, os.code AS o_code, os.name AS o_name,
             ds.id::text AS d_id, ds.code AS d_code, ds.name AS d_name
        FROM fee
        JOIN trip t ON t.id = fee.trip_id
        JOIN ends e ON e.trip_id = t.id
        LEFT JOIN customer_site os ON os.id = e.o
        LEFT JOIN customer_site ds ON ds.id = e.d
        LEFT JOIN vehicle v ON v.id = t.vehicle_id
       WHERE (${origin}::uuid IS NULL OR e.o = ${origin}::uuid)
         AND (${dest}::uuid IS NULL OR e.d = ${dest}::uuid)
         AND (${vt}::uuid IS NULL OR v.vehicle_type_id = ${vt}::uuid)
       ORDER BY t.trip_date DESC, fee.last_at DESC, t.id
       LIMIT 5`;
    const site = (id: string | null, code: string | null, name: string | null) =>
      id ? { id: encodeId('site', id), code: code!, name: name! } : null;
    return rows.map((r) => ({
      tripId: encodeId('trip', r.trip_id),
      tripNo: r.trip_no,
      date: day(r.trip_date),
      origin: site(r.o_id, r.o_code, r.o_name),
      destination: site(r.d_id, r.d_code, r.d_name),
      vehicleType: r.vehicle_type,
      buyAmount: new Prisma.Decimal(r.amount).toFixed(2),
      rateCardCode: r.rate_code,
    }));
  }

  // ---------- write helpers ----------

  private keyOf(r: Complete): string {
    return `rate_card.key:${r.side}:${r.customerId ?? r.carrierId}:${r.originSiteId}:${r.destSiteId}:${r.vehicleTypeId}`;
  }

  /** ล็อก key (เรียงก่อน — ลำดับเดียวกันทุกคำขอ) */
  private async lockKeys(keys: string[]) {
    for (const k of [...new Set(keys)].sort()) await lockKey(this.db.tx, k);
  }

  /**
   * ล็อกข้อมูลหลักที่อ้าง (FOR SHARE — กันถูกลบระหว่างบันทึก) แล้วตรวจ: ไม่พบ/ข้าม tenant/ลบแล้ว → 422 `reference_not_found`
   * ปิดใช้ → 422 `<ชนิด>_inactive` · `only` = ตรวจเฉพาะช่องที่เปลี่ยน (ค่าเดิมที่ปิดใช้ภายหลังไม่ขวางการแก้ช่องอื่นของร่าง)
   */
  private async lockRefs(r: Complete, only?: Set<string>) {
    const tx = this.db.tx;
    const want = (f: string) => !only || only.has(f);
    const check = async (
      table: 'customer' | 'carrier' | 'customer_site' | 'vehicle_type' | 'unit',
      items: { id: string; field: string }[],
      inactiveCode: string,
    ) => {
      const list = items.filter((x) => want(x.field));
      if (!list.length) return;
      const rows = await lockReferenced(
        tx,
        table,
        list.map((x) => x.id),
      );
      for (const x of list) {
        const row = rows.find((y) => y.id === x.id);
        if (!row) throw field422(x.field, 'reference_not_found', `${x.field} not found`);
        if (row.status !== 'ACTIVE')
          throw field422(x.field, inactiveCode, `${x.field} is inactive`);
      }
    };
    if (r.customerId)
      await check('customer', [{ id: r.customerId, field: 'customerId' }], 'customer_inactive');
    // ขาซื้อ: รถร่วมที่ระงับชั่วคราว (INACTIVE) ทำ rate ใหม่/อนุมัติไม่ได้ → 422 `carrier_inactive`
    if (r.carrierId)
      await check('carrier', [{ id: r.carrierId, field: 'carrierId' }], 'carrier_inactive');
    await check(
      'customer_site',
      [
        { id: r.originSiteId, field: 'originId' },
        { id: r.destSiteId, field: 'destinationId' },
      ],
      'site_inactive',
    );
    // สถานที่ของลูกค้ารายอื่นใช้เป็นต้นทาง/ปลายทางไม่ได้ — ใช้ได้เฉพาะจุดของลูกค้ารายนี้หรือจุดของบริษัทเอง (คลัง ไม่มีลูกค้า)
    // spec/02 §2/§5 ไม่ระบุชัด → [DECISION — ย้อนได้ spec/12 §3] (review ST2-T13)
    // ขาซื้อ (ไม่มีลูกค้า): รถร่วมวิ่งไปจุดของลูกค้ารายใดก็ได้ → สถานที่ที่ใช้งานของบริษัททุกจุด [DECISION ST2-T14]
    if (r.customerId && (want('originId') || want('destinationId') || want('customerId'))) {
      const owners = await tx.customerSite.findMany({
        where: { id: { in: [r.originSiteId, r.destSiteId] } },
        select: { id: true, customerId: true },
      });
      for (const [id, field] of [
        [r.originSiteId, 'originId'],
        [r.destSiteId, 'destinationId'],
      ] as const) {
        const o = owners.find((x) => x.id === id);
        if (o?.customerId && o.customerId !== r.customerId)
          throw field422(field, 'site_other_customer', 'site belongs to another customer');
      }
    }
    await check(
      'vehicle_type',
      [{ id: r.vehicleTypeId, field: 'vehicleTypeId' }],
      'vehicle_type_inactive',
    );
    if (r.unitId) {
      await check('unit', [{ id: r.unitId, field: 'unitId' }], 'unit_inactive');
      if (want('unitId')) {
        const u = await tx.unit.findUnique({ where: { id: r.unitId }, select: { kind: true } });
        // ต่อตัน/ต่อ ลบ.ม. มีสูตรของตัวเอง — PER_UNIT ใช้หน่วยนับ (ชิ้น พาเลท …)
        if (u?.kind !== 'COUNT')
          throw field422(
            'unitId',
            'unit_kind',
            'PER_UNIT needs a count unit (use PER_TON / PER_CBM)',
          );
      }
    }
    // รายการบนเอกสาร + ค่าบริการเสริม: ใช้งาน · ฝั่งตรง (ขาย/ทั้งคู่) · ไม่ใช่ %/ตามจริงสำหรับค่าขนส่ง
    const svc = [
      ...(want('serviceItemId') ? [{ id: r.serviceItemId, field: 'serviceItemId' }] : []),
      ...(want('accessorials')
        ? r.accessorials.map((a, i) => ({
            id: a.serviceItemId,
            field: `accessorials.${i}.serviceItemId`,
          }))
        : []),
    ];
    if (!svc.length) return;
    await lockReferenced(
      tx,
      'service_item',
      svc.map((x) => x.id),
    );
    const items = await tx.serviceItem.findMany({
      where: { id: { in: svc.map((x) => x.id) }, deletedAt: null },
      select: { id: true, status: true, side: true, calcUnit: true, systemKey: true },
    });
    for (const x of svc) {
      const s = items.find((y) => y.id === x.id);
      if (!s) throw field422(x.field, 'reference_not_found', 'service item not found');
      if (s.status !== 'ACTIVE')
        throw field422(x.field, 'service_item_inactive', 'service item is inactive');
      if (s.side !== 'BOTH' && s.side !== r.side)
        throw field422(x.field, 'wrong_side', `service item is not for ${r.side}`);
      if (
        s.calcUnit === 'PERCENT_OF_FREIGHT' ||
        (s.systemKey && ['EXTRA_STOP', 'FSC'].includes(s.systemKey))
      )
        throw field422(x.field, 'not_applicable', 'service item cannot be priced on a rate card');
      if (x.field === 'serviceItemId' && s.calcUnit === 'ACTUAL')
        throw field422(x.field, 'not_applicable', 'freight item cannot be "actual"');
      if (x.field !== 'serviceItemId' && s.systemKey && NOT_ACCESSORIAL_KEYS.includes(s.systemKey))
        throw field422(x.field, 'not_applicable', 'freight item is not an accessorial');
      if (x.field !== 'serviceItemId' && s.id === r.serviceItemId)
        throw field422(x.field, 'not_applicable', 'freight item is not an accessorial');
    }
  }

  /**
   * เกณฑ์ตรวจรับ: ช่วงวันใน key เดียวกันทับกัน → 422 `overlap` พร้อมรายการที่ชน (ไม่มีราคาใน problem)
   * `withDrafts` = นับร่างด้วย (ตอนบันทึกร่าง) · ตอนอนุมัติ นับเฉพาะที่ใช้งาน
   * `except` = ตัวเอง + ฉบับเดิม (ฉบับแก้ไขทับฉบับเดิมได้ — ระบบปิดฉบับเดิมตอนอนุมัติ)
   */
  private async assertNoOverlap(r: Complete, except: (string | null)[], withDrafts: boolean) {
    const hits = await this.db.tx.rateCard.findMany({
      where: {
        side: r.side,
        customerId: r.customerId,
        carrierId: r.carrierId,
        originSiteId: r.originSiteId,
        destSiteId: r.destSiteId,
        vehicleTypeId: r.vehicleTypeId,
        deletedAt: null,
        status: {
          in: withDrafts
            ? ['DRAFT', 'PENDING_APPROVAL', 'APPROVED']
            : ['PENDING_APPROVAL', 'APPROVED'],
        },
        id: { notIn: except.filter((x): x is string => !!x) },
        ...(r.validTo ? { validFrom: { lte: toDate(r.validTo) } } : {}),
        OR: [{ validTo: null }, { validTo: { gte: toDate(r.validFrom) } }],
      },
      select: {
        id: true,
        code: true,
        revision: true,
        status: true,
        validFrom: true,
        validTo: true,
      },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    if (!hits.length) return;
    const today = bangkokToday();
    throw new ProblemException(
      'validation_failed',
      'rate period overlaps another rate with the same key',
      [
        {
          field: 'validFrom',
          code: 'overlap',
          message: `period overlaps ${hits.map((h) => h.code).join(', ')}`,
        },
      ],
      {
        conflicts: hits.map((h) => ({
          id: encodeId('rateCard', h.id),
          code: h.code,
          revision: h.revision,
          status: rateStatus(h, today),
          validFrom: day(h.validFrom),
          validTo: h.validTo ? day(h.validTo) : null,
        })),
      },
    );
  }

  /**
   * ช่วงวันของฉบับแก้ไขเทียบฉบับเดิม (review ST2-T13):
   * - ฉบับเดิมมีผลแล้ว → ฉบับแก้ไขเริ่มได้ตั้งแต่พรุ่งนี้ (เวลาไทย) — ห้ามย้อนเปลี่ยนราคาที่ใช้คิดเงินไปแล้ว → 422 `revision_backdated`
   * - ฉบับเดิมยังไม่ถึงวันเริ่ม → เริ่มไม่ก่อนวันเริ่มฉบับเดิม
   * - ฉบับแก้ไขจบก่อนฉบับเดิม (ช่วงกลาง) → ท้ายช่วงของฉบับเดิมจะหาย → 422 `revision_drops_tail` [DECISION — ย้อนได้]
   * ตรวจตอนออก/แก้ร่าง/อนุมัติ (วันเปลี่ยนระหว่างนั้นได้)
   */
  private async assertRevisionWindow(parentId: string, r: Complete) {
    const p = await this.db.tx.rateCard.findFirst({
      where: { id: parentId, deletedAt: null },
      select: { status: true, validFrom: true, validTo: true },
    });
    if (!p || p.status !== 'APPROVED') return;
    const today = bangkokToday();
    const pFrom = day(p.validFrom);
    const pTo = p.validTo ? day(p.validTo) : null;
    if (pFrom <= today ? r.validFrom <= today : r.validFrom < pFrom)
      throw new ProblemException(
        'validation_failed',
        undefined,
        [
          {
            field: 'validFrom',
            code: 'revision_backdated',
            message: `a revision must start after ${pFrom <= today ? today : addDays(pFrom, -1)}`,
          },
        ],
        { earliestValidFrom: pFrom <= today ? addDays(today, 1) : pFrom },
      );
    const overlaps = pTo === null || r.validFrom <= pTo;
    if (overlaps && r.validTo !== null && (pTo === null || r.validTo < pTo))
      throw field422(
        'validTo',
        'revision_drops_tail',
        `a revision must run to the end of the rate it revises (${pTo ?? 'no end'})`,
      );
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.rateCard.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  /** รหัสถัดไป RC-S-0001 (นับรวมที่ลบ เพราะ unique ครอบทุกแถว) — เรียกหลัง lockKey('rate_card.code') */
  private async nextCode(side: RateSide): Promise<string> {
    const p = CODE_PREFIX[side];
    const rows = await this.db.tx.$queryRaw<{ n: bigint | number | null }[]>`
      SELECT max((substring(upper(code) from ${`^${p}-([0-9]{1,9})$`}))::bigint) AS n FROM "rate_card"`;
    return `${p}-${String(Number(rows[0]?.n ?? 0) + 1).padStart(4, '0')}`;
  }

  private data(r: Complete): Prisma.RateCardUncheckedUpdateInput {
    return {
      customerId: r.customerId,
      carrierId: r.carrierId,
      originSiteId: r.originSiteId,
      destSiteId: r.destSiteId,
      vehicleTypeId: r.vehicleTypeId,
      pricingModel: r.pricingModel,
      unitId: r.unitId,
      unitPrice: new Prisma.Decimal(r.unitPrice),
      minCharge: r.minCharge === null ? null : new Prisma.Decimal(r.minCharge),
      extraStopPrice: r.extraStopPrice === null ? null : new Prisma.Decimal(r.extraStopPrice),
      includedStops: r.includedStops,
      serviceItemId: r.serviceItemId,
      validFrom: toDate(r.validFrom),
      validTo: r.validTo ? toDate(r.validTo) : null,
      notes: r.notes,
    };
  }

  private async writeAccessorials(rateCardId: string, r: Complete, replace: boolean) {
    const tx = this.db.tx;
    if (replace) await tx.rateCardAccessorial.deleteMany({ where: { rateCardId } });
    if (r.accessorials.length)
      await tx.rateCardAccessorial.createMany({
        data: r.accessorials.map((a) => ({
          tenantId: requestContext.require().tenantId!,
          rateCardId,
          serviceItemId: a.serviceItemId,
          price: new Prisma.Decimal(a.price),
        })),
      });
  }

  /** ค่าบริการเสริมเริ่มต้น = ค่าขนส่ง (FREIGHT) ของ tenant */
  private async freightItemId(): Promise<string | null> {
    const s = await this.db.tx.serviceItem.findFirst({
      where: { systemKey: 'FREIGHT', deletedAt: null },
      select: { id: true },
    });
    return s?.id ?? null;
  }

  /** แปลง error ของ exclusion constraint (กรณีหลุด lock — เช่นแก้ฐานตรง) เป็น 422 เดียวกับตรวจในแอป */
  private async guardOverlap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (/rate_card_no_overlap|23P01/.test(String((e as Error)?.message)))
        throw new ProblemException('validation_failed', 'rate period overlaps another rate', [
          { field: 'validFrom', code: 'overlap', message: 'period overlaps another active rate' },
        ]);
      throw e;
    }
  }

  // ---------- write ----------

  async create(input: CreateRateCardDto | (UpsertRateCardDto & { externalId: string })) {
    const tx = this.db.tx;
    const side: RateSide = input.side ?? 'SELL';
    assertSideWrite(side);
    const base: Resolved = {
      side,
      customerId: null,
      carrierId: null,
      originSiteId: null,
      destSiteId: null,
      vehicleTypeId: null,
      pricingModel: null,
      unitId: null,
      unitPrice: null,
      minCharge: null,
      extraStopPrice: null,
      includedStops: 2,
      serviceItemId: input.serviceItemId ? null : await this.freightItemId(),
      validFrom: null,
      validTo: null,
      notes: null,
      accessorials: [],
    };
    const r = validateShape(merge(base, input));
    // ลำดับล็อก: ext → key → ข้อมูลที่อ้าง → code (ลด deadlock — เหมือน master อื่น)
    if (input.externalId) {
      await lockKey(tx, `${ENTITY}.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await this.lockKeys([this.keyOf(r)]);
    await this.lockRefs(r);
    await this.assertNoOverlap(r, [], true);
    await lockKey(tx, `${ENTITY}.code`);
    let code = input.code;
    if (code) {
      const taken = await tx.rateCard.findFirst({
        where: { code: iEquals(code) },
        select: { id: true },
      });
      if (taken)
        throw new ProblemException('duplicate', undefined, [
          { field: 'code', code: 'duplicate', message: 'code already exists' },
        ]);
    } else code = await this.nextCode(side);
    const row = await tx.rateCard.create({
      data: {
        ...(this.data(r) as object),
        side,
        code,
        externalId: input.externalId ?? null,
      } as Prisma.RateCardUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    await this.writeAccessorials(row.id, r, false);
    const full = await this.get(row.id);
    await this.audit.record({
      action: `${ENTITY}.created`,
      entityType: ENTITY,
      entityId: row.id,
      after: auditView(full),
    });
    await emitMasterEvent(tx, `${ENTITY}.created`, ENTITY, row.id, eventView(full));
    return full;
  }

  /** แก้ร่าง — rate ที่อนุมัติ/ยกเลิกแล้ว → 409 `not_editable` (ออกฉบับแก้ไขด้วย revise) */
  async update(id: string, input: UpdateRateCardDto, expected?: number): Promise<RateRow> {
    const tx = this.db.tx;
    const current = await this.get(id);
    assertSideWrite(current.side);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.status !== 'DRAFT')
      throw conflict('status', 'not_editable', 'only drafts can be edited — use revise');
    const before = fromRow(current);
    const r = validateShape(merge(before, input));
    // ฉบับแก้ไข: key ต้องเหมือนฉบับเดิม (ระบบปิดฉบับเดิมตอนอนุมัติ — MD-118)
    if (current.parentId)
      for (const [k, f] of [
        ['customerId', 'customerId'],
        ['carrierId', 'carrierId'],
        ['originSiteId', 'originId'],
        ['destSiteId', 'destinationId'],
        ['vehicleTypeId', 'vehicleTypeId'],
      ] as const)
        if (before[k] !== r[k])
          throw field422(f, 'key_locked', 'a revision keeps the key of the rate it revises');
    if (current.parentId) await this.assertRevisionWindow(current.parentId, r);
    if (input.externalId !== undefined && input.externalId) {
      await lockKey(tx, `${ENTITY}.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId, current.id);
    }
    const changed = new Set(
      (
        [
          ['customerId', 'customerId'],
          ['carrierId', 'carrierId'],
          ['originSiteId', 'originId'],
          ['destSiteId', 'destinationId'],
          ['vehicleTypeId', 'vehicleTypeId'],
          ['unitId', 'unitId'],
          ['serviceItemId', 'serviceItemId'],
        ] as const
      )
        .filter(([k]) => before[k] !== r[k])
        .map(([, f]) => f as string),
    );
    if (stableStringify(before.accessorials) !== stableStringify(r.accessorials))
      changed.add('accessorials');
    const extChanged = input.externalId !== undefined && input.externalId !== current.externalId;
    if (fingerprint(before) === fingerprint(r) && !extChanged) return current; // ส่งซ้ำค่าเดิม = ไม่เพิ่ม version
    await this.lockKeys([this.keyOf(validateShape(before)), this.keyOf(r)]);
    await this.lockRefs(r, changed);
    await this.assertNoOverlap(r, [current.id, current.parentId], true);
    const data = this.data(r);
    if (extChanged) data.externalId = input.externalId;
    await this.bumpVersion(current, data);
    if (changed.has('accessorials')) await this.writeAccessorials(current.id, r, true);
    const updated = await this.get(current.id);
    await this.recordUpdate(current, updated);
    return updated;
  }

  private async recordUpdate(current: RateRow, updated: RateRow) {
    const before = auditView(current);
    const after = auditView(updated);
    await this.audit.changed(`${ENTITY}.updated`, ENTITY, updated.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => stableStringify(before[k]) !== stableStringify(after[k]),
    );
    if (changed.length)
      await emitMasterEvent(
        this.db.tx,
        `${ENTITY}.updated`,
        ENTITY,
        updated.id,
        eventView(updated),
        {
          changedFields: changed,
        },
      );
  }

  /** PUT /rate-cards/external/{externalId} — ยังไม่มี = สร้างร่าง · มีแล้ว = แก้ร่าง (อนุมัติแล้ว → 409 ใช้ revise) */
  async upsertExternal(externalId: string, input: UpsertRateCardDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, ENTITY, externalId, {
      find: () =>
        tx.rateCard.findFirst({ where: { externalId, deletedAt: null }, include: INCLUDE }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        const { code: _code, side, ...rest } = input;
        // ฝั่งเปลี่ยนไม่ได้ (key ต่างชนิดกัน) — สร้าง externalId ใหม่แทน
        if (side !== undefined && side !== cur.side)
          throw field422('side', 'side_locked', 'side of an existing rate cannot change');
        return this.update(cur.id, rest, expected);
      },
    });
  }

  /**
   * ออกฉบับแก้ไข (MD-118): rate ที่อนุมัติแล้วแก้ตรงไม่ได้ → สร้างร่างฉบับใหม่ (รหัสเดิม ฉบับที่ +1) คัดลอกทุกช่องแล้วใส่ค่าที่แก้
   * key (ลูกค้า/เส้นทาง/ประเภทรถ) เปลี่ยนไม่ได้ — ต้องการ key ใหม่ให้สร้าง rate ใหม่ · ฉบับเดิมยังใช้ได้จนกว่าฉบับใหม่จะอนุมัติ
   * มีร่างฉบับแก้ไขค้างอยู่แล้ว → 409 `draft_exists` (แก้ร่างนั้นแทน)
   */
  async revise(id: string, input: ReviseRateCardDto, expected?: number): Promise<RateRow> {
    const tx = this.db.tx;
    const current = await this.get(id);
    assertSideWrite(current.side);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.status !== 'APPROVED')
      throw conflict('status', 'not_revisable', 'only approved rates can be revised');
    await lockKey(tx, `${ENTITY}.chain:${current.code.toUpperCase()}`);
    const pending = await tx.rateCard.findFirst({
      where: {
        parentId: current.id,
        deletedAt: null,
        status: { in: ['DRAFT', 'PENDING_APPROVAL'] },
      },
      select: { id: true, code: true, revision: true },
    });
    if (pending)
      throw conflict('id', 'draft_exists', 'a draft revision already exists', {
        existing: {
          id: encodeId('rateCard', pending.id),
          code: pending.code,
          revision: pending.revision,
        },
      });
    const before = fromRow(current);
    const r = validateShape(merge(before, input));
    await this.assertRevisionWindow(current.id, r);
    const changed = new Set<string>();
    if (before.unitId !== r.unitId) changed.add('unitId');
    if (stableStringify(before.accessorials) !== stableStringify(r.accessorials))
      changed.add('accessorials');
    await this.lockKeys([this.keyOf(r)]);
    await this.lockRefs(r, changed);
    await this.assertNoOverlap(r, [current.id], true);
    const last = await tx.rateCard.aggregate({
      where: { code: iEquals(current.code) },
      _max: { revision: true },
    });
    const row = await tx.rateCard.create({
      data: {
        ...(this.data(r) as object),
        side: current.side,
        code: current.code,
        revision: (last._max.revision ?? current.revision) + 1,
        parentId: current.id,
      } as Prisma.RateCardUncheckedCreateInput,
    });
    await this.writeAccessorials(row.id, r, false);
    const full = await this.get(row.id);
    await this.audit.record({
      action: `${ENTITY}.revised`,
      entityType: ENTITY,
      entityId: row.id,
      after: { ...auditView(full), parentId: encodeId('rateCard', current.id) },
    });
    await emitMasterEvent(tx, `${ENTITY}.created`, ENTITY, row.id, eventView(full));
    return full;
  }

  /**
   * อนุมัติ (เฟส 0: ผู้มีสิทธิ์แก้ราคาขายอนุมัติได้ทันที — docs/04 B; แยกหน้าที่ MD-120 = P1) → ใช้คำนวณได้ในช่วงวัน
   * ตรวจข้อมูลที่อ้างยังใช้งาน + ช่วงวันไม่ทับ rate ที่ใช้งาน · ฉบับแก้ไข: ฉบับเดิมสิ้นสุดวันก่อน validFrom ใหม่
   * (validFrom ใหม่ ≤ วันเริ่มฉบับเดิม → ฉบับเดิมถูกแทนทั้งช่วง = RETIRED) — MD-118
   */
  async approve(id: string, reason: string, expected?: number): Promise<RateRow> {
    const tx = this.db.tx;
    const current = await this.get(id);
    assertSideWrite(current.side);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const r = validateShape(fromRow(current));
    await this.lockKeys([this.keyOf(r)]);
    if (current.status === 'DRAFT' || current.status === 'PENDING_APPROVAL') await this.lockRefs(r);
    if (current.parentId && current.status !== 'APPROVED')
      await this.assertRevisionWindow(current.parentId, r);
    await this.assertNoOverlap(r, [current.id, current.parentId], false);
    let updated!: RateRow;
    await this.state.transition(tx, {
      docType: ENTITY,
      docId: id,
      table: RATE_CARD_TRANSITIONS,
      from: current.status,
      event: 'approve',
      note: reason,
      eventType: `${ENTITY}.activated`,
      apply: async (to) => {
        const closed = current.parentId
          ? await this.closeParent(current.parentId, r, current)
          : null;
        const ctx = requestContext.require();
        await this.guardOverlap(() =>
          this.bumpVersion(current, {
            ...(closed
              ? {
                  parentClosed: true,
                  parentPrevValidTo: closed.validTo,
                  parentPrevStatus: closed.status,
                }
              : {}),
            status: to,
            approvedAt: new Date(),
            approvedById: ctx.principalType === 'user' ? (ctx.actorId ?? null) : null,
          }),
        );
        updated = await this.get(id);
        await this.audit.changed(
          `${ENTITY}.activated`,
          ENTITY,
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return eventView(updated);
      },
    });
    return updated;
  }

  /**
   * ฉบับเดิมของฉบับแก้ไขที่กำลังอนุมัติ: ตัดวันหมดเป็นวันก่อน validFrom ใหม่ หรือถูกแทนทั้งช่วง
   * คืนค่าก่อนปิด (เก็บที่ฉบับแก้ไข — ยกเลิกฉบับแก้ไขแล้วคืนให้) · ไม่ได้ปิด = null
   */
  private async closeParent(
    parentId: string,
    next: Complete,
    child: RateRow,
  ): Promise<{ validTo: Date | null; status: RateStatus } | null> {
    const tx = this.db.tx;
    const parent = await tx.rateCard.findFirst({
      where: { id: parentId, deletedAt: null },
      include: INCLUDE,
    });
    if (!parent || parent.status !== 'APPROVED') return null;
    const prev = { validTo: parent.validTo, status: parent.status };
    const pFrom = day(parent.validFrom);
    const pTo = parent.validTo ? day(parent.validTo) : null;
    const overlaps =
      (next.validTo === null || pFrom <= next.validTo) && (pTo === null || pTo >= next.validFrom);
    if (!overlaps) return null;
    const label = `${child.code} v${child.revision}`;
    if (next.validFrom > pFrom) {
      await this.bumpVersion(parent, { validTo: toDate(addDays(next.validFrom, -1)) });
      const after = await this.get(parent.id);
      await this.audit.changed(
        `${ENTITY}.superseded`,
        ENTITY,
        parent.id,
        auditView(parent),
        auditView(after),
        `ฉบับแก้ไข ${label} มีผลแทน`,
      );
      await emitMasterEvent(tx, `${ENTITY}.updated`, ENTITY, parent.id, eventView(after), {
        changedFields: ['validTo'],
      });
      return prev;
    }
    await this.state.transition(tx, {
      docType: ENTITY,
      docId: parent.id,
      table: RATE_CARD_TRANSITIONS,
      from: parent.status,
      event: 'supersede',
      note: `ฉบับแก้ไข ${label} มีผลแทนทั้งช่วง`,
      eventType: `${ENTITY}.superseded`,
      apply: async (to) => {
        await this.bumpVersion(parent, { status: to });
        const after = await this.get(parent.id);
        await this.audit.changed(
          `${ENTITY}.superseded`,
          ENTITY,
          parent.id,
          auditView(parent),
          auditView(after),
          `ฉบับแก้ไข ${label} มีผลแทนทั้งช่วง`,
        );
        return eventView(after);
      },
    });
    return prev;
  }

  /**
   * ยกเลิกฉบับแก้ไขที่ระบบใช้ปิดฉบับเดิม → คืนวันหมด/สถานะเดิมให้ฉบับเดิม (ไม่ทิ้งช่องว่างที่ไม่มีราคา — review ST2-T13)
   * ฉบับเดิมถูกเปลี่ยนต่อหลังจากนั้น (เช่น ฉบับแก้ไขอื่นปิดอีก) หรือคืนแล้วทับ rate อื่น → 409 `revision_cancel_blocked`
   */
  private async restoreParent(child: RateRow, reason: string) {
    const tx = this.db.tx;
    const parent = child.parentId
      ? await tx.rateCard.findFirst({
          where: { id: child.parentId, deletedAt: null },
          include: INCLUDE,
        })
      : null;
    const blocked = () =>
      conflict(
        'id',
        'revision_cancel_blocked',
        'the previous revision changed since — issue a new revision instead of cancelling',
      );
    if (!parent) throw blocked();
    const cut = toDate(addDays(day(child.validFrom), -1)).getTime();
    const trimmed = parent.status === 'APPROVED' && parent.validTo?.getTime() === cut;
    const retired = parent.status === 'RETIRED' && child.parentPrevStatus === 'APPROVED';
    if (!trimmed && !retired) throw blocked();
    const prevTo = child.parentPrevValidTo;
    const note = `ยกเลิกฉบับแก้ไข ${child.code} v${child.revision} — คืนช่วงวันเดิม: ${reason}`;
    const write = async (data: Prisma.RateCardUncheckedUpdateInput) => {
      try {
        await this.bumpVersion(parent, data);
      } catch (e) {
        if (/rate_card_no_overlap|23P01/.test(String((e as Error)?.message))) throw blocked();
        throw e;
      }
      const after = await this.get(parent.id);
      await this.audit.changed(
        `${ENTITY}.restored`,
        ENTITY,
        parent.id,
        auditView(parent),
        auditView(after),
        note,
      );
      return after;
    };
    // ตรวจในแอปก่อน (ข้อความชัด) — constraint ในฐานกันอีกชั้น
    const restored = validateShape({ ...fromRow(parent), validTo: prevTo ? day(prevTo) : null });
    await this.assertNoOverlap(restored, [parent.id, child.id], false).catch(() => {
      throw blocked();
    });
    if (trimmed) {
      const after = await write({ validTo: prevTo });
      await emitMasterEvent(tx, `${ENTITY}.updated`, ENTITY, parent.id, eventView(after), {
        changedFields: ['validTo'],
      });
      return;
    }
    await this.state.transition(tx, {
      docType: ENTITY,
      docId: parent.id,
      table: RATE_CARD_TRANSITIONS,
      from: parent.status,
      event: 'restore',
      note,
      eventType: `${ENTITY}.restored`,
      apply: async (to) => eventView(await write({ status: to, validTo: prevTo })),
    });
  }

  /**
   * ยกเลิก rate ที่อนุมัติแล้วแต่ยังไม่ถึงวันเริ่ม (spec/02 §5 "active → cancelled ยังไม่ถึง validFrom เท่านั้น")
   * ถึงวันเริ่มแล้ว → 409 `in_effect` (ให้ออกฉบับแก้ไขกำหนดวันหมดแทน — ราคาที่เคยใช้คิดเงินต้องตรวจย้อนได้)
   * ร่าง → 409 (ใช้ลบ)
   */
  async cancel(id: string, reason: string, expected?: number): Promise<RateRow> {
    const tx = this.db.tx;
    const current = await this.get(id);
    assertSideWrite(current.side);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.status === 'DRAFT')
      throw conflict('status', 'use_delete', 'drafts are deleted, not cancelled');
    if (current.status === 'APPROVED' && day(current.validFrom) <= bangkokToday())
      throw conflict(
        'validFrom',
        'in_effect',
        'rate is already in effect — revise its end date instead',
      );
    await this.lockKeys([this.keyOf(validateShape(fromRow(current)))]);
    let updated!: RateRow;
    await this.state.transition(tx, {
      docType: ENTITY,
      docId: id,
      table: RATE_CARD_TRANSITIONS,
      from: current.status,
      event: 'cancel',
      note: reason,
      eventType: `${ENTITY}.cancelled`,
      apply: async (to) => {
        await this.bumpVersion(current, { status: to });
        if (current.status === 'APPROVED' && current.parentClosed)
          await this.restoreParent(current, reason);
        updated = await this.get(id);
        await this.audit.changed(
          `${ENTITY}.cancelled`,
          ENTITY,
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return eventView(updated);
      },
    });
    return updated;
  }

  /** ลบร่าง (soft delete + เหตุผล) — อนุมัติแล้ว/ยกเลิกแล้ว → 409 (เก็บไว้ตรวจย้อน; ไม่มีการลบจริง) */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    assertSideWrite(current.side);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.status !== 'DRAFT')
      throw conflict('status', 'not_deletable', 'only drafts can be deleted');
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: `${ENTITY}.deleted`,
      entityType: ENTITY,
      entityId: id,
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(tx, `${ENTITY}.deleted`, ENTITY, id, eventView(current));
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(current: RateCard, data: Prisma.RateCardUncheckedUpdateInput) {
    const r = await this.db.tx.rateCard.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
  }
}
