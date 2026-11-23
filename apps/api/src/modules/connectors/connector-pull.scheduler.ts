import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { readyCapabilities } from '../erp/erp-adapter';
import { ErpAdapterRegistry } from '../erp/erp-adapter.registry';
import { CONNECTOR_PULL_JOB, ConnectorIntakeService } from './connector-intake.service';

/** docs/01 §6.1 `pullOrders` — "scheduler ทุก N นาที (ค่า default 5) ต่อ connector ที่เปิด" */
export const CONNECTOR_PULL_EVERY_MS = 5 * 60_000;

/**
 * ตั้งรอบดึง order ต่อ connector (ST7-T14 — ส่งต่อจาก ST3-T05/ST7-T13)
 * worker เรียก `scheduleDue()` ทุก 5 นาที → สร้าง job `connector.pull` `{connectorId}` ให้ connector ที่
 * ACTIVE + tenant เปิด `pullOrders` + adapter ที่ติดตั้งรองรับ `pullOrders` + tenant TRIAL/ACTIVE + แพ็กเกจมี `conn`
 * - connector ที่ยังมี job ค้าง (PENDING/RUNNING — รวมที่รอลองใหม่เพราะต้นทางล่ม) ไม่สร้างซ้ำ → ไม่กองคิว
 * - advisory lock กันสอง worker สร้างซ้ำ · job ตรวจเงื่อนไขซ้ำตอนรัน (`pullConnector` → skipped)
 * - Standalone / connector ที่ไม่มี pullOrders = ไม่มี scheduler (SO เข้าทาง manual/import/API)
 */
@Injectable()
export class ConnectorPullScheduler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ErpAdapterRegistry,
    private readonly entitlements: EntitlementService,
    private readonly intake: ConnectorIntakeService,
  ) {}

  /** คืนจำนวน job ที่สร้าง */
  async scheduleDue(): Promise<number> {
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${CONNECTOR_PULL_JOB}))`;
      const rows = await db.connector.findMany({
        where: { status: 'ACTIVE', capabilitiesEnabled: { has: 'pullOrders' } },
        select: { id: true, tenantId: true, adapterKey: true },
        orderBy: { createdAt: 'asc' },
      });
      const installed = rows.filter((r) => {
        const a = this.adapters.get(r.adapterKey);
        return !!a && readyCapabilities(a).has('pullOrders') && typeof a.pullOrders === 'function';
      });
      if (!installed.length) return 0;
      const modes = new Map(
        (
          await db.tenant.findMany({
            where: {
              id: { in: [...new Set(installed.map((r) => r.tenantId))] },
              status: { in: ['TRIAL', 'ACTIVE'] },
            },
            select: { id: true, mode: true },
          })
        ).map((t) => [t.id, t.mode === 'test']),
      );
      // D-81 · D68-58/96: sandbox ดึงได้เฉพาะ DemoProvider · demo ใน production = เฉพาะ sandbox (`usableIn`)
      const pullable = installed.filter(
        (r) =>
          modes.has(r.tenantId) && !!this.adapters.usableIn(r.adapterKey, modes.get(r.tenantId)!),
      );
      if (!pullable.length) return 0;
      const tenantIds = [...new Set(pullable.map((r) => r.tenantId))];
      const active = new Set(tenantIds);
      const allowed = new Set(
        await this.entitlements.tenantsWith(
          'conn',
          tenantIds.filter((t) => active.has(t)),
        ),
      );
      const open = await db.job.findMany({
        where: {
          tenantId: { in: [...allowed] },
          type: CONNECTOR_PULL_JOB,
          status: { in: ['PENDING', 'RUNNING'] },
        },
        select: { payload: true },
      });
      const busy = new Set(
        open
          .map((j) => (j.payload as { connectorId?: unknown } | null)?.connectorId)
          .filter((v): v is string => typeof v === 'string'),
      );
      let n = 0;
      for (const r of pullable) {
        if (!allowed.has(r.tenantId) || busy.has(r.id)) continue;
        await this.intake.enqueueConnector(db as unknown as Tx, r.tenantId, r.id);
        n += 1;
      }
      return n;
    });
  }
}
