import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RefPicker } from './RefPicker';

/**
 * ช่องเลือกข้อมูลหลัก: รายการเปิดเมื่อผู้ใช้สั่ง (คลิก / พิมพ์ / ↓) ไม่เปิดตอน focus — FormDrawer ย้าย focus มาช่องที่ผิด
 * หลังบันทึก (ST9-T20) แล้วรายการต้องไม่ลอยทับข้อความ/ปุ่มใต้ช่อง (เช่น "เปิดใช้เส้นทางเดิม" — E2E routes.spec)
 */
function setup() {
  const search = vi.fn(async () => [{ id: 'loc_1', label: 'คลังบางนา' }]);
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RefPicker
        id="p"
        queryKey="t"
        value={{ id: 'loc_0', label: 'จุดเดิม' }}
        onChange={onChange}
        search={search}
        placeholder="— เลือก —"
        noResult="ไม่พบ"
      />
    </QueryClientProvider>,
  );
  return { input: screen.getByRole('combobox'), onChange };
}

describe('RefPicker', () => {
  it('focus จากโปรแกรม (focus ช่องที่ผิด) → ไม่เปิดรายการ ค่าเดิมยังแสดง', () => {
    const { input } = setup();
    act(() => input.focus());
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('จุดเดิม');
  });

  it('คลิก / ↓ / เริ่มพิมพ์ → เปิดรายการ (ล้างข้อความเพื่อค้น)', () => {
    const { input } = setup();
    fireEvent.click(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveValue('');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'ก' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveValue('');
  });
});
