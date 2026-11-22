import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/**
 * ST9-T03 Dashboard AP รถร่วม — เกณฑ์ตรวจรับ: ตัวเลขตรงกับจำนวน settlement ตามสถานะ
 * ช่องของ dashboard (รอตรวจ = DRAFT+DISPUTED · มีรายการโต้แย้ง = DISPUTED · รออนุมัติ = SENT_TO_CARRIER · รอจ่าย = APPROVED · จ่ายแล้ว = PAID)
 * มาจาก `GET /settlements/summary` → เทียบกับ (1) นับตรงจากฐาน (query อิสระ ใช้ role เจ้าของตาราง) และ (2) จำนวนแถวของ
 * `GET /settlements?status=` (ตัวกรองเดียวกับแท็บหน้า settle) ที่เดินครบทุกหน้า · ยอดจ่ายเดือนนี้ (`prices.buy:read`) · สิทธิ์ · แยก tenant
 * ข้อมูลตั้งต้น: ใบทุกสถานะเขียนตรงลงฐาน (ข้าม trigger ลำดับสถานะด้วย session_replication_role — CHECK ยังบังคับ) เพราะทดสอบตัวนับ ไม่ใช่ flow
 * (flow อนุมัติ/จ่ายจริงทดสอบใน settlements.test.ts)
 */
