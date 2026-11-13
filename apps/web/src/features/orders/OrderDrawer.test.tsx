import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { Order } from './orderForm';

/**
 * ST3-T10: drawer SO — ต้นทางแก้หลังวางแผน (ตารางเทียบ + รับค่าต้นทาง/ใช้ค่า TMS พร้อมเหตุผล) และเมนู "ยกเลิกเอกสาร"
 */
const live: { data: Order | undefined } = { data: undefined };
const cancelMutate = vi.fn();
const decideMutate = vi.fn();
vi.mock('./useOrders', () => ({
  useOrder: () => live,
  useUpdateOrder: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useCancelOrder: () => ({ mutate: cancelMutate, isPending: false, error: null, reset: vi.fn() }),
  useDecideSourceChange: () => ({
    mutate: decideMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
  useVehicleTypeOptions: () => ({ data: { data: [{ id: 'vty_1', name: '6 ล้อ' }] } }),
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' } } }),
}));

const { OrderDrawer } = await import('./OrderDrawer');

const BASE = {
  id: 'ord_1',
  soNo: 'SO-6911-0001',
  status: 'planned',
  source: 'ERP:krs',
  sourceType: 'CONNECTOR',
  connector: 'krs',
  externalId: 'KRS-1',
  customer: {
    id: 'cus_1',
    code: 'CUS-0001',
    legalName: 'บจก. ตัวอย่าง',
    externalId: null,
    name: null,
  },
  billingCompanyId: 'cmp_1',
  customerRef: null,
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
      siteText: 'คลังบางนา',
      windowStart: null,
      windowEnd: null,
    },
    {
      sequence: 2,
      type: 'DELIVERY',
      siteId: 'loc_b',
      siteText: 'คลังเดิม',
      windowStart: null,
      windowEnd: null,
    },
  ],
  lines: [],
  editableFields: ['customerRef', 'stops.window'],
  sourceChangedAfterPlan: true,
  sourceChange: {
    id: 'osc_1',
    status: 'PENDING',
    source: 'ERP:krs',
    orderStatus: 'planned',
    receivedAt: '2026-11-13T03:00:00.000Z',
    changes: [
      {
        group: 'stops',
        field: 'stops[1].siteId',
        before: 'คลังเดิม',
        after: 'คลังลาดกระบัง',
        kind: 'text',
      },
      { group: 'lines', field: 'lines[0].weightKg', before: '10000', after: '12500', kind: 'text' },
      {
        group: 'stops.window',
        field: 'stops[1].windowEnd',
        before: null,
        after: '2026-11-13T09:00:00.000Z',
        kind: 'datetime',
      },
    ],
  },
  version: 3,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-13T03:00:00.000Z',
} as unknown as Order;

