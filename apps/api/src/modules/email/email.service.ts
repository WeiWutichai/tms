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
  /** กำหนด id เอง (ST1-T23: แถว notification ช่องอีเมลอ้างถึงแถว outbox — role แอปไม่มี RETURNING) */
  id?: string;
}

/**
 * อีเมล transactional (ST1-T03) — outbox: เขียนแถวใน transaction เดียวกับงาน (rollback = ไม่ส่ง)
 * แล้ว worker ส่งทีหลังด้วย `EmailDispatcher` · render ตอน enqueue (template เปลี่ยนภายหลังไม่กระทบอีเมลที่รอส่ง)
 */
@Injectable()
export class EmailService {
  render<K extends TemplateName>(input: EnqueueEmail<K>) {
    return renderEmail(input.template, input.locale, input.vars);
  }

  /** createMany (ไม่มี RETURNING) — role แอปมีสิทธิ์ INSERT อย่างเดียว อ่านเนื้ออีเมล (มี token) ไม่ได้ */
  async enqueue<K extends TemplateName>(tx: Writer, input: EnqueueEmail<K>): Promise<void> {
    const r = this.render(input);
    await tx.emailOutbox.createMany({
      data: {
        ...(input.id ? { id: input.id } : {}),
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

/** ต้องยาวกว่า timeout ของ SMTP รวมกัน (transport.ts: 20+20+60 วิ) — ไม่งั้น worker อื่นหยิบซ้ำระหว่างส่ง */
const LEASE_MS = 5 * 60_000;

/** ส่งอีเมลจาก outbox (รันใน worker) — หยิบด้วย FOR UPDATE SKIP LOCKED ข้าม tenant, ลองใหม่แบบ backoff */
@Injectable()
export class EmailDispatcher {
  private readonly logger = new Logger('EmailDispatcher');
  private transport?: EmailTransport;

  constructor(private readonly prisma: PrismaService) {}

  /** ตรวจการตั้งค่าตอนเริ่ม worker — ผิดให้ล้มทันที ไม่ใช่ลองส่ง 5 ครั้งแล้ว FAILED เงียบ ๆ */
  init() {
    this.transport ??= transportFromEnv();
  }

  /** test ใส่ MemoryTransport ได้ */
  use(transport: EmailTransport) {
    this.transport = transport;
  }

  private async claim(): Promise<EmailOutbox[]> {
    // ค้าง SENDING เกิน lease และครบจำนวนครั้งแล้ว (worker ตายระหว่างส่ง) → FAILED ไม่วนไม่จบ
    const stale = await this.prisma.platform.$executeRaw`
      UPDATE email_outbox SET status = 'FAILED', locked_until = NULL, text_body = NULL, html_body = NULL,
             error = coalesce(error, 'lease expired'), updated_at = now()
       WHERE status = 'SENDING' AND locked_until < now() AND attempts >= max_attempts`;
    if (stale > 0) await this.syncNotifications();
    return this.prisma.platform.$queryRaw<EmailOutbox[]>`
      WITH c AS (
        SELECT id FROM email_outbox
         WHERE (status = 'PENDING' AND run_at <= now())
            OR (status = 'SENDING' AND locked_until < now() AND attempts < max_attempts)
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

  /**
   * ST1-T23: สถานะแถว notification ช่องอีเมลตามผลใน outbox (SENT/FAILED) — ไม่ระบุ id = ไล่ทุกแถวที่ค้าง
   * (เช่น outbox ถูกตั้ง FAILED เพราะ lease หมด) · เขียนด้วย role platform; error ไม่ใส่ (อาจมีชื่อ host SMTP)
   */
  private async syncNotifications(outboxId?: string): Promise<void> {
    await this.prisma.platform.$executeRaw`
      UPDATE notification n
         SET status = CASE WHEN e.status = 'SENT' THEN 'SENT'::"NotificationStatus" ELSE 'FAILED'::"NotificationStatus" END,
             sent_at = CASE WHEN e.status = 'SENT' THEN e.sent_at ELSE n.sent_at END,
             failed_reason = CASE WHEN e.status = 'FAILED' THEN 'email_failed' ELSE NULL END,
             updated_at = now()
        FROM email_outbox e
       WHERE n.email_outbox_id = e.id AND n.status = 'QUEUED' AND e.status IN ('SENT', 'FAILED')
         AND (${outboxId ?? null}::uuid IS NULL OR e.id = ${outboxId ?? null}::uuid)`;
  }

  /** ส่ง 1 ฉบับ — คืน true ถ้ามีงาน */
  async runOnce(): Promise<boolean> {
    const [m] = await this.claim();
    if (!m) return false;
    const db = this.prisma.platform;
    try {
      this.transport ??= transportFromEnv();
      if (!m.textBody || !m.htmlBody) throw new Error('email body missing');
      const r = await this.transport.send({
        to: m.toAddress,
        subject: m.subject,
        text: m.textBody,
        html: m.htmlBody,
      });
      // ส่งแล้วลบเนื้อหา (มีลิงก์/token) — เขียนเฉพาะถ้ายังเป็นรอบที่เราหยิบ (worker อื่นอาจหยิบซ้ำหลัง lease หมด)
      await db.$executeRaw`
        UPDATE email_outbox SET status = 'SENT', sent_at = now(), locked_until = NULL,
               provider_message_id = ${r.messageId ?? null}, text_body = NULL, html_body = NULL,
               error = NULL, updated_at = now()
         WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}`;
      await this.syncNotifications(m.id);
    } catch (err) {
      const msg = String((err as Error).message ?? err).slice(0, 500);
      this.logger.warn(`email ${m.id} (${m.template}) failed attempt ${m.attempts}: ${msg}`);
      // เวลาลองใหม่คิดด้วยนาฬิกาของฐานข้อมูล (เทียบกับ now() ตอนหยิบ)
      if (m.attempts < m.maxAttempts)
        await db.$executeRaw`
          UPDATE email_outbox SET status = 'PENDING', locked_until = NULL, error = ${msg},
                 run_at = now() + (${2 ** m.attempts}::int * interval '1 second'), updated_at = now()
           WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}`;
      else
        await db.$executeRaw`
          UPDATE email_outbox SET status = 'FAILED', locked_until = NULL, error = ${msg},
                 text_body = NULL, html_body = NULL, updated_at = now()
           WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}`;
      await this.syncNotifications(m.id);
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
