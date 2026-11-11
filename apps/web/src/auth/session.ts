import { createTmsClient } from '@tms/contracts';

/**
 * Session ของ UI (ST1-T01, T04) — Authorization Code + PKCE (plan/02 T-04)
 * - access token เก็บในหน่วยความจำเท่านั้น (ไม่ลง localStorage — กัน XSS อ่าน)
 * - refresh token อยู่ใน cookie httpOnly `tms_rt` (path /v1/oauth) ที่ browser ส่งเอง
 * - reload หน้า → ขอ access token ใหม่ด้วย refresh cookie
 */
const raw = createTmsClient({ baseUrl: '', getToken: () => null });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let access: { token: string; exp: number } | null = null;
/**
 * เข้าใช้งานแทน (ST1-T24): token อ่านอย่างเดียวจาก Platform Console อยู่ในหน่วยความจำของแท็บนี้เท่านั้น
 * ห้ามต่ออายุด้วย refresh cookie (อาจเป็น session จริงของผู้ใช้อื่นในเบราว์เซอร์เดียวกัน) — หมดอายุ = ออก
 */
let impersonating = false;
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
  if (impersonating) {
    if (access && access.exp > Date.now()) return access.token;
    set(null);
    return null;
  }
  if (access && access.exp - Date.now() > 60_000) return access.token;
  const once = () => raw.POST('/v1/oauth/token', { body: { grantType: 'refresh_token' } });
  inflight ??= once()
    // อีกแท็บ/หน้าก่อนเพิ่งหมุน refresh token (อาจยังทำไม่เสร็จ) → ลองซ้ำสูงสุด 3 ครั้ง (API ให้ grace 30 วินาที)
    .then(async (r) => {
      for (const ms of [400, 1000, 2000]) {
        if (r.data || r.response.status !== 400) break;
        await wait(ms);
        r = await once();
      }
      return r;
    })
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

export type LoginResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      tenants?: TenantChoice[];
      /** ขั้นที่ 2 (ST1-T05): ใช้ต่อกับ verifyMfa / startEnroll / confirmEnroll */
      mfa?: MfaStep;
    };

export interface MfaStep {
  mfaToken: string;
  verifier: string;
}

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
    const p = (r1.error ?? {}) as { code?: string; tenants?: TenantChoice[]; mfaToken?: string };
    return {
      ok: false,
      code: p.code ?? 'internal_error',
      tenants: p.tenants,
      ...(p.mfaToken ? { mfa: { mfaToken: p.mfaToken, verifier } } : {}),
    };
  }
  return exchange(r1.data.code, verifier);
}

async function exchange(code: string, verifier: string): Promise<LoginResult> {
  const r2 = await raw.POST('/v1/oauth/token', {
    body: { grantType: 'authorization_code', code, codeVerifier: verifier },
  });
  if (!r2.data)
    return { ok: false, code: (r2.error as { code?: string })?.code ?? 'internal_error' };
  impersonating = false;
  set(r2.data.accessToken, r2.data.expiresIn);
  return { ok: true };
}

const problemCode = (e: unknown) => (e as { code?: string } | undefined)?.code ?? 'internal_error';

/** ขั้นที่ 2: รหัสจากแอป หรือ backup code */
export async function verifyMfa(
  step: MfaStep,
  input: { otp?: string; backupCode?: string; rememberDevice?: boolean },
): Promise<LoginResult> {
  const r = await raw.POST('/v1/auth/2fa/verify', {
    body: { mfaToken: step.mfaToken, ...input, rememberDevice: input.rememberDevice ?? false },
  });
  if (!r.data) return { ok: false, code: problemCode(r.error) };
  return exchange(r.data.code, step.verifier);
}

export async function startEnroll(
  step: MfaStep,
): Promise<{ secret: string; otpauthUri: string } | { error: string }> {
  const r = await raw.POST('/v1/auth/2fa/enroll', { body: { mfaToken: step.mfaToken } });
  return r.data ?? { error: problemCode(r.error) };
}

/** ยืนยันรหัสแรก → ได้ backup code (ยังไม่เข้าระบบจนกว่าผู้ใช้กด "ดำเนินการต่อ" → finishEnroll) */
export async function confirmEnroll(
  step: MfaStep,
  otp: string,
): Promise<{ code: string; backupCodes: string[] } | { error: string }> {
  const r = await raw.POST('/v1/auth/2fa/enroll/confirm', {
    body: { mfaToken: step.mfaToken, otp },
  });
  return r.data ?? { error: problemCode(r.error) };
}

export function finishEnroll(step: MfaStep, code: string): Promise<LoginResult> {
  return exchange(code, step.verifier);
}

export async function logout(): Promise<void> {
  if (impersonating) return endImpersonation();
  await raw.POST('/v1/oauth/revoke').catch(() => undefined);
  set(null);
}

/** วันหมดอายุจาก claim `exp` ของ JWT (ใช้แค่ตั้งเวลาฝั่ง UI — server ตรวจเอง) */
function jwtExp(token: string): number | null {
  try {
    const part = token.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** เริ่มเข้าใช้งานแทนด้วย token จากลิงก์ของ Console (#token=…) — false = token ใช้ไม่ได้/หมดอายุ */
export function startImpersonation(token: string): boolean {
  const exp = jwtExp(token);
  if (!exp || exp <= Date.now()) return false;
  impersonating = true;
  access = { token, exp };
  if (status !== 'in') {
    status = 'in';
    listeners.forEach((l) => l());
  }
  return true;
}

/** ปุ่ม "ออก" บนแถบส้ม: ปิด session ฝั่ง server แล้วทิ้ง token (ยังไม่ใช้ refresh cookie ในแท็บนี้) */
export async function endImpersonation(): Promise<void> {
  const token = access?.token;
  if (token)
    await raw
      .POST('/v1/me/impersonation/end', { headers: { Authorization: `Bearer ${token}` } })
      .catch(() => undefined);
  set(null);
}

/** กำลังเข้าใช้งานแทน (อ่านอย่างเดียว — ST1-T24) — UI เลี่ยงขั้นที่ทำไม่ได้ เช่น ยืนยัน 2FA ของลูกค้า */
export function isImpersonating(): boolean {
  return impersonating;
}
