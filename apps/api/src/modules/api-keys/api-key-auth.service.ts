import { Injectable } from '@nestjs/common';
import { API_KEY_SCOPES } from '@tms/domain';
import type { ApiKey } from '@prisma/client';
import {
  CLIENT_TOKEN_TTL_SECONDS,
  signClientToken,
  type ClientClaims,
} from '../../auth/signing-keys';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { PrismaService } from '../../db/prisma.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { apiKeyStatus } from './api-keys.service';
import { API_KEY_RE, hashApiKey, ipAllowed, sameHash } from './key-material';

/** กันชั้นที่ 2: scope ที่ห้ามให้ key (users/settings:write) ไม่ถูกใช้แม้มีค้างในแถว */
const allowed = (scopes: string[]) =>
  scopes.filter((s) => (API_KEY_SCOPES as readonly string[]).includes(s));

/** tenant ที่เรียก API ได้ (เหมือน login — spec/01 PLT-001) */
const API_TENANT_STATUSES = ['TRIAL', 'ACTIVE'];
/** เขียน lastUsedAt ไม่ถี่กว่านี้ (กันเขียนฐานทุก request) — IP เปลี่ยนเขียนทันที */
const TOUCH_EVERY_MS = 60_000;

export interface KeyPrincipal {
  keyId: string;
  tenantId: string;
  scopes: string[];
  /** ST7-T07 เวอร์ชันที่ pin ไว้บน key (YYYY-MM-DD) — null = ตามวันสร้างบริษัท */
  apiVersion: string | null;
}

const pinOf = (k: ApiKey) => k.apiVersion?.toISOString().slice(0, 10) ?? null;

/**
 * ยืนยันตัวตนด้วย API key (ST7-T01; docs/04 G1) — 2 ทาง ได้ principal `client` แบบเดียวกัน:
 * 1. `Authorization: Bearer tk_live_…` (static key)
 * 2. `POST /oauth/token` grantType=client_credentials → JWT RS256 1 ชม. → `Authorization: Bearer <jwt>`
 * ทุก request ตรวจ key กับฐานอีกครั้ง (เพิกถอน/หมดอายุ/IP/scope ที่ลดลง มีผลทันที — INT-072)
 * ใช้ client platform (ยังไม่รู้ tenant จนกว่าจะหา key เจอ) — อ่านเฉพาะตาราง api_key + tenant
 */
