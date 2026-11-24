import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { th } from '../i18n/th';

/**
 * ST9-T13 R2-M02 — เข้าใช้งานแทนต้อง step-up ของ Console: ยืนยัน 2FA ก่อน (ไม่ส่งคำขอ/ไม่เปิดแท็บ) → ได้ URL แล้วจึงเปิดแท็บ
 * เบราว์เซอร์บล็อกหน้าต่างใหม่ → แสดงลิงก์ "เปิดแท็บ" (ไม่ปิดกล่องเงียบ ๆ)
 */
let token: string | null = null;
const post = vi.fn((_p: string, _o: { headers: Record<string, string> }) =>
  Promise.resolve({ data: { url: 'http://web.test/impersonate#token=abc' } }),
);
vi.mock('./session', async (orig) => ({
  ...(await orig<typeof import('./session')>()),
  consoleStepUp: (_code: string) => {
    token = 'su-token';
    return Promise.resolve();
  },
  dropConsoleStepUp: () => (token = null),
  consoleStepUpHeaders: () => (token ? { 'X-Step-Up': token } : {}),
  consoleApi: { POST: (p: string, o: { headers: Record<string, string> }) => post(p, o) },
  cunwrap: (p: Promise<{ data: unknown }>) => p.then((r) => r.data),
}));
const { ImpersonateDialog } = await import('./Tenants');

const tenant = {
  id: 'ten_1',
  name: 'ตัวอย่างขนส่ง',
  members: [{ id: 'usr_1', name: 'คุณโอ', status: 'active', roles: ['owner'] }],
} as never;

function start(onClose = vi.fn()) {
  render(
    <I18nProvider>
      <ImpersonateDialog x={tenant} onClose={onClose} />
    </I18nProvider>,
  );
  fireEvent.change(screen.getByLabelText(th['con.reason']), {
    target: { value: 'ลูกค้าแจ้งนำเข้า Excel ไม่ผ่าน' },
  });
  fireEvent.click(screen.getByRole('button', { name: th['con.act.imp'] }));
  return onClose;
}
async function confirm() {
  const g = await screen.findByRole('group', { name: th['stepUp.title'] });
  fireEvent.change(g.querySelector('input')!, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: th['mfa.submit'] }));
}

beforeEach(() => {
  token = null;
  post.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('ImpersonateDialog + step-up (R2-M02)', () => {
  it('ยังไม่ยืนยัน 2FA → กล่องยืนยันก่อน ไม่ส่งคำขอ ไม่เปิดแท็บ → ยืนยันแล้วส่งพร้อม X-Step-Up แล้วจึงเปิดแท็บ', async () => {
    const tab = { opener: {} as unknown };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as Window);
    const onClose = start();
    await screen.findByRole('group', { name: th['stepUp.title'] });
    expect(post).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('http://web.test/impersonate#token=abc', '_blank'),
    );
    expect(post.mock.calls[0]![1].headers).toEqual({ 'X-Step-Up': 'su-token' });
    expect(tab.opener).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it('เบราว์เซอร์บล็อกหน้าต่างใหม่ → แสดงลิงก์ "เปิดแท็บ" ไปยัง URL ที่ได้ (ไม่ปิดกล่อง)', async () => {
    token = 'su-token';
    vi.spyOn(window, 'open').mockReturnValue(null);
    const onClose = start();
    const link = await screen.findByRole('link', { name: th['con.act.openTab'] });
    expect(link).toHaveAttribute('href', 'http://web.test/impersonate#token=abc');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(th['con.dlg.impBlocked'], { exact: false })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
