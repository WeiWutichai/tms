import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { resetPublicRateLimit } from '../src/http/public-rate-limit.middleware';
import { MessageDispatcher, RETRY_BASE_S } from '../src/modules/messaging/message-dispatcher';
import { MessagingProviders } from '../src/modules/messaging/messaging.providers';
import {
  RECIPIENT_PER_HOUR,
  RECIPIENT_PLATFORM_PER_HOUR,
  TENANT_PER_HOUR,
} from '../src/modules/messaging/messaging.service';
import { BlindIndex } from '../src/common/blind-index';
import { LineMessagingProvider, MockMessagingProvider } from '../src/modules/messaging/providers';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const LINE_UID = `U${'0a1b2c3d'.repeat(4)}`;
const LINE_TOKEN = 'FakeChannelAccessToken+abc/def=1234567890XYZ9';

/**
 * ST3-T21 ช่องส่ง LINE Messaging API + SMS (docs/04 G4, I) — เกณฑ์ตรวจรับ:
 * ส่งลิงก์เข้า LINE ทดสอบได้ และมี log; LINE ล่ม → ผู้ใช้ยังคัดลอกลิงก์ได้
 * ไม่เรียก LINE/SMS จริงเลย: ใช้ MockMessagingProvider และ LineMessagingProvider + fetch ปลอม
 */
