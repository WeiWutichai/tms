import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

/**
 * Access token ของ TMS (T-04) — claim:
 * - `sub` ผู้ใช้ (uuid) หรือ principal อื่น, `tid` tenant uuid, `scope` "resource:verb ..."
 * - `pt` ชนิด principal: `user` (login จริง ตรวจ `tv` กับฐานข้อมูลทุก request) | `dev` (token สำหรับพัฒนา/test — นอกเครื่อง dev/test ปฏิเสธ)
 * - `tv` tokenVersion ของผู้ใช้ตอนออก token (bump แล้ว token เก่าใช้ไม่ได้ทันที — A1)
 *
 * เซ็นแบบ HS256 ด้วย `AUTH_JWT_SECRET` (fallback `AUTH_DEV_SECRET` เฉพาะเครื่อง dev/test)
 * RS256 + JWKS สำหรับ client ภายนอกมาใน ST7-T01 (ตอนนั้นมีผู้ตรวจ token นอกระบบ) — plan/02 T-04
 */
export const ACCESS_TTL_SECONDS = 15 * 60;

/**
 * เครื่องนักพัฒนา/test เท่านั้น (NODE_ENV = development หรือ test เท่านั้น) — staging/production ไม่รับ token `dev`,
 * ไม่ใช้ AUTH_DEV_SECRET และ cookie ต้อง Secure (review 10 พ.ย. 2569 ข้อ 4–5)
 */
export function isLocalEnv(): boolean {
  // ต้องตั้งชัด ๆ เท่านั้น — ลืมตั้ง NODE_ENV ตอน deploy = ถือว่าไม่ใช่เครื่อง dev (fail closed)
  const e = process.env.NODE_ENV;
  return e === 'development' || e === 'test';
}

function secret(): Uint8Array {
  const s = process.env.AUTH_JWT_SECRET ?? (isLocalEnv() ? process.env.AUTH_DEV_SECRET : undefined);
  if (!s || s.length < 32) throw new Error('AUTH_JWT_SECRET (>= 32 chars) required');
  return new TextEncoder().encode(s);
}

/** `imp` = ทีม Innovera เข้าใช้งานแทนผู้ใช้ของลูกค้า (ST1-T24) — sub = ผู้ใช้ที่สวม, act = platform user */
export type PrincipalType = 'user' | 'dev' | 'imp';

export interface AccessClaims {
  sub: string;
  tid: string;
  scope: string;
  pt: PrincipalType;
  tv?: number;
  /** ผู้กระทำจริงเมื่อ impersonate (platform user id — docs/01 §5.4 claim `act`) */
  act?: string;
  /** impersonation session id */
  sid?: string;
}

export async function signAccessToken(c: AccessClaims, ttl: string | number = ACCESS_TTL_SECONDS) {
  const exp = typeof ttl === 'number' ? Math.floor(Date.now() / 1000) + ttl : ttl;
  return new SignJWT({
    tid: c.tid,
    scope: c.scope,
    pt: c.pt,
    ...(c.tv !== undefined ? { tv: c.tv } : {}),
    ...(c.act ? { act: { sub: c.act } } : {}),
    ...(c.sid ? { sid: c.sid } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (typeof payload.tid !== 'string' || !payload.sub) return null;
    if (payload.pur !== undefined) return null; // token เฉพาะทาง (เช่น step-up) ใช้แทน access token ไม่ได้
    const pt: PrincipalType = payload.pt === 'user' ? 'user' : payload.pt === 'imp' ? 'imp' : 'dev';
    if (pt === 'dev' && !isLocalEnv()) return null;
    if (pt === 'user' && typeof payload.tv !== 'number') return null;
    const act = (payload.act as { sub?: unknown } | undefined)?.sub;
    if (pt === 'imp' && (typeof act !== 'string' || typeof payload.sid !== 'string')) return null;
    return {
      sub: payload.sub,
      tid: payload.tid,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
      pt,
      tv: typeof payload.tv === 'number' ? payload.tv : undefined,
      ...(pt === 'imp' ? { act: act as string, sid: payload.sid as string } : {}),
    };
  } catch {
    return null;
  }
}

/** token สุ่ม (base64url 256 bit) + hash ที่เก็บในฐานข้อมูล */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(v: string): string {
  return createHash('sha256').update(v).digest('base64url');
}

/** PKCE S256: BASE64URL(SHA256(verifier)) — RFC 7636 */
export function pkceChallenge(verifier: string): string {
  return sha256(verifier);
}

/** step-up 2FA (ST1-T05; A3 "เปลี่ยน role ต้อง step-up") — อายุ 5 นาที ส่งใน header `X-Step-Up` */
export const STEP_UP_TTL_SECONDS = 5 * 60;

export async function signStepUpToken(sub: string, tid: string): Promise<string> {
  return new SignJWT({ tid, pur: 'step_up' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STEP_UP_TTL_SECONDS)
    .sign(secret());
}

export async function verifyStepUpToken(
  token: string,
): Promise<{ sub: string; tid: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (payload.pur !== 'step_up' || typeof payload.tid !== 'string' || !payload.sub) return null;
    return { sub: payload.sub, tid: payload.tid };
  } catch {
    return null;
  }
}

/**
 * token ของ Platform Console (ST1-T24) — คนละชนิดกับ token ของลูกค้า (`pur: platform` → verifyAccessToken ปฏิเสธ)
 * อายุ 8 ชม. เก็บในหน่วยความจำเท่านั้น (reload = login + 2FA ใหม่) · `tv` = tokenVersion ของ platform user
 */
export const PLATFORM_TTL_SECONDS = 8 * 60 * 60;
export interface PlatformClaims {
  sub: string;
  role: string;
  tv: number;
}
export async function signPlatformToken(c: PlatformClaims, ttl = PLATFORM_TTL_SECONDS) {
  return new SignJWT({ pur: 'platform', role: c.role, tv: c.tv })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(secret());
}
export async function verifyPlatformToken(token: string): Promise<PlatformClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (payload.pur !== 'platform' || !payload.sub || typeof payload.role !== 'string') return null;
    if (typeof payload.tv !== 'number') return null;
    return { sub: payload.sub, role: payload.role, tv: payload.tv };
  } catch {
    return null;
  }
}

/** ขั้นกลางของ login Console (รหัสผ่านผ่านแล้ว รอ TOTP) — อายุ 5 นาที ใช้แทน token อื่นไม่ได้ */
export async function signPlatformChallenge(sub: string) {
  return new SignJWT({ pur: 'platform_mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(secret());
}
export async function verifyPlatformChallenge(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    return payload.pur === 'platform_mfa' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
