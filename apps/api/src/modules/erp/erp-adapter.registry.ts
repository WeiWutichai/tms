import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { isSandboxTenant } from '../sandbox/users';
import { isLocalEnv } from '../../auth/tokens';
import { type ConnectorDefinition, definitionProblems } from './connector-definition';
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
 * - adapter `localOnly` (Demo) ใช้ได้ทุก tenant เฉพาะ dev/test หรือเมื่อ `ERP_DEMO_ADAPTERS=1` (staging — docs/04 G3) ·
 *   environment อื่น (production cluster) = **ใช้ได้เฉพาะ tenant sandbox** (`mode = test` — D-81 · D68-58/D68-96; docs/04 G3/J)
 * - tenant sandbox ใช้ได้เฉพาะ adapter `localOnly` — connector จริงใน sandbox ยังปิด (ไม่ส่งออกนอกระบบ — ST7-T09)
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
    // หมายเหตุ D68-96: false ไม่ได้แปลว่าปิด demo ทั้งหมด — tenant sandbox ยังใช้ได้ (`usableIn`)
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

  /** adapter จำลองที่ environment นี้ให้ใช้เฉพาะ tenant sandbox (D68-96) */
  private readonly sandboxOnly = new Set<string>();

  isSandboxOnly(key: string): boolean {
    return this.sandboxOnly.has(key) && this.adapters.has(key);
  }

  /**
   * D-81 · D68-58/D68-96 adapter ที่ tenant โหมดนี้ใช้ได้ (null = ใช้ไม่ได้/ไม่มี):
   * sandbox (`mode = test`) → เฉพาะ `localOnly` (DemoProvider) · บริษัทจริง → ทุกตัว ยกเว้น demo ที่ environment นี้ให้ใช้เฉพาะ sandbox
   */
  usableIn(key: string, sandbox: boolean): ErpAdapter | null {
    const a = this.get(key);
    if (!a || a === this.standalone) return a;
    if (sandbox) return a.localOnly ? a : null;
    return this.sandboxOnly.has(key) ? null : a;
  }

  register(adapter: ErpAdapter): void {
    if (adapter.key === STANDALONE_KEY)
      throw new Error(`erp adapter key '${STANDALONE_KEY}' is reserved`);
    if (this.adapters.has(adapter.key))
      throw new Error(`erp adapter '${adapter.key}' already registered`);
    if (this.defs.has(adapter.key))
      throw new Error(`erp adapter '${adapter.key}' is declared as a coming-soon definition`);
    this.put(adapter);
  }

  /** P1-ST5-T01b connector ที่ประกาศล่วงหน้า (ยังไม่มี adapter — เชื่อมต่อไม่ได้) */
  private readonly defs = new Map<string, ConnectorDefinition>();

  /** ลงทะเบียน `ConnectorDefinition` (จาก `src/erp-adapters/index.ts` เท่านั้น) — key ซ้ำกับ adapter/definition อื่น = error */
  define(def: ConnectorDefinition): void {
    if (def.key === STANDALONE_KEY)
      throw new Error(`connector key '${STANDALONE_KEY}' is reserved`);
    if (this.adapters.has(def.key) || this.defs.has(def.key))
      throw new Error(`connector '${def.key}' already registered`);
    const problems = definitionProblems(def);
    if (problems.length)
      throw new Error(`connector definition '${def.key}' invalid: ${problems.join('; ')}`);
    this.defs.set(def.key, def);
  }

  /** definition ที่ยังไม่มี adapter (null = ไม่มี หรือมี adapter แล้ว) */
  comingSoon(key: string): ConnectorDefinition | null {
    return this.adapters.has(key) ? null : (this.defs.get(key) ?? null);
  }

  /**
   * definition ที่เชื่อมต่อไม่ได้ เรียงตามรหัส · tenant sandbox ไม่เห็น (ใช้ได้เฉพาะ adapter จำลอง — D68-96)
   */
  definitions(sandbox?: boolean): ConnectorDefinition[] {
    if (sandbox) return [];
    return [...this.defs.values()]
      .filter((d) => !this.adapters.has(d.key))
      .sort((a, b) => a.key.localeCompare(b.key));
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
    const problems = adapterShapeProblems(adapter);
    if (problems.length)
      throw new Error(`erp adapter '${adapter.key}' invalid: ${problems.join('; ')}`);
    this.adapters.set(adapter.key, adapter);
    // D68-96: production cluster มี tenant sandbox — demo ลงทะเบียนไว้แต่ใช้ได้เฉพาะ sandbox
    if (adapter.localOnly && !ErpAdapterRegistry.demoAllowed()) this.sandboxOnly.add(adapter.key);
    else this.sandboxOnly.delete(adapter.key);
  }

  /** ไม่มี = null (core ถือว่า adapter หาย — ไม่ใช่ Standalone, คำสั่งรอคิว) */
  get(key: string): ErpAdapter | null {
    if (key === STANDALONE_KEY) return this.standalone;
    return this.adapters.get(key) ?? null;
  }

  /**
   * adapter ที่เปิดเป็น connector ได้ เรียงตามรหัส (spec/07 INT-010: ไม่มีตัวใดเป็นค่าเริ่มต้น)
   * ระบุ `sandbox` = เฉพาะที่ tenant โหมดนั้นใช้ได้ (`usableIn`) · ไม่ระบุ = ทั้งหมด
   */
  list(sandbox?: boolean): ErpAdapter[] {
    return [...this.adapters.values()]
      .filter((a) => sandbox === undefined || this.usableIn(a.key, sandbox) === a)
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}

/**
 * D-81 · D68-58/D68-96 adapter ของ connector ที่ tenant นั้นใช้ได้ (ตามโหมด sandbox/บริษัทจริง — `usableIn`) — ใช้ในงานเบื้องหลัง
 * ที่ติดต่อปลายทาง (healthCheck, webhook ขาเข้า, ดึงผังรหัส, ดึงสถานะรับชำระ) · โหมด tenant cache ต่อ process (`isSandboxTenant`)
 */
export async function usableAdapter(
  registry: ErpAdapterRegistry,
  db: PrismaClient,
  c: { tenantId: string; adapterKey: string },
): Promise<ErpAdapter | null> {
  if (!registry.get(c.adapterKey)) return null;
  return registry.usableIn(c.adapterKey, await isSandboxTenant(db, c.tenantId));
}
