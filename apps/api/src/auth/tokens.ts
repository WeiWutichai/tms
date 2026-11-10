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

export type PrincipalType = 'user' | 'dev';

export interface AccessClaims {
  sub: string;
  tid: string;
  scope: string;
  pt: PrincipalType;
  tv?: number;
}

export async function signAccessToken(c: AccessClaims, ttl: string | number = ACCESS_TTL_SECONDS) {
  const exp = typeof ttl === 'number' ? Math.floor(Date.now() / 1000) + ttl : ttl;
  return new SignJWT({
    tid: c.tid,
    scope: c.scope,
    pt: c.pt,
    ...(c.tv !== undefined ? { tv: c.tv } : {}),
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
    const pt: PrincipalType = payload.pt === 'user' ? 'user' : 'dev';
    if (pt === 'dev' && !isLocalEnv()) return null;
    if (pt === 'user' && typeof payload.tv !== 'number') return null;
    return {
      sub: payload.sub,
      tid: payload.tid,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
      pt,
      tv: typeof payload.tv === 'number' ? payload.tv : undefined,
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