@Injectable()
export class ApiKeyAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  private get db() {
    return this.prisma.platform;
  }

  /** ตรวจ key ที่หาเจอแล้ว: สถานะ tenant → เพิกถอน → หมดอายุ → IP → แพ็กเกจมี Open API */
  private async check(k: ApiKey, ip: string | undefined): Promise<void> {
    // ST7-T09: key `tk_test_` อยู่ในแถว sandbox — สถานะที่ใช้ = ของบริษัทจริง (ระงับบริษัท = sandbox หยุดด้วย)
    const own = await this.db.tenant.findUnique({
      where: { id: k.tenantId },
      select: { mode: true, liveTenantId: true },
    });
    if (!own || (own.mode === 'test') !== (k.mode === 'test'))
      throw new ProblemException('unauthorized'); // key live ในแถว sandbox (หรือกลับกัน) ห้ามใช้
    const t = await this.db.tenant.findFirst({
      where: {
        id: own.mode === 'test' ? own.liveTenantId! : k.tenantId,
        mode: 'live',
        status: { in: API_TENANT_STATUSES as never },
      },
      select: { id: true },
    });
    if (!t) throw new ProblemException('unauthorized');
    const st = apiKeyStatus(k);
    if (st === 'revoked') throw new ProblemException('key_revoked');
    if (st === 'expired') throw new ProblemException('key_expired');
    if (!ipAllowed(k.ipAllowlist, ip)) {
      // INT-075: เก็บ IP ที่ถูกปฏิเสธล่าสุดไว้บน key (ไม่แตะ updated_at/version)
      await this.db.$executeRaw`
        UPDATE api_key SET last_rejected_ip = ${ip ?? null}, last_rejected_at = now()
         WHERE id = ${k.id}::uuid`.catch(() => undefined);
      throw new ProblemException('ip_not_allowed');
    }
    if (!(await this.entitlements.enabled(k.tenantId, 'api')))
      throw new ProblemException('feature_not_in_plan', undefined, undefined, {
        featureKey: 'api',
      });
  }

  /** หา key จาก secret (HMAC lookup + เทียบแบบเวลาคงที่) — ไม่พบ = null */
  private async bySecret(secret: string): Promise<ApiKey | null> {
    if (!API_KEY_RE.test(secret)) return null;
    const h = hashApiKey(secret);
    const k = await this.db.apiKey.findUnique({ where: { secretHash: h } });
    return k && sameHash(k.secretHash, h) ? k : null;
  }

  private async touch(k: ApiKey, ip: string | undefined) {
    const now = new Date();
    if (
      k.lastUsedAt &&
      now.getTime() - k.lastUsedAt.getTime() < TOUCH_EVERY_MS &&
      (k.lastUsedIp ?? null) === (ip ?? null)
    )
      return;
    // ไม่แตะ updated_at/version (ไม่ใช่การแก้ key) — raw SQL เพราะ @updatedAt ของ Prisma ตั้งให้อัตโนมัติ
    await this.db.$executeRaw`
      UPDATE api_key SET last_used_at = ${now}, last_used_ip = ${ip ?? null}
       WHERE id = ${k.id}::uuid
         AND (last_used_at IS NULL OR last_used_at < ${new Date(now.getTime() - TOUCH_EVERY_MS)}
              OR last_used_ip IS DISTINCT FROM ${ip ?? null})`.catch(() => undefined);
  }

  /** Bearer `tk_live_…` */
  async authenticateSecret(secret: string, ip: string | undefined): Promise<KeyPrincipal> {
    const k = await this.bySecret(secret);
    if (!k) throw new ProblemException('unauthorized');
    await this.check(k, ip);
    await this.touch(k, ip);
    return { keyId: k.id, tenantId: k.tenantId, scopes: allowed(k.scopes), apiVersion: pinOf(k) };
  }

  /** Bearer JWT จาก client credentials — scope = ที่ token ได้ ∩ scope ปัจจุบันของ key */
  async authenticateClient(c: ClientClaims, ip: string | undefined): Promise<KeyPrincipal> {
    const id = tryDecodeId('apiKey', c.sub);
    const k = id ? await this.db.apiKey.findUnique({ where: { id } }) : null;
    if (!k || k.tenantId !== c.tid) throw new ProblemException('unauthorized');
    await this.check(k, ip);
    await this.touch(k, ip);
    const granted = c.scope ? c.scope.split(' ') : [];
    return {
      keyId: k.id,
      tenantId: k.tenantId,
      scopes: allowed(granted.filter((s) => k.scopes.includes(s))),
      apiVersion: pinOf(k),
    };
  }

  /**
   * OAuth2 client credentials (RFC 6749 §4.4): client_id = `key_…`, client_secret = API key เต็ม
   * scope ที่ขอ ⊆ scope ของ key (ไม่ส่ง = ทั้งหมด) · token อายุ ≤ 1 ชม. และไม่เกินวันหมดอายุ/เพิกถอนของ key
   */
  async issueToken(
    clientId: string,
    clientSecret: string,
    scope: string | undefined,
    ip: string | undefined,
  ): Promise<{ accessToken: string; expiresIn: number; scope: string }> {
    const k = await this.bySecret(clientSecret);
    // client_id = `key_…` หรือ prefix ที่แสดงในหน้าจอ (`tk_live_8f3a`) — secret เป็นตัวยืนยันจริง client_id แค่ต้องตรงกัน
    if (!k || (encodeId('apiKey', k.id) !== clientId && k.prefix !== clientId))
      throw new ProblemException('invalid_client');
    await this.check(k, ip);
    const asked = scope?.trim() ? [...new Set(scope.trim().split(/\s+/))] : k.scopes;
    if (asked.some((s) => !k.scopes.includes(s))) throw new ProblemException('invalid_scope');
    const now = Math.floor(Date.now() / 1000);
    let exp = now + CLIENT_TOKEN_TTL_SECONDS;
    for (const d of [k.expiresAt, k.revokeAt])
      if (d) exp = Math.min(exp, Math.floor(d.getTime() / 1000));
    const s = [...asked].sort().join(' ');
    const accessToken = await signClientToken(
      { sub: encodeId('apiKey', k.id), tid: k.tenantId, scope: s },
      exp,
    );
    await this.touch(k, ip);
    return { accessToken, expiresIn: Math.max(0, exp - now), scope: s };
  }
}
