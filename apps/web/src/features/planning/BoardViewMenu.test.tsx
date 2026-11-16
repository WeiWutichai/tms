import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { BoardViewMenu } from './BoardViewMenu';

const ALL = ['ORDER_NO', 'CUSTOMER', 'TIME', 'ROUTE', 'WEIGHT'];
const setup = (fields: string[] = ALL, disabled = false) => {
  const onChange = vi.fn();
  render(
    <I18nProvider lang="th">
      <BoardViewMenu view="FLEET" fields={fields} disabled={disabled} onChange={onChange} />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /มุมมอง: รถบริษัท \+ รถร่วม/ }));
  return onChange;
};

/** ST3-T13 ตัวสลับมุมมอง + field บนการ์ด (ปุ่ม "มุมมอง: …" ของต้นแบบ) */
describe('BoardViewMenu', () => {
  it('แสดง 4 มุมมอง ค่าที่เลือกมีเครื่องหมาย · เลือกใหม่ส่ง view + field เดิม แล้วปิดเมนู', () => {
    const onChange = setup();
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((x) => x.textContent)).toEqual([
      'รถบริษัท + รถร่วม',
      'ตามรถ',
      'ตามคนขับ',
      'ตามรถร่วม',
    ]);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'ตามคนขับ' }));
    expect(onChange).toHaveBeenCalledWith({ view: 'DRIVER', cardFields: ALL });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ติ๊ก field บนการ์ด: เอาออก/ใส่กลับตามลำดับมาตรฐาน · เหลือ field เดียวเอาออกไม่ได้', () => {
    const onChange = setup(['ORDER_NO', 'WEIGHT']);
    expect(screen.getByText('ข้อมูลบนการ์ด')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('ลูกค้า'));
    expect(onChange).toHaveBeenLastCalledWith({
      view: 'FLEET',
      cardFields: ['ORDER_NO', 'CUSTOMER', 'WEIGHT'],
    });
    fireEvent.click(screen.getByLabelText('เลข SO'));
    expect(onChange).toHaveBeenLastCalledWith({ view: 'FLEET', cardFields: ['WEIGHT'] });
  });

  it('field สุดท้ายถูกปิดไว้ (ต้องมีอย่างน้อย 1)', () => {
    setup(['ROUTE']);
    expect(screen.getByLabelText('เส้นทาง')).toBeDisabled();
    expect(screen.getByLabelText('ช่วงเวลา')).not.toBeDisabled();
  });

  it('Esc ปิดเมนูแล้วโฟกัสกลับที่ปุ่ม', () => {
    setup();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: /มุมมอง:/ })).toHaveFocus();
  });

  it('ระหว่างโหลดค่าของผู้ใช้ ปุ่มกดไม่ได้', () => {
    setup(ALL, true);
    expect(screen.getByRole('button', { name: /มุมมอง:/ })).toBeDisabled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ปุ่มตัวหนา 500 ตามต้นแบบ', () => {
    setup();
    expect(screen.getByRole('button', { name: /มุมมอง:/ })).toHaveStyle({ fontWeight: '500' });
  });
});
