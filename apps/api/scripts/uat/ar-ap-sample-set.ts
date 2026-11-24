/**
 * ST5-T25 ชุดเอกสารตัวอย่าง AR/AP แบบเบา (รวม ST6-T12) — รันผ่าน `pnpm --filter @tms/api uat:samples` เท่านั้น (cli.mjs สลับไปฐาน `<lane>_uat`)
 *
 * ทำอะไร (ผลเท่าเดิมทุกครั้ง ยกเว้น id/วันที่ = วันที่รัน):
 * 1. ลบ/สร้างฐาน `<lane>_uat` ใหม่ → migrate (ทางเดียวกับทุกที่: `db:migrate`) — ไม่ใช้ `prisma migrate reset/dev`
 * 2. สร้าง tenant ตัวอย่าง + ข้อมูลหลัก แล้วสร้างเอกสาร **ผ่าน API จริง** (`/v1` ชุดเดียวกับ UI/ลูกค้า) ตามกรณีในตาราง CASES
 *    ข้อยกเว้นเดียว: ขั้น "รถร่วมรับงาน + วิ่งจบ" ของเที่ยวรถร่วม จำลองด้วยการแก้แถวตรง (แบบเดียวกับ test/settlements.test.ts —
 *    flow จริงผ่านลิงก์รถร่วมทดสอบแล้วใน ST3/ST4) เพื่อไม่ต้องเปิดลิงก์มือถือ
 * 3. ดาวน์โหลด PDF ของทุกเอกสารที่ออกเลขแล้ว + เขียน manifest.json / manifest.md (เลขเอกสาร สถานะ ยอดจาก API)
 *    ให้ผู้ตรวจใช้คู่กับ `plan/sign-offs/st5-t25-ar-ap-checklist.md`
 *
 * ข้อมูลสมมติทั้งหมด: ชื่อขึ้นต้น "ตัวอย่างชุดตรวจ" · เลขผู้เสียภาษีขึ้นต้น 0990 (checksum ถูก แต่ไม่ใช่เลขจริง)
 * ยอด VAT/WHT ในเอกสาร TMS = **ยอดประมาณการ** (D-54) — เอกสารภาษีจริงออกที่ระบบบัญชี (D-55/D-56/D-58)
 */
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { client, ok, taxId } from '../perf/lib';

const API_DIR = resolve(__dirname, '../..');
const OUT = resolve(API_DIR, '.data/uat/ar-ap');
const PORT = Number(process.env.UAT_API_PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const ADDR = {
  line1: '9 ถนนตัวอย่างชุดตรวจ',
  subdistrict: 'ตัวอย่าง',
  district: 'เมืองชลบุรี',
  province: 'ชลบุรี',
  postcode: '20000',
};
const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const REASON = 'สร้างชุดเอกสารตัวอย่างสำหรับผู้ตรวจ ST5-T25';

/** กันรันผิดฐาน — ต้องถูกเรียกผ่าน cli.mjs (connection string ทุกตัวชี้ `tms_<lane>_uat`) */
function assertUatDb(): string {
  const names = ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL'].map((k) =>
    decodeURIComponent(new URL(process.env[k] ?? 'postgres://x/none').pathname.slice(1)),
  );
  if (!names.every((n) => /^tms_[a-z0-9]+_uat$/.test(n) && n === process.env.UAT_DB))
    throw new Error(
      `uat:samples: ต้องรันผ่าน "pnpm --filter @tms/api uat:samples" (ฐาน: ${names.join(', ')})`,
    );
  if (!PORT) throw new Error('uat:samples: ไม่มี UAT_API_PORT');
  return names[0]!;
}

/** แถวของ manifest — 1 แถวต่อ 1 กรณีในชุด */
interface CaseRow {
  case: string;
  title: string;
  docType: 'INVOICE' | 'BILLING_NOTE' | 'PAYMENT' | 'SETTLEMENT';
  docNo: string | null;
  status: string;
  amounts: Record<string, string | null | undefined>;
  pdf: string | null;
  note?: string;
}