describe('ส่งลิงก์ทาง LINE / SMS (messaging)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let dbs: DbService;
  let providers: MessagingProviders;
  let dispatcher: MessageDispatcher;
  let tenantId: string;
  let admin: string;
  let viewer: string;
  let dispatcherOnly: string;
  let otherAdmin: string;
  let carrierA: string;
  let carrierB: string;
  let line: MockMessagingProvider;
  let sms: MockMessagingProvider;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    dbs = app.get(DbService);
    providers = app.get(MessagingProviders);
    dispatcher = app.get(MessageDispatcher);
    tenantId = (await createTenant(db, 'ศรีสมมติขนส่ง')).id;
    admin = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, 'master:read', 'user-viewer');
    dispatcherOnly = await tokenFor(tenantId, 'trips:assign trips:read', 'user-dispatch');
    otherAdmin = await tokenFor((await createTenant(db)).id);
    const carrier = async (n: number, extra: object) =>
      (
        await api(app, admin)
          .post('/v1/carriers')
          .send({
            legalName: `หจก. รถร่วมสมมติ ${n}`,
            entityType: 'INDIVIDUAL',
            taxId: validTaxId(900 + n),
            ...extra,
          })
          .expect(201)
      ).body.id as string;
    carrierA = await carrier(1, { phone: '081-234-5678', lineContact: LINE_UID });
    carrierB = await carrier(2, { phone: '02-123-4567', lineContact: '@sapsomboon' });
  });
  beforeEach(async () => {
    resetPublicRateLimit();
    line = new MockMessagingProvider('LINE');
    sms = new MockMessagingProvider('SMS');
    providers.use('LINE', line);
    providers.use('SMS', sms);
    // แต่ละข้อเริ่มจาก log ว่าง (เพดานต่อผู้รับนับจาก log)
    await db.messageDelivery.deleteMany({});
    await db.messagingSetting.deleteMany({});
    await db.messageRecipientCounter.deleteMany({});
    // ปิดเป็นค่าเริ่มต้น — test ส่วนใหญ่เปิดทั้งสองช่อง (mock ไม่ต้องมี token)
    await db.messagingSetting.create({ data: { tenantId, lineEnabled: true, smsEnabled: true } });
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const issue = async (carrierId = carrierA) => {
    await db.magicLink.updateMany({
      where: { entityId: tryDecodeId('carrier', carrierId)!, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'test reset' },
    });
    return (
      await api(app, admin).post(`/v1/carriers/${carrierId}/upload-links`).send({}).expect(201)
    ).body as { id: string; token: string; url: string };
  };
  const send = (body: object, token = admin) =>
    api(app, token)
      .post('/v1/messages/send-link')
      .set('Idempotency-Key', `msg-${++seed}`)
      .send(body);
  /** ให้รอบลองใหม่ถึงเวลาทันที (แทนการรอ backoff จริง) */
  const due = () => db.messageDelivery.updateMany({ data: { runAt: new Date(Date.now() - 1000) } });
  const row = (id: string) =>
    db.messageDelivery.findUniqueOrThrow({ where: { id: tryDecodeId('messageDelivery', id)! } });

  it('ส่งลิงก์เข้า LINE (mock) → เข้าคิว → worker ส่ง → log สถานะ sent + ข้อความไทยมีลิงก์', async () => {
    const link = await issue();
    const r = await send({ channel: 'line', url: link.url }).expect(202);
    expect(r.body).toMatchObject({
      channel: 'line',
      template: 'carrier_docs_link',
      status: 'queued',
      recipient: 'U0a•••2c3d',
      carrierId: carrierA,
      linkId: link.id,
      entityType: 'carrier',
      entityId: carrierA,
    });
    // response ไม่มีเนื้อความ/ผู้รับตัวจริง/token
    expect(JSON.stringify(r.body)).not.toContain(LINE_UID);
    expect(JSON.stringify(r.body)).not.toContain(link.token);
    expect(line.sent).toHaveLength(0); // ยังไม่ส่งใน transaction ของคำขอ

    expect(await dispatcher.drain()).toBe(1);
    expect(line.sent).toHaveLength(1);
    expect(line.sent[0]!.to).toBe(LINE_UID);
    expect(line.sent[0]!.retryKey).toBe(tryDecodeId('messageDelivery', r.body.id));
    expect(line.sent[0]!.text).toContain('เรียน หจก. รถร่วมสมมติ 1');
    expect(line.sent[0]!.text).toContain('ศรีสมมติขนส่ง ขอให้ส่งเอกสารรถและใบขับขี่');
    expect(line.sent[0]!.text).toContain(link.url);
    expect(line.sent[0]!.text).toMatch(/ลิงก์ใช้ได้ถึง \d{1,2} \S+ 25\d\d \d\d:\d\d น\./);

    const got = await api(app, admin).get(`/v1/messages/${r.body.id}`).expect(200);
    expect(got.body).toMatchObject({
      status: 'sent',
      attempts: 1,
      provider: 'mock',
      providerMessageId: 'mock-line-1',
      errorCode: null,
      nextAttemptAt: null,
    });
    expect(got.body.sentAt).toBeTruthy();
    // ส่งแล้วลบเนื้อความ (มี token) + ผู้รับตัวจริง เหลือแบบปิดบัง
    const db1 = await row(r.body.id);
    expect(db1.vars).toBeNull();
    expect(db1.recipientEnc).toBeNull();
    expect(db1.recipientMasked).toBe('U0a•••2c3d');

    const list = await api(app, viewer).get(`/v1/messages?carrierId=${carrierA}`).expect(200);
    expect(list.body.data.map((m: { id: string }) => m.id)).toEqual([r.body.id]);
    // audit การเข้าคิว — ผู้รับปิดบัง
    const audits = (
      await db.auditLog.findMany({ where: { tenantId, action: 'message.queued' } })
    ).map((a) => a.after);
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(LINE_UID);
    expect(JSON.stringify(audits)).not.toContain(link.token);
  });

  it('SMS ใช้เบอร์มือถือของผู้รับเหมา (ปรับรูปแบบ) — ข้อความสั้น', async () => {
    const link = await issue();
    const r = await send({ channel: 'sms', url: link.url }).expect(202);
    expect(r.body.recipient).toBe('081•••5678');
    await dispatcher.drain();
    expect(sms.sent[0]!.to).toBe('0812345678');
    // SMS = ข้อความคงที่ + ลิงก์ ไม่มีชื่อที่ tenant กรอก (บัญชี SMS ของระบบ)
    expect(sms.sent[0]!.text.startsWith('TMS: ส่งเอกสารรถ/ใบขับขี่')).toBe(true);
    expect(sms.sent[0]!.text).not.toContain('ศรีสมมติ');
    expect(sms.sent[0]!.text).toContain(link.url);
    expect(sms.sent[0]!.text.length).toBeLessThan(link.url.length + 80);
    // ปิด SMS ระหว่างรอส่ง → worker ไม่ส่ง (FAILED not_configured)
    const r2 = await send({ channel: 'sms', url: link.url }).expect(202);
    await api(app, admin).patch('/v1/settings/messaging').send({ smsEnabled: false }).expect(200);
    await dispatcher.drain();
    expect(sms.sent).toHaveLength(1);
    expect(await row(r2.body.id)).toMatchObject({ status: 'FAILED', errorCode: 'not_configured' });
  });

  it('ล้มแบบลองใหม่ได้ → QUEUED + backoff แล้วสำเร็จรอบถัดไป', async () => {
    const link = await issue();
    line.failTimes = 2;
    const r = await send({ channel: 'line', url: link.url }).expect(202);
    const t0 = Date.now();
    await dispatcher.drain();
    let m = await row(r.body.id);
    expect(m).toMatchObject({ status: 'QUEUED', attempts: 1, errorCode: 'provider_unavailable' });
    expect(m.vars).not.toBeNull(); // ยังไม่จบ — เก็บไว้ส่งรอบหน้า (ตัวแปร ไม่ใช่ลิงก์)
    expect(JSON.stringify(m)).not.toContain(link.token);
    // รอบถัดไป ≈ 10 วินาที (นาฬิกาฐานข้อมูล)
    expect(m.runAt.getTime() - t0).toBeGreaterThan((RETRY_BASE_S - 3) * 1000);
    expect(await dispatcher.drain()).toBe(0); // ยังไม่ถึงเวลา
    const view = await api(app, admin).get(`/v1/messages/${r.body.id}`).expect(200);
    expect(view.body).toMatchObject({ status: 'queued', errorCode: 'provider_unavailable' });
    expect(view.body.nextAttemptAt).toBeTruthy();
    await due();
    await dispatcher.drain();
    m = await row(r.body.id);
    expect(m.attempts).toBe(2);
    expect(m.runAt.getTime() - Date.now()).toBeGreaterThan((2 * RETRY_BASE_S - 3) * 1000); // backoff ×2
    await due();
    await dispatcher.drain();
    m = await row(r.body.id);
    expect(m).toMatchObject({ status: 'SENT', attempts: 3, errorCode: null, vars: null });
    expect(line.sent).toHaveLength(1);
  });

  it('LINE ล่ม: ครบ 5 ครั้ง → FAILED มี log สาเหตุ และลิงก์ยังใช้ได้ (คัดลอกไปส่งเอง)', async () => {
    const link = await issue();
    line.down = true;
    const r = await send({ channel: 'line', url: link.url }).expect(202);
    for (let i = 0; i < 5; i++) {
      await due();
      await dispatcher.drain();
    }
    const m = await row(r.body.id);
    expect(m).toMatchObject({ status: 'FAILED', attempts: 5, errorCode: 'provider_unavailable' });
    expect(m.vars).toBeNull();
    expect(m.recipientEnc).toBeNull();
    expect(m.failedAt).toBeTruthy();
    const list = await api(app, admin)
      .get(`/v1/messages?linkId=${link.id}&status=failed`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      status: 'failed',
      errorCode: 'provider_unavailable',
    });
    // fallback: ลิงก์เดิมยัง active — เปิดจาก url ที่คัดลอกได้ตามปกติ
    await request(app.getHttpServer()).get(`/v1/public/carrier-docs/${link.token}`).expect(200);
    const links = await api(app, admin).get(`/v1/carriers/${carrierA}/upload-links`).expect(200);
    expect(links.body.data.find((l: { id: string }) => l.id === link.id).status).toBe('active');
  });

  it('ปิดช่องทาง (provider none) → channels บอกใช้ไม่ได้ + ส่ง 409 channel_unavailable แต่ออกลิงก์/คัดลอกได้', async () => {
    providers.use('LINE', null);
    const ch = await api(app, viewer).get('/v1/messages/channels').expect(200);
    expect(ch.body.data).toEqual([
      { channel: 'line', available: false, reason: 'provider_disabled' },
      { channel: 'sms', available: true, reason: null },
    ]);
    const link = await issue();
    const r = await send({ channel: 'line', url: link.url }).expect(409);
    expect(r.body.code).toBe('channel_unavailable');
    expect(r.body.errors[0].code).toBe('provider_disabled');
    expect(await db.messageDelivery.count()).toBe(0);
    await request(app.getHttpServer()).get(`/v1/public/carrier-docs/${link.token}`).expect(200);
    // SMS ปิดต่อบริษัท
    await api(app, admin).patch('/v1/settings/messaging').send({ smsEnabled: false }).expect(200);
    const r2 = await send({ channel: 'sms', url: link.url }).expect(409);
    expect(r2.body.errors[0].code).toBe('channel_disabled');
  });

  it('LINE จริง (fetch ปลอม): token ต่อบริษัทเข้ารหัส ไม่คืนใน API/audit, ส่งด้วย Bearer + X-Line-Retry-Key', async () => {
    await db.messagingSetting.deleteMany({});
    const calls: { url: string; init: RequestInit }[] = [];
    let reply: () => Response = () =>
      new Response(JSON.stringify({ sentMessages: [{ id: '5000000001', quoteToken: 'q' }] }), {
        status: 200,
        headers: { 'x-line-request-id': 'req-1' },
      });
    providers.use(
      'LINE',
      new LineMessagingProvider('https://line.test.invalid', async (url, init) => {
        calls.push({ url, init });
        return reply();
      }),
    );
    // ยังไม่ตั้ง token → ใช้ไม่ได้
    let ch = await api(app, viewer).get('/v1/messages/channels').expect(200);
    expect(ch.body.data[0]).toEqual({
      channel: 'line',
      available: false,
      reason: 'not_configured',
    });
    const link = await issue();
    expect((await send({ channel: 'line', url: link.url }).expect(409)).body.errors[0].code).toBe(
      'not_configured',
    );
    // เปิด LINE โดยไม่มี token → 422
    await api(app, admin).patch('/v1/settings/messaging').send({ lineEnabled: true }).expect(422);
    // viewer แก้ไม่ได้
    await api(app, viewer)
      .patch('/v1/settings/messaging')
      .send({ lineChannelAccessToken: LINE_TOKEN })
      .expect(403);
    const s = await api(app, admin)
      .patch('/v1/settings/messaging')
      .send({ lineChannelAccessToken: LINE_TOKEN })
      .expect(200);
    expect(s.body).toMatchObject({
      lineEnabled: true,
      lineConfigured: true,
      lineTokenHint: '•••• XYZ9',
      lineProvider: 'line',
      version: 1,
    });
    expect(JSON.stringify(s.body)).not.toContain(LINE_TOKEN);
    const g = await api(app, admin).get('/v1/settings/messaging').expect(200);
    expect(JSON.stringify(g.body)).not.toContain(LINE_TOKEN);
    const stored = await db.messagingSetting.findUniqueOrThrow({ where: { tenantId } });
    expect(stored.lineTokenEnc).toMatch(/^v1\./);
    expect(stored.lineTokenEnc).not.toContain(LINE_TOKEN);
    const audits = (
      await db.auditLog.findMany({ where: { tenantId, action: 'messaging_setting.updated' } })
    ).map((a) => [a.before, a.after]);
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(LINE_TOKEN);
    expect(JSON.stringify(audits)).not.toContain('XYZ9');

    ch = await api(app, viewer).get('/v1/messages/channels').expect(200);
    expect(ch.body.data[0].available).toBe(true);
    const r = await send({ channel: 'line', url: link.url }).expect(202);
    await dispatcher.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://line.test.invalid/v2/bot/message/push');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${LINE_TOKEN}`);
    expect(calls[0]!.init.redirect).toBe('error');
    expect(h['X-Line-Retry-Key']).toBe(tryDecodeId('messageDelivery', r.body.id));
    const payload = JSON.parse(String(calls[0]!.init.body));
    expect(payload.to).toBe(LINE_UID);
    expect(payload.messages[0].type).toBe('text');
    expect(payload.messages[0].text).toContain(link.url);
    expect((await api(app, admin).get(`/v1/messages/${r.body.id}`)).body).toMatchObject({
      status: 'sent',
      provider: 'line',
      providerMessageId: '5000000001',
    });

    // 409 + accepted request id (ส่งซ้ำหลัง timeout ด้วย retry key เดิม) = ถือว่าส่งแล้ว
    reply = () =>
      new Response('{"message":"The retry key is already accepted"}', {
        status: 409,
        headers: { 'x-line-accepted-request-id': 'req-accepted' },
      });
    const r2 = await send({ channel: 'line', url: link.url }).expect(202);
    await dispatcher.drain();
    expect((await row(r2.body.id)).providerMessageId).toBe('req-accepted');

    // 401 token ผิด → FAILED ทันที (ไม่ลองซ้ำ) — ข้อความ error ไม่มี token
    reply = () => new Response('{"message":"Authentication failed"}', { status: 401 });
    const r3 = await send({ channel: 'line', url: link.url }).expect(202);
    await dispatcher.drain();
    const f = await row(r3.body.id);
    expect(f).toMatchObject({ status: 'FAILED', attempts: 1, errorCode: 'provider_auth_failed' });
    expect(f.error).not.toContain(LINE_TOKEN);
    expect(f.error).toBe('LINE HTTP 401'); // ไม่เก็บ response ของ provider

    // 500 → ลองใหม่
    reply = () => new Response('oops', { status: 503 });
    const r4 = await send({ channel: 'line', url: link.url }).expect(202);
    await dispatcher.drain();
    expect(await row(r4.body.id)).toMatchObject({
      status: 'QUEUED',
      errorCode: 'provider_unavailable',
    });

    // ปิด LINE ระหว่างรอส่ง → FAILED not_configured
    await api(app, admin).patch('/v1/settings/messaging').send({ lineEnabled: false }).expect(200);
    await due();
    await dispatcher.drain();
    expect(await row(r4.body.id)).toMatchObject({ status: 'FAILED', errorCode: 'not_configured' });
    // ลบ token
    const cleared = await api(app, admin)
      .patch('/v1/settings/messaging')
      .send({ lineChannelAccessToken: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      lineConfigured: false,
      lineEnabled: false,
      lineTokenHint: null,
    });
  });

  it('role แอปอ่านเนื้อความ/ผู้รับตัวจริงของ log ไม่ได้ และแก้/ลบ log ไม่ได้', async () => {
    const link = await issue();
    await send({ channel: 'line', url: link.url }).expect(202);
    await expect(
      dbs.withTenant(tenantId, (tx) => tx.$queryRaw`SELECT vars FROM message_delivery`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      dbs.withTenant(tenantId, (tx) => tx.$queryRaw`SELECT recipient_enc FROM message_delivery`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      dbs.withTenant(tenantId, (tx) => tx.$executeRaw`UPDATE message_delivery SET status = 'SENT'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      dbs.withTenant(tenantId, (tx) => tx.$executeRaw`DELETE FROM message_delivery`),
    ).rejects.toThrow(/permission denied/);
    // ตัวนับข้ามบริษัท: role แอปใช้ได้ผ่านฟังก์ชันเท่านั้น
    await expect(
      dbs.withTenant(tenantId, (tx) => tx.$queryRaw`SELECT * FROM message_recipient_counter`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      dbs.withTenant(
        tenantId,
        (tx) => tx.$executeRaw`UPDATE message_recipient_counter SET count = 0`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('รับเฉพาะลิงก์ที่ยังใช้ได้ของบริษัทนี้ + ผู้รับต้องถูกต้อง', async () => {
    const link = await issue();
    const code = async (body: object, status = 422) =>
      (await send(body).expect(status)).body.errors?.[0]?.code as string;
    // URL อื่น / path ผิด / token ปลอม
    expect(await code({ channel: 'line', url: 'https://evil.example/link/carrier-docs/x' })).toBe(
      'link_invalid',
    );
    expect(await code({ channel: 'line', url: link.url.replace('carrier-docs', 'offer') })).toBe(
      'link_invalid',
    );
    expect(await code({ channel: 'line', url: `${link.url.slice(0, -3)}AAA` })).toBe(
      'link_invalid',
    );
    // ระบุผู้รับเอง/ผู้รับเหมาอื่นไม่ได้ (ช่อง to / carrierId ถูกตัดออก — review M1)
    expect(await code({ channel: 'sms', url: link.url, to: '0899999999' })).toBeTruthy();
    expect(await code({ channel: 'sms', url: link.url, carrierId: carrierB })).toBeTruthy();
    expect(await db.messageDelivery.count()).toBe(0);
    // ผู้รับเหมา B: LINE ID แบบ @ ใช้ push ไม่ได้ · เบอร์บ้านส่ง SMS ไม่ได้
    const linkB = await issue(carrierB);
    expect(await code({ channel: 'line', url: linkB.url })).toBe('recipient_missing');
    expect(await code({ channel: 'sms', url: linkB.url })).toBe('recipient_missing');
    // ข้อเสนองาน (trip_offer) ยังส่งไม่ได้จนกว่า ST3-T23 ตรวจว่าเที่ยวเสนอให้ผู้รับเหมารายนั้น
    const offer = await db.magicLink.create({
      data: {
        tenantId,
        purpose: 'trip_offer',
        entityType: 'trip',
        entityId: tryDecodeId('carrier', carrierA)!,
        actions: ['offer.respond'],
        scopes: [],
        expiresAt: new Date(Math.floor(Date.now() / 1000 + 86400) * 1000),
      },
    });
    const { encodeLinkToken } = await import('../src/modules/links/magic-link.service');
    const offerUrl = `${new URL(link.url).origin}/link/offer/${encodeLinkToken(offer.id, Math.floor(offer.expiresAt.getTime() / 1000))}`;
    expect(await code({ channel: 'line', url: offerUrl })).toBe('link_kind_not_supported');
    // ลิงก์ที่เพิกถอนแล้ว
    await api(app, admin)
      .post(`/v1/carrier-upload-links/${link.id}/revoke`)
      .send({ reason: 'ส่งผิดคน ยกเลิกลิงก์นี้' })
      .expect(200);
    expect(await code({ channel: 'line', url: link.url })).toBe('link_invalid');
  });

  it('ลิงก์ถูกเพิกถอนระหว่างรอส่ง → ไม่ส่ง (FAILED link_inactive)', async () => {
    const link = await issue();
    const r = await send({ channel: 'line', url: link.url }).expect(202);
    await api(app, admin)
      .post(`/v1/carrier-upload-links/${link.id}/revoke`)
      .send({ reason: 'ยกเลิกก่อนส่งข้อความออกไป' })
      .expect(200);
    await dispatcher.drain();
    expect(line.sent).toHaveLength(0);
    expect(await row(r.body.id)).toMatchObject({ status: 'FAILED', errorCode: 'link_inactive' });
  });

  it('สิทธิ์: ส่งลิงก์เอกสารรถร่วมต้อง master:write · ดู log ตามสิทธิ์ดูของชนิดลิงก์', async () => {
    const link = await issue();
    await send({ channel: 'line', url: link.url }, viewer).expect(403);
    const denied = await send({ channel: 'line', url: link.url }, dispatcherOnly).expect(403);
    expect(denied.body.code).toBe('permission_denied');
    const r = await send({ channel: 'line', url: link.url }).expect(202);
    expect((await api(app, viewer).get('/v1/messages').expect(200)).body.data).toHaveLength(1);
    // trips:read อย่างเดียว ไม่เห็น log ของลิงก์เอกสารรถร่วม
    expect((await api(app, dispatcherOnly).get('/v1/messages').expect(200)).body.data).toHaveLength(
      0,
    );
    await api(app, dispatcherOnly).get(`/v1/messages/${r.body.id}`).expect(404);
    const none = await tokenFor(tenantId, 'orders:read', 'user-none');
    await api(app, none).get('/v1/messages').expect(403);
    await api(app, none).get('/v1/settings/messaging').expect(403);
  });

  it('แยก tenant: บริษัทอื่นไม่เห็น log และส่งลิงก์ของบริษัทนี้ไม่ได้', async () => {
    const link = await issue();
    const r = await send({ channel: 'line', url: link.url }).expect(202);
    await api(app, otherAdmin).get(`/v1/messages/${r.body.id}`).expect(404);
    expect((await api(app, otherAdmin).get('/v1/messages').expect(200)).body.data).toHaveLength(0);
    const x = await send({ channel: 'line', url: link.url }, otherAdmin).expect(422);
    expect(x.body.errors[0].code).toBe('link_invalid');
  });

  it(`rate limit: ต่อผู้รับ ${RECIPIENT_PER_HOUR} ครั้ง/ชม. และต่อบริษัท ${TENANT_PER_HOUR} ครั้ง/ชม. → 429`, async () => {
    const link = await issue();
    for (let i = 0; i < RECIPIENT_PER_HOUR; i++)
      await send({ channel: 'line', url: link.url }).expect(202);
    const r = await send({ channel: 'line', url: link.url }).expect(429);
    expect(r.body.errors[0].code).toBe('recipient_hourly_limit');
    // ผู้รับคนอื่นยังส่งได้ (SMS = ผู้รับคนละค่า)
    await send({ channel: 'sms', url: link.url }).expect(202);
    // เต็มเพดานของบริษัท
    await db.messageDelivery.createMany({
      data: Array.from({ length: TENANT_PER_HOUR }, (_, i) => ({
        tenantId,
        channel: 'SMS',
        template: 'carrier_docs_link',
        recipientMasked: '•••',
        recipientHash: `x${i}`,
        status: 'SENT',
      })),
    });
    const t = await send({ channel: 'sms', url: link.url }).expect(429);
    expect(t.body.errors[0].code).toBe('tenant_hourly_limit');
  });

  it(`เพดานต่อผู้รับข้ามทุกบริษัท ${RECIPIENT_PLATFORM_PER_HOUR} ครั้ง/ชม. → 429`, async () => {
    const link = await issue();
    // บริษัทอื่นส่งถึงเบอร์เดียวกันไปแล้วเต็มเพดาน (ตัวนับใช้ hash เดียวกันทั้งระบบ)
    const hash = new BlindIndex().of('SMS:0812345678');
    await db.$executeRaw`INSERT INTO message_recipient_counter (recipient_hash, hour, count)
      VALUES (${hash}, date_trunc('hour', now()), ${RECIPIENT_PLATFORM_PER_HOUR})`;
    const r = await send({ channel: 'sms', url: link.url }).expect(429);
    expect(r.body.errors[0].code).toBe('recipient_platform_limit');
    expect(await db.messageDelivery.count()).toBe(0);
    // ช่อง LINE = ผู้รับคนละค่า ยังส่งได้ และนับเพิ่ม
    await send({ channel: 'line', url: link.url }).expect(202);
    const c = await db.messageRecipientCounter.findMany({});
    expect(c.find((x) => x.recipientHash === hash)!.count).toBe(RECIPIENT_PLATFORM_PER_HOUR);
    expect(c.find((x) => x.recipientHash !== hash)!.count).toBe(1);
  });

  it('ค่าเริ่มต้นปิดทั้ง LINE และ SMS — admin ต้องเปิดเอง', async () => {
    await db.messagingSetting.deleteMany({});
    const ch = await api(app, viewer).get('/v1/messages/channels').expect(200);
    expect(ch.body.data).toEqual([
      { channel: 'line', available: false, reason: 'channel_disabled' },
      { channel: 'sms', available: false, reason: 'channel_disabled' },
    ]);
    const s = await api(app, admin).get('/v1/settings/messaging').expect(200);
    expect(s.body).toMatchObject({ lineEnabled: false, smsEnabled: false });
    const link = await issue();
    expect((await send({ channel: 'sms', url: link.url }).expect(409)).body.code).toBe(
      'channel_unavailable',
    );
    await api(app, admin).patch('/v1/settings/messaging').send({ smsEnabled: true }).expect(200);
    await send({ channel: 'sms', url: link.url }).expect(202);
  });

  it('Idempotency-Key ซ้ำ = ไม่เข้าคิวซ้ำ', async () => {
    const link = await issue();
    const a = await api(app, admin)
      .post('/v1/messages/send-link')
      .set('Idempotency-Key', 'same-send-1')
      .send({ channel: 'line', url: link.url })
      .expect(202);
    const b = await api(app, admin)
      .post('/v1/messages/send-link')
      .set('Idempotency-Key', 'same-send-1')
      .send({ channel: 'line', url: link.url })
      .expect(202);
    expect(b.body.id).toBe(a.body.id);
    expect(await db.messageDelivery.count()).toBe(1);
  });
});
