import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../../i18n';
import type { Order } from './orderForm';

/**
 * ST3-T10: drawer SO — ต้นทางแก้หลังวางแผน (ตารางเทียบ + รับค่าต้นทาง/ใช้ค่า TMS พร้อมเหตุผล) และเมนู "ยกเลิกเอกสาร"
 */
const live: { data: Order | undefined } = { data: undefined };
const cancelMutate = vi.fn();
const decideMutate = vi.fn();
const recheckMutate = vi.fn();
const priceMutate = vi.fn();
const mut = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(() => new Promise(() => {})),
  isPending: false,
  error: null,
  reset: vi.fn(),
});
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
  useForceUnlock: () => mut(),
  // หน้าใบค้าง (ST3-T07)
  useMapCustomer: () => mut(),
  useMapSite: () => mut(),
  useReevaluate: () => ({ ...mut(), mutateAsync: recheckMutate }),
  useResolveSourceError: () => mut(),
  useManualPrice: () => ({ ...mut(), mutateAsync: priceMutate }),
  searchCustomers: async () => [],
  searchStopSites: async () => [],
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

const view = (
  p: {
    canWrite?: boolean;
    canCancel?: boolean;
    canSeePrice?: boolean;
    canEditPrice?: boolean;
  } = {},
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <I18nProvider lang="th">
          <OrderDrawer
            id="ord_1"
            canWrite={p.canWrite ?? true}
            canCancel={p.canCancel ?? true}
            canSeePrice={p.canSeePrice ?? false}
            canEditPrice={p.canEditPrice ?? false}
            onClose={() => {}}
            onEdit={() => {}}
            onCopy={() => {}}
            onSaveTemplate={() => {}}
            onDone={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('OrderDrawer (ST3-T10)', () => {
  beforeEach(() => {
    cancelMutate.mockReset();
    decideMutate.mockReset();
    recheckMutate.mockReset();
    priceMutate.mockReset().mockReturnValue(new Promise(() => {}));
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

  // ---------- หน้าใบค้าง (ST3-T07) ----------

  /** ใบค้าง RATE_MISSING ก่อนวางแผน (แก้ได้ทุกช่อง) */
  const RATE_HELD = {
    ...BASE,
    status: 'on_hold',
    holdReason: {
      code: 'RATE_MISSING',
      label: 'ไม่มีเรท',
      note: 'ยังไม่มีราคาขาย',
      field: 'pricing',
      fields: ['pricing'],
    },
    holdCodes: ['RATE_MISSING'],
    pricingStatus: 'RATE_MISSING',
    sellCharges: [],
    sellTotal: null,
    stops: BASE.stops.map((x) => ({ ...x, match: { method: null, score: null, candidates: [] } })),
    customer: { ...BASE.customer, match: { method: 'INPUT', candidates: [] } },
    sourceChangedAfterPlan: false,
    sourceChange: null,
    editLock: null,
    editableFields: [
      'customer',
      'billingCompanyId',
      'customerRef',
      'requestedDate',
      'vehicleTypeId',
      'stops',
      'stops.window',
      'lines',
      'sourceIssues',
    ],
  } as unknown as Order;

  it('RATE_MISSING: แถวเตือนตามต้นแบบ + "กำหนดราคาเอง" → ช่องราคา → dialog เหตุผล (ตารางเทียบ) → ส่ง manual-price · ไม่มีปุ่มเปิดหน้า Rate card', () => {
    live.data = RATE_HELD;
    view({ canSeePrice: true, canEditPrice: true });
    expect(screen.getByText('ไม่พบ rate card ของลูกค้านี้สำหรับเส้นทางนี้')).toBeInTheDocument();
    expect(screen.queryByText(/เปิดหน้า Rate card/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'กำหนดราคาเอง' }));
    expect(screen.getByText('ค่าขนส่ง (กำหนดเอง)')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'ค่าขนส่ง (บาท)' });
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกราคา' }));
    expect(screen.getByText('กรอกจำนวนเงินมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /กำหนดราคาเอง SO/ })).toBeNull();
    fireEvent.change(input, { target: { value: '4,200.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกราคา' }));
    const dlg = screen.getByRole('dialog', { name: 'กำหนดราคาเอง SO-6911-0001' });
    expect(within(dlg).getByRole('cell', { name: '4,200.50' })).toBeInTheDocument();
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'ลูกค้ารายใหม่ ตกลงราคาทางโทรศัพท์' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'บันทึกราคา' }));
    expect(priceMutate).toHaveBeenCalledWith({
      id: 'ord_1',
      version: 3,
      sellAmount: '4200.50',
      reason: 'ลูกค้ารายใหม่ ตกลงราคาทางโทรศัพท์',
    });
  });

  it('ไม่มีสิทธิ์แก้ราคาขาย (prices.sell:write) → เห็นแถวเตือนแต่ไม่มีปุ่มกำหนดราคาเอง · บรรทัด MANUAL แสดง "ค่าขนส่ง (กำหนดเอง)"', () => {
    live.data = RATE_HELD;
    view({ canSeePrice: true, canEditPrice: false });
    expect(screen.getByText('ไม่พบ rate card ของลูกค้านี้สำหรับเส้นทางนี้')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'กำหนดราคาเอง' })).toBeNull();
    expect(screen.getByRole('button', { name: /ตรวจอีกครั้ง/ })).toBeInTheDocument();
  });

  it('บรรทัดค่าขนส่ง MANUAL → ป้าย "ค่าขนส่ง (กำหนดเอง)" ไม่มีแถวเตือน', () => {
    live.data = {
      ...RATE_HELD,
      status: 'received',
      holdReason: null,
      holdCodes: [],
      sellTotal: '4200.00',
      sellCharges: [
        {
          lineNo: 1,
          kind: 'FREIGHT',
          origin: 'MANUAL',
          description: 'ค่าขนส่ง',
          sellAmount: '4200.00',
          rateCardCode: null,
          rateCardRevision: null,
        },
      ],
    } as unknown as Order;
    view({ canSeePrice: true, canEditPrice: true });
    expect(screen.getByText('ค่าขนส่ง (กำหนดเอง)')).toBeInTheDocument();
    expect(screen.queryByText('ไม่พบ rate card ของลูกค้านี้สำหรับเส้นทางนี้')).toBeNull();
  });

  it('ผู้อื่นเปิดแก้อยู่ (ST3-T08) → ไม่มีปุ่มเคลียร์ใบค้าง (ตรวจอีกครั้ง / กำหนดราคาเอง / ยืนยันข้อมูลถูกต้อง)', () => {
    const lock = {
      userId: 'usr_2',
      userName: 'สมชาย ใจดี',
      acquiredAt: '2026-11-13T02:00:00.000Z',
      lastSeenAt: '2026-11-13T02:00:00.000Z',
      expiresAt: '2026-11-13T02:10:00.000Z',
      mine: false,
    };
    live.data = { ...RATE_HELD, editLock: lock } as unknown as Order;
    view({ canSeePrice: true, canEditPrice: true });
    expect(screen.getByText(/กำลังแก้ไขโดย/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ตรวจอีกครั้ง/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'กำหนดราคาเอง' })).toBeNull();
    live.data = {
      ...RATE_HELD,
      editLock: lock,
      holdReason: {
        code: 'SOURCE_ERROR',
        label: 'ข้อมูลต้นทางผิด',
        note: null,
        field: 'source',
        fields: ['source'],
      },
    } as unknown as Order;
    view({ canSeePrice: true, canEditPrice: true });
    expect(screen.queryByRole('button', { name: /ยืนยันข้อมูลถูกต้อง/ })).toBeNull();
  });

  it('ST4-T10 ลูกค้าวางบิลตามยอดส่งจริง: แถวค่าขนส่งตามส่งจริง + ยอดวางบิล · ยังไม่บันทึก = ข้อความรอ · ราคากำหนดเองไม่เปลี่ยน', () => {
    const charge = {
      lineNo: 1,
      kind: 'FREIGHT',
      origin: 'RATE_CARD',
      description: 'ค่าขนส่ง',
      sellAmount: '8750.00',
      rateCardCode: 'RC-S-0001',
      rateCardRevision: 1,
    };
    const billing = (over: object) => ({
      preview: true,
      basis: 'ACTUAL',
      status: 'ACTUAL',
      actualRecorded: true,
      sellPlannedTotal: '8750.00',
      sellBillableTotal: '7875.00',
      reasons: [],
      charges: [
        {
          lineNo: 1,
          kind: 'FREIGHT',
          origin: 'RATE_CARD',
          description: 'ค่าขนส่ง',
          qtyPlanned: '25',
          qty: '22.5',
          qtyExact: '22.5',
          sellUnitPrice: '350.00',
          sellPlannedAmount: '8750.00',
          sellAmount: '7875.00',
          minChargeApplied: false,
          vatType: 'EXEMPT_TRANSPORT',
          whtRate: '1.00',
          adjusted: true,
          note: null,
          qtyUnit: 'ตัน',
        },
      ],
      ...over,
    });
    live.data = {
      ...BASE,
      sourceChange: null,
      sellTotal: '8750.00',
      sellCharges: [charge],
      sellBilling: billing({}),
    } as unknown as Order;
    view({ canSeePrice: true });
    const box = screen.getByTestId('bill-actual');
    expect(within(box).getByText('ตามส่งจริง 22.5 ตัน (ใบสั่ง 25 ตัน)')).toBeInTheDocument();
    expect(
      within(box).getByText('ยอดประมาณตามยอดส่งจริง (ยังไม่ใช้ออกใบแจ้งหนี้)'),
    ).toBeInTheDocument();
    expect(within(box).getAllByText('7,875.00')).toHaveLength(2);
    expect(screen.getByText('ยอดรวมตามใบสั่ง (ก่อน VAT)')).toBeInTheDocument();

    live.data = {
      ...BASE,
      sourceChange: null,
      sellCharges: [charge],
      sellBilling: billing({ status: 'NOT_RECORDED', actualRecorded: false }),
    } as unknown as Order;
    view({ canSeePrice: true });
    expect(
      screen.getByText('ลูกค้าวางบิลตามยอดส่งจริง — ยังไม่มียอดส่งจริง ใช้ยอดตามใบสั่ง'),
    ).toBeInTheDocument();
  });

  it('ST4-T10 QA L1: ปฏิเสธรับทั้งหมด → ข้อความรอกติกา (ไม่ชี้ไปกำหนดราคาเอง)', () => {
    live.data = {
      ...BASE,
      sourceChange: null,
      sellCharges: [],
      sellBilling: {
        preview: true,
        basis: 'ACTUAL',
        status: 'CALCULATION_FAILURE',
        actualRecorded: true,
        sellPlannedTotal: '8750.00',
        sellBillableTotal: null,
        reasons: [{ code: 'QUANTITY_INVALID', message: 'จำนวนสินค้าไม่ถูกต้อง' }],
        charges: [],
      },
    } as unknown as Order;
    view({ canSeePrice: true });
    expect(screen.getByText('ปฏิเสธรับทั้งหมด — รอกำหนดกติกา (OPEN)')).toBeInTheDocument();
    expect(screen.queryByText(/กำหนดราคาเอง/)).toBeNull();
  });
});
