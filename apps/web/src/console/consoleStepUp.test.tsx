import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import { th } from '../i18n/th';

/**
 * D-77 (PO 23 พ.ย. 2569) — step-up ของ Platform Console: กล่อง ActionDialog (ใส่/หมุน credential, เปิด connector)
 * API ตอบ step_up_required → กล่องยืนยัน 2FA เดิม (StepUpBox) ในกล่องเดียวกัน → ยืนยันรหัส → ส่งคำขอเดิมซ้ำ
 */
const consoleStepUp = vi.fn((_code: string) => Promise.resolve());
const dropConsoleStepUp = vi.fn();
vi.mock('./session', async (orig) => ({
  ...(await orig<typeof import('./session')>()),
  consoleStepUp: (code: string) => consoleStepUp(code),
  dropConsoleStepUp: () => dropConsoleStepUp(),
}));
const { ActionDialog } = await import('./Tenants');

const problem = (code: string, status: number) =>
  new ApiError({ code, status, title: '', type: '' } as never);
const group = () => screen.queryByRole('group', { name: th['stepUp.title'] });

function open(onOk: (v: Record<string, string>, reason: string) => Promise<void>) {
  const onClose = vi.fn();
  render(
    <I18nProvider>
      <ActionDialog
        title="หมุน key"
        desc="ใส่ key ใหม่"
        okL="บันทึก"
        onOk={onOk}
        onClose={onClose}
      />
    </I18nProvider>,
  );
  fireEvent.change(screen.getByLabelText(th['con.reason']), {
    target: { value: 'ลูกค้าแจ้งหมุน key ใน ERP' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
}
async function typeOtp(otp = '123456') {
  const g = await screen.findByRole('group', { name: th['stepUp.title'] });
  fireEvent.change(g.querySelector('input')!, { target: { value: otp } });
  fireEvent.click(screen.getByRole('button', { name: th['mfa.submit'] }));
}

beforeEach(() => {
  consoleStepUp.mockReset();
  consoleStepUp.mockImplementation(() => Promise.resolve());
  dropConsoleStepUp.mockClear();
});

describe('ActionDialog ของ Console + step-up (D-77)', () => {
  it('step_up_required → กล่องยืนยัน (ปุ่มบันทึกปิด) → ยืนยันรหัส → ส่งซ้ำด้วยข้อมูลเดิม', async () => {
    let n = 0;
    const onOk = vi.fn(async () => {
      if (++n === 1) throw problem('step_up_required', 403);
    });
    open(onOk);
    expect(await screen.findByText(th['stepUp.descAction'])).toBeInTheDocument();
    expect(dropConsoleStepUp).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'บันทึก' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull(); // ไม่แสดง step_up_required เป็น error
    await typeOtp('654321');
    await waitFor(() => expect(onOk).toHaveBeenCalledTimes(2));
    expect(consoleStepUp).toHaveBeenCalledWith('654321');
    expect(onOk.mock.calls[1]).toEqual([{}, 'ลูกค้าแจ้งหมุน key ใน ERP']);
    await waitFor(() => expect(group()).toBeNull());
  });

  it('รหัสผิด → ข้อความ invalid_otp · กล่องยังอยู่ · ยกเลิก → กลับมากดบันทึกได้', async () => {
    const onOk = vi.fn(async () => {
      throw problem('step_up_required', 403);
    });
    consoleStepUp.mockImplementation(() => Promise.reject(problem('invalid_otp', 401)));
    open(onOk);
    await typeOtp('000000');
    expect(await screen.findByRole('alert')).toHaveTextContent(th['problem.invalid_otp']);
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(group()).not.toBeNull();
    fireEvent.click(within(group()!).getByRole('button', { name: th['common.cancel'] }));
    await waitFor(() => expect(group()).toBeNull());
    expect(screen.getByRole('button', { name: 'บันทึก' })).toBeEnabled();
  });

  it('error อื่นแสดงตามเดิม ไม่เปิดกล่องยืนยัน', async () => {
    open(async () => {
      throw problem('feature_not_in_plan', 403);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(th['problem.feature_not_in_plan']);
    expect(group()).toBeNull();
  });
});
