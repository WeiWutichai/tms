import { Injectable } from '@nestjs/common';
import { Prisma, type ApiKey } from '@prisma/client';
import { API_KEY_SCOPES, PERMISSIONS, scopeAllows } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import { AuditService, diff } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import {
  API_KEY_STATUSES,
  type ApiKeyDto,
  type ApiKeyListQuery,
  type ApiKeySecretDto,
  type ApiKeyStatus,
  type ApiKeySummaryDto,
  type CreateApiKeyDto,
  type RevokeApiKeyDto,
  type RotateApiKeyDto,
  type UpdateApiKeyDto,
} from './api-key.dto';
import { generateApiKey, IP_ALLOWLIST_MAX, normalizeIpEntry } from './key-material';

const DAY = 24 * 60 * 60 * 1000;
/** "ใกล้หมดอายุ" (ต้นแบบ specApi: exp ≤ 30 วัน) */
export const EXPIRING_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/** สถานะที่คำนวณจากเวลา (ลำดับ: เพิกถอน > หมดอายุ > หมุน > ใกล้หมดอายุ > ใช้งาน) */
export function apiKeyStatus(k: Pick<ApiKey, 'revokeAt' | 'expiresAt'>, now = new Date()) {
  const t = now.getTime();
  if (k.revokeAt && k.revokeAt.getTime() <= t) return 'revoked' as const;
  if (k.expiresAt && k.expiresAt.getTime() <= t) return 'expired' as const;
  if (k.revokeAt) return 'rotating' as const;
  if (k.expiresAt && k.expiresAt.getTime() <= t + EXPIRING_DAYS * DAY) return 'expiring' as const;
  return 'active' as const;
}

/** where ของแต่ละสถานะ — ตรงกับ apiKeyStatus() */
function statusWhere(s: ApiKeyStatus, now: Date): Prisma.ApiKeyWhereInput {
  const notExpired: Prisma.ApiKeyWhereInput = {
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
  switch (s) {
    case 'revoked':
      return { revokeAt: { lte: now } };
    case 'expired':
      return {
        expiresAt: { lte: now },
        OR: [{ revokeAt: null }, { revokeAt: { gt: now } }],
      };
    case 'rotating':
      return { AND: [{ revokeAt: { gt: now } }, notExpired] };
    case 'expiring':
      return {
        revokeAt: null,
        expiresAt: { gt: now, lte: new Date(now.getTime() + EXPIRING_DAYS * DAY) },
      };
    case 'active':
      // ใช้งานและยังไม่ใกล้หมดอายุ — ตรงกับแท็บ "ใช้งาน" ของต้นแบบ (ใกล้หมดอายุแยกแท็บ)
      return {
        revokeAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date(now.getTime() + EXPIRING_DAYS * DAY) } },
        ],
      };
  }
}

export interface Creator {
  name: string;
  active: boolean;
}

