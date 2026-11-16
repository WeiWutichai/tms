import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ScheduleDialog } from './ScheduleDialog';

const D = '2026-11-20';
const show = (p: Partial<Parameters<typeof ScheduleDialog>[0]> = {}) => {
  const onOk = vi.fn();
  render(
    <I18nProvider>
      <ScheduleDialog
        kind="LEAVE"
        title="ใส่วันลาคนขับ"
        description="x"
        initial={{ driverId: 'drv_1', startsOn: D, endsOn: D, note: '' }}
        drivers={[
          { id: 'drv_1', name: 'สมชาย' },
          { id: 'drv_2', name: 'สมหญิง' },
        ]}
        onOk={onOk}
        onClose={() => {}}
        {...p}
      />
    </I18nProvider>,
  );
  return onOk;
};

describe('ScheduleDialog (ST3-T19)', () => {
  it('วันลา: ค่าเริ่ม = คนขับประจำ + วันของช่อง · บันทึกได้เมื่อมีเหตุผล · ตัดช่องว่าง', () => {
    const onOk = show();
    const save = screen.getByRole('button', { name: 'บันทึก' });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('drv_1');
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
    show({ initial: { driverId: '', startsOn: D, endsOn: D, note: 'ลากิจ' } });
    const save = screen.getByRole('button', { name: 'บันทึก' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'drv_2' } });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/ตั้งแต่วันที่/), { target: { value: '2026-11-25' } });
    expect((screen.getByLabelText(/ถึงวันที่/) as HTMLInputElement).value).toBe('2026-11-25');
    fireEvent.change(screen.getByLabelText(/ถึงวันที่/), { target: { value: '2026-11-24' } });
    expect(save).toBeDisabled();
  });
  it('โน้ต: ไม่มีช่องคนขับ · แสดง error จาก server', () => {
    show({ kind: 'NOTE', error: 'มีวันลาทับอยู่แล้ว', fieldErrors: { endsOn: 'ช่วงยาวเกิน' } });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('มีวันลาทับอยู่แล้ว')).toBeTruthy();
    expect(screen.getByText('ช่วงยาวเกิน')).toBeTruthy();
  });
});
