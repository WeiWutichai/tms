import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../src/common/clock';
import { DbService } from '../src/db/db.service';
import { JobQueue } from '../src/jobs/job-queue.service';
import {
  addMonths,
  dueLines,
  fromSatang,
  monthlyAmount,
  toSatang,
} from '../src/modules/depreciation/depreciation-policy';
import {
  DEPRECIATION_JOB,
  DepreciationService,
  closedMonth,
} from '../src/modules/depreciation/depreciation.service';
import { bootApp, createTenant, platform, truncateAll } from './helpers';

const sum = (xs: string[]) => fromSatang(xs.reduce((a, x) => a + toSatang(x), 0n));

/** กติกาเงิน/เดือน (ฟังก์ชันบริสุทธิ์) — spec/06 FLT-004, backlog ST2-T22 */
describe('ค่าเสื่อมเส้นตรง: กติกา (ST2-T22)', () => {
  const base = {
    purchaseCost: '1200000.00',
    salvageValue: null,
    years: 5,
    purchasedOn: '2026-01-15',
    retiredMonth: null,
  };
  it('เกณฑ์ตรวจรับ: ยอด/เดือน = ราคาซื้อ ÷ (N × 12) — หารลงตัว ทุกเดือนเท่ากัน รวม = ราคาซื้อ', () => {
    const lines = dueLines(base, '2035-12', new Map());
    expect(lines).toHaveLength(60);
    expect(new Set(lines.map((l) => l.amount))).toEqual(new Set(['20000.00']));
    expect(lines[0]).toMatchObject({ month: '2026-01', index: 1, total: 60 });
    expect(lines.at(-1)).toMatchObject({ month: '2030-12', index: 60 });
    expect(sum(lines.map((l) => l.amount))).toBe('1200000.00');
  });
  it('หารไม่ลงตัว: ปัดครึ่งขึ้นเป็นสตางค์ · เดือนสุดท้ายรับเศษ → รวม = ฐานพอดี', () => {
    const i = { ...base, purchaseCost: '1000000.00' };
    expect(monthlyAmount(i)).toBe('16666.67'); // 16,666.666…
    const lines = dueLines(i, '2040-01', new Map());
    expect(lines.slice(0, 59).every((l) => l.amount === '16666.67')).toBe(true);
    expect(lines[59]!.amount).toBe('16666.47'); // 1,000,000 − 59 × 16,666.67
    expect(sum(lines.map((l) => l.amount))).toBe('1000000.00');
    // ปัดลง: 100,000.01 ÷ 12 = 8,333.334… → 8,333.33; เดือนสุดท้าย 8,333.38
    const j = dueLines({ ...base, purchaseCost: '100000.01', years: 1 }, '2030-01', new Map());
    expect(j.slice(0, 11).every((l) => l.amount === '8333.33')).toBe(true);
    expect(j[11]!.amount).toBe('8333.38');
    expect(sum(j.map((l) => l.amount))).toBe('100000.01');
    // ครึ่งพอดีปัดขึ้น: 0.18 ÷ 12 = 0.015 → 0.02
    expect(monthlyAmount({ purchaseCost: '0.18', salvageValue: null, years: 1 })).toBe('0.02');
  });
  it('มีมูลค่าซาก: ฐาน = ราคาซื้อ − ซาก (spec/06 ตัวอย่าง 2,400,000 / ซาก 400,000 / 120 เดือน = 16,666.67)', () => {
    const i = { ...base, purchaseCost: '2400000.00', salvageValue: '400000.00', years: 10 };
    expect(monthlyAmount(i)).toBe('16666.67');
    const lines = dueLines(i, '2099-12', new Map());
    expect(lines).toHaveLength(120);
    expect(sum(lines.map((l) => l.amount))).toBe('2000000.00');
    // ซาก = ราคาซื้อ → ไม่มีค่าเสื่อม
    expect(dueLines({ ...i, salvageValue: '2400000.00' }, '2099-12', new Map())).toEqual([]);
  });
  it('เริ่มเดือนที่ซื้อ (ซื้อวันสุดท้ายของเดือนก็คิดเต็มเดือน) · คิดถึงเดือน through เท่านั้น', () => {
    const lines = dueLines({ ...base, purchasedOn: '2026-03-31' }, '2026-05', new Map());
    expect(lines.map((l) => l.month)).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(dueLines({ ...base, purchasedOn: '2026-06-01' }, '2026-05', new Map())).toEqual([]);
  });
  it('ปลดระวาง: คิดถึงเดือนที่ปลด (รวม) แล้วหยุด — ไม่เกลี่ยยอดคงเหลือ', () => {
    const lines = dueLines({ ...base, retiredMonth: '2026-04' }, '2027-12', new Map());
    expect(lines.map((l) => l.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(lines.every((l) => l.amount === '20000.00')).toBe(true);
  });
  it('เดือนที่ลงแล้วไม่ลงซ้ำ · เดือนที่ขาดตรงกลางลงย้อน · ลดราคาซื้อ → เกลี่ยยอดคงเหลือ รวม = ฐานใหม่', () => {
    const posted = new Map([
      ['2026-01', '20000.00'],
      ['2026-03', '20000.00'],
    ]);
    expect(dueLines(base, '2026-04', posted).map((l) => l.month)).toEqual(['2026-02', '2026-04']);
    // ราคาซื้อแก้เหลือ 50,000 หลังลงไป 2 เดือน (40,000) → เหลือ 10,000 เกลี่ยให้ 58 เดือนที่เหลือ
    const cut = dueLines({ ...base, purchaseCost: '50000.00' }, '2035-12', posted);
    expect(cut).toHaveLength(58);
    expect(cut[0]!.amount).toBe('169.49'); // 10,000 ÷ 59 เดือนที่เหลือ (ก.พ. 2026 … ธ.ค. 2030)
    expect(cut.at(-1)!.month).toBe('2030-12');
    expect(sum(cut.map((l) => l.amount))).toBe('10000.00');
    // ลงไปเกินฐานใหม่แล้ว → ไม่ลงเพิ่ม (ไม่กลับรายการส่วนเกิน)
    expect(dueLines({ ...base, purchaseCost: '30000.00' }, '2035-12', posted)).toEqual([]);
  });
  const firstYear = new Map(
    Array.from({ length: 12 }, (_, k) => [addMonths('2026-01', k), '20000.00'] as const),
  );
  it('แก้กลางอายุ — ลดอายุ: เกลี่ยยอดคงเหลือให้เดือนที่เหลือ · อายุจบไปแล้ว → ลงยอดคงเหลือก้อนเดียวในเดือนแรกที่ยังไม่ลง', () => {
    // 5 ปี → 2 ปี หลังลงไป 12 เดือน (240,000): เหลือ 960,000 ÷ 12 เดือน = 80,000
    const two = dueLines({ ...base, years: 2 }, '2028-12', firstYear);
    expect(two).toHaveLength(12);
    expect(two.every((l) => l.amount === '80000.00' && !l.catchUp)).toBe(true);
    expect(two.at(-1)!.month).toBe('2027-12');
    // 5 ปี → 1 ปี: อายุจบ ธ.ค. 2026 แล้ว → 960,000 ลง ม.ค. 2027 (catchUp) แถวเดียว
    const one = dueLines({ ...base, years: 1 }, '2027-03', firstYear);
    expect(one).toEqual([
      { month: '2027-01', index: 12, total: 12, amount: '960000.00', catchUp: true },
    ]);
  });
  it('แก้กลางอายุ — ขึ้นราคาซื้อ: ส่วนเพิ่มเกลี่ยให้เดือนที่เหลือ รวม = ฐานใหม่', () => {
    const up = dueLines({ ...base, purchaseCost: '1440000.00' }, '2035-12', firstYear);
    expect(up).toHaveLength(48);
    expect(up.every((l) => l.amount === '25000.00')).toBe(true); // 1,200,000 ÷ 48
    expect(sum(up.map((l) => l.amount))).toBe('1200000.00');
  });
  it('แก้กลางอายุ — เลื่อนวันซื้อเร็วขึ้น: ลงย้อนเดือนก่อนหน้า + เกลี่ยใหม่ จบเดือนสุดท้ายของอายุใหม่ รวม = ฐาน', () => {
    const six = new Map(
      Array.from({ length: 6 }, (_, k) => [addMonths('2026-01', k), '20000.00'] as const),
    );
    const early = dueLines({ ...base, purchasedOn: '2025-07-01' }, '2035-12', six);
    expect(early.slice(0, 6).map((l) => [l.month, l.amount])).toEqual(
      ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'].map((m) => [
        m,
        '18000.00',
      ]),
    );
    expect(early.at(-1)!.month).toBe('2030-06');
    expect(early.some((l) => l.catchUp)).toBe(false);
    expect(sum([...six.values(), ...early.map((l) => l.amount)])).toBe('1200000.00');
  });
  it('ยอด/เดือนปัดได้ 0.00 → ไม่ลงแถว ยอดไปลงเดือนสุดท้าย', () => {
    const tiny = dueLines({ ...base, purchaseCost: '0.05', years: 1 }, '2030-01', new Map());
    expect(tiny).toEqual([
      { month: '2026-12', index: 12, total: 12, amount: '0.05', catchUp: false },
    ]);
  });
  it('เดือนที่ปิดล่าสุด: ก่อนวันที่ 1 เวลา 02:00 น. ไทย ยังเป็นเดือนก่อนหน้านั้น', () => {
    expect(closedMonth(new Date('2026-11-30T18:59:00Z'))).toBe('2026-10'); // 1 ธ.ค. 01:59 ไทย
    expect(closedMonth(new Date('2026-11-30T19:00:00Z'))).toBe('2026-11'); // 1 ธ.ค. 02:00 ไทย
    expect(closedMonth(new Date('2027-01-01T00:00:00Z'))).toBe('2026-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
  });
});

/** ST2-T22: job รายเดือนลง vehicle_cost หมวด DEPRECIATION */
describe('ค่าเสื่อม: job รายเดือน (ST2-T22)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let svc: DepreciationService;
  let queue: JobQueue;
  let dbs: DbService;
  let clock: Clock;
  let tA: string;
  let tB: string;
  let vtA: string;
  let vtB: string;
  let carrierA: string;
  let n = 0;

  const date = (d: string) => new Date(`${d}T00:00:00Z`);
  /** วันที่ 1 ของเดือนถัดจาก `m` เวลา 02:00 น. ไทย */
  const runAt = (m: string) => new Date(`${addMonths(m, 1)}-01T02:00:00+07:00`);

  async function vehicle(
    tenantId: string,
    vehicleTypeId: string,
    extra: Partial<Prisma.VehicleUncheckedCreateInput> = {},
  ) {
    const plate = `70-${1000 + ++n}`;
    return db.vehicle.create({
      data: {
        tenantId,
        plate,
        plateProvince: 'TH-10',
        plateKey: `${plate.replace(/\D/g, '')}|TH-10`,
        plateNorm: plate.replace(/\D/g, ''),
        vehicleTypeId,
        ownership: 'OWN',
        purchaseCost: new Prisma.Decimal('1200000.00'),
        purchasedOn: date('2026-01-10'),
        depreciationMethod: 'STRAIGHT_LINE',
        depreciationYears: 5,
        ...extra,
      },
    });
  }
  const rows = (vehicleId: string) =>
    db.vehicleCost.findMany({
      where: { vehicleId, category: 'DEPRECIATION' },
      orderBy: { periodMonth: 'asc' },
    });
  /** เดินเวลาไปต้นเดือนถัดจาก `m` แล้วให้ worker ทำงาน: scheduleDue → รัน job ที่ค้างจนหมด */
  async function runMonth(m: string) {
    clock.set(runAt(m));
    const created = await svc.scheduleDue();
    while (await queue.runOnce());
    return created;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    svc = app.get(DepreciationService);
    queue = app.get(JobQueue);
    dbs = app.get(DbService);
    clock = app.get(Clock);
    tA = (await createTenant(db, 'ขนส่ง ก')).id;
    tB = (await createTenant(db, 'ขนส่ง ข')).id;
    const vt = (tenantId: string) =>
      db.vehicleType.create({
        data: { tenantId, code: `VT-${++n}`, nameTh: `6 ล้อ ${n}`, vehicleClass: '6W' },
      });
    vtA = (await vt(tA)).id;
    vtB = (await vt(tB)).id;
    carrierA = (
      await db.carrier.create({
        data: {
          tenantId: tA,
          code: 'SUB-1',
          legalName: 'หจก. รถร่วม ทดสอบ',
          entityType: 'JURISTIC',
        },
      })
    ).id;
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.job.deleteMany({});
    await db.tenant.updateMany({ data: { status: 'ACTIVE' } });
    // รถของ test ก่อนหน้าไม่ให้มาปน — ปลดออกจากการคิดค่าเสื่อม (vehicle_cost ลบไม่ได้ตามออกแบบ)
    await db.vehicle.updateMany({ data: { depreciationMethod: null, depreciationYears: null } });
  });
  afterAll(async () => {
    clock.set(null);
    await app.close();
    await db.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: รัน job เดือนเดียวกันซ้ำไม่เกิดแถวซ้ำ · ยอด = ราคาซื้อ ÷ (N × 12)', async () => {
    const v = await vehicle(tA, vtA);
    expect(await runMonth('2026-01')).toBe(2); // tenant ก + ข
    let r = await rows(v.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      tenantId: tA,
      category: 'DEPRECIATION',
      sourceType: 'depreciation',
      note: 'ค่าเสื่อมเส้นตรง เดือนที่ 1/60',
    });
    expect(r[0]!.amount.toFixed(2)).toBe('20000.00'); // 1,200,000 ÷ (5 × 12)
    expect(r[0]!.periodMonth!.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(r[0]!.occurredOn.toISOString().slice(0, 10)).toBe('2026-01-31');
    // worker เรียกซ้ำในเดือนเดียวกัน → ไม่สร้าง job ใหม่
    expect(await svc.scheduleDue()).toBe(0);
    // สั่ง job เดือนเดียวกันซ้ำตรง ๆ → ไม่เกิดแถวเพิ่ม
    await db.$transaction((tx) =>
      queue.enqueue(tx as never, {
        tenantId: tA,
        type: DEPRECIATION_JOB,
        payload: { through: '2026-01' },
      }),
    );
    while (await queue.runOnce());
    const again = await svc.runForTenant(tA, '2026-01');
    expect(again.rows).toBe(0);
    r = await rows(v.id);
    expect(r).toHaveLength(1);
  });

  it('พร้อมกัน: สอง worker รันเดือนเดียวกันพร้อมกัน → แถวชุดเดียว (advisory lock ต่อรถ + unique)', async () => {
    const vs = await Promise.all(
      [1, 2, 3].map(() => vehicle(tA, vtA, { purchasedOn: date('2026-03-05') })),
    );
    const results = await Promise.all([1, 2, 3, 4].map(() => svc.runForTenant(tA, '2026-08')));
    expect(results.reduce((a, r) => a + r.rows, 0)).toBe(3 * 6);
    for (const v of vs) {
      const r = await rows(v.id);
      expect(r.map((x) => x.periodMonth!.toISOString().slice(0, 7))).toEqual([
        '2026-03',
        '2026-04',
        '2026-05',
        '2026-06',
        '2026-07',
        '2026-08',
      ]);
    }
    // สอง worker สร้าง job พร้อมกัน → ชิ้นเดียวต่อ tenant
    clock.set(runAt('2026-08'));
    const made = await Promise.all([svc.scheduleDue(), svc.scheduleDue()]);
    expect(made.sort()).toEqual([0, 2]);
  });

  it('unique ระดับฐาน: เขียนแถว DEPRECIATION เดือนเดิมซ้ำตรง ๆ → ชน · หมวดอื่นต้องไม่มี period_month', async () => {
    const v = await vehicle(tA, vtA);
    await svc.runForTenant(tA, '2026-01');
    const dup = dbs.withTenant(tA, (tx) =>
      tx.vehicleCost.create({
        data: {
          tenantId: tA,
          vehicleId: v.id,
          category: 'DEPRECIATION',
          amount: '1.00',
          periodMonth: date('2026-01-01'),
          occurredOn: date('2026-01-31'),
        },
      }),
    );
    await expect(dup).rejects.toThrow();
    const noPeriod = dbs.withTenant(tA, (tx) =>
      tx.vehicleCost.create({
        data: {
          tenantId: tA,
          vehicleId: v.id,
          category: 'DEPRECIATION',
          amount: '1.00',
          occurredOn: date('2026-02-28'),
        },
      }),
    );
    await expect(noPeriod).rejects.toThrow();
    const midMonth = dbs.withTenant(tA, (tx) =>
      tx.vehicleCost.create({
        data: {
          tenantId: tA,
          vehicleId: v.id,
          category: 'DEPRECIATION',
          amount: '1.00',
          periodMonth: date('2026-02-15'),
          occurredOn: date('2026-02-28'),
        },
      }),
    );
    await expect(midMonth).rejects.toThrow();
    const docWithPeriod = dbs.withTenant(tA, (tx) =>
      tx.vehicleCost.create({
        data: {
          tenantId: tA,
          vehicleId: v.id,
          category: 'DOCUMENT',
          amount: '1.00',
          periodMonth: date('2026-02-01'),
          occurredOn: date('2026-02-28'),
        },
      }),
    );
    await expect(docWithPeriod).rejects.toThrow();
  });

  it('เลื่อนเวลา: job รายเดือนลงเดือนละแถว · worker หยุดไป 3 เดือน → ลงย้อนครบ · หมดอายุแล้วหยุด รวม = ฐานพอดี', async () => {
    const v = await vehicle(tA, vtA, {
      purchaseCost: new Prisma.Decimal('100000.01'),
      purchasedOn: date('2026-02-20'),
      depreciationYears: 1,
    });
    await runMonth('2026-01'); // ก่อนซื้อ
    expect(await rows(v.id)).toHaveLength(0);
    await runMonth('2026-02');
    await runMonth('2026-03');
    expect((await rows(v.id)).map((r) => r.amount.toFixed(2))).toEqual(['8333.33', '8333.33']);
    // worker ไม่ได้รัน เม.ย.–มิ.ย. → รอบ ก.ค. ลงย้อน 4 เดือน
    await runMonth('2026-07');
    expect(await rows(v.id)).toHaveLength(6);
    for (const m of [
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
    ])
      await runMonth(m);
    const r = await rows(v.id);
    expect(r).toHaveLength(12);
    expect(r.at(-1)!.periodMonth!.toISOString().slice(0, 7)).toBe('2027-01');
    expect(r.at(-1)!.amount.toFixed(2)).toBe('8333.38');
    expect(sum(r.map((x) => x.amount.toFixed(2)))).toBe('100000.01');
  });

  it('เลือกรถ: เฉพาะรถบริษัทที่ตั้งเส้นตรง + ราคาซื้อ + วันซื้อ + อายุ · รถร่วม/ลบแล้ว/ไม่ตั้งค่า/ไม่มีวันซื้อ = ไม่ลง', async () => {
    const own = await vehicle(tA, vtA);
    const sub = await vehicle(tA, vtA, { ownership: 'SUBCONTRACT', carrierId: carrierA });
    const deleted = await vehicle(tA, vtA, { deletedAt: new Date() });
    const none = await vehicle(tA, vtA, { depreciationMethod: null, depreciationYears: null });
    const noDate = await vehicle(tA, vtA, { purchasedOn: null });
    const r = await svc.runForTenant(tA, '2026-02');
    expect(r).toMatchObject({ vehicles: 1, rows: 2, incomplete: 1, failed: 0 });
    expect(await rows(own.id)).toHaveLength(2);
    for (const v of [sub, deleted, none, noDate]) expect(await rows(v.id)).toHaveLength(0);
  });

  it('ปลดระวาง: คิดถึงเดือนที่ปลด (เวลาไทย) แล้วหยุด', async () => {
    // ปลด 1 พ.ค. 2026 00:30 น. ไทย = 30 เม.ย. 17:30Z → เดือนที่ปลด = พ.ค.
    const v = await vehicle(tA, vtA, {
      status: 'RETIRED',
      retiredAt: new Date('2026-04-30T17:30:00Z'),
    });
    await runMonth('2026-12');
    expect((await rows(v.id)).map((r) => r.periodMonth!.toISOString().slice(0, 7))).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
    ]);
  });

  it('tenant ถูกระงับ: ไม่สร้าง job · ระงับหลังสร้าง job แล้ว → handler ข้าม (ตรวจซ้ำตอนรัน)', async () => {
    const vA = await vehicle(tA, vtA);
    const vB = await vehicle(tB, vtB);
    await db.tenant.update({ where: { id: tB }, data: { status: 'SUSPENDED' } });
    clock.set(runAt('2026-01'));
    expect(await svc.scheduleDue()).toBe(1);
    // job ของ tenant ก ถูกสร้างแล้ว แต่ระงับก่อนรัน
    await db.tenant.update({ where: { id: tA }, data: { status: 'SUSPENDED' } });
    while (await queue.runOnce());
    expect(await rows(vA.id)).toHaveLength(0);
    expect(await rows(vB.id)).toHaveLength(0);
    const job = await db.job.findFirstOrThrow({ where: { tenantId: tA, type: DEPRECIATION_JOB } });
    expect(job.status).toBe('SUCCEEDED');
    expect(job.result).toMatchObject({ skipped: 'tenant_inactive' });
    // กลับมา ACTIVE → เดือนถัดไปลงย้อนเดือนที่ขาด
    await db.tenant.update({ where: { id: tA }, data: { status: 'ACTIVE' } });
    await runMonth('2026-02');
    expect(await rows(vA.id)).toHaveLength(2);
  });

  it('แยก tenant: job ของ tenant ก ไม่ลงรถของ ข · tenant ข มองไม่เห็นแถวของ ก (RLS)', async () => {
    const vA = await vehicle(tA, vtA);
    const vB = await vehicle(tB, vtB);
    await svc.runForTenant(tA, '2026-03');
    expect(await rows(vA.id)).toHaveLength(3);
    expect(await rows(vB.id)).toHaveLength(0);
    const seenByB = await dbs.withTenant(tB, (tx) =>
      tx.vehicleCost.findMany({ where: { vehicleId: vA.id } }),
    );
    expect(seenByB).toHaveLength(0);
    // tenant ข เขียนแถวให้รถของ ก ไม่ได้ (RLS WITH CHECK / FK มองไม่เห็นรถ)
    const cross = dbs.withTenant(tB, (tx) =>
      tx.vehicleCost.create({
        data: {
          tenantId: tA,
          vehicleId: vA.id,
          category: 'DEPRECIATION',
          amount: '1.00',
          periodMonth: date('2026-09-01'),
          occurredOn: date('2026-09-30'),
        },
      }),
    );
    await expect(cross).rejects.toThrow();
  });

  it('แก้กลางอายุ (เลื่อนเวลา): ขึ้นราคา → เกลี่ยเดือนที่เหลือ · ลดอายุจนจบแล้ว → ลงยอดคงเหลือก้อนเดียว รวม = ฐานใหม่', async () => {
    const v = await vehicle(tA, vtA);
    await runMonth('2026-06'); // ม.ค.–มิ.ย. × 20,000
    await db.vehicle.update({ where: { id: v.id }, data: { purchaseCost: '1440000.00' } });
    await runMonth('2026-07');
    let r = await rows(v.id);
    expect(r.at(-1)!.amount.toFixed(2)).toBe('24444.44'); // (1,440,000 − 120,000) ÷ 54
    await db.vehicle.update({ where: { id: v.id }, data: { depreciationYears: 1 } }); // อายุจบ ธ.ค. 2026
    await runMonth('2026-12');
    await runMonth('2027-01');
    r = await rows(v.id);
    expect(r.map((x) => x.periodMonth!.toISOString().slice(0, 7)).at(-1)).toBe('2026-12');
    expect(r.at(-1)!.note).toBe('ค่าเสื่อมเส้นตรง เดือนที่ 12/12');
    expect(sum(r.map((x) => x.amount.toFixed(2)))).toBe('1440000.00');
    // ลดอายุหลังอายุใหม่จบไปแล้ว → เดือนแรกที่ยังไม่ลงรับยอดคงเหลือทั้งก้อน
    const w = await vehicle(tA, vtA);
    await runMonth('2027-02'); // ลงครบ 14 เดือน (280,000)
    await db.vehicle.update({ where: { id: w.id }, data: { depreciationYears: 1 } });
    await runMonth('2027-03');
    const rw = await rows(w.id);
    expect(rw).toHaveLength(15);
    expect(rw.at(-1)).toMatchObject({ note: 'ค่าเสื่อมคงเหลือหลังครบอายุ 12 เดือน' });
    expect(rw.at(-1)!.amount.toFixed(2)).toBe('920000.00');
    expect(rw.at(-1)!.periodMonth!.toISOString().slice(0, 7)).toBe('2027-03');
  });

  it('job ของเดือนที่ล้มถาวร (FAILED) สร้างใหม่ได้ไม่เกินวันละครั้ง', async () => {
    clock.set(runAt('2026-05'));
    const failed = await db.job.create({
      data: {
        tenantId: tA,
        type: DEPRECIATION_JOB,
        payload: { through: '2026-05' },
        status: 'FAILED',
      },
    });
    await db.job.create({
      data: {
        tenantId: tB,
        type: DEPRECIATION_JOB,
        payload: { through: '2026-05' },
        status: 'SUCCEEDED',
      },
    });
    expect(await svc.scheduleDue()).toBe(0); // ล้มเมื่อครู่ → ยังไม่สร้างใหม่
    await db.job.update({
      where: { id: failed.id },
      data: { createdAt: new Date(Date.now() - 25 * 3600_000) },
    });
    expect(await svc.scheduleDue()).toBe(1); // เกิน 24 ชม. → สร้างใหม่ 1 ชิ้น (tenant ก)
    expect(await svc.scheduleDue()).toBe(0);
  });

  it('รถคันหนึ่งล้ม → คันอื่นยังลง · job ล้มเพื่อให้ลองใหม่ (คันที่ลงแล้วไม่ซ้ำ)', async () => {
    const ok = await vehicle(tA, vtA);
    const bad = await vehicle(tA, vtA);
    const real = (svc as unknown as { postVehicle: (...a: unknown[]) => Promise<number> })
      .postVehicle;
    const spy = vi
      .spyOn(svc as unknown as { postVehicle: (...a: unknown[]) => Promise<number> }, 'postVehicle')
      .mockImplementation(function (this: unknown, ...a: unknown[]) {
        if (a[2] === bad.id) return Promise.reject(new Error('boom'));
        return real.apply(svc, a);
      });
    const r = await svc.runForTenant(tA, '2026-01');
    expect(r).toMatchObject({ rows: 1, failed: 1 });
    expect(await rows(ok.id)).toHaveLength(1);
    spy.mockRestore();
    const r2 = await svc.runForTenant(tA, '2026-01');
    expect(r2).toMatchObject({ rows: 1, failed: 0 });
    expect(await rows(ok.id)).toHaveLength(1);
    expect(await rows(bad.id)).toHaveLength(1);
  });
});