async function main() {
  const db = assertUatDb();
  const t0 = Date.now();
  const log = (m: string) =>
    console.log(`[uat:samples +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  // ---------- 1) ฐาน `_uat` ใหม่ ----------
  const adminUrl = new URL(process.env.DATABASE_URL!);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
  await admin.$disconnect();
  rmSync(resolve(API_DIR, '.data/uat'), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
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
  const { signStepUpToken } = require('../../src/auth/tokens');
  const { tryDecodeId } = require('../../src/common/ids');
  /* eslint-enable @typescript-eslint/no-require-imports */
  await ensurePlanCatalog(plat);

  // ---------- 2) tenant + ผู้ออกเอกสาร ----------
  const tenant = await createTenantWithDefaults(plat, { name: 'ตัวอย่างชุดตรวจ AR/AP' });
  const tenantId: string = tenant.id;
  const company = await owner.company.create({
    data: {
      tenantId,
      legalName: 'บริษัท ตัวอย่างชุดตรวจขนส่ง จำกัด',
      legalNameEn: 'Sample Audit Transport Co., Ltd.',
      taxId: taxId(1),
      vatRegistered: true,
    },
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

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@nestjs/common').Logger.overrideLogger(['error', 'warn']);
  const app = await createApp();
  await app.listen(PORT, '127.0.0.1');
  // ผู้ใช้คนละคนตามการแบ่งหน้าที่ (SoD): เตรียม / ออกเลข / อนุมัติ / บันทึกจ่าย
  const SUBS = {
    prep: 'uat-preparer',
    fin: 'uat-finalizer',
    appr: 'uat-approver',
    pay: 'uat-payer',
  };
  const tok = async (sub: string) => (await signDevToken({ sub, tid: tenantId }, '2h')) as string;
  const prep = client(await tok(SUBS.prep), BASE);
  const fin = client(await tok(SUBS.fin), BASE);
  const appr = client(await tok(SUBS.appr), BASE);
  const pay = client(await tok(SUBS.pay), BASE);
  const stepUp = async (sub: string) => ({
    'X-Step-Up': (await signStepUpToken(sub, tenantId)) as string,
  });
  const uuid = (kind: string, id: string): string => tryDecodeId(kind, id);
  const ifMatch = (v: number) => ({ 'If-Match': `"${v}"` });

  const list = async (path: string) => ok(await prep('GET', path), 200, path).body.data as any[];
  const vehicleTypeId: string = (await list('/v1/vehicle-types?limit=50')).find(
    (t) => t.code === '6W',
  ).id;
  const unitId: string = (await list('/v1/units?limit=50')).find((u) => u.code === 'TON').id;
  const items = await list('/v1/service-items?limit=100');
  const LOAD = items.find((s) => s.code === 'LOAD');
  if (!LOAD) throw new Error('ไม่พบค่าบริการ LOAD ในชุดเริ่มต้น');

  // ---------- 3) ข้อมูลหลัก ----------
  let n = 0;
  const customer = async (legalName: string, extra: object) =>
    ok(
      await prep('POST', '/v1/customers', {
        legalName,
        taxId: taxId(100 + ++n),
        branchCode: '00000',
        billingAddress: ADDR,
        ...extra,
      }),
      201,
      `customer ${legalName}`,
    ).body.id as string;
  const C1 = await customer('บริษัท ตัวอย่างชุดตรวจ ก จำกัด', { whtExpectedRate: '1.00' });
  const C2 = await customer('บริษัท ตัวอย่างชุดตรวจ ข จำกัด', {
    whtExpectedRate: '1.00',
    branchCode: '00002',
  });
  const C3 = await customer('ร้าน ตัวอย่างชุดตรวจ ค', { whtExpectedRate: '0.00' });
  // checklist หลักฐานส่ง = ไม่บังคับช่องใด (ไม่ต้องแนบไฟล์ POD) · เครดิต 30 วัน
  await owner.customer.updateMany({
    where: { tenantId },
    data: {
      podRequirements: { success: { fields: [] } },
      paymentTermDays: 30,
      billingCycle: 'MANUAL',
    },
  });

  const site = async (name: string) =>
    ok(
      await prep('POST', '/v1/customer-sites', { name, kind: 'DROPOFF', address: ADDR }),
      201,
      'site',
    ).body.id as string;
  const origin = await site('คลังตัวอย่างชุดตรวจ (ต้นทาง)');
  const dest = await site('ร้านตัวอย่างชุดตรวจ (ปลายทาง)');
  const approveRate = async (id: string) =>
    ok(await prep('POST', `/v1/rate-cards/${id}/approve`, { reason: REASON }), 200, 'approve rate');
  const sellRate = async (customerId: string, rate: string) => {
    const r = ok(
      await prep('POST', '/v1/rate-cards', {
        customerId,
        originId: origin,
        destinationId: dest,
        vehicleTypeId,
        validFrom: '2026-01-01',
        pricingModel: 'PER_TRIP',
        sellRate: rate,
      }),
      201,
      'sell rate',
    ).body;
    await approveRate(r.id);
  };
  // ค่าขนส่งต่อเที่ยว: ก 8,000 · ข 10,000 · ค 900 (ต่ำกว่าขั้นต่ำหัก ณ ที่จ่าย 1,000 บาท — research §3.1 ข้อ 12/5)
  await sellRate(C1, '8000');
  await sellRate(C2, '10000');
  await sellRate(C3, '900');

  const ownVehicle = async (i: number) => {
    const v = ok(
      await prep('POST', '/v1/vehicles', {
        plate: `7${i}-${String(6000 + i)}`,
        plateProvince: 'TH-20',
        vehicleTypeId,
        ownership: 'OWN',
      }),
      201,
      'vehicle',
    ).body.id as string;
    ok(
      await prep('POST', '/v1/drivers', {
        name: `คนขับตัวอย่างชุดตรวจ ${i}`,
        phone: `089-000-${String(1000 + i)}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2031-12-31',
        defaultVehicleId: v,
      }),
      201,
      'driver',
    );
    return v;
  };
  const vehicles = [await ownVehicle(1), await ownVehicle(2)];

  // ---------- งานขนส่งผ่าน API: ใบสั่ง → DO → เที่ยว ----------
  const newOrderTrip = async (customerId: string, vehicleId?: string) => {
    const order = ok(
      await prep('POST', '/v1/orders', {
        customer: { id: customerId },
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
      await prep('POST', '/v1/trips', {
        tripDate: TODAY,
        deliveryOrderIds: [d.id],
        ...(vehicleId ? { vehicleId } : {}),
      }),
      201,
      'trip',
    ).body;
    return { doId: d.id as string, tripId: trip.id as string };
  };
  /** รถบริษัท: จ่ายงาน → ถึง/ส่งสำเร็จ 2 จุด → ส่งบัญชี (พร้อมวางบิล) */
  const deliveredOwn = async (customerId: string, k: number) => {
    const vehicleId = vehicles[k % vehicles.length]!;
    const { doId, tripId } = await newOrderTrip(customerId, vehicleId);
    const a = await prep('POST', `/v1/trips/${tripId}/assign`, { vehicleId, dispatch: true });
    if (a.status !== 200)
      ok(
        await prep('POST', `/v1/trips/${tripId}/assign`, {
          vehicleId,
          dispatch: true,
          ruleKeys: (a.body.warnings ?? []).map((x: { key: string }) => x.key),
          overrideReason: REASON,
        }),
        200,
        'assign',
      );
    const full = ok(await prep('GET', `/v1/trips/${tripId}`), 200, 'trip').body;
    const [pickup, drop] = [...full.stops].sort((x: any, y: any) => x.sequence - y.sequence);
    const ev = (stop: string, action: string, min: number, extra: object = {}) =>
      prep('POST', `/v1/stops/${stop}/${action}`, {
        clientEventId: crypto.randomUUID(),
        occurredAt: ago(min),
        ...extra,
      });
    ok(await ev(pickup.id, 'arrive', 60), 201, 'arrive');
    ok(await ev(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }), 201, 'complete');
    ok(await ev(drop.id, 'arrive', 20), 201, 'arrive');
    ok(await ev(drop.id, 'complete', 10, { outcome: 'DELIVERED' }), 201, 'complete');
    ok(await prep('POST', `/v1/delivery-orders/${doId}/release`, {}), 200, 'release');
    return doId;
  };

  // ---------- 4) ใบแจ้งหนี้ ----------
  const rows: CaseRow[] = [];
  const pdfs: Array<{ file: string; path: string }> = [];
  const invAmounts = (i: any) => ({
    subtotalExempt: i.sellSubtotalExempt,
    subtotalVatable: i.sellSubtotalVatable,
    vat: i.sellVatAmount,
    total: i.sellTotal,
    whtExpected: i.sellWhtExpected,
    netExpected: i.sellNetExpected,
    paid: i.sellPaidAmount,
    outstanding: i.sellOutstanding,
  });
  const draftInvoice = async (customerId: string, doIds: string[]) =>
    ok(await prep('POST', '/v1/invoices', { customerId, deliveryOrderIds: doIds }), 201, 'draft')
      .body;
  /** ผู้ออกเลขต้องไม่ใช่ผู้สร้าง/แก้ร่าง (`invoice_self_finalize`) — ร่างที่ระบบสร้างตอน void+reissue เป็นของผู้ยกเลิก จึงให้ `prep` ออก */
  const finalize = async (id: string, by = fin) => {
    const cur = ok(await prep('GET', `/v1/invoices/${id}`), 200, 'invoice').body;
    return ok(
      await by('POST', `/v1/invoices/${id}/finalize`, undefined, ifMatch(cur.version)),
      200,
      'finalize',
    ).body;
  };
  const getInv = async (id: string) =>
    ok(await prep('GET', `/v1/invoices/${id}`), 200, 'invoice').body;

  // S-INV-01 ค่าขนส่งล้วน (ยกเว้น VAT) 2 DO · ลูกค้านิติบุคคล หัก 1%
  const inv1 = await finalize(
    (await draftInvoice(C1, [await deliveredOwn(C1, 0), await deliveredOwn(C1, 1)])).id,
  );
  // S-INV-02 บรรทัดปน: ค่าขนส่ง (ยกเว้น) + ค่าขึ้นสินค้า LOAD (VAT 7%, หัก 3%) · ลูกค้าสาขา 00002
  const d2 = await draftInvoice(C2, [await deliveredOwn(C2, 0)]);
  ok(
    await prep(
      'POST',
      `/v1/invoices/${d2.id}/lines`,
      {
        serviceItemId: LOAD.id,
        description: 'ค่าขึ้นสินค้า (แรงงานยกขน)',
        quantity: '1',
        sellUnitPrice: '500',
        reason: REASON,
      },
      ifMatch((await getInv(d2.id)).version),
    ),
    [200, 201],
    'add LOAD line',
  );
  const inv2 = await finalize(d2.id);
  // S-INV-03 ยอดต่ำกว่า 1,000 บาท · ลูกค้าไม่หัก ณ ที่จ่าย
  const inv3 = await finalize((await draftInvoice(C3, [await deliveredOwn(C3, 0)])).id);
  // S-INV-04 ออกเลขแล้ว → ยกเลิกคงเลข (void) + ออกใบแทน (reissue) → S-INV-04R
  const inv4 = await finalize((await draftInvoice(C1, [await deliveredOwn(C1, 0)])).id);
  const voided = ok(
    await fin(
      'POST',
      `/v1/invoices/${inv4.id}/void`,
      { reason: 'ราคาผิด ต้องออกใบใหม่แทน (ตัวอย่างชุดตรวจ)', reissue: true },
      {
        ...ifMatch(inv4.version),
        ...(await stepUp(SUBS.fin)),
      },
    ),
    200,
    'void + reissue',
  ).body;
  const reissueId: string | undefined = voided.replacedByInvoice?.id;
  let inv4r: any = null;
  if (reissueId) inv4r = await finalize(reissueId, prep);
  // S-INV-05 ร่างถูกยกเลิก (ไม่เคยมีเลข)
  const d5 = await draftInvoice(C1, [await deliveredOwn(C1, 1)]);
  const inv5 = ok(
    await prep(
      'POST',
      `/v1/invoices/${d5.id}/cancel`,
      { reason: 'ลูกค้าขอรวมไปรอบหน้า (ตัวอย่างชุดตรวจ)' },
      ifMatch(d5.version),
    ),
    200,
    'cancel draft',
  ).body;
  // S-INV-06 ใบสำหรับกรณีเช็คคืน
  const inv6 = await finalize((await draftInvoice(C1, [await deliveredOwn(C1, 0)])).id);
  log('ใบแจ้งหนี้ครบ');

  // ---------- 5) ใบวางบิล ----------
  const bnInvoices = [inv1.id, inv6.id, ...(inv4r ? [inv4r.id] : [])];
  const bnDraft = ok(
    await prep('POST', '/v1/billing-notes', {
      customerId: C1,
      invoiceIds: bnInvoices,
      collectionDate: TODAY,
    }),
    201,
    'billing note',
  ).body;
  const bn = ok(
    await fin(
      'POST',
      `/v1/billing-notes/${bnDraft.id}/finalize`,
      undefined,
      ifMatch(bnDraft.version),
    ),
    200,
    'bn finalize',
  ).body;
  const bnAck = ok(
    await prep(
      'POST',
      `/v1/billing-notes/${bn.id}/acknowledge`,
      { receivedBy: 'คุณตัวอย่าง รับวางบิล', receivedOn: TODAY },
      ifMatch(bn.version),
    ),
    200,
    'bn acknowledge',
  ).body;
  log('ใบวางบิลครบ');

  // ---------- 6) รับชำระ ----------
  const payment = async (body: object, what: string) =>
    ok(await pay('POST', '/v1/payments', { receivedDate: TODAY, ...body }), 201, what).body;
  // S-PAY-01 รับบางส่วนของ S-INV-01 (โอน) — ใช้หนี้ 5,000 = รับ 4,950 + ถูกหัก 1% 50
  const pay1 = await payment(
    {
      method: 'TRANSFER',
      reference: 'TRF-ตัวอย่าง-0001',
      amountReceived: '4950.00',
      whtAmount: '50.00',
      whtCertificateNo: 'WHT-ตัวอย่าง-0001',
      allocations: [{ invoiceId: inv1.id, amount: '5000.00', whtAmount: '50.00' }],
    },
    'payment partial',
  );
  // S-PAY-02 ส่วนที่เหลือของ S-INV-01 (เช็ค → ผ่าน) — 11,000 = รับ 10,890 + ถูกหัก 110
  const pay2 = await payment(
    {
      method: 'CHEQUE',
      chequeNo: '0000001',
      chequeBank: 'ธนาคารตัวอย่าง',
      chequeDate: TODAY,
      amountReceived: '10890.00',
      whtAmount: '110.00',
      whtCertificateNo: 'WHT-ตัวอย่าง-0002',
      allocations: [{ invoiceId: inv1.id, amount: '11000.00', whtAmount: '110.00' }],
    },
    'payment cheque',
  );
  const pay2c = ok(
    await pay('POST', `/v1/payments/${pay2.id}/clear`, {}, ifMatch(pay2.version)),
    200,
    'cheque clear',
  ).body;
  // S-PAY-03 ใบบรรทัดปน S-INV-02 รับเต็ม (โอน) — ถูกหัก 1% ของค่าขนส่ง + 3% ของค่าขึ้นสินค้า (ตามบรรทัด)
  const inv2Now = await getInv(inv2.id);
  const wht2 = (10000 * 0.01 + 500 * 0.03).toFixed(2);
  const total2 = String(inv2Now.sellTotal);
  const pay3 = await payment(
    {
      method: 'TRANSFER',
      reference: 'TRF-ตัวอย่าง-0003',
      amountReceived: (Number(total2) - Number(wht2)).toFixed(2),
      whtAmount: wht2,
      whtCertificateNo: 'WHT-ตัวอย่าง-0003',
      allocations: [{ invoiceId: inv2.id, amount: total2, whtAmount: wht2 }],
    },
    'payment mixed',
  );
  // S-PAY-04 เช็คของ S-INV-06 → เช็คคืน (bounce) — ใบกลับเป็นค้างชำระ
  const pay4 = await payment(
    {
      method: 'CHEQUE',
      chequeNo: '0000002',
      chequeBank: 'ธนาคารตัวอย่าง',
      chequeDate: TODAY,
      amountReceived: '7920.00',
      whtAmount: '80.00',
      whtCertificateNo: 'WHT-ตัวอย่าง-0004',
      allocations: [{ invoiceId: inv6.id, amount: '8000.00', whtAmount: '80.00' }],
    },
    'payment cheque 2',
  );
  const pay4b = ok(
    await pay(
      'POST',
      `/v1/payments/${pay4.id}/bounce`,
      { reason: 'เช็คคืน เงินในบัญชีไม่พอจ่าย (ตัวอย่าง)' },
      ifMatch(pay4.version),
    ),
    200,
    'cheque bounce',
  ).body;
  // S-PAY-05 ยอดต่ำกว่า 1,000 (เงินสด ไม่หัก)
  const pay5 = await payment(
    {
      method: 'CASH',
      amountReceived: '900.00',
      allocations: [{ invoiceId: inv3.id, amount: '900.00' }],
    },
    'payment cash',
  );
  log('รับชำระครบ');

  // ---------- 7) รถร่วม → ใบสำคัญจ่าย ----------
  const carrier = async (body: object) =>
    ok(await prep('POST', '/v1/carriers', body), 201, 'carrier').body as {
      id: string;
      code: string;
    };
  const K1 = await carrier({
    legalName: 'หจก. ตัวอย่างชุดตรวจรถร่วม',
    entityType: 'JURISTIC',
    taxId: taxId(500),
  });
  const K2 = await carrier({
    legalName: 'นายตัวอย่าง ชุดตรวจ',
    entityType: 'INDIVIDUAL',
    taxId: taxId(501),
  });
  const buyRate = async (carrierId: string, rate: string) => {
    const r = ok(
      await prep('POST', '/v1/rate-cards', {
        side: 'BUY',
        carrierId,
        originId: origin,
        destinationId: dest,
        vehicleTypeId,
        pricingModel: 'PER_TRIP',
        buyRate: rate,
        validFrom: '2026-01-01',
      }),
      201,
      'buy rate',
    ).body;
    await approveRate(r.id);
  };
  // ราคาซื้อ: นิติบุคคล 6,000/เที่ยว · บุคคลธรรมดา 700/เที่ยว (ต่ำกว่าขั้นต่ำ 1,000)
  await buyRate(K1.id, '6000');
  await buyRate(K2.id, '700');
  let plateN = 0;
  /** เที่ยวรถร่วม: เสนองานผ่าน API → (จำลอง) รถร่วมรับงาน + วิ่งจบ + POD ครบ → ปิดต้นทุนผ่าน API (COSTED) */
  const subconTrip = async (carrierId: string, customerId: string) => {
    const { doId, tripId } = await newOrderTrip(customerId);
    ok(
      await prep('POST', `/v1/trips/${tripId}/offer`, {
        carrierId,
        selectionReason: 'รายนี้มีรถว่างช่วงเช้า',
      }),
      200,
      'offer',
    );
    const v = ok(
      await prep('POST', '/v1/vehicles', {
        plate: `8${++plateN}-${String(7000 + plateN)}`,
        plateProvince: 'TH-10',
        vehicleTypeId,
        ownership: 'SUBCONTRACT',
        carrierId,
      }),
      201,
      'subcon vehicle',
    ).body.id as string;
    const tid = uuid('trip', tripId);
    await owner.subconOffer.updateMany({
      where: { tripId: tid, status: 'OFFERED' },
      data: { status: 'ACCEPTED', respondedAt: new Date(), respondedVia: 'USER' },
    });
    await owner.trip.update({
      where: { id: tid },
      data: {
        status: 'COMPLETED',
        vehicleId: uuid('vehicle', v),
        vehiclePlateSnapshot: 'ตัวอย่าง',
        vehicleTypeId: uuid('vehicleType', vehicleTypeId),
        assignmentStatus: 'ACCEPTED',
        completedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await owner.deliveryOrder.update({
      where: { id: uuid('deliveryOrder', doId) },
      data: { status: 'UNBILLED', podStatus: 'COMPLETE' },
    });
    ok(await prep('POST', `/v1/trips/${tripId}/cost`), 200, 'trip cost');
    return tripId;
  };
  const k1Trips = [
    await subconTrip(K1.id, C1),
    await subconTrip(K1.id, C2),
    await subconTrip(K1.id, C1),
  ];
  const k2Trip = await subconTrip(K2.id, C3);
  const k1Extra = await subconTrip(K1.id, C1);

  const settle = async (body: object) =>
    ok(await prep('POST', '/v1/settlements', body), 201, 'settlement').body;
  const approve = async (s: any) =>
    ok(
      await appr(
        'POST',
        `/v1/settlements/${s.id}/approve`,
        { reason: 'ตรวจเที่ยวและรายการหักครบแล้ว (ตัวอย่างชุดตรวจ)' },
        {
          ...ifMatch(s.version),
          ...(await stepUp(SUBS.appr)),
        },
      ),
      200,
      'settlement approve',
    ).body;
  const markPaid = async (s: any, body: object) =>
    ok(
      await pay(
        'POST',
        `/v1/settlements/${s.id}/mark-paid`,
        { paidDate: TODAY, ...body },
        ifMatch(s.version),
      ),
      200,
      'settlement pay',
    ).body;
  // S-STL-01 นิติบุคคล 3 เที่ยว + หักเงินเบิกล่วงหน้า + ค่าปรับ → อนุมัติ → จ่ายโอน
  const s1 = await approve(
    await settle({
      carrierId: K1.id,
      tripIds: k1Trips,
      deductions: [
        {
          deductionType: 'CASH_ADVANCE',
          description: 'เงินเบิกล่วงหน้าค่าน้ำมัน',
          amount: '-2000.00',
          reference: 'ADV-ตัวอย่าง-0001',
        },
        {
          deductionType: 'FINE',
          description: 'ค่าปรับส่งช้า',
          amount: '-500.00',
          reference: 'FINE-ตัวอย่าง-0001',
        },
      ],
      carrierInvoiceNo: 'SUB-INV-ตัวอย่าง-01',
      carrierInvoiceDate: TODAY,
    }),
  );
  const s1p = await markPaid(s1, {
    method: 'TRANSFER',
    reference: 'TRF-AP-ตัวอย่าง-0001',
    bank: 'ธนาคารตัวอย่าง',
  });
  // S-STL-02 บุคคลธรรมดา 1 เที่ยว 700 บาท (ต่ำกว่าขั้นต่ำ) → อนุมัติ → จ่ายเงินสด
  const s2 = await approve(await settle({ carrierId: K2.id, tripIds: [k2Trip] }));
  const s2p = await markPaid(s2, { method: 'CASH' });
  // S-STL-03 ร่างถูกยกเลิก (เที่ยวกลับเข้าคิว)
  const s3d = await settle({ carrierId: K1.id, tripIds: [k1Extra] });
  const s3 = ok(
    await prep(
      'POST',
      `/v1/settlements/${s3d.id}/cancel`,
      { reason: 'รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า' },
      ifMatch(s3d.version),
    ),
    200,
    'settlement cancel',
  ).body;
  log('ใบสำคัญจ่ายครบ');

  // ---------- 8) PDF + manifest ----------
  const token = await tok(SUBS.prep);
  const savePdf = async (path: string, file: string): Promise<string | null> => {
    const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) {
      console.warn(`  ! PDF ${path}: HTTP ${r.status}`);
      return null;
    }
    writeFileSync(resolve(OUT, file), Buffer.from(await r.arrayBuffer()));
    pdfs.push({ file, path });
    return file;
  };
  const invRow = async (c: string, title: string, inv: any, note?: string) => {
    const cur = await getInv(inv.id);
    rows.push({
      case: c,
      title,
      docType: 'INVOICE',
      docNo: cur.invoiceNo,
      status: cur.status,
      amounts: invAmounts(cur),
      pdf: cur.invoiceNo ? await savePdf(`/v1/invoices/${inv.id}/pdf`, `${c}.pdf`) : null,
      note,
    });
  };
  await invRow('S-INV-01', 'ค่าขนส่งล้วน (ยกเว้น VAT) 2 DO · ลูกค้าหัก 1% · รับชำระ 2 งวด', inv1);
  await invRow(
    'S-INV-02',
    'บรรทัดปน: ค่าขนส่ง (ยกเว้น) + ค่าขึ้นสินค้า (VAT 7% / หัก 3%) · ลูกค้าสาขา 00002',
    inv2,
  );
  await invRow('S-INV-03', 'ยอดต่ำกว่า 1,000 บาท · ลูกค้าไม่หัก ณ ที่จ่าย', inv3);
  await invRow('S-INV-04', 'ออกเลขแล้วถูกยกเลิก (void) + ออกใบแทน', inv4, voided.status);
  if (inv4r) await invRow('S-INV-04R', 'ใบที่ออกแทน S-INV-04 (ต้องอ้างเลข/วันที่ใบเดิม)', inv4r);
  else console.warn('  ! ไม่พบ id ใบออกแทนในคำตอบ void — ตรวจรูปแบบคำตอบ');
  await invRow('S-INV-05', 'ร่างถูกยกเลิก (ไม่มีเลข — ไม่กินเลข)', inv5);
  await invRow('S-INV-06', 'ใบที่รับเช็คแล้วเช็คคืน (กลับเป็นค้างชำระ)', inv6);
  const bnCur = ok(await prep('GET', `/v1/billing-notes/${bn.id}`), 200, 'bn').body;
  rows.push({
    case: 'S-BN-01',
    title: 'ใบวางบิลของลูกค้า ก รวม S-INV-01, S-INV-06, S-INV-04R · ลูกค้ารับวางบิลแล้ว',
    docType: 'BILLING_NOTE',
    docNo: bnCur.billingNoteNo,
    status: bnCur.status,
    amounts: {
      total: bnCur.sellTotal,
      whtExpected: bnCur.sellWhtExpected,
      netExpected: bnCur.sellNetExpected,
    },
    pdf: await savePdf(`/v1/billing-notes/${bn.id}/pdf`, 'S-BN-01.pdf'),
    note: `acknowledged: ${bnAck.status}`,
  });
  const payRow = (c: string, title: string, p: any) =>
    rows.push({
      case: c,
      title,
      docType: 'PAYMENT',
      docNo: p.paymentNo,
      status: `${p.status}${p.chequeStatus ? ` / เช็ค ${p.chequeStatus}` : ''}`,
      amounts: {
        amountReceived: p.sellAmountReceived,
        whtAmount: p.sellWhtAmount,
        appliedTotal: p.sellAppliedTotal,
      },
      pdf: null,
      note: 'TMS ไม่ออกใบเสร็จ/ใบกำกับภาษี (D-56) — บันทึกรับชำระเท่านั้น',
    });
  payRow('S-PAY-01', 'รับบางส่วนของ S-INV-01 (โอน) + ถูกหัก 1%', pay1);
  payRow('S-PAY-02', 'รับส่วนที่เหลือของ S-INV-01 (เช็ค → ผ่าน)', pay2c);
  payRow('S-PAY-03', 'รับเต็มใบบรรทัดปน S-INV-02 + ถูกหัก 1%/3% ตามบรรทัด', pay3);
  payRow('S-PAY-04', 'เช็คของ S-INV-06 → เช็คคืน', pay4b);
  payRow('S-PAY-05', 'รับเงินสด S-INV-03 (ยอด < 1,000 ไม่หัก)', pay5);
  const stlRow = async (c: string, title: string, s: any) => {
    const cur = ok(await prep('GET', `/v1/settlements/${s.id}`), 200, 'settlement').body;
    rows.push({
      case: c,
      title,
      docType: 'SETTLEMENT',
      docNo: cur.settlementNo,
      status: cur.status,
      amounts: {
        gross: cur.buyGrossAmount,
        deductions: cur.buyDeductionAmount,
        netPayable: cur.buyNetPayable,
        whtEstimate: cur.buyWhtAmount,
        netAfterWht: cur.buyNetAfterWht,
      },
      pdf: cur.settlementNo ? await savePdf(`/v1/settlements/${s.id}/pdf`, `${c}.pdf`) : null,
    });
  };
  await stlRow(
    'S-STL-01',
    'รถร่วมนิติบุคคล 3 เที่ยว + หักเงินเบิก/ค่าปรับ → อนุมัติ → จ่ายโอน',
    s1p,
  );
  await stlRow(
    'S-STL-02',
    'รถร่วมบุคคลธรรมดา 1 เที่ยว 700 บาท (< 1,000) → อนุมัติ → จ่ายเงินสด',
    s2p,
  );
  await stlRow('S-STL-03', 'ร่างใบสำคัญจ่ายถูกยกเลิก (ไม่มีเลข)', s3);

  await app.close();
  await owner.$disconnect();
  await plat.$disconnect();

  const manifest = {
    generatedAt: new Date().toISOString(),
    runDate: TODAY,
    database: db,
    tenantId,
    cases: rows,
  };
  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const md = [
    `# ชุดเอกสารตัวอย่าง ST5-T25 — สร้างเมื่อ ${manifest.generatedAt} (ฐาน ${db})`,
    '',
    '> ข้อมูลสมมติ · ยอด VAT/WHT ใน TMS เป็นยอดประมาณการ (D-54) · ใช้คู่กับ `plan/sign-offs/st5-t25-ar-ap-checklist.md`',
    '',
    '| กรณี | เอกสาร | เลขที่ | สถานะ | ยอด (จาก API) | PDF | หมายเหตุ |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.case} | ${r.title} | ${r.docNo ?? '—'} | ${r.status} | ${Object.entries(r.amounts)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${v}`)
          .join(' · ')} | ${r.pdf ?? '—'} | ${r.note ?? ''} |`,
    ),
    '',
  ].join('\n');
  writeFileSync(resolve(OUT, 'manifest.md'), md);
  log(`เสร็จ: ${rows.length} กรณี · PDF ${pdfs.length} ไฟล์ → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
