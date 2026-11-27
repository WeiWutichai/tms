import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { LandingPage } from '../landing/Landing';
import { readLandingConfig } from '../landing/config';
import { signupToken } from './signupApi';

/** P1-ST2-T03 หน้าสมัครขั้น 1 — ฟอร์ม → ขอ OTP → ยืนยัน → stepper ขั้น 2 (fetch ปลอม) */
const SESSION = {
  status: 'account_pending_otp',
  step: 1,
  name: 'สมชาย ใจดี',
  email: 'somchai@company.co.th',
  mobile: '+66812345678',
  otp: {
    channel: 'email',
    sentTo: 'somchai@company.co.th',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
    lockedUntil: null,
    attemptsLeft: 5,
  },
};
const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

function renderSignup() {
  return render(
    <I18nProvider lang="th">
      <LandingPage view="signup" config={readLandingConfig({})} />
    </I18nProvider>,
  );
}
const fill = (label: string, v: string) =>
  fireEvent.change(screen.getByText(label).closest('label')!.querySelector('input')!, {
    target: { value: v },
  });

describe('หน้าสมัคร /signup (P1-ST2-T03)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    signupToken.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    signupToken.clear();
  });

  it('ตามต้นแบบ: stepper 3 ขั้น, หัวข้อ, ช่องกรอก 4 ช่อง, แผงขวา — ไม่มีปุ่ม Google (R-08) · ส่ง OTP ทางอีเมล', () => {
    renderSignup();
    expect(screen.getByRole('heading', { level: 1, name: 'สร้างบัญชี' })).toBeTruthy();
    expect(screen.getByText('ใช้อีเมลบริษัท เราจะส่งรหัสยืนยันไปที่อีเมล')).toBeTruthy();
    for (const s of ['บัญชี', 'บริษัท', 'แพ็กเกจ']) expect(screen.getByText(s)).toBeTruthy();
    for (const l of ['ชื่อ-นามสกุล', 'อีเมลบริษัท', 'เบอร์มือถือ', 'รหัสผ่าน'])
      expect(screen.getByText(l)).toBeTruthy();
    expect(screen.getByText('+66')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'เริ่มใช้งานได้ใน 3 ขั้น' })).toBeTruthy();
    expect(screen.queryByText(/Google/)).toBeNull();
    expect(screen.getByText('ขั้น 1 จาก 3')).toBeTruthy();
  });

  it('ตรวจฟอร์มก่อนส่ง (ไม่เรียก API) · รหัสผ่าน ≥ 12 ตามนโยบาย ST1-T02', () => {
    renderSignup();
    fireEvent.click(screen.getByRole('button', { name: 'ขอรหัส OTP' }));
    expect(screen.getByText('กรอกชื่อ-นามสกุล')).toBeTruthy();
    expect(screen.getByText('อีเมลไม่ถูกต้อง')).toBeTruthy();
    expect(screen.getByText('เบอร์มือถือ 9 หลักหลัง +66')).toBeTruthy();
    expect(screen.getAllByText('อย่างน้อย 12 ตัวอักษร').length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('อีเมลมีบัญชีแล้ว → "อีเมลนี้มีบัญชีแล้ว" + ลิงก์ "เข้าสู่ระบบเพื่อเพิ่มบริษัทใหม่"', async () => {
    fetchMock.mockReturnValueOnce(json(409, { code: 'account_exists' }));
    renderSignup();
    fill('ชื่อ-นามสกุล', 'สมชาย ใจดี');
    fill('อีเมลบริษัท', 'somchai@company.co.th');
    fill('เบอร์มือถือ', '81 234 5678');
    fill('รหัสผ่าน', 'signup-password-2569');
    fireEvent.click(screen.getByRole('button', { name: 'ขอรหัส OTP' }));
    const link = await screen.findByRole('link', { name: 'เข้าสู่ระบบเพื่อเพิ่มบริษัทใหม่' });
    expect(link.getAttribute('href')).toBe('/login');
    expect(screen.getByText(/อีเมลนี้มีบัญชีแล้ว/)).toBeTruthy();
  });

  it('ขอ OTP → กล่องกรอกรหัส + นับถอยหลัง → รหัสผิด "เหลือ 4 ครั้ง" → ถูก → ขั้น 2 (stub ตาม stepper)', async () => {
    fetchMock
      .mockReturnValueOnce(json(201, { token: 'tok', session: SESSION }))
      .mockReturnValueOnce(json(422, { code: 'otp_invalid', attemptsLeft: 4 }))
      .mockReturnValueOnce(
        json(200, { ...SESSION, status: 'account_verified', step: 2, otp: null }),
      );
    renderSignup();
    fill('ชื่อ-นามสกุล', 'สมชาย ใจดี');
    fill('อีเมลบริษัท', 'somchai@company.co.th');
    fill('เบอร์มือถือ', '81 234 5678');
    fill('รหัสผ่าน', 'signup-password-2569');
    fireEvent.click(screen.getByRole('button', { name: 'ขอรหัส OTP' }));
    await screen.findByText('กรอกรหัส 6 หลักที่ส่งไปที่ somchai@company.co.th');
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(sent).toMatchObject({ mobile: '+66812345678', email: 'somchai@company.co.th' });
    expect(signupToken.get()).toBe('tok');
    expect(screen.getByText(/ขอรหัสใหม่ได้ใน \d+ วินาที/)).toBeTruthy();
    expect(screen.getByText('ขั้น 1 จาก 3 · ยืนยันอีเมล')).toBeTruthy();
    const input = screen.getByPlaceholderText('••••••');
    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรหัส' }));
    await screen.findByText('รหัสไม่ถูกต้อง เหลือ 4 ครั้ง');
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรหัส' }));
    await screen.findByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' });
    expect(screen.getByText('ขั้น 2 จาก 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ถัดไป' })).toBeNull();
    const verifyCall = fetchMock.mock.calls[2]!;
    expect(new Headers(verifyCall[1].headers).get('X-Signup-Token')).toBe('tok');
  });

  it('ผิดครบ 5 ครั้ง → บอกเวลาที่เหลือจาก Retry-After', async () => {
    signupToken.set('tok');
    fetchMock
      .mockReturnValueOnce(json(200, SESSION))
      .mockReturnValueOnce(json(429, { code: 'otp_locked', retryAfter: 840 }));
    await act(async () => {
      renderSignup();
    });
    const input = await screen.findByPlaceholderText('••••••');
    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรหัส' }));
    await screen.findByText('ใส่รหัสผิดครบ 5 ครั้ง ลองใหม่ได้ใน 14 นาที');
  });

  it('มี token ใน sessionStorage (รีเฟรช / login แล้วกลับมา) → โหลดขั้นที่ค้าง', async () => {
    signupToken.set('resume');
    fetchMock.mockReturnValueOnce(
      json(200, { ...SESSION, status: 'account_verified', step: 2, otp: null }),
    );
    await act(async () => {
      renderSignup();
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' })).toBeTruthy(),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('/v1/public/signup/session');
  });
});
