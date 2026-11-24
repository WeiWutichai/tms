import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { TripDetail } from './useTrips';

/**
 * ปิดต้นทุนเที่ยว (ST6-T01 API · UI UAT 24 พ.ย. 2569): kv ค่าเที่ยว (prices.buy:read) + สถานะต้นทุน/สิ่งที่ขวาง,
 * ปุ่ม "ปิดต้นทุนเที่ยว" กดไม่ได้เมื่อมี blocker · ยืนยันใน dialog → POST /trips/{id}/cost พร้อม If-Match
 */
let costs: { summary: Record<string, unknown> } = { summary: {} };
let fail: unknown = null;
const posts: { path: string; init: unknown }[] = [];
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });
vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  return {
    ...real,
    api: {
      GET: (path: string) => {
        if (path === '/v1/delivery-orders/{id}/revenue-lines')
          return ok({ sellRevenueTotal: '4750.25', provisional: false, data: [] });
        if (path === '/v1/me')
          return ok({ scopes: [], user: { roles: ['x'] }, tenant: { yearStyle: 'BE', name: 'x' } });
        return ok(costs);
      },
      POST: (path: string, init: unknown) => {
        posts.push({ path, init });
        if (fail)
          return Promise.resolve({ error: fail, response: new Response(null, { status: 409 }) });
        return ok({ ...TRIP, status: 'COSTED', version: 8 });
      },
    },
  };
});
const { TripMoneySection, TripCostCloseButton } = await import('./TripCost');

const TRIP = {
  id: 'trp_1',
  tripNo: 'TRP-6911-0001',
  status: 'COMPLETED',
  version: 7,
  carrier: { id: 'car_1', name: 'หจก. รถร่วม' },
  deliveryOrders: [{ id: 'do_1' }, { id: 'do_2' }],
} as unknown as TripDetail;

function mount(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('ปิดต้นทุนเที่ยว', () => {
  beforeEach(() => {
    posts.length = 0;
    fail = null;
  });

  it('ส่วนยอดเงิน: รายได้จาก DO (รวมทุกใบ) / ค่าเที่ยวรถร่วม / กำไร (มีทั้งสองสิทธิ์) + สิ่งที่ขวาง', async () => {
    costs = {
      summary: {
        tripStatus: 'COMPLETED',
        buyTotal: '6500.00',
        pendingCount: 1,
        blockers: ['PENDING_FIELD_CHARGES'],
        costedAt: null,
      },
    };
    mount(<TripMoneySection trip={TRIP} canSeeBuy canSeeSell />);
    expect(await screen.findByText('ยอดเงิน')).toBeInTheDocument();
    expect(await screen.findByText('9,500.50')).toBeInTheDocument();
    expect(screen.getByText('ค่าเที่ยวรถร่วม')).toBeInTheDocument();
    expect(screen.getByText('6,500.00')).toBeInTheDocument();
    expect(screen.getByText('กำไรเที่ยวนี้')).toBeInTheDocument();
    expect(screen.getByText('3,000.50')).toBeInTheDocument();
    expect(screen.getByText('ยังปิดต้นทุนไม่ได้: มีค่าใช้จ่ายหน้างานรอยืนยัน')).toBeInTheDocument();
  });

  it('มีสิทธิ์ราคาซื้ออย่างเดียว → ไม่มีรายได้/กำไร · ไม่มีสิทธิ์ราคา → แสดงแค่สถานะต้นทุน', async () => {
    costs = {
      summary: { tripStatus: 'COMPLETED', buyTotal: '100.00', pendingCount: 0, blockers: [] },
    };
    const { unmount } = mount(<TripMoneySection trip={TRIP} canSeeBuy canSeeSell={false} />);
    expect(await screen.findByText('100.00')).toBeInTheDocument();
    expect(screen.queryByText('รายได้จาก DO')).toBeNull();
    expect(screen.queryByText('กำไรเที่ยวนี้')).toBeNull();
    unmount();
    costs = { summary: { tripStatus: 'COMPLETED', pendingCount: 0, blockers: [], costedAt: null } };
    mount(<TripMoneySection trip={TRIP} canSeeBuy={false} canSeeSell={false} />);
    expect(await screen.findByText('ยังไม่ปิดต้นทุน')).toBeInTheDocument();
    expect(screen.queryByText('ค่าเที่ยวรถร่วม')).toBeNull();
  });

  it('มี blocker → ปุ่มกดไม่ได้', async () => {
    costs = {
      summary: { tripStatus: 'COMPLETED', pendingCount: 0, blockers: ['CARRIER_FEE_MISSING'] },
    };
    mount(<TripCostCloseButton trip={TRIP} onDone={() => undefined} />);
    const b = await screen.findByTestId('trip-cost-close');
    await waitFor(() => expect(b).toBeDisabled());
  });

  it('ยืนยัน → POST /cost + If-Match + toast · 409 แสดงข้อความใน dialog', async () => {
    costs = { summary: { tripStatus: 'COMPLETED', pendingCount: 0, blockers: [] } };
    const done = vi.fn();
    mount(<TripCostCloseButton trip={TRIP} onDone={done} />);
    const b = await screen.findByTestId('trip-cost-close');
    await waitFor(() => expect(b).not.toBeDisabled());
    fireEvent.click(b);
    expect(
      await screen.findByRole('dialog', { name: 'ปิดต้นทุนเที่ยว TRP-6911-0001' }),
    ).toBeInTheDocument();
    fail = { type: '', title: '', status: 409, code: 'trip_costs_incomplete' };
    fireEvent.click(screen.getByRole('button', { name: /^ปิดต้นทุน$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ต้นทุนเที่ยวยังไม่ครบ');
    fail = null;
    fireEvent.click(screen.getByRole('button', { name: /^ปิดต้นทุน$/ }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('ปิดต้นทุน TRP-6911-0001 แล้ว'));
    const p = posts.at(-1)!;
    expect(p.path).toBe('/v1/trips/{id}/cost');
    expect((p.init as { headers: Record<string, string> }).headers['If-Match']).toBe('"7"');
  });
});
