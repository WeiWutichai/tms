import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type { ErpAdapter } from '../modules/erp/erp-adapter';
import {
  type FileExportAdapter,
  FileExportAdapterRegistry,
} from '../modules/accounting-export/file-export-adapter';
import { ErpAdapterRegistry } from '../modules/erp/erp-adapter.registry';
import { AccountSystemAdapter } from './accountsystem/accountsystem.adapter';
import type { ConnectorDefinition } from '../modules/erp/connector-definition';
import { DemoAdapter } from './demo/demo.adapter';
import { FLOWACCOUNT_DEFINITION } from './flowaccount/flowaccount.definition';
import { PEAK_DEFINITION } from './peak/peak.definition';
import { GenericFileExport } from './file-generic/generic-file-export';
import { KrsAdapter } from './krs/krs.adapter';

/**
 * Composition root ของ ErpAdapter (ST7-T13) — **ที่เดียว** ที่รู้จัก adapter แต่ละตัว
 * กติกา (ตรวจด้วย `apps/api/scripts/lint-adapters.mjs` ใน `pnpm lint`):
 * - โค้ดนอก `src/erp-adapters/` import ได้เฉพาะไฟล์นี้ และเฉพาะ `src/app.module.ts`
 * - adapter แต่ละตัวอยู่ใน `src/erp-adapters/<key>/` และไม่ import adapter ตัวอื่น
 * - adapter ใหม่ = เพิ่มโฟลเดอร์ + 1 บรรทัดใน ERP_ADAPTER_FACTORIES + ผ่าน contract test (`test/erp-adapter-contract.ts`)
 * - StandaloneProvider (ไม่มี connector) อยู่ใน core (`STANDALONE_ADAPTER`) — ไม่ลงทะเบียนที่นี่ และเป็นค่าเริ่มต้นของทุก tenant เสมอ
 * - DemoProvider (`demo`, ST7-T14) = ERP จำลอง `localOnly` — ทุก tenant ใน dev/test/`ERP_DEMO_ADAPTERS=1` · environment อื่น
 *   (production cluster) = เฉพาะ tenant sandbox (D-81 · D68-58/96; docs/04 G3/J) · ไม่เป็นค่าเริ่มต้นของใคร
 * - KrsAdapter (`krs`, ST8-T03) = adapter จริงตัวแรก (โครง — push/pull/fetch ตาม ST8-T04…T10) · เปิดได้ทุก environment
 *   แต่ tenant sandbox ใช้ไม่ได้ (sandbox ใช้ได้เฉพาะ adapter `localOnly` — `ErpAdapterRegistry.usableIn` + sink กันซ้ำ)
 * - AccountSystemAdapter (`accountsystem`, ST8-T16) = ระบบบัญชีของ Innovera (D-54/D-55): ใบแจ้งหนี้ → IV ร่าง, ใบสำคัญจ่าย → AP ร่าง,
 *   รับ webhook · เจ้าของเอกสารภาษี = ERP ตายตัว
 * - FileExportAdapter (ST7-T23) = "รูปแบบไฟล์" ของการส่งออกให้นักบัญชี (ไม่ใช่ connector — ไม่มี capability/outbox):
 *   ลงทะเบียนใน `FileExportAdapterRegistry` · `file-generic` = รูปแบบทั่วไป (layout กลาง) — Express/PEAK/FlowAccount
 *   เพิ่มเป็นโฟลเดอร์ใหม่ + 1 บรรทัดใน FILE_EXPORT_ADAPTER_FACTORIES เมื่อได้ template นำเข้าจริง (spec/07 INT-043)
 */
export const ERP_ADAPTER_FACTORIES: ReadonlyArray<() => ErpAdapter> = [
  () => new DemoAdapter(),
  () => new KrsAdapter(),
  () => new AccountSystemAdapter(),
];

/**
 * P1-ST5-T01b connector ที่ประกาศใน catalog ล่วงหน้าแต่ยังเชื่อมต่อไม่ได้ (การ์ด "ยังไม่เปิดให้เชื่อมต่อ") —
 * adapter ตัวจริงมาแล้ว = ย้าย key นั้นไป `ERP_ADAPTER_FACTORIES` และลบออกจากรายการนี้ (key เดียวกันลงทะเบียนสองแบบไม่ได้)
 */
export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  FLOWACCOUNT_DEFINITION,
  PEAK_DEFINITION,
];

/** ST7-T23 รูปแบบไฟล์ส่งออกให้นักบัญชี */
export const FILE_EXPORT_ADAPTER_FACTORIES: ReadonlyArray<() => FileExportAdapter> = [
  () => new GenericFileExport(),
];

@Injectable()
export class ErpAdaptersBootstrap implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('ErpAdapters');

  constructor(
    private readonly registry: ErpAdapterRegistry,
    private readonly prisma: PrismaService,
    private readonly fileExports: FileExportAdapterRegistry,
  ) {}

  onModuleInit() {
    for (const make of FILE_EXPORT_ADAPTER_FACTORIES) {
      const f = make();
      if (!this.fileExports.get(f.key)) this.fileExports.register(f);
    }
    for (const make of ERP_ADAPTER_FACTORIES) {
      const a = make();
      // D68-96: demo ใน production ลงทะเบียนไว้ให้ tenant sandbox — บริษัทจริงใช้ไม่ได้ (`usableIn`)
      if (!this.registry.get(a.key)) this.registry.register(a);
    }
    for (const d of CONNECTOR_DEFINITIONS)
      if (!this.registry.get(d.key) && !this.registry.comingSoon(d.key)) this.registry.define(d);
  }

  /** เตือนตอนบูต: connector ของบริษัทจริงที่ยังไม่ยกเลิกแต่ใช้ adapter ที่ใช้ได้เฉพาะ sandbox ใน environment นี้ (demo ค้างใน production) */
  async onApplicationBootstrap() {
    const keys = [
      ...this.registry.refusedKeys(),
      ...this.registry
        .list()
        .filter((a) => this.registry.isSandboxOnly(a.key))
        .map((a) => a.key),
    ];
    if (!keys.length) return;
    try {
      const rows = await this.prisma.platform.connector.findMany({
        where: { adapterKey: { in: keys }, status: { not: 'DISCONNECTED' } },
        select: { id: true, tenantId: true, adapterKey: true, status: true },
      });
      const live = new Set(
        (
          await this.prisma.platform.tenant.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] }, mode: 'live' },
            select: { id: true },
          })
        ).map((t) => t.id),
      );
      const stuck = rows.filter((r) => live.has(r.tenantId));
      if (stuck.length)
        this.logger.warn(
          `connectors using adapters disabled in this environment (${keys.join(', ')}) — not sending/pulling: ${JSON.stringify(stuck)}`,
        );
    } catch (e) {
      this.logger.warn(`cannot check connectors of disabled adapters: ${String(e)}`);
    }
  }
}
