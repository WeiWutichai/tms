import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { readLandingConfig } from '../landing/config';
import { signupToken } from './signupApi';
import { SignupPage } from './SignupPage';

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
      <SignupPage config={readLandingConfig({})} plans={null} />
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
    // P1-ST2-T04: ขั้น 2 เปิดแล้ว — ฟอร์มข้อมูลบริษัท (ช่องเลขผู้เสียภาษี + ปุ่มค้นหา)
    expect(screen.getByRole('button', { name: 'ค้นหา' })).toBeTruthy();
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

/** P1-ST2-T04 ขั้น 2 "ข้อมูลบริษัท" (fetch ปลอม) */
describe('หน้าสมัครขั้น 2 ข้อมูลบริษัท (P1-ST2-T04)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const STEP2 = { ...SESSION, status: 'account_verified', step: 2, otp: null };
  const LOOKUP = {
    taxId: '0105567153766',
    branchCode: '00000',
    result: 'vat_found',
    source: 'rd_vat',
    company: {
      legalName: 'บริษัท ตัวอย่างขนส่ง จำกัด',
      branchNumber: 0,
      branchName: 'สำนักงานใหญ่',
      address: {
        houseNo: '99/1',
        moo: '4',
        soi: '',
        street: 'พระราม 2',
        subDistrict: 'แสมดำ',
        district: 'บางขุนเทียน',
        province: 'กรุงเทพมหานคร',
        postalCode: '10150',
      },
      vatRegisteredSince: '2024-05-02',
    },
    duplicate: null,
    sameTaxOtherBranch: false,
    requiresCertificate: false,
  };
  beforeEach(() => {
    signupToken.set('tok');
    fetchMock = vi.fn().mockReturnValueOnce(json(200, STEP2));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    signupToken.clear();
  });
  const taxBox = () => screen.getByPlaceholderText<HTMLInputElement>('0105556078912');

  it('checksum ผิด (PLT-020) → error ทันทีเมื่อพิมพ์ครบ 13 หลัก และกด "ค้นหา" ไม่ส่งคำขอ', async () => {
    await act(async () => {
      renderSignup();
    });
    await screen.findByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' });
    fireEvent.change(taxBox(), { target: { value: '0105567153767' } });
    expect(screen.getByText('เลขผู้เสียภาษีไม่ถูกต้อง ตรวจตัวเลขอีกครั้ง')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา' }));
    fireEvent.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(fetchMock).toHaveBeenCalledTimes(1); // แค่โหลด session
    fireEvent.change(taxBox(), { target: { value: '01055' } });
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา' }));
    expect(screen.getByText('เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // "ย้อนกลับ" ตามต้นแบบ → ขั้น 1 อ่านอย่างเดียว → "ถัดไป" กลับขั้น 2 (ค่าที่พิมพ์ยังอยู่)
    fireEvent.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
    await screen.findByRole('heading', { level: 1, name: 'สร้างบัญชี' });
    const email = screen.getByText('อีเมลบริษัท').closest('label')!.querySelector('input')!;
    expect(email.readOnly).toBe(true);
    expect(email.value).toBe('somchai@company.co.th');
    expect(screen.queryByRole('button', { name: 'ขอรหัส OTP' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await screen.findByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' });
    expect(taxBox().value).toBe('01055');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ค้นหา → ป้าย "ข้อมูลจากกรมสรรพากร" + prefill ที่อยู่แยกฟิลด์ → ยอมรับข้อกำหนด → ส่ง → ขั้น 3 (stub) → ย้อนกลับแก้ได้', async () => {
    await act(async () => {
      renderSignup();
    });
    await screen.findByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' });
    fetchMock.mockReturnValueOnce(json(200, LOOKUP));
    fireEvent.change(taxBox(), { target: { value: '0105567153766' } });
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await screen.findByText('ข้อมูลจากกรมสรรพากร · แก้ได้');
    expect(fetchMock.mock.calls[1]![0]).toBe('/v1/public/signup/session/company/lookup');
    const nameInput = screen.getByText('ชื่อนิติบุคคล').closest('label')!.querySelector('input')!;
    expect(nameInput.value).toBe('บริษัท ตัวอย่างขนส่ง จำกัด');
    for (const l of [
      'เลขที่',
      'หมู่',
      'ซอย',
      'ถนน',
      'แขวง/ตำบล',
      'เขต/อำเภอ',
      'จังหวัด',
      'รหัสไปรษณีย์',
    ])
      expect(screen.getByText(l)).toBeTruthy();
    for (const l of ['ไม่มี', 'Express', 'FlowAccount', 'KRS', 'PEAK', 'SAP B1', 'อื่นๆ'])
      expect(screen.getByRole('button', { name: l })).toBeTruthy();
    fill('รถบริษัท (โดยประมาณ)', '20');
    fill('รถร่วม (โดยประมาณ)', '8');
    fireEvent.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByText('ต้องยอมรับเงื่อนไขและนโยบายความเป็นส่วนตัว')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText(/ยอมรับเงื่อนไขการใช้บริการ/));
    fireEvent.click(screen.getByLabelText(/ยอมรับนโยบายความเป็นส่วนตัว/));
    fireEvent.click(screen.getByRole('button', { name: 'PEAK' }));
    fetchMock.mockReturnValueOnce(
      json(200, {
        ...STEP2,
        status: 'company_submitted',
        step: 3,
        company: { taxId: '0105567153766', branchCode: '00000', verificationStatus: 'auto_vat' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await screen.findByRole('heading', { level: 1, name: 'เลือกแพ็กเกจ' });
    expect(screen.getByText('ขั้น 3 จาก 3')).toBeTruthy();
    const sent = JSON.parse(fetchMock.mock.calls[2]![1].body as string);
    expect(fetchMock.mock.calls[2]![0]).toBe('/v1/public/signup/session/company');
    expect(sent).toMatchObject({
      taxId: '0105567153766',
      branchType: 'hq',
      legalName: 'บริษัท ตัวอย่างขนส่ง จำกัด',
      address: { houseNo: '99/1', postalCode: '10150', province: 'กรุงเทพมหานคร' },
      fleetSizeOwn: 20,
      fleetSizeSubcon: 8,
      accountingSoftware: 'peak',
      acceptTerms: true,
      acceptPrivacy: true,
      marketingOptIn: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
    await screen.findByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' });
  });

  it('เลขซ้ำ tenant เดิม → กล่อง "บริษัทนี้ใช้ TMS อยู่แล้ว" + ส่งคำขอเข้าร่วม/ติดต่อเรา ไม่มีปุ่มถัดไป → ส่งคำขอ → การ์ด "ส่งคำขอเข้าร่วมแล้ว"', async () => {
    await act(async () => {
      renderSignup();
    });
    await screen.findByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' });
    fetchMock.mockReturnValueOnce(
      json(200, {
        ...LOOKUP,
        result: 'duplicate',
        source: null,
        company: null,
        duplicate: { companyName: 'บริษัท ศรีไทยขนส่ง จำกัด', branchLabel: 'สำนักงานใหญ่' },
      }),
    );
    fireEvent.change(taxBox(), { target: { value: '0105567153766' } });
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await screen.findByText('บริษัทนี้ใช้ TMS อยู่แล้ว · บริษัท ศรีไทยขนส่ง จำกัด (สำนักงานใหญ่)');
    expect(screen.queryByRole('button', { name: 'ถัดไป' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ติดต่อเรา' })).toBeTruthy();
    fetchMock.mockReturnValueOnce(
      json(200, {
        ...STEP2,
        joinRequest: {
          kind: 'join',
          companyName: 'บริษัท ศรีไทยขนส่ง จำกัด',
          taxId: '0105567153766',
          requestedAt: new Date().toISOString(),
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ส่งคำขอเข้าร่วมบริษัท' }));
    await screen.findByRole('heading', { level: 1, name: 'ส่งคำขอเข้าร่วมแล้ว' });
    expect(screen.getByText('รอยืนยัน')).toBeTruthy();
  });
});

/** P1-ST2-T05 ขั้น 3 "เลือกแพ็กเกจ" + หน้าผล (fetch ปลอม) */
describe('หน้าสมัครขั้น 3 เลือกแพ็กเกจ (P1-ST2-T05)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const STEP3 = {
    ...SESSION,
    status: 'company_submitted',
    step: 3,
    otp: null,
    company: {
      taxId: '0105567153766',
      branchCode: '00000',
      legalName: 'บริษัท ตัวอย่างขนส่ง จำกัด',
      fleetSizeOwn: 12,
      fleetSizeSubcon: 0,
      verificationStatus: 'auto_vat',
    },
    joinRequest: null,
    planCode: null,
    demoRequestedAt: null,
  };
  const plan = (code: string, nameTh: string, extra: Record<string, unknown> = {}) => ({
    code,
    nameTh,
    nameEn: null,
    badge: null,
    isContactSales: false,
    pricePerVehicleMonthly: null,
    minimumMonthly: null,
    annualDiscountPct: '15.00',
    volumeTiers: [],
    vehicleMin: 1,
    vehicleMax: 15,
    ...extra,
  });
  const PLANS = {
    trialDays: 30,
    pricesVisible: true,
    plans: [
      plan('start', 'Starter', { pricePerVehicleMonthly: '350.00', minimumMonthly: '1500.00' }),
      plan('std', 'Growth', { pricePerVehicleMonthly: '450.00', vehicleMin: 16, vehicleMax: 60 }),
      plan('ent', 'Enterprise', { isContactSales: true, vehicleMin: 201, vehicleMax: null }),
    ],
  };
  const completion = (outcome: string) => ({
    session: { ...STEP3, status: outcome === 'demo' ? 'company_submitted' : 'completed' },
    completion: {
      outcome,
      tenantStatus:
        outcome === 'ready' ? 'trialing' : outcome === 'pending' ? 'pending_verification' : null,
      companyName: 'บริษัท ตัวอย่างขนส่ง จำกัด',
      planCode: outcome === 'demo' ? 'ent' : 'start',
      planName: outcome === 'demo' ? 'Enterprise' : 'Starter',
      trialEndsAt: '2026-12-28T05:00:00.000Z',
    },
    signIn: outcome === 'ready' ? { kind: 'mfa', mfaToken: 'mfa-tok', purpose: 'enroll' } : null,
  });
  beforeEach(() => {
    signupToken.set('tok');
    sessionStorage.removeItem('tms.signupSignIn');
    fetchMock = vi.fn().mockReturnValueOnce(json(200, STEP3)).mockReturnValueOnce(json(200, PLANS));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    signupToken.clear();
  });

  it('ตามต้นแบบ: การ์ดแพ็กเกจ (ทดลองใช้ / นัด demo) + ราคาหลังทดลอง + ประมาณการ · ค่าเริ่ม = แพ็กเกจที่ครอบจำนวนรถ', async () => {
    renderSignup();
    await screen.findByRole('heading', { level: 1, name: 'เลือกแพ็กเกจ' });
    expect(
      screen.getByText('ทดลองใช้ 30 วัน ไม่ต้องใช้บัตร เปลี่ยนแพ็กเกจได้ทุกเมื่อ'),
    ).toBeTruthy();
    const starter = await screen.findByRole('radio', { name: /ทดลองใช้ Starter 30 วัน/ });
    expect(starter.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('หลังทดลอง ฿350 / รถ')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Enterprise · นัด demo/ })).toBeTruthy();
    expect(screen.getByText('ติดต่อฝ่ายขาย')).toBeTruthy();
    // 12 คัน × 350 = 4,200 (มากกว่าขั้นต่ำ 1,500)
    expect(
      screen.getByText(
        'ประมาณการหลังทดลอง 12 คัน · ฿4,200.00 / เดือน ก่อน VAT · ไม่มีการตัดเงินระหว่างทดลอง',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'เริ่มใช้งาน' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Enterprise/ }));
    expect(screen.getByRole('button', { name: 'นัด demo' })).toBeTruthy();
    expect(screen.getByText('ทีมขายจะนัด demo และเสนอราคาตามจำนวนรถ 12 คัน')).toBeTruthy();
  });

  it('"เริ่มใช้งาน" → สร้างบริษัท → "พร้อมใช้งานแล้ว" + ปุ่ม "เข้าใช้งาน TMS" (ส่งต่อ 2FA ไปหน้า login)', async () => {
    renderSignup();
    await screen.findByRole('radio', { name: /ทดลองใช้ Starter/ });
    fetchMock.mockReturnValueOnce(json(200, completion('ready')));
    fireEvent.click(screen.getByRole('button', { name: 'เริ่มใช้งาน' }));
    await screen.findByRole('heading', { level: 1, name: 'พร้อมใช้งานแล้ว' });
    const call = fetchMock.mock.calls[2]!;
    expect(call[0]).toBe('/v1/public/signup/session/complete');
    const sent = JSON.parse(call[1].body as string);
    expect(sent.planCode).toBe('start');
    expect(sent.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      screen.getByText(/บริษัท ตัวอย่างขนส่ง จำกัด เริ่มทดลองใช้แพ็กเกจStarter ถึง 28 ธ.ค. 2569/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'เข้าใช้งาน TMS' }).getAttribute('href')).toBe(
      '/login?from=signup',
    );
    const h = JSON.parse(sessionStorage.getItem('tms.signupSignIn')!);
    expect(h.signIn).toEqual({ kind: 'mfa', mfaToken: 'mfa-tok', purpose: 'enroll' });
    expect(h.verifier).toBeTruthy();
    expect(signupToken.get()).toBeNull();
  });

  it('รอทีมงานตรวจ → "เราได้รับข้อมูลแล้ว" · นัด demo → "เราได้รับคำขอ demo แล้ว"', async () => {
    renderSignup();
    await screen.findByRole('radio', { name: /ทดลองใช้ Starter/ });
    fetchMock.mockReturnValueOnce(json(200, completion('pending')));
    fireEvent.click(screen.getByRole('button', { name: 'เริ่มใช้งาน' }));
    await screen.findByRole('heading', { level: 1, name: 'เราได้รับข้อมูลแล้ว' });
    expect(
      screen.getByText(
        'ทีมงานจะตรวจข้อมูลบริษัทและแจ้งผลทางอีเมลภายใน 1 วันทำการ ระหว่างนี้ยังไม่ต้องทำอะไรเพิ่ม',
      ),
    ).toBeTruthy();
    expect(screen.getByText('รอยืนยัน')).toBeTruthy();
  });

  it('นัด demo → "เราได้รับคำขอ demo แล้ว"', async () => {
    renderSignup();
    fireEvent.click(await screen.findByRole('radio', { name: /Enterprise/ }));
    fetchMock.mockReturnValueOnce(json(200, completion('demo')));
    fireEvent.click(screen.getByRole('button', { name: 'นัด demo' }));
    await screen.findByRole('heading', { level: 1, name: 'เราได้รับคำขอ demo แล้ว' });
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body as string).planCode).toBe('ent');
  });
});
