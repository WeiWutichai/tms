import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * หน้าใบส่งของ `/do` (UAT 24 พ.ย. 2569 — ต้นแบบ TMS v4 specDo + kpisX do + vPanel do): การ์ด (มูลค่ายังไม่วางบิลตามสิทธิ์),
 * แท็บ → สถานะจริง, ตัวกรองคอลัมน์ → query, drawer DO (ข้อมูล/จุดรับ–ส่ง/ราคา snapshot/เปิดเที่ยวรถ)
 */
let scopes: string[] = [];
const calls: { path: string; query?: Record<string, unknown> }[] = [];
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });
const page = (data: unknown[]) => ({ data, nextCursor: null, hasMore: false });
const DO = {
  id: 'do_1',
  doNo: 'DO-6911-00001',
  status: 'UNBILLED',
  orderId: 'ord_1',
  doDate: '2026-11-24',
  customerName: 'บริษัท ลูกค้า จำกัด',
  originSiteName: 'คลังบางนา',
  destSiteName: 'ร้านชลบุรี',
  tripId: 'trp_1',
  tripNo: 'TRP-6911-0001',
  vehiclePlate: '70-1234',
  driverName: 'สมชาย ใจดี',
  carrierName: null,
  weightKg: '1200',
  customerRef: 'PO-77',
  lines: [
    { lineNo: 1, description: 'ปูนซีเมนต์', qtyPlanned: '10', unit: 'ถุง' },
    { lineNo: 2, description: 'ทราย', qtyPlanned: '2', unit: 'ตัน' },
  ],
};
const SUMMARY = {
  date: '2026-11-24',
  today: 4,
  delivered: 2,
  failed: 0,
  draft: 6,
  inTransit: 3,
  unbilled: 5,
  sellUnbilledAmount: '125400.00',
};
vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  return {
    ...real,
    api: {
      GET: (path: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
        calls.push({ path, query: opts?.params?.query });
        if (path === '/v1/me')
          return ok({ scopes, user: { roles: ['x'] }, tenant: { yearStyle: 'BE', name: 'x' } });
        if (path === '/v1/delivery-orders/summary')
          return ok(
            scopes.includes('prices.sell:read')
              ? SUMMARY
              : { ...SUMMARY, sellUnbilledAmount: undefined },
          );
        if (path === '/v1/delivery-orders') return ok(page([DO]));
        if (path === '/v1/delivery-orders/{id}') return ok(DO);
        if (path === '/v1/delivery-orders/{id}/revenue-lines')
          return ok({ sellRevenueTotal: '8500.00', provisional: false, data: [] });
        return ok(page([]));
      },
    },
  };
});
vi.mock('../trips/TripDrawer', () => ({
  TripDrawer: ({ id }: { id: string }) => <div data-testid="trip-drawer">{id}</div>,
}));
vi.mock('../orders/OrderDrawer', () => ({
  OrderDrawer: ({ id }: { id: string }) => <div data-testid="order-drawer">{id}</div>,
}));

const { DoPage } = await import('./DoPage');

function mount() {
  sessionStorage.clear();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={['/do']}>
          <DoPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const lastList = () => calls.filter((c) => c.path === '/v1/delivery-orders').at(-1)!.query!;

describe('หน้าใบส่งของ /do', () => {
  beforeEach(() => {
    calls.length = 0;
    scopes = ['orders:read', 'trips:read', 'prices.sell:read'];
  });

  it('การ์ด 4 ใบตามต้นแบบ — ยังไม่วางบิล = มูลค่า ฿ (มีสิทธิ์ราคาขาย) + คอลัมน์ตามต้นแบบ', async () => {
    mount();
    await waitFor(() =>
      expect(document.querySelector('.tms-strip')).toHaveTextContent(
        '6ร่าง3ระหว่างส่ง2ส่งแล้ววันนี้฿125,400.00ยังไม่วางบิล · 5 ใบ',
      ),
    );
    await screen.findByText('DO-6911-00001');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    for (const h of [
      'เลข DO',
      'วันที่ส่ง',
      'ลูกค้า',
      'เส้นทาง',
      'รถ',
      'คนขับ',
      'น้ำหนัก / เที่ยว',
      'สินค้า',
      'สถานะ',
    ])
      expect(heads.some((x) => x.startsWith(h))).toBe(true);
    expect(screen.getByText('ปูนซีเมนต์ +1 รายการ')).toBeInTheDocument();
    expect(screen.getByText('1,200 กก.')).toBeInTheDocument();
    // ไม่มีปุ่มหัวหน้า (สร้าง DO / นำเข้า / พิมพ์ — spec/12 §3)
    expect(screen.queryByRole('button', { name: /สร้าง DO/ })).toBeNull();
  });

  it('ไม่มีสิทธิ์ราคาขาย → การ์ดยังไม่วางบิลแสดงจำนวนใบ', async () => {
    scopes = ['orders:read'];
    mount();
    await waitFor(() =>
      expect(document.querySelector('.tms-strip')).toHaveTextContent('5ยังไม่วางบิล · 5 ใบ'),
    );
    expect(document.querySelector('.tms-strip')).not.toHaveTextContent('฿');
  });

  it('แท็บ → สถานะจริง · การ์ดส่งแล้ววันนี้ = สถานะส่งแล้ว + วันของ server · ตัวกรองคอลัมน์ → query', async () => {
    mount();
    await screen.findByText('DO-6911-00001');
    fireEvent.click(screen.getByRole('tab', { name: /ตีกลับ/ }));
    await waitFor(() => expect(lastList().status).toBe('RETURNED'));
    fireEvent.click(screen.getByRole('tab', { name: /ร่าง/ }));
    await waitFor(() => expect(lastList().status).toBe('DRAFT,PLANNED'));
    fireEvent.click(screen.getByText('ส่งแล้ววันนี้').closest('button')!);
    await waitFor(() =>
      expect(lastList()).toMatchObject({
        status: 'DELIVERED,POD_PENDING,UNBILLED,BILLED',
        dateFrom: '2026-11-24',
        dateTo: '2026-11-24',
      }),
    );
    fireEvent.click(screen.getByText(/ยังไม่วางบิล · 5 ใบ/).closest('button')!);
    await waitFor(() => expect(lastList().status).toBe('DELIVERED,POD_PENDING,UNBILLED'));
  });

  it('คลิกแถว → drawer DO: ข้อมูล + จุดรับ–ส่ง + ราคา snapshot + เปิดเที่ยวรถ', async () => {
    mount();
    fireEvent.click(await screen.findByText('DO-6911-00001'));
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByText('ใบส่งของ');
    expect(within(dlg).getByText('จุดรับ–ส่ง')).toBeInTheDocument();
    expect(within(dlg).getByText('1 · รับ')).toBeInTheDocument();
    expect(within(dlg).getByText('ปูนซีเมนต์ 10 ถุง, ทราย 2 ตัน')).toBeInTheDocument();
    await within(dlg).findByText('฿8,500.00');
    fireEvent.click(within(dlg).getByRole('button', { name: 'เปิดเที่ยวรถ' }));
    expect(await screen.findByTestId('trip-drawer')).toHaveTextContent('trp_1');
  });
});
