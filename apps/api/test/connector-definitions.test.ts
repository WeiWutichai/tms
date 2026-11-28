import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTOR_DEFINITIONS, ERP_ADAPTER_FACTORIES } from '../src/erp-adapters';
import {
  type ConnectorDefinition,
  definitionProblems,
} from '../src/modules/erp/connector-definition';
import { ErpAdapterRegistry } from '../src/modules/erp/erp-adapter.registry';
import { FakeErpAdapter } from './fake-erp-adapter';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST5-T01b ConnectorDefinition ของ FlowAccount / PEAK (plan/13 R-01 · D-55 · docs/02 §3.1 · spec/07 INT-010)
 * - การ์ดมาจาก catalog (`GET /v1/connectors/adapters`) — ไม่ hard-code ในหน้าจอ
 * - ยังไม่มี adapter (รอ X-02 / X-03) → `availability: COMING_SOON` · เชื่อมต่อไม่ได้ (422 `adapter_coming_soon`, ไม่เกิดแถว)
 * - credential schema: ทุกช่องที่ใช้ยืนยันตัวตน `secret: true` · เจ้าของเอกสารภาษี = ERP ตายตัว · ไม่มี pushCreditNote
 * - gating: feature `conn` (แพ็กเกจที่ไม่มี = 403) · `minTier: growth` เป็นข้อมูลประกอบจนกว่า P1-ST1-T01 merge
 */
describe('ConnectorDefinition FlowAccount / PEAK (P1-ST5-T01b)', () => {
  let app: NestExpressApplication;
  const plat: PrismaClient = platform();
  let tenantId: string;
  let token: string;
  let starterToken: string;
  type Cat = {
    key: string;
    displayName: string;
    availability: string;
    capabilities: string[];
    capabilitiesPending: string[];
    fixedTaxDocumentOwner: string | null;
    requiredFeature: string;
    minTier: string | null;
    configFields: { key: string; secret: boolean; required: boolean; options: string[] | null }[];
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(plat, 'บริษัท ดูการ์ดเชื่อมต่อ')).id;
    await plat.tenant.update({ where: { id: tenantId }, data: { planCode: 'std' } });
    token = await tokenFor(tenantId);
    const starter = (await createTenant(plat, 'บริษัท แพ็กเกจเริ่มต้น')).id;
    await plat.tenant.update({ where: { id: starter }, data: { planCode: 'start' } });
    starterToken = await tokenFor(starter);
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('catalog: FlowAccount + PEAK = COMING_SOON · ERP เป็นเจ้าของเอกสารภาษี · capability ทั้งหมดยังไม่รองรับ · credential ลับ · เรียงตามรหัส', async () => {
    const r = await api(app, token).get('/v1/connectors/adapters').expect(200);
    const list = r.body.data as Cat[];
    const keys = list.map((a) => a.key);
    expect(keys).toEqual([...keys].sort());
    for (const key of ['flowaccount', 'peak']) {
      const d = list.find((a) => a.key === key)!;
      expect(d, key).toMatchObject({
        availability: 'COMING_SOON',
        fixedTaxDocumentOwner: 'ERP',
        requiredFeature: 'conn',
        minTier: 'growth',
        capabilities: ['pushInvoice', 'pushSettlement', 'fetchDocument', 'fetchPaymentStatus'],
      });
      expect(d.capabilitiesPending).toEqual(d.capabilities);
      expect(d.capabilities).not.toContain('pushCreditNote');
      expect(d.configFields.filter((f) => !f.options).every((f) => f.secret && f.required)).toBe(
        true,
      );
    }
    expect(list.find((a) => a.key === 'flowaccount')!.displayName).toBe('FlowAccount');
    expect(list.find((a) => a.key === 'flowaccount')!.configFields.map((f) => f.key)).toEqual([
      'environment',
      'clientId',
      'clientSecret',
    ]);
    expect(list.find((a) => a.key === 'peak')!.configFields.map((f) => f.key)).toEqual([
      'clientToken',
      'userToken',
      'connectId',
    ]);
    // adapter ที่ทำแล้ว = AVAILABLE
    for (const a of list.filter((x) => !['flowaccount', 'peak'].includes(x.key)))
      expect(a.availability, a.key).toBe('AVAILABLE');
    expect(list.find((a) => a.key === 'demo')).toMatchObject({ requiredFeature: 'conn' });
  });

  it('เชื่อมต่อไม่ได้: POST /connectors → 422 adapter_coming_soon · ไม่เกิดแถว connector · ไม่มี audit', async () => {
    for (const adapterKey of ['flowaccount', 'peak']) {
      const r = await api(app, token)
        .post('/v1/connectors')
        .send({
          adapterKey,
          settings: { environment: 'sandbox' },
          credentials: { clientId: 'x', clientSecret: 'y', clientToken: 'a', userToken: 'b' },
        });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.errors[0]).toMatchObject({ field: 'adapterKey', code: 'adapter_coming_soon' });
      expect(JSON.stringify(r.body)).not.toContain('clientSecret":"y');
    }
    expect(await plat.connector.count({ where: { tenantId } })).toBe(0);
    expect(
      await plat.auditLog.count({ where: { tenantId, action: { startsWith: 'connector.' } } }),
    ).toBe(0);
  });

  it('gating: แพ็กเกจที่ไม่มีการเชื่อมต่อ (conn) → catalog 403 feature_not_in_plan', async () => {
    const r = await api(app, starterToken).get('/v1/connectors/adapters');
    expect(r.status, JSON.stringify(r.body)).toBe(403);
  });

  it('registry: key ซ้ำกับ adapter/definition = error · adapter ตัวจริงมาแล้ว definition หายจาก catalog · definition ผิดกติกาไม่ผ่าน', () => {
    const reg = new ErpAdapterRegistry();
    for (const make of ERP_ADAPTER_FACTORIES) reg.register(make());
    for (const d of CONNECTOR_DEFINITIONS) reg.define(d);
    expect(reg.definitions().map((d) => d.key)).toEqual(['flowaccount', 'peak']);
    expect(() => reg.define(CONNECTOR_DEFINITIONS[0]!)).toThrow(/already registered/);
    expect(() => reg.register(new FakeErpAdapter('peak', ['pushInvoice']))).toThrow(
      /coming-soon definition/,
    );
    // test: adapter ตัวจริง (replace) → ไม่ใช่ COMING_SOON อีก
    reg.replace(new FakeErpAdapter('flowaccount', ['pushInvoice']));
    expect(reg.comingSoon('flowaccount')).toBeNull();
    expect(reg.definitions().map((d) => d.key)).toEqual(['peak']);
    // sandbox ไม่เห็น definition (ใช้ได้เฉพาะ adapter จำลอง)
    expect(reg.definitions(true)).toEqual([]);
    const bad: ConnectorDefinition = {
      ...CONNECTOR_DEFINITIONS[1]!,
      key: 'Bad Key',
      configFields: [{ key: 'apiToken', secret: false, required: true, kind: 'string' }],
    };
    const p = definitionProblems(bad);
    expect(p.join('\n')).toMatch(/key 'Bad Key'/);
    expect(p.join('\n')).toMatch(/apiToken' looks like a credential/);
    for (const d of CONNECTOR_DEFINITIONS) expect(definitionProblems(d), d.key).toEqual([]);
  });
});
