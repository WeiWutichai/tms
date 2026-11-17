import { ERP_CAPABILITIES, type ErpCapability } from '@tms/domain';
import { describe, expect, it } from 'vitest';
import { ERROR_CLASSES } from '../src/modules/integration/outbox.types';
import {
  adapterShapeProblems,
  type CanonicalDocument,
  type ErpAdapter,
  type ErpContext,
  type ExternalRef,
  type HealthResult,
  type PushResult,
} from '../src/modules/erp/erp-adapter';

/**
 * Contract test ที่ ErpAdapter ทุกตัวต้องผ่าน (ST7-T13) — Standalone / Demo (ST7-T14) / FileExport (ST7-T23) / KRS (ST8-T03)
 * ใช้: `describeErpAdapterContract('demo', { make: () => new DemoAdapter(), config: {...}, samples: {...} })` ในไฟล์ test ของ adapter
 *
 * ตรวจ: รูป (method ⇔ capability, key, configFields) · capabilities คงที่และแก้จากภายนอกไม่ได้ ·
 * healthCheck ไม่ throw ทั้งค่าถูก/ผิด · PushResult ถูกรูปและ ErrorClass อยู่ในรายการกลาง ·
 * ส่งซ้ำด้วย idempotencyKey เดิมไม่สร้างเอกสารซ้ำ (externalId เดิม หรือ DUPLICATE) · ไม่มีค่า credential ในผลลัพธ์ใด ๆ
 */
export interface ErpAdapterContractOptions {
  make: () => ErpAdapter;
  /** ค่าตั้งที่ถูกต้อง (healthCheck ควรผ่าน) — ช่อง secret ถูกแทนด้วยค่า sentinel ระหว่างตรวจการรั่ว */
  config: Record<string, string>;
  /** ค่าตั้งที่ credential ผิด → healthCheck ต้อง ok:false (ไม่ throw) · ไม่ส่ง = ข้ามข้อนี้ */
  badConfig?: Record<string, string>;
  /** ตัวอย่าง canonical payload ต่อ operation (ไม่ส่ง = ข้ามการเรียก method นั้น แต่ยังตรวจรูป) */
  samples?: {
    invoice?: CanonicalDocument;
    creditNote?: CanonicalDocument;
    settlement?: CanonicalDocument;
    ref?: ExternalRef;
  };
  /** healthCheck ด้วย `config` ต้องผ่าน (false สำหรับ adapter ที่ต้องมีปลายทางจริง) */
  expectHealthy?: boolean;
}

const SENTINEL = 'SENTINEL-secret-9f2c7e41b6';

function ctxOf(
  adapter: ErpAdapter,
  config: Record<string, string>,
  key = 'contract:1',
): ErpContext {
  return {
    tenantId: '00000000-0000-4000-8000-000000000001',
    connectorId: '00000000-0000-4000-8000-000000000002',
    companyId: null,
    erpCompanyCode: null,
    config: Object.freeze({ ...config }),
    idempotencyKey: key,
  };
}

function expectHealthShape(r: HealthResult) {
  expect(typeof r.ok).toBe('boolean');
  if (!r.ok) {
    expect(ERROR_CLASSES).toContain(r.errorClass);
    expect(typeof r.problem.code).toBe('string');
    expect(typeof r.problem.message).toBe('string');
  }
}

function expectPushShape(r: PushResult) {
  expect(typeof r.ok).toBe('boolean');
  if (r.ok) {
    expect(typeof r.externalId).toBe('string');
    expect(r.externalId.length).toBeGreaterThan(0);
  } else {
    expect(ERROR_CLASSES).toContain(r.errorClass);
    expect(typeof r.retryable).toBe('boolean');
    expect(typeof r.problem.code).toBe('string');
  }
}

