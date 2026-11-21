import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { cardQuery } from '../features/dashboard/opsCards';

/**
 * ST9-T01 หน้าภาพรวม (Dashboard ปฏิบัติการ): ตัวเลขการ์ดจาก summary, คลิกการ์ด = `?card=` + ตาราง "ต้องทำวันนี้"
 * เรียกรายการ `/v1` ด้วยตัวกรองของการ์ด, การ์ดที่ไม่มีสิทธิ์ไม่ render, การ์ดที่โหลดไม่สำเร็จแสดง "ลองใหม่"
 */
let scopes: string[] = [];
let failTrips = false;
const calls: { path: string; query?: Record<string, unknown> }[] = [];
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });
const page = (data: unknown[]) => ({ data, nextCursor: null, hasMore: false });
const SUMMARY: Record<string, unknown> = {
  '/v1/orders/summary': {
    today: '2026-11-18',
    waiting: 7,
    waitingOverdue: 2,
    onHold: 3,
    heldTotal: 3,
    holdReasons: [
      { code: 'CUSTOMER_UNMAPPED', count: 2 },
      { code: 'RATE_MISSING', count: 0 },
    ],
  },
  '/v1/delivery-orders/summary': { date: '2026-11-18', today: 12, delivered: 5, failed: 1 },
  '/v1/trips/summary': { running: 4, offered: 2 },
  '/v1/vehicles/summary': { fleet: { available: 9, inUse: 4, maintenance: 1 } },
  // ST9-T02 Dashboard บิล
  '/v1/invoices/summary': {
    total: 12,
    draft: 2,
    issued: 3,
    partiallyPaid: 1,
    paid: 1,
    overdue: 2,
    cancelled: 2,
    today: '2026-11-18',
    sellDraftTotal: '3500.50',
    sellIssuedOutstanding: '15221.07',
    sellPartiallyPaidOutstanding: '3765.44',
    sellOverdueOutstanding: '12500.00',
    issuedThisMonth: { month: '2026-11', count: 6, sellTotal: '1234567.89' },
    issuedLastMonth: { month: '2026-10', count: 2, sellTotal: '4400.00' },
  },
  '/v1/payments/summary': {
    sellOutstanding: '31486.51',
    sellOverdueOutstanding: '12500.00',
    sellReceivedThisMonth: '2733.56',
    sellReceivedLastMonth: '200.00',
    receivedThisMonth: 3,
    receivedLastMonth: 1,
    dueSoon: 1,
    total: 9,
    open: 6,
    overdue: 2,
    partiallyPaid: 1,
    paid: 1,
  },
  '/v1/invoices/queue': {
    data: [],
    nextCursor: null,
    hasMore: false,
    customers: [],
    totals: { deliveryOrderCount: 2, releasedCount: 0, sellTotal: '2987.05' },
  },
};
/** ไม่มีสิทธิ์ราคาขาย — API ตัดฟิลด์ `sell*` (ตาม @PriceField) */
const unsell = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(unsell)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => !k.startsWith('sell'))
            .map(([k, x]) => [k, unsell(x)]),
        )
      : v;
let failInvoices = false;
vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>();
  return {
    ...real,
    api: {
      GET: (path: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
        calls.push({ path, query: opts?.params?.query });
        if (path === '/v1/me')
          return ok({ scopes, user: { roles: ['x'] }, tenant: { yearStyle: 'BE', name: 'x' } });
        if (path === '/v1/trips/summary' && failTrips)
          return Promise.resolve({
            error: { code: 'internal_error', status: 500, title: '', type: '' },
            response: new Response(null, { status: 500 }),
          });
        if (path === '/v1/invoices/summary' && failInvoices)
          return Promise.resolve({
            error: { code: 'internal_error', status: 500, title: '', type: '' },
            response: new Response(null, { status: 500 }),
          });
        if (path in SUMMARY)
          return ok(scopes.includes('prices.sell:read') ? SUMMARY[path] : unsell(SUMMARY[path]));
        if (path === '/v1/trips')
          return ok(
            page([
              {
                id: 'trp_1',
                tripNo: 'TRP-6911-0001',
                tripDate: '2026-11-18',
                status: 'IN_PROGRESS',
                vehicle: { plate: '70-1234' },
                driver: { name: 'สมชาย' },
                carrier: null,
                stops: [{ siteName: 'คลังบางนา' }, { siteName: 'ร้านชลบุรี' }],
              },
            ]),
          );
        if (path === '/v1/delivery-orders')
          return ok(
            page([
              {
                id: 'do_1',
                doNo: 'DO-6911-0001',
                status: 'DELIVERED',
                doDate: '2026-11-18',
                customerName: 'บริษัท ลูกค้า',
                originSiteName: 'คลัง',
                destSiteName: 'ร้าน',
                vehiclePlate: null,
                driverName: null,
                carrierName: null,
                tripId: null,
                orderId: 'ord_1',
              },
            ]),
          );
        return ok(page([]));
      },
    },
  };
});
vi.mock('../features/setup/SetupChecklist', () => ({ SetupChecklist: () => null }));
vi.mock('../features/imports/ImportExcelButton', () => ({ ImportExcelButton: () => null }));
vi.mock('../features/trips/TripDrawer', () => ({ TripDrawer: () => null }));

