import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * หน้าเที่ยวรถ `/trips` (UAT 24 พ.ย. 2569 — ต้นแบบ TMS v4 specTrp + vTrpB): การ์ด/แท็บ → ตัวกรองสถานะชุดเดียวกับตัวนับ,
 * คอลัมน์ตามต้นแบบ (เงินตามสิทธิ์), กระดาน (วาง DO บนการ์ด = attach · บน "เที่ยวใหม่" = สร้างเที่ยว · ปล่อยเที่ยว = bulk-assign)
 */
let scopes: string[] = [];
const calls: { m: string; path: string; query?: Record<string, unknown>; init?: unknown }[] = [];
const ok = (data: unknown, status = 200) =>
  Promise.resolve({ data, response: new Response(null, { status }) });
const page = (data: unknown[]) => ({ data, nextCursor: null, hasMore: false });
const trip = (o: Record<string, unknown>) => ({
  id: 'trp_1',
  tripNo: 'TRP-6911-0001',
  tripDate: '2026-11-24',
  status: 'PLANNING',
  version: 3,
  vehicle: { id: 'veh_1', plate: '70-1234', vehicleTypeId: 'vty_6', vehicleTypeName: '6 ล้อ' },
  trailer: null,
  driver: { id: 'drv_1', name: 'สมชาย ใจดี', phone: null },
  carrier: null,
  weightKg: '3000',
  stops: [
    { id: 's1', type: 'PICKUP', siteName: 'คลังบางนา' },
    { id: 's2', type: 'DELIVERY', siteName: 'ร้านชลบุรี' },
  ],
  deliveryOrders: [{ id: 'do_9', doNo: 'DO-6911-00009' }],
  sellAmount: '9500.00',
  buyTotal: '6500.00',
  ...o,
});
vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  return {
    ...real,
    api: {
      GET: (path: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
        calls.push({ m: 'GET', path, query: opts?.params?.query });
        if (path === '/v1/me')
          return ok({ scopes, user: { roles: ['x'] }, tenant: { yearStyle: 'BE', name: 'x' } });
        if (path === '/v1/trips/summary')
          return ok({ running: 1, offered: 1, planning: 5, inTransit: 3, done: 7, subcon: 2 });
        if (path === '/v1/delivery-orders')
          return ok(
            page([
              {
                id: 'do_1',
                doNo: 'DO-6911-00001',
                doDate: '2026-11-25',
                status: 'DRAFT',
                customerName: 'บริษัท ลูกค้า',
                originSiteName: 'คลังบางนา',
                destSiteName: 'ร้านระยอง',
                weightKg: '1200',
              },
            ]),
          );
        if (path === '/v1/vehicle-types') return ok(page([{ id: 'vty_6', payloadKg: 6000 }]));
        if (path === '/v1/trips') {
          const q = opts?.params?.query ?? {};
          if (q.status === 'PLANNING,ASSIGNED' && q.limit === 50) return ok(page([trip({})]));
          return ok(
            page([
              trip({ id: 'trp_2', tripNo: 'TRP-6911-0002', status: 'IN_PROGRESS' }),
              trip({ carrier: { id: 'car_1', name: 'หจก. รถร่วม' }, driver: null }),
            ]),
          );
        }
        if (path === '/v1/saved-views') return ok(page([]));
        return ok(page([]));
      },
      POST: (path: string, init?: unknown) => {
        calls.push({ m: 'POST', path, init });
        if (path === '/v1/trips/bulk-assign')
          return ok({
            results: [{ tripId: 'trp_1', trip: {}, outcome: 'DISPATCHED' }],
            succeeded: 1,
            unchanged: 0,
          });
        if (path === '/v1/trips') return ok(trip({ id: 'trp_new', tripNo: 'TRP-6911-0099' }), 201);
        return ok(trip({}));
      },
    },
  };
});
vi.mock('./TripDrawer', () => ({
  TripDrawer: ({ id }: { id: string }) => <div data-testid="trip-drawer">{id}</div>,
}));

