import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const refetch = vi.fn();
const state = { isError: true, data: undefined as unknown, pending: false };
vi.mock('./useSettings', () => ({
  useTenantSettings: () => ({ isError: state.isError, data: state.data, refetch }),
  useSaveTenantSettings: () => ({ isPending: state.pending, mutate: vi.fn() }),
  useCompaniesAll: () => ({ data: undefined }),
  useBranches: () => ({ data: undefined }),
  stepUp: vi.fn(),
}));

const { SecuritySection } = await import('./OrgSections');

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
