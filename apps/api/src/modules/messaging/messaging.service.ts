import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { scopeAllows } from '@tms/domain';
import { webBaseUrl } from '../../auth/password-reset.controller';
import { AuditService } from '../../audit/audit.service';
import { BlindIndex } from '../../common/blind-index';
import { FieldCipher } from '../../common/crypto';
import { decodeIdOr404, encodeId, tryDecodeId, type IdKind } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { isThaiPhone, phoneNorm } from '../drivers/drivers.service';
import { decodeLinkToken } from '../links/magic-link.service';
import { lockKey } from '../master/master-kit';
import {
  LINE_USER_ID_RE,
  type ChannelKey,
  type ChannelStatusDto,
  type MessageDeliveryDto,
  type MessageDeliveryListQuery,
  type MessagingSettingsDto,
  type SendLinkDto,
  type UpdateMessagingSettingsDto,
} from './messaging.dto';
import { MessagingProviders } from './messaging.providers';
import { maskRecipient, type MessageChannel } from './providers';
import { renderMessage, type MessageTemplate } from './templates';

/**
 * ชนิดลิงก์ที่ส่งทาง LINE/SMS ได้ — path หน้าเว็บ + template + สิทธิ์ส่ง/ดูบันทึก (docs/04 A3)
 * ST3-T23 (ข้อเสนองาน) ยืนยัน path ของหน้า public ตอนทำหน้าจริง
 */
export const LINK_KINDS = {
  carrier_docs: {
    path: 'carrier-docs',
    template: 'carrier_docs_link',
    sendScope: 'master:write',
    readScope: 'master:read',
    entityType: 'carrier',
  },
  trip_offer: {
    path: 'offer',
    template: 'job_offer_link',
    sendScope: 'trips:assign',
    readScope: 'trips:read',
    entityType: 'trip',
  },
} as const satisfies Record<
  string,
  {
    path: string;
    template: MessageTemplate;
    sendScope: string;
    readScope: string;
    entityType: string;
  }
>;
type LinkKind = keyof typeof LINK_KINDS;

/** เพดานต่อ tenant / ชั่วโมง (กันส่งรัว — ค่าใช้จ่าย SMS + LINE quota) */
export const TENANT_PER_HOUR = 300;
/** เพดานต่อผู้รับ / ชั่วโมง (กันก่อกวนผู้รับคนเดียว) */
export const RECIPIENT_PER_HOUR = 5;

const CHANNEL: Record<ChannelKey, MessageChannel> = { line: 'LINE', sms: 'SMS' };
const KEY: Record<string, ChannelKey> = { LINE: 'line', SMS: 'sms' };

/** คอลัมน์ที่ role แอปอ่านได้ (migration 0062 — body/recipient_enc อ่านไม่ได้) */
const SAFE_SELECT = {
  id: true,
  channel: true,
  template: true,
  status: true,
  recipientMasked: true,
  recipientType: true,
  recipientRefId: true,
  magicLinkId: true,
  entityType: true,
  entityId: true,
  attempts: true,
  runAt: true,
  provider: true,
  providerMessageId: true,
  errorCode: true,
  createdAt: true,
  sentAt: true,
  failedAt: true,
} satisfies Prisma.MessageDeliverySelect;
type SafeRow = Prisma.MessageDeliveryGetPayload<{ select: typeof SAFE_SELECT }>;

const ENTITY_KIND: Record<string, IdKind> = { carrier: 'carrier', trip: 'trip' };

const bad = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', message, [{ field, code, message }]);

/**
 * ส่งลิงก์ทาง LINE/SMS (ST3-T21) — เขียนแถว outbox ใน transaction ของคำขอ (rollback = ไม่ส่ง), worker ส่งจริง
 * ส่งได้เฉพาะลิงก์ที่ระบบออกและยังใช้ได้ของบริษัทนี้ (ไม่รับ URL อื่น — กันใช้ระบบเราส่งสแปม/ฟิชชิง)
 * ผู้รับเข้ารหัส + ปิดบัง · ส่งไม่ได้ = ผู้ใช้ยังคัดลอกลิงก์ไปส่งเองได้เสมอ (fallback ของเกณฑ์ตรวจรับ)
 */
