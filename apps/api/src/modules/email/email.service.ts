import { Injectable, Logger } from '@nestjs/common';
import type { EmailOutbox, Prisma } from '@prisma/client';
import { PrismaService } from '../../db/prisma.service';
import { renderEmail, type TemplateName, type TemplateVars } from './templates';
import { transportFromEnv, type EmailTransport } from './transport';

type Writer = Pick<Prisma.TransactionClient, 'emailOutbox'>;

export interface EnqueueEmail<K extends TemplateName> {
  /** null = อีเมลระบบที่ยังไม่รู้บริษัท (เขียนด้วย client platform เท่านั้น) */
  tenantId: string | null;
  to: string;
  template: K;
  locale: string;
  vars: TemplateVars[K];
  runAt?: Date;
}

/**
 * อีเมล transactional (ST1-T03) — outbox: เขียนแถวใน transaction เดียวกับงาน (rollback = ไม่ส่ง)
 * แล้ว worker ส่งทีหลังด้วย `EmailDispatcher` · render ตอน enqueue (template เปลี่ยนภายหลังไม่กระทบอีเมลที่รอส่ง)
 */
@Injectable()
export class EmailService {
  enqueue<K extends TemplateName>(tx: Writer, input: EnqueueEmail<K>) {
    const r = renderEmail(input.template, input.locale, input.vars);
    return tx.emailOutbox.create({
      data: {
        tenantId: input.tenantId,
        toAddress: input.to,
        template: input.template,
        locale: input.locale,
        subject: r.subject,
        textBody: r.text,
        htmlBody: r.html,
        ...(input.runAt ? { runAt: input.runAt } : {}),
      },
    });
  }
}

const LEASE_MS = 2 * 60_000;

/** ส่งอีเมลจาก outbox (รันใน worker) — หยิบด้วย FOR UPDATE SKIP LOCKED ข้าม tenant, ลองใหม่แบบ backoff */
@Injectable()
export class EmailDispatcher {
  private readonly logger = new Logger('EmailDispatcher');
  private transport?: EmailTransport;

  constructor(private readonly prisma: PrismaService) {}

  /** test ใส่ MemoryTransport ได้ */
  use(transport: EmailTransport) {
    this.transport = transport;
  }

  private claim(): Promise<EmailOutbox[]> {
    return this.prisma.platform.$queryRaw<EmailOutbox[]>`
      WITH c AS (
        SELECT id FROM email_outbox
         WHERE (status = 'PENDING' AND run_at <= now())
            OR (status = 'SENDING' AND locked_until < now())
         ORDER BY run_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE email_outbox e SET status = 'SENDING', attempts = e.attempts + 1,
             locked_until = now() + (${LEASE_MS}::int * interval '1 millisecond'), updated_at = now()
        FROM c WHERE e.id = c.id
      RETURNING e.id, e.to_address AS "toAddress", e.subject, e.text_body AS "textBody",
                e.html_body AS "htmlBody", e.attempts, e.max_attempts AS "maxAttempts", e.template`;
  }

  /** ส่ง 1 ฉบับ — คืน true ถ้ามีงาน */
  async runOnce(): Promise<boolean> {
    const [m] = await this.claim();
    if (!m) return false;
    const db = this.prisma.platform.emailOutbox;
    try {
      this.transport ??= transportFromEnv();
      if (!m.textBody || !m.htmlBody) throw new Error('email body missing');
      const r = await this.transport.send({
        to: m.toAddress,
        subject: m.subject,
        text: m.textBody,
        html: m.htmlBody,
      });
      // ส่งแล้วลบเนื้อหา (มีลิงก์/token) — เก็บแค่ข้อมูลตรวจย้อน
      await db.update({
        where: { id: m.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          lockedUntil: null,
          providerMessageId: r.messageId ?? null,
          textBody: null,
          htmlBody: null,
          error: null,
        },
      });
    } catch (err) {
      const retry = m.attempts < m.maxAttempts;
      const msg = String((err as Error).message ?? err).slice(0, 500);
      this.logger.warn(`email ${m.id} (${m.template}) failed attempt ${m.attempts}: ${msg}`);
      await db.update({
        where: { id: m.id },
        data: retry
          ? {
              status: 'PENDING',
              runAt: new Date(Date.now() + 2 ** m.attempts * 1000),
              lockedUntil: null,
              error: msg,
            }
          : { status: 'FAILED', lockedUntil: null, error: msg, textBody: null, htmlBody: null },
      });
    }
    return true;
  }

  /** ส่งที่ค้างทั้งหมด (test/งานเล็ก) */
  async drain(max = 100): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }
}
