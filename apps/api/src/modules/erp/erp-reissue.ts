import { documentSyncMode } from '@tms/domain';
import type { Tx } from '../../db/db.service';

/**
 * ST8-T13 (D-54 [OPEN — PO] #60 ข้อ ฉ) "ภาพหลังปรับ" ระหว่างที่ TMS ไม่มีใบลด/เพิ่มหนี้ = **ยกเลิกแล้วออกใหม่** (ST5-T10 `reissue`)
 *
 * docs/01 §6.1 แถว `pushCreditNote`: ERP ที่ไม่มี `pushCreditNote` แต่มี `replaceDocument` → core สร้าง "ภาพรวมหลังปรับ" แล้วแทนที่เอกสาร
 * เดิมฝั่ง ERP (approval ถ้าลงบัญชีแล้ว) · A.2 (KRS): `PUT /invoice/{transactionNo}` ด้วย `tmsVoucherNo` เดิม
 * → ใบที่ออกใหม่ (`replaces_invoice_id` = ใบเดิม) **แทนที่เอกสารของใบเดิมในระบบบัญชี** (ไม่ POST ใบใหม่ — ไม่เกิดเอกสารซ้ำในระบบบัญชี)
 * แล้ว external_mapping ย้ายจากใบเดิม (RETIRED + `detail.reissuedTo`) ไปใบใหม่
 *
 * กฎกลาง (ไม่ผูก ERP — ตัดสินด้วย capability):
 * - ใช้เมื่อ `documentSyncMode(capabilities, 'creditNote') === 'REPLACE'` (มี replaceDocument ไม่มี pushCreditNote)
 * - เป้าหมาย = ใบบรรพบุรุษที่ยกเลิกแล้วใบแรก (ไล่ `replaces_invoice_id` ผ่านใบที่ยกเลิก) ที่ mapping บอกว่าอยู่ในระบบบัญชีครบ
 *   และยังไม่ถูกแทนที่ · ใบระหว่างทางต้องยกเลิกทั้งหมด (ใบที่ยังใช้อยู่ = ไม่ใช่สายการแทนที่)
 * - ลูกค้า/นิติบุคคลผู้ออกต้องเหมือนใบเดิม — ไม่เหมือน = ไม่ใช่ "การปรับใบ" (ส่งใบใหม่ตามปกติ + แจ้งบัญชียกเลิกใบเดิมเอง)
 * - การยกเลิกใบเดิมในระบบบัญชี (KRS ไม่มี DELETE — KRS-6 [OPEN — KRS]) ทำตามทางรอคำตอบ (C): แจ้งบัญชียกเลิกเอง
 *   (`void_manual_required`) **ยกเว้น** ใบเดิมมีใบออกใหม่ที่จะ/ได้แทนที่เอกสารนั้นแล้ว (`void_replaced_by_reissue` — ไม่ใช่งานของคน)
 */

/** สายการแทนที่ยาวสุดที่ไล่ (กันวน — ใบหนึ่งยกเลิกแล้วออกใหม่ได้ครั้งเดียว) */
const MAX_CHAIN = 20;

type MappingLike = {
  externalId: string | null;
  externalStatus: string | null;
  status: string;
  detail: unknown;
};

/** ใบใหม่ที่ mapping นี้ถูกย้ายไปแล้ว (เอกสารในระบบบัญชีเป็นของใบนั้น) */
export function reissuedToOf(detail: unknown): string | null {
  const v = (detail ?? {}) as { reissuedTo?: unknown };
  return typeof v.reissuedTo === 'string' && v.reissuedTo ? v.reissuedTo : null;
}

/** เลขอ้างอิงที่ระบบบัญชีเห็น (ใบที่ได้ mapping จากใบเดิม = เลขของใบเดิม) — ไม่มี = เลขของเอกสารเอง */
export function externalRefOf(detail: unknown): string | null {
  const v = (detail ?? {}) as { externalRef?: unknown };
  return typeof v.externalRef === 'string' && v.externalRef ? v.externalRef : null;
}

/** mapping บอกว่าเอกสารอยู่ในระบบบัญชีครบ (มี id · ERP ไม่ได้ยกเลิก · ไม่ใช่ส่งไม่ครบ · ไม่ถูกย้าย) */
export function mappingInErp(m: MappingLike | null | undefined): boolean {
  if (!m?.externalId || m.externalStatus === 'VOIDED' || m.status === 'RETIRED') return false;
  return (m.detail as { documentsPartial?: unknown } | null)?.documentsPartial !== true;
}

