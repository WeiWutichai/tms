import { createTmsClient, type Problem } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api';

/**
 * Session ของ Platform Console (ST1-T24) — แยกจาก session ลูกค้า (auth/session.ts) ทั้ง token และ client
 * token อยู่ในหน่วยความจำเท่านั้น (ไม่มี refresh cookie) → reload หน้า = เข้าสู่ระบบใหม่ (บังคับ 2FA ทุกครั้ง)
 */
let current: { token: string; exp: number } | null = null;
const listeners = new Set<() => void>();
/** D-77 step-up ของ Console (ดู consoleStepUp) */
let stepUp: { token: string; until: number } | null = null;

function set(token: string | null, expiresIn = 0) {
  current = token ? { token, exp: Date.now() + expiresIn * 1000 } : null;
  stepUp = null; // session เปลี่ยน → ทิ้ง token step-up
  listeners.forEach((l) => l());
}

/**
 * D-77 (PO 23 พ.ย. 2569): step-up ของ Console — ยืนยันรหัส 6 หลักซ้ำก่อนใส่/หมุน credential หรือเปิด connector พร้อมค่าตั้ง
 * `POST /v1/platform/auth/step-up` → token (5 นาที) จำไว้ในหน่วยความจำ แนบ header `X-Step-Up` ด้วย `consoleStepUpHeaders()`
 */
export function consoleStepUpHeaders(): Record<string, string> {
  return stepUp && stepUp.until > Date.now() ? { 'X-Step-Up': stepUp.token } : {};
}
export async function consoleStepUp(code: string): Promise<void> {
  const r = await cunwrap(consoleApi.POST('/v1/platform/auth/step-up', { body: { code } }));
  // เผื่อเวลาเดินทาง 30 วินาที — หมดก่อน server เสมอ
  stepUp = { token: r.stepUpToken, until: Date.now() + Math.max(0, r.expiresIn - 30) * 1000 };
}
/** API ตอบ `step_up_required` → ทิ้ง token ที่จำไว้ (หมดอายุ/ใช้ไม่ได้) */
export function dropConsoleStepUp(): void {
  stepUp = null;
}

export const consoleSession = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: (): boolean => !!current && current.exp > Date.now(),
};

/** client ชุดเดียวกับแอป (generate จาก OpenAPI) แต่ใช้ token ของ Console */
export const consoleApi = createTmsClient({
  baseUrl: '',
  getToken: () => (current && current.exp > Date.now() ? current.token : null),
  locale: () => (document.documentElement.lang === 'en' ? 'en' : 'th'),
});

/** data หรือโยน ApiError — 401 = token Console หมดอายุ/ถูกเพิกถอน → กลับหน้าเข้าสู่ระบบของ Console */
export async function cunwrap<T>(
  p: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const r = await p;
  if (r.error !== undefined || !r.response.ok) {
    const problem = (r.error ?? {
      code: 'internal_error',
      status: r.response.status,
      title: '',
      type: '',
    }) as Problem;
    // 401 = token Console หมดอายุ/ถูกเพิกถอน · ยกเว้นรหัสยืนยันผิด (`invalid_otp` ของ step-up) — ยังอยู่ในระบบ ให้กรอกใหม่
    if (r.response.status === 401 && problem.code !== 'invalid_otp') set(null);
    throw new ApiError(problem);
  }
  return r.data as T;
}

const codeOf = (e: unknown) => (e as { code?: string } | undefined)?.code ?? 'internal_error';

/** ขั้นที่ 1: อีเมล + รหัสผ่าน → challenge สำหรับรหัส 6 หลัก */
export async function consoleLogin(
  email: string,
  password: string,
): Promise<{ challenge: string } | { error: string }> {
  const r = await consoleApi.POST('/v1/platform/auth/login', { body: { email, password } });
  return r.data ?? { error: codeOf(r.error) };
}

/** ขั้นที่ 2: รหัสจากแอป Authenticator → token Console */
export async function consoleMfa(
  challenge: string,
  code: string,
): Promise<{ ok: true } | { error: string }> {
  const r = await consoleApi.POST('/v1/platform/auth/mfa', { body: { challenge, code } });
  if (!r.data) return { error: codeOf(r.error) };
  set(r.data.accessToken, r.data.expiresIn);
  return { ok: true };
}

export async function consoleLogout(): Promise<void> {
  await consoleApi.POST('/v1/platform/auth/logout').catch(() => undefined);
  set(null);
}

export type StaffRole = 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING';

/** สิทธิ์ตามบทบาททีมงาน (docs/04 A6 — ตรงกับ @PlatformAuth ของ API; UI ซ่อนปุ่ม, API ตอบ 403 อีกชั้น) */
export const can = {
  create: (r?: StaffRole) => r === 'SUPER_ADMIN',
  suspend: (r?: StaffRole) => r === 'SUPER_ADMIN',
  plan: (r?: StaffRole) => r === 'SUPER_ADMIN' || r === 'BILLING',
  impersonate: (r?: StaffRole) => r === 'SUPER_ADMIN' || r === 'SUPPORT',
  /** #81 รีเซ็ต 2FA ผู้ใช้ลูกค้า — SUPER_ADMIN เท่านั้น (docs/04 A6: SUPPORT ดู + เข้าใช้งานแทน) */
  reset2fa: (r?: StaffRole) => r === 'SUPER_ADMIN',
};

export function useStaff() {
  return useQuery({
    queryKey: ['console', 'me'],
    queryFn: () => cunwrap(consoleApi.GET('/v1/platform/auth/me')),
    staleTime: Infinity,
  });
}
