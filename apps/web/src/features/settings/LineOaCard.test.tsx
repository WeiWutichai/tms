import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { I18nProvider } from '../../i18n';

/** การ์ด LINE Official Account (ตั้งค่า → การเชื่อมต่อ — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ) */
const GET = vi.fn();
const PATCH = vi.fn();
const POST = vi.fn();
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: {
    GET: (...a: unknown[]) => GET(...a),
    PATCH: (...a: unknown[]) => PATCH(...a),
    POST: (...a: unknown[]) => POST(...a),
  },
  unwrap: (p: Promise<unknown>) => p,
}));
const { LineOaCard } = await import('./LineOaCard');

const S = {
  lineEnabled: false,
  lineConfigured: false,
  lineTokenHint: null,
  smsEnabled: false,
  lineProvider: 'line',
  smsProvider: null,
  version: 1,
  updatedAt: null,
};
const show = (canWrite = true) => {
  const onToast = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <LineOaCard canWrite={canWrite} onToast={onToast} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onToast;
};

describe('LineOaCard', () => {
  beforeEach(() => {
    GET.mockReset();
    PATCH.mockReset();
  });

  it('ยังไม่ตั้งค่า → ตั้งค่า → วาง token → บันทึก (เปิดส่งทาง LINE) · token ไม่แสดงกลับ', async () => {
    GET.mockResolvedValue(S);
    PATCH.mockResolvedValueOnce({
      ...S,
      lineEnabled: true,
      lineConfigured: true,
      lineTokenHint: '•••• a1B2',
    });
    const onToast = show();
    expect(await screen.findByText('ยังไม่ตั้งค่า')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ตั้งค่า' }));
    fireEvent.change(screen.getByLabelText('Channel access token (long-lived)'), {
      target: { value: ' tok-123 ' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'บันทึก token' }));
    });
    expect(PATCH).toHaveBeenCalledWith('/v1/settings/messaging', {
      body: { lineChannelAccessToken: 'tok-123', lineEnabled: true },
      headers: {},
    });
    expect(onToast).toHaveBeenCalledWith('บันทึก token LINE OA แล้ว');
    expect(await screen.findByText('เชื่อมต่อ')).toBeTruthy();
    expect(screen.getByText('ตั้ง token แล้ว (•••• a1B2)')).toBeTruthy();
  });

  it('ไม่มีสิทธิ์แก้ → ไม่มีปุ่มตั้งค่า', async () => {
    GET.mockResolvedValue({
      ...S,
      lineConfigured: true,
      lineEnabled: true,
      lineTokenHint: '•••• zz',
    });
    show(false);
    expect(await screen.findByText('เชื่อมต่อ')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ตั้งค่า' })).toBeNull();
  });

  it('API ขอยืนยัน 2FA (step_up_required) → กล่องยืนยันในการ์ด → ส่งซ้ำพร้อม X-Step-Up', async () => {
    GET.mockResolvedValue(S);
    PATCH.mockRejectedValueOnce(
      new ApiError({ status: 403, code: 'step_up_required', title: 'x' } as never),
    ).mockResolvedValueOnce({
      ...S,
      lineEnabled: true,
      lineConfigured: true,
      lineTokenHint: '•••• 9',
    });
    POST.mockResolvedValueOnce({ stepUpToken: 'su-tok', expiresIn: 300 });
    const onToast = show();
    fireEvent.click(await screen.findByRole('button', { name: 'ตั้งค่า' }));
    fireEvent.change(screen.getByLabelText('Channel access token (long-lived)'), {
      target: { value: 'tok-9' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'บันทึก token' }));
    });
    const otp = await screen.findByLabelText('รหัส 6 หลัก');
    fireEvent.change(otp, { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน' }));
    });
    await waitFor(() =>
      expect(PATCH).toHaveBeenLastCalledWith('/v1/settings/messaging', {
        body: { lineChannelAccessToken: 'tok-9', lineEnabled: true },
        headers: { 'X-Step-Up': 'su-tok' },
      }),
    );
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('บันทึก token LINE OA แล้ว'));
  });
});
