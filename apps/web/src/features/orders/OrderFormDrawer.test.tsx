import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { fromOrder, type Order } from './orderForm';

/**
 * ST3-T02 review M2: ฟอร์มแก้ไขใช้สถานะ/ช่องที่แก้ได้ล่าสุดจาก GET (useOrder) — หลัง 409 order_locked_for_update
 * โหลดใบใหม่แล้วช่องถูกปิดและป้ายแสดงสถานะใหม่ โดยไม่ล้างสิ่งที่ผู้ใช้พิมพ์
 */
const live: { data: Order | undefined } = { data: undefined };
vi.mock('./useOrders', () => ({
  useOrder: () => live,
  useCreateOrder: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useUpdateOrder: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useVehicleTypeOptions: () => ({ data: { data: [{ id: 'vty_1', name: '6 ล้อ' }] } }),
  searchCustomers: vi.fn(),
  searchSites: () => vi.fn(),
  searchUnits: vi.fn(),
  searchProducts: vi.fn(),
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' } } }),
}));

const { OrderFormDrawer } = await import('./OrderFormDrawer');

const BASE = {
  id: 'ord_1',
  soNo: 'SO-6911-0001',
  status: 'received',
  source: 'MANUAL',
  sourceType: 'MANUAL',
  connector: null,
  externalId: null,
  customer: {
    id: 'cus_1',
    code: 'CUS-0001',
    legalName: 'บจก. ตัวอย่าง',
    externalId: null,
    name: null,
  },
  billingCompanyId: 'cmp_1',
  customerRef: 'PO-1',
  requestedDate: '2026-11-13',
  vehicleTypeId: 'vty_1',
  holdReason: null,
  holdCodes: [],
  pricingStatus: 'AVAILABLE',
  pricingReasons: [],
  stops: [
    {
      sequence: 1,
      type: 'PICKUP',
      siteId: 'loc_a',
      siteText: 'คลัง',
      windowStart: null,
      windowEnd: null,
    },
  ],
  lines: [],
  editableFields: [
    'customer',
    'customerRef',
    'requestedDate',
    'vehicleTypeId',
    'stops',
    'stops.window',
    'lines',
  ],
  version: 1,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
} as unknown as Order;

const view = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider lang="th">
        <OrderFormDrawer
          mode="edit"
          initial={fromOrder(BASE)}
          order={BASE}
          canSeePrice={false}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('OrderFormDrawer แก้ไข (ST3-T02)', () => {
  it('สถานะล่าสุดจาก GET เป็น PLANNED → ช่องที่แก้ไม่ได้ถูกปิด + ป้ายบอกสถานะใหม่', () => {
    live.data = {
      ...BASE,
      status: 'planned',
      editableFields: ['customerRef', 'stops.window'],
      version: 2,
    } as Order;
    view();
    expect(screen.getByRole('combobox', { name: /ลูกค้า/ })).toBeDisabled();
    expect(screen.getByLabelText(/เลข PO ลูกค้า/)).toBeEnabled();
    expect(screen.getByText(/สถานะ "จัดรถแล้ว"/)).toBeInTheDocument();
  });

  it('ยังแก้ได้ทุกช่อง → ไม่มีป้ายล็อก', () => {
    live.data = BASE;
    view();
    expect(screen.getByRole('combobox', { name: /ลูกค้า/ })).toBeEnabled();
    expect(screen.queryByText(/สถานะ "/)).toBeNull();
  });
});
