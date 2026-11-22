/**
 * ST9-T17 ข้อมูลตั้งต้นของการทดสอบประสิทธิภาพ — รันผ่าน `pnpm --filter @tms/api perf seed`
 *
 * 1. ลบ/สร้างฐาน `<ฐาน dev>_perf` → migrate (ทางเดียวกับทุกที่: `db:migrate`)
 * 2. ข้อมูลหลัก + งานตัวอย่าง 2 ใบ **ผ่าน API จริง** (role แอป + RLS): ลูกค้า จุดรับ-ส่ง ราคา รถ คนขับ → ใบสั่ง → DO → เที่ยว →
 *    ส่งสำเร็จ → ส่งบัญชี → ร่าง → ออกใบแจ้งหนี้ (ได้แถวที่ระบบสร้างเองครบทุกคอลัมน์/ทุก snapshot)
 * 3. ขยายเป็นปริมาณจริงด้วย bulk insert (connection เจ้าของฐาน): clone แถวตัวอย่างด้วย `jsonb_populate_record`
 *    — id ใหม่ = md5(id ตัวอย่าง + ลำดับ) จึงได้ข้อมูลชุดเดิมทุกครั้ง (ไม่มีค่าสุ่ม)
 *
 * ปริมาณ: ดู `VOLUME` ใน lib.ts · ข้อมูลสมมติทั้งหมด (ชื่อขึ้นต้น "ทดสอบประสิทธิภาพ")
 */
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  API_PORT,
  BASE,
  PERF_DIR,
  VOLUME,
  assertPerfDb,
  client,
  ok,
  taxId,
  writeState,
} from './lib';
import { PERF_USER } from './web';

