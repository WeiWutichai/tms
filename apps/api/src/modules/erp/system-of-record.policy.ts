import { Injectable } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import {
  canIssueTaxDocumentNumber,
  documentSyncMode,
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
import { ConnectorResolver } from './connector-resolver';

/** system-of-record ที่ใช้กับนิติบุคคล (ผล routing ตามนิติบุคคล) */
export interface EffectiveSystemOfRecord extends SystemOfRecord {
  /** true = ไม่มี connector (หรือยกเลิกแล้ว) → TMS เป็นเจ้าของทุกอย่าง */
  standalone: boolean;
  connectorId: string | null;
  /** connector ส่งใบแจ้งหนี้ไป ERP (documentSyncMode invoice ≠ NOT_APPLICABLE) */
  documentInErp: boolean;
}

/** ค่าตั้ง system-of-record ของแถว connector (null/ยกเลิกแล้ว = Standalone) */
export function sorOf(row: Connector | null): SystemOfRecord {
  if (!row || row.status === 'DISCONNECTED')
    return { ...STANDALONE_SOR, fieldSync: { ...STANDALONE_SOR.fieldSync } };
  return {
    customerOwner: row.customerOwner,
    taxDocumentOwner: row.taxDocumentOwner,
    fieldSync: normalizeFieldSync(row.fieldSync),
    editableUntilPaid: row.editableUntilPaid,
  };
}

/**
 * **จุดบังคับใช้เดียว** ของ system-of-record rules (ST7-T17; docs/04 G3; docs/01 §8.1; plan/05 D-27)
 * - ใช้ connector ตาม routing นิติบุคคล (ConnectorResolver: ของนิติบุคคล → ทุกนิติบุคคล → Standalone) ไม่ดู adapter_key
 * - connector ที่ยังไม่ยกเลิก (ACTIVE/PAUSED/ERROR) ใช้กฎของ connector นั้นเสมอ — หยุดชั่วคราว/ล่ม/แพ็กเกจปิดการเชื่อมต่อ
 *   **ไม่ทำให้ TMS กลับมาออกใบกำกับภาษีเอง** (กันเอกสารภาษีซ้ำสองชุด) — กลับเป็น TMS เมื่อยกเลิกการเชื่อมเท่านั้น
 * - ผู้เรียก (ST5-T09 finalize/ออกเลข, ST7-T16 push/regenerate) ต้องเรียกใน transaction เดียวกับการออกเลข/สร้างคำสั่ง
 */
@Injectable()
export class SystemOfRecordPolicy {
  constructor(private readonly resolver: ConnectorResolver) {}

  async forCompany(tx: Tx, companyId: string | null): Promise<EffectiveSystemOfRecord> {
    const r = await this.resolver.forCompany(tx, companyId);
    return {
      ...sorOf(r.connector),
      standalone: r.standalone,
      connectorId: r.connector ? encodeId('connector', r.connector.id) : null,
      documentInErp: documentSyncMode(r.capabilities, 'invoice') !== 'NOT_APPLICABLE',
    };
  }

  /** TMS ออกเลขใบกำกับภาษี (`tax_invoice_no`) ให้เอกสารของนิติบุคคลนี้ได้ไหม */
  async canIssueTaxDocumentNumber(tx: Tx, companyId: string | null): Promise<boolean> {
    return canIssueTaxDocumentNumber(await this.forCompany(tx, companyId));
  }

  /**
   * ST5-T09 ต้องเรียกก่อนออกเลขใบกำกับภาษีทุกครั้ง — ERP เป็นเจ้าของ → 409 `tax_document_owned_by_erp`
   * (ใบแจ้งหนี้/ใบวางบิลยังออกเลขของ TMS ได้ตามปกติ — D-27)
   */
  async assertCanIssueTaxDocumentNumber(tx: Tx, companyId: string | null): Promise<void> {
    const sor = await this.forCompany(tx, companyId);
    if (!canIssueTaxDocumentNumber(sor))
      throw new ProblemException('tax_document_owned_by_erp', undefined, undefined, {
        connectorId: sor.connectorId,
      });
  }

  /** การเปลี่ยน field กลุ่ม `group` ของใบแจ้งหนี้ (สถานะ `invoiceStatus`) ไปถึง ERP แบบไหน */
  async fieldChangePolicy(
    tx: Tx,
    companyId: string | null,
    group: SorFieldGroup,
    invoiceStatus: string | null,
  ): Promise<SorChangeDecision> {
    const sor = await this.forCompany(tx, companyId);
    return fieldChangePolicy(sor, group, invoiceStatus, sor.documentInErp);
  }
}
