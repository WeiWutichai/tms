import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { DeliveryOrder } from './returnForm';
import type { DoPod } from './usePod';

/** ST4-T11 dialog "ตีกลับบางส่วน" (ต้นแบบ TMS v4 vRt) */
const mutate = vi.fn();
vi.mock('./useReturn', () => ({ useResolveRejection: () => ({ mutate, isPending: false }) }));
vi.mock('../settings/useReasonCodes', () => ({
  useReasonCodes: () => ({
    data: [
      {
        id: 'rsn_s',
        category: 'REJECTED_BY_RECEIVER',
        label: 'จำนวนไม่ครบ',
        status: 'active',
        requiresPhoto: true,
        requiresNote: false,
      },
      {
        id: 'rsn_p',
        category: 'REJECTED_BY_RECEIVER',
        label: 'ลูกค้าปฏิเสธรับบางรายการ',
        status: 'active',
        requiresPhoto: false,
        requiresNote: true,
      },
      {
        id: 'rsn_f',
        category: 'DELIVERY_FAILED',
        label: 'ลูกค้าขอเลื่อนรับสินค้า',
        status: 'active',
        requiresPhoto: false,
        requiresNote: false,
      },
    ],
  }),
}));
const { ReturnDialog } = await import('./ReturnDialog');

const d = (status = 'UNBILLED') =>
  ({
    id: 'do_1',
    doNo: 'DO-6911-0001',
    status,
    version: 4,
    lines: [
      {
        lineNo: 1,
        description: 'ปูนซีเมนต์',
        qtyPlanned: '20',
        rejectQty: '10',
        rejectReasonCodeId: 'rsn_s',
        redeliveredQty: '0',
        returnedQty: '0',
        openRejectQty: '10',
      },
      {
        lineNo: 2,
        description: 'เหล็กเส้น',
        qtyPlanned: '5',
        rejectQty: null,
        rejectReasonCodeId: null,
        redeliveredQty: '0',
        returnedQty: '0',
        openRejectQty: '0',
      },
    ],
  }) as unknown as DeliveryOrder;
const pod = (photos = 1) =>
  ({
    lines: [
      { lineNo: 1, unit: 'ตัน' },
      { lineNo: 2, unit: 'ตัน' },
    ],
    current: { photos: Array.from({ length: photos }, (_, i) => ({ id: `doc_${i}` })) },
  }) as unknown as DoPod;

const show = (dd: DeliveryOrder, p: DoPod, mode: 'rejected' | 'failed' = 'rejected') => {
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <ReturnDialog d={dd} pod={p} mode={mode} onClose={vi.fn()} onDone={onDone} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onDone;
};

describe('ReturnDialog (ST4-T11)', () => {
  beforeEach(() => mutate.mockReset());

  it('หัว/รายการตามต้นแบบ: เฉพาะบรรทัดที่ปฏิเสธคงเหลือ · ต้องติ๊กก่อนบันทึก · ส่งซ้ำ = If-Match + บรรทัด/จำนวนคงเหลือ', () => {
    const onDone = show(d(), pod());
    expect(screen.getByRole('heading').textContent).toBe('ตีกลับบางส่วน DO-6911-0001');
    expect(screen.getByText('ปูนซีเมนต์')).toBeTruthy();
    expect(screen.queryByText('เหล็กเส้น')).toBeNull();
    expect(screen.getByText('10 ตัน')).toBeTruthy();
    expect(screen.getByTestId('rt-hint').textContent).toBe(
      'เลือกรายการอย่างน้อย 1 รายการ · แนบรูป',
    );
    fireEvent.click(screen.getByText('บันทึกตีกลับ'));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByTestId('rt-hint').textContent).toContain('จะสร้างใบส่งของใหม่ 1 รายการ');
    fireEvent.click(screen.getByText('บันทึกตีกลับ'));
    expect(mutate.mock.calls[0]![0]).toEqual({
      id: 'do_1',
      version: 4,
      action: 'redeliver',
      body: { reasonCodeId: 'rsn_s', note: null, lines: [{ lineNo: 1, qty: '10' }] },
    });
    mutate.mock.calls[0]![1].onSuccess({ source: {}, redelivery: { doNo: 'DO-6911-0002' } });
    expect(onDone).toHaveBeenCalledWith(
      'สร้างใบส่งของ DO-6911-0002 (ส่งซ้ำของ DO-6911-0001) แล้ว — รอจัดรถ',
    );
  });

  it('คืนคลัง + เหตุผลบังคับโน้ต · เหตุผลบังคับรูปแต่ไม่มีรูปหลักฐาน → บันทึกไม่ได้', () => {
    show(d(), pod(0));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('ยังไม่มีรูปในหลักฐานส่ง — แนบรูปในฟอร์มหลักฐานส่งก่อน')).toBeTruthy();
    fireEvent.click(screen.getByText('บันทึกตีกลับ'));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'rsn_p' } });
    expect(screen.getByText('โน้ต (บังคับ)')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('คืนคลัง — ไม่ส่งซ้ำ'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'กล่องบุบ 3 กล่อง' } });
    fireEvent.click(screen.getByText('บันทึกตีกลับ'));
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      action: 'return',
      body: { reasonCodeId: 'rsn_p', note: 'กล่องบุบ 3 กล่อง', lines: [{ lineNo: 1, qty: '10' }] },
    });
  });

  it('ส่งไม่สำเร็จ: หัว "ส่งไม่สำเร็จ" ทั้งใบติ๊กแก้ไม่ได้ · เหตุผลหมวดส่งไม่สำเร็จ · ไม่ส่ง lines', () => {
    show(d('FAILED'), pod(0), 'failed');
    expect(screen.getByRole('heading').textContent).toBe('ส่งไม่สำเร็จ DO-6911-0001');
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [true, true],
    ]);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('rsn_f');
    fireEvent.click(screen.getByText('บันทึกตีกลับ'));
    expect(mutate.mock.calls[0]![0].body).toEqual({ reasonCodeId: 'rsn_f', note: null });
  });
});
