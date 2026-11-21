import type { Connector } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger';
import { ConnectorResolver, supports } from '../src/modules/erp/connector-resolver';
import { redactSecrets } from '../src/modules/erp/connectors.service';
import {
  adapterShapeProblems,
  type ErpAdapter,
  STANDALONE_ADAPTER,
} from '../src/modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { describeErpAdapterContract } from './erp-adapter-contract';
import { FakeErpAdapter, GOOD_KEY } from './fake-erp-adapter';

/** ST7-T13 ส่วนที่ไม่แตะฐานข้อมูล: ทะเบียน adapter, การหา connector ต่อ tenant, capability gating, lint rule */

const row = (over: Partial<Connector> = {}): Connector => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  adapterKey: 'fake-erp',
  companyId: null,
  erpCompanyCode: 'PP01',
  branchMap: {},
  capabilitiesEnabled: ['pushInvoice', 'fetchDocument'],
  settings: {},
  credentialsEnc: null,
  credentialKeys: [],
  credentialsUpdatedAt: null,
  syncFromDate: null,
  customerOwner: null,
  taxDocumentOwner: 'TMS',
  fieldSync: {},
  status: 'ACTIVE',
  statusReason: null,
  statusChangedAt: null,
  lastHealthAt: null,
  lastHealthOk: null,
  lastHealthError: null,
  healthFailingSince: null,
  activatedAt: null,
  disconnectedAt: null,
  inboundTokenHash: null,
  inboundTokenPrefix: null,
  inboundTokenRotatedAt: null,
  createdBy: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('ErpAdapterRegistry (ST7-T13)', () => {
  it('ค่าเริ่มต้นไม่มี adapter (ทุก tenant = Standalone) · standalone สงวนไว้ · ซ้ำไม่ได้', () => {
    const reg = new ErpAdapterRegistry();
    expect(reg.list()).toEqual([]);
    expect(reg.get('standalone')).toBe(STANDALONE_ADAPTER);
    expect(reg.get('krs')).toBeNull();
    expect(() => reg.register({ ...STANDALONE_ADAPTER })).toThrow(/reserved/);
    reg.register(new FakeErpAdapter('zeta'));
    reg.register(new FakeErpAdapter('alpha'));
    expect(() => reg.register(new FakeErpAdapter('alpha'))).toThrow(/already registered/);
    // เรียงตามรหัส ไม่มีตัวใดเป็นค่าเริ่มต้น (spec/07 INT-010)
    expect(reg.list().map((a) => a.key)).toEqual(['alpha', 'zeta']);
  });

  it('ปฏิเสธ adapter ที่ประกาศ capability แต่ไม่มี method (และกลับกัน) / key ผิดรูป', () => {
    const reg = new ErpAdapterRegistry();
    const liar: ErpAdapter = {
      key: 'liar',
      displayName: 'Liar',
      configFields: [],
      capabilities: () => new Set(['pushInvoice', 'pushSettlement'] as const),
      healthCheck: async () => ({ ok: true }),
      pushInvoice: async () => ({ ok: true, externalId: '1' }),
      fetchDocument: async () => null,
    };
    expect(adapterShapeProblems(liar)).toEqual([
      "capability 'pushSettlement' declared but method pushSettlement() missing",
      "method fetchDocument() present but capability 'fetchDocument' not declared",
    ]);
    expect(() => reg.register(liar)).toThrow(/invalid/);
    expect(adapterShapeProblems({ ...STANDALONE_ADAPTER, key: 'Bad Key' })[0]).toMatch(/key/);
    expect(
      adapterShapeProblems({
        ...STANDALONE_ADAPTER,
        key: 'x',
        capabilities: () => new Set(['voidInvoice' as never]),
      }),
    ).toContain("unknown capability 'voidInvoice'");
    // ST7-T22 webhook ขาเข้า: ต้องมีครบ verify/parse/handle
    expect(
      adapterShapeProblems({
        ...STANDALONE_ADAPTER,
        key: 'x',
        inbound: { verify: () => false } as never,
      }),
    ).toEqual(['inbound.parse() required', 'inbound.handle() required']);
  });

  it('adapter จำลอง (localOnly) ลงทะเบียนได้เฉพาะ dev/test หรือ ERP_DEMO_ADAPTERS=1 (ไม่ใช่ production — ST7-T14)', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ERP_DEMO_ADAPTERS;
      const demo = Object.assign(new FakeErpAdapter('demo'), { localOnly: true });
      expect(() => new ErpAdapterRegistry().register(demo)).toThrow(/only allowed/);
      process.env.ERP_DEMO_ADAPTERS = '1';
      expect(() => new ErpAdapterRegistry().register(demo)).toThrow(/only allowed/);
      process.env.NODE_ENV = 'staging';
      expect(() => new ErpAdapterRegistry().register(demo)).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
      delete process.env.ERP_DEMO_ADAPTERS;
    }
  });
});