@Injectable()
export class MessagingService {
  private cipherInstance?: FieldCipher;
  private blindInstance?: BlindIndex;

  constructor(
    private readonly db: DbService,
    private readonly providers: MessagingProviders,
    private readonly audit: AuditService,
  ) {}

  private get cipher() {
    return (this.cipherInstance ??= new FieldCipher());
  }
  private get blind() {
    return (this.blindInstance ??= new BlindIndex());
  }

  // ---------- ช่องทาง ----------

  private async setting() {
    return this.db.tx.messagingSetting.findFirst();
  }

  async channels(): Promise<ChannelStatusDto[]> {
    const s = await this.setting();
    return (['line', 'sms'] as const).map((k) => {
      const reason = this.unavailable(CHANNEL[k], s);
      return { channel: k, available: !reason, reason };
    });
  }

  /** null = ส่งได้ */
  private unavailable(
    ch: MessageChannel,
    s: { lineEnabled: boolean; lineTokenEnc: string | null; smsEnabled: boolean } | null,
  ): 'provider_disabled' | 'not_configured' | 'channel_disabled' | null {
    const p = this.providers.get(ch);
    if (!p) return 'provider_disabled';
    if (ch === 'SMS') return (s?.smsEnabled ?? true) ? null : 'channel_disabled';
    // mock (dev/test) ไม่ต้องตั้ง token · LINE จริง = ต้องตั้ง token + เปิดใช้
    if (!p.needsTenantCredentials) return null;
    if (!s?.lineTokenEnc) return 'not_configured';
    return s.lineEnabled ? null : 'channel_disabled';
  }

  // ---------- ส่ง ----------

  async sendLink(input: SendLinkDto): Promise<MessageDeliveryDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const channel = CHANNEL[input.channel];
    const { kind, link } = await this.resolveLink(input.url);
    const k = LINK_KINDS[kind];
    if (!scopeAllows(ctx.scopes ?? [], k.sendScope))
      throw new ProblemException('permission_denied');

    // ผู้รับ: ผู้รับเหมา (ค่าเริ่มต้น = เจ้าของลิงก์ของผู้รับเหมา) และ/หรือระบุตรง
    let carrierId = input.carrierId ? decodeIdOr404('carrier', input.carrierId) : null;
    if (!carrierId && k.entityType === 'carrier') carrierId = link.entityId;
    const carrier = carrierId
      ? await tx.carrier.findFirst({
          where: { id: carrierId, deletedAt: null },
          select: { id: true, legalName: true, phone: true, lineContact: true },
        })
      : null;
    if (carrierId && !carrier) throw new ProblemException('not_found');
    if (k.entityType === 'carrier' && carrier && link.entityId !== carrier.id)
      throw bad('carrierId', 'link_mismatch', 'link belongs to another carrier');
    const to = this.recipient(channel, input.to, carrier);

    const s = await this.setting();
    const reason = this.unavailable(channel, s);
    if (reason)
      throw new ProblemException(
        'channel_unavailable',
        `${input.channel} is not available (${reason}) — copy the link and send it yourself`,
        [{ field: 'channel', code: reason, message: `${input.channel} is not available` }],
      );