export function describeErpAdapterContract(name: string, opts: ErpAdapterContractOptions) {
  describe(`ErpAdapter contract — ${name}`, () => {
    const secretKeys = () =>
      opts
        .make()
        .configFields.filter((f) => f.secret)
        .map((f) => f.key);
    /** config ที่ช่อง secret เป็น sentinel (ถ้า adapter ไม่ต้องการค่าจริงเพื่อทำงาน) */
    const leakConfig = () => ({
      ...opts.config,
      ...Object.fromEntries(secretKeys().map((k) => [k, `${SENTINEL}-${k}`])),
    });
    const noLeak = (v: unknown) => expect(JSON.stringify(v ?? null)).not.toContain(SENTINEL);

    it('รูปถูกต้อง: key, displayName, method ⇔ capability, configFields', () => {
      const a = opts.make();
      expect(adapterShapeProblems(a)).toEqual([]);
    });

    it('capabilities() อยู่ในรายการกลาง คงที่ และแก้จากภายนอกไม่ได้', () => {
      const a = opts.make();
      const first = [...a.capabilities()].sort();
      for (const c of first) expect(ERP_CAPABILITIES).toContain(c);
      try {
        (a.capabilities() as Set<ErpCapability>).add('pushSettlement');
        (a.capabilities() as Set<ErpCapability>).delete(first[0] as ErpCapability);
      } catch {
        /* Set ที่แก้ไม่ได้ก็ผ่าน */
      }
      expect([...a.capabilities()].sort()).toEqual(first);
    });

    it('healthCheck ไม่ throw และคืนรูปถูก (ค่าถูก/ค่าผิด) — ไม่มี credential ในผล', async () => {
      const a = opts.make();
      const good = await a.healthCheck(ctxOf(a, opts.config));
      expectHealthShape(good);
      if (opts.expectHealthy !== false) expect(good.ok).toBe(true);
      if (opts.badConfig) {
        const bad = await a.healthCheck(ctxOf(a, opts.badConfig));
        expectHealthShape(bad);
        expect(bad.ok).toBe(false);
      }
      noLeak(await a.healthCheck(ctxOf(a, leakConfig())));
    });

    it('push/fetch ที่ประกาศ: ผลถูกรูป · ส่งซ้ำ key เดิมไม่สร้างซ้ำ · ไม่มี credential ในผล', async () => {
      const a = opts.make();
      const caps = a.capabilities();
      const s = opts.samples ?? {};
      const pushes: Array<[ErpCapability, CanonicalDocument | undefined, keyof ErpAdapter]> = [
        ['pushInvoice', s.invoice, 'pushInvoice'],
        ['pushCreditNote', s.creditNote, 'pushCreditNote'],
        ['pushSettlement', s.settlement, 'pushSettlement'],
      ];
      for (const [cap, doc, m] of pushes) {
        if (!caps.has(cap) || !doc) continue;
        const fn = a[m] as (c: ErpContext, d: CanonicalDocument) => Promise<PushResult>;
        const ctx = ctxOf(a, opts.config, `contract:${cap}:${doc.id}`);
        const r1 = await fn.call(a, ctx, doc);
        expectPushShape(r1);
        const r2 = await fn.call(a, ctx, doc);
        expectPushShape(r2);
        if (r1.ok)
          expect(r2.ok ? r2.externalId : r2.errorClass).toBe(r2.ok ? r1.externalId : 'DUPLICATE');
        noLeak(await fn.call(a, ctxOf(a, leakConfig(), `contract:leak:${cap}`), doc));
      }
      if (s.ref && caps.has('fetchDocument'))
        noLeak(await a.fetchDocument!(ctxOf(a, leakConfig()), s.ref));
      if (s.ref && caps.has('fetchPaymentStatus')) {
        const p = await a.fetchPaymentStatus!(ctxOf(a, opts.config), s.ref);
        if (p) {
          expect(['UNPAID', 'PARTIALLY_PAID', 'PAID']).toContain(p.status);
          expect(p.paidAmount).toMatch(/^-?\d+(\.\d{1,2})?$/);
        }
      }
    });

    it('pullOrders (ถ้าประกาศ): หน้าไม่เกิน limit + cursor ถูกรูป', async () => {
      const a = opts.make();
      if (!a.capabilities().has('pullOrders')) return;
      const page = await a.pullOrders!(ctxOf(a, opts.config), null, 5);
      expect(Array.isArray(page.orders)).toBe(true);
      expect(page.orders.length).toBeLessThanOrEqual(5);
      expect(page.nextCursor === null || typeof page.nextCursor === 'string').toBe(true);
      expect(typeof page.hasMore).toBe('boolean');
      noLeak(await a.pullOrders!(ctxOf(a, leakConfig()), null, 5));
    });
  });
}
