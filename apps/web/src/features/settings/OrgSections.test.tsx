import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const refetch = vi.fn();
const state = { isError: true, data: undefined as unknown, pending: false };
const mutate = vi.fn();
vi.mock('./useSettings', () => ({
  useTenantSettings: () => ({ isError: state.isError, data: state.data, refetch }),
  useSaveTenantSettings: () => ({ isPending: state.pending, mutate }),
  useCompaniesAll: () => ({ data: undefined }),
  useBranches: () => ({ data: undefined }),
  stepUp: vi.fn(),
}));

const { SecuritySection, DispatchSection } = await import('./OrgSections');

const wrap = () =>
  render(
    <I18nProvider lang="th">
      <SecuritySection canWrite />
    </I18nProvider>,
  );

describe('ตั้งค่าความปลอดภัย: สถานะโหลด/บันทึก', () => {
  it('GET /v1/settings ล้ม → แสดง error + ลองอีกครั้ง (ไม่ค้างที่ปุ่มบันทึกกดไม่ได้)', () => {
    wrap();
    expect(screen.getByText('โหลดการตั้งค่าไม่สำเร็จ')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'บันทึก' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('กำลังบันทึก → ช่องกรอกถูกปิด', () => {
    state.isError = false;
    state.pending = true;
    state.data = {
      data: [
        { key: 'security.idleTimeoutMinutes', value: 480, version: 1 },
        { key: 'security.autoLogout', value: true, version: 1 },
        { key: 'security.require2faAll', value: false, version: 1 },
      ],
    };
    wrap();
    expect(screen.getByLabelText('Session timeout')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'บันทึก' })).toBeDisabled();
  });
});

describe('ตั้งค่า → การจ่ายงานและติดตาม (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ)', () => {
  const data = {
    data: [
      { key: 'dispatch.subconResponseHours', value: 2, version: 1 },
      { key: 'dispatch.maxAutoReschedules', value: 2, version: 3 },
      { key: 'tracking.contactPhone', value: null, version: 1 },
      { key: 'tracking.showPod', value: false, version: 1 },
      { key: 'tracking.linkDays', value: 30, version: 1 },
    ],
  };
  const show = () =>
    render(
      <I18nProvider lang="th">
        <DispatchSection canWrite />
      </I18nProvider>,
    );
  it('แก้ค่า → บันทึกเฉพาะค่าที่เปลี่ยน + version · ค่านอกช่วง = ข้อความแดง + บันทึกไม่ได้', () => {
    state.isError = false;
    state.pending = false;
    state.data = data;
    mutate.mockReset();
    show();
    const max = screen.getByLabelText('นัดส่งใหม่อัตโนมัติได้สูงสุด (ครั้งต่อใบส่งของ)');
    expect((max as HTMLInputElement).value).toBe('2');
    fireEvent.change(max, { target: { value: '11' } });
    expect(screen.getByText('ใส่ 0–10 ครั้ง')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'บันทึก' })).toBeDisabled();
    fireEvent.change(max, { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('เบอร์ติดต่อบริษัท'), {
      target: { value: '02 123 4567' },
    });
    fireEvent.click(screen.getByRole('switch', { name: /แสดงหลักฐานการส่ง/ }));
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      values: {
        'dispatch.maxAutoReschedules': 0,
        'tracking.contactPhone': '02 123 4567',
        'tracking.showPod': true,
      },
      versions: {
        'dispatch.maxAutoReschedules': 3,
        'tracking.contactPhone': 1,
        'tracking.showPod': 1,
      },
    });
  });
});
