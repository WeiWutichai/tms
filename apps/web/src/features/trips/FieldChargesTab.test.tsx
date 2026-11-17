import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { TripDetail } from './useTrips';
import type { FieldCharge } from './useFieldCharges';

/** ST4-T13 แท็บค่าใช้จ่ายหน้างาน: แถวตามต้นแบบ, เพิ่มรายการ (ฝั่ง/รูป), สิทธิ์, ยืนยัน/ปฏิเสธ/ลบด้วยเหตุผล, ยอดรวม */
const state: { lines: FieldCharge[]; scopes: string[]; actorId: string } = {
  lines: [],
  scopes: ['*'],
  actorId: 'usr_me',
};
const create = vi.fn();
const decide = vi.fn();
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({
    data: { scopes: state.scopes, actorId: state.actorId, tenant: { yearStyle: 'BE' } },
  }),
}));
vi.mock('./useFieldCharges', async (orig) => {
  const real = await orig<typeof import('./useFieldCharges')>();
  return {
    ...real,
    useFieldCharges: () => ({ data: state.lines, isError: false, isLoading: false }),
    useFieldChargeItems: () => [
      { id: 'svc_wait', name: 'ค่ารอ', side: 'BOTH', isSurcharge: true, calcUnit: 'PER_HOUR' },
      { id: 'svc_load', name: 'ค่ายกของ', side: 'SELL', isSurcharge: true, calcUnit: 'PER_TRIP' },
    ],
    useCreateFieldCharge: () => ({ mutate: create, isPending: false }),
    useDecideFieldCharge: () => ({ mutate: decide, isPending: false }),
    uploadReceipt: vi.fn(async () => 'doc_1'),
  };
});
const { FieldChargesTab } = await import('./FieldChargesTab');
const { moneyInput, sumMoney, itemAllows } = await import('./useFieldCharges');

const trip = (
  status = 'IN_PROGRESS',
  dos = [{ id: 'do_1', doNo: 'DO-6911-0001', status: 'DISPATCHED' }],
) =>
  ({ id: 'trp_1', tripNo: 'TRP-6911-0001', status, deliveryOrders: dos }) as unknown as TripDetail;

const line = (x: Partial<FieldCharge>): FieldCharge =>
  ({
    id: 'dsc_1',
    side: 'SELL',
    status: 'PENDING_CONFIRM',
    tripId: 'trp_1',
    deliveryOrderId: 'do_1',
    doNo: 'DO-6911-0001',
    serviceItemId: 'svc_wait',
    serviceItemCode: 'WAIT',
    description: 'ค่ารอ',
    unitLabel: 'ชั่วโมง',
    vatType: 'VAT_7',
    whtRate: '3.00',
    qty: '1',
    sellUnitPrice: '500.00',
    sellAmount: '500.00',
    costType: null,
    pairedId: null,
    evidence: {
      id: 'doc_1',
      mime: 'image/png',
      bytes: 10,
      filename: 'r.png',
      downloadUrl: 'http://x/v1/documents/doc_1/content?sig=1',
      urlExpiresAt: '2026-11-17T03:00:00.000Z',
    },
    note: null,
    createdBy: 'usr_1',
    createdByName: 'สมพร หน้าคลัง',
    createdAt: '2026-11-17T02:10:00.000Z',
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionReason: null,
    version: 1,
    ...x,
  }) as FieldCharge;

const onToast = vi.fn();
const show = (tr = trip()) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider lang="th">
        <FieldChargesTab trip={tr} onToast={onToast} />
      </I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  create.mockReset();
  decide.mockReset();
  state.lines = [];
  state.scopes = ['*'];
});

