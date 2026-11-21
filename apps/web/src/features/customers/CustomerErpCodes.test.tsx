import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import {
  type CustomerErpCode,
  CustomerErpCodesTab,
  CustomerErpWarn,
  erpCodeChanges,
} from './CustomerErpCodes';

vi.mock('../../api', () => ({ api: {}, unwrap: vi.fn() }));

const row = (
  id: string,
  name: string,
  externalId: string | null,
  version = 1,
): CustomerErpCode => ({
  connector: { id, adapterKey: name.toLowerCase(), displayName: name, status: 'ACTIVE' },
  externalId,
  sourceCode: externalId,
  status: externalId ? 'SYNCED' : 'UNMAPPED',
  updatedAt: null,
  version,
});

const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe('รหัสระบบบัญชีของลูกค้า (ST8-T05 — ต้นแบบ drawer ลูกค้า แท็บ erpc)', () => {
  it('แถวละ connector: ชื่อ · ช่องรหัส (ยังไม่ map) · ป้าย สำเร็จ/ยังไม่ map', () => {
    const onChange = vi.fn();
    wrap(
      <CustomerErpCodesTab
        rows={[row('con_1', 'KRS', 'C0001'), row('con_2', 'Other', null, 0)]}
        draft={{}}
        onChange={onChange}
        readOnly={false}
      />,
    );
    expect(screen.getByRole('heading', { name: 'รหัสลูกค้าในระบบบัญชีที่เชื่อมต่อ' })).toBeTruthy();
    const rows = screen.getAllByTestId('cust-erp-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('KRS');
    expect(rows[0]!.textContent).toContain('สำเร็จ');
    expect(rows[1]!.textContent).toContain('ยังไม่ map');
    const input = screen.getByLabelText('รหัสลูกค้าใน Other') as HTMLInputElement;
    expect(input.placeholder).toBe('ยังไม่ map');
    fireEvent.change(input, { target: { value: 'D-9' } });
    expect(onChange).toHaveBeenCalledWith('con_2', 'D-9');
  });

  it('อ่านอย่างเดียว = ช่องปิด', () => {
    wrap(
      <CustomerErpCodesTab
        rows={[row('con_1', 'KRS', null)]}
        draft={{}}
        onChange={() => {}}
        readOnly
      />,
    );
    expect((screen.getByLabelText('รหัสลูกค้าใน KRS') as HTMLInputElement).disabled).toBe(true);
  });

  it('กล่องเตือนในแท็บทั่วไปเมื่อยังไม่มีรหัส · ครบแล้วไม่แสดง', () => {
    const { rerender } = wrap(<CustomerErpWarn rows={[row('con_1', 'KRS', null)]} />);
    expect(screen.getByTestId('cust-erp-warn').textContent).toBe(
      'ยังไม่ได้ map รหัสลูกค้าใน KRS · ใบแจ้งหนี้ของลูกค้านี้จะส่งเข้า KRS ไม่ได้',
    );
    rerender(
      <I18nProvider>
        <CustomerErpWarn rows={[row('con_1', 'KRS', 'C1')]} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('cust-erp-warn')).toBeNull();
  });

  it('บันทึกเฉพาะช่องที่เปลี่ยน (ตัดช่องว่าง)', () => {
    const rows = [row('con_1', 'KRS', 'C1'), row('con_2', 'Other', null)];
    expect(erpCodeChanges(rows, {})).toEqual([]);
    expect(erpCodeChanges(rows, { con_1: ' C1 ' })).toEqual([]);
    expect(erpCodeChanges(rows, { con_1: '', con_2: 'X' })).toEqual([
      { row: rows[0], value: '' },
      { row: rows[1], value: 'X' },
    ]);
  });
});
