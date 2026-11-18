import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  constructWebhookEvent,
  createTmsClient,
  etagOf,
  IDEMPOTENT_POSTS,
  ifMatch,
  paginate,
  parseRetryAfter,
  TmsApiError,
  unwrap,
  verifyWebhookSignature,
  WebhookSignatureError,
} from './index';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

function recorder(responses: Array<Response | Error>) {
  const calls: { method: string; url: string; headers: Headers; body: string }[] = [];
  const fetch = async (req: Request) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: await req.text() });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetch };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

describe('@tms/sdk', () => {
  it('API_VERSION ตรงกับ info.x-api-version-latest ของ openapi.json', () => {
    const doc = JSON.parse(
      readFileSync(resolve(__dirname, '../../contracts/openapi.json'), 'utf8'),
    ) as { info: { 'x-api-version-latest': string } };
    expect(API_VERSION).toBe(doc.info['x-api-version-latest']);
  });

  it('ส่ง Bearer key + X-Api-Version · POST ที่ประกาศรับได้ Idempotency-Key อัตโนมัติ (ไม่ทับของผู้เรียก) · POST ที่ไม่รับ ไม่ใส่', async () => {
    const r = recorder([json(201, { id: 'cus_1' }), json(201, { id: 'cus_2' }), json(200, {})]);
    const tms = createTmsClient({ apiKey: 'tk_test_abc', baseUrl: 'http://x/', fetch: r.fetch });
    await tms.POST('/v1/customers', { body: { legalName: 'ก' } });
    await tms.POST('/v1/customers', {
      body: { legalName: 'ข' },
      params: { header: { 'Idempotency-Key': 'mine-1' } },
    });
    expect(r.calls[0]!.url).toBe('http://x/v1/customers');
    expect(r.calls[0]!.headers.get('authorization')).toBe('Bearer tk_test_abc');
    expect(r.calls[0]!.headers.get('x-api-version')).toBe(API_VERSION);
    expect(r.calls[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.calls[1]!.headers.get('idempotency-key')).toBe('mine-1');
    expect(JSON.parse(r.calls[1]!.body)).toEqual({ legalName: 'ข' });
    expect(IDEMPOTENT_POSTS.has('/v1/customers')).toBe(true);
    expect(IDEMPOTENT_POSTS.has('/v1/carriers/{id}/reveal')).toBe(false);
    await tms.POST('/v1/carriers/{id}/reveal', {
      params: { path: { id: 'car_1' } },
      body: {} as never,
    });
    expect(r.calls[2]!.headers.has('idempotency-key')).toBe(false);
  });

  it('429 → รอตาม Retry-After แล้วส่งใหม่ (body + Idempotency-Key เดิม)', async () => {
    sleeps.length = 0;
    const r = recorder([
      json(429, { code: 'rate_limited', status: 429 }, { 'Retry-After': '2' }),
      json(201, { id: 'cus_1' }),
    ]);
    const tms = createTmsClient({ apiKey: 'k', fetch: r.fetch, retry: { sleep } });
    const res = await tms.POST('/v1/customers', { body: { legalName: 'ก' } });
    expect(res.response.status).toBe(201);
    expect(sleeps).toEqual([2000]);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.body).toBe(r.calls[0]!.body);
    expect(r.calls[1]!.headers.get('idempotency-key')).toBe(
      r.calls[0]!.headers.get('idempotency-key'),
    );
  });

  it('503 ลองใหม่เมื่อส่งซ้ำได้ปลอดภัย · POST ไม่มี Idempotency-Key ไม่ลองใหม่ · Retry-After เกินเพดาน = คืนเลย', async () => {
    sleeps.length = 0;
    const a = recorder([json(503, { code: 'unavailable', status: 503 }), json(200, { data: [] })]);
    const get = createTmsClient({ fetch: a.fetch, retry: { sleep, baseDelayMs: 100 } });
    expect((await get.GET('/v1/customers')).response.status).toBe(200);
    expect(sleeps).toEqual([100]);

    const b = recorder([json(503, { code: 'unavailable', status: 503 })]);
    const post = createTmsClient({ fetch: b.fetch, autoIdempotencyKey: false, retry: { sleep } });
    expect((await post.POST('/v1/customers', { body: { legalName: 'ก' } })).response.status).toBe(
      503,
    );
    expect(b.calls).toHaveLength(1);

    const c = recorder([
      json(429, { code: 'rate_limited', status: 429 }, { 'Retry-After': '120' }),
    ]);
    const capped = createTmsClient({ fetch: c.fetch, retry: { sleep, maxDelayMs: 1000 } });
    expect((await capped.GET('/v1/customers')).response.status).toBe(429);
    expect(c.calls).toHaveLength(1);

    const d = recorder([new TypeError('fetch failed'), json(200, { data: [] })]);
    const net = createTmsClient({ fetch: d.fetch, retry: { sleep } });
    expect((await net.GET('/v1/customers')).response.status).toBe(200);

    const e = recorder(Array.from({ length: 5 }, () => json(429, { code: 'rate_limited' })));
    const max = createTmsClient({ fetch: e.fetch, retry: { sleep, maxRetries: 2 } });
    expect((await max.GET('/v1/customers')).response.status).toBe(429);
    expect(e.calls).toHaveLength(3);
  });

  it('parseRetryAfter: วินาที / HTTP-date / ค่าเสีย', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('ifMatch / etagOf · unwrap โยน TmsApiError พร้อม code + requestId', async () => {
    expect(ifMatch(3)).toEqual({ 'If-Match': '"3"' });
    expect(ifMatch('"3"')).toEqual({ 'If-Match': '"3"' });
    expect(ifMatch('*')).toEqual({ 'If-Match': '*' });
    const r = recorder([
      json(200, { id: 'ord_1', version: 3 }, { ETag: '"3"' }),
      json(412, {
        type: 'https://docs.tms.example/problems/precondition_failed',
        title: 'x',
        status: 412,
        code: 'precondition_failed',
        requestId: 'req-1',
      }),
    ]);
    const tms = createTmsClient({ fetch: r.fetch });
    const got = await tms.GET('/v1/orders/{id}', { params: { path: { id: 'ord_1' } } });
    expect(etagOf(got.response)).toBe('"3"');
    const res = await tms.PATCH('/v1/orders/{id}', {
      params: { path: { id: 'ord_1' }, header: ifMatch(etagOf(got.response)!) },
      body: { customerRef: 'PO-9' },
    });
    expect(r.calls[1]!.headers.get('if-match')).toBe('"3"');
    let err: unknown;
    try {
      unwrap(res);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TmsApiError);
    expect(err).toMatchObject({ status: 412, code: 'precondition_failed', requestId: 'req-1' });
  });

  it('paginate เดินตาม nextCursor จนหมด', async () => {
    const r = recorder([
      json(200, { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1', hasMore: true }),
      json(200, { data: [{ id: 'c' }], nextCursor: null, hasMore: false }),
    ]);
    const tms = createTmsClient({ fetch: r.fetch });
    const ids: string[] = [];
    for await (const c of paginate((cursor) =>
      tms.GET('/v1/customers', { params: { query: { limit: 2, ...(cursor ? { cursor } : {}) } } }),
    ))
      ids.push(c.id);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(new URL(r.calls[1]!.url).searchParams.get('cursor')).toBe('c1');
  });

  it('verifyWebhookSignature: ตรงกับวิธีเซ็นของเซิร์ฟเวอร์ · หลาย v1 · เวลาเกิน · ลายเซ็นผิด · header เสีย', async () => {
    const body = '{"id":"evt_1","type":"order.created","data":{"object":{"id":"ord_1"}}}';
    const t = 1_763_500_000;
    const sign = (s: string) => createHmac('sha256', s).update(`${t}.${body}`).digest('hex');
    const header = `t=${t},v1=${sign('whsec_new')},v1=${sign('whsec_old')}`;
    expect(
      await verifyWebhookSignature({ rawBody: body, header, secret: 'whsec_old', nowSec: t + 10 }),
    ).toEqual({
      ok: true,
      timestamp: t,
    });
    expect(
      await verifyWebhookSignature({
        rawBody: new TextEncoder().encode(body),
        header,
        secret: ['whsec_x', 'whsec_new'],
        nowSec: t,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await verifyWebhookSignature({ rawBody: body, header, secret: 'whsec_new', nowSec: t + 301 }),
    ).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    expect(
      await verifyWebhookSignature({ rawBody: body + ' ', header, secret: 'whsec_new', nowSec: t }),
    ).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    });
    expect(
      await verifyWebhookSignature({ rawBody: body, header: 'v1=zz', secret: 'whsec_new' }),
    ).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const ev = await constructWebhookEvent<{ id: string }>({
      rawBody: body,
      header,
      secret: 'whsec_new',
      nowSec: t,
    });
    expect(ev.data.object.id).toBe('ord_1');
    await expect(
      constructWebhookEvent({ rawBody: body, header, secret: 'whsec_bad', nowSec: t }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});
