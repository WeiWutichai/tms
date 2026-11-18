import { describe, expect, it } from 'vitest';
import {
  canConnectorTransition,
  documentSyncMode,
  documentSyncModes,
  effectiveCapabilities,
  ERP_CAPABILITIES,
  ERP_OPERATION_CAPABILITY,
  isErpCapability,
  isErpOperation,
  unsupportedCapabilities,
} from './erp';

describe('ErpAdapter capabilities (ST7-T13; docs/01 §6.1)', () => {
  it('รายการ capability ตาม docs/01 §6.1 ครบ 10 ตัว', () => {
    expect([...ERP_CAPABILITIES].sort()).toEqual(
      [
        'pullOrders',
        'pushInvoice',
        'pushCreditNote',
        'pushSettlement',
        'fetchDocument',
        'fetchPaymentStatus',
        'listDocuments',
        'replaceDocument',
        'postedStatus',
        'ownsDocumentNumber',
      ].sort(),
    );
    expect(isErpCapability('pushInvoice')).toBe(true);
    expect(isErpCapability('voidInvoice')).toBe(false);
    expect(isErpCapability(1)).toBe(false);
  });

  it('capability ที่ใช้ได้ = adapter ∩ ที่เปิด · Standalone/ยกเลิกการเชื่อม = ว่าง', () => {
    const krsLike = ['pullOrders', 'pushInvoice', 'fetchDocument', 'replaceDocument'];
    expect(effectiveCapabilities(krsLike, ['pushInvoice', 'pullOrders'], 'ACTIVE')).toEqual([
      'pullOrders',
      'pushInvoice',
    ]);
    // tenant เปิดสิ่งที่ adapter ไม่มี → ไม่ได้
    expect(effectiveCapabilities(krsLike, ['pushCreditNote'], 'ACTIVE')).toEqual([]);
    // หยุดชั่วคราว/ผิดพลาด: เอกสารใหม่ยังเข้าคิว (ชุดเดิม) แต่ไม่ส่ง
    expect(effectiveCapabilities(krsLike, krsLike, 'PAUSED')).toEqual(krsLike);
    expect(effectiveCapabilities(krsLike, krsLike, 'ERROR')).toEqual(krsLike);
    expect(effectiveCapabilities(krsLike, krsLike, 'DISCONNECTED')).toEqual([]);
    expect(effectiveCapabilities(krsLike, krsLike, null)).toEqual([]);
  });

  it('unsupportedCapabilities: ชื่อนอกรายการ/ที่ adapter ไม่มี', () => {
    expect(
      unsupportedCapabilities(['pushInvoice'], ['pushInvoice', 'pushSettlement', 'x']),
    ).toEqual(['pushSettlement', 'x']);
    expect(unsupportedCapabilities(['pushInvoice'], [])).toEqual([]);
  });

  it('คำสั่ง outbox ↔ capability · การเปลี่ยนสถานะที่ผู้ใช้สั่งได้', () => {
    for (const [op, cap] of Object.entries(ERP_OPERATION_CAPABILITY)) {
      expect(isErpOperation(op)).toBe(true);
      expect(isErpCapability(cap)).toBe(true);
    }
    expect(isErpOperation('toString')).toBe(false);
    expect(isErpOperation('invoice.finalized')).toBe(false);
    expect(canConnectorTransition('resume', 'PAUSED')).toBe(true);
    expect(canConnectorTransition('resume', 'ACTIVE')).toBe(false);
    expect(canConnectorTransition('pause', 'DISCONNECTED')).toBe(false);
    expect(canConnectorTransition('disconnect', 'DISCONNECTED')).toBe(false);
    expect(canConnectorTransition('disconnect', 'ERROR')).toBe(true);
  });
});

describe('โหมด sync ต่อประเภทเอกสาร (ST7-T14; docs/01 §6.1)', () => {
  it('Standalone (ไม่มี capability) = NOT_APPLICABLE ทุกประเภท — invoice เดิน ISSUED → PAID โดยไม่มีสถานะ sync', () => {
    expect(documentSyncModes([])).toEqual({
      invoice: 'NOT_APPLICABLE',
      creditNote: 'NOT_APPLICABLE',
      debitNote: 'NOT_APPLICABLE',
      settlement: 'NOT_APPLICABLE',
    });
  });

  it('ตาม capability: push / replace (fallback) / ส่งใบปรับไม่ได้ = MANUAL', () => {
    expect(documentSyncMode(['pushInvoice', 'pushCreditNote'], 'creditNote')).toBe('PUSH');
    expect(documentSyncMode(['pushInvoice', 'replaceDocument'], 'debitNote')).toBe('REPLACE');
    expect(documentSyncMode(['pushInvoice'], 'creditNote')).toBe('MANUAL');
    expect(documentSyncMode(['pullOrders'], 'creditNote')).toBe('NOT_APPLICABLE');
    expect(documentSyncMode(['pullOrders'], 'invoice')).toBe('NOT_APPLICABLE');
    expect(documentSyncMode(['pushSettlement'], 'settlement')).toBe('PUSH');
    expect(documentSyncMode(['pushInvoice'], 'settlement')).toBe('NOT_APPLICABLE');
  });
});
