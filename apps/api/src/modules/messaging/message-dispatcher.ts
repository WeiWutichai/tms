import { Injectable, Logger } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto';
import { PrismaService } from '../../db/prisma.service';
import { MessagingProviders } from './messaging.providers';
import { MessagingError, redactLinks, type MessageChannel } from './providers';

/** ต้องยาวกว่า timeout ของ provider (15 วิ) มาก — ไม่งั้น worker อื่นหยิบซ้ำระหว่างส่ง */
const LEASE_MS = 2 * 60_000;
/** รอบลองใหม่: 10, 20, 40, 80 วินาที … (base × 2^(ครั้งที่ − 1)) */
export const RETRY_BASE_S = 10;

interface Claimed {
  id: string;
  tenantId: string;
  channel: MessageChannel;
  recipientEnc: string | null;
  body: string | null;
  magicLinkId: string | null;
  attempts: number;
  maxAttempts: number;
}

/**
 * ส่งข้อความ LINE/SMS จาก outbox `message_delivery` (รันใน worker; ST3-T21) — แบบเดียวกับ EmailDispatcher (ST1-T03)
 * หยิบด้วย FOR UPDATE SKIP LOCKED ข้าม tenant (role platform) · ล้มแบบลองใหม่ได้ → backoff · ครบครั้ง/ลองใหม่ไม่ได้ → FAILED
 * จบแล้ว (SENT/FAILED) ลบ body + ผู้รับตัวจริง เหลือแค่แบบปิดบัง (PDPA)
 */
@Injectable()
export class MessageDispatcher {
  private readonly logger = new Logger('MessageDispatcher');
  private cipherInstance?: FieldCipher;

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: MessagingProviders,
  ) {}

  private get cipher() {
    return (this.cipherInstance ??= new FieldCipher());
  }

  private async claim(): Promise<Claimed[]> {
    const db = this.prisma.platform;
    // ค้าง SENDING เกิน lease และครบจำนวนครั้งแล้ว (worker ตายระหว่างส่ง) → FAILED ไม่วนไม่จบ
    await db.$executeRaw`
      UPDATE message_delivery SET status = 'FAILED', locked_until = NULL, body = NULL, recipient_enc = NULL,
             error_code = coalesce(error_code, 'lease_expired'), error = coalesce(error, 'lease expired'),
             failed_at = now(), updated_at = now()
       WHERE status = 'SENDING' AND locked_until < now() AND attempts >= max_attempts`;
    return db.$queryRaw<Claimed[]>`
      WITH c AS (
        SELECT id FROM message_delivery
         WHERE (status = 'QUEUED' AND run_at <= now())
            OR (status = 'SENDING' AND locked_until < now() AND attempts < max_attempts)
         ORDER BY run_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE message_delivery m SET status = 'SENDING', attempts = m.attempts + 1,
             locked_until = now() + (${LEASE_MS}::int * interval '1 millisecond'), updated_at = now()
        FROM c WHERE m.id = c.id
      RETURNING m.id, m.tenant_id AS "tenantId", m.channel, m.recipient_enc AS "recipientEnc", m.body,
                m.magic_link_id AS "magicLinkId", m.attempts, m.max_attempts AS "maxAttempts"`;
  }

  /** ส่ง 1 ข้อความ — คืน true ถ้ามีงาน */
  async runOnce(): Promise<boolean> {
    const [m] = await this.claim();
    if (!m) return false;
    try {
      const provider = this.providers.get(m.channel);
      if (!provider) throw new MessagingError('channel is disabled', 'channel_disabled', false);
      if (!m.body || !m.recipientEnc)
        throw new MessagingError('message body missing', 'body_missing', false);
      // ลิงก์ถูกเพิกถอน/หมดอายุระหว่างรอส่ง → ไม่ส่ง (ผู้รับเปิดแล้วใช้ไม่ได้)
      if (m.magicLinkId) {
        const link = await this.prisma.platform.magicLink.findUnique({
          where: { id: m.magicLinkId },
          select: { revokedAt: true, expiresAt: true },
        });
        if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now())
          throw new MessagingError('link is no longer active', 'link_inactive', false);
      }
      let lineToken: string | undefined;
      if (provider.needsTenantCredentials) {
        const s = await this.prisma.platform.messagingSetting.findUnique({
          where: { tenantId: m.tenantId },
          select: { lineEnabled: true, lineTokenEnc: true },
        });
        if (!s?.lineEnabled || !s.lineTokenEnc)
          throw new MessagingError('LINE channel is not configured', 'not_configured', false);
        lineToken = this.cipher.decrypt(s.lineTokenEnc);
      }
      const r = await provider.send({
        to: this.cipher.decrypt(m.recipientEnc),
        text: m.body,
        retryKey: m.id,
        ...(lineToken ? { credentials: { lineToken } } : {}),
      });
      // เขียนเฉพาะถ้ายังเป็นรอบที่เราหยิบ (worker อื่นอาจหยิบซ้ำหลัง lease หมด)
      await this.prisma.platform.$executeRaw`
        UPDATE message_delivery SET status = 'SENT', sent_at = now(), locked_until = NULL, body = NULL,
               recipient_enc = NULL, provider = ${provider.name}, provider_message_id = ${r.messageId ?? null},
               error = NULL, error_code = NULL, updated_at = now()
         WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}`;
    } catch (err) {
      const e =
        err instanceof MessagingError
          ? err
          : new MessagingError(String((err as Error).message ?? err), 'internal_error', true);
      const msg = redactLinks(e.message).slice(0, 500);
      this.logger.warn(
        `message ${m.id} (${m.channel}) failed attempt ${m.attempts}: ${e.code} ${msg}`,
      );
      if (e.retryable && m.attempts < m.maxAttempts)
        await this.prisma.platform.$executeRaw`
          UPDATE message_delivery SET status = 'QUEUED', locked_until = NULL, error = ${msg}, error_code = ${e.code},
                 run_at = now() + (${RETRY_BASE_S * 2 ** (m.attempts - 1)}::int * interval '1 second'), updated_at = now()
           WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}`;
      else
        await this.prisma.platform.$executeRaw`
          UPDATE message_delivery SET status = 'FAILED', locked_until = NULL, error = ${msg}, error_code = ${e.code},
                 body = NULL, recipient_enc = NULL, failed_at = now(), updated_at = now()
           WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}`;
    }
    return true;
  }

  /** ส่งที่ถึงเวลาทั้งหมด (test/งานเล็ก) */
  async drain(max = 100): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }
}
