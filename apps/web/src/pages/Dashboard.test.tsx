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
    waiting: 7,
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
};
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
        if (path in SUMMARY) return ok(SUMMARY[path]);
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
      status: 'DISPATCHED,IN_PROGRESS',
    });
    expect(screen.getByText('กรองอยู่')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('kpi-running').closest('button')!);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/));
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
