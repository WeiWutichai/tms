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
const DO: { status: string } & Record<string, unknown> = {
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
        if (path === '/v1/trips/{id}')
          return ok({
            id: 'trp_1',
            tripNo: 'TRP-6911-0001',
            status: 'IN_PROGRESS',
            version: 2,
            assignedAt: null,
            dispatchedAt: '2026-11-24T01:00:00Z',
            stops: [
              {
                id: 's2',
                type: 'DELIVERY',
                plannedArrival: '2026-11-24T06:00:00Z',
                windowStart: null,
              },
            ],
            deliveryOrders: [
              { id: 'do_1', doNo: 'DO-6911-00001', dropStopId: 's2', pickupStopId: null },
            ],
          });
        if (path === '/v1/delivery-orders/{id}/revenue-lines')
          return ok({ sellRevenueTotal: '8500.00', provisional: false, data: [] });
        return ok(page([]));
      },
    },
  };
});
vi.mock('../trips/TripDrawer', () => ({
  TripDrawer: ({ id, completeDoId }: { id: string; completeDoId?: string }) => (
    <div data-testid="trip-drawer">
      {id}
      {completeDoId ? ` complete:${completeDoId}` : ''}
    </div>
  ),
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
    fireEvent.click(screen.getByRole('tab', { name: /ตีกลับบางส่วน/ }));
    await waitFor(() =>
      expect(lastList()).toMatchObject({
        status: 'DELIVERED,POD_PENDING,UNBILLED',
        rejected: 'true',
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: /^ส่งแล้ว/ }));
    await waitFor(() => expect(lastList().rejected).toBe('false'));
    fireEvent.click(screen.getByRole('tab', { name: /ส่งไม่สำเร็จ/ }));
    await waitFor(() => expect(lastList().status).toBe('FAILED,RETURNED'));
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
    // ไม่ซ้ำเลข PO ในหัว (มีใน kv แล้ว)
    expect(within(dlg).queryByText(/บริษัท ลูกค้า จำกัด · PO-77/)).toBeNull();
    // แท็บตามต้นแบบ
    for (const l of ['รายละเอียด', 'ไทม์ไลน์', 'หลักฐานส่ง', 'ค่าใช้จ่ายหน้างาน'])
      expect(within(dlg).getByRole('tab', { name: l })).toBeInTheDocument();
    // ส่งแล้ว (UNBILLED) ไม่มีปุ่ม ยืนยันส่งแล้ว / ปล่อยงาน
    expect(within(dlg).queryByRole('button', { name: /ยืนยันส่งแล้ว/ })).toBeNull();
    fireEvent.click(within(dlg).getByRole('button', { name: 'เพิ่มเติม' }));
    fireEvent.click(within(dlg).getByRole('menuitem', { name: /เปิดเที่ยวรถ/ }));
    expect(await screen.findByTestId('trip-drawer')).toHaveTextContent('trp_1');
  });
});

describe('หน้าใบส่งของ /do — ยืนยันส่งแล้ว', () => {
  beforeEach(() => {
    calls.length = 0;
    scopes = ['orders:read', 'trips:read', 'trips:dispatch'];
    DO.status = 'DISPATCHED';
  });

  it('เมนูแถว "ยืนยันส่งแล้ว" → drawer เที่ยว (ไทม์ไลน์ + ปิดงานที่จุดส่งของ DO นี้)', async () => {
    mount();
    await screen.findByText('DO-6911-00001');
    fireEvent.click(screen.getAllByRole('button', { name: /การกระทำ|เมนู|more/i })[0]!);
    fireEvent.click(await screen.findByText('ยืนยันส่งแล้ว'));
    expect(await screen.findByTestId('trip-drawer')).toHaveTextContent('trp_1 complete:do_1');
  });

  it('ไม่มี trips:dispatch → ไม่มีปุ่มยืนยันส่งแล้วใน drawer', async () => {
    scopes = ['orders:read', 'trips:read'];
    mount();
    fireEvent.click(await screen.findByText('DO-6911-00001'));
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByText('จุดรับ–ส่ง');
    expect(within(dlg).queryByRole('button', { name: /ยืนยันส่งแล้ว/ })).toBeNull();
  });
});
