import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { estimatePlanCharge, planForVehicles } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetPublicRateLimit } from '../src/http/public-rate-limit.middleware';
import { bootApp, truncateAll } from './helpers';

/**
 * P1-ST2-T02: `GET /v1/public/plans` — หน้าราคาสาธารณะ (spec/01 §2 ข้อ 3, PLT-002)
 * เกณฑ์ตรวจรับ (plan/13): รถ 30 คัน → ราคาบนเครื่องคำนวณ = ผลจาก domain (รวมขั้นต่ำ + รายปี) ·
 * เซลล์ตารางเปรียบเทียบ (✓ / ซื้อเพิ่ม / ตัวเลข / —) มาจาก matrix · ซ่อนเมื่อ `pricing.publicVisible = false`
 * แคตตาล็อกเป็นข้อมูลอ้างอิง → แพ็กเกจทดสอบชั่วคราว (`tp_`) ลบด้วย role เจ้าของตารางตอนจบ
 */
describe('หน้าราคาสาธารณะ GET /v1/public/plans (P1-ST2-T02)', () => {
  let app: NestExpressApplication;
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const tag = randomUUID().slice(0, 6);
  const P = { shown: `tp_pub_${tag}`, hidden: `tp_hid_${tag}`, future: `tp_fut_${tag}` };
  const get = () => request(app.getHttpServer()).get('/v1/public/plans');
  const setVisible = (v: boolean) =>
    owner.platformSetting.upsert({
      where: { key: 'pricing.publicVisible' },
      create: { key: 'pricing.publicVisible', value: v },
      update: { value: v },
    });

  async function dropTemp() {
    const where = { code: { in: Object.values(P) } };
    await owner.planVersion.deleteMany({ where: { planCode: where.code } });
    await owner.plan.deleteMany({ where });
  }

  /** แพ็กเกจทดสอบ + เวอร์ชัน (insert เป็น draft ใส่สิทธิ์ แล้วค่อย publish — guard 0175/0177) */
  async function mkPlan(code: string, showOnWeb: boolean, effectiveFrom: Date, publish = true) {
    await owner.plan.create({
      data: { code, nameTh: `ทดสอบ ${code}`, sortOrder: 90, showOnWeb },
    });
    const v = await owner.planVersion.create({
      data: {
        planCode: code,
        version: 1,
        status: 'draft',
        pricePerVehicleMonthly: '100.00',
        minimumMonthly: '1000.00',
        annualDiscountPct: '10.00',
        vehicleMin: 1,
        vehicleMax: 9,
        effectiveFrom,
      },
    });
    const feats = await owner.feature.findMany();
    await owner.planEntitlement.createMany({
      data: feats.map((f) => ({
        planVersionId: v.id,
        featureKey: f.key,
        mode: f.isBasic ? 'included' : f.key === 'portal' ? 'addon' : 'not_available',
        limit: f.key === 'cf' ? 7 : null,
      })),
    });
    // cf ต้อง included ถึงจะเป็นตัวเลข (not_available = —)
    await owner.planEntitlement.update({
      where: { planVersionId_featureKey: { planVersionId: v.id, featureKey: 'cf' } },
      data: { mode: 'included' },
    });
    if (publish)
      await owner.planVersion.update({
        where: { id: v.id },
        data: { status: 'published', publishedAt: new Date() },
      });
    return v.id;
  }

  beforeAll(async () => {
    await truncateAll();
    await dropTemp();
    app = await bootApp();
    await mkPlan(P.shown, true, new Date(Date.now() - 60_000));
    await mkPlan(P.hidden, false, new Date(Date.now() - 60_000));
    await mkPlan(P.future, true, new Date(Date.now() + 86_400_000));
  });
  afterAll(async () => {
    await app.close();
    await dropTemp();
    await owner.platformSetting.deleteMany({});
    await owner.$disconnect();
  });

  it('ค่าเริ่ม pricing.publicVisible = false → 404 (ซ่อนทั้งหน้า) · no-store', async () => {
    await owner.platformSetting.deleteMany({ where: { key: 'pricing.publicVisible' } });
    const r = await get().expect(404);
    expect(r.headers['content-type']).toMatch(/problem\+json/);
    expect(r.headers['cache-control']).toBe('no-store');
    await setVisible(false);
    await get().expect(404);
  });

  it('เปิดแล้ว: เฉพาะ showOnWeb + เวอร์ชัน published ที่ถึงวันมีผล · เรียงตาม sortOrder · ไม่รวม VAT', async () => {
    await setVisible(true);
    const b = (await get().expect(200)).body;
    const codes = b.plans.map((p: { code: string }) => p.code);
    expect(codes).toEqual(['start', 'std', 'biz', 'ent', P.shown]);
    expect(b).toMatchObject({
      currency: 'THB',
      vatMode: 'exclusive',
      provisional: true,
      retentionDays: 90,
      subconWeight: '1.00',
      trialDays: 30,
    });
    // docs/02 §2 ราคาตั้งต้น (seed 0175)
    expect(b.plans[1]).toMatchObject({
      code: 'std',
      nameTh: 'Growth',
      badge: 'นิยม',
      version: 1,
      pricePerVehicleMonthly: '280.00',
      minimumMonthly: '4500.00',
      annualDiscountPct: '15.00',
      vehicleMin: 16,
      vehicleMax: 60,
      trialDays: 30,
      provisional: true,
      isContactSales: false,
    });
    expect(b.plans[3]).toMatchObject({
      code: 'ent',
      pricePerVehicleMonthly: null,
      isContactSales: true,
    });
  });

  it('draft ไม่แสดง: แพ็กเกจที่มี draft v2 ยังแสดง v1', async () => {
    const id = (
      await owner.planVersion.create({
        data: {
          planCode: P.shown,
          version: 2,
          status: 'draft',
          pricePerVehicleMonthly: '1.00',
          effectiveFrom: new Date(),
        },
      })
    ).id;
    const b = (await get().expect(200)).body;
    const p = b.plans.find((x: { code: string }) => x.code === P.shown);
    expect(p).toMatchObject({ version: 1, pricePerVehicleMonthly: '100.00' });
    await owner.planVersion.delete({ where: { id } });
  });

  it('เซลล์ตารางเปรียบเทียบมาจาก plan_entitlement ของเวอร์ชันที่มีผล (✓ / ซื้อเพิ่ม / ตัวเลข / ไม่จำกัด / —)', async () => {
    const b = (await get().expect(200)).body;
    const col = (code: string) => b.plans.findIndex((p: { code: string }) => p.code === code);
    const cell = (key: string, code: string) =>
      b.features.find((f: { key: string }) => f.key === key).cells[col(code)];
    // ทุกเซลล์ตรงกับ matrix ในฐาน (เวอร์ชัน 1 ของ 4 แพ็กเกจ seed)
    const ents = await owner.planEntitlement.findMany({
      include: { planVersion: true, feature: true },
      where: { planVersion: { planCode: { in: ['start', 'std', 'biz', 'ent'] }, version: 1 } },
    });
    expect(ents.length).toBeGreaterThan(0);
    for (const e of ents) {
      const c = cell(e.featureKey, e.planVersion.planCode);
      const want =
        e.mode === 'not_available'
          ? { kind: 'no', limit: null }
          : e.mode === 'addon'
            ? { kind: 'addon', limit: null }
            : e.feature.type === 'boolean'
              ? { kind: 'yes', limit: null }
              : e.limit === null
                ? { kind: 'unlimited', limit: null }
                : { kind: 'limit', limit: e.limit };
      expect(c, `${e.featureKey}/${e.planVersion.planCode}`).toEqual(want);
    }
    // ตัวอย่างตามชนิดเซลล์
    expect(cell('settle', 'start')).toEqual({ kind: 'yes', limit: null }); // พื้นฐานทุกแพ็กเกจ (R-07)
    expect(cell('track', 'start')).toEqual({ kind: 'no', limit: null });
    expect(cell('fleetx', 'std')).toEqual({ kind: 'addon', limit: null });
    expect(cell('api', 'std')).toEqual({ kind: 'limit', limit: 300 });
    expect(cell('conn', 'ent')).toEqual({ kind: 'unlimited', limit: null });
    // แพ็กเกจทดสอบ
    expect(cell('portal', P.shown)).toEqual({ kind: 'addon', limit: null });
    expect(cell('cf', P.shown)).toEqual({ kind: 'limit', limit: 7 });
    expect(cell('multi', P.shown)).toEqual({ kind: 'no', limit: null });
    // ทุกฟีเจอร์มีเซลล์ครบทุกคอลัมน์
    for (const f of b.features) expect(f.cells).toHaveLength(b.plans.length);
  });

  it.each([
    // [รถ, รอบ, แพ็กเกจที่ช่วงรถครอบ, ต่อเดือน, ต่อปี]
    [30, 'monthly', 'std', '8400.00', '100800.00'],
    [30, 'annual', 'std', '7140.00', '85680.00'],
    [5, 'monthly', 'start', '2500.00', '30000.00'], // ขั้นต่ำ
    [5, 'annual', 'start', '2125.00', '25500.00'], // ขั้นต่ำ − 15%
    [61, 'monthly', 'biz', '13500.00', '162000.00'], // ขั้นต่ำ
  ] as const)(
    'เครื่องคำนวณ: %i คัน %s → แพ็กเกจ %s = domain (%s / เดือน)',
    async (n, cycle, code, monthly, yearly) => {
      const b = (await get().expect(200)).body;
      const seed = b.plans.filter((p: { code: string }) => !p.code.startsWith('tp_'));
      const plan = planForVehicles(
        seed as { code: string; vehicleMin: number; vehicleMax: number | null }[],
        n,
      )!;
      expect(plan.code).toBe(code);
      const e = estimatePlanCharge(
        b.plans.find((p: { code: string }) => p.code === code),
        n,
        cycle,
      )!;
      expect([e.monthly, e.yearly]).toEqual([monthly, yearly]);
    },
  );

  it('ราคาเป็นข้อมูล: ปิด publicVisible อีกครั้ง → 404 ทันที (ไม่มี cache)', async () => {
    await setVisible(false);
    await get().expect(404);
    await setVisible(true);
    await get().expect(200);
  });

  it('rate limit ต่อ IP ของ /v1/public/* (429)', async () => {
    await resetPublicRateLimit();
    let last = 200;
    // เพดาน dev/test = 120/นาที/IP
    for (let i = 0; i < 125 && last !== 429; i++) last = (await get()).status;
    expect(last).toBe(429);
    await resetPublicRateLimit();
  });
});
