import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ErpAdapter } from '../modules/erp/erp-adapter';
import { ErpAdapterRegistry } from '../modules/erp/erp-adapter.registry';

/**
 * Composition root ของ ErpAdapter (ST7-T13) — **ที่เดียว** ที่รู้จัก adapter แต่ละตัว
 * กติกา (ตรวจด้วย `apps/api/scripts/lint-adapters.mjs` ใน `pnpm lint`):
 * - โค้ดนอก `src/erp-adapters/` import ได้เฉพาะไฟล์นี้ และเฉพาะ `src/app.module.ts`
 * - adapter แต่ละตัวอยู่ใน `src/erp-adapters/<key>/` และไม่ import adapter ตัวอื่น
 * - adapter ใหม่ = เพิ่มโฟลเดอร์ + 1 บรรทัดใน ERP_ADAPTER_FACTORIES + ผ่าน contract test (`test/erp-adapter-contract.ts`)
 * ตอนนี้ยังไม่มี adapter (DemoProvider = ST7-T14, FileExportAdapter = ST7-T23, KrsAdapter = ST8-T03) → ทุก tenant เป็น Standalone
 */
export const ERP_ADAPTER_FACTORIES: ReadonlyArray<() => ErpAdapter> = [];

@Injectable()
export class ErpAdaptersBootstrap implements OnModuleInit {
  constructor(private readonly registry: ErpAdapterRegistry) {}

  onModuleInit() {
    for (const make of ERP_ADAPTER_FACTORIES) {
      const a = make();
      if (a.localOnly && !ErpAdapterRegistry.demoAllowed()) continue;
      if (!this.registry.get(a.key)) this.registry.register(a);
    }
  }
}
