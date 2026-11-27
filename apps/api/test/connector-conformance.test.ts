import { type MockAccountSystem, startMockAccountSystem } from '@tms/mock-accountsystem';
import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERP_ADAPTER_FACTORIES } from '../src/erp-adapters';
import { AccountSystemAdapter } from '../src/erp-adapters/accountsystem/accountsystem.adapter';
import { DemoAdapter } from '../src/erp-adapters/demo/demo.adapter';
import { KrsAdapter } from '../src/erp-adapters/krs/krs.adapter';
import { STANDALONE_ADAPTER } from '../src/modules/erp/erp-adapter';
import { describeConnectorConformance } from './connector-kit/conformance';
import {
  krsContractContext,
  krsContractInvoice,
  sampleInvoice,
  sampleSettlement,
} from './connector-kit/samples';
import { docOf } from './erp-demo-fixtures';

/**
 * P1-ST5-T01 ชุด conformance กับ adapter ทุกตัวที่ลงทะเบียน (เกณฑ์ตรวจรับ plan/13: "Demo/KRS/AccountSystem adapter เดิมผ่านชุดนี้
 * หรือมีรายการข้อยกเว้นที่อธิบายได้") — ไม่ใช้ฐานข้อมูล · mock ในโปรเซส (พอร์ตสุ่ม) · ไม่ติดต่อระบบจริง
 * ส่วนที่ใช้ฐานข้อมูล (คิว / หยุด connector / external_mapping / แยก tenant ด้วย RLS) = connector-conformance-pipeline.test.ts
 */

describe('ทะเบียน adapter (P1-ST5-T01)', () => {
  it('adapter ทุกตัวใน ERP_ADAPTER_FACTORIES มีชุด conformance ในไฟล์นี้', () => {
    const covered = new Set(['demo', 'krs', 'accountsystem']);
    for (const make of ERP_ADAPTER_FACTORIES) expect(covered).toContain(make().key);
  });
});

describeConnectorConformance('standalone', { make: () => STANDALONE_ADAPTER, config: {} });

// ---------- Demo (ST7-T14) — ไม่ใช้ HTTP: จำลอง fault ด้วยค่าตั้ง failMode / credential `invalid` ----------
describeConnectorConformance('demo (DemoProvider)', {
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
  simulate: (f): Record<string, string> | null => {
    switch (f) {
      case 'auth401':
      case 'auth403':
        return { apiKey: 'invalid' };
      case 'rateLimit429':
      case 'unavailable503':
      case 'serverError500':
        return { failMode: 'TRANSIENT' };
      case 'badRequest400':
      case 'rejected422':
        return { failMode: 'VALIDATION' };
      case 'resetAfterSend':
        return { failMode: 'AMBIGUOUS' };
      case 'duplicate':
        return { failMode: 'DUPLICATE' };
      case 'periodClosed':
        return { failMode: 'PERIOD_CLOSED' };
      default:
        return null; // refused — ไม่มีปลายทางจริง
    }
  },
});

// ---------- AccountSystem (ST8-T16) — mock จาก contract + FaultProxy ----------
const AS_KEY = 'inn_tms_conformance_5c2e';
const as: { m?: MockAccountSystem } = {};
const asGood: Record<string, string> = { baseUrl: '', apiKey: AS_KEY, webhookSecret: 'whsec_c0' };
beforeAll(async () => {
  as.m = await startMockAccountSystem({
    apiKey: AS_KEY,
    webhookSecret: 'whsec_c0',
    contacts: [{ code: 'C-0001', tax_id: '0105555000001', branch_code: '00000', kind: 'customer' }],
  });
  asGood.baseUrl = as.m.url;
});
afterAll(async () => {
  await as.m?.stop();
});
describeConnectorConformance('accountsystem (AccountSystemAdapter)', {
  profile: 'accounting',
  make: () => new AccountSystemAdapter({ allowPrivate: true }),
  config: asGood,
  badConfig: { baseUrl: '', apiKey: 'inn_wrong_key' },
  samples: { invoice: sampleInvoice(90), settlement: sampleSettlement(90) },
  http: { upstream: () => as.m!.url, writePath: /\/ext\/v1\/documents$/ },
  exceptions: {
    resetAfterSend: {
      expect: ['TRANSIENT'],
      reason:
        'AccountSystem กันซ้ำด้วย external_ref (เลข TMS) — ส่งซ้ำหลังสายหลุดได้ร่างเดิม (created=false) จึงลองใหม่แบบ TRANSIENT ได้ปลอดภัย',
    },
  },
});

// ---------- KRS (ST8-T03…T13) — mock KRS + FaultProxy · tenant อื่น = mock ตัวที่สอง ----------
const KRS_KEY = 'krs-conformance-key-1e7c';
const krs: { a?: MockKrs; b?: MockKrs } = {};
const krsGood: Record<string, string> = { baseUrl: '', apiKey: KRS_KEY, salePerson: 'S001' };
beforeAll(async () => {
  krs.a = await startMockKrs({ apiKey: KRS_KEY });
  krs.b = await startMockKrs({ apiKey: KRS_KEY });
  krsGood.baseUrl = krs.a.apiBaseUrl;
});
afterAll(async () => {
  await krs.a?.stop();
  await krs.b?.stop();
});
describeConnectorConformance('krs (KrsAdapter)', {
  make: () => new KrsAdapter({ allowPrivate: true }),
  config: krsGood,
  badConfig: { baseUrl: '', apiKey: 'wrong-key' },
  samples: { invoice: krsContractInvoice() },
  context: krsContractContext(),
  http: {
    upstream: () => krs.a!.apiBaseUrl,
    writePath: /\/invoice$/,
    fixtures: {
      // docs/01 A.5: 409 = tmsVoucherNo ซ้ำ (รูป error ของ KRS)
      duplicate: {
        status: 409,
        body: { status: 409, error: 'CONFLICT', message: 'tmsVoucherNo already exists' },
      },
    },
  },
  isolation: { config: () => ({ ...krsGood, baseUrl: krs.b!.apiBaseUrl }) },
});
