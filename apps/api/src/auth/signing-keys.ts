import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
} from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeProtectedHeader, exportJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import { isLocalEnv } from './tokens';

/**
 * กุญแจ RS256 ของ access token ที่ออกให้ client ภายนอก (ST7-T01; docs/04 G1 "JWT RS256 1 ชม.")
 *
 * ที่มาของกุญแจ (ตามลำดับ):
 * 1. `OAUTH_SIGNING_KEYS_DIR` — โฟลเดอร์ไฟล์ `<kid>.pem` (RSA private key PKCS#8/PKCS#1, ≥ 2048 bit)
 *    ไฟล์ที่ชื่อเรียงท้ายสุดใช้เซ็น (ตั้งชื่อตามวันที่ เช่น `2026-11-17.pem`) · ทุกไฟล์ใช้ตรวจ + ประกาศใน JWKS
 * 2. `OAUTH_SIGNING_KEY` — PEM ก้อนเดียว (kid = SHA-256 ของ public key 16 ตัวแรก)
 * 3. เครื่อง dev/test เท่านั้น: สร้างกุญแจชั่วคราวในหน่วยความจำ (restart แล้ว token เดิมใช้ไม่ได้ — client ขอใหม่ได้เอง)
 * staging/production ไม่ตั้ง → ออก token ไม่ได้ (fail closed)
 *
 * หมุนกุญแจ: วางไฟล์ใหม่ (ชื่อเรียงท้าย) → restart → token ใหม่เซ็นด้วยกุญแจใหม่ ส่วน token เก่า (อายุ ≤ 1 ชม.) ยังตรวจผ่าน
 * ด้วยกุญแจเดิม → หลัง 1 ชม. ลบไฟล์เดิมแล้ว restart อีกครั้ง · ผู้ตรวจภายนอกอ่าน `GET /v1/.well-known/jwks.json`
 */
export const CLIENT_TOKEN_TTL_SECONDS = 60 * 60;
export const CLIENT_TOKEN_ISSUER = 'tms';

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

let ring: SigningKey[] | null = null;

function kidOf(pub: KeyObject): string {
  const der = pub.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

function fromPem(pem: string, kid?: string): SigningKey {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('OAuth signing key must be RSA');
  const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < 2048) throw new Error('OAuth signing key must be >= 2048 bit');
  const publicKey = createPublicKey(privateKey);
  return { kid: kid ?? kidOf(publicKey), privateKey, publicKey };
}

function load(): SigningKey[] {
  const dir = process.env.OAUTH_SIGNING_KEYS_DIR;
  if (dir) {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.pem'))
      .sort();
    if (!files.length) throw new Error(`OAUTH_SIGNING_KEYS_DIR (${dir}) has no .pem files`);
    // ตัวท้าย = ตัวเซ็น → เก็บเป็นตัวแรกของ ring
    return files.reverse().map((f) => fromPem(readFileSync(join(dir, f), 'utf8'), f.slice(0, -4)));
  }
  const pem = process.env.OAUTH_SIGNING_KEY;
  if (pem) return [fromPem(pem.replace(/\\n/g, '\n'))];
  if (!isLocalEnv()) throw new Error('OAUTH_SIGNING_KEYS_DIR or OAUTH_SIGNING_KEY required');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return [{ kid: `dev-${kidOf(publicKey)}`, privateKey, publicKey }];
}

function keys(): SigningKey[] {
  ring ??= load();
  return ring;
}

/** สำหรับ test: ล้างกุญแจที่โหลดไว้ (อ่าน env ใหม่) */
export function resetSigningKeys(): void {
  ring = null;
}

export interface ClientClaims {
  /** public id ของ API key (`key_…`) = client_id */
  sub: string;
  tid: string;
  scope: string;
}

/** access token ของ client credentials — `pt: client`, อายุไม่เกิน 1 ชม. (ไม่เกินวันหมดอายุ/เพิกถอนของ key) */
export async function signClientToken(c: ClientClaims, expSeconds: number): Promise<string> {
  const k = keys()[0]!;
  return new SignJWT({ tid: c.tid, scope: c.scope, pt: 'client' })
    .setProtectedHeader({ alg: 'RS256', kid: k.kid, typ: 'at+jwt' })
    .setIssuer(CLIENT_TOKEN_ISSUER)
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .sign(k.privateKey);
}

/** token นี้เซ็นแบบ RS256 ไหม (ดูจาก header ไม่ตรวจลายเซ็น) */
export function isRs256(token: string): boolean {
  try {
    return decodeProtectedHeader(token).alg === 'RS256';
  } catch {
    return false;
  }
}

export async function verifyClientToken(token: string): Promise<ClientClaims | null> {
  try {
    const { payload } = await jwtVerify(
      token,
      async (header) => {
        const k = keys().find((x) => x.kid === header.kid);
        if (!k) throw new Error('unknown kid');
        return k.publicKey;
      },
      { algorithms: ['RS256'], issuer: CLIENT_TOKEN_ISSUER },
    );
    if (payload.pt !== 'client' || typeof payload.tid !== 'string' || !payload.sub) return null;
    return {
      sub: payload.sub,
      tid: payload.tid,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
    };
  } catch {
    return null;
  }
}

/** JWKS สาธารณะ (RFC 7517) — ทุกกุญแจใน ring (รวมตัวเก่าระหว่างหมุน) */
export async function jwks(): Promise<{ keys: JWK[] }> {
  return {
    keys: await Promise.all(
      keys().map(async (k) => ({
        ...(await exportJWK(k.publicKey)),
        kid: k.kid,
        alg: 'RS256',
        use: 'sig',
      })),
    ),
  };
}