describe('ConnectorResolver.describe — Standalone default + capability gating (ST7-T13)', () => {
  const reg = new ErpAdapterRegistry();
  reg.register(new FakeErpAdapter());
  const resolver = new ConnectorResolver(reg);

  it('ไม่มี connector / ยกเลิกแล้ว = Standalone: ไม่มี capability ใด ไม่ส่ง', () => {
    for (const r of [
      resolver.describe(null),
      resolver.describe(row({ status: 'DISCONNECTED', disconnectedAt: new Date() })),
    ]) {
      expect(r).toMatchObject({
        standalone: true,
        connector: null,
        status: null,
        capabilities: [],
        sending: false,
        scope: 'none',
      });
      expect(r.adapter).toBe(STANDALONE_ADAPTER);
      expect(supports(r, 'pushInvoice')).toBe(false);
    }
  });

  it('capability ที่ใช้ได้ = adapter ∩ เปิด · PAUSED/ERROR เข้าคิวแต่ไม่ส่ง', () => {
    const r = resolver.describe(row({ capabilitiesEnabled: ['pushInvoice', 'pushSettlement'] }));
    expect(r.capabilities).toEqual(['pushInvoice']); // adapter ไม่มี pushSettlement
    expect(r.sending).toBe(true);
    expect(supports(r, 'pushInvoice')).toBe(true);
    expect(supports(r, 'fetchDocument')).toBe(false); // adapter มีแต่ tenant ไม่เปิด
    for (const status of ['PAUSED', 'ERROR'] as const) {
      const p = resolver.describe(row({ status }));
      expect(p.capabilities).toEqual(['pushInvoice', 'fetchDocument']);
      expect(p.sending).toBe(false);
      expect(p.standalone).toBe(false);
    }
  });

  it('adapter ไม่ได้ติดตั้ง: ไม่ถือเป็น Standalone (เอกสารเข้าคิวรอ) และไม่ส่ง', () => {
    const r = resolver.describe(row({ adapterKey: 'gone' }));
    expect(r).toMatchObject({ standalone: false, adapter: null, sending: false });
    expect(r.capabilities).toEqual(['pushInvoice', 'fetchDocument']);
  });

  it('รหัส ERP ของเอกสาร: branchMap[สาขา] → erpCompanyCode', () => {
    const b = '00000000-0000-4000-8000-0000000000b1';
    const c = row({ branchMap: { [b]: 'PP01-CNX' } });
    expect(resolver.describe(c, b).erpCompanyCode).toBe('PP01-CNX');
    expect(resolver.describe(c, '00000000-0000-4000-8000-0000000000b2').erpCompanyCode).toBe(
      'PP01',
    );
  });

  it('log ไม่มี credential ของ connector (body สร้าง/หมุน + ErpContext.config)', () => {
    const lines: string[] = [];
    const log = createLogger(
      new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    );
    log.info({
      body: { credentials: { apiKey: GOOD_KEY } },
      ctx: { config: { apiKey: GOOD_KEY } },
    });
    log.info({ credentials: { token: GOOD_KEY } });
    expect(lines.join('')).not.toContain(GOOD_KEY);
  });

  it('redactSecrets ตัดค่า credential ออกจากข้อความของปลายทาง (ตัวจริง / URL-encoded / base64)', () => {
    expect(redactSecrets(`401 key=${GOOD_KEY} rejected`, [GOOD_KEY, ''])).toBe(
      '401 key=*** rejected',
    );
    const s = 'p@ss/w0rd+ok';
    const b64 = Buffer.from(s).toString('base64');
    const out = redactSecrets(
      `GET https://x/?k=${encodeURIComponent(s)} Authorization: Basic ${b64} url=${Buffer.from(s).toString('base64url')}`,
      [s],
    );
    expect(out).not.toContain(encodeURIComponent(s));
    expect(out).not.toContain(b64.replace(/=+$/, ''));
    expect(out).not.toContain(Buffer.from(s).toString('base64url'));
  });
});

// สัญญาที่ adapter ทุกตัวต้องผ่าน — รันกับ Standalone และ adapter จำลองของ test (ST7-T14/ST8 ใช้ชุดเดียวกัน)
describeErpAdapterContract('standalone', { make: () => STANDALONE_ADAPTER, config: {} });
describeErpAdapterContract('fake-erp (test double)', {
  make: () => new FakeErpAdapter(),
  config: { baseUrl: 'https://erp.example.com', apiKey: GOOD_KEY },
  badConfig: { baseUrl: 'https://erp.example.com', apiKey: 'wrong' },
  samples: {
    invoice: { id: 'inv-1', number: 'INV-00000-2611-0001' },
    ref: { entityType: 'invoice', localId: 'inv-1', number: 'INV-1', externalId: 'ext-1' },
  },
});

