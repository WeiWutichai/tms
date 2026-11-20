import { Injectable } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import {
  canIssueTaxDocumentNumber,
  fieldChangePolicy,
  normalizeFieldSync,
  type SorChangeDecision,
  type SorFieldGroup,
  STANDALONE_SOR,
  type SystemOfRecord,
} from '@tms/domain';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import type { Tx } from '../../db/db.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { ConnectorResolver, type ResolvedConnector } from './connector-resolver';

/** system-of-record ที่ใช้กับนิติบุคคล (ผล routing ตามนิติบุคคล) */
export interface EffectiveSystemOfRecord extends SystemOfRecord {
  /** true = ไม่มี connector (หรือยกเลิกแล้ว) → TMS เป็นเจ้าของทุกอย่าง */
  standalone: boolean;
  connectorId: string | null;
  /**
   * ใบแจ้งหนี้ไปถึง ERP ได้ตามค่าตั้ง: แพ็กเกจมี `conn` + `pushInvoice` ใช้ได้จริง (adapter ทำแล้ว ไม่ pending ∩ tenant เปิด)
   * + connector ACTIVE หรือเคยเปิดใช้แล้ว (PAUSED/ERROR หลังเปิดใช้ = คิวส่งทีหลัง)
   */
  invoiceReachesErp: boolean;
  /** TMS ออกเลขใบกำกับภาษีได้ไหม (ผลของ canIssueTaxDocumentNumber) */
  canIssueTaxDocumentNumber: boolean;
}

/** ค่าตั้ง system-of-record ของแถว connector (null/ยกเลิกแล้ว = Standalone) */
export function sorOf(row: Connector | null): SystemOfRecord {
  if (!row || row.status === 'DISCONNECTED')
    return { ...STANDALONE_SOR, fieldSync: { ...STANDALONE_SOR.fieldSync } };
  return {
    customerOwner: row.customerOwner,
    taxDocumentOwner: row.taxDocumentOwner,
    fieldSync: normalizeFieldSync(row.fieldSync),
  };
}

/** ใบแจ้งหนี้ไปถึง ERP ได้ตามค่าตั้ง (ไม่รวมแพ็กเกจ — ผู้เรียกส่ง `entitled`) */
export function invoiceReachesErp(r: ResolvedConnector, entitled: boolean): boolean {
  const c = r.connector;
  if (!c || r.standalone || !entitled) return false;
  if (!r.capabilities.includes('pushInvoice')) return false;
  return c.status === 'ACTIVE' || c.activatedAt !== null;
}

/**
 * **จุดบังคับใช้เดียว** ของ system-of-record rules (ST7-T17; docs/04 G3; docs/01 §8.1; plan/05 D-27)
 * - ใช้ connector ตาม routing นิติบุคคล (ConnectorResolver: ของนิติบุคคล → ทุกนิติบุคคล → Standalone) ไม่ดู adapter_key
 * - standalone-first: TMS ไม่ออกเลขใบกำกับภาษี **เฉพาะ** เมื่อ ERP เป็นเจ้าของ **และ** ใบแจ้งหนี้ไปถึง ERP ได้จริง
 *   (connector ที่ยังไม่เคยเปิดใช้ / ไม่มี pushInvoice / แพ็กเกจไม่มี `conn` / ยังไม่เลือกเจ้าของ = TMS ออกเลขเอง)
 * - ผู้เรียก (ST5-T09 finalize/ออกเลข, ST7-T16 push/regenerate) ต้องเรียกใน transaction เดียวกับการออกเลข/สร้างคำสั่ง
 */
@Injectable()
export class SystemOfRecordPolicy {
  constructor(
    private readonly resolver: ConnectorResolver,
    private readonly entitlements: EntitlementService,
  ) {}

  /** ผลของ connector ที่ resolve แล้ว (ใช้ร่วมกับ `GET /connectors/effective`) */
  async describe(r: ResolvedConnector): Promise<EffectiveSystemOfRecord> {
    const sor = sorOf(r.connector);
    const entitled = r.connector
      ? await this.entitlements.enabled(r.connector.tenantId, 'conn')
      : false;
    const reaches = invoiceReachesErp(r, entitled);
    return {
      ...sor,
      standalone: r.standalone,
      connectorId: r.connector ? encodeId('connector', r.connector.id) : null,
      invoiceReachesErp: reaches,
      canIssueTaxDocumentNumber: canIssueTaxDocumentNumber(sor, reaches),
    };
  }

  async forCompany(tx: Tx, companyId: string | null): Promise<EffectiveSystemOfRecord> {
    return this.describe(await this.resolver.forCompany(tx, companyId));
  }

  /** TMS ออกเลขใบกำกับภาษี (`tax_invoice_no`) ให้เอกสารของนิติบุคคลนี้ได้ไหม */
  async canIssueTaxDocumentNumber(tx: Tx, companyId: string | null): Promise<boolean> {
    return (await this.forCompany(tx, companyId)).canIssueTaxDocumentNumber;
  }

  /**
   * ST5-T09 ต้องเรียกก่อนออกเลขใบกำกับภาษีทุกครั้ง (transaction เดียวกัน) — ERP เป็นเจ้าของ → 409 `tax_document_owned_by_erp`
   * (ใบแจ้งหนี้/ใบวางบิลยังออกเลขของ TMS ได้ตามปกติ — D-27)
   */
  async assertCanIssueTaxDocumentNumber(tx: Tx, companyId: string | null): Promise<void> {
    const sor = await this.forCompany(tx, companyId);
    if (!sor.canIssueTaxDocumentNumber)
      throw new ProblemException('tax_document_owned_by_erp', undefined, undefined, {
        connectorId: sor.connectorId,
      });
  }

  /**
   * การเปลี่ยน field กลุ่ม `group` ของใบแจ้งหนี้ (สถานะ `invoiceStatus`) ไปถึง ERP แบบไหน
   * `documentInErp` = เอกสาร**ใบนั้น**อยู่ใน ERP แล้ว — ST7-T16 ต้องตัดสินจาก `external_mapping` ของเอกสารนั้น
   * (ไม่ระบุ = ใช้ค่าระดับ connector `invoiceReachesErp` แทนชั่วคราว)
   */
  async fieldChangePolicy(
    tx: Tx,
    companyId: string | null,
    group: SorFieldGroup,
    invoiceStatus: string | null,
    documentInErp?: boolean,
  ): Promise<SorChangeDecision> {
    const sor = await this.forCompany(tx, companyId);
    return fieldChangePolicy(sor, group, invoiceStatus, documentInErp ?? sor.invoiceReachesErp);
  }
}