const { TripsPage } = await import('./TripsPage');

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname}</div>;
}
function mount() {
  sessionStorage.clear();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={['/trips']}>
          <Routes>
            <Route path="*" element={<TripsPage />} />
          </Routes>
          <Loc />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const lastList = () =>
  calls.filter((c) => c.path === '/v1/trips' && c.query?.limit !== 50).at(-1)!.query!;

describe('หน้าเที่ยวรถ /trips', () => {
  beforeEach(() => {
    calls.length = 0;
    scopes = [
      'trips:read',
      'trips:assign',
      'trips:dispatch',
      'documents:write',
      'master:read',
      'orders:read',
      'prices.sell:read',
      'prices.buy:read',
    ];
  });

  it('หัวหน้า + การ์ด 4 ใบ (ตัวเลขจาก /trips/summary) + คอลัมน์ตามต้นแบบ', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'เที่ยวรถ / ใบคุมรถ' })).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('.tms-strip')).toHaveTextContent(
        '5วางแผน3ระหว่างส่ง7ส่งแล้ว2ใช้รถร่วม',
      ),
    );
    await screen.findByText('TRP-6911-0002');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of [
      'เลขเที่ยว',
      'วันที่',
      'รถ / หาง',
      'คนขับ / สังกัด',
      'เส้นทางหลัก',
      'จุด / DO',
      'รายได้ (฿)',
      'ค่าเที่ยว (฿)',
      'สถานะ',
    ])
      expect(heads.some((x) => x?.startsWith(h))).toBe(true);
    expect(screen.getAllByText('9,500.00').length).toBeGreaterThan(0);
    // รถร่วม: บรรทัดรอง = ชื่อรถร่วม · รถบริษัท = "รถบริษัท"
    expect(screen.getAllByText('หจก. รถร่วม').length).toBeGreaterThan(0);
    expect(screen.getAllByText('รถบริษัท').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 จุด · 1 DO').length).toBeGreaterThan(0);
  });

  it('ไม่มีสิทธิ์ราคา → ไม่มีคอลัมน์รายได้/ค่าเที่ยว', async () => {
    scopes = ['trips:read'];
    mount();
    await screen.findByText('TRP-6911-0002');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(heads.some((x) => x.includes('รายได้'))).toBe(false);
    expect(heads.some((x) => x.includes('ค่าเที่ยว'))).toBe(false);
    // ไม่มีสิทธิ์จัดรถ = ไม่มีช่อง "เที่ยวใหม่"
    expect(screen.queryByTestId('trip-new')).toBeNull();
  });

  it('คลิกการ์ด → แท็บ/ตัวกรองสถานะเดียวกับตัวนับ · ใช้รถร่วม = ownership=SUBCON', async () => {
    mount();
    await screen.findByText('TRP-6911-0002');
    fireEvent.click(screen.getAllByText('ระหว่างส่ง')[0]!.closest('button')!);
    await waitFor(() => expect(lastList().status).toBe('DISPATCHED,IN_PROGRESS'));
    fireEvent.click(screen.getAllByText('ใช้รถร่วม')[0]!.closest('button')!);
    await waitFor(() => expect(lastList().ownership).toBe('SUBCON'));
    expect(lastList().status).toContain('PLANNING');
    expect(lastList().status).not.toContain('CANCELLED');
  });

  it('ปุ่มหัวหน้า "เปิดกระดานวางแผน" → /plan', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /เปิดกระดานวางแผน/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/plan'));
  });

  it('กระดาน: วาง DO บนการ์ด = attach (If-Match) · บน "เที่ยวใหม่" = สร้างเที่ยว · ปล่อยเที่ยว = bulk-assign', async () => {
    mount();
    const pool = await screen.findByTestId('trip-pool-do');
    expect(pool).toHaveTextContent('DO-6911-00001');
    const card = await screen.findByTestId('trip-card');
    expect(within(card).getByText('3,000 / 6,000 กก.')).toBeInTheDocument();
    const dt = { getData: () => 'do_1', setData: () => undefined };
    fireEvent.dragStart(pool, { dataTransfer: dt });
    fireEvent.dragOver(card, { dataTransfer: dt });
    fireEvent.drop(card, { dataTransfer: dt });
    await waitFor(() =>
      expect(calls.some((c) => c.m === 'POST' && c.path === '/v1/trips/{id}/attach')).toBe(true),
    );
    const at = calls.find((c) => c.path === '/v1/trips/{id}/attach')!.init as {
      body: unknown;
      headers: Record<string, string>;
    };
    expect(at.body).toEqual({ deliveryOrderIds: ['do_1'] });
    expect(at.headers['If-Match']).toBe('"3"');
    await screen.findByText('เพิ่ม DO-6911-00001 เข้า TRP-6911-0001 แล้ว');

    fireEvent.drop(screen.getByTestId('trip-new'), { dataTransfer: dt });
    await waitFor(() =>
      expect(calls.some((c) => c.m === 'POST' && c.path === '/v1/trips')).toBe(true),
    );
    const cr = calls.find((c) => c.m === 'POST' && c.path === '/v1/trips')!.init as {
      body: unknown;
    };
    expect(cr.body).toMatchObject({ deliveryOrderIds: ['do_1'] });

    fireEvent.click(within(card).getByRole('button', { name: /ปล่อยเที่ยว/ }));
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/trips/bulk-assign')).toBe(true));
    const ba = calls.find((c) => c.path === '/v1/trips/bulk-assign')!.init as { body: unknown };
    expect(ba.body).toEqual({ items: [{ tripId: 'trp_1', version: 3 }], dispatch: true });
    await screen.findByText('ปล่อย 1 เที่ยวแล้ว');
  });

  it('คลิกการ์ดเที่ยว/แถว → drawer เที่ยว', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('trip-card'));
    expect(await screen.findByTestId('trip-drawer')).toHaveTextContent('trp_1');
  });
});
