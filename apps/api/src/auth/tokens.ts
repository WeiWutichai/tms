import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

/**
 * Access token ของ TMS (T-04) — claim:
 * - `sub` ผู้ใช้ (uuid) หรือ principal อื่น, `tid` tenant uuid, `scope` "resource:verb ..."
 * - `pt` ชนิด principal: `user` (login จริง ตรวจ `tv` กับฐานข้อมูลทุก request) | `dev` (token สำหรับพัฒนา/test — production ปฏิเสธ)
 * - `tv` tokenVersion ของผู้ใช้ตอนออก token (bump แล้ว token เก่าใช้ไม่ได้ทันที — A1)
 *
 * เซ็นแบบ HS256 ด้วย `AUTH_JWT_SECRET` (fallback `AUTH_DEV_SECRET` นอก production)
 * RS256 + JWKS สำหรับ client ภายนอกมาใน ST7-T01 (ตอนนั้นมีผู้ตรวจ token นอกระบบ) — plan/02 T-04
 */
export const ACCESS_TTL_SECONDS = 15 * 60;

function secret(): Uint8Array {
  const prod = process.env.NODE_ENV === 'production';
  const s = process.env.AUTH_JWT_SECRET ?? (prod ? undefined : process.env.AUTH_DEV_SECRET);
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
    const pt: PrincipalType = payload.pt === 'user' ? 'user' : 'dev';
    if (pt === 'dev' && process.env.NODE_ENV === 'production') return null;
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
