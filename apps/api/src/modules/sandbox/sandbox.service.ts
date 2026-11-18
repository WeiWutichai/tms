import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { PrismaService } from '../../db/prisma.service';
import { bootstrapTenant } from '../tenants/bootstrap';

export type TenantMode = 'live' | 'test';

/** header ที่ผู้ใช้ (UI) เลือกโหมดของหน้า นักพัฒนา / Open API — route ที่ติด @SandboxAware เท่านั้น */
export const MODE_HEADER = 'x-tms-mode';

export interface TenantLink {
  id: string;
  mode: TenantMode;
  /** tenant จริงของ sandbox (live = ตัวเอง) — ใช้หาแพ็กเกจ/สถานะ/ผู้ใช้/วันสร้าง */
  liveTenantId: string;
}

/** สถานะ/แพ็กเกจของ sandbox = ของบริษัทจริงเสมอ (ไม่เก็บซ้ำในแถว sandbox) */
export async function tenantLink(db: PrismaClient, tenantId: string): Promise<TenantLink | null> {
  const t = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, mode: true, liveTenantId: true },
  });
  if (!t) return null;
  const mode: TenantMode = t.mode === 'test' ? 'test' : 'live';
  return { id: t.id, mode, liveTenantId: mode === 'test' ? t.liveTenantId! : t.id };
}

/**
 * Sandbox (ST7-T09; docs/04 G1 "Sandbox", spec/07 INT-061) — tenant mode `test` ใน cluster เดียว
 * - sandbox = **แถว tenant แยก** (`mode='test'`, `live_tenant_id` → บริษัทจริง, 1:1) → ข้อมูลแยกด้วย RLS เหมือนบริษัทอื่น
 *   key `tk_test_` / webhook / event / outbox ของ sandbox อยู่ในแถวของ sandbox — ไม่มีการแปลง tenant ตอนยืนยัน key
 *   จึงไม่มีทางที่ key test จะเห็นข้อมูล live แม้โค้ดส่วนอื่นผิด
 * - สร้างครั้งแรกเมื่อผู้ใช้สลับเป็นโหมด Sandbox (ค่าเริ่มต้นภาษาไทยชุดเดียวกับบริษัทใหม่ — bootstrapTenant)
 * - แพ็กเกจ/ฟีเจอร์/สถานะ (ระงับ/ยกเลิก) ตามบริษัทจริง (resolveEntitlements, ApiKeyAuthService)
 */
@Injectable()
export class SandboxService {
  private readonly logger = new Logger('SandboxService');
  /** tenant → link (แก้ไม่ได้หลังสร้าง — trigger ในฐาน) */
  private readonly cache = new Map<string, TenantLink>();

  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.platform;
  }

  async link(tenantId: string): Promise<TenantLink | null> {
    const hit = this.cache.get(tenantId);
    if (hit) return hit;
    const l = await tenantLink(this.db, tenantId);
    if (l) {
      if (this.cache.size > 5000) this.cache.clear();
      this.cache.set(tenantId, l);
    }
    return l;
  }

  async modeOf(tenantId: string): Promise<TenantMode> {
    return (await this.link(tenantId))?.mode ?? 'live';
  }

  /** sandbox ของบริษัท (ไม่สร้าง) */
  async find(liveTenantId: string): Promise<string | null> {
    const t = await this.db.tenant.findUnique({
      where: { liveTenantId },
      select: { id: true },
    });
    return t?.id ?? null;
  }

  /** sandbox ของบริษัท — ยังไม่มี = สร้าง (รันพร้อมกันได้: unique live_tenant_id → อ่านแถวที่อีกฝั่งสร้าง) */
  async ensure(liveTenantId: string): Promise<string> {
    const found = await this.find(liveTenantId);
    if (found) return found;
    const live = await this.db.tenant.findUnique({
      where: { id: liveTenantId },
      select: { id: true, name: true, mode: true, planCode: true, yearStyle: true },
    });
    if (!live || live.mode !== 'live') throw new ProblemException('not_found');
    try {
      const t = await this.db.$transaction(
        async (tx) => {
          const row = await tx.tenant.create({
            data: {
              name: `${live.name} (Sandbox)`,
              status: 'ACTIVE',
              mode: 'test',
              liveTenantId: live.id,
              planCode: live.planCode,
              yearStyle: live.yearStyle,
            },
          });
          await bootstrapTenant(tx, row.id);
          // ใครเปิด sandbox เมื่อไร — audit ของบริษัทจริง
          const ctx = requestContext.get();
          await tx.auditLog.create({
            data: {
              tenantId: live.id,
              actorId: ctx?.actorId ?? null,
              actAs: ctx?.actAs ?? null,
              action: 'sandbox.created',
              entityType: 'tenant',
              entityId: row.id,
              after: { mode: 'test', name: row.name },
              requestId: ctx?.requestId ?? null,
              ip: ctx?.ip ?? null,
            },
          });
          return row;
        },
        { timeout: 30_000 },
      );
      this.logger.log(`sandbox ${t.id} created for tenant ${live.id}`);
      return t.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.find(liveTenantId);
        if (again) return again;
      }
      throw e;
    }
  }

  /** ผู้ใช้ของบริษัทจริง (ชื่อผู้สร้าง key/endpoint, ผู้ทำรายการใน audit ของ sandbox) — ค้นด้วย client platform + tenant_id ชัดเจน */
  async liveUsers(
    liveTenantId: string,
    where: { ids?: string[]; name?: string },
  ): Promise<{ id: string; name: string; status: string }[]> {
    if (where.ids && !where.ids.length) return [];
    return this.db.appUser.findMany({
      where: {
        tenantId: liveTenantId,
        ...(where.ids ? { id: { in: where.ids } } : {}),
        ...(where.name ? { name: { contains: where.name, mode: 'insensitive' } } : {}),
      },
      select: { id: true, name: true, status: true },
    });
  }
}
