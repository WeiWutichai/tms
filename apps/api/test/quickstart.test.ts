import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseQuickstartCurl, type CurlStep } from '@tms/api-docs';
import { verifyWebhookSignature } from '@tms/sdk';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { copyLegalEntities, SandboxService } from '../src/modules/sandbox/sandbox.service';
import { signatureHeader } from '../src/modules/webhooks/signature';
import { QUICKSTART_SCOPES, runQuickstart } from '../../../packages/api-docs/examples/quickstart';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST7-T12 เกณฑ์ตรวจรับ: "คนนอกทีมทำตาม quickstart สร้าง order ใน sandbox ได้"
 * รันขั้นตอนของ quickstart ที่เผยแพร่จริง (packages/api-docs/site/quickstart.md) กับ API ที่ฟังพอร์ตจริง ด้วย key `tk_test_`
 * (1) ตัวอย่าง TypeScript (examples/quickstart.ts — ไฟล์เดียวกับที่ฝังในหน้า) ผ่าน @tms/sdk
 * (2) คำสั่ง curl ทุกบล็อกในหน้า (แปลงเป็น fetch ตามลำดับ แทนตัวแปรจาก response ก่อนหน้า)
 * บริษัทมี **2 นิติบุคคล** ไม่ตั้งค่าออกบิลในนาม (QA ST7-T12: กรณีที่ quickstart เดิมล้มด้วย routing_not_configured)
 */
