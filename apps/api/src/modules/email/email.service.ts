import { Injectable, Logger } from '@nestjs/common';
import type { EmailOutbox, Prisma } from '@prisma/client';
import { PrismaService } from '../../db/prisma.service';
import { defaultFileStore } from '../../pdf/file-store';
import { isSandboxTenant } from '../sandbox/users';
import { renderEmail, type TemplateName, type TemplateVars } from './templates';
import { transportFromEnv, type EmailAttachment, type EmailTransport } from './transport';

type Writer = Pick<Prisma.TransactionClient, 'emailOutbox'>;

/** ไฟล์แนบใน outbox (ST5-T21) — อ้าง key ใน FileStore ของ tenant เดียวกับอีเมล; worker อ่านไฟล์ตอนส่ง */
export interface OutboxAttachment {
  fileKey: string;
  filename: string;
  contentType: string;
}

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
  /** ST5-T21 ไฟล์แนบ (key ต้องขึ้นต้นด้วย tenantId ของอีเมล) */
  attachments?: OutboxAttachment[];
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
    await this.enqueueMany(tx, [input]);
  }

  /** หลายฉบับใน INSERT เดียว (ST1-T23 แจ้งเตือนหลายผู้รับ) */
  async enqueueMany<K extends TemplateName>(tx: Writer, inputs: EnqueueEmail<K>[]): Promise<void> {
    if (!inputs.length) return;
    await tx.emailOutbox.createMany({
      data: inputs.map((input) => {
        const r = this.render(input);
        return {
          ...(input.id ? { id: input.id } : {}),
          tenantId: input.tenantId,
          toAddress: input.to,
          template: input.template,
          locale: input.locale,
          subject: r.subject,
          textBody: r.text,
          htmlBody: r.html,
          ...(input.runAt ? { runAt: input.runAt } : {}),
          ...(input.attachments?.length
            ? { attachments: input.attachments as unknown as Prisma.InputJsonValue }
            : {}),
        };
      }),
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
    // ST1-T23: แถว notification ช่องอีเมลเปลี่ยนสถานะในคำสั่งเดียวกับ outbox (ไม่ค้าง QUEUED ถ้าล้มกลางทาง)
    await this.prisma.platform.$executeRaw`
      WITH e AS (
        UPDATE email_outbox SET status = 'FAILED', locked_until = NULL, text_body = NULL, html_body = NULL,
               error = coalesce(error, 'lease expired'), updated_at = now()
         WHERE status = 'SENDING' AND locked_until < now() AND attempts >= max_attempts
        RETURNING id),
      n AS (
      UPDATE notification n SET status = 'FAILED', failed_reason = 'email_failed', updated_at = now()
        FROM e WHERE n.email_outbox_id = e.id AND n.status = 'QUEUED' RETURNING n.id)
      UPDATE document_email d SET status = 'FAILED', failed_reason = 'email_failed', updated_at = now()
        FROM e WHERE d.email_outbox_id = e.id AND d.status = 'QUEUED'`;
    return this.prisma.platform.$queryRaw<EmailOutbox[]>`
      WITH c AS (
        SELECT id FROM email_outbox
         WHERE (status = 'PENDING' AND run_at <= now())
            OR (status = 'SENDING' AND locked_until < now() AND attempts < max_attempts)
         -- อีเมลแจ้งเตือน (template notification เช่น สรุปเตือนวันหมดอายุ ST2-T18) ส่งหลังอีเมลยืนยันตัวตน
         -- (ลืมรหัสผ่าน/คำเชิญ ฯลฯ) ที่ถึงเวลาแล้ว — ไม่ให้ลิงก์ 30 นาทีรอคิวแจ้งเตือน
         ORDER BY (template = 'notification'), run_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE email_outbox e SET status = 'SENDING', attempts = e.attempts + 1,
             locked_until = now() + (${LEASE_MS}::int * interval '1 millisecond'), updated_at = now()
        FROM c WHERE e.id = c.id
      RETURNING e.id, e.tenant_id AS "tenantId", e.to_address AS "toAddress", e.subject, e.text_body AS "textBody",
                e.html_body AS "htmlBody", e.attempts, e.max_attempts AS "maxAttempts", e.template,
                e.attachments`;
  }

  /** ส่ง 1 ฉบับ — คืน true ถ้ามีงาน */
  async runOnce(): Promise<boolean> {
    const [m] = await this.claim();
    if (!m) return false;
    const db = this.prisma.platform;
    try {
      this.transport ??= transportFromEnv();
      if (!m.textBody || !m.htmlBody) throw new Error('email body missing');
      // ST7-T09: sandbox ไม่ส่งอีเมลออกไปหาคนจริง (ลูกค้า/รถร่วม/ผู้รับ) — บันทึกเป็น FAILED `sandbox_suppressed` ไม่ลองใหม่
      if (m.tenantId && (await isSandboxTenant(this.prisma.platform, m.tenantId))) {
        await db.$executeRaw`
          WITH e AS (
            UPDATE email_outbox SET status = 'FAILED', locked_until = NULL, error = 'sandbox_suppressed',
                   text_body = NULL, html_body = NULL, updated_at = now()
             WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}
            RETURNING id),
          n AS (
          UPDATE notification n SET status = 'FAILED', failed_reason = 'sandbox_suppressed', updated_at = now()
            FROM e WHERE n.email_outbox_id = e.id AND n.status = 'QUEUED' RETURNING n.id)
          UPDATE document_email d SET status = 'FAILED', failed_reason = 'sandbox_suppressed', updated_at = now()
            FROM e WHERE d.email_outbox_id = e.id AND d.status = 'QUEUED'`;
        this.logger.log(`email ${m.id} (${m.template}) suppressed — sandbox tenant`);
        return true;
      }
      const attachments = await loadAttachments(m.tenantId, m.attachments);
      const r = await this.transport.send({
        to: m.toAddress,
        subject: m.subject,
        text: m.textBody,
        html: m.htmlBody,
        ...(attachments.length ? { attachments } : {}),
      });
      // ส่งแล้วลบเนื้อหา (มีลิงก์/token) — เขียนเฉพาะถ้ายังเป็นรอบที่เราหยิบ (worker อื่นอาจหยิบซ้ำหลัง lease หมด)
      await db.$executeRaw`
        WITH e AS (
          UPDATE email_outbox SET status = 'SENT', sent_at = now(), locked_until = NULL,
                 provider_message_id = ${r.messageId ?? null}, text_body = NULL, html_body = NULL,
                 error = NULL, updated_at = now()
           WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}
          RETURNING id, sent_at),
        n AS (
        UPDATE notification n SET status = 'SENT', sent_at = e.sent_at, updated_at = now()
          FROM e WHERE n.email_outbox_id = e.id AND n.status = 'QUEUED' RETURNING n.id)
        UPDATE document_email d SET status = 'SENT', sent_at = e.sent_at, updated_at = now()
          FROM e WHERE d.email_outbox_id = e.id AND d.status = 'QUEUED'`;
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
          WITH e AS (
            UPDATE email_outbox SET status = 'FAILED', locked_until = NULL, error = ${msg},
                   text_body = NULL, html_body = NULL, updated_at = now()
             WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}
            RETURNING id),
          n AS (
          UPDATE notification n SET status = 'FAILED', failed_reason = 'email_failed', updated_at = now()
            FROM e WHERE n.email_outbox_id = e.id AND n.status = 'QUEUED' RETURNING n.id)
          UPDATE document_email d SET status = 'FAILED', failed_reason = 'email_failed', updated_at = now()
            FROM e WHERE d.email_outbox_id = e.id AND d.status = 'QUEUED'`;
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

/**
 * อ่านไฟล์แนบจาก FileStore (ST5-T21) — key ต้องอยู่ใต้ tenant ของอีเมล (กันอีเมลของ tenant หนึ่งแนบไฟล์ของอีกที่)
 * ไฟล์หาย/ผิด tenant → throw (outbox ลองใหม่ตามรอบแล้ว FAILED — ไม่ส่งอีเมลที่ไม่มีไฟล์แนบ)
 */
async function loadAttachments(tenantId: string | null, raw: unknown): Promise<EmailAttachment[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('attachments malformed');
  const out: EmailAttachment[] = [];
  for (const a of raw as OutboxAttachment[]) {
    if (!tenantId || typeof a?.fileKey !== 'string' || !a.fileKey.startsWith(`${tenantId}/`))
      throw new Error('attachment outside tenant');
    out.push({
      filename: a.filename,
      contentType: a.contentType,
      content: await defaultFileStore().get(a.fileKey),
    });
  }
  return out;
}
