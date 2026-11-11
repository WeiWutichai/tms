import { createTmsClient, type Problem } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api';

/**
 * Session ของ Platform Console (ST1-T24) — แยกจาก session ลูกค้า (auth/session.ts) ทั้ง token และ client
 * token อยู่ในหน่วยความจำเท่านั้น (ไม่มี refresh cookie) → reload หน้า = เข้าสู่ระบบใหม่ (บังคับ 2FA ทุกครั้ง)
 */
let current: { token: string; exp: number } | null = null;
const listeners = new Set<() => void>();

function set(token: string | null, expiresIn = 0) {
  current = token ? { token, exp: Date.now() + expiresIn * 1000 } : null;
  listeners.forEach((l) => l());
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
    if (r.response.status === 401) set(null);
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
};

export function useStaff() {
  return useQuery({
    queryKey: ['console', 'me'],
    queryFn: () => cunwrap(consoleApi.GET('/v1/platform/auth/me')),
    staleTime: Infinity,
  });
}
