import { createTmsClient } from '@tms/contracts';

/**
 * Session ของ UI (ST1-T01, T04) — Authorization Code + PKCE (plan/02 T-04)
 * - access token เก็บในหน่วยความจำเท่านั้น (ไม่ลง localStorage — กัน XSS อ่าน)
 * - refresh token อยู่ใน cookie httpOnly `tms_rt` (path /v1/oauth) ที่ browser ส่งเอง
 * - reload หน้า → ขอ access token ใหม่ด้วย refresh cookie
 */
const raw = createTmsClient({ baseUrl: '', getToken: () => null });

let access: { token: string; exp: number } | null = null;
let inflight: Promise<string | null> | null = null;
/** unknown = ยังไม่ได้ลอง refresh ตั้งแต่โหลดหน้า */
export type SessionStatus = 'unknown' | 'in' | 'out';
let status: SessionStatus = 'unknown';
const listeners = new Set<() => void>();

function set(token: string | null, expiresIn = 0) {
  access = token ? { token, exp: Date.now() + expiresIn * 1000 } : null;
  const next: SessionStatus = token ? 'in' : 'out';
  if (next !== status) {
    status = next;
    listeners.forEach((l) => l());
  }
}

export const sessionStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: (): SessionStatus => status,
};

/** access token ที่ยังใช้ได้ (ต่ออายุด้วย refresh cookie เมื่อเหลือ < 60 วินาที) — null = ต้อง login */
export async function getAccessToken(): Promise<string | null> {
  if (access && access.exp - Date.now() > 60_000) return access.token;
  inflight ??= raw
    .POST('/v1/oauth/token', { body: { grantType: 'refresh_token' } })
    .then(({ data }) => {
      set(data?.accessToken ?? null, data?.expiresIn);
      return data?.accessToken ?? null;
    })
    .catch(() => {
      set(null);
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** API ตอบ 401 (token ถูกเพิกถอน/tokenVersion เปลี่ยน) → ทิ้ง token แล้วให้ guard พาไปหน้า login */
export function dropAccessToken() {
  set(null);
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export interface TenantChoice {
  id: string;
  name: string;
  status: string;
}

export type LoginResult = { ok: true } | { ok: false; code: string; tenants?: TenantChoice[] };

/** login → code → token; ผลลัพธ์ผิดคืน code ของ problem+json ให้หน้าจอแปลเป็นข้อความ */
export async function login(
  email: string,
  password: string,
  tenantId?: string,
): Promise<LoginResult> {
  const { verifier, challenge } = await createPkce();
  const r1 = await raw.POST('/v1/auth/login', {
    body: { email, password, codeChallenge: challenge, ...(tenantId ? { tenantId } : {}) },
  });
  if (!r1.data) {
    const p = (r1.error ?? {}) as { code?: string; tenants?: TenantChoice[] };
    return { ok: false, code: p.code ?? 'internal_error', tenants: p.tenants };
  }
  const r2 = await raw.POST('/v1/oauth/token', {
    body: { grantType: 'authorization_code', code: r1.data.code, codeVerifier: verifier },
  });
  if (!r2.data)
    return { ok: false, code: (r2.error as { code?: string })?.code ?? 'internal_error' };
  set(r2.data.accessToken, r2.data.expiresIn);
  return { ok: true };
}

export async function logout(): Promise<void> {
  await raw.POST('/v1/oauth/revoke').catch(() => undefined);
  set(null);
}