const API_DIR = resolve(__dirname, '../..');
const ADDR = {
  line1: '99 ถนนทดสอบ',
  subdistrict: 'ทดสอบ',
  district: 'เมืองชลบุรี',
  province: 'ชลบุรี',
  postcode: '20000',
};
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function main() {
  const db = assertPerfDb();
  const t0 = Date.now();
  const log = (m: string) =>
    console.log(`[perf seed +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  // ---------- 1) ฐาน ----------
  const adminUrl = new URL(process.env.DATABASE_URL!);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
  await admin.$disconnect();
  rmSync(PERF_DIR, { recursive: true, force: true });
  log(`สร้างฐาน ${db} ใหม่ → migrate`);
  execSync('pnpm -s db:migrate', { cwd: API_DIR, env: process.env, stdio: 'pipe' });

  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const plat = new PrismaClient({
    datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } },
  });
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { ensurePlanCatalog } = require('../../src/modules/entitlements/plan-catalog');
  const { createTenantWithDefaults } = require('../../src/modules/tenants/bootstrap');
  const { createApp } = require('../../src/bootstrap');
  const { signDevToken } = require('../../src/auth/auth.guard');
  const { tryDecodeId } = require('../../src/common/ids');
  /* eslint-enable @typescript-eslint/no-require-imports */
  await ensurePlanCatalog(plat);

  // ---------- 2) tenant + ข้อมูลหลักผ่าน API ----------
  const tenant = await createTenantWithDefaults(plat, { name: 'ทดสอบประสิทธิภาพ จำกัด' });
  const tenantId: string = tenant.id;
  const company = await owner.company.create({
    data: { tenantId, legalName: 'บริษัท ทดสอบประสิทธิภาพขนส่ง จำกัด', taxId: taxId(1) },
  });
  await owner.branch.create({
    data: {
      tenantId,
      companyId: company.id,
      branchCode: '00000',
      branchLabel: 'สำนักงานใหญ่',
      address: ADDR,
      isDefaultIssuer: true,
    },
  });

  // ผู้ใช้ viewer (ไม่บังคับ 2FA) สำหรับวัดหน้าเว็บ (`perf run --only=web`) — ข้อมูลสมมติ ใช้กับฐาน perf เท่านั้น
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { hashPassword } = require('../../src/auth/password');
  const { ensureSystemRoles } = require('../../src/auth/system-roles');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const roles: Record<string, string> = await ensureSystemRoles(plat, tenantId);
  const viewer = await plat.appUser.create({
    data: {
      tenantId,
      email: PERF_USER.email,
      name: 'ผู้ดูทดสอบประสิทธิภาพ',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PERF_USER.password),
    },
  });
  await plat.userRole.create({ data: { tenantId, userId: viewer.id, roleId: roles.viewer! } });

  // ระหว่าง seed ปิด rate limit (ยิงติดกันหลายร้อยคำขอ) — ตอนวัดเปิดตามค่าเริ่ม
  process.env.RATE_LIMIT = 'off';
  // log ช้า > 150 ms ของฐาน perf (ใช้หา query ช้า + EXPLAIN — ดู docs/perf/st9-t17-report.md §วิธีวัด) · มีผลเฉพาะฐานนี้
  await owner.$executeRawUnsafe(`ALTER DATABASE "${db}" SET log_min_duration_statement = 150`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@nestjs/common').Logger.overrideLogger(['error', 'warn']);
  const app = await createApp();
  await app.listen(API_PORT, '127.0.0.1');
  const token = (sub: string) => signDevToken({ sub, tid: tenantId }, '2h') as Promise<string>;
  const api = client(await token('perf-preparer'), BASE);
  const finalizer = client(await token('perf-finalizer'), BASE);
  const uuid = (kind: string, id: string): string => tryDecodeId(kind, id);

  const list = async (path: string) => ok(await api('GET', path), 200, path).body.data as any[];
  const vehicleTypeId: string = (await list('/v1/vehicle-types?limit=50')).find(
    (t) => t.code === '6W',
  ).id;
  const unitId: string = (await list('/v1/units?limit=50')).find((u) => u.code === 'TON').id;

  let n = 1;
  const newCustomer = async (label: string) =>
    ok(
      await api('POST', '/v1/customers', {
        legalName: `ลูกค้าทดสอบประสิทธิภาพ ${label}`,
        taxId: taxId(1000 + ++n),
        branchCode: '00000',
        billingAddress: ADDR,
      }),
      201,
      'customer',
    ).body.id as string;
  const run: string[] = [];
  for (let i = 1; i <= VOLUME.runCustomers; i++) run.push(await newCustomer(`รอบ ${i}`));
  const hist: string[] = [];
  for (let i = 1; i <= VOLUME.histCustomers; i++) hist.push(await newCustomer(`ประวัติ ${i}`));
  const big500 = await newCustomer('ใบใหญ่ 500');
  const big200 = await newCustomer('ใบใหญ่ 200');
  // ลูกค้าของรอบวางบิล = MONTHLY · อื่น ๆ = MANUAL (ไม่เข้ารอบ) · checklist หลักฐานส่ง = ไม่บังคับช่องใด (ไม่ต้องมีไฟล์ POD)
  await owner.customer.updateMany({
    where: { tenantId },
    data: {
      podRequirements: { success: { fields: [] } },
      paymentTermDays: 30,
      billingCycle: 'MANUAL',
    },
  });
  await owner.customer.updateMany({
    where: { id: { in: run.map((c) => uuid('customer', c)) } },
    data: { billingCycle: 'MONTHLY' },
  });
  log(`ลูกค้า ${run.length + hist.length + 2} ราย`);

  const site = async (name: string) =>
    ok(
      await api('POST', '/v1/customer-sites', { name, kind: 'DROPOFF', address: ADDR }),
      201,
      'site',
    ).body.id as string;
  const origin = await site('คลังทดสอบประสิทธิภาพ (ต้นทาง)');
  const dest = await site('ร้านทดสอบประสิทธิภาพ (ปลายทาง)');
  const rate = ok(
    await api('POST', '/v1/rate-cards', {
      customerId: hist[0],
      originId: origin,
      destinationId: dest,
      vehicleTypeId,
      validFrom: '2026-01-01',
      pricingModel: 'PER_TON',
      sellRate: '350',
    }),
    201,
    'rate card',
  ).body;
  ok(
    await api('POST', `/v1/rate-cards/${rate.id}/approve`, {
      reason: 'ข้อมูลตั้งต้นทดสอบประสิทธิภาพ',
    }),
    200,
    'approve rate',
  );

  const vehicles: string[] = [];
  for (let i = 1; i <= VOLUME.vehicles; i++) {
    const v = ok(
      await api('POST', '/v1/vehicles', {
        plate: `7${i % 10}-${String(4000 + i)}`,
        plateProvince: 'TH-20',
        vehicleTypeId,
        ownership: 'OWN',
      }),
      201,
      'vehicle',
    ).body.id as string;
    ok(
      await api('POST', '/v1/drivers', {
        name: `คนขับทดสอบ ${i}`,
        phone: `089-${String(i).padStart(3, '0')}-${String(1000 + i)}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2031-12-31',
        defaultVehicleId: v,
      }),
      201,
      'driver',
    );
    vehicles.push(v);
  }
  log(`รถ + คนขับ ${vehicles.length} ชุด`);

  // ---------- งานตัวอย่างผ่าน API จริง: ใบสั่ง → DO → เที่ยว → ส่งสำเร็จ → ส่งบัญชี ----------
  const delivered = async (vehicleId: string) => {
    const order = ok(
      await api('POST', '/v1/orders', {
        customer: { id: hist[0] },
        requestedDate: TODAY,
        vehicleTypeId,
        stops: [
          { type: 'PICKUP', siteId: origin },
          { type: 'DELIVERY', siteId: dest },
        ],
        lines: [{ description: 'ปูนซีเมนต์ถุง 50 กก.', qty: '5', unitId, weightKg: '5000' }],
      }),
      201,
      'order',
    ).body;
    const [d] = await list(`/v1/delivery-orders?orderId=${order.id}`);
    const trip = ok(
      await api('POST', '/v1/trips', { tripDate: TODAY, deliveryOrderIds: [d.id], vehicleId }),
      201,
      'trip',
    ).body;
    const a = await api('POST', `/v1/trips/${trip.id}/assign`, { vehicleId, dispatch: true });
    if (a.status !== 200)
      ok(
        await api('POST', `/v1/trips/${trip.id}/assign`, {
          vehicleId,
          dispatch: true,
          ruleKeys: (a.body.warnings ?? []).map((x: { key: string }) => x.key),
          overrideReason: 'ข้อมูลตั้งต้นทดสอบประสิทธิภาพ',
        }),
        200,
        'assign',
      );
    const full = ok(await api('GET', `/v1/trips/${trip.id}`), 200, 'trip').body;
    const [pickup, drop] = [...full.stops].sort((x: any, y: any) => x.sequence - y.sequence);
    const ev = (stop: string, action: string, min: number, extra: object = {}) =>
      api('POST', `/v1/stops/${stop}/${action}`, {
        clientEventId: crypto.randomUUID(),
        occurredAt: ago(min),
        ...extra,
      });
    ok(await ev(pickup.id, 'arrive', 60), 201, 'arrive');
    ok(await ev(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }), 201, 'complete');
    ok(await ev(drop.id, 'arrive', 20), 201, 'arrive');
    ok(await ev(drop.id, 'complete', 10, { outcome: 'DELIVERED' }), 201, 'complete');
    ok(await api('POST', `/v1/delivery-orders/${d.id}/release`, {}), 200, 'release');
    return {
      orderId: order.id as string,
      deliveryOrderId: d.id as string,
      tripId: trip.id as string,
    };
  };
  // T1 = แม่แบบของ ใบสั่ง/DO/เที่ยว (ค้างที่ "ส่งบัญชีแล้ว พร้อมวางบิล") · T2 = ออกใบแจ้งหนี้จริง 1 ใบ เป็นแม่แบบใบแจ้งหนี้
  const t1 = await delivered(vehicles[0]!);
  const t2 = await delivered(vehicles[1]!);
  const draft = ok(
    await api('POST', '/v1/invoices', {
      customerId: hist[0],
      deliveryOrderIds: [t2.deliveryOrderId],
    }),
    201,
    'draft',
  ).body;
  const issued = ok(
    await finalizer('POST', `/v1/invoices/${draft.id}/finalize`, undefined, {
      'If-Match': `"${draft.version}"`,
    }),
    200,
    'finalize',
  ).body;
  log(`งานตัวอย่างผ่าน API: ${issued.invoiceNo} (PDF ${issued.pdf ? 'เก็บแล้ว' : 'รอ job'})`);
  await app.close();

  // ---------- 3) ขยายปริมาณ (bulk) ----------
  const T = {
    so: uuid('salesOrder', t1.orderId),
    dord: uuid('deliveryOrder', t1.deliveryOrderId),
    trip: uuid('trip', t1.tripId),
    inv: uuid('invoice', issued.id),
  };
  const ids = (kind: string, xs: string[]) => xs.map((x) => uuid(kind, x));
  await owner.$transaction(
    async (tx) => {
      const x = (sql: string, ...p: unknown[]) => tx.$executeRawUnsafe(sql, ...p);
      await x(`CREATE FUNCTION pg_temp.nid(uuid, int) RETURNS uuid LANGUAGE sql IMMUTABLE
               AS $$ SELECT md5($1::text || '#' || $2::text)::uuid $$`);
      // แผนต่อแถว n: กลุ่ม/ลูกค้า/รถ/วันที่/สถานะ
      await x(
        `CREATE TEMP TABLE perf_n ON COMMIT DROP AS
         WITH g AS (
           SELECT n,
                  CASE WHEN n <= ${VOLUME.runA.to} THEN 'RUN_A' WHEN n <= ${VOLUME.runB.to} THEN 'RUN_B'
                       WHEN n <= ${VOLUME.big500.to} THEN 'BIG500' WHEN n <= ${VOLUME.big200.to} THEN 'BIG200'
                       ELSE (ARRAY['PLANNED','DISPATCHED','POD_PENDING','BILLED','BILLED','BILLED','BILLED',
                                   'BILLED','BILLED','BILLED'])[1 + n % 10] END AS cls,
                  ((n - 1) % 2000) + 1 AS k
             FROM generate_series(1, ${VOLUME.orders}) n)
         SELECT g.n, g.cls,
                CASE WHEN g.n <= ${VOLUME.runB.to}
                       THEN ($1::uuid[])[CASE WHEN g.k <= 450 THEN 1 WHEN g.k <= 900 THEN 2 ELSE 3 + (g.k - 901) % 22 END]
                     WHEN g.cls = 'BIG500' THEN $2::uuid WHEN g.cls = 'BIG200' THEN $3::uuid
                     ELSE ($4::uuid[])[1 + g.n % ${VOLUME.histCustomers}] END AS customer_id,
                ($5::uuid[])[1 + g.n % ${VOLUME.vehicles}] AS vehicle_id,
                CASE g.cls WHEN 'RUN_A' THEN DATE '2026-10-01' + (g.n % 31)
                           WHEN 'RUN_B' THEN DATE '2026-09-01' + (g.n % 30)
                           WHEN 'BIG500' THEN DATE '2026-10-01' + (g.n % 31)
                           WHEN 'BIG200' THEN DATE '2026-10-01' + (g.n % 31)
                           ELSE DATE '2026-06-01' + (g.n % 90) END AS d,
                TIMESTAMPTZ '2026-11-01T00:00:00Z' + g.n * INTERVAL '30 seconds' AS upd,
                (g.cls NOT IN ('PLANNED', 'DISPATCHED')) AS done,
                (g.cls IN ('RUN_A', 'BIG500', 'BIG200', 'BILLED')) AS released
           FROM g`,
        ids('customer', run),
        uuid('customer', big500),
        uuid('customer', big200),
        ids('customer', hist),
        ids('vehicle', vehicles),
      );
      await x('CREATE UNIQUE INDEX ON perf_n (n)');
      /** clone แถวของ `table` ที่ตรง `where` ต่อ n — `patch` = jsonb ที่ทับคอลัมน์ (อ้าง s = แถวแม่แบบ, p = perf_n) */
      const clone = (table: string, where: string, patch: string, ...p: unknown[]) =>
        x(
          `INSERT INTO "${table}"
           SELECT r.* FROM "${table}" s CROSS JOIN perf_n p
            CROSS JOIN LATERAL jsonb_populate_record(NULL::"${table}", to_jsonb(s) || ${patch}) r
           WHERE ${where}`,
          ...p,
        );
      await clone(
        'sales_order',
        's.id = $1::uuid',
        `jsonb_build_object('id', pg_temp.nid(s.id, p.n), 'so_no', 'SO-P-' || lpad(p.n::text, 6, '0'),
           'external_id', NULL, 'customer_id', p.customer_id, 'requested_date', p.d,
           'status', CASE p.cls WHEN 'PLANNED' THEN 'PLANNED' WHEN 'DISPATCHED' THEN 'IN_TRANSIT' ELSE 'DELIVERED' END,
           'updated_at', p.upd, 'created_at', p.upd - INTERVAL '2 days')`,
        T.so,
      );
      for (const t of ['sales_order_stop', 'sales_order_line', 'sales_order_charge'])
        await clone(
          t,
          's.sales_order_id = $1::uuid',
          `jsonb_build_object('id', pg_temp.nid(s.id, p.n), 'sales_order_id', pg_temp.nid(s.sales_order_id, p.n))`,
          T.so,
        );
      await clone(
        'trip',
        's.id = $1::uuid',
        `jsonb_build_object('id', pg_temp.nid(s.id, p.n), 'trip_no', 'TR-P-' || lpad(p.n::text, 6, '0'),
           'trip_date', p.d, 'vehicle_id', p.vehicle_id,
           'status', CASE p.cls WHEN 'PLANNED' THEN 'ASSIGNED' WHEN 'DISPATCHED' THEN 'IN_PROGRESS' ELSE 'COMPLETED' END,
           'dispatched_at', CASE WHEN p.cls = 'PLANNED' THEN NULL ELSE s.dispatched_at END,
           'completed_at', CASE WHEN p.done THEN s.completed_at ELSE NULL END,
           'updated_at', p.upd, 'created_at', p.upd - INTERVAL '1 day')`,
        T.trip,
      );
      await clone(
        'trip_stop',
        's.trip_id = $1::uuid',
        `jsonb_build_object('id', pg_temp.nid(s.id, p.n), 'trip_id', pg_temp.nid(s.trip_id, p.n), 'last_event_id', NULL)
         || CASE WHEN p.done THEN '{}'::jsonb
                 ELSE '{"status":"PENDING","arrived_at":null,"departed_at":null,"outcome":null,"pod":null}'::jsonb END`,
        T.trip,
      );
      await clone(
        'delivery_order',
        's.id = $1::uuid',
        `jsonb_build_object('id', pg_temp.nid(s.id, p.n), 'do_no', 'DO-P-' || lpad(p.n::text, 6, '0'),
           'do_date', p.d, 'sales_order_id', pg_temp.nid(s.sales_order_id, p.n), 'customer_id', p.customer_id,
           'trip_id', pg_temp.nid(s.trip_id, p.n), 'trip_stop_id', pg_temp.nid(s.trip_stop_id, p.n),
           'pickup_trip_stop_id', pg_temp.nid(s.pickup_trip_stop_id, p.n), 'public_token_hash', NULL,
           'status', CASE p.cls WHEN 'PLANNED' THEN 'PLANNED' WHEN 'DISPATCHED' THEN 'DISPATCHED'
                                WHEN 'POD_PENDING' THEN 'POD_PENDING' WHEN 'BILLED' THEN 'BILLED' ELSE s.status::text END,
           'pod_status', CASE WHEN p.cls IN ('PLANNED', 'DISPATCHED', 'POD_PENDING') THEN 'NONE' ELSE s.pod_status END,
           'billing_status', CASE WHEN p.cls = 'BILLED' THEN 'INVOICED' ELSE 'UNBILLED' END,
           'invoiced_at', CASE WHEN p.cls = 'BILLED' THEN p.upd ELSE NULL END,
           'released_at', CASE WHEN p.released THEN p.upd ELSE NULL END,
           'released_by', CASE WHEN p.released THEN s.released_by ELSE NULL END,
           'updated_at', p.upd, 'created_at', p.upd - INTERVAL '1 day')`,
        T.dord,
      );
      await clone(
        'delivery_order_line',
        's.delivery_order_id = $1::uuid',
        `jsonb_build_object('id', pg_temp.nid(s.id, p.n), 'delivery_order_id', pg_temp.nid(s.delivery_order_id, p.n),
           'sales_order_line_id', pg_temp.nid(s.sales_order_line_id, p.n))`,
        T.dord,
      );
      await clone(
        'revenue_line',
        's.sales_order_id = $1::uuid',
        `jsonb_build_object('id', pg_temp.nid(s.id, p.n), 'sales_order_id', pg_temp.nid(s.sales_order_id, p.n),
           'delivery_order_id', pg_temp.nid(s.delivery_order_id, p.n), 'source_id', pg_temp.nid(s.source_id, p.n),
           'updated_at', p.upd)`,
        T.so,
      );

      // ใบแจ้งหนี้ย้อนหลัง: clone ใบที่ออกจริง (snapshot ครบ) — ข้าม trigger ของเอกสาร (เขียนใบที่ออกแล้วตรง ๆ ทำไม่ได้ตามปกติ)
      await x(`SET LOCAL session_replication_role = replica`);
      await x(
        `CREATE TEMP TABLE perf_i ON COMMIT DROP AS
         SELECT i,
                CASE WHEN i <= 600 THEN (CASE WHEN i % 2 = 0 THEN 'ISSUED' ELSE 'PAID' END)
                     ELSE (ARRAY['DRAFT','CANCELLED','ISSUED','ISSUED','ISSUED','ISSUED','ISSUED','ISSUED','ISSUED',
                                 'PARTIALLY_PAID','PAID','PAID','PAID','PAID','PAID','PAID','PAID','PAID','PAID','PAID'])[1 + i % 20]
                END AS st,
                ($1::uuid[])[1 + i % ${VOLUME.histCustomers}] AS customer_id,
                DATE '2026-06-01' + (i % 170) AS issue_date,
                TIMESTAMPTZ '2026-11-01T00:00:00Z' + i * INTERVAL '30 seconds' AS upd
           FROM generate_series(1, ${VOLUME.invoices}) i`,
        ids('customer', hist),
      );
      await x(
        `INSERT INTO invoice
         SELECT r.* FROM invoice s CROSS JOIN perf_i p
          CROSS JOIN LATERAL jsonb_populate_record(NULL::invoice, to_jsonb(s) || jsonb_build_object(
            'id', pg_temp.nid(s.id, p.i), 'customer_id', p.customer_id, 'status', p.st, 'pdf_document_id', NULL,
            'invoice_no', CASE WHEN p.st = 'DRAFT' THEN NULL ELSE 'INV-P-' || lpad(p.i::text, 6, '0') END,
            'issue_date', CASE WHEN p.st = 'DRAFT' THEN NULL ELSE p.issue_date END,
            'due_date', CASE WHEN p.st = 'DRAFT' THEN NULL ELSE p.issue_date + 30 END,
            'issued_at', CASE WHEN p.st = 'DRAFT' THEN NULL ELSE p.issue_date::timestamptz + INTERVAL '10 hours' END,
            'issued_by', CASE WHEN p.st = 'DRAFT' THEN NULL ELSE s.issued_by END,
            'paid_amount', CASE p.st WHEN 'PAID' THEN s.total_amount
                                     WHEN 'PARTIALLY_PAID' THEN round(s.total_amount / 2, 2) ELSE 0 END,
            'overdue_at', CASE WHEN p.st IN ('ISSUED', 'PARTIALLY_PAID') AND p.issue_date + 30 < CURRENT_DATE
                               THEN (p.issue_date + 31)::timestamptz ELSE NULL END,
            'cancelled_at', CASE WHEN p.st = 'CANCELLED' THEN p.upd ELSE NULL END,
            'cancelled_by', CASE WHEN p.st = 'CANCELLED' THEN 'perf-seed' ELSE NULL END,
            'cancel_reason', CASE WHEN p.st = 'CANCELLED' THEN 'ข้อมูลตั้งต้นทดสอบประสิทธิภาพ' ELSE NULL END,
            'updated_at', p.upd, 'created_at', p.upd - INTERVAL '1 hour')) r
         WHERE s.id = $1::uuid`,
        T.inv,
      );
      // บรรทัด: ทุกใบมีบรรทัดที่เพิ่มเอง 1 บรรทัด · DO ที่วางบิลแล้ว (กลุ่ม BILLED) กระจายใบละ 10 DO ใน 600 ใบแรก (ISSUED/PAID)
      await x(
        `INSERT INTO invoice_line
         SELECT r.* FROM invoice_line s CROSS JOIN perf_i p
          CROSS JOIN LATERAL jsonb_populate_record(NULL::invoice_line, to_jsonb(s) || jsonb_build_object(
            'id', pg_temp.nid(s.id, p.i), 'invoice_id', pg_temp.nid(s.invoice_id, p.i), 'line_no', 1,
            'delivery_order_id', NULL, 'revenue_line_id', NULL, 'is_user_added', true, 'do_anchor', false,
            'active', p.st <> 'CANCELLED', 'released_with_invoice', p.st = 'CANCELLED')) r
         WHERE s.invoice_id = $1::uuid`,
        T.inv,
      );
      await x(
        `INSERT INTO invoice_line
         SELECT r.* FROM invoice_line s
          CROSS JOIN (SELECT n, row_number() OVER (ORDER BY n) AS rk FROM perf_n WHERE cls = 'BILLED') b
          CROSS JOIN LATERAL jsonb_populate_record(NULL::invoice_line, to_jsonb(s) || jsonb_build_object(
            'id', md5(s.id::text || '#do' || b.n::text)::uuid,
            'invoice_id', pg_temp.nid(s.invoice_id, ((b.rk - 1) / 10 + 1)::int),
            'line_no', 2 + (b.rk - 1) % 10,
            'delivery_order_id', pg_temp.nid($2::uuid, b.n),
            'revenue_line_id', (SELECT pg_temp.nid(l.id, b.n) FROM revenue_line l
                                 WHERE l.sales_order_id = $3::uuid ORDER BY l.line_no LIMIT 1))) r
         WHERE s.invoice_id = $1::uuid`,
        T.inv,
        T.dord,
        T.so,
      );
      await x(`SET LOCAL session_replication_role = origin`);
    },
    { timeout: 600_000, maxWait: 10_000 },
  );
  await owner.$executeRawUnsafe('ANALYZE');
  const counts = await owner.$queryRawUnsafe<{ t: string; n: bigint }[]>(
    `SELECT 'sales_order' t, count(*) n FROM sales_order UNION ALL SELECT 'delivery_order', count(*) FROM delivery_order
     UNION ALL SELECT 'trip', count(*) FROM trip UNION ALL SELECT 'revenue_line', count(*) FROM revenue_line
     UNION ALL SELECT 'invoice', count(*) FROM invoice UNION ALL SELECT 'invoice_line', count(*) FROM invoice_line`,
  );
  log(`bulk: ${counts.map((c) => `${c.t} ${c.n}`).join(' · ')}`);

  writeState({
    seededAt: new Date().toISOString(),
    tenantId,
    customers: { run, big500, big200, hist },
    vehicles,
    sites: { origin, dest },
    vehicleTypeId,
    unitId,
    template: { ...t1, invoiceId: issued.id },
    consumed: {},
  });
  await owner.$disconnect();
  await plat.$disconnect();
  log('เสร็จ');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
