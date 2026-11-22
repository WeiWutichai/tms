import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type { ErpAdapter } from '../modules/erp/erp-adapter';
import {
  type FileExportAdapter,
  FileExportAdapterRegistry,
} from '../modules/accounting-export/file-export-adapter';
import { ErpAdapterRegistry } from '../modules/erp/erp-adapter.registry';
import { AccountSystemAdapter } from './accountsystem/accountsystem.adapter';
import { DemoAdapter } from './demo/demo.adapter';
import { GenericFileExport } from './file-generic/generic-file-export';
import { KrsAdapter } from './krs/krs.adapter';

/**
 * Composition root ของ ErpAdapter (ST7-T13) — **ที่เดียว** ที่รู้จัก adapter แต่ละตัว
 * กติกา (ตรวจด้วย `apps/api/scripts/lint-adapters.mjs` ใน `pnpm lint`):
 * - โค้ดนอก `src/erp-adapters/` import ได้เฉพาะไฟล์นี้ และเฉพาะ `src/app.module.ts`
 * - adapter แต่ละตัวอยู่ใน `src/erp-adapters/<key>/` และไม่ import adapter ตัวอื่น
 * - adapter ใหม่ = เพิ่มโฟลเดอร์ + 1 บรรทัดใน ERP_ADAPTER_FACTORIES + ผ่าน contract test (`test/erp-adapter-contract.ts`)
 * - StandaloneProvider (ไม่มี connector) อยู่ใน core (`STANDALONE_ADAPTER`) — ไม่ลงทะเบียนที่นี่ และเป็นค่าเริ่มต้นของทุก tenant เสมอ
 * - DemoProvider (`demo`, ST7-T14) = ERP จำลอง `localOnly` — มีเฉพาะ dev/test/`ERP_DEMO_ADAPTERS=1` ไม่เป็นค่าเริ่มต้นของใคร
 * - KrsAdapter (`krs`, ST8-T03) = adapter จริงตัวแรก (โครง — push/pull/fetch ตาม ST8-T04…T10) · เปิดได้ทุก environment
 *   แต่ tenant sandbox ใช้ไม่ได้ (route connector เป็น @LiveOnly + sink กันซ้ำ)
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
      if (a.localOnly && !ErpAdapterRegistry.demoAllowed()) {
        // รู้จักแต่ปิดใน environment นี้ — connector ที่ค้างอยู่ถือว่า "ใช้ไม่ได้" (ไม่ใช่รอ deploy)
        this.registry.refuse(a.key);
        continue;
      }
      if (!this.registry.get(a.key)) this.registry.register(a);
    }
  }

  /** เตือนตอนบูต: connector ที่ยังไม่ยกเลิกแต่ใช้ adapter ที่ปิดใน environment นี้ (เช่น demo ค้างใน production) */
  async onApplicationBootstrap() {
    const keys = this.registry.refusedKeys();
    if (!keys.length) return;
    try {
      const rows = await this.prisma.platform.connector.findMany({
        where: { adapterKey: { in: keys }, status: { not: 'DISCONNECTED' } },
        select: { id: true, tenantId: true, adapterKey: true, status: true },
      });
      if (rows.length)
        this.logger.warn(
          `connectors using adapters disabled in this environment (${keys.join(', ')}) — not sending/pulling: ${JSON.stringify(rows)}`,
        );
    } catch (e) {
      this.logger.warn(`cannot check connectors of disabled adapters: ${String(e)}`);
    }
  }
}