/** connector นี้ส่งการปรับใบเป็น "ภาพหลังปรับ" (replaceDocument) — docs/01 §6.1 */
export function replacesAdjustments(capabilities: readonly string[]): boolean {
  return documentSyncMode(capabilities, 'creditNote') === 'REPLACE';
}

export interface ReissueTarget {
  id: string;
  invoiceNo: string | null;
  customerId: string;
  issuingCompanyId: string;
  cancelledBy: string | null;
}

/**
 * ใบเดิมที่ใบใหม่ (ซึ่งอ้าง `fromId` เป็นใบที่แทน) ต้องแทนที่ในระบบบัญชี — ไล่ย้อนผ่านใบที่ยกเลิกแล้ว
 * `connectorId` null = connector ใดก็ได้ · เจอใบที่ยังไม่ยกเลิก / ถูกแทนที่ไปแล้ว / อยู่ในระบบบัญชีไม่ครบ = null
 */
export async function reissueTarget(
  tx: Tx,
  connectorId: string | null,
  fromId: string | null,
): Promise<ReissueTarget | null> {
  let cur = fromId;
  const seen = new Set<string>();
  for (let i = 0; cur && i < MAX_CHAIN && !seen.has(cur); i++) {
    seen.add(cur);
    const inv = await tx.invoice.findUnique({
      where: { id: cur },
      select: {
        id: true,
        status: true,
        invoiceNo: true,
        customerId: true,
        issuingCompanyId: true,
        cancelledBy: true,
        replacesInvoiceId: true,
      },
    });
    if (!inv || inv.status !== 'CANCELLED') return null;
    const maps = await tx.externalMapping.findMany({
      where: { entityType: 'INVOICE', localId: cur, ...(connectorId ? { connectorId } : {}) },
      select: { externalId: true, externalStatus: true, status: true, detail: true },
    });
    if (maps.some((m) => reissuedToOf(m.detail))) return null;
    if (maps.some((m) => mappingInErp(m)))
      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        customerId: inv.customerId,
        issuingCompanyId: inv.issuingCompanyId,
        cancelledBy: inv.cancelledBy,
      };
    // อยู่ในระบบบัญชีไม่ครบ / ERP ยกเลิกแล้ว = ไม่ใช่เป้าหมายของการแทนที่ (ทางเดิม: ส่งใบใหม่ + แจ้งบัญชี)
    if (maps.some((m) => m.externalId)) return null;
    cur = inv.replacesInvoiceId;
  }
  return null;
}

/**
 * ใบที่ถูกยกเลิก (`voidedId`) มีใบออกใหม่ที่ **จะ/ได้** แทนที่เอกสารของใบนี้ในระบบบัญชี connector นี้ → ไม่ต้องแจ้งบัญชียกเลิกเอง
 * - mapping ถูกย้ายไปใบใหม่แล้ว (`detail.reissuedTo`) = แทนที่แล้ว
 * - ไล่ใบที่ออกแทน (ข้ามใบที่ยกเลิก): ใบที่ยังใช้อยู่เป็น **ร่าง** = รอออกเอกสาร (ตอนออกจะแทนที่ หรือแจ้งบัญชีถ้าแทนที่ไม่ได้) ·
 *   ออกแล้วและมีคำสั่ง REPLACE_DOCUMENT ที่อ้างใบนี้ = กำลังแทนที่ (ผลของคำสั่งนั้นขึ้นคิว/แจ้งบัญชีเอง) · อื่น ๆ = ไม่ครอบคลุม
 */
export async function reissueCovers(
  tx: Tx,
  connectorId: string,
  voidedId: string,
): Promise<boolean> {
  const m = await tx.externalMapping.findUnique({
    where: {
      connectorId_entityType_localId: { connectorId, entityType: 'INVOICE', localId: voidedId },
    },
    select: { detail: true },
  });
  if (reissuedToOf(m?.detail)) return true;
  let cur = voidedId;
  const seen = new Set<string>([cur]);
  for (let i = 0; i < MAX_CHAIN; i++) {
    const next = await tx.invoice.findFirst({
      where: { replacesInvoiceId: cur },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    if (!next || seen.has(next.id)) return false;
    seen.add(next.id);
    if (next.status === 'DRAFT') return true;
    if (next.status !== 'CANCELLED') {
      const cmd = await tx.integrationOutbox.findFirst({
        where: {
          sink: 'erp',
          targetId: connectorId,
          operation: 'REPLACE_DOCUMENT',
          entityType: 'invoice',
          localId: next.id,
          payload: { path: ['reissueOf'], equals: voidedId },
        },
        select: { id: true },
      });
      return !!cmd;
    }
    cur = next.id;
  }
  return false;
}
