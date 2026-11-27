/**
 * เรียก `/v1/public/signup/*` (P1-ST2-T03) — fetch ตรง ไม่ดึง client ทั้งแอป (หน้าสมัครอยู่ใน chunk เดียวกับ landing)
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
export interface SignupSession {
  status: string;
  step: number;
  name: string;
  email: string;
  mobile: string;
  otp: SignupOtpState | null;
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
  if (init.body) headers.set('Content-Type', 'application/json');
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
};
