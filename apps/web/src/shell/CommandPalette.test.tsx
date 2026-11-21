import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { th } from '../i18n/th';

/** ST9-T09 ค้นหา ⌘K — กลุ่ม/คีย์บอร์ด/ปลายทาง deep link ตามต้นแบบ vCmd() */
const ok = (data: unknown) => Promise.resolve({ data, response: { ok: true, status: 200 } });
const hit = (x: Record<string, unknown>) => ({
  label: null,
  matchedOn: 'number',
  status: null,
  customerName: null,
  customerRef: null,
  plate: null,
  vehicleType: null,
  driverName: null,
  code: null,
  overdue: false,
  orderId: null,
  tripId: null,
  ...x,
});
const TRIP = 'trp_' + 'a'.repeat(32);
const DO = 'do_' + 'b'.repeat(32);
const ORD = 'ord_' + 'c'.repeat(32);
const RESULT = {
  q: '2611-004',
  searched: ['order', 'deliveryOrder', 'vehicle'],
  data: [
    hit({
      type: 'order',
      id: ORD,
      label: 'SO-2611-0042',
      status: 'received',
      customerName: 'บจก. สยามพลาสติก',
    }),
    hit({
      type: 'deliveryOrder',
      id: DO,
      label: 'DO-2611-0042',
      status: 'DRAFT',
      customerName: 'บจก. สยามพลาสติก',
      orderId: ORD,
      tripId: TRIP,
    }),
    hit({
      type: 'vehicle',
      id: 'veh_' + 'd'.repeat(32),
      label: '70-2611',
      vehicleType: 'หกล้อ',
      driverName: null,
    }),
  ],
};
const GET = vi.fn((_p: string, _o?: unknown) => ok(RESULT));
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  api: { GET: (p: string, o: unknown) => GET(p, o) },
}));

const { CommandPalette, hitPath, hitSub, rankOf } = await import('./CommandPalette');

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
const show = (scopes: string[] = ['*']) => {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <CommandPalette open onClose={onClose} scopes={scopes} />
                  <Where />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onClose;
};

beforeEach(() => GET.mockClear());

describe('CommandPalette (ST9-T09)', () => {
  it('ยังไม่พิมพ์: คำสั่ง + หน้า ตามสิทธิ์ (ไม่เรียก API) · ช่องค้นหาได้ focus', () => {
    show(['orders:read', 'orders:write']);
    expect(screen.getByRole('dialog', { name: 'ค้นหา' })).toBeInTheDocument();
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('placeholder', th['cmdk.ph']);
    expect(screen.getByRole('option', { name: /สร้าง SO ใหม่/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /สร้างใบวางบิล/ })).toBeNull();
    expect(screen.getByRole('group', { name: 'หน้า' })).toBeInTheDocument();
    expect(GET).not.toHaveBeenCalled();
  });

  it('พิมพ์เลข DO บางส่วน → เรียก /v1/search แล้ว Enter เปิดเที่ยวของ DO', async () => {
    const onClose = show();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: ' 2611-004 ' } });
    const doc = await screen.findByRole('option', { name: /DO-2611-0042/ });
    expect(GET).toHaveBeenCalledWith('/v1/search', {
      params: { query: { q: '2611-004', limit: 6 } },
    });
    expect(doc.textContent).toContain('บจก. สยามพลาสติก · รอจัดรถ');
    expect(screen.getByRole('option', { name: /70-2611/ }).textContent).toContain(
      'หกล้อ · ไม่มีคนขับ',
    );
    // ลูกศรลงไปที่ DO แล้ว Enter
    const opts = screen.getAllByRole('option');
    const at = opts.findIndex((o) => o === doc);
    for (let i = 0; i < at; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(doc).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', doc.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe(`/plan?trip=${TRIP}`);
  });

  it('ไม่พบผล → กล่องว่างตามต้นแบบ', async () => {
    GET.mockImplementationOnce(() => ok({ q: 'zzzz', searched: ['order'], data: [] }));
    show(['orders:read']);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzz' } });
    expect(await screen.findByText('ไม่พบผลลัพธ์')).toBeInTheDocument();
    expect(screen.getByText(th['cmdk.empty.d'])).toBeInTheDocument();
  });

  it('ปลายทาง deep link ของแต่ละชนิด', () => {
    const h = (x: Record<string, unknown>) => hit(x) as Parameters<typeof hitPath>[0];
    expect(hitPath(h({ type: 'order', id: ORD }), ['*'])).toBe(`/so?open=${ORD}`);
    expect(hitPath(h({ type: 'deliveryOrder', id: DO, orderId: ORD, tripId: TRIP }), ['*'])).toBe(
      `/plan?trip=${TRIP}`,
    );
    // ไม่มีสิทธิ์ดูเที่ยว / DO ยังไม่จัด → drawer SO
    expect(
      hitPath(h({ type: 'deliveryOrder', id: DO, orderId: ORD, tripId: TRIP }), ['orders:read']),
    ).toBe(`/so?open=${ORD}`);
    expect(hitPath(h({ type: 'invoice', id: 'ivc_1' }), ['*'])).toBe('/bill?invoice=ivc_1');
    expect(hitPath(h({ type: 'billingNote', id: 'bn_1' }), ['*'])).toBe('/bill?bn=bn_1');
    expect(hitPath(h({ type: 'customer', id: 'cus_1' }), ['*'])).toBe(
      '/master/customers?open=cus_1',
    );
    expect(hitPath(h({ type: 'vehicle', id: 'veh_1' }), ['*'])).toBe('/fleet/vehicles/veh_1');
  });

  it('บรรทัดรอง: เจอจากเลข PO / ใบแจ้งหนี้เกินกำหนด · อันดับตรงทั้งคำก่อน', () => {
    const t = (k: string) => (th as Record<string, string>)[k] ?? k;
    const h = (x: Record<string, unknown>) => hit(x) as Parameters<typeof hitSub>[0];
    expect(
      hitSub(
        h({ type: 'invoice', customerName: 'A', status: 'ISSUED', overdue: true }),
        t as never,
      ),
    ).toBe('A · เกินกำหนด');
    expect(
      hitSub(
        h({ type: 'order', customerName: 'A', matchedOn: 'po', customerRef: 'PO-77' }),
        t as never,
      ),
    ).toBe('A · เลข PO ลูกค้า: PO-77');
    expect(rankOf(h({ label: 'DO-1' }), 'do-1')).toBe(0);
    expect(rankOf(h({ label: 'DO-12' }), 'do-1')).toBe(1);
    expect(rankOf(h({ label: 'X-DO-1' }), 'do-1')).toBe(2);
  });

  it('Esc ปิด', async () => {
    const onClose = show();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
