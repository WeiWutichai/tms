import { Injectable, Logger } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto';
import { PrismaService } from '../../db/prisma.service';
import { isLinkKind, linkUrl } from './link-kinds';
import { MessagingProviders } from './messaging.providers';
import { MessagingError, safeError, type MessageChannel } from './providers';
import { MESSAGE_TEMPLATES, renderMessage, type MessageTemplate } from './templates';

/** ต้องยาวกว่า timeout ของ provider (15 วิ) มาก — ไม่งั้น worker อื่นหยิบซ้ำระหว่างส่ง */
const LEASE_MS = 2 * 60_000;
/** รอบลองใหม่: 10, 20, 40, 80 วินาที … (base × 2^(ครั้งที่ − 1)) */
export const RETRY_BASE_S = 10;

interface Claimed {
  id: string;
  tenantId: string;
  channel: MessageChannel;
  template: string;
  locale: string;
  recipientEnc: string | null;
  vars: {
    sender?: string;
    recipientName?: string | null;
    ref?: string | null;
    yearStyle?: string;
  } | null;
  magicLinkId: string | null;
  attempts: number;
  maxAttempts: number;
}

/**
 * ส่งข้อความ LINE/SMS จาก outbox `message_delivery` (รันใน worker; ST3-T21) — แบบเดียวกับ EmailDispatcher (ST1-T03)
 * หยิบด้วย FOR UPDATE SKIP LOCKED ข้าม tenant (role platform) · ล้มแบบลองใหม่ได้ → backoff · ครบครั้ง/ลองใหม่ไม่ได้ → FAILED
 * render ข้อความ + สร้าง URL ลิงก์ (จาก magic_link id + วันหมดอายุ) ตอนส่ง — outbox ไม่มี token ค้างในฐาน (review M2)
 * จบแล้ว (SENT/FAILED) ลบตัวแปรข้อความ + ผู้รับตัวจริง เหลือแค่แบบปิดบัง (PDPA)
 * provider รับไปแล้วแต่บันทึก SENT ไม่สำเร็จ → ไม่ตั้งรอบลองใหม่เอง; ถ้า lease หมดแล้วถูกหยิบซ้ำ กันส่งซ้ำด้วย retry key
 * (LINE `X-Line-Retry-Key` รับประกันฝั่ง LINE · SMS ขึ้นกับผู้ให้บริการรองรับ `Idempotency-Key` — เงื่อนไขตอนเลือกเจ้า #49)
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
      UPDATE message_delivery SET status = 'FAILED', locked_until = NULL, vars = NULL, recipient_enc = NULL,
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
      RETURNING m.id, m.tenant_id AS "tenantId", m.channel, m.template, m.locale,
                m.recipient_enc AS "recipientEnc", m.vars, m.magic_link_id AS "magicLinkId",
                m.attempts, m.max_attempts AS "maxAttempts"`;
  }

  /** ข้อความที่จะส่ง — ลิงก์ถูกเพิกถอน/หมดอายุระหว่างรอ = ไม่ส่ง */
  private async compose(m: Claimed): Promise<string> {
    if (!m.vars || !m.magicLinkId || !(MESSAGE_TEMPLATES as readonly string[]).includes(m.template))
      throw new MessagingError('message data missing', 'body_missing', false);
    const link = await this.prisma.platform.magicLink.findUnique({
      where: { id: m.magicLinkId },
      select: { id: true, tenantId: true, purpose: true, revokedAt: true, expiresAt: true },
    });
    if (
      !link ||
      link.tenantId !== m.tenantId ||
      !isLinkKind(link.purpose) ||
      link.revokedAt ||
      link.expiresAt.getTime() <= Date.now()
    )
      throw new MessagingError('link is no longer active', 'link_inactive', false);
    return renderMessage(m.template as MessageTemplate, m.channel, m.locale, {
      sender: m.vars.sender ?? 'TMS',
      recipientName: m.vars.recipientName ?? null,
      ref: m.vars.ref ?? null,
      url: linkUrl(link.purpose, link),
      expiresAt: link.expiresAt,
      yearStyle: m.vars.yearStyle === 'CE' ? 'CE' : 'BE',
    });
  }

  /** ส่ง 1 ข้อความ — คืน true ถ้ามีงาน */
  async runOnce(): Promise<boolean> {
    const [m] = await this.claim();
    if (!m) return false;
    let delivered: { provider: string; messageId: string | null } | null = null;
    try {
      const provider = this.providers.get(m.channel);
      if (!provider) throw new MessagingError('channel is disabled', 'channel_disabled', false);
      if (!m.recipientEnc) throw new MessagingError('recipient missing', 'body_missing', false);
      const text = await this.compose(m);
      // ช่องถูกปิด/ยังไม่ตั้งค่าระหว่างรอส่ง → ไม่ส่ง (ตรวจตอนส่งทั้ง LINE และ SMS — QA ST3-T21)
      const s = await this.prisma.platform.messagingSetting.findUnique({
        where: { tenantId: m.tenantId },
        select: { lineEnabled: true, lineTokenEnc: true, smsEnabled: true },
      });
      const enabled = m.channel === 'SMS' ? s?.smsEnabled : s?.lineEnabled;
      if (!enabled || (provider.needsTenantCredentials && !s?.lineTokenEnc))
        throw new MessagingError(`${m.channel} channel is not configured`, 'not_configured', false);
      const lineToken =
        provider.needsTenantCredentials && s?.lineTokenEnc
          ? this.cipher.decrypt(s.lineTokenEnc)
          : undefined;
      const r = await provider.send({
        to: this.cipher.decrypt(m.recipientEnc),
        text,
        retryKey: m.id,
        ...(lineToken ? { credentials: { lineToken } } : {}),
      });
      delivered = { provider: provider.name, messageId: r.messageId ?? null };
      // เขียนเฉพาะถ้ายังเป็นรอบที่เราหยิบ (worker อื่นอาจหยิบซ้ำหลัง lease หมด)
      await this.prisma.platform.$executeRaw`
        UPDATE message_delivery SET status = 'SENT', sent_at = now(), locked_until = NULL, vars = NULL,
               recipient_enc = NULL, provider = ${delivered.provider},
               provider_message_id = ${delivered.messageId}, error = NULL, error_code = NULL, updated_at = now()
         WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}`;
    } catch (err) {
      if (delivered) {
        // ส่งถึง provider แล้ว — ห้ามตั้งรอบลองใหม่ (ส่งซ้ำ); ปล่อยให้ lease หมด → หยิบซ้ำด้วย retry key เดิม
        this.logger.error(`message ${m.id} delivered but status update failed: ${safeError(err)}`);
        return true;
      }
      const e =
        err instanceof MessagingError
          ? err
          : new MessagingError(safeError(err), 'internal_error', true);
      // เก็บแค่รหัส + ข้อความสั้นที่ตัดตัวเลขยาว/ลิงก์แล้ว (ไม่เก็บ response ของ provider ทั้งก้อน)
      const msg = safeError(e);
      this.logger.warn(`message ${m.id} (${m.channel}) failed attempt ${m.attempts}: ${e.code}`);
      if (e.retryable && m.attempts < m.maxAttempts)
        await this.prisma.platform.$executeRaw`
          UPDATE message_delivery SET status = 'QUEUED', locked_until = NULL, error = ${msg}, error_code = ${e.code},
                 run_at = now() + (${RETRY_BASE_S * 2 ** (m.attempts - 1)}::int * interval '1 second'), updated_at = now()
           WHERE id = ${m.id}::uuid AND status = 'SENDING' AND attempts = ${m.attempts}`;
      else
        await this.prisma.platform.$executeRaw`
          UPDATE message_delivery SET status = 'FAILED', locked_until = NULL, error = ${msg}, error_code = ${e.code},
                 vars = NULL, recipient_enc = NULL, failed_at = now(), updated_at = now()
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
