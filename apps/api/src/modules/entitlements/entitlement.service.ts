import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../db/prisma.service';

/**
 * Feature flag ตามแพ็กเกจ + override ต่อ tenant (ST1-T18; docs/04 A5; spec/01 PLT-062)
 * ที่มีผล = PlanEntitlement(แพ็กเกจของ tenant) → ทับด้วย override ที่ยังไม่หมดอายุ (grant / revoke / set_limit)
 * add-on ที่ซื้อเพิ่ม (SubscriptionAddOn) มาใน ST9/P1 — ตอนนี้เปิดผ่าน override `grant`
 * cache 60 วินาทีต่อ tenant (ล้างด้วย invalidate เมื่อแก้จาก Console)
 */
export interface Entitlement {
  enabled: boolean;
  /** null = ไม่จำกัด */
  limit: number | null;
}
export type Entitlements = Record<string, Entitlement>;

const TTL_MS = 60_000;

export async function resolveEntitlements(
  db: PrismaClient,
  tenantId: string,
): Promise<Entitlements> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { planCode: true },
  });
  if (!tenant) return {};
  const [rows, overrides] = await Promise.all([
    db.planEntitlement.findMany({ where: { planCode: tenant.planCode } }),
    db.tenantEntitlementOverride.findMany({
      where: { tenantId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    }),
  ]);
  const out: Entitlements = {};
  for (const r of rows) out[r.featureKey] = { enabled: r.mode === 'included', limit: r.limit };
  for (const o of overrides) {
    const cur = out[o.featureKey] ?? { enabled: false, limit: null };
    if (o.mode === 'grant') out[o.featureKey] = { enabled: true, limit: o.limit ?? cur.limit };
    else if (o.mode === 'revoke') out[o.featureKey] = { enabled: false, limit: cur.limit };
    else if (o.mode === 'set_limit') out[o.featureKey] = { ...cur, limit: o.limit };
  }
  return out;
}

@Injectable()
export class EntitlementService {
  private readonly cache = new Map<string, { at: number; value: Entitlements }>();
  constructor(private readonly prisma: PrismaService) {}

  async resolve(tenantId: string): Promise<Entitlements> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await resolveEntitlements(this.prisma.platform, tenantId);
    this.cache.set(tenantId, { at: Date.now(), value });
    return value;
  }

  async enabled(tenantId: string, feature: string): Promise<boolean> {
    return (await this.resolve(tenantId))[feature]?.enabled === true;
  }

  invalidate(tenantId?: string) {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  /** tenant ทั้งหมดที่เปิดฟีเจอร์นี้ — ใช้ใน scheduler/cron ให้ข้าม tenant ที่ปิด (A5 "ตรวจซ้ำใน cron job") */
  async tenantsWith(feature: string, tenantIds: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const t of tenantIds) if (await this.enabled(t, feature)) out.push(t);
    return out;
  }
}