import { Dashboard } from './Dashboard';

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}
function mount(url = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="*" element={<Dashboard />} />
          </Routes>
          <Loc />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Dashboard ปฏิบัติการ (ST9-T01)', () => {
  beforeEach(() => {
    calls.length = 0;
    failTrips = false;
    scopes = ['orders:read', 'trips:read', 'master:read'];
  });

  it('การ์ด 6 ใบตามลำดับ + ตัวเลขจาก summary + บรรทัดรอง "ส่งแล้ว x / y" + การ์ดล่าง', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('kpi-today')).toHaveTextContent('12'));
    await waitFor(() => expect(screen.getByTestId('kpi-running')).toHaveTextContent('4'));
    expect(screen.getByTestId('kpi-waiting')).toHaveTextContent('7');
    expect(screen.getByTestId('kpi-failed')).toHaveTextContent('1');
    expect(screen.getByTestId('kpi-delivered')).toHaveTextContent('5');
    expect(screen.getByTestId('kpi-offered')).toHaveTextContent('2');
    const labels = screen.getAllByTestId(/^kpi-.*-label$/).map((e) => e.textContent);
    expect(labels).toEqual([
      'งานวันนี้',
      'รอจัดรถ',
      'กำลังวิ่ง',
      'ส่งไม่สำเร็จวันนี้',
      'ส่งแล้ววันนี้',
      'รถร่วมรอตอบ',
    ]);
    expect(screen.getByText('ส่งแล้ว 5 / 12')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-waiting-over')).toHaveTextContent('เลยกำหนดรับ 2');
    // หัวหน้าใช้วันที่ของ server
    expect(screen.getByText(/งานปฏิบัติการประจำวันที่ 18 พ\.ย\. 2569/)).toBeInTheDocument();
    // ใบค้างต่อเหตุ: แสดงเฉพาะเหตุที่มีใบ
    expect(screen.getByTestId('hold-CUSTOMER_UNMAPPED-n')).toHaveTextContent('2');
    expect(screen.queryByTestId('hold-RATE_MISSING')).toBeNull();
    expect(screen.getByTestId('fleet-available-n')).toHaveTextContent('9');
    // ตารางเริ่มต้น = DO วันนี้ (วันจาก server)
    await screen.findByText('DO-6911-0001');
    const q = calls.find((c) => c.path === '/v1/delivery-orders')!.query!;
    expect(q).toMatchObject(cardQuery('today', '2026-11-18'));
  });

  it('คลิกการ์ด → ?card= + รายการเที่ยวด้วยตัวกรองเดียวกับที่นับ · คลิกซ้ำ = ล้าง', async () => {
    mount();
    fireEvent.click((await screen.findByTestId('kpi-running')).closest('button')!);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/?card=running'));
    await screen.findByText('TRP-6911-0001');
    expect(calls.find((c) => c.path === '/v1/trips')!.query).toMatchObject({
      status: 'IN_PROGRESS',
    });
    expect(screen.getByText('กรองอยู่')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('kpi-running').closest('button')!);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/));
  });

  it('สลับการ์ดเร็ว ๆ: ทุกคำขอรายการใช้ตัวกรองของ endpoint นั้นเท่านั้น (ไม่ยิงตัวกรองการ์ดเก่าไป endpoint ใหม่ → 422)', async () => {
    mount();
    await screen.findByText('DO-6911-0001');
    for (const k of ['running', 'waiting', 'failed', 'offered', 'running', 'delivered'])
      fireEvent.click(screen.getByTestId(`kpi-${k}`).closest('button')!);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/?card=delivered'));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.path === '/v1/delivery-orders' &&
            c.query?.status === 'DELIVERED,POD_PENDING,UNBILLED,BILLED',
        ),
      ).toBe(true),
    );
    const lists = calls.filter((c) =>
      ['/v1/orders', '/v1/trips', '/v1/delivery-orders'].includes(c.path),
    );
    for (const c of lists) {
      const q = c.query ?? {};
      if (c.path === '/v1/trips') {
        expect(q.dateFrom).toBeUndefined();
        expect(['IN_PROGRESS', 'OFFERED']).toContain(q.status);
      }
      if (c.path === '/v1/orders')
        expect(q).toMatchObject({ status: 'received,on_hold', requestedTo: '2026-11-19' });
      if (c.path === '/v1/delivery-orders') expect(q.dateFrom).toBe('2026-11-18');
      expect(q.card).toBeUndefined();
    }
  });

  it('ตัวกรองการ์ดตาม spec/09 §1: รอจัดรถ = วันรับของ ≤ พรุ่งนี้ · กำลังวิ่ง = IN_PROGRESS', () => {
    expect(cardQuery('waiting', '2026-11-18')).toEqual({
      status: 'received,on_hold',
      requestedTo: '2026-11-19',
    });
    expect(cardQuery('running', '')).toEqual({ status: 'IN_PROGRESS' });
  });

  it('การ์ดรถ/ใบค้าง ลิงก์ไปหน้ารายการพร้อมตัวกรอง', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('fleet-inUse'));
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent(
        '/fleet/vehicles?ownership=OWN&busy=true',
      ),
    );
  });

  it('ไม่มี trips:read → ไม่ render การ์ดเที่ยวและไม่เรียก API · ไม่มี master:read → ไม่มีการ์ดรถ', async () => {
    scopes = ['orders:read'];
    mount();
    await screen.findByTestId('kpi-today');
    expect(screen.queryByTestId('kpi-running')).toBeNull();
    expect(screen.queryByTestId('kpi-offered')).toBeNull();
    expect(screen.queryByTestId('dash-fleet')).toBeNull();
    expect(calls.some((c) => c.path === '/v1/trips/summary')).toBe(false);
    expect(calls.some((c) => c.path === '/v1/vehicles/summary')).toBe(false);
  });

  it('summary ของเที่ยวล้ม → การ์ดเที่ยวแสดง "โหลดไม่สำเร็จ · ลองใหม่" การ์ดอื่นยังแสดง', async () => {
    failTrips = true;
    mount();
    await waitFor(() => expect(screen.getByTestId('kpi-today')).toHaveTextContent('12'));
    await waitFor(() => expect(screen.getAllByText('โหลดไม่สำเร็จ · ลองใหม่')).toHaveLength(2));
  });
});

