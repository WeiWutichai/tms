import { Injectable } from '@nestjs/common';
import { Prisma, type WebhookEndpoint } from '@prisma/client';
import { WEBHOOK_ROTATION_GRACE_HOURS } from '@tms/domain';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { OutboxService } from '../integration/outbox.service';
import { generateWebhookSecret } from './signature';
import { checkUrlShape, resolvePublic, SsrfBlockedError, urlHost } from './ssrf';
import type {
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookActionDto,
  WebhookReasonDto,
  WebhookEndpointDto,
  WebhookEndpointSecretDto,
  WebhookHeaderDto,
  WebhookListQuery,
  WebhookStatus,
  WebhookSummaryDto,
  WebhookTestDto,
  WebhookTestResultDto,
} from './webhook.dto';
import { RESERVED_HEADER, WebhookEngine } from './webhook-engine';
import { VERIFICATION_OP, WEBHOOK_SINK } from './webhook.sink';

const DAY = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** resolve DNS ตอนบันทึกไม่เกินนี้ (ตรวจซ้ำทุกครั้งที่ส่งอยู่แล้ว — resolve ไม่ได้ตอนบันทึก = ยอม) */
const SAVE_DNS_TIMEOUT_MS = 3000;

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/** event ล่าสุดล้ม (ยังไม่ครบ 50) = "ล้มเหลวต่อเนื่อง" — เงื่อนไขเดียวกับ SQL ใน statusIds() */
export function webhookStatus(e: WebhookEndpoint): WebhookStatus {
  if (e.status === 'DISABLED') return 'disabled';
  if (e.status === 'AUTO_DISABLED') return 'auto_disabled';
  const lastFailed = !!e.lastFailureAt && (!e.lastSuccessAt || e.lastSuccessAt < e.lastFailureAt);
  return e.consecutiveFailures > 0 || lastFailed ? 'failing' : 'active';
}

const STATUS_SQL: Record<WebhookStatus, Prisma.Sql> = {
  disabled: Prisma.sql`status = 'DISABLED'`,
  auto_disabled: Prisma.sql`status = 'AUTO_DISABLED'`,
  failing: Prisma.sql`status = 'ACTIVE' AND (consecutive_failures > 0
    OR last_failure_at > coalesce(last_success_at, '-infinity'::timestamptz))`,
  active: Prisma.sql`status = 'ACTIVE' AND consecutive_failures = 0
    AND NOT coalesce(last_failure_at > coalesce(last_success_at, '-infinity'::timestamptz), false)`,
};

interface Stats {
  rate: Map<string, number>;
  names: Map<string, string>;
}

function auditView(e: WebhookEndpoint) {
  return {
    url: e.url,
    description: e.description,
    events: e.events,
    extraHeaderNames: e.extraHeaderNames,
    status: e.status,
  };
}