export function toApiKeyDto(k: ApiKey, names?: Map<string, Creator>, now = new Date()): ApiKeyDto {
  const by = k.createdBy && UUID_RE.test(k.createdBy) ? k.createdBy : null;
  return {
    id: encodeId('apiKey', k.id),
    name: k.name,
    mode: k.mode as 'live' | 'test',
    prefix: k.prefix,
    scopes: k.scopes,
    ipAllowlist: k.ipAllowlist,
    status: apiKeyStatus(k, now),
    expiresAt: k.expiresAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: k.lastUsedIp,
    revokeAt: k.revokeAt?.toISOString() ?? null,
    revokeReason: k.revokeReason,
    rotatedToId: k.rotatedToId ? encodeId('apiKey', k.rotatedToId) : null,
    rotatedFromId: k.rotatedFromId ? encodeId('apiKey', k.rotatedFromId) : null,
    createdBy: by ? encodeId('user', by) : null,
    createdByName: by ? (names?.get(by)?.name ?? null) : null,
    // INT-076: ผู้สร้างถูกระงับ/ลบ → key ยังทำงาน แต่หน้าจอแสดงป้ายให้โอนเจ้าของ (key ที่ไม่มีผู้สร้างเป็นคน = ไม่แสดง)
    creatorInactive: by ? names?.get(by)?.active === false || !names?.has(by) : false,
    lastRejectedIp: k.lastRejectedIp,
    lastRejectedAt: k.lastRejectedAt?.toISOString() ?? null,
    version: k.version,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit (ไม่มี secret/hash — AuditService ตัด field ชื่อ hash/secret อีกชั้น) */
function auditView(k: ApiKey) {
  return {
    name: k.name,
    mode: k.mode,
    prefix: k.prefix,
    scopes: k.scopes,
    ipAllowlist: k.ipAllowlist,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revokeAt: k.revokeAt?.toISOString() ?? null,
    rotatedToId: k.rotatedToId ? encodeId('apiKey', k.rotatedToId) : null,
    rotatedFromId: k.rotatedFromId ? encodeId('apiKey', k.rotatedFromId) : null,
  };
}

/**
 * API key ของ tenant (ST7-T01; docs/04 G1 Auth, G2 #10 `api-keys`; spec/07 §6) — จัดการผ่าน `/v1/api-keys`
 * - สิทธิ์: อ่าน `settings:read` · สร้าง/แก้/หมุน/เพิกถอน `settings:write` (A3 แถว "ตั้งค่าองค์กร / … / API key")
 *   + ต้องเป็นผู้ใช้ (API key จัดการ key ด้วยกันเองไม่ได้)
 * - scope ของ key ⊆ PERMISSIONS และผู้สร้างต้องมีสิทธิ์นั้นเอง (INT-073)
 * - secret แสดงครั้งเดียวตอนสร้าง/หมุน (INT-070) · หมุน = ออก key ใหม่ + key เดิมใช้ได้ถึง `revokeAt` ≤ 7 วัน
 * - ทุกการสร้าง/แก้/หมุน/เพิกถอนลง audit · หมุน/เพิกถอนต้องมีเหตุผล ≥ 10 ตัว
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** การจัดการ key ทำได้เฉพาะผู้ใช้ (ไม่ใช่ API key/ลิงก์) */
  assertHuman(): void {
    const pt = requestContext.require().principalType;
    if (pt !== 'user' && pt !== 'dev')
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'api-keys',
        action: 'manage',
        required: ['settings:write'],
      });
  }

  private callerScopes(): string[] {
    return requestContext.require().scopes ?? [];
  }

  private async names(rows: ApiKey[]): Promise<Map<string, Creator>> {
    const ids = [...new Set(rows.map((r) => r.createdBy).filter((x) => x && UUID_RE.test(x)))];
    if (!ids.length) return new Map();
    const users = await this.db.tx.appUser.findMany({
      where: { id: { in: ids as string[] } },
      select: { id: true, name: true, status: true },
    });
    return new Map(users.map((u) => [u.id, { name: u.name, active: u.status === 'ACTIVE' }]));
  }

  async dto(k: ApiKey): Promise<ApiKeyDto> {
    return toApiKeyDto(k, await this.names([k]));
  }

  // ---------- read ----------

  async list(q: ApiKeyListQuery) {
    this.assertHuman();
    const now = new Date();
    const k = keysetArgs(q);
    const and: Prisma.ApiKeyWhereInput[] = [k.where as Prisma.ApiKeyWhereInput];
    if (q.status)
      and.push({ OR: q.status.split(',').map((s) => statusWhere(s as ApiKeyStatus, now)) });
    if (q.name) and.push({ name: { contains: q.name, mode: 'insensitive' } });
    if (q.scope) {
      // ค้นบางส่วน (ช่องกรองคอลัมน์ Scope ของต้นแบบเป็นช่องพิมพ์) — scope ที่ตรงจาก registry
      const hit = PERMISSIONS.filter((s) => s.includes(q.scope!.trim().toLowerCase()));
      and.push({ scopes: { hasSome: hit.length ? hit : ['-'] } });
    }
    if (q.createdBy) {
      const users = await this.db.tx.appUser.findMany({
        where: { name: { contains: q.createdBy, mode: 'insensitive' } },
        select: { id: true },
      });
      and.push({ createdBy: { in: users.map((u) => u.id) } });
    }
    const rows = await this.db.tx.apiKey.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.ApiKeyOrderByWithRelationInput[],
      take: k.take,
    });
    const names = await this.names(rows);
    return toPage(rows, k, (r) => toApiKeyDto(r, names, now), q.fields);
  }

  async summary(): Promise<ApiKeySummaryDto> {
    this.assertHuman();
    const now = new Date();
    const counts = await Promise.all(
      API_KEY_STATUSES.map((s) => this.db.tx.apiKey.count({ where: statusWhere(s, now) })),
    );
    const by = Object.fromEntries(API_KEY_STATUSES.map((s, i) => [s, counts[i]!])) as Record<
      ApiKeyStatus,
      number
    >;
    return { all: await this.db.tx.apiKey.count(), ...by };
  }

  async get(id: string): Promise<ApiKey> {
    this.assertHuman();
    const k = await this.db.tx.apiKey.findUnique({ where: { id } });
    if (!k) throw new ProblemException('not_found');
    return k;
  }

  /** scope ที่ให้ key ได้ (API_KEY_SCOPES — ไม่มีงานบริหารผู้ใช้/ตั้งค่า) + ผู้เรียกให้ได้ไหม */
  scopeOptions() {
    this.assertHuman();
    const mine = this.callerScopes();
    return {
      data: API_KEY_SCOPES.map((scope) => ({ scope, grantable: scopeAllows(mine, scope) })),
    };
  }

  // ---------- validate ----------

  private checkScopes(scopes: string[]): string[] {
    const uniq = [...new Set(scopes)];
    const known = new Set<string>(API_KEY_SCOPES);
    const mine = this.callerScopes();
    for (const s of uniq) {
      if (!known.has(s)) throw field422('scopes', 'unknown_scope', `unknown scope ${s}`);
      if (!scopeAllows(mine, s))
        throw field422('scopes', 'scope_not_grantable', `you do not hold scope ${s}`);
    }
    return uniq.sort();
  }

  private checkIps(list: string[]): string[] {
    const out: string[] = [];
    for (const raw of list) {
      if (!raw.trim()) continue;
      const n = normalizeIpEntry(raw);
      if (!n) throw field422('ipAllowlist', 'invalid_ip', `invalid IP or CIDR: ${raw}`);
      if (!out.includes(n)) out.push(n);
    }
    if (out.length > IP_ALLOWLIST_MAX)
      throw field422('ipAllowlist', 'too_many', `at most ${IP_ALLOWLIST_MAX} entries`);
    return out;
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const dup = await this.db.tx.apiKey.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        revokeAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (dup) throw new ProblemException('duplicate', undefined, [nameDup]);
  }

  // ---------- write ----------

  async create(body: CreateApiKeyDto): Promise<ApiKeySecretDto> {
    this.assertHuman();
    const ctx = requestContext.require();
    const mode = body.mode ?? 'live';
    // sandbox (tenant mode test) ยังไม่มี — key test ที่เห็นข้อมูลจริงจะผิดหลัก G1 Sandbox → รอ ST7-T09
    if (mode === 'test')
      throw field422('mode', 'sandbox_not_available', 'test keys require sandbox (ST7-T09)');
    const scopes = this.checkScopes(body.scopes);
    const ipAllowlist = this.checkIps(body.ipAllowlist ?? []);
    const name = body.name.trim();
    await this.assertNameFree(name);
    const ttl = body.expiresInDays === undefined ? 90 : body.expiresInDays;
    const now = new Date();
    const m = generateApiKey(mode);
    const row = await this.insert({
      id: randomUUID(),
      tenantId: ctx.tenantId!,
      name,
      mode,
      prefix: m.prefix,
      secretHash: m.hash,
      scopes,
      ipAllowlist,
      expiresAt: ttl === null ? null : new Date(now.getTime() + ttl * DAY),
      createdBy: ctx.actorId ?? null,
    });
    await this.audit.record({
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: row.id,
      after: auditView(row),
    });
    return { ...(await this.dto(row)), secret: m.key, clientId: encodeId('apiKey', row.id) };
  }

  private async insert(data: Prisma.ApiKeyUncheckedCreateInput): Promise<ApiKey> {
    try {
      return await this.db.tx.apiKey.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ProblemException('duplicate', undefined, [nameDup]);
      throw e;
    }
  }

  async update(id: string, body: UpdateApiKeyDto, expected?: number): Promise<ApiKey> {
    this.assertHuman();
    const cur = await this.get(id);
    if (apiKeyStatus(cur) === 'revoked') throw new ProblemException('invalid_state_transition');
    if (expected !== undefined && expected !== cur.version)
      throw new ProblemException('precondition_failed');
    const data: Prisma.ApiKeyUpdateManyMutationInput = {};
    if (body.name !== undefined && body.name.trim() !== cur.name) {
      const name = body.name.trim();
      if (cur.revokeAt === null) await this.assertNameFree(name, cur.id);
      data.name = name;
    }
    if (body.scopes !== undefined) {
      // scope ที่ key มีอยู่แล้วคงไว้ได้แม้ผู้แก้ไม่มีสิทธิ์นั้น — ตรวจเฉพาะ scope ที่เพิ่มใหม่ (INT-073)
      const added = body.scopes.filter((s) => !cur.scopes.includes(s));
      this.checkScopes(added);
      const known = new Set<string>(API_KEY_SCOPES);
      for (const s of body.scopes)
        if (!known.has(s)) throw field422('scopes', 'unknown_scope', `unknown scope ${s}`);
      const next = [...new Set(body.scopes)].sort();
      if (next.join(' ') !== cur.scopes.join(' ')) data.scopes = next;
    }
    if (body.ipAllowlist !== undefined) {
      const next = this.checkIps(body.ipAllowlist);
      if (next.join(',') !== cur.ipAllowlist.join(',')) data.ipAllowlist = next;
    }
    if (Object.keys(data).length === 0) return cur;
    const n = await this.db.tx.apiKey
      .updateMany({
        where: { id: cur.id, version: cur.version },
        data: { ...data, version: { increment: 1 } },
      })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ProblemException('duplicate', undefined, [nameDup]);
        throw e;
      });
    if (n.count === 0) throw new ProblemException('precondition_failed');
    const row = await this.get(cur.id);
    const d = diff(auditView(cur), auditView(row));
    await this.audit.record({
      action: 'api_key.updated',
      entityType: 'api_key',
      entityId: row.id,
      before: d.before,
      after: d.after,
    });
    return row;
  }

  /** หมุน: ออก key ใหม่ (scope/IP/ชื่อเดิม) + key เดิมใช้ได้อีก graceHours (ค่าเริ่ม 24, ≤ 168) */
  async rotate(id: string, body: RotateApiKeyDto, expected?: number): Promise<ApiKeySecretDto> {
    this.assertHuman();
    const ctx = requestContext.require();
    const cur = await this.get(id);
    const st = apiKeyStatus(cur);
    // หมุนซ้ำ key ที่กำลังหมุนอยู่ไม่ได้ (มี key ใหม่แล้ว) · เพิกถอนแล้วหมุนไม่ได้
    if (st === 'revoked' || st === 'rotating' || cur.revokeAt)
      throw new ProblemException('invalid_state_transition');
    if (expected !== undefined && expected !== cur.version)
      throw new ProblemException('precondition_failed');
    // ผู้หมุนต้องให้ scope เดิมได้ทั้งหมด (INT-073)
    this.checkScopes(cur.scopes);
    const now = new Date();
    const grace = body.graceHours ?? 24;
    const newId = randomUUID();
    const n = await this.db.tx.apiKey.updateMany({
      where: { id: cur.id, version: cur.version, revokeAt: null },
      data: {
        revokeAt: new Date(now.getTime() + grace * 60 * 60 * 1000),
        revokeReason: body.reason,
        revokedBy: ctx.actorId ?? null,
        rotatedToId: newId,
        version: { increment: 1 },
      },
    });
    if (n.count === 0) throw new ProblemException('precondition_failed');
    const lifetime =
      cur.expiresAt === null ? null : cur.expiresAt.getTime() - cur.createdAt.getTime();
    const m = generateApiKey(cur.mode as 'live' | 'test');
    const row = await this.insert({
      id: newId,
      tenantId: cur.tenantId,
      name: cur.name,
      mode: cur.mode,
      prefix: m.prefix,
      secretHash: m.hash,
      scopes: cur.scopes,
      ipAllowlist: cur.ipAllowlist,
      expiresAt: lifetime === null ? null : new Date(now.getTime() + lifetime),
      rotatedFromId: cur.id,
      createdBy: ctx.actorId ?? null,
    });
    const old = await this.get(cur.id);
    await this.audit.record({
      action: 'api_key.rotated',
      entityType: 'api_key',
      entityId: cur.id,
      before: { revokeAt: null, rotatedToId: null },
      after: {
        revokeAt: old.revokeAt?.toISOString() ?? null,
        rotatedToId: encodeId('apiKey', newId),
        graceHours: grace,
      },
      reason: body.reason,
    });
    await this.audit.record({
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: row.id,
      after: auditView(row),
      reason: body.reason,
    });
    return { ...(await this.dto(row)), secret: m.key, clientId: encodeId('apiKey', row.id) };
  }

  /** เพิกถอน — มีผลทันที (ทุก request ตรวจกับฐาน) · key ที่กำลังหมุนก็หยุดทันที */
  async revoke(id: string, body: RevokeApiKeyDto, expected?: number): Promise<ApiKey> {
    this.assertHuman();
    const ctx = requestContext.require();
    const cur = await this.get(id);
    if (apiKeyStatus(cur) === 'revoked') throw new ProblemException('invalid_state_transition');
    if (expected !== undefined && expected !== cur.version)
      throw new ProblemException('precondition_failed');
    const now = new Date();
    const n = await this.db.tx.apiKey.updateMany({
      where: {
        id: cur.id,
        version: cur.version,
        OR: [{ revokeAt: null }, { revokeAt: { gt: now } }],
      },
      data: {
        revokeAt: now,
        // หมุนแล้วมาเพิกถอน: เก็บเหตุผลการเพิกถอน (เหตุผลการหมุนอยู่ใน audit แล้ว)
        revokeReason: body.reason,
        revokedBy: ctx.actorId ?? null,
        version: { increment: 1 },
      },
    });
    if (n.count === 0) throw new ProblemException('precondition_failed');
    // key นี้มาจากการหมุน: เพิกถอน key ใหม่ = จบช่วงผ่อนผันของ key เดิมทันทีด้วย (กรณี secret รั่ว — ไม่ให้ key เดิมใช้ต่อ)
    // [DECISION spec/12 §3]
    if (cur.rotatedFromId) {
      const prev = await this.db.tx.apiKey.updateMany({
        where: { id: cur.rotatedFromId, revokeAt: { gt: now } },
        data: { revokeAt: now, version: { increment: 1 } },
      });
      if (prev.count)
        await this.audit.record({
          action: 'api_key.revoked',
          entityType: 'api_key',
          entityId: cur.rotatedFromId,
          before: { status: 'rotating' },
          after: {
            status: 'revoked',
            revokeAt: now.toISOString(),
            bySuccessor: encodeId('apiKey', cur.id),
          },
          reason: body.reason,
        });
    }
    const row = await this.get(cur.id);
    await this.audit.record({
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: row.id,
      before: { status: apiKeyStatus(cur, now), revokeAt: cur.revokeAt?.toISOString() ?? null },
      after: { status: 'revoked', revokeAt: now.toISOString() },
      reason: body.reason,
    });
    return row;
  }
}

const nameDup = {
  field: 'name',
  code: 'duplicate',
  message: 'an active key with this name exists',
};
