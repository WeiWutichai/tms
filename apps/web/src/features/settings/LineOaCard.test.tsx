import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/** การ์ด LINE Official Account (ตั้งค่า → การเชื่อมต่อ — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ) */
const GET = vi.fn();
const PATCH = vi.fn();
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: { GET: (...a: unknown[]) => GET(...a), PATCH: (...a: unknown[]) => PATCH(...a) },
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
});
