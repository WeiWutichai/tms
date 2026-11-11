import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { webBaseUrl } from '../../auth/password-reset.controller';
import type { Tx } from '../../db/db.service';
import { EmailService } from '../email/email.service';
import { renderNotification, type NotificationTemplate, type NotificationVars } from './templates';

/** ช่องทางที่ระบบรู้จัก — push (FCM/APNs แอปคนขับ เฟส 2), line/sms (ST3-T21) เสียบเพิ่มด้วย `register()` */
export const CHANNELS = ['in_app', 'email', 'push', 'line', 'sms'] as const;
export type ChannelName = (typeof CHANNELS)[number];

/** ผู้รับหนึ่งคนที่ resolve แล้ว + ข้อความในภาษาของเขา */
export interface PreparedNotification {
  tenantId: string;
  recipient: { id: string; email: string; locale: string };
  template: NotificationTemplate;
  title: string;
  body: string;
  /** path ภายในเว็บ (ขึ้นต้นด้วย /) */
  link: string | null;
  payload: Prisma.InputJsonValue;
  entity: { type: string; id: string } | null;
}

/**
 * ช่องทางส่ง (docs/04 I; backlog ST1-T23 "interface ช่องทาง") — `deliver` รันใน transaction ของผู้เรียก:
 * งานหลัก rollback = ไม่มีแจ้งเตือนหลุดออกไป · ช่องที่ส่งออกนอกระบบต้องเขียน outbox แล้วให้ worker ส่ง
 * (ห้ามเรียก provider ภายนอกตรง ๆ ใน transaction)
 */
export interface NotificationChannel {
  readonly name: ChannelName;
  deliver(tx: Tx, n: PreparedNotification): Promise<void>;
}

/** กระดิ่งในเว็บ — แถวเดียวจบ (SENT ทันที, READ เมื่อผู้ใช้เปิดอ่าน) */
export class InAppChannel implements NotificationChannel {
  readonly name = 'in_app' as const;
  async deliver(tx: Tx, n: PreparedNotification) {
    await tx.notification.create({
      data: {
        ...base(n),
        channel: 'in_app',
        status: 'SENT',
        sentAt: new Date(),
      },
    });
  }
}

/** อีเมลผ่าน outbox (ST1-T03) — worker อัปเดตสถานะแถวนี้ตามผลส่ง (EmailDispatcher.syncNotifications) */
export class EmailChannel implements NotificationChannel {
  readonly name = 'email' as const;
  constructor(
    private readonly email: EmailService,
    private readonly webBase: () => string,
  ) {}
  async deliver(tx: Tx, n: PreparedNotification) {
    const outboxId = randomUUID();
    await this.email.enqueue(tx, {
      id: outboxId,
      tenantId: n.tenantId,
      to: n.recipient.email,
      template: 'notification',
      locale: n.recipient.locale,
      vars: {
        title: n.title,
        body: n.body,
        ...(n.link ? { link: `${this.webBase()}${n.link}` } : {}),
      },
    });
    await tx.notification.create({
      data: { ...base(n), channel: 'email', status: 'QUEUED', emailOutboxId: outboxId },
    });
  }
}

function base(n: PreparedNotification) {
  return {
    tenantId: n.tenantId,
    recipientId: n.recipient.id,
    templateCode: n.template,
    locale: n.recipient.locale,
    title: n.title,
    body: n.body,
    link: n.link,
    payload: n.payload,
    relatedEntityType: n.entity?.type ?? null,
    relatedEntityId: n.entity?.id ?? null,
  };
}

export interface NotifyInput<K extends NotificationTemplate> {
  tenantId: string;
  /** ผู้ใช้ที่ระบุตรง + ผู้ใช้ทุกคนที่มี role code เหล่านี้ (รวมแล้วไม่ซ้ำ; เฉพาะ ACTIVE) */
  to: { userIds?: string[]; roles?: string[] };
  template: K;
  vars: NotificationVars[K];
  /** ค่าเริ่มต้น in_app + email (docs/04 I: P0) */
  channels?: ChannelName[];
  /** path ภายในเว็บที่กดแล้วไป เช่น `/settings/users` */
  link?: string;
  entity?: { type: string; id: string };
}

/** ผู้รับต่อการแจ้งหนึ่งครั้ง — กันเหตุการณ์เดียวยิงทั้งบริษัทแบบไม่ตั้งใจ */
const MAX_RECIPIENTS = 500;

/**
 * แกนแจ้งเตือน (ST1-T23; docs/04 I, spec/10 Notification)
 * `notify()` เรียกใน transaction ของงานที่ทำให้เกิดเหตุการณ์ → resolve ผู้รับ → render ตามภาษาผู้รับ → ส่งทุกช่อง
 * ยังไม่มี: การตั้งค่ารับ/ไม่รับต่อผู้ใช้, สรุปรายวัน 08:00 (docs/04 I — ดู PROGRESS)
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('NotificationService');
  private readonly channels = new Map<ChannelName, NotificationChannel>();

  constructor(email: EmailService) {
    const base = webBaseUrl(); // ตรวจตอนเริ่ม — ไม่ตั้ง PUBLIC_WEB_BASE_URL นอก dev ให้ล้มตั้งแต่บูต
    this.register(new InAppChannel());
    this.register(new EmailChannel(email, () => base));
  }

  register(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel);
  }

  /** คืนจำนวนผู้รับ */
  async notify<K extends NotificationTemplate>(tx: Tx, input: NotifyInput<K>): Promise<number> {
    if (input.link !== undefined && !/^\/(?!\/)[^\s]*$/.test(input.link))
      throw new Error('notification link must be an internal path starting with /');
    const wanted = input.channels ?? ['in_app', 'email'];
    const channels = wanted.map((c) => {
      const ch = this.channels.get(c);
      if (!ch) throw new Error(`notification channel '${c}' is not registered`);
      return ch;
    });
    const recipients = await this.resolve(tx, input.tenantId, input.to);
    if (recipients.length > MAX_RECIPIENTS)
      throw new Error(`too many notification recipients (${recipients.length})`);
    for (const r of recipients) {
      const text = renderNotification(input.template, r.locale, input.vars);
      const n: PreparedNotification = {
        tenantId: input.tenantId,
        recipient: r,
        template: input.template,
        title: text.title,
        body: text.body,
        link: input.link ?? null,
        payload: input.vars as unknown as Prisma.InputJsonValue,
        entity: input.entity ?? null,
      };
      for (const ch of channels) await ch.deliver(tx, n);
    }
    if (!recipients.length)
      this.logger.debug(`notify ${input.template}: no active recipients in tenant`);
    return recipients.length;
  }

  private async resolve(tx: Tx, tenantId: string, to: NotifyInput<never>['to']) {
    const ids = new Set(to.userIds ?? []);
    if (to.roles?.length) {
      const rows = await tx.userRole.findMany({
        where: { tenantId, roleId: { in: await this.roleIds(tx, tenantId, to.roles) } },
        select: { userId: true },
      });
      for (const r of rows) ids.add(r.userId);
    }
    if (!ids.size) return [];
    const users = await tx.appUser.findMany({
      where: { tenantId, id: { in: [...ids] }, status: 'ACTIVE', deletedAt: null },
      select: { id: true, email: true, locale: true },
      orderBy: { id: 'asc' },
    });
    return users;
  }

  private async roleIds(tx: Tx, tenantId: string, codes: string[]): Promise<string[]> {
    const roles = await tx.role.findMany({
      where: { tenantId, code: { in: codes } },
      select: { id: true },
    });
    return roles.map((r) => r.id);
  }
}
