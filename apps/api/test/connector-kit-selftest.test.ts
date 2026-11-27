import type { ErpCapability } from '@tms/domain';
import { describe, expect, it } from 'vitest';
import {
  type CanonicalDocument,
  type ErpAdapter,
  ErpAdapterError,
  type ErpContext,
  type ErpHttpCall,
  type HealthResult,
  notImplementedResult,
  type PushResult,
} from '../src/modules/erp/erp-adapter';
import {
  checkHealthOutcome,
  checkNotFoundFetch,
  checkPendingOutcome,
  checkPushOutcome,
  checkReadOutcome,
  checkSyncLog,
  missingExceptions,
} from './connector-kit/conformance';
import type { CapturedRequest } from './connector-kit/fault-proxy';

/**
 * P1-ST5-T01 self-test ของชุด conformance — adapter ที่**ตั้งใจทำผิด**ต้องถูกตัวตรวจปฏิเสธทุกข้อ
 * (กันชุดตรวจที่ผ่านทุกอย่างแบบเงียบ) + ตัวควบคุมฝั่งถูกต้องต้องผ่าน
 */
class BrokenAdapter implements ErpAdapter {
  readonly key = 'broken';
  readonly displayName = 'Broken';
  readonly configFields = [
    { key: 'baseUrl', secret: false, required: true, kind: 'url' as const },
    { key: 'apiKey', secret: true, required: true, kind: 'string' as const },
  ];
  readonly pendingCapabilities: readonly ErpCapability[] = ['fetchPaymentStatus'];
  capabilities(): ReadonlySet<ErpCapability> {
    return new Set<ErpCapability>(['pushInvoice', 'fetchDocument', 'fetchPaymentStatus']);
  }
  async healthCheck(): Promise<HealthResult> {
    return { ok: true }; // ผิด: ผ่านแม้ปลายทางตอบ 401
  }
  /** ผิด: 401 → TRANSIENT (core จะยิงซ้ำด้วย key ผิด) + รายงาน onHttpCall 2 ครั้งต่อคำขอเดียว */
  async pushInvoice(ctx: ErpContext): Promise<PushResult> {
    const call: ErpHttpCall = {
      method: 'POST',
      url: 'https://erp.invalid/x',
      status: 401,
      durationMs: 1,
    };
    ctx.onHttpCall?.(call);
    ctx.onHttpCall?.(call);
    return {
      ok: false,
      errorClass: 'TRANSIENT',
      retryable: true,
      problem: { code: 'http_401', message: 'x' },
    };
  }
  /** ผิด: key ผิด = Error ธรรมดา · ปลายทางล่ม = null */
  async fetchDocument(ctx: ErpContext): Promise<CanonicalDocument | null> {
    if (ctx.config.mode === 'auth') throw new Error('401 unauthorized');
    return null;
  }
  /** ผิด: ประกาศว่าค้าง แต่ตอบเหมือนทำได้ */
  async fetchPaymentStatus() {
    return { status: 'UNPAID' as const, paidAmount: '0.00', paidAt: null };
  }
}

const ctxOf = (mode: string, calls: ErpHttpCall[] = []): ErpContext => ({
  tenantId: '00000000-0000-4000-8000-0000000000e1',
  connectorId: '00000000-0000-4000-8000-0000000000e2',
  companyId: null,
  erpCompanyCode: null,
  config: { baseUrl: 'https://erp.invalid', apiKey: 'k', mode },
  onHttpCall: (c) => calls.push(c),
});
const settle = async <T>(p: () => Promise<T>) => {
  try {
    return { value: await p() };
  } catch (e) {
    return { thrown: e };
  }
};