describe('AP dashboard (ST9-T03)', () => {
  let app: NestExpressApplication;
  const db = platform();
  /** เจ้าของตาราง — เขียนใบสถานะต่าง ๆ ตรงลงฐาน + นับอิสระ (ไม่ผ่าน RLS/API) */
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let seq = 0;
  const today = bangkokToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  /** วันสุดท้ายของเดือนก่อน (เวลาไทย) — ใบที่จ่ายเดือนก่อนนับใน "จ่ายแล้ว" แต่ไม่นับยอดเดือนนี้ */
  const lastMonth = new Date(Date.parse(`${monthStart}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const JUR = '0105570000010';

  async function carrier(tid: string): Promise<string> {
    const c = await db.carrier.create({
      data: {
        tenantId: tid,
        code: `SUB-${String(++seq).padStart(4, '0')}`,
        legalName: `หจก. รถร่วม AP ${seq}`,
        entityType: 'JURISTIC',
        taxId: JUR,
      } as never,
    });
    return c.id;
  }

  /** ใบหนึ่งใบในสถานะที่ต้องการ (ช่องบังคับตาม CHECK ของแต่ละสถานะ) */
  async function seedSettlement(
    tid: string,
    carrierId: string,
    status: 'DRAFT' | 'SENT_TO_CARRIER' | 'DISPUTED' | 'APPROVED' | 'PAID' | 'CANCELLED',
    opts: { net?: string; wht?: string; paidDate?: string } = {},
  ) {
    const id = randomUUID();
    const n = ++seq;
    const net = opts.net ?? '0.00';
    const sent = ['SENT_TO_CARRIER', 'DISPUTED'].includes(status);
    const approved = ['APPROVED', 'PAID'].includes(status);
    const paid = status === 'PAID';
    const snap = JSON.stringify({
      code: 'SUB-AP',
      legalName: 'หจก. รถร่วม AP',
      entityType: 'JURISTIC',
      taxId: JUR,
      taxIdLast4: null,
      branchCode: '00000',
      address: null,
    });
    await owner.$transaction([
      owner.$executeRaw`SET LOCAL session_replication_role = replica`,
      owner.$executeRaw`
        INSERT INTO carrier_settlement (
          id, tenant_id, carrier_id, carrier_snapshot, period_from, period_to,
          gross_amount, deduction_amount, net_payable, status, created_by, updated_at,
          sent_at, sent_by, review_round,
          settlement_no, approved_at, approved_by,
          wht_amount, wht_minimum_amount, wht_rate_default,
          paid_date, paid_at, paid_by, payment_method,
          cancelled_at, cancelled_by, cancel_reason)
        VALUES (
          ${id}::uuid, ${tid}::uuid, ${carrierId}::uuid, ${snap}::jsonb, ${today}::date, ${today}::date,
          ${net}::numeric, 0, ${net}::numeric, ${status}, 'u-prep', now(),
          ${sent ? new Date() : null}, ${sent ? 'u-prep' : null}, ${sent ? 1 : 0},
          ${approved ? `STL-AP-${n}` : null}, ${approved ? new Date() : null}, ${approved ? 'u-appr' : null},
          ${approved ? (opts.wht ?? '0.00') : null}::numeric, ${approved ? '0.00' : null}::numeric, ${approved ? '1.00' : null}::numeric,
          ${paid ? (opts.paidDate ?? today) : null}::date, ${paid ? new Date() : null}, ${paid ? 'u-pay' : null}, ${paid ? 'CASH' : null},
          ${status === 'CANCELLED' ? new Date() : null}, ${status === 'CANCELLED' ? 'u-prep' : null},
          ${status === 'CANCELLED' ? 'ยกเลิกเพื่อทดสอบตัวนับ' : null})`,
    ]);
    return id;
  }

  /** นับอิสระจากฐาน (ไม่ผ่าน service) — ต่อสถานะของ tenant */
  async function dbCounts(tid: string): Promise<Record<string, number>> {
    const rows = await owner.$queryRaw<{ status: string; n: bigint }[]>`
      SELECT status, COUNT(*) AS n FROM carrier_settlement WHERE tenant_id = ${tid}::uuid GROUP BY status`;
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  /** จำนวนแถวของรายการเมื่อคลิกลงไป — เดินครบทุกหน้า (limit เล็กให้มีหลายหน้า) */
  async function listCount(token: string, status: string): Promise<number> {
    let cursor: string | undefined;
    const ids = new Set<string>();
    for (let guard = 0; guard < 100; guard++) {
      const r = await api(app, token)
        .get('/v1/settlements')
        .query({ status, limit: 2, sort: '-updatedAt', ...(cursor ? { cursor } : {}) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      for (const x of r.body.data as { id: string; status: string }[]) {
        expect(status.split(',')).toContain(x.status);
        ids.add(x.id);
      }
      if (!r.body.hasMore) break;
      cursor = r.body.nextCursor;
    }
    return ids.size;
  }

  /** ช่องของ dashboard → สถานะ (ชุดเดียวกับ `AP_TILES` ของเว็บ / `TAB_STATUS` หน้า settle) */
  const TILES = {
    chk: 'DRAFT,DISPUTED',
    disputed: 'DISPUTED',
    appr: 'SENT_TO_CARRIER',
    unpaid: 'APPROVED',
    paid: 'PAID',
  } as const;
  const tileOf = (s: Record<string, number>, statuses: string) => {
    const m: Record<string, string> = {
      DRAFT: 'draft',
      SENT_TO_CARRIER: 'sentToCarrier',
      DISPUTED: 'disputed',
      APPROVED: 'approved',
      PAID: 'paid',
    };
    return statuses.split(',').reduce((n, x) => n + (s[m[x]!] ?? 0), 0);
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท AP dashboard' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น AP' })).id;
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    const c1 = await carrier(tenantId);
    const c2 = await carrier(tenantId);
    // tenant นี้: ร่าง 3 · ส่งตรวจ 2 · โต้แย้ง 2 · อนุมัติ 3 · จ่ายเดือนนี้ 2 + เดือนก่อน 1 · ยกเลิก 1 (ปนรถร่วม 2 ราย)
    for (const c of [c1, c1, c2]) await seedSettlement(tenantId, c, 'DRAFT');
    for (const c of [c1, c2]) await seedSettlement(tenantId, c, 'SENT_TO_CARRIER');
    for (const c of [c2, c2]) await seedSettlement(tenantId, c, 'DISPUTED');
    for (const c of [c1, c2, c1])
      await seedSettlement(tenantId, c, 'APPROVED', { net: '500.00', wht: '5.00' });
    await seedSettlement(tenantId, c1, 'PAID', { net: '1000.00', wht: '10.00' });
    await seedSettlement(tenantId, c2, 'PAID', { net: '2500.50', wht: '25.01' });
    await seedSettlement(tenantId, c1, 'PAID', {
      net: '9999.00',
      wht: '99.99',
      paidDate: lastMonth,
    });
    await seedSettlement(tenantId, c1, 'CANCELLED');
    // tenant อื่น: ใบของตัวเอง (ห้ามรั่วมานับ)
    const o = await carrier(otherId);
    for (const s of ['DRAFT', 'DISPUTED', 'APPROVED', 'PAID'] as const)
      await seedSettlement(otherId, o, s, { net: '700.00', wht: '7.00' });
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
  });

  it('ตัวเลขทุกช่อง = จำนวน settlement ตามสถานะ (นับตรงจากฐาน) = จำนวนแถวของรายการที่คลิกลงไป', async () => {
    const s = (await api(app, admin).get('/v1/settlements/summary').expect(200)).body as Record<
      string,
      number
    >;
    const c = await dbCounts(tenantId);
    expect(c).toEqual({
      DRAFT: 3,
      SENT_TO_CARRIER: 2,
      DISPUTED: 2,
      APPROVED: 3,
      PAID: 3,
      CANCELLED: 1,
    });
    for (const [tile, statuses] of Object.entries(TILES)) {
      const want = statuses.split(',').reduce((n, x) => n + (c[x] ?? 0), 0);
      expect(tileOf(s, statuses), tile).toBe(want);
      expect(await listCount(admin, statuses), tile).toBe(want);
    }
    expect(s.total).toBe(Object.values(c).reduce((a, b) => a + b, 0));
    // ยกเลิกไม่อยู่ในช่องใด (แท็บ "ทั้งหมด" เท่านั้น)
    expect(s.cancelled).toBe(1);
  });

  it('ยอดจ่ายแล้วเดือนนี้ = Σ (ยอดสุทธิ − หัก ณ ที่จ่ายที่ตรึง) ของใบที่จ่ายในเดือนนี้ (เวลาไทย) — ใบเดือนก่อนนับจำนวนแต่ไม่นับยอด', async () => {
    const s = (await api(app, admin).get('/v1/settlements/summary').expect(200)).body;
    const [row] = await owner.$queryRaw<{ amt: string }[]>`
      SELECT COALESCE(SUM(net_payable - wht_amount), 0)::text AS amt FROM carrier_settlement
       WHERE tenant_id = ${tenantId}::uuid AND status = 'PAID'
         AND paid_date >= ${monthStart}::date AND paid_date <= ${today}::date`;
    expect(row?.amt).toBe('3465.49');
    expect(s.buyPaidThisMonth).toBe('3465.49');
    expect(s.paid).toBe(3);
  });

  it('สิทธิ์: settlements:read อย่างเดียว = เห็นจำนวน ไม่มีฟิลด์ยอด · ไม่มี settlements:read = 403 · มี prices.buy:read = เห็นยอด', async () => {
    const countsOnly = await tokenFor(tenantId, 'settlements:read', 'u-ap-view');
    const a = (await api(app, countsOnly).get('/v1/settlements/summary').expect(200)).body;
    expect(a.paid).toBe(3);
    expect(a.disputed).toBe(2);
    expect(a).not.toHaveProperty('buyPaidThisMonth');
    const buy = await tokenFor(tenantId, 'settlements:read prices.buy:read', 'u-ap-buy');
    expect(
      (await api(app, buy).get('/v1/settlements/summary').expect(200)).body.buyPaidThisMonth,
    ).toBe('3465.49');
    const none = await tokenFor(tenantId, 'orders:read prices.buy:read', 'u-ap-none');
    const r = await api(app, none).get('/v1/settlements/summary').expect(403);
    expect(r.body.code).toBe('permission_denied');
    await api(app, none).get('/v1/settlements').query({ status: 'PAID' }).expect(403);
  });

  it('แยก tenant: แต่ละ tenant นับเฉพาะใบของตัวเอง (รายการก็เช่นกัน)', async () => {
    const o = (await api(app, other).get('/v1/settlements/summary').expect(200)).body;
    expect(o).toMatchObject({
      total: 4,
      draft: 1,
      sentToCarrier: 0,
      disputed: 1,
      approved: 1,
      paid: 1,
      cancelled: 0,
      buyPaidThisMonth: '693.00',
    });
    expect(await dbCounts(otherId)).toEqual({ DRAFT: 1, DISPUTED: 1, APPROVED: 1, PAID: 1 });
    for (const statuses of Object.values(TILES))
      expect(await listCount(other, statuses)).toBe(tileOf(o, statuses));
    // tenant นี้ไม่เห็นใบของ tenant อื่นในรายการ
    const mine = (await api(app, admin).get('/v1/settlements').query({ limit: 200 }).expect(200))
      .body.data as { id: string }[];
    const theirs = await owner.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM carrier_settlement WHERE tenant_id = ${otherId}::uuid`;
    const mineUuids = new Set(mine.map((x) => tryDecodeId('settlement', x.id)));
    for (const t of theirs) expect(mineUuids.has(t.id)).toBe(false);
  });
});