/**
 * Webhook endpoint ของ tenant (ST7-T04; docs/04 G1 Webhook, G2 #2 `webhooks`; spec/07 §10)
 * - สิทธิ์: อ่าน `settings:read` · จัดการ `settings:write` + ต้องเป็นผู้ใช้ (หน้า นักพัฒนา / Open API แถว A3 เดียวกับ API key)
 *   [DECISION spec/12 §3 — scope `webhooks:manage` ของ API key รอเปิดพร้อม Open API สาธารณะ]
 * - ฟีเจอร์ `webhook` ของแพ็กเกจ + จำนวน endpoint ตาม limit (มาตรฐาน 3)
 * - secret `whsec_…` สร้างฝั่งเซิร์ฟเวอร์ แสดงครั้งเดียว เก็บเข้ารหัส (FieldCipher) · หมุน = secret ใหม่ + เดิมเซ็นคู่ 24 ชม.
 * - endpoint ↔ integration_subscription (sink `webhook`) — event ใหม่เข้าคิว outbox ใน transaction เดียวกับ event (T03)
 * - สร้าง/แก้/หมุน/ปิด/เปิด/ลบ ลง audit (INT-003) · ไม่มี hard delete
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly engine: WebhookEngine,
    private readonly entitlements: EntitlementService,
  ) {}

  assertHuman(): void {
    const pt = requestContext.require().principalType;
    if (pt !== 'user' && pt !== 'dev')
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'webhooks',
        action: 'manage',
        required: ['settings:write'],
      });
  }

  // ---------- read ----------

  private async stats(tx: Tx, rows: WebhookEndpoint[]): Promise<Stats> {
    const ids = rows.map((r) => r.id);
    const rate = new Map<string, number>();
    const names = new Map<string, string>();
    if (!ids.length) return { rate, names };
    const since = new Date(Date.now() - 7 * DAY);
    const g = await tx.webhookDelivery.groupBy({
      by: ['endpointId', 'status'],
      where: { endpointId: { in: ids }, test: false, sentAt: { gte: since } },
      _count: { _all: true },
    });
    const tot = new Map<string, { ok: number; all: number }>();
    for (const r of g) {
      const t = tot.get(r.endpointId) ?? { ok: 0, all: 0 };
      t.all += r._count._all;
      if (r.status === 'DELIVERED') t.ok += r._count._all;
      tot.set(r.endpointId, t);
    }
    for (const [id, t] of tot) rate.set(id, Math.round((t.ok / t.all) * 1000) / 10);
    const users = [...new Set(rows.map((r) => r.createdBy).filter((x) => x && UUID_RE.test(x)))];
    if (users.length)
      for (const u of await tx.appUser.findMany({
        where: { id: { in: users as string[] } },
        select: { id: true, name: true },
      }))
        names.set(u.id, u.name);
    return { rate, names };
  }

  toDto(e: WebhookEndpoint, s?: Stats): WebhookEndpointDto {
    const by = e.createdBy && UUID_RE.test(e.createdBy) ? e.createdBy : null;
    const prevLive = e.secretPrevExpiresAt && e.secretPrevExpiresAt > new Date();
    return {
      id: encodeId('webhookEndpoint', e.id),
      url: e.url,
      description: e.description,
      events: e.events,
      extraHeaderNames: e.extraHeaderNames,
      status: webhookStatus(e),
      consecutiveFailures: e.consecutiveFailures,
      successRate7d: s?.rate.get(e.id) ?? null,
      lastDeliveryAt: e.lastDeliveryAt?.toISOString() ?? null,
      lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null,
      verifiedAt: e.verifiedAt?.toISOString() ?? null,
      secretRotatedAt: e.secretRotatedAt?.toISOString() ?? null,
      previousSecretExpiresAt: prevLive ? e.secretPrevExpiresAt!.toISOString() : null,
      disabledAt: e.disabledAt?.toISOString() ?? null,
      disabledReason: e.disabledReason,
      createdBy: by ? encodeId('user', by) : null,
      createdByName: by ? (s?.names.get(by) ?? null) : null,
      version: e.version,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }

  async dto(e: WebhookEndpoint): Promise<WebhookEndpointDto> {
    return this.toDto(e, await this.stats(this.db.tx, [e]));
  }

  private async statusIds(tx: Tx, statuses: WebhookStatus[]): Promise<string[]> {
    const cond = Prisma.join(
      statuses.map((s) => Prisma.sql`(${STATUS_SQL[s]})`),
      ' OR ',
    );
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM webhook_endpoint WHERE deleted_at IS NULL AND (${cond})`;
    return rows.map((r) => r.id);
  }

  async list(q: WebhookListQuery) {
    const tx = this.db.tx;
    const k = keysetArgs(q);
    const and: Prisma.WebhookEndpointWhereInput[] = [
      k.where as Prisma.WebhookEndpointWhereInput,
      { deletedAt: null },
    ];
    if (q.status)
      and.push({ id: { in: await this.statusIds(tx, q.status.split(',') as WebhookStatus[]) } });
    if (q.url) and.push({ url: { contains: q.url.trim(), mode: 'insensitive' } });
    const rows = await tx.webhookEndpoint.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.WebhookEndpointOrderByWithRelationInput[],
      take: k.take,
    });
    const s = await this.stats(tx, rows);
    return toPage(rows, k, (r) => this.toDto(r, s), q.fields);
  }

  async summary(): Promise<WebhookSummaryDto> {
    const tx = this.db.tx;
    const n = async (s: WebhookStatus[]) => (await this.statusIds(tx, s)).length;
    const [active, failing, disabled, all] = await Promise.all([
      n(['active']),
      n(['failing']),
      n(['disabled', 'auto_disabled']),
      tx.webhookEndpoint.count({ where: { deletedAt: null } }),
    ]);
    const tenantId = requestContext.require().tenantId!;
    const limit = (await this.entitlements.resolve(tenantId)).webhook?.limit ?? null;
    return { all, active, failing, disabled, limit };
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<WebhookEndpoint> {
    const e = await tx.webhookEndpoint.findFirst({ where: { id, deletedAt: null } });
    if (!e) throw new ProblemException('not_found');
    return e;
  }

  // ---------- validate ----------

  private async checkUrl(url: string): Promise<string> {
    const p = checkUrlShape(url);
    if (p) throw field422('url', p.code, p.message);
    const host = urlHost(new URL(url));
    try {
      await Promise.race([
        resolvePublic(host),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('dns timeout')), SAVE_DNS_TIMEOUT_MS).unref?.(),
        ),
      ]);
    } catch (e) {
      // ชี้ IP ภายใน = ปฏิเสธ · resolve ไม่ได้ (ยังไม่ตั้ง DNS/เครือข่าย) = ยอม — ตรวจซ้ำตอนส่งทุกครั้ง
      if (e instanceof SsrfBlockedError) throw field422('url', 'url_not_allowed', e.message);
    }
    // เก็บรูปมาตรฐานของ URL (host ตัวเล็ก, percent-encode) — ตรวจซ้ำ/ส่งด้วยค่าเดียวกัน
    return new URL(url).href;
  }

  private checkHeaders(list: WebhookHeaderDto[] | undefined): WebhookHeaderDto[] {
    const out: WebhookHeaderDto[] = [];
    for (const h of list ?? []) {
      if (RESERVED_HEADER.test(h.name))
        throw field422('extraHeaders', 'reserved_header', `header ${h.name} cannot be set`);
      if (out.some((x) => x.name.toLowerCase() === h.name.toLowerCase()))
        throw field422('extraHeaders', 'duplicate_header', `header ${h.name} repeated`);
      out.push({ name: h.name, value: h.value.trim() });
    }
    return out;
  }

  private async assertUrlFree(tx: Tx, url: string, exceptId?: string) {
    const dup = await tx.webhookEndpoint.findFirst({
      where: { url, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'url', code: 'duplicate', message: 'endpoint URL already exists' },
      ]);
  }

  private async assertLimit(tx: Tx, tenantId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${tenantId}))`;
    const limit = (await this.entitlements.resolve(tenantId)).webhook?.limit ?? null;
    if (limit === null) return;
    const used = await tx.webhookEndpoint.count({ where: { deletedAt: null } });
    if (used >= limit)
      throw new ProblemException('webhook_limit_reached', undefined, undefined, { limit });
  }

  private sortedEvents(events: string[]): string[] {
    return [...new Set(events)].sort();
  }

  private version(e: WebhookEndpoint, expected?: number) {
    if (expected !== undefined && expected !== e.version)
      throw new ProblemException('precondition_failed');
  }

  // ---------- write ----------

  async create(body: CreateWebhookDto): Promise<WebhookEndpointSecretDto> {
    this.assertHuman();
    const ctx = requestContext.require();
    const tx = this.db.tx;
    const tenantId = ctx.tenantId!;
    const url = await this.checkUrl(body.url);
    const headers = this.checkHeaders(body.extraHeaders);
    const events = this.sortedEvents(body.events);
    await this.assertLimit(tx, tenantId);
    await this.assertUrlFree(tx, url);
    const secret = generateWebhookSecret();
    const id = randomUUID();
    const sub = await this.outbox.subscribe(tx, {
      tenantId,
      kind: 'WEBHOOK',
      sink: WEBHOOK_SINK,
      targetId: id,
      eventTypes: events,
      createdBy: ctx.actorId ?? null,
    });
    let row: WebhookEndpoint;
    try {
      row = await tx.webhookEndpoint.create({
        data: {
          id,
          tenantId,
          url,
          description: body.description?.trim() || null,
          events,
          extraHeadersEnc: headers.length
            ? this.engine.cipher.encrypt(JSON.stringify(headers))
            : null,
          extraHeaderNames: headers.map((h) => h.name),
          secretEnc: this.engine.cipher.encrypt(secret),
          subscriptionId: sub.id,
          createdBy: ctx.actorId ?? null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ProblemException('duplicate', undefined, [
          { field: 'url', code: 'duplicate', message: 'endpoint URL already exists' },
        ]);
      throw e;
    }
    // verification `challenge` (docs/04 G1) — ส่งหลัง commit ผ่าน outbox ครั้งเดียว ผลไม่บล็อก (spec/07 §10.6)
    await this.enqueueVerification(tx, tenantId, id);
    await this.audit.record({
      action: 'webhook_endpoint.created',
      entityType: 'webhook_endpoint',
      entityId: id,
      after: auditView(row),
    });
    return { ...(await this.dto(row)), secret };
  }

  private async enqueueVerification(tx: Tx, tenantId: string, id: string) {
    await this.outbox.enqueueCommand(tx, {
      tenantId,
      kind: 'WEBHOOK',
      sink: WEBHOOK_SINK,
      targetId: id,
      operation: VERIFICATION_OP,
      entityType: 'webhook_endpoint',
      localId: id,
      payload: { challenge: randomBytes(16).toString('hex') },
      maxAttempt: 1,
    });
  }

  /**
   * จำกัด "ส่ง event ทดสอบ" (กันใช้เป็นเครื่องยิงคำขอ): 1 ครั้ง / 5 วิ ต่อ endpoint และ 10 ครั้ง / นาที ต่อ tenant → 429
   * นับใน process (API หลายเครื่อง = เพดานรวมคูณจำนวนเครื่อง — พอสำหรับกันกดรัว)
   */
  private readonly testHits = new Map<string, number[]>();
  private takeTestSlot(tenantId: string, id: string, now = Date.now()) {
    const hit = (key: string, windowMs: number, max: number) => {
      const xs = (this.testHits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (xs.length >= max) return Math.ceil((windowMs - (now - xs[0]!)) / 1000);
      return 0;
    };
    const wait = Math.max(hit(`e:${id}`, 5000, 1), hit(`t:${tenantId}`, 60_000, 10));
    if (wait)
      throw new ProblemException('rate_limited', undefined, undefined, { retryAfter: wait });
    for (const k of [`e:${id}`, `t:${tenantId}`])
      this.testHits.set(k, [...(this.testHits.get(k) ?? []).filter((t) => now - t < 60_000), now]);
    if (this.testHits.size > 10_000) this.testHits.clear();
  }

  async update(id: string, body: UpdateWebhookDto, expected?: number): Promise<WebhookEndpoint> {
    this.assertHuman();
    const tx = this.db.tx;
    const cur = await this.get(id);
    this.version(cur, expected);
    const data: Prisma.WebhookEndpointUpdateInput = {};
    let urlChanged = false;
    if (body.url !== undefined) {
      const url = await this.checkUrl(body.url);
      if (url !== cur.url) {
        await this.assertUrlFree(tx, url, cur.id);
        data.url = url;
        // ปลายทางใหม่ยังไม่ได้ยืนยัน — ล้าง verifiedAt แล้วส่ง challenge ใหม่หลัง commit
        data.verifiedAt = null;
        urlChanged = true;
      }
    }
    if (body.events !== undefined) {
      const ev = this.sortedEvents(body.events);
      if (ev.join() !== cur.events.join()) data.events = ev;
    }
    if (body.description !== undefined) {
      const d = body.description?.trim() || null;
      if (d !== cur.description) data.description = d;
    }
    if (body.extraHeaders !== undefined) {
      const h = this.checkHeaders(body.extraHeaders);
      data.extraHeadersEnc = h.length ? this.engine.cipher.encrypt(JSON.stringify(h)) : null;
      data.extraHeaderNames = h.map((x) => x.name);
    }
    if (!Object.keys(data).length) return cur;
    const n = await tx.webhookEndpoint.updateMany({
      where: { id, version: cur.version },
      data: {
        ...(data as Prisma.WebhookEndpointUpdateManyMutationInput),
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    if (urlChanged) await this.enqueueVerification(tx, cur.tenantId, id);
    if (data.events)
      await tx.integrationSubscription.updateMany({
        where: { sink: WEBHOOK_SINK, targetId: id },
        data: { eventTypes: data.events as string[] },
      });
    const after = await this.get(id);
    await this.audit.changed('webhook_endpoint.updated', 'webhook_endpoint', id, auditView(cur), {
      ...auditView(after),
      ...(body.extraHeaders !== undefined ? { extraHeaders: 'changed' } : {}),
    });
    return after;
  }

  /** หมุน signing secret: secret ใหม่ใช้ทันที + secret เดิมเซ็นคู่อีก 24 ชม. (INT-102) */
  async rotate(
    id: string,
    body: WebhookActionDto,
    expected?: number,
  ): Promise<WebhookEndpointSecretDto> {
    this.assertHuman();
    const tx = this.db.tx;
    const cur = await this.get(id);
    this.version(cur, expected);
    const secret = generateWebhookSecret();
    const now = new Date();
    const n = await tx.webhookEndpoint.updateMany({
      where: { id, version: cur.version },
      data: {
        secretEnc: this.engine.cipher.encrypt(secret),
        secretPrevEnc: cur.secretEnc,
        secretPrevExpiresAt: new Date(now.getTime() + WEBHOOK_ROTATION_GRACE_HOURS * 3600_000),
        secretRotatedAt: now,
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    const row = await this.get(id);
    await this.audit.record({
      action: 'webhook_endpoint.secret_rotated',
      entityType: 'webhook_endpoint',
      entityId: id,
      after: { previousSecretExpiresAt: row.secretPrevExpiresAt?.toISOString() },
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return { ...(await this.dto(row)), secret };
  }

  async disable(id: string, body: WebhookReasonDto, expected?: number): Promise<WebhookEndpoint> {
    return this.setActive(id, false, body, expected);
  }

  /** เปิดใช้อีกครั้ง — ตัวนับล้มเหลวเริ่มใหม่ (event ระหว่างปิดส่งซ้ำได้ใน ST7-T05 redeliver) */
  async enable(id: string, body: WebhookActionDto, expected?: number): Promise<WebhookEndpoint> {
    return this.setActive(id, true, body, expected);
  }

  private async setActive(id: string, on: boolean, body: WebhookActionDto, expected?: number) {
    this.assertHuman();
    const ctx = requestContext.require();
    const tx = this.db.tx;
    const cur = await this.get(id);
    this.version(cur, expected);
    if (on === (cur.status === 'ACTIVE')) throw new ProblemException('invalid_state_transition');
    const n = await tx.webhookEndpoint.updateMany({
      where: { id, version: cur.version },
      data: on
        ? {
            status: 'ACTIVE',
            consecutiveFailures: 0,
            lastFailureAt: null,
            disabledAt: null,
            disabledReason: null,
            disabledBy: null,
            version: { increment: 1 },
          }
        : {
            status: 'DISABLED',
            disabledAt: new Date(),
            disabledReason: body.reason ?? null,
            disabledBy: ctx.actorId ?? null,
            version: { increment: 1 },
          },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    await tx.integrationSubscription.updateMany({
      where: { sink: WEBHOOK_SINK, targetId: id },
      data: { active: on },
    });
    await this.audit.record({
      action: on ? 'webhook_endpoint.enabled' : 'webhook_endpoint.disabled',
      entityType: 'webhook_endpoint',
      entityId: id,
      before: { status: cur.status },
      after: { status: on ? 'ACTIVE' : 'DISABLED' },
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return this.get(id);
  }

  /** ลบ (soft) — หยุดรับ event ทันที · ประวัติการส่งเก็บตาม retention */
  async remove(id: string, body: WebhookReasonDto, expected?: number): Promise<void> {
    this.assertHuman();
    const tx = this.db.tx;
    const cur = await this.get(id);
    this.version(cur, expected);
    const n = await tx.webhookEndpoint.updateMany({
      where: { id, version: cur.version, deletedAt: null },
      data: { deletedAt: new Date(), status: 'DISABLED', version: { increment: 1 } },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    await tx.integrationSubscription.updateMany({
      where: { sink: WEBHOOK_SINK, targetId: id },
      data: { active: false },
    });
    await this.audit.record({
      action: 'webhook_endpoint.deleted',
      entityType: 'webhook_endpoint',
      entityId: id,
      before: auditView(cur),
      ...(body.reason ? { reason: body.reason } : {}),
    });
  }

  /**
   * ส่ง `webhook.test` ทันที (INT-107; ต้นแบบ testHook) — ไม่อยู่ใน transaction ของ request (รอปลายทางได้ถึง 10 วิ)
   * endpoint ต้องเปิดอยู่ · payload ตัวอย่างของ event ที่เลือก + `"test": true` · ไม่นับอัตราสำเร็จ/ปิดอัตโนมัติ
   */
  async test(id: string, body: WebhookTestDto): Promise<WebhookTestResultDto> {
    this.assertHuman();
    const ctx = requestContext.require();
    const tenantId = ctx.tenantId!;
    const withTx = <T>(fn: (tx: Tx) => Promise<T>) => this.db.withTenant(tenantId, fn);
    const e = await withTx((tx) => this.get(id, tx));
    if (e.status !== 'ACTIVE') throw new ProblemException('invalid_state_transition');
    this.takeTestSlot(tenantId, id);
    const type = body.eventType ?? e.events[0] ?? 'order.created';
    const envelope = this.engine.systemEnvelope(tenantId, 'webhook.test', sampleObject(type));
    const r = await this.engine.attempt({
      tenantId,
      endpoint: e,
      envelope,
      attempt: 1,
      test: true,
      withTx,
    });
    await withTx(async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: ctx.actorId ?? null,
          actAs: ctx.actAs ?? null,
          action: 'webhook_endpoint.test_sent',
          entityType: 'webhook_endpoint',
          entityId: id,
          after: { eventType: type, status: r.send.status, errorCode: r.errorCode },
          requestId: ctx.requestId,
          ip: ctx.ip ?? null,
        },
      });
    });
    return {
      delivered: r.outcome === 'DELIVERED',
      status: r.send.status,
      durationMs: r.send.durationMs,
      errorCode: r.errorCode,
      eventId: envelope.id,
    };
  }
}

/** payload ตัวอย่างของ event (INT-107) — ไม่ใช่ข้อมูลจริงของบริษัท */
export function sampleObject(type: string): Record<string, unknown> {
  const entity = type.split('.')[0]!;
  const zero = '0'.repeat(32);
  const prefix: Record<string, string> = {
    order: 'ord',
    trip: 'trp',
    stop: 'stp',
    delivery_order: 'do',
    pod: 'doc',
    invoice: 'inv',
    job: 'job',
  };
  return {
    sampleEventType: type,
    id: `${prefix[entity] ?? 'obj'}_${zero}`,
    object: entity,
    status: type.split('.')[1] ?? 'updated',
    updatedAt: new Date().toISOString(),
  };
}
