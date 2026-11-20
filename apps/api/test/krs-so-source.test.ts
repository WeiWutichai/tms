import { type MockKrs, startMockKrs } from '@tms/mock-krs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type KrsSalesOrder,
  loadKrsSoMapping,
  readKrsSalesOrders,
} from '../src/erp-adapters/krs/krs-so-source';

/**
 * ST8-T02 เกณฑ์ตรวจรับ: "poller ชี้มาที่ mock แล้วอ่าน SO ตัวอย่างได้ รวมแถวที่ถูกยกเลิก/แก้ไข"
 * client อ่านแบบ watermark (ขั้นต่ำ) กับ mock แหล่ง SO (ST8-T02, พอร์ตสุ่มในโปรเซสเดียวกัน) — ไม่แตะฐานข้อมูล
 */

const KEY = 'krs-so-test-key-3b9e';
let mock: MockKrs;
const cfg = () => ({ baseUrl: mock.apiBaseUrl, apiKey: KEY });
const opts = { allowPrivate: true };

/** อ่านจนหมด (หลายหน้า) คืนใบทั้งหมด + watermark สุดท้าย — แบบที่ poller ST8-T04 จะทำทุก 5 นาที */
async function drain(since: string | null, limit = 2) {
  const all: KrsSalesOrder[] = [];
  let wm = since;
  for (let i = 0; i < 20; i++) {
    const r = await readKrsSalesOrders(cfg(), wm, limit, opts);
    if (!r.ok) throw new Error(`${r.errorClass} ${r.problem.code}`);
    all.push(...r.orders);
    wm = r.next;
    if (!r.hasMore) break;
  }
  return { orders: all, watermark: wm };
}