    // rate limit — นับใต้ lock ของ tenant (คำขอพร้อมกันไม่หลุดเพดาน)
    const hash = this.blind.of(`${channel}:${to}`);
    await lockKey(tx, 'messaging.rate');
    const since = new Date(Date.now() - 3600_000);
    const [tenantCount, recipientCount] = await Promise.all([
      tx.messageDelivery.count({ where: { createdAt: { gt: since } } }),
      tx.messageDelivery.count({ where: { recipientHash: hash, createdAt: { gt: since } } }),
    ]);
    if (tenantCount >= TENANT_PER_HOUR)
      throw new ProblemException('rate_limited', `at most ${TENANT_PER_HOUR} messages per hour`, [
        { field: 'channel', code: 'tenant_hourly_limit', message: 'too many messages this hour' },
      ]);
    if (recipientCount >= RECIPIENT_PER_HOUR)
      throw new ProblemException(
        'rate_limited',
        `at most ${RECIPIENT_PER_HOUR} messages per recipient per hour`,
        [
          {
            field: 'to',
            code: 'recipient_hourly_limit',
            message: 'too many messages to recipient',
          },
        ],
      );

    const tenant = await tx.tenant.findFirst({ select: { name: true, yearStyle: true } });
    const body = renderMessage(k.template, channel, 'th', {
      sender: tenant?.name ?? 'TMS',
      recipientName: carrier?.legalName ?? null,
      url: input.url,
      expiresAt: link.expiresAt,
      yearStyle: tenant?.yearStyle === 'CE' ? 'CE' : 'BE',
    });
    const id = randomUUID();
    // createMany = ไม่มี RETURNING (role แอปอ่าน body/recipient_enc ไม่ได้)
    await tx.messageDelivery.createMany({
      data: [
        {
          id,
          tenantId: ctx.tenantId!,
          channel,
          template: k.template,
          locale: 'th',
          recipientEnc: this.cipher.encrypt(to),
          recipientMasked: maskRecipient(channel, to),
          recipientHash: hash,
          recipientType: carrier ? 'carrier' : null,
          recipientRefId: carrier?.id ?? null,
          body,
          magicLinkId: link.id,
          entityType: link.entityType,
          entityId: link.entityId,
          provider: this.providers.get(channel)!.name,
          createdBy: ctx.actorId ?? null,
        },
      ],
    });
    await this.audit.record({
      action: 'message.queued',
      entityType: link.entityType,
      entityId: link.entityId,
      after: {
        messageId: encodeId('messageDelivery', id),
        channel: input.channel,
        template: k.template,
        recipient: maskRecipient(channel, to),
        linkId: encodeId('magicLink', link.id),
      },
    });
    return toDto(
      await tx.messageDelivery.findUniqueOrThrow({ where: { id }, select: SAFE_SELECT }),
    );
  }

  /** URL ต้องเป็น `{PUBLIC_WEB_BASE_URL}/link/{path}/{token}` ของลิงก์ที่ยังใช้ได้ในบริษัทนี้ */
  private async resolveLink(url: string) {
    const invalid = () =>
      bad('url', 'link_invalid', 'url is not an active link issued by this organisation');
    const base = webBaseUrl();
    if (!url.startsWith(`${base}/link/`)) throw invalid();
    const m = /^\/link\/([a-z-]+)\/(ml1\.[A-Za-z0-9._-]+)$/.exec(url.slice(base.length));
    const kind = (Object.keys(LINK_KINDS) as LinkKind[]).find((k) => LINK_KINDS[k].path === m?.[1]);
    const t = m && kind ? decodeLinkToken(m[2]!) : null;
    if (!t || !kind) throw invalid();
    // RLS: ลิงก์ของบริษัทอื่นมองไม่เห็น = ไม่ถูกต้อง
    const link = await this.db.tx.magicLink.findFirst({ where: { id: t.id } });
    if (
      !link ||
      link.purpose !== kind ||
      link.revokedAt ||
      link.expiresAt.getTime() <= Date.now() ||
      Math.floor(link.expiresAt.getTime() / 1000) !== t.exp
    )
      throw invalid();
    return { kind, link };
  }

  private recipient(
    channel: MessageChannel,
    to: string | undefined,
    carrier: { phone: string | null; lineContact: string | null } | null,
  ): string {
    if (channel === 'LINE') {
      const v = (to ?? carrier?.lineContact ?? '').trim();
      if (!v) throw bad('to', 'recipient_missing', 'no LINE userId for this recipient');
      // LINE ID ที่ตั้งเอง (@xxx) ใช้ push ไม่ได้ — ต้องเป็น userId จาก webhook (ยังไม่มี — OPEN #49)
      if (!LINE_USER_ID_RE.test(v))
        throw bad(
          'to',
          to ? 'recipient_invalid' : 'recipient_missing',
          'LINE push needs a LINE userId (U + 32 hex)',
        );
      return v;
    }
    const raw = (to ?? carrier?.phone ?? '').trim();
    if (!raw) throw bad('to', 'recipient_missing', 'no mobile number for this recipient');
    const n = phoneNorm(raw);
    if (!isThaiPhone(n) || !/^0[689]/.test(n))
      throw bad(
        'to',
        to ? 'recipient_invalid' : 'recipient_missing',
        'SMS needs a Thai mobile number',
      );
    return n;
  }

  // ---------- บันทึกการส่ง ----------

  /** template ที่ผู้เรียกดูได้ (ตามสิทธิ์ดูของชนิดลิงก์) */
  private readable(): string[] {
    const scopes = requestContext.require().scopes ?? [];
    return Object.values(LINK_KINDS)
      .filter((k) => scopeAllows(scopes, k.readScope))
      .map((k) => k.template);
  }

  async list(q: MessageDeliveryListQuery) {
    const limit = q.limit ?? 20;
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const carrierId = q.carrierId ? tryDecodeId('carrier', q.carrierId) : undefined;
    const linkId = q.linkId ? tryDecodeId('magicLink', q.linkId) : undefined;
    // id ผิดรูป = ไม่มีผลลัพธ์ (ไม่บอกใบ้)
    if (carrierId === null || linkId === null)
      return { data: [], nextCursor: null, hasMore: false };
    const rows = await this.db.tx.messageDelivery.findMany({
      where: {
        template: { in: this.readable() },
        ...(carrierId ? { recipientType: 'carrier', recipientRefId: carrierId } : {}),
        ...(linkId ? { magicLinkId: linkId } : {}),
        ...(q.channel ? { channel: CHANNEL[q.channel] } : {}),
        ...(q.status ? { status: q.status.toUpperCase() } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: SAFE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page.map(toDto),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ a: last.createdAt.toISOString(), i: last.id })).toString(
              'base64url',
            )
          : null,
      hasMore,
    };
  }

  async get(id: string): Promise<MessageDeliveryDto> {
    const row = await this.db.tx.messageDelivery.findFirst({
      where: { id, template: { in: this.readable() } },
      select: SAFE_SELECT,
    });
    if (!row) throw new ProblemException('not_found');
    return toDto(row);
  }

  // ---------- ตั้งค่า ----------

  async getSettings(): Promise<MessagingSettingsDto> {
    return this.settingsDto(await this.setting());
  }

  private settingsDto(s: Awaited<ReturnType<MessagingService['setting']>>): MessagingSettingsDto {
    return {
      lineEnabled: s?.lineEnabled ?? false,
      lineConfigured: !!s?.lineTokenEnc,
      lineTokenHint: s?.lineTokenLast4 ? `•••• ${s.lineTokenLast4}` : null,
      smsEnabled: s?.smsEnabled ?? true,
      lineProvider: this.providers.get('LINE')?.name ?? null,
      smsProvider: this.providers.get('SMS')?.name ?? null,
      version: s?.version ?? 0,
      updatedAt: s?.updatedAt.toISOString() ?? null,
    };
  }

  async updateSettings(dto: UpdateMessagingSettingsDto): Promise<MessagingSettingsDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    await lockKey(tx, 'messaging.setting');
    const before = await this.setting();
    const next = {
      lineTokenEnc: before?.lineTokenEnc ?? null,
      lineTokenLast4: before?.lineTokenLast4 ?? null,
      lineEnabled: before?.lineEnabled ?? false,
      smsEnabled: before?.smsEnabled ?? true,
    };
    const tokenChanged = dto.lineChannelAccessToken !== undefined;
    if (dto.lineChannelAccessToken === null) {
      next.lineTokenEnc = null;
      next.lineTokenLast4 = null;
      next.lineEnabled = false;
    } else if (dto.lineChannelAccessToken !== undefined) {
      next.lineTokenEnc = this.cipher.encrypt(dto.lineChannelAccessToken);
      next.lineTokenLast4 = dto.lineChannelAccessToken.slice(-4);
      // ตั้ง token ครั้งแรกโดยไม่ระบุ = เปิดใช้
      if (!before?.lineTokenEnc && dto.lineEnabled === undefined) next.lineEnabled = true;
    }
    if (dto.lineEnabled !== undefined) next.lineEnabled = dto.lineEnabled;
    if (dto.smsEnabled !== undefined) next.smsEnabled = dto.smsEnabled;
    if (next.lineEnabled && !next.lineTokenEnc)
      throw bad(
        'lineEnabled',
        'line_token_required',
        'set lineChannelAccessToken before enabling LINE',
      );
    const changed =
      tokenChanged ||
      next.lineEnabled !== (before?.lineEnabled ?? false) ||
      next.smsEnabled !== (before?.smsEnabled ?? true);
    if (!changed) return this.settingsDto(before);
    const row = before
      ? await tx.messagingSetting.update({
          where: { tenantId: before.tenantId },
          data: { ...next, version: { increment: 1 }, updatedBy: ctx.actorId ?? null },
        })
      : await tx.messagingSetting.create({
          data: { tenantId: ctx.tenantId!, ...next, updatedBy: ctx.actorId ?? null },
        });
    // ไม่ลงค่า token (แม้ 4 ตัวท้าย) ใน audit — บอกแค่ว่าเปลี่ยน
    await this.audit.record({
      action: 'messaging_setting.updated',
      entityType: 'messaging_setting',
      entityId: ctx.tenantId!,
      before: {
        lineEnabled: before?.lineEnabled ?? false,
        lineConfigured: !!before?.lineTokenEnc,
        smsEnabled: before?.smsEnabled ?? true,
      },
      after: {
        lineEnabled: row.lineEnabled,
        lineConfigured: !!row.lineTokenEnc,
        lineCredentialChanged: tokenChanged,
        smsEnabled: row.smsEnabled,
      },
    });
    return this.settingsDto(row);
  }
}

