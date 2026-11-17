import { Injectable } from '@nestjs/common';
import { DemoSink } from './demo-sink';
import type { OutboxSink } from './outbox.types';

/**
 * ทะเบียน sink ของ outbox (ST7-T03) — webhook dispatcher (ST7-T04) / ERP push (ST7-T16) ลงทะเบียนตอนเริ่ม module
 * มี `demo` (DemoSink) ติดมาเสมอ — ใช้ได้เฉพาะ tenant ที่มี subscription `demo` (สร้างใน test/dev เท่านั้น)
 */
@Injectable()
export class OutboxSinkRegistry {
  private readonly sinks = new Map<string, OutboxSink>();
  readonly demo = new DemoSink();

  constructor() {
    this.register(this.demo);
  }

  register(sink: OutboxSink): void {
    if (this.sinks.has(sink.key)) throw new Error(`outbox sink '${sink.key}' already registered`);
    this.sinks.set(sink.key, sink);
  }

  /** test: แทนที่ sink เดิม */
  replace(sink: OutboxSink): void {
    this.sinks.set(sink.key, sink);
  }

  get(key: string): OutboxSink | undefined {
    return this.sinks.get(key);
  }
}