describe('quickstart ของเอกสาร API (ST7-T12)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let baseUrl = '';
  let liveId = '';
  let apiKey = '';

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    liveId = (await createTenantWithDefaults(db, { name: 'บริษัท ทดลองเชื่อมระบบ' })).id;
    await legalEntity(liveId, 701, 'ERP-CO-1');
    await legalEntity(liveId, 704);
    const userId = (
      await db.appUser.create({
        data: { tenantId: liveId, email: 'dev@qs.test', name: 'นักพัฒนา', status: 'ACTIVE' },
      })
    ).id;
    const admin = await tokenFor(liveId, '*', userId);
    // ขั้น 1 ของ quickstart ทำบนหน้าเว็บ: นักพัฒนา / Open API → สลับ Sandbox → สร้าง API key (= คำขอเดียวกับที่หน้าเว็บส่ง)
    const k = await api(app, admin)
      .post('/v1/api-keys')
      .set('X-Tms-Mode', 'test')
      .send({ name: 'quickstart', mode: 'test', scopes: QUICKSTART_SCOPES });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    apiKey = k.body.secret;
    expect(apiKey).toMatch(/^tk_test_/);
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
  });

  async function legalEntity(tenantId: string, seed: number, externalId?: string) {
    const c = await db.company.create({
      data: {
        tenantId,
        legalName: `บริษัท ผู้ออกบิล ${seed} จำกัด`,
        taxId: validTaxId(seed),
        externalId: externalId ?? null,
      },
    });
    await db.branch.create({
      data: {
        tenantId,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: { line1: '1 ถ.พระราม 4 กรุงเทพฯ 10110' },
        isDefaultIssuer: true,
      },
    });
    return c;
  }

  const sandboxId = async () =>
    (await db.tenant.findUniqueOrThrow({ where: { liveTenantId: liveId } })).id;

  it('ตัวอย่าง TypeScript (@tms/sdk) สร้าง order ใน sandbox · รันซ้ำ = ใบเดิม · ไม่มีข้อมูลใน live', async () => {
    const r = await runQuickstart({ baseUrl, apiKey });
    expect(r.order.id).toMatch(/^ord_/);
    expect(r.order).toMatchObject({ source: 'API', externalId: 'QS-ORDER-001' });
    expect(['received', 'on_hold']).toContain(r.order.status);
    expect(r.order.stops.map((s) => s.siteId)).toEqual([r.pickup.id, r.dropoff.id]);
    const again = await runQuickstart({ baseUrl, apiKey });
    expect(again.order.id).toBe(r.order.id);
    const row = await db.salesOrder.findUniqueOrThrow({
      where: { id: tryDecodeId('salesOrder', r.order.id)! },
    });
    expect(row.tenantId).toBe(await sandboxId());
    expect(await db.salesOrder.count({ where: { tenantId: liveId } })).toBe(0);
    expect(r.order.billingCompanyId).toMatch(/^cmp_/);
  });

  it('หลายนิติบุคคล + ไม่ส่ง billingCompanyId → 422 routing_not_configured ที่ช่อง billingCompanyId (ข้อความไทย)', async () => {
    const res = await fetch(`${baseUrl}/v1/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestedDate: '2026-12-01',
        customer: { name: 'ลูกค้าทดลอง' },
        stops: [{ type: 'PICKUP', siteText: 'คลัง' }],
      }),
    });
    expect(res.status).toBe(422);
    const p = (await res.json()) as {
      code: string;
      errors: { field: string; code: string; message: string }[];
    };
    expect(p.code).toBe('validation_failed');
    expect(p.errors).toEqual([
      expect.objectContaining({ field: 'billingCompanyId', code: 'routing_not_configured' }),
    ]);
    expect(p.errors[0]!.message).toMatch(/หลายนิติบุคคล/);
  });

  it('คำสั่ง curl ทุกบล็อกในหน้า quickstart ที่เผยแพร่ รันได้ตามลำดับ และจบด้วย order ใน sandbox', async () => {
    const md = readFileSync(
      resolve(__dirname, '../../../packages/api-docs/site/quickstart.md'),
      'utf8',
    );
    const steps: CurlStep[] = parseQuickstartCurl(md);
    expect(steps.length).toBeGreaterThanOrEqual(7);
    const vars: Record<string, string> = { TMS_BASE_URL: baseUrl, TMS_API_KEY: apiKey };
    const sub = (s: string) =>
      s.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, n: string) => {
        if (!(n in vars)) throw new Error(`ตัวแปร ${n} ยังไม่ถูกตั้งก่อนใช้ใน: ${s}`);
        return vars[n]!;
      });
    let last: { id?: string; status?: string } = {};
    for (const st of steps) {
      const headers = Object.fromEntries(st.headers.map(([k, v]) => [k, sub(v)]));
      const res = await fetch(sub(st.url), {
        method: st.method,
        headers,
        ...(st.body !== undefined ? { body: sub(st.body) } : {}),
      });
      const text = await res.text();
      expect(res.status, `${st.method} ${st.url}: ${text}`).toBeLessThan(300);
      last = JSON.parse(text);
      if (st.capture) {
        // jq -e: null/ไม่มีค่า = ล้ม (เหมือน shell ที่ set -e)
        const v = jqPath(last, st.capture.path);
        expect(v, `${st.capture.variable} จาก ${st.capture.path}`).toBeTruthy();
        vars[st.capture.variable] = String(v);
      }
    }
    expect(last.id).toMatch(/^ord_/);
    const row = await db.salesOrder.findUniqueOrThrow({
      where: { id: tryDecodeId('salesOrder', last.id!)! },
    });
    expect(row.tenantId).toBe(await sandboxId());
  });

  it('sandbox ได้นิติบุคคล + สาขาของบริษัทจริง (ไม่มี = สร้าง order ไม่ได้) · คัดลอกครั้งเดียว · ค่าออกบิลในนามชี้ตัวที่คัดลอก', async () => {
    const sb = await sandboxId();
    const [live] = await db.company.findMany({ where: { tenantId: liveId } });
    const copies = await db.company.findMany({
      where: { tenantId: sb },
      orderBy: { createdAt: 'asc' },
    });
    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({
      legalName: live!.legalName,
      taxId: live!.taxId,
      externalId: null,
    });
    expect(copies[0]!.id).not.toBe(live!.id);
    expect(await db.branch.count({ where: { tenantId: sb, companyId: copies[0]!.id } })).toBe(1);
    expect(
      await db.auditLog.count({
        where: { tenantId: liveId, action: 'sandbox.entities_copied', entityId: sb },
      }),
    ).toBe(1);
    // sandbox ที่สร้างก่อนมีนิติบุคคล (เช่น ก่อน ST7-T12) → คัดลอกตอนสลับโหมดครั้งถัดไป · มีแล้ว = ไม่คัดลอกซ้ำ
    const live2 = (await createTenantWithDefaults(db, { name: 'บริษัท สอง' })).id;
    const sb2 = (
      await db.tenant.create({
        data: { name: 'บริษัท สอง (Sandbox)', status: 'ACTIVE', mode: 'test', liveTenantId: live2 },
      })
    ).id;
    const a = await legalEntity(live2, 702);
    await legalEntity(live2, 703);
    await db.tenantSetting.create({
      data: {
        tenantId: live2,
        key: 'routing.invoiceAsCompanyId',
        value: encodeId('company', a.id),
      },
    });
    expect(await db.$transaction((tx) => copyLegalEntities(tx, live2, sb2))).toBe(2);
    expect(await db.$transaction((tx) => copyLegalEntities(tx, live2, sb2))).toBe(0);
    expect(await db.company.count({ where: { tenantId: sb2 } })).toBe(2);
    const setting = await db.tenantSetting.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: sb2, key: 'routing.invoiceAsCompanyId' } },
    });
    const target = await db.company.findUniqueOrThrow({
      where: { id: tryDecodeId('company', setting.value as string)! },
    });
    expect(target).toMatchObject({ tenantId: sb2, taxId: a.taxId });
  });

  async function liveWithUser(name: string) {
    const id = (await createTenantWithDefaults(db, { name })).id;
    const u = await db.appUser.create({
      data: { tenantId: id, email: `${id}@qs.test`, name: 'ผู้ดูแล', status: 'ACTIVE' },
    });
    return { id, admin: await tokenFor(id, '*', u.id) };
  }

  it('ensure(): sandbox ที่ยังไม่มีนิติบุคคล → คัดลอกครั้งเดียวแม้คำขอแรกมาพร้อมกัน (advisory lock) + audit', async () => {
    const svc = app.get(SandboxService);
    const live = await liveWithUser('บริษัท สาม');
    const sb = await svc.ensure(live.id); // บริษัทจริงยังไม่มีนิติบุคคล → sandbox ว่าง (ไม่จำ — ตรวจใหม่ครั้งหน้า)
    expect(await db.company.count({ where: { tenantId: sb } })).toBe(0);
    await legalEntity(live.id, 705);
    await legalEntity(live.id, 706);
    const ids = await Promise.all([svc.ensure(live.id), svc.ensure(live.id), svc.ensure(live.id)]);
    expect(new Set(ids)).toEqual(new Set([sb]));
    expect(await db.company.count({ where: { tenantId: sb } })).toBe(2);
    const audits = await db.auditLog.findMany({
      where: { tenantId: live.id, action: 'sandbox.entities_copied' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ reason: 'backfill', companies: 2 });
  });

  it('sandbox ที่ใช้ผ่าน key tk_test_ อย่างเดียว ได้นิติบุคคลตอนยืนยัน key', async () => {
    const live = await liveWithUser('บริษัท สี่');
    const k = await api(app, live.admin)
      .post('/v1/api-keys')
      .set('X-Tms-Mode', 'test')
      .send({ name: 'key only', mode: 'test', scopes: ['companies:read'] })
      .expect(201);
    const sb = (await db.tenant.findUniqueOrThrow({ where: { liveTenantId: live.id } })).id;
    expect(await db.company.count({ where: { tenantId: sb } })).toBe(0);
    await legalEntity(live.id, 707); // ตั้งนิติบุคคลหลังสร้าง sandbox แล้วไม่มีใครสลับโหมดอีก
    const res = await fetch(`${baseUrl}/v1/companies`, {
      headers: { Authorization: `Bearer ${k.body.secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { taxId: string }[] };
    expect(body.data.map((c) => c.taxId)).toEqual([validTaxId(707)]);
  });

  it('ตัวตรวจลายเซ็นของ SDK ยอมรับลายเซ็นที่เซิร์ฟเวอร์สร้าง (รวมช่วงหมุน secret 2 ตัว)', async () => {
    const body = JSON.stringify({ id: 'evt_x', type: 'order.created', data: { object: {} } });
    const t = Math.floor(Date.now() / 1000);
    const header = signatureHeader(t, body, ['whsec_new', 'whsec_old']);
    expect(await verifyWebhookSignature({ rawBody: body, header, secret: 'whsec_old' })).toEqual({
      ok: true,
      timestamp: t,
    });
    expect(
      (await verifyWebhookSignature({ rawBody: `${body} `, header, secret: 'whsec_new' })).ok,
    ).toBe(false);
  });
});

/** `jq -r .a.b` / `.data[0].id` แบบง่าย */
function jqPath(obj: unknown, path: string): unknown {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}
