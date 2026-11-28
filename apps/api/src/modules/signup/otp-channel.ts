import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isLocalEnv } from '../../auth/tokens';
import { EmailService } from '../email/email.service';

/**
 * ช่องทางส่ง OTP ของการสมัคร (P1-ST2-T03; spec/01 §2 ขั้น 1 ข้อ 8; plan/13 X-04)
 * interface กลาง — ไม่ผูกผู้ให้บริการ SMS ใด · เลือกด้วย env `OTP_CHANNEL`:
 * - `email` (ค่าเริ่ม) — ส่งรหัสทางอีเมลผ่าน outbox (เนื้ออีเมลถูกลบหลังส่ง) จนกว่าจะได้ผู้ให้บริการ SMS (X-04)
 * - `sms` — `SmsOtpChannel` + `SmsSender` · **ยังไม่มีผู้ให้บริการ** (stub ปิดไว้): ตั้ง `sms` โดยไม่มี sender = API ไม่ยอมเริ่ม
 * ส่งใน transaction ของผู้เรียก (rollback = ไม่ส่ง)
 */
export type OtpChannelKind = 'email' | 'sms';

export interface OtpMessage {
  /** ปลายทางตามช่องทาง — อีเมล (lower-case) หรือเบอร์ E.164 (+66…) */
  to: string;
  code: string;
  locale: string;
  ttlMinutes: number;
}

export type OtpWriter = Pick<Prisma.TransactionClient, 'emailOutbox'>;

export interface OtpChannel {
  readonly kind: OtpChannelKind;
  /** เลือกปลายทางจากข้อมูลผู้สมัคร */
  destination(applicant: { email: string; mobile: string }): string;
  send(tx: OtpWriter, msg: OtpMessage): Promise<void>;
}

export class EmailOtpChannel implements OtpChannel {
  readonly kind = 'email' as const;
  constructor(private readonly email: EmailService) {}
  destination(a: { email: string }) {
    return a.email;
  }
  async send(tx: OtpWriter, msg: OtpMessage) {
    await this.email.enqueue(tx, {
      tenantId: null,
      to: msg.to,
      template: 'signup_otp',
      locale: msg.locale === 'en' ? 'en' : 'th',
      vars: { code: msg.code, minutes: msg.ttlMinutes },
    });
  }
}

/** ผู้ให้บริการ SMS (X-04) — ต่อเมื่อได้สัญญา; ข้อความไม่ควรเกิน 1 segment */
export interface SmsSender {
  readonly name: string;
  send(to: string, text: string): Promise<void>;
}

/**
 * SMS adapter (stub — ปิดเป็นค่าเริ่ม) · ส่งนอก transaction ไม่ได้ย้อน → ส่งทันทีหลังบันทึก hash
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] เมื่อได้ผู้ให้บริการ: ย้ายไปคิวแบบ outbox เหมือนอีเมล
 */
export class SmsOtpChannel implements OtpChannel {
  readonly kind = 'sms' as const;
  constructor(private readonly sender: SmsSender) {}
  destination(a: { mobile: string }) {
    return a.mobile;
  }
  async send(_tx: OtpWriter, msg: OtpMessage) {
    const text =
      msg.locale === 'en'
        ? `TMS sign-up code: ${msg.code} (valid ${msg.ttlMinutes} min). Do not share.`
        : `รหัสยืนยันการสมัคร TMS: ${msg.code} (ใช้ได้ ${msg.ttlMinutes} นาที) ห้ามบอกผู้อื่น`;
    await this.sender.send(msg.to, text);
  }
}

/** สร้างช่องทางจาก env — ค่าผิด / `sms` ที่ยังไม่มีผู้ให้บริการ = API ไม่ยอมเริ่ม (ไม่ส่ง OTP หายเงียบ) */
export function createOtpChannel(
  email: EmailService,
  env: Record<string, string | undefined> = process.env,
  sms?: SmsSender,
): OtpChannel {
  const kind = (env.OTP_CHANNEL ?? 'email').trim().toLowerCase();
  if (kind === 'email' || kind === '') return new EmailOtpChannel(email);
  if (kind === 'sms') {
    if (!sms)
      throw new Error('OTP_CHANNEL=sms แต่ยังไม่มีผู้ให้บริการ SMS (X-04) — ใช้ OTP_CHANNEL=email');
    return new SmsOtpChannel(sms);
  }
  throw new Error(`OTP_CHANNEL ไม่รู้จัก: ${kind} (ใช้ email | sms)`);
}

/** ตัวถือช่องทาง (test เปลี่ยน `channel` เป็นของปลอมได้) */
@Injectable()
export class OtpChannelService {
  channel: OtpChannel;
  constructor(email: EmailService) {
    this.channel = createOtpChannel(email);
    if (this.channel.kind === 'email' && !isLocalEnv())
      new Logger('OtpChannel').log(
        'OTP การสมัครส่งทางอีเมล (OTP_CHANNEL=email) — SMS รอผู้ให้บริการ X-04',
      );
  }
}