describe('FieldChargesTab (ST4-T13)', () => {
  it('ว่าง: ข้อความต้นแบบ + ปุ่มเพิ่มรายการ + รวม ฿0.00', () => {
    show();
    expect(
      screen.getByText('ยังไม่มีค่าใช้จ่ายหน้างาน เช่น ค่ารอคิว ค่าค้างคืน ค่าทางด่วน'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /เพิ่มรายการ/ })).toBeTruthy();
    expect(screen.getByText('รวมค่าใช้จ่ายหน้างาน')).toBeTruthy();
    expect(screen.getByText('฿0.00')).toBeTruthy();
  });

  it('เพิ่ม "ค่ารอ" 500 บาท ฝั่งเก็บลูกค้า พร้อมรูป → ส่ง body ตาม API (ภาษีไม่ส่ง — API คัดลอกจากรายการ)', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มรายการ/ }));
    const draft = screen.getByTestId('fc-draft');
    // ฝั่ง: เก็บเงินลูกค้า / ต้นทุนเที่ยว / ทั้งสองฝั่ง
    expect(
      within(draft).getByRole('button', { name: 'เก็บเงินลูกค้า' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.change(within(draft).getByLabelText('จำนวนเงิน (บาท)'), { target: { value: '500' } });
    const file = new File(['x'], 'r.png', { type: 'image/png' });
    fireEvent.change(within(draft).getByLabelText('อัปโหลดรูปใบเสร็จ'), {
      target: { files: [file] },
    });
    await screen.findByText('r.png');
    fireEvent.click(within(draft).getByRole('button', { name: /บันทึกรายการ/ }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toEqual({
      side: 'SELL',
      serviceItemId: 'svc_wait',
      deliveryOrderId: 'do_1',
      sellUnitPrice: '500.00',
      evidenceDocumentId: 'doc_1',
    });
  });

  it('ทั้งสองฝั่ง: รายการขายอย่างเดียวไม่อยู่ในตัวเลือก + ช่องต้นทุนแยก · ยอดผิดรูป/ไม่มีรูป → ข้อความเตือน ไม่ส่ง', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มรายการ/ }));
    const draft = screen.getByTestId('fc-draft');
    fireEvent.click(within(draft).getByRole('button', { name: 'ทั้งสองฝั่ง' }));
    const opts = within(within(draft).getByLabelText('รายการ')).getAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(['ค่ารอ']);
    fireEvent.change(within(draft).getByLabelText('จำนวนเงิน (บาท)'), {
      target: { value: '1.234' },
    });
    fireEvent.click(within(draft).getByRole('button', { name: /บันทึกรายการ/ }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('กรอกจำนวนเงินมากกว่า 0');
    fireEvent.change(within(draft).getByLabelText('จำนวนเงิน (บาท)'), {
      target: { value: '1,500' },
    });
    fireEvent.change(within(draft).getAllByLabelText('ต้นทุนตามใบเสร็จ (บาท)')[0]!, {
      target: { value: '1200.5' },
    });
    fireEvent.click(within(draft).getByRole('button', { name: /บันทึกรายการ/ }));
    // ยังไม่แนบรูป → ไม่ส่ง (รูปบังคับ)
    fireEvent.click(within(draft).getByRole('button', { name: /บันทึกรายการ/ }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('แนบรูปใบเสร็จก่อนบันทึก');
    fireEvent.change(within(draft).getByLabelText('อัปโหลดรูปใบเสร็จ'), {
      target: { files: [new File(['x'], 'r.png', { type: 'image/png' })] },
    });
    await screen.findByText('r.png');
    fireEvent.click(within(draft).getByRole('button', { name: /บันทึกรายการ/ }));
    expect(create.mock.calls[0]![0]).toEqual({
      side: 'BOTH',
      serviceItemId: 'svc_wait',
      deliveryOrderId: 'do_1',
      sellUnitPrice: '1500.00',
      costAmount: '1200.50',
      evidenceDocumentId: 'doc_1',
    });
  });

  it('สิทธิ์: ไม่มีสิทธิ์แก้ราคา → ไม่มีปุ่มเพิ่ม · เที่ยวยังไม่ปล่อย → ไม่มีปุ่ม + ข้อความ', () => {
    state.scopes = ['trips:read', 'prices.buy:read'];
    const { unmount } = show();
    expect(screen.queryByRole('button', { name: /เพิ่มรายการ/ })).toBeNull();
    unmount();
    state.scopes = ['*'];
    show(trip('PLANNING'));
    expect(screen.queryByRole('button', { name: /เพิ่มรายการ/ })).toBeNull();
    expect(screen.getByText('บันทึกค่าใช้จ่ายหน้างานได้หลังปล่อยเที่ยว')).toBeTruthy();
  });

  it('แถวที่บันทึกแล้ว: ป้ายรอยืนยัน, DO, ดูใบเสร็จ, ยืนยัน/ปฏิเสธ (ผู้วางบิล) ผ่าน dialog เหตุผล', () => {
    state.lines = [
      line({}),
      line({
        id: 'tco_1',
        side: 'BUY',
        status: 'REJECTED',
        description: 'ค่าทางด่วน',
        sellAmount: undefined,
        sellUnitPrice: undefined,
        buyAmount: '180.00',
        doNo: null,
        evidence: null,
        decidedByName: 'วิภา วางบิล',
        decidedAt: '2026-11-17T03:00:00.000Z',
        decisionReason: 'ไม่มีใบเสร็จแนบมา',
      }),
    ];
    show();
    const rows = screen.getAllByTestId('fc-line');
    expect(within(rows[0]!).getByText('รอยืนยัน')).toBeTruthy();
    expect(within(rows[0]!).getByText('เก็บเงินลูกค้า · DO-6911-0001')).toBeTruthy();
    expect(
      within(rows[0]!)
        .getByRole('link', { name: /ดูใบเสร็จ/ })
        .getAttribute('href'),
    ).toContain('/v1/documents/doc_1/content');
    expect((within(rows[0]!).getByLabelText('จำนวนเงิน (บาท)') as HTMLInputElement).value).toBe(
      '500.00',
    );
    expect(within(rows[1]!).getByText('ปฏิเสธ')).toBeTruthy();
    expect(within(rows[1]!).getByText(/ไม่มีใบเสร็จแนบมา/)).toBeTruthy();
    // รวม: เฉพาะที่รอ/ยืนยัน (บรรทัดที่ปฏิเสธไม่นับ)
    expect(screen.getByText('฿500.00')).toBeTruthy();
    expect(screen.queryByText('รวมต้นทุนหน้างาน (จ่ายรถร่วม/คนขับ)')).toBeNull();

    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'ยืนยัน' }));
    const dlg = screen.getByRole('dialog');
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'ตรวจใบเสร็จแล้วถูกต้อง' },
    });
    fireEvent.click(within(dlg).getAllByRole('button', { name: 'ยืนยัน' }).at(-1)!);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toMatchObject({
      action: 'confirm',
      reason: 'ตรวจใบเสร็จแล้วถูกต้อง',
      line: { id: 'dsc_1', version: 1 },
    });
  });

  it('ผู้ไม่มีสิทธิ์วางบิล/ดูราคาขาย: ไม่มีปุ่มยืนยัน และยอดขายแสดง "—"', () => {
    state.scopes = ['trips:read', 'prices.buy:read', 'prices.buy:write'];
    state.lines = [line({ sellAmount: undefined, sellUnitPrice: undefined })];
    show();
    const row = screen.getByTestId('fc-line');
    expect(within(row).queryByRole('button', { name: 'ยืนยัน' })).toBeNull();
    expect((within(row).getByLabelText('จำนวนเงิน (บาท)') as HTMLInputElement).value).toBe('—');
    // ลบ (ยกเลิก) ฝั่งขายต้องมีสิทธิ์แก้ราคาขาย
    expect(within(row).queryByRole('button', { name: 'ลบ' })).toBeNull();
  });

  it('maker-checker: บรรทัดที่ตัวเองบันทึก → ปุ่มยืนยัน/ปฏิเสธปิด + tooltip · ผู้จ่ายงานเพิ่มฝั่งซื้อได้ ไม่มีฝั่งขาย · ยืนยันฝั่งซื้อต้อง settlements:approve', () => {
    state.lines = [line({ createdBy: 'usr_me' })];
    const { unmount } = show();
    const row = screen.getByTestId('fc-line');
    expect(
      (within(row).getByRole('button', { name: 'ยืนยัน' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(row.querySelector('[title="รายการที่คุณบันทึกเอง ต้องให้ผู้อื่นยืนยัน"]')).toBeTruthy();
    unmount();
    state.scopes = ['trips:read', 'trips:dispatch', 'prices.buy:read', 'invoices:draft'];
    state.lines = [line({ id: 'tco_1', side: 'BUY', buyAmount: '180.00', createdBy: 'usr_x' })];
    show();
    // ยืนยันฝั่งซื้อไม่มี (ไม่มี settlements:approve)
    expect(
      within(screen.getByTestId('fc-line')).queryByRole('button', { name: 'ยืนยัน' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มรายการ/ }));
    const draft = screen.getByTestId('fc-draft');
    // มีฝั่งเดียว (ต้นทุนเที่ยว) → ไม่มีตัวเลือกฝั่ง
    expect(within(draft).queryByRole('button', { name: 'เก็บเงินลูกค้า' })).toBeNull();
    expect(within(draft).getByLabelText('ต้นทุนตามใบเสร็จ (บาท)')).toBeTruthy();
  });

  it('ตัวช่วยเงิน: แปลงข้อความ → สตริง 2 ตำแหน่ง, รวมแบบสตางค์, ฝั่งของรายการ', () => {
    expect(moneyInput('1,234.5')).toBe('1234.50');
    expect(moneyInput('007')).toBe('7.00');
    expect(moneyInput('-1')).toBeNull();
    expect(moneyInput('1.234')).toBeNull();
    expect(sumMoney(['0.10', '0.20', null, '1000.05'])).toBe('1,000.35');
    expect(itemAllows({ side: 'SELL' }, 'BOTH')).toBe(false);
    expect(itemAllows({ side: 'BOTH' }, 'BUY')).toBe(true);
    expect(itemAllows({ side: 'BUY' }, 'BUY')).toBe(true);
  });
});
