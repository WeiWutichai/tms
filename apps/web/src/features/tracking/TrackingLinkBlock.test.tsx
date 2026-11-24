import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/** ลิงก์ติดตามสำหรับผู้รับ (ST4-T14 — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ) */
const GET = vi.fn();
const POST = vi.fn();
vi.mock('../../api', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
  unwrap: (p: Promise<unknown>) => p,
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' }, scopes: [] } }),
}));
const { TrackingLinkBlock } = await import('./TrackingLinkBlock');

const LINK = {
  linkId: 'mlk_1',
  url: 'https://app.example/t/ml1.abc',
  expiresAt: '2027-02-22T00:00:00Z',
  createdAt: '2026-11-24T03:00:00Z',
  lastUsedAt: null,
};
const show = (kind: 'do' | 'customer' = 'do') => {
  const onToast = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider>
        <TrackingLinkBlock kind={kind} id={kind === 'do' ? 'do_1' : 'cus_1'} onToast={onToast} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onToast;
};

describe('TrackingLinkBlock', () => {
  beforeEach(() => {
    GET.mockReset();
    POST.mockReset();
  });

  it('ยังไม่มีลิงก์ → "สร้างลิงก์ติดตาม" → POST ของ DO → แถว URL + คัดลอก/เปิดหน้าผู้รับ', async () => {
    GET.mockResolvedValueOnce({ link: null }).mockResolvedValue({ link: LINK });
    POST.mockResolvedValueOnce(LINK);
    const onToast = show();
    const create = await screen.findByRole('button', { name: 'สร้างลิงก์ติดตาม' });
    expect(GET).toHaveBeenCalledWith('/v1/delivery-orders/{id}/tracking-link', {
      params: { path: { id: 'do_1' } },
    });
    await act(async () => {
      fireEvent.click(create);
    });
    expect(POST).toHaveBeenCalledWith('/v1/delivery-orders/{id}/tracking-link', {
      params: { path: { id: 'do_1' } },
    });
    expect(onToast).toHaveBeenCalledWith('สร้างลิงก์ติดตามแล้ว');
    await waitFor(() => expect(screen.getByTestId('trk-link-url').textContent).toContain(LINK.url));
    expect(screen.getByRole('link', { name: 'เปิดหน้าผู้รับ' }).getAttribute('href')).toBe(
      LINK.url,
    );
    expect(screen.getByRole('button', { name: 'ออกลิงก์ใหม่' })).toBeTruthy();
    expect(screen.getByText('ออกลิงก์ใหม่แล้วลิงก์เดิมจะใช้ไม่ได้')).toBeTruthy();
  });

  it('ลูกค้า: เพิกถอนต้องมีเหตุผล ≥ 10 → POST revoke พร้อมเหตุผล', async () => {
    GET.mockResolvedValueOnce({ link: LINK }).mockResolvedValue({ link: null });
    POST.mockResolvedValueOnce({ link: null });
    const onToast = show('customer');
    fireEvent.click(await screen.findByRole('button', { name: 'เพิกถอนลิงก์' }));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'ส่งลิงก์ให้ผู้รับผิดคน' } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'เพิกถอนลิงก์' }).at(-1)!);
    });
    expect(POST).toHaveBeenCalledWith('/v1/customers/{id}/tracking-link/revoke', {
      params: { path: { id: 'cus_1' } },
      body: { reason: 'ส่งลิงก์ให้ผู้รับผิดคน' },
    });
    expect(onToast).toHaveBeenCalledWith('เพิกถอนลิงก์ติดตามแล้ว');
  });
});