describe('lint rule: core ไม่ import adapter ตรง (เกณฑ์ตรวจรับ ST7-T13)', () => {
  const script = join(__dirname, '../scripts/lint-adapters.mjs');
  const dirs: string[] = [];
  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'lint-adapters-'));
    dirs.push(root);
    for (const [p, src] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), src);
    }
    return root;
  };
  const run = (root: string) => {
    try {
      return {
        ok: true,
        out: execFileSync('node', [script, root], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      };
    } catch (e) {
      return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) };
    }
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const base = {
    'erp-adapters/index.ts': "import { KrsAdapter } from './krs/krs.adapter';\n",
    'erp-adapters/krs/krs.adapter.ts': 'export class KrsAdapter {}\n',
    'erp-adapters/demo/demo.adapter.ts': 'export class DemoAdapter {}\n',
    'app.module.ts': "import { ErpAdaptersBootstrap } from './erp-adapters';\n",
    'modules/erp/erp-adapter.ts': 'export interface ErpAdapter {}\n',
  };

  it('repo จริงผ่าน', () => {
    expect(run(join(__dirname, '../src')).ok).toBe(true);
  });

  it('โครงที่ถูก (composition root + app.module) ผ่าน', () => {
    expect(run(tree(base))).toMatchObject({ ok: true });
  });

  it('core import adapter ตรง / dynamic import / อ้างคลาส adapter → ล้ม', () => {
    for (const [file, src] of [
      [
        'modules/billing/invoice.service.ts',
        "import { KrsAdapter } from '../../erp-adapters/krs/krs.adapter';",
      ],
      ['modules/billing/x.ts', "const m = await import('../../erp-adapters/krs/krs.adapter');"],
      ['modules/billing/y.ts', "import { ERP_ADAPTER_FACTORIES } from '../../erp-adapters';"],
      ['modules/billing/z.ts', 'const a = new KrsAdapter();'],
    ] as const) {
      const r = run(tree({ ...base, [file]: src }));
      expect(r.ok, file).toBe(false);
      expect(r.out).toContain(file);
    }
  });

  it('dynamic import แบบ template literal / require.resolve / ไฟล์ .mjs / อ้างชื่อ Provider ของ adapter → ล้ม', () => {
    const withDemo = {
      ...base,
      'erp-adapters/demo/demo.provider.ts': 'export class DemoProvider {}\n',
    };
    for (const [file, src] of [
      ['modules/a.ts', 'const k = "krs"; await import(`../erp-adapters/${k}/krs.adapter`);'],
      ['modules/b.ts', "const p = require.resolve('../erp-adapters/krs/krs.adapter');"],
      ['modules/c.mjs', "import { KrsAdapter } from '../erp-adapters/krs/krs.adapter.ts';"],
      ['modules/d.ts', 'export const make = () => DemoProvider;'],
    ] as const) {
      const r = run(tree({ ...withDemo, [file]: src }));
      expect(r.ok, file).toBe(false);
      expect(r.out).toContain(file);
    }
  });

  it('ST8-T16 กฎ 4: core มีชื่อ adapter (โฟลเดอร์) เป็นโค้ด/สตริง → ล้ม · ใน comment / ใน adapter เอง ผ่าน', () => {
    const withAs = {
      ...base,
      'erp-adapters/accountsystem/accountsystem.adapter.ts':
        "export const KEY = 'accountsystem';\n",
    };
    expect(run(tree(withAs))).toMatchObject({ ok: true });
    expect(
      run(
        tree({
          ...withAs,
          'modules/ok.ts':
            '// ส่งเข้า AccountSystem (comment)\n/* accountsystem */\nexport const x = 1;\n',
        }),
      ),
    ).toMatchObject({ ok: true });
    for (const [file, src] of [
      ['modules/billing/a.ts', "if (c.adapterKey === 'accountsystem') doIt();"],
      ['modules/billing/b.ts', 'const AccountSystemClient = 1;'],
      ['modules/billing/c.ts', 'const u = `/v1/inbound/accountsystem/${t}`;'],
    ] as const) {
      const r = run(tree({ ...withAs, [file]: src }));
      expect(r.ok, file).toBe(false);
      expect(r.out).toContain(`${file}:1  core มีชื่อ adapter`);
    }
  });

  it('adapter import adapter ตัวอื่น → ล้ม', () => {
    const r = run(
      tree({
        ...base,
        'erp-adapters/demo/demo.adapter.ts': "import { KrsAdapter } from '../krs/krs.adapter';\n",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain("adapter 'demo' import adapter 'krs'");
  });
});