describe('connector kit self-test (P1-ST5-T01) — adapter ที่ทำผิดต้องถูกปฏิเสธ', () => {
  const a = new BrokenAdapter();

  it('401 → TRANSIENT ถูกปฏิเสธ (ต้องเป็น AUTH, retryable false)', async () => {
    const r = await a.pushInvoice(ctxOf('auth'));
    const p = checkPushOutcome({ result: r }, 'auth401', ['AUTH']);
    expect(p.length).toBeGreaterThan(0);
    expect(p.join()).toContain('errorClass TRANSIENT');
    // retryable ไม่ตรงกับ class (AUTH ที่บอกว่าลองใหม่ได้) ก็ถูกปฏิเสธ
    const authRetry: PushResult = {
      ok: false,
      errorClass: 'AUTH',
      retryable: true,
      problem: { code: 'unauthorized', message: 'x' },
    };
    expect(checkPushOutcome({ result: authRetry }, 'auth401', ['AUTH']).join()).toContain(
      'retryable',
    );
    // healthCheck ที่ผ่านภายใต้ 401 ก็ถูกปฏิเสธ
    expect(checkHealthOutcome(await a.healthCheck(), 'auth401', ['AUTH'])).not.toEqual([]);
  });

  it('อ่านกลับด้วย key ผิดแล้ว throw Error ธรรมดา ถูกปฏิเสธ (ต้องเป็น ErpAdapterError AUTH)', async () => {
    const o = await settle(() => a.fetchDocument(ctxOf('auth')));
    expect('thrown' in o).toBe(true);
    expect(checkReadOutcome('fetchDocument', o, 'auth401', ['AUTH'])).not.toEqual([]);
    expect(checkReadOutcome('fetchDocument', o, 'auth403', ['AUTH'])).not.toEqual([]);
  });

  it('ปลายทางล่มแล้วคืน null ถูกปฏิเสธ (ต้อง throw — null = core ถือว่าไม่พบ)', async () => {
    const o = await settle(() => a.fetchDocument(ctxOf('down')));
    expect(o).toEqual({ value: null });
    expect(checkReadOutcome('fetchDocument', o, 'unavailable503', ['TRANSIENT'])).not.toEqual([]);
  });

  it('onHttpCall 2 ครั้งต่อ HTTP call เดียว ถูกปฏิเสธ', async () => {
    const calls: ErpHttpCall[] = [];
    await a.pushInvoice(ctxOf('ok', calls));
    const one: CapturedRequest[] = [{ method: 'POST', path: '/x', body: '{}', faulted: false }];
    expect(checkSyncLog(calls, one)).not.toEqual([]);
    expect(checkSyncLog([], null)).not.toEqual([]);
  });

  it('capability ที่ค้างแต่ตอบเหมือนทำได้ ถูกปฏิเสธ', async () => {
    const o = await settle(() => a.fetchPaymentStatus());
    expect(checkPendingOutcome('fetchPaymentStatus', o)).not.toEqual([]);
  });

  it('adapter HTTP ที่ไม่มี fixture ซ้ำ/งวดปิด และไม่มีข้อยกเว้น = ข้อ "ทุกข้อมีข้อยกเว้น" ล้ม', () => {
    const missing = missingExceptions({
      make: () => a,
      config: {},
      http: { upstream: () => 'http://127.0.0.1:1' },
    });
    expect(missing).toEqual(['duplicate', 'periodClosed']);
    // adapter ที่ไม่ใช่ HTTP และไม่ simulate = ทุกข้อขาด
    expect(missingExceptions({ make: () => a, config: {} }).length).toBeGreaterThan(5);
  });
});

describe('connector kit self-test — ผลที่ถูกต้องต้องผ่าน (ตัวควบคุม)', () => {
  it('ทุกตัวตรวจผ่านกับผลที่ถูกต้อง', () => {
    const auth: PushResult = {
      ok: false,
      errorClass: 'AUTH',
      retryable: false,
      problem: { code: 'unauthorized', message: 'x' },
    };
    expect(checkPushOutcome({ result: auth }, 'auth401', ['AUTH'])).toEqual([]);
    expect(checkPushOutcome({ thrown: new Error('503') }, 'unavailable503', ['TRANSIENT'])).toEqual(
      [],
    );
    expect(
      checkHealthOutcome(
        { ok: false, errorClass: 'AUTH', problem: { code: 'u', message: 'x' } },
        'auth401',
        ['AUTH'],
      ),
    ).toEqual([]);
    const authErr = new ErpAdapterError('AUTH', { code: 'unauthorized', message: 'x' });
    expect(checkReadOutcome('fetchDocument', { thrown: authErr }, 'auth401', ['AUTH'])).toEqual([]);
    expect(
      checkReadOutcome('fetchDocument', { thrown: new Error('503') }, 'unavailable503', [
        'TRANSIENT',
      ]),
    ).toEqual([]);
    expect(checkNotFoundFetch({ value: null })).toEqual([]);
    expect(
      checkNotFoundFetch({
        thrown: new ErpAdapterError('NOT_FOUND', { code: 'nf', message: 'x' }),
      }),
    ).toEqual([]);
    expect(checkNotFoundFetch({ thrown: new Error('404') })).not.toEqual([]);
    const call: ErpHttpCall = { method: 'POST', url: 'u', status: 201, durationMs: 1 };
    expect(
      checkSyncLog([call], [{ method: 'POST', path: '/x', body: '{}', faulted: false }]),
    ).toEqual([]);
    expect(
      checkPendingOutcome('pushInvoice', { result: notImplementedResult('pushInvoice') }),
    ).toEqual([]);
  });
});