function toDto(r: SafeRow): MessageDeliveryDto {
  const kind = r.entityType ? ENTITY_KIND[r.entityType] : undefined;
  const done = r.status === 'SENT' || r.status === 'FAILED';
  return {
    id: encodeId('messageDelivery', r.id),
    channel: KEY[r.channel] ?? 'line',
    template: r.template,
    status: r.status.toLowerCase(),
    recipient: r.recipientMasked,
    carrierId:
      r.recipientType === 'carrier' && r.recipientRefId
        ? encodeId('carrier', r.recipientRefId)
        : null,
    linkId: r.magicLinkId ? encodeId('magicLink', r.magicLinkId) : null,
    entityType: r.entityType,
    entityId: r.entityId && kind ? encodeId(kind, r.entityId) : null,
    attempts: r.attempts,
    provider: r.provider,
    providerMessageId: r.providerMessageId,
    errorCode: r.errorCode,
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
    failedAt: r.failedAt?.toISOString() ?? null,
    nextAttemptAt: done ? null : r.runAt.toISOString(),
  };
}

function decodeCursor(c: string): { at: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { a: string; i: string };
    const at = new Date(v.a);
    if (
      Number.isNaN(at.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v.i))
    )
      throw new Error();
    return { at, id: v.i };
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}
