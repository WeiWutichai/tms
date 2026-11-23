import { Injectable } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import {
  type ConnectorStatus,
  effectiveCapabilities,
  ERP_CAPABILITIES,
  type ErpCapability,
} from '@tms/domain';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import {
  resolveDocumentEntity,
  type RoutingInput,
  type RoutingResult,
} from '../routing/document-routing';
import { type ErpAdapter, readyCapabilities } from './erp-adapter';
import { ErpAdapterRegistry } from './erp-adapter.registry';

/** ผลการหา connector ของเอกสาร/นิติบุคคล — core ตัดสิน flow จากที่นี่เท่านั้น (ไม่ดู adapter_key) */
export interface ResolvedConnector {
  /**
   * true = ไม่มี connector (หรือยกเลิกแล้ว / แพ็กเกจไม่มี `conn`) → ทุก flow เดินใน TMS เอง
   * connector ที่ปิดทุก capability ไว้ = `standalone: false` แต่ `capabilities: []` และ `sending: false`
   * (flow ใดจะมีขั้น sync ให้ดู `capabilities` เสมอ ไม่ใช่ `standalone`)
   */
  standalone: boolean;
  connector: Connector | null;
  /** STANDALONE_ADAPTER เมื่อ standalone · null เมื่อมี connector แต่ adapter ไม่ได้ลงทะเบียน (deploy ไม่ครบ) */
  adapter: ErpAdapter | null;
  status: ConnectorStatus | null;
  /** adapter ประกาศ ∩ tenant เปิด (ว่าง = Standalone) — ใช้ตัดสินว่า flow ไหนมีขั้น sync */
  capabilities: ErpCapability[];
  /** ส่ง/ดึงได้ตอนนี้ (ACTIVE + มี adapter + เปิดอย่างน้อย 1 capability) — false = คำสั่งรอคิว (PAUSED/ERROR/adapter หาย) */
  sending: boolean;
  /** รหัสบริษัท/สาขาฝั่ง ERP ของเอกสาร (branch_map[สาขา] → erp_company_code) */
  erpCompanyCode: string | null;
  /** connector มาจากขอบเขตไหน: นิติบุคคลนี้ / ทุกนิติบุคคล / ไม่มี */
  scope: 'company' | 'tenant' | 'none';
}

export function supports(r: ResolvedConnector, cap: ErpCapability): boolean {
  return r.capabilities.includes(cap);
}

/**
 * ทะเบียน connector ต่อ tenant (ST7-T13; docs/01 §3.7; docs/04 G3 "Routing ตามนิติบุคคล")
 * ลำดับ: connector ของนิติบุคคลนั้น → connector ทุกนิติบุคคล (company_id null) → Standalone
 * DISCONNECTED ไม่นับ · tenant ที่มี 2 นิติบุคคลชี้ connector ต่างกันได้ (เกณฑ์ตรวจรับ)
 * ทำงานใน transaction ของผู้เรียก (RLS ของ tenant) — ไม่ cache ข้ามคำขอ
 */
@Injectable()
export class ConnectorResolver {
  constructor(private readonly adapters: ErpAdapterRegistry) {}

  /** connector ที่ใช้กับนิติบุคคล (null = tenant ที่ยังไม่มีนิติบุคคล/เอกสารไม่ระบุ → เฉพาะขอบเขตทุกนิติบุคคล) */
  async forCompany(
    tx: Tx,
    companyId: string | null,
    branchId?: string | null,
  ): Promise<ResolvedConnector> {
    const rows = await tx.connector.findMany({
      where: {
        status: { not: 'DISCONNECTED' },
        OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])],
      },
    });
    const own = companyId ? rows.find((r) => r.companyId === companyId) : undefined;
    const row = own ?? rows.find((r) => r.companyId === null) ?? null;
    // D68-58/96 โหมด tenant มีผลเฉพาะ adapter จำลอง/tenant sandbox — ไม่รู้จากคำขอ (งานเบื้องหลัง) → อ่านจากแถว tenant
    let sandbox = requestContext.get()?.sandbox ? true : undefined;
    if (
      row &&
      sandbox === undefined &&
      this.adapters.usableIn(row.adapterKey, true) !== this.adapters.usableIn(row.adapterKey, false)
    ) {
      const t = await tx.tenant.findUnique({ where: { id: row.tenantId }, select: { mode: true } });
      sandbox = t?.mode === 'test';
    }
    return this.describe(row, branchId ?? null, own ? 'company' : row ? 'tenant' : 'none', sandbox);
  }

  /** เอกสารที่ออกในนามนิติบุคคล (Invoice As / Tender As — resolver ของ ST1-T16) → connector */
  async forDocument(
    tx: Tx,
    tenantId: string,
    input: RoutingInput,
  ): Promise<ResolvedConnector & { routing: RoutingResult }> {
    const routing = await resolveDocumentEntity(tx, tenantId, input);
    return { ...(await this.forCompany(tx, routing.company.id, routing.branch.id)), routing };
  }

  /** D68-58 adapter ของ key นี้เป็นตัวจำลอง (DemoProvider — tenant sandbox ใช้ได้) ไหม */
  isSandboxAdapter(key: string): boolean {
    return this.adapters.get(key)?.localOnly === true;
  }

  /**
   * สรุปของแถว connector (ใช้ใน DTO/หน้าจอด้วย)
   * `sandbox` = tenant เป็น sandbox ไหม (D68-58/96 — sandbox ใช้ได้เฉพาะ DemoProvider; demo ใน production ใช้ได้เฉพาะ sandbox) ·
   * ไม่ระบุ = ดูจากคำขอ (ไม่มีคำขอ = บริษัทจริง)
   */
  describe(
    row: Connector | null,
    branchId: string | null = null,
    scope: ResolvedConnector['scope'] = row ? (row.companyId ? 'company' : 'tenant') : 'none',
    sandbox?: boolean,
  ): ResolvedConnector {
    if (!row || row.status === 'DISCONNECTED')
      return {
        standalone: true,
        connector: null,
        adapter: this.adapters.standalone,
        status: null,
        capabilities: [],
        sending: false,
        erpCompanyCode: null,
        scope: 'none',
      };
    const installed = this.adapters.get(row.adapterKey);
    const adapter = this.adapters.usableIn(
      row.adapterKey,
      sandbox ?? !!requestContext.get()?.sandbox,
    );
    // adapter หาย (deploy ไม่ครบ): เชื่อชุดที่ตรวจตอนบันทึก — เอกสารยังเข้าคิวรอ ไม่ถูกปฏิบัติเหมือน Standalone
    // ยกเว้น adapter ที่ปิดใน environment นี้ / ใช้ไม่ได้ในโหมดของ tenant (demo ของบริษัทจริงใน production, connector จริงใน
    // sandbox — ST7-T14, D68-58/96): ใช้ไม่ได้ = ไม่มี capability ไม่มีขั้น sync
    const declared = adapter
      ? readyCapabilities(adapter)
      : installed || this.adapters.isRefused(row.adapterKey)
        ? new Set<string>()
        : new Set<string>(ERP_CAPABILITIES);
    const map = (row.branchMap ?? {}) as Record<string, unknown>;
    const branchCode =
      branchId && typeof map[branchId] === 'string' ? (map[branchId] as string) : null;
    const capabilities = effectiveCapabilities(declared, row.capabilitiesEnabled, row.status);
    return {
      standalone: false,
      connector: row,
      adapter,
      status: row.status,
      capabilities,
      sending: row.status === 'ACTIVE' && !!adapter && capabilities.length > 0,
      erpCompanyCode: branchCode ?? row.erpCompanyCode,
      scope,
    };
  }
}
