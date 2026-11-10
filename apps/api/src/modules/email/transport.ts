import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { isLocalEnv } from '../../auth/tokens';

/**
 * ช่องส่งอีเมล (ST1-T03) — ยังไม่เลือกผู้ให้บริการ (D-32 [OPEN]) จึงมีแค่ 2 แบบที่ไม่ผูกเจ้าใด
 * - `log`  : dev/test — เขียนลง log (เนื้อหาเต็มเฉพาะ NODE_ENV development/test)
 * - `smtp` : SMTP มาตรฐาน (`EMAIL_SMTP_URL` เช่น smtps://user:pass@host:465) — ใช้กับ SES/SendGrid/Mailgun/Postmark ได้ทุกเจ้า
 * ผู้ให้บริการที่มี API เฉพาะเพิ่มเป็น transport ใหม่ได้โดยไม่แตะผู้เรียก
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface EmailTransport {
  readonly name: string;
  send(m: EmailMessage): Promise<{ messageId?: string }>;
}

export class LogTransport implements EmailTransport {
  readonly name = 'log';
  private readonly log = new Logger('Email');
  async send(m: EmailMessage) {
    // นอกเครื่อง dev ห้ามเขียนเนื้อหา (มี token/ลิงก์) ลง log
    if (isLocalEnv()) this.log.log(`to=${m.to} subject=${m.subject}\n${m.text}`);
    else this.log.log(`to=${m.to} subject=${m.subject} (body hidden)`);
    return {};
  }
}

/** เก็บไว้ในหน่วยความจำ — ใช้ใน test */
export class MemoryTransport implements EmailTransport {
  readonly name = 'memory';
  readonly sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { messageId: `mem-${this.sent.length}` };
  }
}

export class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private readonly t;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.t = createTransport(url);
  }
  async send(m: EmailMessage) {
    const r = await this.t.sendMail({ from: this.from, ...m });
    return { messageId: r.messageId };
  }
}

/** เลือกจาก env — นอก dev/test ต้องตั้ง smtp ชัด ๆ (ไม่ตกไปใช้ log เงียบ ๆ แล้วผู้ใช้ไม่ได้อีเมล) */
export function transportFromEnv(env = process.env): EmailTransport {
  const kind = env.EMAIL_TRANSPORT ?? (isLocalEnv() ? 'log' : 'smtp');
  if (kind === 'log') {
    if (!isLocalEnv()) throw new Error('EMAIL_TRANSPORT=log is only allowed in development/test');
    return new LogTransport();
  }
  if (kind === 'smtp') {
    if (!env.EMAIL_SMTP_URL) throw new Error('EMAIL_SMTP_URL is required for EMAIL_TRANSPORT=smtp');
    return new SmtpTransport(env.EMAIL_SMTP_URL, env.EMAIL_FROM ?? 'TMS <no-reply@localhost>');
  }
  throw new Error(`unknown EMAIL_TRANSPORT '${kind}'`);
}
