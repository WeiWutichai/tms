import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../i18n';
import { ScheduleDialog } from './ScheduleDialog';

const D = '2026-11-20';
const LEAVE = {
  id: 'sch_1',
  kind: 'LEAVE',
  driver: { id: 'drv_1', name: 'สมชาย' },
  vehicle: null,
  startsOn: '2026-11-22',
  endsOn: '2026-11-23',
  note: 'ลาพักร้อน',
  cancelledAt: null,
  cancelReason: null,
  createdAt: '',
  version: 1,
} as const;
const onCancel = vi.fn();
const show = (p: Partial<Parameters<typeof ScheduleDialog>[0]> = {}) => {
  const onOk = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <ScheduleDialog
          kind="LEAVE"
          title="ใส่วันลาคนขับ"
          description="x"
          initial={{ driverId: 'drv_1', startsOn: D, endsOn: D, note: '' }}
          initialDriver={{ id: 'drv_1', label: 'สมชาย' }}
          searchDrivers={async () => [
            { id: 'drv_1', label: 'สมชาย' },
            { id: 'drv_2', label: 'สมหญิง' },
          ]}
          useLeaves={(id) => ({ data: id === 'drv_1' ? [LEAVE] : [] })}
          dayRange={(e) => `${e.startsOn}–${e.endsOn}`}
          onCancelLeave={onCancel}
          onOk={onOk}
          onClose={() => {}}
          {...p}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onOk;
};

describe('ScheduleDialog (ST3-T19)', () => {
  it('วันลา: ค่าเริ่ม = คนขับประจำ + วันของช่อง · บันทึกได้เมื่อมีเหตุผล · ตัดช่องว่าง', () => {
    const onOk = show();
    const save = screen.getByRole('button', { name: 'บันทึก' });
    // วันลาที่มีอยู่ของคนขับที่เลือก + ยกเลิกได้ (QA M1)
    expect(screen.getByTestId('schedule-existing').textContent).toContain('ลาพักร้อน');
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกวันลา' }));
    expect(onCancel).toHaveBeenCalledWith(LEAVE);
    expect((screen.getByLabelText(/ตั้งแต่วันที่/) as HTMLInputElement).value).toBe(D);
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/เหตุผลการลา/), { target: { value: '  ลาป่วย ' } });
    fireEvent.change(screen.getByLabelText(/ถึงวันที่/), { target: { value: '2026-11-21' } });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onOk).toHaveBeenCalledWith({
      driverId: 'drv_1',
      startsOn: D,
      endsOn: '2026-11-21',
      note: 'ลาป่วย',
    });
  });
  it('วันสิ้นสุดก่อนวันเริ่ม / ไม่เลือกคนขับ = บันทึกไม่ได้ · เลื่อนวันเริ่มเลยวันสิ้นสุด = วันสิ้นสุดตาม', () => {
    show({ initial: { driverId: '', startsOn: D, endsOn: D, note: 'ลากิจ' }, initialDriver: null });
    const save = screen.getByRole('button', { name: 'บันทึก' });
    expect(save).toBeDisabled();
    expect(screen.queryByTestId('schedule-existing')).toBeNull();
    fireEvent.change(screen.getByLabelText(/ตั้งแต่วันที่/), { target: { value: '2026-11-25' } });
    expect((screen.getByLabelText(/ถึงวันที่/) as HTMLInputElement).value).toBe('2026-11-25');
    fireEvent.change(screen.getByLabelText(/ถึงวันที่/), { target: { value: '2026-11-24' } });
    expect(save).toBeDisabled();
  });
  it('โน้ต: ไม่มีช่องคนขับ · แสดง error จาก server', () => {
    show({ kind: 'NOTE', error: 'มีวันลาทับอยู่แล้ว', fieldErrors: { endsOn: 'ช่วงยาวเกิน' } });
    expect(screen.queryByPlaceholderText('ค้นหาชื่อคนขับ')).toBeNull();
    expect(screen.getByText('มีวันลาทับอยู่แล้ว')).toBeTruthy();
    expect(screen.getByText('ช่วงยาวเกิน')).toBeTruthy();
  });
});
