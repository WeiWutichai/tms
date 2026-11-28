import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId, type IdKind } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { CARRIER_CODE_PREFIX } from '../carriers/carriers.service';
import { CUSTOMER_CODE_PREFIX } from '../customers/customers.service';
import { DRIVER_CODE_PREFIX, phoneNorm } from '../drivers/drivers.service';
import { lockKey, nextCode } from '../master/master-kit';
import { OrderIntakeService } from '../orders/order-intake.service';
import { SITE_CODE_PREFIX, SITE_CODE_WIDTH } from '../sites/sites.service';
import { plateKey, plateNorm } from '../vehicles/vehicles.service';
import {
  SAMPLE_CARRIERS,
  SAMPLE_CUSTOMERS,
  SAMPLE_DRIVERS,
  SAMPLE_ORDERS,
  SAMPLE_SITES,
  SAMPLE_VEHICLES,
} from './sample-dataset';

/** ชนิดแถวที่ติดธงตัวอย่างได้ (ตรงกับ CHECK ของ sample_record — migration 0202) ตามลำดับที่แสดง */
export const SAMPLE_ENTITY_TYPES = [
  'customer',
  'customer_site',
  'carrier',
  'vehicle',
  'driver',
  'rate_card',
  'sales_order',
] as const;
export type SampleEntityType = (typeof SAMPLE_ENTITY_TYPES)[number];

const ID_KIND: Record<SampleEntityType, IdKind> = {
  customer: 'customer',
  customer_site: 'site',
  carrier: 'carrier',
  vehicle: 'vehicle',
  driver: 'driver',
  rate_card: 'rateCard',
  sales_order: 'salesOrder',
};

export type SampleCounts = Record<SampleEntityType, number>;

export interface SampleStatus {
  /** บริษัทนี้ใส่ข้อมูลตัวอย่างได้ (ช่วงทดลองใช้ / sandbox) */
  allowed: boolean;
  /** มีแถวที่ติดธงตัวอย่างอยู่ */
  loaded: boolean;
  counts: SampleCounts;
}

export interface SampleKept {
  entityType: SampleEntityType;
  id: string;
  label: string;
  reason: 'in_use';
}

export interface SampleRemoved {
  entityType: SampleEntityType;
  id: string;
  label: string;
}

export interface SampleClearResult extends SampleStatus {
  removed: SampleCounts;
  kept: SampleKept[];
}

/** สถานะบริษัทที่ใส่ข้อมูลตัวอย่างได้ — ช่วงทดลองใช้ (รวมรอตรวจสอบหลังสมัคร) · sandbox ใส่ได้เสมอ */
const TRIAL_STATUSES = new Set(['TRIALING', 'PENDING_VERIFICATION']);

const zero = (): SampleCounts =>
  Object.fromEntries(SAMPLE_ENTITY_TYPES.map((t) => [t, 0])) as SampleCounts;

/** วันที่เวลาไทย + n วัน (YYYY-MM-DD) */
const bkkDate = (now: Date, addDays = 0) =>
  new Date(now.getTime() + 7 * 3600_000 + addDays * 86_400_000).toISOString().slice(0, 10);

