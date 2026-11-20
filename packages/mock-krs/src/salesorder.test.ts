import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { optionsFromEnv } from './env';
import { DEFAULT_SCHEMA_DIR, MockKrs, startMockKrs } from './mock-krs';
import { loadSalesOrderMapping, SO_FIELDS, sampleSalesOrders } from './salesorder';

/**
 * ST8-T02 แหล่ง SO จำลอง (`GET /salesorder?since=`) — อ่านด้วย watermark ได้ครบ รวมแถวที่ถูกยกเลิก/แก้ไข
 * ทุก test เรียกผ่าน HTTP จริง (port สุ่มบน 127.0.0.1)
 */

const KEY = 'so-test-key';
let mock: MockKrs;
const mapping = loadSalesOrderMapping(DEFAULT_SCHEMA_DIR);
const col = (f: (typeof SO_FIELDS)[number]) => mapping.columns[f].column;

async function get(query = '', key = KEY) {
  const res = await fetch(`${mock.apiBaseUrl}/salesorder${query}`, {
    headers: { 'X-API-Key': key },
  });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

async function control(method: string, path: string, body?: unknown) {
  const res = await fetch(`${mock.url}/__mock${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const soNos = (rows: Array<Record<string, unknown>>) => [
  ...new Set(rows.map((r) => r[col('soNo')] as string)),
];

beforeAll(async () => {
  mock = await startMockKrs({
    apiKey: KEY,
    now: () => new Date('2026-11-20T03:00:00.000Z'),
  });
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(() => {
  mock.reset();
});

describe('mapping (packages/contracts/krs/salesorder-source.json)', () => {
  it('ชื่อ view/คอลัมน์มาจากไฟล์ mapping ที่เดียว และครบทุกช่อง', () => {
    const raw = JSON.parse(
      readFileSync(join(DEFAULT_SCHEMA_DIR, 'salesorder-source.json'), 'utf8'),
    ) as { view: string; columns: Record<string, unknown> };
    expect(raw.view).toBe('vw_TMS_SalesOrder');
    expect(Object.keys(raw.columns).sort()).toEqual([...SO_FIELDS].sort());
  });
});

describe('ข้อมูลตัวอย่าง', () => {
  it('เป็นข้อมูลปลอมชัดเจน (SAMPLE-/บริษัทตัวอย่าง) และมีใบยกเลิก + ใบแก้ไข', () => {
    const all = sampleSalesOrders();
    for (const so of all) {
      expect(so.company).toBe('SAMPLE');
      expect(so.soNo).toMatch(/^SAMPLE-/);
      expect(so.customerCode).toMatch(/^SAMPLE-/);
      expect(so.customerName).toContain('ตัวอย่าง');
      for (const l of so.lines) expect(l.itemCode).toMatch(/^SAMPLE-/);
    }
    expect(all.some((s) => s.cancelled)).toBe(true);
    // แก้ไขหลังสร้าง: updated_at ไม่ใช่วันเดียวกับวันที่ SO
    expect(all.some((s) => !s.cancelled && s.updatedAt.slice(0, 10) > s.soDate)).toBe(true);
  });
});

describe('GET /salesorder?since=', () => {
  it('ไม่มี key / key ผิด = 401', async () => {
    expect((await get('', 'wrong')).status).toBe(401);
    const res = await fetch(`${mock.apiBaseUrl}/salesorder`);
    expect(res.status).toBe(401);
  });

  it('อ่านจากต้นได้ทุกแถว (1 แถว = 1 รายการ) รวมแถวที่ถูกยกเลิก ชื่อคอลัมน์ตาม mapping', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.view).toBe('vw_TMS_SalesOrder');
    expect(r.body.hasMore).toBe(false);
    expect(soNos(r.body.rows)).toEqual([
      'SAMPLE-SO-6911-0001',
      'SAMPLE-SO-6911-0002',
      'SAMPLE-SO-6911-0003',
      'SAMPLE-SO-6911-0004',
      'SAMPLE-SO-6911-0005',
    ]);
    // ใบ 0002 มี 2 รายการ → 2 แถว หัวเอกสารซ้ำ watermark เท่ากัน
    expect(r.body.rows).toHaveLength(6);
    for (const row of r.body.rows)
      expect(Object.keys(row).sort()).toEqual(SO_FIELDS.map(col).sort());
    const two = r.body.rows.filter((x: any) => x[col('soNo')] === 'SAMPLE-SO-6911-0002');
    expect(two.map((x: any) => x[col('lineNo')])).toEqual([1, 2]);
    expect(two[0][col('rowVersion')]).toBe(two[1][col('rowVersion')]);
    expect(two[0][col('qty')]).toBe('12.500');
    const cancelled = r.body.rows.find((x: any) => x[col('soNo')] === 'SAMPLE-SO-6911-0005');
    expect(cancelled[col('cancelled')]).toBe(1);
    expect(r.body.next).toBe(r.body.rows[r.body.rows.length - 1][col('rowVersion')]);
  });

  it('since = watermark (ไม่รวมตัวมันเอง) · limit นับเป็นใบ ไม่ตัดกลางใบ', async () => {
    const p1 = await get('?limit=2');
    expect(soNos(p1.body.rows)).toEqual(['SAMPLE-SO-6911-0001', 'SAMPLE-SO-6911-0002']);
    expect(p1.body.rows).toHaveLength(3);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await get(`?since=${p1.body.next}&limit=2`);
    expect(soNos(p2.body.rows)).toEqual(['SAMPLE-SO-6911-0003', 'SAMPLE-SO-6911-0004']);
    const p3 = await get(`?since=${p2.body.next}&limit=2`);
    expect(soNos(p3.body.rows)).toEqual(['SAMPLE-SO-6911-0005']);
    expect(p3.body.hasMore).toBe(false);
    const p4 = await get(`?since=${p3.body.next}`);
    expect(p4.body.rows).toEqual([]);
    expect(p4.body.next).toBe(p3.body.next);
    expect(p4.body.hasMore).toBe(false);
  });

  it('แก้/ยกเลิก/เพิ่ม SO หลัง watermark → รอบถัดไปได้เฉพาะใบที่เปลี่ยน พร้อมค่าใหม่', async () => {
    const first = await get();
    const wm = first.body.next as string;

    const edited = await control('PATCH', '/salesorders/SAMPLE/SAMPLE-SO-6911-0001', {
      deliveryDate: '2026-11-09',
      lines: [
        {
          lineNo: 1,
          itemCode: 'SAMPLE-ITEM-01',
          itemName: 'ค่าขนส่ง (ตัวอย่าง)',
          qty: '2',
          unit: 'เที่ยว',
        },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.updatedAt).toBe('2026-11-20T10:00:00.000'); // เวลาไทย (UTC+7)
    expect((await control('POST', '/salesorders/SAMPLE/SAMPLE-SO-6911-0002/cancel')).status).toBe(
      200,
    );
    const added = await control('POST', '/salesorders', {
      company: 'SAMPLE',
      soNo: 'SAMPLE-SO-6911-0006',
      soDate: '2026-11-20',
      customerCode: 'SAMPLE-C001',
      customerName: 'บริษัทตัวอย่าง ก จำกัด',
      customerPo: null,
      deliveryDate: '2026-11-21',
      vehicleType: null,
      originCode: null,
      originName: 'คลังตัวอย่าง บางนา',
      destinationCode: null,
      destinationName: 'ร้านตัวอย่าง สาขา 3',
      remark: null,
      lines: [
        {
          lineNo: 1,
          itemCode: 'SAMPLE-ITEM-01',
          itemName: 'ค่าขนส่ง (ตัวอย่าง)',
          qty: '1',
          unit: 'เที่ยว',
        },
      ],
    });
    expect(added.status).toBe(200);

    const next = await get(`?since=${wm}`);
    expect(soNos(next.body.rows)).toEqual([
      'SAMPLE-SO-6911-0001',
      'SAMPLE-SO-6911-0002',
      'SAMPLE-SO-6911-0006',
    ]);
    const e = next.body.rows.find((x: any) => x[col('soNo')] === 'SAMPLE-SO-6911-0001');
    expect(e[col('deliveryDate')]).toBe('2026-11-09');
    expect(e[col('qty')]).toBe('2');
    expect(e[col('cancelled')]).toBe(0);
    expect(Number(e[col('rowVersion')])).toBeGreaterThan(Number(wm));
    const c = next.body.rows.filter((x: any) => x[col('soNo')] === 'SAMPLE-SO-6911-0002');
    expect(c).toHaveLength(2);
    expect(c.every((x: any) => x[col('cancelled')] === 1)).toBe(true);

    // อ่านซ้ำจาก watermark ใหม่ = ไม่มีอะไร
    expect((await get(`?since=${next.body.next}`)).body.rows).toEqual([]);
  });

  it('พารามิเตอร์ผิด = 400 · method อื่น = 405 · fault 503 ใช้ได้', async () => {
    expect((await get('?since=abc')).status).toBe(400);
    expect((await get('?limit=0')).status).toBe(400);
    expect((await get('?limit=501')).status).toBe(400);
    const post = await fetch(`${mock.apiBaseUrl}/salesorder`, {
      method: 'POST',
      headers: { 'X-API-Key': KEY },
    });
    expect(post.status).toBe(405);
    mock.injectFault({ status: 503, method: 'GET' });
    const r = await get();
    expect(r.status).toBe(503);
    expect((await get()).status).toBe(200);
  });

  it('control ตรวจข้อมูล: แก้ soNo ไม่ได้ · ใบไม่มี = 404 · qty ต้องเป็นสตริงทศนิยม', async () => {
    expect(
      (await control('PATCH', '/salesorders/SAMPLE/SAMPLE-SO-6911-0001', { soNo: 'X' })).status,
    ).toBe(400);
    expect((await control('POST', '/salesorders/SAMPLE/SAMPLE-NOPE/cancel')).status).toBe(404);
    expect(
      (
        await control('PATCH', '/salesorders/SAMPLE/SAMPLE-SO-6911-0001', {
          lines: [{ lineNo: 1, itemCode: 'A', itemName: 'B', qty: 1.5, unit: 'ตัน' }],
        })
      ).status,
    ).toBe(400);
  });

  it('reset คืนข้อมูลตัวอย่าง · salesOrderSample=false = แหล่งว่าง', async () => {
    await control('POST', '/salesorders/SAMPLE/SAMPLE-SO-6911-0001/cancel');
    expect((await control('POST', '/reset')).status).toBe(200);
    const so = await control('GET', '/salesorders/SAMPLE/SAMPLE-SO-6911-0001');
    expect(so.body.cancelled).toBe(false);
    const empty = new MockKrs({ salesOrderSample: false });
    expect(empty.salesOrders.list()).toEqual([]);
    expect(optionsFromEnv({ MOCK_KRS_SO_SAMPLE: 'false' }).options.salesOrderSample).toBe(false);
  });
});
