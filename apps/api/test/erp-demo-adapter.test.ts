import { describe, expect, it } from 'vitest';
import {
  DEMO_SAMPLE_ORDERS,
  DemoAdapter,
  demoExternalSuffix,
} from '../src/erp-adapters/demo/demo.adapter';
import { ERP_ADAPTER_FACTORIES } from '../src/erp-adapters';
import { connectorIdOf, docOf } from './erp-demo-fixtures';
import {
  adapterShapeProblems,
  type ErpContext,
  STANDALONE_ADAPTER,
} from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { describeErpAdapterContract } from './erp-adapter-contract';

/** ST7-T14 DemoProvider (ERP จำลอง) + StandaloneProvider — ส่วนที่ไม่แตะฐานข้อมูล */

const TENANT = '00000000-0000-4000-8000-0000000000d1';
const ctx = (config: Record<string, string> = {}, key?: string, connector = 'c1'): ErpContext => ({
  tenantId: TENANT,
  connectorId: connectorIdOf(connector),
  companyId: null,
  erpCompanyCode: null,
  config: Object.freeze({ apiKey: 'demo-key', ...config }),
  idempotencyKey: key,
});

/** เลขภายนอกที่คาดไว้ (hash ของ tenant, connector, ประเภท, idempotency key) */
const ext = (key: string, connector = 'c1', kind = 'invoice') =>
  `DEMO-INV-${demoExternalSuffix(`${TENANT}:${connectorIdOf(connector)}`, kind, key)}`;

describeErpAdapterContract('demo (DemoProvider)', {
  make: () => new DemoAdapter(),
  config: { apiKey: 'demo-key' },
  badConfig: { apiKey: 'invalid' },
  samples: {
    invoice: docOf('inv-1', 'INV-00000-2611-0001', '1070.00'),
    creditNote: docOf('cn-1', 'CN-00000-2611-0001', '107.00'),
    settlement: docOf('stl-1', 'STL-2611-0001', '500.00'),
    ref: {
      entityType: 'invoice',
      localId: 'inv-1',
      number: 'INV-00000-2611-0001',
      externalId: null,
    },
  },
});

