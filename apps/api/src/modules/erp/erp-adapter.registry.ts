import { Injectable } from '@nestjs/common';
import { isLocalEnv } from '../../auth/tokens';
import {
  adapterShapeProblems,
  type ErpAdapter,
  STANDALONE_ADAPTER,
  STANDALONE_KEY,
} from './erp-adapter';

/**
 * ทะเบียน ErpAdapter ในโค้ด (ST7-T13; docs/01 §6.1; plan/00a: catalog ของ adapter อยู่ในโค้ด ไม่ใช่ตาราง)
 * - adapter ลงทะเบียนจาก `src/erp-adapters/index.ts` เท่านั้น (composition root) — core หา adapter จาก `adapter_key` ไม่รู้จัก ERP ใดเป็นพิเศษ
 * - `standalone` สงวนไว้ = ไม่มี connector (คืนเมื่อหาไม่พบ — ไม่เดา adapter)
 * - adapter `localOnly` (Demo) ลงทะเบียนได้เฉพาะ dev/test หรือเมื่อ `ERP_DEMO_ADAPTERS=1` (staging/sandbox — docs/04 G3)
 */
@Injectable()
export class ErpAdapterRegistry {
  private readonly adapters = new Map<string, ErpAdapter>();
  readonly standalone = STANDALONE_ADAPTER;

  /**
   * adapter จำลองใช้ได้ไหม: dev/test เสมอ · staging/sandbox ต้องตั้ง `ERP_DEMO_ADAPTERS=1` ·
   * `NODE_ENV=production` **ไม่ได้เลย** แม้ตั้งธง (ST7-T14 review — staging ต้องตั้ง NODE_ENV อื่น เช่น `staging`)
   */
  static demoAllowed(): boolean {
    if (isLocalEnv()) return true;
    return process.env.NODE_ENV !== 'production' && process.env.ERP_DEMO_ADAPTERS === '1';
  }

  /** adapter ที่รู้จักแต่ปิดใน environment นี้ (localOnly ใน production) — connector ที่ค้างอยู่ = ใช้ไม่ได้ ไม่ใช่ "รอ deploy" */
  private readonly refused = new Set<string>();

  refuse(key: string): void {
    if (!this.adapters.has(key)) this.refused.add(key);
  }

  isRefused(key: string): boolean {
    return this.refused.has(key) && !this.adapters.has(key);
  }

  refusedKeys(): string[] {
    return [...this.refused].filter((k) => !this.adapters.has(k)).sort();
  }

  register(adapter: ErpAdapter): void {
    if (adapter.key === STANDALONE_KEY)
      throw new Error(`erp adapter key '${STANDALONE_KEY}' is reserved`);
    if (this.adapters.has(adapter.key))
      throw new Error(`erp adapter '${adapter.key}' already registered`);
    this.put(adapter);
  }

  /** test: แทนที่/เพิ่ม adapter */
  replace(adapter: ErpAdapter): void {
    this.put(adapter);
  }

  /** test: เอา adapter ออก */
  unregister(key: string): void {
    this.adapters.delete(key);
  }

  private put(adapter: ErpAdapter) {
    if (adapter.localOnly && !ErpAdapterRegistry.demoAllowed())
      throw new Error(`erp adapter '${adapter.key}' is only allowed in development/test/sandbox`);
    const problems = adapterShapeProblems(adapter);
    if (problems.length)
      throw new Error(`erp adapter '${adapter.key}' invalid: ${problems.join('; ')}`);
    this.adapters.set(adapter.key, adapter);
  }

  /** ไม่มี = null (core ถือว่า adapter หาย — ไม่ใช่ Standalone, คำสั่งรอคิว) */
  get(key: string): ErpAdapter | null {
    if (key === STANDALONE_KEY) return this.standalone;
    return this.adapters.get(key) ?? null;
  }

  /** adapter ที่เปิดเป็น connector ได้ เรียงตามรหัส (spec/07 INT-010: ไม่มีตัวใดเป็นค่าเริ่มต้น) */
  list(): ErpAdapter[] {
    return [...this.adapters.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}
