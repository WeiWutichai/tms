import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiError, unwrap } from '../api';
import { I18nProvider } from '../i18n';
import { th } from '../i18n/th';
import { LoginPage } from '../public/Login';
import {
  peekLoginNotice,
  requireTwoFactorEnrolment,
  sessionStore,
  startImpersonation,
} from './session';

/**
 * D-78 (PO 23 พ.ย. 2569) — ผู้ใช้ที่ถือสิทธิ์สำคัญแต่ยังไม่ตั้ง 2FA: API ตอบ 403 `two_factor_enrolment_required`
 * → ออกจากระบบ (เพิกถอน refresh token) → หน้าเข้าสู่ระบบบอกเหตุ → login ใหม่ = ขั้นตั้ง 2FA เดิม
 */
const fakeJwt = (exp: number) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.y`;

describe('ด่านบังคับตั้ง 2FA (D-78)', () => {
  it('unwrap: 403 two_factor_enrolment_required → ออกจากระบบ (session out) + ข้อความหน้าเข้าสู่ระบบ · error โยนต่อ', async () => {
    const r = unwrap(
      Promise.resolve({
        error: { code: 'two_factor_enrolment_required', status: 403, title: '', type: '' },
        response: new Response(null, { status: 403 }),
      }),
    );
    await expect(r).rejects.toBeInstanceOf(ApiError);
    await waitFor(() => expect(sessionStore.get()).toBe('out'));
    expect(peekLoginNotice()).toBe('two_factor_enrolment_required');
  });

  it('หน้าเข้าสู่ระบบแสดงเหตุในช่องข้อความเดิม (role=alert)', () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(th['login.enrolRequired']);
  });

  it('403 อื่น (permission_denied) ไม่ออกจากระบบ', async () => {
    startImpersonation(fakeJwt(Math.floor(Date.now() / 1000) + 600));
    expect(sessionStore.get()).toBe('in');
    await expect(
      unwrap(
        Promise.resolve({
          error: { code: 'permission_denied', status: 403, title: '', type: '' },
          response: new Response(null, { status: 403 }),
        }),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    // เข้าใช้งานแทน (ทีม Innovera) ไม่ถูกบังคับ — requireTwoFactorEnrolment ไม่ทำอะไร
    await requireTwoFactorEnrolment();
    expect(sessionStore.get()).toBe('in');
  });
});