/**
 * ข้อมูลตัวอย่างสำหรับ trial (P1-ST2-T09; docs/02 §2 "มีข้อมูลตัวอย่างบริษัทขนส่งไทยให้ลองทันที" · plan/01 ผู้สมัคร #30)
 *
 * - ใส่: ลูกค้า / สถานที่ / รถร่วม / รถ / คนขับ / rate card (ขาย + ซื้อ อนุมัติแล้ว) / ใบสั่งขนส่ง ของบริษัทสมมติ (`sample-dataset.ts`
 *   — ชื่อมีคำว่า "ตัวอย่าง" ไม่เหมือนบริษัทจริง ตามคำเตือน design/README.md) ทุกแถวติดธงผ่าน `tms_sample_flag()` (ตรวจว่าแถวสร้างใน
 *   transaction นี้) · ข้อมูลหลักเขียนตรง · ใบสั่งผ่าน `upsertOrder` (ทางเดียวของ order — DO ร่างถูกสร้างอัตโนมัติ)
 *   · ทั้ง transaction ตั้งธง `tms.suppress_outbox` → domain_event ที่เกิด (order.created ฯลฯ) ไม่ถูกส่งต่อไป webhook / ERP
 *   (ยังอยู่ในตาราง domain_event — ประวัติ)
 * - ล้าง: `tms_sample_data_purge()` ลบเฉพาะแถวที่มีธงและยังไม่ถูกใช้ต่อ (SO พ้นขั้นรับงาน / DO ลงเที่ยว / มี FK หรือตัวอ้างอิงอื่น)
 *   = คงไว้ + เหตุผล · ไม่ส่ง event
 * - ไม่นับ usage: เที่ยวที่ใช้รถ/รถร่วมตัวอย่างขณะบริษัทยังอยู่ช่วงทดลองใช้ไม่นับรถ active (trigger 0202 — พ้น trial แล้วนับปกติ)
 *   · DO จาก SO ตัวอย่างไม่นับ `do.created` · ไม่ทำให้ขั้น "นำเข้าข้อมูลหลัก" ของ checklist เสร็จ
 *   · ออกใบแจ้งหนี้ให้ลูกค้าตัวอย่างไม่ได้ (422 — `assertNotSampleCustomer`; ใบวางบิลต้องอ้างใบแจ้งหนี้ที่ออกแล้ว จึงไม่เกิดตามไปด้วย)
 * [DECISION — lead 28 พ.ย. 2569, ย้อนได้ — spec/12 §3]
 */