describe('DemoProvider (ST7-T14)', () => {
  it('ลงทะเบียนผ่าน composition root เท่านั้น · localOnly (ไม่ใช่ production) · ไม่ใช่ค่าเริ่มต้น', () => {
    const made = ERP_ADAPTER_FACTORIES.map((f) => f());
    const demo = made.find((a) => a.key === 'demo');
    expect(demo).toBeInstanceOf(DemoAdapter);
    expect(demo!.localOnly).toBe(true);
    expect(adapterShapeProblems(demo!)).toEqual([]);
    // standalone ไม่อยู่ในรายการ (อยู่ใน core) — ไม่มี connector = Standalone เสมอ
    expect(made.map((a) => a.key)).not.toContain('standalone');
    const reg = new ErpAdapterRegistry();
    expect(reg.get('standalone')).toBe(STANDALONE_ADAPTER);
    // production (ไม่ตั้ง ERP_DEMO_ADAPTERS) ลงทะเบียน demo ไม่ได้
    const env = { node: process.env.NODE_ENV, demo: process.env.ERP_DEMO_ADAPTERS };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ERP_DEMO_ADAPTERS;
      expect(() => new ErpAdapterRegistry().register(new DemoAdapter())).toThrow(/only allowed/);
      // production ไม่ได้แม้ตั้งธง (review ST7-T14)
      process.env.ERP_DEMO_ADAPTERS = '1';
      expect(ErpAdapterRegistry.demoAllowed()).toBe(false);
      expect(() => new ErpAdapterRegistry().register(new DemoAdapter())).toThrow(/only allowed/);
      // staging/sandbox (NODE_ENV อื่น) + ธง = ได้ · ไม่ตั้งธง = ไม่ได้
      process.env.NODE_ENV = 'staging';
      expect(() => new ErpAdapterRegistry().register(new DemoAdapter())).not.toThrow();
      delete process.env.ERP_DEMO_ADAPTERS;
      expect(ErpAdapterRegistry.demoAllowed()).toBe(false);
    } finally {
      process.env.NODE_ENV = env.node;
      if (env.demo === undefined) delete process.env.ERP_DEMO_ADAPTERS;
      else process.env.ERP_DEMO_ADAPTERS = env.demo;
    }
  });

  it('Standalone: ไม่มี capability ใด · healthCheck ผ่านเสมอ · ไม่มี method ส่ง/ดึง', async () => {
    expect([...STANDALONE_ADAPTER.capabilities()]).toEqual([]);
    expect(await STANDALONE_ADAPTER.healthCheck(ctx())).toEqual({ ok: true });
    expect(STANDALONE_ADAPTER.pushInvoice).toBeUndefined();
    expect(STANDALONE_ADAPTER.pullOrders).toBeUndefined();
  });

  it('รับ invoice → เลขภายนอกคงที่ (deterministic) · key เดิม = ใบเดิม · เลขอ้างอิงซ้ำด้วย key อื่น = DUPLICATE · แยก connector/tenant', async () => {
    const a = new DemoAdapter();
    const inv = docOf('inv-1', 'INV-1', '1070.00');
    const r1 = await a.pushInvoice(ctx({}, 'k1'), inv);
    expect(r1).toMatchObject({
      ok: true,
      externalId: ext('k1'),
      externalDocNo: `DMINV${ext('k1').slice(9, 19)}`,
      externalVersion: '1',
    });
    expect(ext('k1')).toMatch(/^DEMO-INV-[0-9A-F]{12}$/);
    expect(await a.pushInvoice(ctx({}, 'k1'), inv)).toMatchObject({ externalId: ext('k1') });
    // restart (instance ใหม่) + เอกสารอื่น → เลขไม่ซ้ำของเดิม · คำสั่งเดิม → เลขเดิม
    const b = new DemoAdapter();
    expect(await b.pushInvoice(ctx({}, 'k-other'), docOf('inv-2', 'INV-2'))).toMatchObject({
      externalId: ext('k-other'),
    });
    expect(ext('k-other')).not.toBe(ext('k1'));
    expect(await b.pushInvoice(ctx({}, 'k1'), inv)).toMatchObject({ externalId: ext('k1') });
    expect(await a.pushInvoice(ctx({}, 'k2'), inv)).toMatchObject({
      ok: false,
      errorClass: 'DUPLICATE',
      raw: { externalId: ext('k1') },
    });
    // connector อื่น = ERP คนละตัว (ไม่เห็นกัน)
    expect(await a.pushInvoice(ctx({}, 'k1', 'c2'), inv)).toMatchObject({
      ok: true,
      externalId: ext('k1', 'c2'),
    });
    expect(ext('k1', 'c2')).not.toBe(ext('k1'));
    expect(a.documents(TENANT, connectorIdOf('c1'))).toHaveLength(1);
    expect(a.documents(TENANT, connectorIdOf('c2'))).toHaveLength(1);
    // payload ผิด
    expect(await a.pushInvoice(ctx({}, 'k9'), { id: '', number: '' })).toMatchObject({
      ok: false,
      errorClass: 'VALIDATION',
    });
  });

  it('ฉีด error ทีละ class จากค่าตั้ง (failMode) · failTimes = ล้ม n ครั้งแล้วสำเร็จ', async () => {
    const a = new DemoAdapter();
    const cases = [
      ['TRANSIENT', true],
      ['VALIDATION', false],
      ['AUTH', false],
      ['NOT_FOUND', false],
      ['PERIOD_CLOSED', false],
    ] as const;
    for (const [mode, retryable] of cases) {
      const r = await a.pushInvoice(ctx({ failMode: mode }, `f-${mode}`), docOf(mode, `N-${mode}`));
      expect(r).toMatchObject({ ok: false, errorClass: mode, retryable });
    }
    expect(a.documents(TENANT, connectorIdOf('c1'))).toHaveLength(0); // ล้มแบบนี้ไม่บันทึก
    // VALIDATION มีรายช่องที่ผิด (หน้าคิวแสดง field)
    const v = await a.pushInvoice(ctx({ failMode: 'VALIDATION' }, 'v'), docOf('v', 'V'));
    expect(!v.ok && v.problem.fields?.[0]?.field).toBe('customer.externalId');
    // ล้ม 2 ครั้งแล้วสำเร็จ
    const c = ctx({ failMode: 'TRANSIENT', failTimes: '2' }, 'retry-me');
    const d = docOf('r', 'R-1');
    expect((await a.pushInvoice(c, d)).ok).toBe(false);
    expect((await a.pushInvoice(c, d)).ok).toBe(false);
    expect(await a.pushInvoice(c, d)).toMatchObject({ ok: true });
    // healthCheck ล้มเฉพาะ AUTH / credential ผิด
    expect((await a.healthCheck(ctx({ failMode: 'TRANSIENT' }))).ok).toBe(true);
    expect(await a.healthCheck(ctx({ failMode: 'AUTH' }))).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
    });
    expect(await a.healthCheck(ctx({ apiKey: 'invalid' }))).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
    });
  });

  it('AMBIGUOUS: ERP ได้รับแล้วแต่ตอบไม่ทัน → ส่งใหม่ด้วย key เดิมได้ใบเดิม (ไม่ซ้ำ)', async () => {
    const a = new DemoAdapter();
    const c = ctx({ failMode: 'AMBIGUOUS', failTimes: '1' }, 'amb');
    const d = docOf('amb', 'AMB-1');
    expect(await a.pushInvoice(c, d)).toMatchObject({
      ok: false,
      errorClass: 'AMBIGUOUS',
      retryable: true,
    });
    expect(a.documents(TENANT, connectorIdOf('c1'))).toHaveLength(1);
    expect(await a.pushInvoice(c, d)).toMatchObject({ ok: true, externalId: ext('amb') });
    expect(a.documents(TENANT, connectorIdOf('c1'))).toHaveLength(1);
  });

  it('fetch / สถานะรับชำระ (เงินเป็นสตริง ไม่ใช้ float) / list / replace', async () => {
    const a = new DemoAdapter();
    a.now = () => new Date('2026-11-18T03:00:00Z');
    await a.pushInvoice(ctx({}, 'p1'), docOf('inv-9', 'INV-9', '1070.15'));
    const ref = { entityType: 'invoice', localId: 'inv-9', number: 'INV-9', externalId: null };
    expect(await a.fetchDocument(ctx(), ref)).toMatchObject({
      id: 'inv-9',
      number: 'INV-9',
      externalId: ext('p1'),
    });
    expect(await a.fetchDocument(ctx(), { ...ref, number: 'nope' })).toBeNull();
    expect(await a.fetchPaymentStatus(ctx(), ref)).toEqual({
      status: 'UNPAID',
      paidAmount: '0.00',
      paidAt: null,
    });
    expect(await a.fetchPaymentStatus(ctx({ paymentStatus: 'PAID' }), ref)).toEqual({
      status: 'PAID',
      paidAmount: '1070.15',
      paidAt: '2026-11-18T03:00:00.000Z',
    });
    expect(await a.fetchPaymentStatus(ctx({ paymentStatus: 'PARTIALLY_PAID' }), ref)).toMatchObject(
      {
        status: 'PARTIALLY_PAID',
        paidAmount: '535.07',
      },
    );
    expect(await a.listDocuments(ctx(), { ref: 'INV-9', limit: 10 })).toEqual({
      items: [{ entityType: 'invoice', localId: 'inv-9', number: 'INV-9', externalId: ext('p1') }],
      next: null,
    });
    const rep = await a.replaceDocument(
      ctx({}, 'rep-1'),
      { ...ref, externalId: ext('p1') },
      docOf('inv-9', 'INV-9', '1000.00'),
    );
    expect(rep).toMatchObject({ ok: true, externalVersion: '2' });
    // key เดิม = ไม่เพิ่มฉบับ
    expect(
      await a.replaceDocument(
        ctx({}, 'rep-1'),
        { ...ref, externalId: ext('p1') },
        docOf('inv-9', 'INV-9'),
      ),
    ).toMatchObject({ externalVersion: '2' });
    expect(
      await a.replaceDocument(
        ctx({}, 'rep-2'),
        { ...ref, externalId: 'DEMO-INV-999999' },
        docOf('x', 'X'),
      ),
    ).toMatchObject({ ok: false, errorClass: 'NOT_FOUND' });
  });

  it('pullOrders: order ตัวอย่าง 5 ใบ ทีละหน้า · ดึงซ้ำได้ข้อมูลเดิม · ต้นทางล่ม/credential ผิด = throw (ไม่มี credential ในข้อความ)', async () => {
    const a = new DemoAdapter();
    const p1 = await a.pullOrders(ctx(), null, 3);
    expect(p1.orders.map((o) => o.externalId)).toEqual([
      'DEMO-SO-0001',
      'DEMO-SO-0002',
      'DEMO-SO-0003',
    ]);
    expect(p1).toMatchObject({ nextCursor: '3', hasMore: true });
    const p2 = await a.pullOrders(ctx(), p1.nextCursor, 3);
    expect(p2.orders).toHaveLength(DEMO_SAMPLE_ORDERS - 3);
    expect(p2).toMatchObject({ nextCursor: '5', hasMore: false });
    expect(await a.pullOrders(ctx(), null, 3)).toEqual(p1);
    await expect(a.pullOrders(ctx({ failMode: 'TRANSIENT' }), null, 3)).rejects.toThrow(
      /unavailable/,
    );
    await expect(a.pullOrders(ctx({ apiKey: 'invalid' }), null, 3)).rejects.toThrow(/rejected/);
    await expect(
      a.pullOrders(ctx({ apiKey: 'SECRET-xyz-123', failMode: 'AUTH' }), null, 3),
    ).rejects.not.toThrow(/SECRET/);
  });
});
