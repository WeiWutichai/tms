import { Injectable } from '@nestjs/common';

/**
 * นาฬิกาที่ฉีดได้ (ST2-T18) — งานที่ขึ้นกับ "วันนี้" (job เตือนวันหมดอายุ) อ่านเวลาผ่านตัวนี้
 * test เลื่อนเวลาด้วย `clock.set(...)` แทนการแก้เวลาเครื่อง
 */
@Injectable()
export class Clock {
  private fixed: Date | null = null;

  now(): Date {
    return this.fixed ? new Date(this.fixed.getTime()) : new Date();
  }

  /** ใช้ใน test เท่านั้น — null = กลับไปใช้เวลาจริง */
  set(at: Date | null): void {
    this.fixed = at ? new Date(at.getTime()) : null;
  }
}