/**
 * ST9-T02 Dashboard บิล: KPI "ใบแจ้งหนี้เกินกำหนด" ตำแหน่งที่ 4 (ต้นแบบ) + การ์ด "สถานะบิล" 5 ช่อง + เดือนนี้ vs เดือนก่อน
 * + การ์ด "ลูกหนี้ค้างชำระ" · ตัวเลข = ค่าจาก summary ตรง ๆ (ไม่คำนวณเงินฝั่งเว็บ) · ไม่มี WHT/50 ทวิ (D-54) · สิทธิ์ (RPT-011)
 */
describe('Dashboard บิล (ST9-T02)', () => {
  beforeEach(() => {
    calls.length = 0;
    failTrips = false;
    failInvoices = false;
    scopes = ['orders:read', 'trips:read', 'master:read', 'invoices:read', 'prices.sell:read'];
  });

  it('KPI เกินกำหนดตำแหน่งที่ 4 + ยอดค้าง · การ์ด 5 ช่อง = ยอดจาก summary · เดือนนี้/เดือนก่อน · ลูกหนี้', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('kpi-invOver')).toHaveTextContent('2'));
    await waitFor(() =>
      expect(screen.getAllByTestId(/^kpi-.*-label$/).map((e) => e.textContent)).toEqual([
        'งานวันนี้',
        'รอจัดรถ',
        'กำลังวิ่ง',
        'ใบแจ้งหนี้เกินกำหนด',
        'ส่งไม่สำเร็จวันนี้',
        'ส่งแล้ววันนี้',
        'รถร่วมรอตอบ',
      ]),
    );
    expect(screen.getByTestId('kpi-invOver-sub')).toHaveTextContent('ค้าง 12,500.00');
    const v = (id: string) => screen.getByTestId(id).textContent;
    await waitFor(() => expect(v('bill-ready-v')).toBe('2,987.05'));
    expect([
      v('bill-draft-v'),
      v('bill-issued-v'),
      v('bill-overdue-v'),
      v('bill-partial-v'),
    ]).toEqual(['3,500.50', '15,221.07', '12,500.00', '3,765.44']);
    expect([
      v('bill-draft-n'),
      v('bill-ready-n'),
      v('bill-issued-n'),
      v('bill-overdue-n'),
      v('bill-partial-n'),
    ]).toEqual(['2 ใบ', '2 ใบส่งของ', '3 ใบ', '2 ใบ', '1 ใบ']);
    expect(v('month-issued-this')).toBe('1,234,567.89');
    expect(v('month-issued-last')).toBe('4,400.00');
    expect(v('month-received-this')).toBe('2,733.56');
    expect(v('month-received-last')).toBe('200.00');
    expect(v('ar-open-v')).toBe('31,486.51');
    expect(v('ar-over-v')).toBe('12,500.00');
    expect(screen.getByTestId('ar-open')).toHaveTextContent('ค้างรับ · 6 ใบ');
    // D-54: ไม่มีการ์ด WHT รอ 50 ทวิ
    expect(screen.queryByText(/50 ทวิ/)).toBeNull();
    expect(screen.queryByText(/WHT/)).toBeNull();
  });

  it('คลิกการ์ด → หน้ารายการที่แท็บเดียวกัน (RPT-005)', async () => {
    const cases: [string, string][] = [
      ['bill-draft', '/bill?tab=DRAFT'],
      ['bill-ready', '/bill'],
      ['bill-issued', '/bill?tab=ISSUED'],
      ['bill-overdue', '/pay?tab=over'],
      ['bill-partial', '/pay?tab=part'],
      ['ar-open', '/pay?tab=open'],
    ];
    for (const [id, to] of cases) {
      const r = mount();
      fireEvent.click(await screen.findByTestId(id));
      await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(to));
      r.unmount();
    }
    mount();
    fireEvent.click((await screen.findByTestId('kpi-invOver')).closest('button')!);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/pay?tab=over'));
  });

  it('ไม่มีสิทธิ์ราคาขาย → แสดงจำนวนแทนยอดเงิน (API ไม่ส่งฟิลด์เงิน)', async () => {
    scopes = ['orders:read', 'invoices:read'];
    mount();
    await waitFor(() => expect(screen.getByTestId('bill-draft-v')).toHaveTextContent('2 ใบ'));
    expect(screen.getByTestId('bill-ready-v')).toHaveTextContent('2 ใบส่งของ');
    expect(screen.queryByTestId('bill-draft-n')).toBeNull();
    expect(screen.getByTestId('month-issued-this')).toHaveTextContent('6 ใบ');
    expect(screen.getByTestId('month-received-last')).toHaveTextContent('1 ใบ');
    expect(screen.queryByTestId('kpi-invOver-sub')).toBeNull();
    expect(screen.getByTestId('ar-over-v')).toHaveTextContent('2');
    expect(screen.queryByText(/12,500/)).toBeNull();
  });

  it('ไม่มี invoices:read → ไม่ render การ์ดเงินและไม่เรียก API (RPT-011)', async () => {
    scopes = ['orders:read', 'trips:read', 'master:read', 'prices.sell:read'];
    mount();
    await screen.findByTestId('kpi-today');
    expect(screen.queryByTestId('kpi-invOver')).toBeNull();
    expect(screen.queryByTestId('dash-bill')).toBeNull();
    for (const p of ['/v1/invoices/summary', '/v1/payments/summary', '/v1/invoices/queue'])
      expect(calls.some((c) => c.path === p)).toBe(false);
  });

  it('summary ใบแจ้งหนี้ล้ม → KPI/ช่องใบแจ้งหนี้ "โหลดไม่สำเร็จ · ลองใหม่" · ค้างวางบิล/ลูกหนี้ยังแสดง', async () => {
    failInvoices = true;
    mount();
    await waitFor(() => expect(screen.getByTestId('bill-ready-v')).toHaveTextContent('2,987.05'));
    await waitFor(() =>
      expect(screen.getByTestId('bill-draft')).toHaveTextContent('โหลดไม่สำเร็จ'),
    );
    expect(screen.getByTestId('ar-open-v')).toHaveTextContent('31,486.51');
  });
});
