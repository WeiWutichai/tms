import { fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ReasonDialog } from './master';

describe('ReasonDialog', () => {
  const props = {
    open: true,
    title: 'ลบ',
    label: 'เหตุผล',
    okLabel: 'ยืนยัน',
    cancelLabel: 'ยกเลิก',
    closeLabel: 'ปิด',
  };

  it('ดับเบิลคลิกยืนยันส่งคำขอครั้งเดียว (review ST2-T12)', () => {
    const onOk = vi.fn();
    render(<ReasonDialog {...props} onOk={onOk} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'เหตุผลยาวพอสมควร' } });
    const btn = screen.getByRole('button', { name: 'ยืนยัน' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it('error จาก server ปลดล็อกให้กดใหม่ได้', () => {
    const onOk = vi.fn();
    const { rerender } = render(<ReasonDialog {...props} onOk={onOk} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'เหตุผลยาวพอสมควร' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน' }));
    rerender(<ReasonDialog {...props} error="ผิดพลาด" onOk={onOk} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน' }));
    expect(onOk).toHaveBeenCalledTimes(2);
  });

  it('เปิดใหม่: ภาพแรกไม่มีเหตุผลเก่าค้าง · render ซ้ำระหว่างเปิด (refetch) ไม่ล้างสิ่งที่พิมพ์', () => {
    // ค่าใน textarea ตอน commit (ก่อน useEffect) — เดิมล้างใน effect: เปิดครั้งที่ 2 เห็นเหตุผลเก่าแล้วค่อยล้าง
    // สิ่งที่ผู้ใช้/Playwright พิมพ์ในช่วงนั้นหายไป (E2E carrier-upload ยกเลิกลิงก์ที่ 2)
    const painted: string[] = [];
    function Host({ open, n }: { open: boolean; n: number }) {
      useLayoutEffect(() => {
        if (open) painted.push(document.querySelector('textarea')?.value ?? '-');
      }, [open]);
      return (
        <ReasonDialog {...props} title={`ลบ ${n}`} open={open} onOk={() => {}} onClose={() => {}} />
      );
    }
    const { rerender } = render(<Host open n={1} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'เหตุผลรอบแรกยาวพอ' } });
    rerender(<Host open={false} n={1} />);
    rerender(<Host open n={2} />);
    expect(painted).toEqual(['', '']);
    expect(screen.getByRole('textbox')).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'เหตุผลรอบสองยาวพอ' } });
    rerender(<Host open n={3} />);
    expect(screen.getByRole('textbox')).toHaveValue('เหตุผลรอบสองยาวพอ');
    expect(screen.getByRole('button', { name: 'ยืนยัน' })).toBeEnabled();
  });
});
