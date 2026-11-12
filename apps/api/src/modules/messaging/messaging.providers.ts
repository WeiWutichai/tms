import { Injectable } from '@nestjs/common';
import {
  lineProviderFromEnv,
  smsProviderFromEnv,
  type MessageChannel,
  type MessagingProvider,
} from './providers';

/**
 * ผู้ให้บริการ LINE/SMS ที่ระบบใช้ (เลือกจาก env ตอนเริ่ม — ตั้งผิด = ล้มตั้งแต่บูต ทั้ง api และ worker)
 * null = ปิดช่องนั้น (ปุ่มส่งซ่อน → คัดลอกลิงก์) · test เปลี่ยนด้วย `use()`
 */
@Injectable()
export class MessagingProviders {
  private readonly map = new Map<MessageChannel, MessagingProvider | null>();

  constructor() {
    this.map.set('LINE', lineProviderFromEnv());
    this.map.set('SMS', smsProviderFromEnv());
  }

  get(channel: MessageChannel): MessagingProvider | null {
    return this.map.get(channel) ?? null;
  }

  use(channel: MessageChannel, provider: MessagingProvider | null): void {
    if (provider && provider.channel !== channel) throw new Error('provider channel mismatch');
    this.map.set(channel, provider);
  }
}
