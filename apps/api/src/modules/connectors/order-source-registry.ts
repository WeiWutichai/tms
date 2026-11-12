import { Injectable } from '@nestjs/common';
import { CONNECTOR_KEY_RE } from '@tms/domain';
import { isLocalEnv } from '../../auth/tokens';
import type { ExternalOrder, OrderSourcePort, PullContext, PullPage } from './order-source.port';

/**
 * ต้นทางจำลองในหน่วยความจำ (ST3-T05) — dev/test เท่านั้น (production ปฏิเสธ เหมือน GEO_PROVIDER=mock)
 * เก็บคิว order ต่อ tenant; cursor = ลำดับในคิว · ส่งใบเดิม (externalId เดิม) ซ้ำได้ = จำลองต้นทางแก้ใบ
 */
export class MockOrderSource implements OrderSourcePort {
  readonly key: string;
  private readonly feed = new Map<string, ExternalOrder[]>();
  /** test: หน่วงเวลาตอนดึง (จำลองต้นทางช้า — ทดสอบดึงพร้อมกัน) */
  delayMs = 0;
  /** test: ดึงครั้งถัดไปล้ม (จำลองต้นทางล่ม) */
  failNext: Error | null = null;
  calls = 0;

  constructor(key = 'mock') {
    if (!isLocalEnv()) throw new Error('mock order source is only allowed in development/test');
    this.key = key;
  }

  /** เพิ่ม order ท้ายคิวของ tenant */
  push(tenantId: string, ...orders: ExternalOrder[]): void {
    this.feed.set(tenantId, [...(this.feed.get(tenantId) ?? []), ...orders]);
  }

  reset(): void {
    this.feed.clear();
    this.delayMs = 0;
    this.failNext = null;
    this.calls = 0;
  }

  async pullOrders(ctx: PullContext, since: string | null, limit: number): Promise<PullPage> {
    this.calls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const all = this.feed.get(ctx.tenantId) ?? [];
    const from = since && /^\d+$/.test(since) ? Number(since) : 0;
    const orders = all.slice(from, from + limit);
    const next = from + orders.length;
    return {
      // สำเนา (ผู้เรียกแก้ไม่กระทบคิว) — ค่าที่ clone ไม่ได้ (ฟังก์ชัน/getter: จำลองข้อมูลพิษ) ส่งตัวจริง
      orders: orders.map((o) => {
        try {
          return structuredClone(o);
        } catch {
          return o;
        }
      }),
      nextCursor: String(next),
      hasMore: next < all.length,
    };
  }
}

/**
 * ทะเบียน adapter ขาเข้า (ST3-T05) — core หา port จากรหัส connector เท่านั้น ไม่รู้จัก ERP ใดเป็นพิเศษ
 * ตอนนี้มีเฉพาะ `mock` (dev/test) · ST7-T13 แทนด้วย registry ต่อ tenant จากตาราง `connector` · ST8 ลงทะเบียน KRS adapter
 */
@Injectable()
export class OrderSourceRegistry {
  private readonly ports = new Map<string, OrderSourcePort>();

  constructor() {
    if (isLocalEnv()) this.register(new MockOrderSource());
  }

  register(port: OrderSourcePort): void {
    if (!CONNECTOR_KEY_RE.test(port.key)) throw new Error(`invalid connector key '${port.key}'`);
    if (port instanceof MockOrderSource && !isLocalEnv())
      throw new Error('mock order source is only allowed in development/test');
    this.ports.set(port.key, port);
  }

  /** ไม่มี = null (job ล้มพร้อมข้อความ — ไม่เดา adapter) */
  get(key: string): OrderSourcePort | null {
    return this.ports.get(key) ?? null;
  }

  /** test: mock ที่ลงทะเบียนไว้ */
  mock(key = 'mock'): MockOrderSource {
    const p = this.ports.get(key);
    if (!(p instanceof MockOrderSource)) throw new Error(`no mock order source '${key}'`);
    return p;
  }
}
