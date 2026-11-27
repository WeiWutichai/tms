/**
 * เรียก `/v1/public/signup/*` (P1-ST2-T03 ขั้น 1 · P1-ST2-T04 ขั้น 2) — fetch ตรง ไม่ดึง client ทั้งแอป (หน้าสมัครอยู่ใน chunk เดียวกับ landing)
 * token ทำต่อเก็บใน sessionStorage (รีเฟรชได้ · ปิดเบราว์เซอร์ = หาย → login ด้วยอีเมล/รหัสของการสมัครเพื่อกลับมาทำต่อ)
 */
export interface SignupOtpState {
  channel: string;
  sentTo: string;
  expiresAt: string | null;
  resendAvailableAt: string | null;
  lockedUntil: string | null;
  attemptsLeft: number;
}
/** P1-ST2-T04 ที่อยู่แยกฟิลด์ (ลำดับตาม spec/01 §2 ขั้น 2) */
export const ADDRESS_KEYS = [
  'houseNo',
  'moo',
  'soi',
  'street',
  'subDistrict',
  'district',
  'province',
  'postalCode',
] as const;
export type CompanyAddress = Record<(typeof ADDRESS_KEYS)[number], string>;
/** ตัวเลือกโปรแกรมบัญชี — "ไม่มี" ก่อน แล้วตามตัวอักษร (spec/01 §2) · ข้อมูล lead เท่านั้น */
export const ACCOUNTING_SOFTWARE = [
  'none',
  'express',
  'flowaccount',
  'krs',
  'peak',
  'sap_b1',
  'other',
] as const;
export interface SignupCertificate {
  filename: string | null;
  mime: string;
  bytes: number;
}
export interface SignupCompany {
  taxId: string;
  branchCode: string;
  legalName: string | null;
  address: CompanyAddress | null;
  fleetSizeOwn: number | null;
  fleetSizeSubcon: number | null;
  accountingSoftware: string | null;
  verificationStatus: string | null;
  verificationSource: string | null;
  marketingOptIn: boolean;
  certificate: SignupCertificate | null;
  submittedAt: string;
}
export interface SignupSession {
  status: string;
  step: number;
  name: string;
  email: string;
  mobile: string;
  otp: SignupOtpState | null;
  company: SignupCompany | null;
  certificate: SignupCertificate | null;
  joinRequest: {
    kind: string;
    companyName: string | null;
    taxId: string;
    requestedAt: string;
  } | null;
}
export interface CompanyLookupResult {
  taxId: string;
  branchCode: string;
  result: 'duplicate' | 'vat_found' | 'tin_exists' | 'not_found' | 'unavailable' | 'individual';
  source: string | null;
  company: {
    legalName: string;
    branchNumber: number;
    branchName: string | null;
    address: CompanyAddress;
    vatRegisteredSince: string | null;
  } | null;
  duplicate: { companyName: string; branchLabel: string | null } | null;
  sameTaxOtherBranch: boolean;
  requiresCertificate: boolean;
}
export interface SubmitCompanyInput {
  taxId: string;
  branchType: 'hq' | 'branch';
  branchCode?: string;
  legalName: string;
  address: CompanyAddress;
  fleetSizeOwn: number;
  fleetSizeSubcon: number;
  accountingSoftware: string;
  acceptTerms: true;
  acceptPrivacy: true;
  marketingOptIn: boolean;
}
export interface SignupProblem {
  code: string;
  status: number;
  retryAfter?: number;
  attemptsLeft?: number;
  errors?: Array<{ field: string; code: string }>;
}

export class SignupError extends Error {
  constructor(readonly problem: SignupProblem) {
    super(problem.code);
  }
}

const KEY = 'tms.signupToken';
export const signupToken = {
  get(): string | null {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(v: string) {
    try {
      sessionStorage.setItem(KEY, v);
    } catch {
      /* โหมดส่วนตัว/ปิด storage — ทำต่อด้วย login แทน */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ไม่มี storage */
    }
  },
};

async function call<T>(path: string, init: RequestInit = {}, withToken = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const lang = document.documentElement.lang === 'en' ? 'en' : 'th';
  headers.set('Accept-Language', lang);
  const tok = withToken ? signupToken.get() : null;
  if (tok) headers.set('X-Signup-Token', tok);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new SignupError({ code: 'internal_error', status: 0 });
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new SignupError({
      code: typeof body.code === 'string' ? body.code : 'internal_error',
      status: res.status,
      retryAfter:
        typeof body.retryAfter === 'number'
          ? body.retryAfter
          : Number(res.headers.get('Retry-After')) || undefined,
      attemptsLeft: typeof body.attemptsLeft === 'number' ? body.attemptsLeft : undefined,
      errors: Array.isArray(body.errors) ? (body.errors as SignupProblem['errors']) : undefined,
    });
  return body as T;
}

export const signupApi = {
  start: (input: {
    name: string;
    email: string;
    mobile: string;
    password: string;
    locale: string;
  }) =>
    call<{ token: string; session: SignupSession }>(
      '/v1/public/signup',
      { method: 'POST', body: JSON.stringify(input) },
      false,
    ),
  get: () => call<SignupSession>('/v1/public/signup/session'),
  resend: () =>
    call<SignupSession>('/v1/public/signup/session/otp/resend', { method: 'POST', body: '{}' }),
  verify: (code: string) =>
    call<SignupSession>('/v1/public/signup/session/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  // P1-ST2-T04 ขั้น 2
  lookup: (taxId: string, branchCode: string) =>
    call<CompanyLookupResult>('/v1/public/signup/session/company/lookup', {
      method: 'POST',
      body: JSON.stringify({ taxId, branchCode }),
    }),
  uploadCertificate: (file: File) =>
    call<SignupSession>(
      `/v1/public/signup/session/company/certificate?filename=${encodeURIComponent(file.name)}`,
      { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
    ),
  submitCompany: (input: SubmitCompanyInput) =>
    call<SignupSession>('/v1/public/signup/session/company', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  joinRequest: (taxId: string, branchCode: string, kind: 'join' | 'contact') =>
    call<SignupSession>('/v1/public/signup/session/company/join-request', {
      method: 'POST',
      body: JSON.stringify({ taxId, branchCode, kind }),
    }),
};