const view = (p: { canWrite?: boolean; canCancel?: boolean } = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider lang="th">
        <OrderDrawer
          id="ord_1"
          canWrite={p.canWrite ?? true}
          canCancel={p.canCancel ?? true}
          canSeePrice={false}
          onClose={() => {}}
          onEdit={() => {}}
          onCopy={() => {}}
          onSaveTemplate={() => {}}
          onDone={() => {}}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('OrderDrawer (ST3-T10)', () => {
  beforeEach(() => {
    cancelMutate.mockReset();
    decideMutate.mockReset();
  });

  it('ต้นทางแก้หลังวางแผน: ป้าย + ตารางเทียบ TMS กับ KRS (ชื่อช่องไทย, เวลาไทย) + ปุ่มรับ/ใช้ค่า TMS', () => {
    live.data = BASE;
    view();
    expect(screen.getAllByText('ต้นทางแก้หลังวางแผน').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert')).toHaveTextContent(/ระบบยังไม่เขียนทับ/);
    expect(screen.getByText('เทียบข้อมูล TMS กับ KRS')).toBeInTheDocument();
    expect(screen.getByText('ต่าง 3 ฟิลด์')).toBeInTheDocument();
    expect(screen.getByText('12,500')).toBeInTheDocument();
    expect(screen.getByText('10,000')).toBeInTheDocument();
    expect(screen.getByText('จุดที่ 2 · สถานที่')).toBeInTheDocument();
    expect(screen.getByText('คลังลาดกระบัง')).toBeInTheDocument();
    expect(screen.getByText(/16:00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'รับค่า KRS' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ใช้ค่า TMS/ })).toBeInTheDocument();
  });

  it('ใช้ค่า TMS → dialog มีตารางเทียบ + เหตุผล ≥ 10 ตัวอักษร → ส่ง reject', () => {
    live.data = BASE;
    view();
    fireEvent.click(screen.getByRole('button', { name: /ใช้ค่า TMS/ }));
    const dlg = screen.getByRole('dialog', { name: 'ใช้ค่า TMS · SO-6911-0001' });
    expect(within(dlg).getAllByRole('row')).toHaveLength(4);
    // ใช้ค่า TMS: ค่าต้นทาง (ขวา) ถูกขีดฆ่า
    expect(within(dlg).getByRole('cell', { name: 'คลังลาดกระบัง' })).toHaveClass(
      'tms-dialog__diffb',
    );
    expect(within(dlg).getByRole('cell', { name: 'คลังเดิม' })).toHaveClass('tms-dialog__diffa');
    const ok = within(dlg)
      .getAllByRole('button', { name: /ใช้ค่า TMS/ })
      .at(-1)!;
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: 'สั้น' } });
    expect(ok).toBeDisabled();
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'ลูกค้ายืนยันใช้ปลายทางเดิม' },
    });
    fireEvent.click(ok);
    expect(decideMutate).toHaveBeenCalledWith(
      {
        id: 'ord_1',
        version: 3,
        changeId: 'osc_1',
        accept: false,
        reason: 'ลูกค้ายืนยันใช้ปลายทางเดิม',
      },
      expect.anything(),
    );
  });

  it('เมนู ⋯ ยกเลิกเอกสาร (สิทธิ์ orders:cancel) → dialog สถานะ เดิม → ยกเลิก + If-Match version', () => {
    live.data = { ...BASE, sourceChangedAfterPlan: false, sourceChange: null } as Order;
    view();
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มเติม' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /ยกเลิกเอกสาร/ }));
    const dlg = screen.getByRole('dialog', { name: 'ยกเลิก SO-6911-0001' });
    expect(within(dlg).getByText('กรอกอย่างน้อย 10 ตัวอักษร (0/10)')).toBeInTheDocument();
    expect(within(dlg).getByText('จัดรถแล้ว')).toBeInTheDocument();
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'ลูกค้ายกเลิกคำสั่งทางอีเมล' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'ยืนยันยกเลิก' }));
    expect(cancelMutate).toHaveBeenCalledWith(
      { id: 'ord_1', version: 3, reason: 'ลูกค้ายกเลิกคำสั่งทางอีเมล' },
      expect.anything(),
    );
  });

  it('ไม่มีสิทธิ์ / สถานะยกเลิกไม่ได้ → ไม่มีเมนูยกเลิก · ไม่มีสิทธิ์เขียน → ไม่มีปุ่มรับ/ไม่รับ', () => {
    live.data = { ...BASE, status: 'in_transit' } as Order;
    view({ canWrite: false });
    expect(screen.queryByRole('button', { name: 'รับค่า KRS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'เพิ่มเติม' })).toBeNull();
  });

  it('ใบออกรถแล้ว: ไม่มีปุ่มรับค่าต้นทาง (ไม่รับได้อย่างเดียว)', () => {
    live.data = { ...BASE, status: 'in_transit' } as Order;
    view();
    expect(screen.queryByRole('button', { name: 'รับค่า KRS' })).toBeNull();
    expect(screen.getByRole('button', { name: /ใช้ค่า TMS/ })).toBeInTheDocument();
  });
});
