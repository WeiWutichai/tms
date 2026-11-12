import { fireEvent, render, screen } from '@testing-library/react';
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
});