@Injectable()
export class SampleDataService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly intake: OrderIntakeService,
  ) {}

  async status(tx: Tx = this.db.tx): Promise<SampleStatus> {
    const tenantId = requestContext.require().tenantId!;
    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, mode: true },
    });
    const allowed = !!t && (t.mode === 'test' || TRIAL_STATUSES.has(t.status));
    const counts = await this.counts(tx);
    return { allowed, loaded: Object.values(counts).some((n) => n > 0), counts };
  }

  /** uuid ของแถวตัวอย่างชนิดนั้น (checklist / usage ใช้ตัดออก) */
  async ids(type: SampleEntityType, tx: Tx = this.db.tx): Promise<string[]> {
    const rows = await tx.sampleRecord.findMany({
      where: { entityType: type },
      select: { entityId: true },
    });
    return rows.map((r) => r.entityId);
  }

  async load(): Promise<SampleStatus> {
    const tx = this.db.tx;
    // ใส่ซ้ำพร้อมกันสองแท็บ → คนที่สองรอแล้วเห็นว่ามีแล้ว (409)
    await lockKey(tx, 'sample_data');
    const s = await this.status(tx);
    if (!s.allowed) throw new ProblemException('sample_data_not_allowed');
    if (s.loaded) throw new ProblemException('sample_data_loaded');

    const ctx = requestContext.require();
    const tenantId = ctx.tenantId!;
    const now = this.clock.now();
    // event ของข้อมูลตัวอย่างไม่ออก webhook / ERP (trigger domain_event_to_outbox อ่านธงนี้) — ปิดธงก่อนจบ
    await tx.$executeRaw`SELECT set_config('tms.suppress_outbox', 'on', true)`;
    const flags: { entityType: SampleEntityType; entityId: string }[] = [];
    const flag = (entityType: SampleEntityType, entityId: string) =>
      flags.push({ entityType, entityId });

    // ค่าเริ่มต้นของระบบที่ bootstrap สร้างให้ทุกบริษัท (ประเภทรถ / รายการค่าขนส่ง)
    const types = await tx.vehicleType.findMany({
      where: { systemKey: { in: ['th.6w', 'th.10w'] }, deletedAt: null },
      select: { id: true, systemKey: true },
    });
    const vt = (k: '6W' | '10W') =>
      types.find((x) => x.systemKey === (k === '6W' ? 'th.6w' : 'th.10w'))?.id ??
      types[0]?.id ??
      null;
    const freight = await tx.serviceItem.findFirst({
      where: { systemKey: 'FREIGHT' },
      select: { id: true },
    });
    if (!vt('6W') || !freight)
      throw new ProblemException(
        'conflict',
        'default vehicle types / FREIGHT service item missing',
      );

    // 1) ลูกค้า
    await lockKey(tx, 'customer.code');
    const customers = new Map<string, string>();
    for (const c of SAMPLE_CUSTOMERS) {
      const row = await tx.customer.create({
        data: {
          tenantId,
          code: await nextCode(tx, 'customer', CUSTOMER_CODE_PREFIX),
          legalName: c.name,
          billingAddress: c.address,
          contacts: [{ name: c.contact, phone: c.phone, email: null, isPrimary: true }],
          paymentTermDays: 30,
          requirePodToBill: false,
        },
        select: { id: true },
      });
      customers.set(c.key, row.id);
      flag('customer', row.id);
    }

    // 2) สถานที่ (พิกัดตัวอย่าง — ยืนยันแล้ว ไม่ต้อง geocode)
    await lockKey(tx, 'customer_site.code');
    const sites = new Map<string, string>();
    for (const p of SAMPLE_SITES) {
      const row = await tx.customerSite.create({
        data: {
          tenantId,
          code: await nextCode(tx, 'customer_site', SITE_CODE_PREFIX, SITE_CODE_WIDTH),
          customerId: p.customer ? customers.get(p.customer)! : null,
          kind: p.kind,
          name: p.name,
          address: p.address,
          lat: new Prisma.Decimal(p.lat),
          lng: new Prisma.Decimal(p.lng),
          geocodeStatus: 'OK',
          openTime: p.openTime ?? null,
          closeTime: p.closeTime ?? null,
          avgDwellMin: 30,
          notes: null,
        },
        select: { id: true },
      });
      sites.set(p.key, row.id);
      flag('customer_site', row.id);
    }

    // 3) รถร่วม (ไม่มีเลขผู้เสียภาษี/บัญชีธนาคาร — ข้อมูลสมมติ)
    await lockKey(tx, 'carrier.code');
    const carriers = new Map<string, string>();
    for (const c of SAMPLE_CARRIERS) {
      const row = await tx.carrier.create({
        data: {
          tenantId,
          code: await nextCode(tx, 'carrier', CARRIER_CODE_PREFIX),
          legalName: c.name,
          entityType: c.entityType,
          whtRateDefault: new Prisma.Decimal('1.00'),
          phone: c.phone,
          requirePodToPay: false,
        },
        select: { id: true },
      });
      carriers.set(c.key, row.id);
      flag('carrier', row.id);
    }

    // 4) รถ (ทะเบียนตัวอย่าง "ตย-…" — ข้ามคันที่ทะเบียนชนกับรถใดก็ตามที่มีอยู่ รวมที่ปลดระวาง/ลบ — ไม่ล้มทั้งชุด)
    const taken = new Set(
      (await tx.vehicle.findMany({ select: { plateKey: true } })).map((v) => v.plateKey),
    );
    for (const v of SAMPLE_VEHICLES) {
      const key = plateKey(v.plate, v.province);
      if (taken.has(key)) continue;
      const row = await tx.vehicle.create({
        data: {
          tenantId,
          plate: v.plate,
          plateProvince: v.province,
          plateKey: key,
          plateNorm: plateNorm(v.plate),
          vehicleTypeId: vt(v.type)!,
          ownership: v.carrier ? 'SUBCONTRACT' : 'OWN',
          carrierId: v.carrier ? carriers.get(v.carrier)! : null,
          brand: v.brand,
          fuelType: 'DIESEL',
        },
        select: { id: true },
      });
      flag('vehicle', row.id);
    }

    // 4b) คนขับตัวอย่าง (พนักงานของบริษัท — ให้รถบริษัทตัวอย่างปล่อยเที่ยวได้) · ข้ามเบอร์ที่ชนคนขับที่มีอยู่
    await lockKey(tx, 'driver.code');
    const phones = new Set(
      (await tx.driver.findMany({ select: { phoneNorm: true } })).map((d) => d.phoneNorm),
    );
    for (const d of SAMPLE_DRIVERS) {
      if (phones.has(phoneNorm(d.phone))) continue;
      const row = await tx.driver.create({
        data: {
          tenantId,
          code: await nextCode(tx, 'driver', DRIVER_CODE_PREFIX),
          name: d.name,
          phone: d.phone,
          phoneNorm: phoneNorm(d.phone),
          licenceClass: d.licenceClass,
          employmentType: 'EMPLOYEE_SALARIED',
        },
        select: { id: true },
      });
      flag('driver', row.id);
    }

    // 5) rate card ขาย (ลูกค้า × เส้นทางของใบสั่งตัวอย่าง) + ซื้อ (รถร่วม) — อนุมัติแล้ว เริ่มใช้วันนี้
    await lockKey(tx, 'rate_card.code');
    const validFrom = new Date(`${bkkDate(now)}T00:00:00Z`);
    const nextRc = async (p: 'RC-S' | 'RC-B') => {
      const r = await tx.$queryRaw<{ n: bigint | number | null }[]>`
        SELECT max((substring(upper(code) from ${`^${p}-([0-9]{1,9})$`}))::bigint) AS n FROM "rate_card"`;
      return `${p}-${String(Number(r[0]?.n ?? 0) + 1).padStart(4, '0')}`;
    };
    const rate = async (o: {
      side: 'SELL' | 'BUY';
      customerId?: string;
      carrierId?: string;
      origin: string;
      dest: string;
      vehicleTypeId: string;
      price: string;
    }) => {
      const row = await tx.rateCard.create({
        data: {
          tenantId,
          side: o.side,
          code: await nextRc(o.side === 'SELL' ? 'RC-S' : 'RC-B'),
          customerId: o.customerId ?? null,
          carrierId: o.carrierId ?? null,
          originSiteId: o.origin,
          destSiteId: o.dest,
          vehicleTypeId: o.vehicleTypeId,
          pricingModel: 'PER_TRIP',
          unitPrice: new Prisma.Decimal(o.price),
          serviceItemId: freight.id,
          validFrom,
          status: 'APPROVED',
          approvedAt: now,
          approvedById: isUuid(ctx.actorId) ? ctx.actorId : null,
        },
        select: { id: true },
      });
      flag('rate_card', row.id);
    };
    for (const o of SAMPLE_ORDERS) {
      await rate({
        side: 'SELL',
        customerId: customers.get(o.customer)!,
        origin: sites.get(o.from)!,
        dest: sites.get(o.to)!,
        vehicleTypeId: vt(o.type)!,
        price: o.sell,
      });
      if (o.buy)
        await rate({
          side: 'BUY',
          carrierId: carriers.get(o.buy.carrier)!,
          origin: sites.get(o.from)!,
          dest: sites.get(o.to)!,
          vehicleTypeId: vt(o.type)!,
          price: o.buy.price,
        });
    }

    // 6) ใบสั่งขนส่ง — ทางเดียวของ order (upsertOrder): ออกเลข SO + คิดราคาจาก rate card ข้างบน
    //    หลายนิติบุคคล (routing อาจยังไม่ตั้ง) → ออกบิลในนามนิติบุคคลแรกที่มีสาขาออกเอกสาร · นิติบุคคลเดียว = ตาม routing ปกติ
    const companies = await tx.company.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const issuers = new Set(
      (
        await tx.branch.findMany({ where: { isDefaultIssuer: true }, select: { companyId: true } })
      ).map((b) => b.companyId),
    );
    const billingCompanyId =
      companies.length > 1
        ? (companies.find((c) => issuers.has(c.id)) ?? companies[0]!).id
        : undefined;
    for (const [i, o] of SAMPLE_ORDERS.entries()) {
      const r = await this.intake.upsertOrder(
        {
          source: { source: 'MANUAL', connector: '' },
          customer: { id: customers.get(o.customer)! },
          customerRef: o.ref,
          ...(billingCompanyId ? { billingCompanyId } : {}),
          requestedDate: bkkDate(now, 1 + (i % 2)),
          vehicleTypeId: vt(o.type)!,
          stops: [
            { type: 'PICKUP', siteId: sites.get(o.from)! },
            { type: 'DELIVERY', siteId: sites.get(o.to)! },
          ],
          lines: o.lines.map((l) => ({
            description: l.description,
            qty: l.qty,
            unit: l.unit,
            weightKg: l.weightKg,
          })),
        },
        tx,
      );
      flag('sales_order', r.order.id);
    }

    // ติดธงผ่านฟังก์ชันฐานข้อมูล (แอปเขียน sample_record ตรงไม่ได้ — ฟังก์ชันตรวจว่าแถวสร้างใน transaction นี้)
    for (const t of SAMPLE_ENTITY_TYPES) {
      const ids = flags.filter((f) => f.entityType === t).map((f) => f.entityId);
      if (ids.length) await tx.$queryRaw`SELECT tms_sample_flag(${t}, ${ids}::uuid[])`;
    }
    await tx.$executeRaw`SELECT set_config('tms.suppress_outbox', 'off', true)`;
    const after = await this.status(tx);
    await this.audit.record({
      action: 'sample_data.loaded',
      entityType: 'tenant',
      entityId: ctx.tenantId!,
      after: { counts: after.counts },
    });
    return after;
  }

  async clear(): Promise<SampleClearResult> {
    const tx = this.db.tx;
    await lockKey(tx, 'sample_data');
    // ป้ายของแถวที่อาจคงไว้ — อ่านก่อนลบ (หลังลบอ่านไม่ได้แล้ว)
    const labels = await this.labels(tx);
    const rows = await tx.$queryRaw<
      {
        entity_type: SampleEntityType;
        entity_id: string;
        removed: boolean;
        reason: string | null;
      }[]
    >`SELECT entity_type, entity_id, removed, reason FROM tms_sample_data_purge()`;
    const removed = zero();
    const removedList: SampleRemoved[] = [];
    const kept: SampleKept[] = [];
    for (const r of rows) {
      if (r.removed) {
        removed[r.entity_type] += 1;
        removedList.push({
          entityType: r.entity_type,
          id: encodeId(ID_KIND[r.entity_type], r.entity_id),
          label: labels.get(r.entity_id) ?? '',
        });
      } else
        kept.push({
          entityType: r.entity_type,
          id: encodeId(ID_KIND[r.entity_type], r.entity_id),
          label: labels.get(r.entity_id) ?? '',
          reason: 'in_use',
        });
    }
    const after = await this.status(tx);
    if (rows.length)
      await this.audit.record({
        action: 'sample_data.cleared',
        entityType: 'tenant',
        entityId: requestContext.require().tenantId!,
        after: {
          removed: removedList.map((k) => ({ type: k.entityType, id: k.id, label: k.label })),
          kept: kept.map((k) => ({
            type: k.entityType,
            id: k.id,
            label: k.label,
            reason: k.reason,
          })),
        },
      });
    return { ...after, removed, kept };
  }

  private async counts(tx: Tx): Promise<SampleCounts> {
    const g = await tx.sampleRecord.groupBy({ by: ['entityType'], _count: { _all: true } });
    const out = zero();
    for (const r of g) out[r.entityType as SampleEntityType] = r._count._all;
    return out;
  }

  /** รหัส/ชื่อที่ผู้ใช้จำได้ของแถวตัวอย่างทุกแถว */
  private async labels(tx: Tx): Promise<Map<string, string>> {
    const ids = async (t: SampleEntityType) => ({ id: { in: await this.ids(t, tx) } });
    const m = new Map<string, string>();
    const put = (id: string, ...parts: (string | null | undefined)[]) =>
      m.set(id, parts.filter(Boolean).join(' '));
    for (const r of await tx.customer.findMany({
      where: await ids('customer'),
      select: { id: true, code: true, legalName: true },
    }))
      put(r.id, r.code, r.legalName);
    for (const r of await tx.customerSite.findMany({
      where: await ids('customer_site'),
      select: { id: true, code: true, name: true },
    }))
      put(r.id, r.code, r.name);
    for (const r of await tx.carrier.findMany({
      where: await ids('carrier'),
      select: { id: true, code: true, legalName: true },
    }))
      put(r.id, r.code, r.legalName);
    for (const r of await tx.vehicle.findMany({
      where: await ids('vehicle'),
      select: { id: true, plate: true },
    }))
      put(r.id, r.plate);
    for (const r of await tx.driver.findMany({
      where: await ids('driver'),
      select: { id: true, code: true, name: true },
    }))
      put(r.id, r.code, r.name);
    for (const r of await tx.rateCard.findMany({
      where: await ids('rate_card'),
      select: { id: true, code: true },
    }))
      put(r.id, r.code);
    for (const r of await tx.salesOrder.findMany({
      where: await ids('sales_order'),
      select: { id: true, soNo: true, customerRef: true },
    }))
      put(r.id, r.soNo ?? r.customerRef);
    return m;
  }
}

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
