import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const mutate = vi.fn();
const refetch = vi.fn();
const DEFAULT = {
  success: {
    fields: [
      { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
      { key: 'signature', type: 'SIGNATURE', level: 'REQUIRED' },
      { key: 'note', type: 'NOTE', level: 'ENABLED' },
    ],
  },
};
vi.mock('../../api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public problem: { code: string }) {
      super(problem.code);
    }
  },
}));
vi.mock('../settings/useSettings', () => ({
  useTenantSettings: () => ({
    isError: false,
    data: { data: [{ key: 'pod.checklist', value: DEFAULT, version: 3 }] },
    refetch,
  }),
  useSaveTenantSettings: () => ({ isPending: false, mutate }),
}));

const { PodSection } = await import('./PodSection');
const { nextCheckKey, podChecklistInvalid, podSummary } = await import('./PodChecklistTable');
const { ApiError } = await import('../../api');

const wrap = (canWrite = true) =>
  render(
    <I18nProvider lang="th">
      <PodSection canWrite={canWrite} />
    </I18nProvider>,
  );

describe('ตั้งค่า → หลักฐานส่ง (POD)', () => {
  it('แสดงแถวตามชนิด + ระดับปัจจุบัน; รูปบังคับมีจำนวนขั้นต่ำ', () => {
    wrap();
    expect(
      screen.getByRole('heading', { name: 'หลักฐานส่ง (POD) ค่าเริ่มต้น' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'บังคับ — รูปหลักฐาน' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'ไม่บังคับ — หมายเหตุ' })).toBeChecked();
    expect(screen.getByLabelText('จำนวนรูปขั้นต่ำ')).toHaveValue('1');
  });

  it('เปลี่ยนระดับ + จำนวนรูป + เพิ่มข้อยืนยัน แล้วบันทึก → PATCH ค่าใหม่พร้อม version', () => {
    wrap();
    fireEvent.click(screen.getByRole('radio', { name: 'บังคับ — หมายเหตุ' }));
    fireEvent.change(screen.getByLabelText('จำนวนรูปขั้นต่ำ'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มข้อยืนยัน' }));
    // ข้อความว่าง → ไม่ส่ง แจ้งให้กรอก
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('กรอกข้อความของข้อยืนยันให้ครบ');
    fireEvent.click(within(screen.getByRole('status')).getByRole('button'));
    fireEvent.change(screen.getByLabelText('ข้อความข้อยืนยัน'), {
      target: { value: 'สินค้าครบ ไม่เสียหาย' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toEqual({
      values: {
        'pod.checklist': {
          success: {
            fields: [
              { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 2 },
              { key: 'signature', type: 'SIGNATURE', level: 'REQUIRED' },
              { key: 'note', type: 'NOTE', level: 'REQUIRED' },
              { key: 'check_1', type: 'BOOLEAN', level: 'REQUIRED', label: 'สินค้าครบ ไม่เสียหาย' },
            ],
          },
        },
      },
      versions: { 'pod.checklist': 3 },
    });
  });

  it('ไม่มีสิทธิ์แก้ → อ่านอย่างเดียว ไม่มีปุ่มบันทึก/เพิ่ม', () => {
    wrap(false);
    expect(screen.getByRole('radio', { name: 'บังคับ — รูปหลักฐาน' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'บันทึก' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'เพิ่มข้อยืนยัน' })).toBeNull();
  });

  it('เพิ่มข้อยืนยัน → โฟกัสช่องข้อความ; 412 → ทิ้งร่าง โหลดค่าล่าสุด แจ้งให้แก้ใหม่', () => {
    mutate.mockReset();
    wrap();
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มข้อยืนยัน' }));
    const input = screen.getByLabelText('ข้อความข้อยืนยัน');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'ของครบ' } });
    mutate.mockImplementation((_v, o: { onError: (e: unknown) => void }) =>
      o.onError(
        new (ApiError as unknown as new (p: { code: string }) => Error)({
          code: 'precondition_failed',
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('ถูกแก้โดยผู้อื่นแล้ว');
    expect(screen.queryByLabelText('ข้อความข้อยืนยัน')).toBeNull(); // ร่างถูกทิ้ง
  });

  it('อ่านอย่างเดียว: จำนวนรูปเป็นข้อความ ไม่ใช่ select', () => {
    wrap(false);
    expect(screen.queryByLabelText('จำนวนรูปขั้นต่ำ')).toBeNull();
    expect(screen.getByText('อย่างน้อย 1 รูป')).toBeInTheDocument();
  });

  it('สรุปสำหรับแท็บกิจกรรม อ่านง่าย', () => {
    const t = (k: string) =>
      ({
        'pod.cust.default': 'ใช้ค่าเริ่มต้นขององค์กร',
        'pod.type.PHOTO': 'รูปหลักฐาน',
        'pod.type.NOTE': 'หมายเหตุ',
        'pod.lv.REQUIRED': 'บังคับ',
        'pod.lv.DISABLED': 'ไม่ใช้',
      })[k] ?? k;
    expect(podSummary(t as never, {})).toBe('ใช้ค่าเริ่มต้นขององค์กร');
    expect(
      podSummary(t as never, {
        success: {
          fields: [
            { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 2 },
            { key: 'note', type: 'NOTE', level: 'DISABLED' },
          ],
        },
      }),
    ).toBe('รูปหลักฐาน: บังคับ (≥ 2) · หมายเหตุ: ไม่ใช้');
  });

  it('helper: key ข้อยืนยันไม่ซ้ำ และตรวจข้อความว่าง', () => {
    expect(nextCheckKey([{ key: 'check_1', type: 'BOOLEAN', level: 'ENABLED', label: 'x' }])).toBe(
      'check_2',
    );
    expect(
      podChecklistInvalid([{ key: 'check_1', type: 'BOOLEAN', level: 'ENABLED', label: '  ' }]),
    ).toBe(true);
  });
});