beforeAll(async () => {
  mock = await startMockKrs({ apiKey: KEY, now: () => new Date('2026-11-20T03:00:00.000Z') });
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(() => {
  mock.reset();
});

describe('readKrsSalesOrders (ST8-T02) กับ mock แหล่ง SO', () => {
  it('mapping ที่เดียวกับ mock: view vw_TMS_SalesOrder (ชื่อเสนอ — [OPEN — KRS])', () => {
    const m = loadKrsSoMapping();
    expect(m.view).toBe('vw_TMS_SalesOrder');
    expect(m.httpPath).toBe('/salesorder');
    expect(m.watermark).toBe('rowVersion');
    expect(mock.salesOrders.mapping).toEqual(m);
  });

  it('อ่านจากต้นได้ครบทุกใบ (หลายหน้า) รวมใบที่ยกเลิกและใบที่แก้ไข รวมรายการเป็นใบ', async () => {
    const { orders, watermark } = await drain(null);
    expect(orders.map((o) => o.soNo)).toEqual([
      'SAMPLE-SO-6911-0001',
      'SAMPLE-SO-6911-0002',
      'SAMPLE-SO-6911-0003',
      'SAMPLE-SO-6911-0004',
      'SAMPLE-SO-6911-0005',
    ]);
    const so2 = orders[1]!;
    expect(so2.company).toBe('SAMPLE');
    expect(so2.lines.map((l) => [l.lineNo, l.qty, l.unit])).toEqual([
      [1, '12.500', 'ตัน'],
      [2, '8', 'พาเลท'],
    ]);
    expect(so2.raw).toHaveLength(2);
    expect(so2.updatedAt).toBe('2026-11-02T09:40:00.000+07:00');
    const cancelled = orders.find((o) => o.soNo === 'SAMPLE-SO-6911-0005')!;
    expect(cancelled.cancelled).toBe(true);
    const edited = orders.find((o) => o.soNo === 'SAMPLE-SO-6911-0004')!;
    expect(edited.cancelled).toBe(false);
    expect(String(edited.updatedAt).slice(0, 10) > String(edited.soDate)).toBe(true);
    expect(watermark).toBe(cancelled.rowVersion);
  });

  it('รอบถัดไปจาก watermark ได้เฉพาะใบที่ถูกแก้/ยกเลิก/เพิ่มหลังรอบก่อน — อ่านซ้ำไม่ได้ใบซ้ำ', async () => {
    const first = await drain(null);
    expect((await drain(first.watermark)).orders).toEqual([]);

    mock.salesOrders.edit('SAMPLE', 'SAMPLE-SO-6911-0003', {
      deliveryDate: '2026-11-10',
      remark: 'เลื่อนวันส่ง (ตัวอย่าง)',
    });
    mock.salesOrders.cancel('SAMPLE', 'SAMPLE-SO-6911-0001');

    const second = await drain(first.watermark);
    expect(second.orders.map((o) => [o.soNo, o.cancelled])).toEqual([
      ['SAMPLE-SO-6911-0003', false],
      ['SAMPLE-SO-6911-0001', true],
    ]);
    const e = second.orders[0]!;
    expect(e.deliveryDate).toBe('2026-11-10');
    expect(e.updatedAt).toBe('2026-11-20T10:00:00.000+07:00');
    expect(BigInt(e.rowVersion) > BigInt(first.watermark!)).toBe(true);
    expect((await drain(second.watermark)).orders).toEqual([]);
  });

  it('key ผิด = AUTH · mock 503 = TRANSIENT · ปิด mock = TRANSIENT · since ผิดรูป = VALIDATION', async () => {
    const auth = await readKrsSalesOrders({ ...cfg(), apiKey: 'wrong' }, null, 10, opts);
    expect(auth).toMatchObject({
      ok: false,
      errorClass: 'AUTH',
      problem: { code: 'unauthorized' },
    });
    mock.injectFault({ status: 503, method: 'GET' });
    expect(await readKrsSalesOrders(cfg(), null, 10, opts)).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
    });
    expect(await readKrsSalesOrders(cfg(), 'abc', 10, opts)).toMatchObject({
      ok: false,
      errorClass: 'VALIDATION',
      problem: { code: 'invalid_watermark' },
    });
    const dead = await startMockKrs({ apiKey: KEY });
    const url = dead.apiBaseUrl;
    await dead.stop();
    expect(await readKrsSalesOrders({ baseUrl: url, apiKey: KEY }, null, 10, opts)).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
      problem: { code: 'unreachable' },
    });
  });

  it('view/คอลัมน์หาย → source_not_found / source_columns_missing (ST8-T04 ใช้ตั้ง SOURCE_ERROR)', async () => {
    const m = loadKrsSoMapping();
    const renamed = { ...m, httpPath: '/salesorder_v2' };
    expect(await readKrsSalesOrders(cfg(), null, 10, { ...opts, mapping: renamed })).toMatchObject({
      ok: false,
      errorClass: 'VALIDATION',
      problem: { code: 'source_not_found' },
    });

    // ต้นทางส่งแถวที่ไม่มีคอลัมน์ is_cancelled (เช่น KRS เปลี่ยน view โดยไม่แจ้ง)
    const rows = mock.salesOrders.toRows(mock.salesOrders.list()[0]!);
    for (const r of rows) delete r[m.columns.cancelled.column];
    const srv: Server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ rows, next: '1001', hasMore: false }));
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      const port = (srv.address() as AddressInfo).port;
      const r = await readKrsSalesOrders(
        { baseUrl: `http://127.0.0.1:${port}/api`, apiKey: KEY },
        null,
        10,
        opts,
      );
      expect(r).toMatchObject({
        ok: false,
        errorClass: 'VALIDATION',
        problem: { code: 'source_columns_missing' },
        missingColumns: ['is_cancelled'],
      });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((ok) => srv.close(() => ok()));
    }
  });

  it('แถวที่ไม่ใช่ object / ไม่มี soNo → rejectedRows · 408 = TRANSIENT · timezone ไม่รู้จัก = VALIDATION', async () => {
    const m = loadKrsSoMapping();
    const good = mock.salesOrders.toRows(mock.salesOrders.list()[0]!);
    const noSo = { ...good[0]!, [m.columns.soNo.column]: '' };
    let status = 200;
    const srv: Server = createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ rows: [...good, 'oops', null, noSo], next: null, hasMore: false }));
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api`;
      const r = await readKrsSalesOrders({ baseUrl: base, apiKey: KEY }, null, 10, opts);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.orders.map((o) => o.soNo)).toEqual(['SAMPLE-SO-6911-0001']);
      expect(r.rejectedRows).toEqual(['oops', null, noSo]);
      expect(r.next).toBe(r.orders[0]!.rowVersion);
      status = 408;
      expect(
        await readKrsSalesOrders({ baseUrl: base, apiKey: KEY }, null, 10, opts),
      ).toMatchObject({
        ok: false,
        errorClass: 'TRANSIENT',
        problem: { code: 'http_408' },
      });
      expect(
        await readKrsSalesOrders({ baseUrl: base, apiKey: KEY }, null, 10, {
          ...opts,
          mapping: { ...m, timezone: 'Mars/Olympus' },
        }),
      ).toMatchObject({
        ok: false,
        errorClass: 'VALIDATION',
        problem: { code: 'unsupported_timezone' },
      });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((ok) => srv.close(() => ok()));
    }
  });

  it('ปลายทาง private เมื่อไม่อนุญาต = ssrf_blocked · ไม่ตอบ = TRANSIENT timeout', async () => {
    expect(await readKrsSalesOrders(cfg(), null, 10, { allowPrivate: false })).toMatchObject({
      ok: false,
      errorClass: 'VALIDATION',
      problem: { code: 'ssrf_blocked' },
    });
    mock.injectFault({ kind: 'timeout', method: 'GET' });
    expect(await readKrsSalesOrders(cfg(), null, 10, { ...opts, timeoutMs: 300 })).toMatchObject({
      ok: false,
      errorClass: 'TRANSIENT',
      problem: { code: 'timeout' },
    });
  });
});
