import { describe, expect, it } from 'vitest';
import {
  canConnectorTransition,
  documentSyncMode,
  documentSyncModes,
  effectiveCapabilities,
  erpItemMappingStatus,
  isErpMasterCodeKind,
  ERP_CAPABILITIES,
  ERP_OPERATION_CAPABILITY,
  isErpCapability,
  isErpOperation,
  resolveErpMasterCode,
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

describe('erpItemMappingStatus (ST7-T18)', () => {
  const codes = new Set(['sv-frt-01', 'sv-wait']);
  it('ไม่มีรหัส = UNMAPPED', () => {
    expect(erpItemMappingStatus(null, codes)).toBe('UNMAPPED');
    expect(erpItemMappingStatus('  ', codes)).toBe('UNMAPPED');
  });
  it('มีรายการรหัสแล้ว: ต้องอยู่ในรายการ (ไม่สนตัวพิมพ์)', () => {
    expect(erpItemMappingStatus('SV-FRT-01', codes)).toBe('MAPPED');
    expect(erpItemMappingStatus('SV-NOPE', codes)).toBe('CODE_UNKNOWN');
  });
  it('ยังไม่มีรายการรหัส = เชื่อรหัสที่กรอก', () => {
    expect(erpItemMappingStatus('ANY-1', new Set())).toBe('MAPPED');
  });
  it('เคยมีผังแต่ถูกปิดหมด = ไม่กลับไปเชื่อรหัสที่กรอก', () => {
    expect(erpItemMappingStatus('ANY-1', new Set(), true)).toBe('CODE_UNKNOWN');
  });
  it('ชนิดรหัส', () => {
    expect(isErpMasterCodeKind('ITEM')).toBe(true);
    expect(isErpMasterCodeKind('item')).toBe(false);
  });
});

describe('resolveErpMasterCode (ST8-T06)', () => {
  const units = [
    { code: 'TRIP', name: 'เที่ยว' },
    { code: 'ตัน', name: null },
    { code: 'KM', name: 'กม.' },
    { code: 'H1', name: 'ชั่วโมง' },
    { code: 'H2', name: 'ชั่วโมง' },
  ];
  it('ตรงรหัส (ไม่สนตัวพิมพ์/ช่องว่าง) → รหัสตามผัง', () => {
    expect(resolveErpMasterCode(' trip ', units)).toEqual({ status: 'FOUND', code: 'TRIP' });
    expect(resolveErpMasterCode('ตัน', units)).toEqual({ status: 'FOUND', code: 'ตัน' });
  });
  it('ตรงชื่อของรหัสเดียว → รหัสนั้น', () => {
    expect(resolveErpMasterCode('เที่ยว', units)).toEqual({ status: 'FOUND', code: 'TRIP' });
    expect(resolveErpMasterCode('กม.', units)).toEqual({ status: 'FOUND', code: 'KM' });
  });
  it('ชื่อซ้ำหลายรหัส = AMBIGUOUS · ไม่มีค่า = MISSING · ไม่พบ = UNKNOWN', () => {
    expect(resolveErpMasterCode('ชั่วโมง', units).status).toBe('AMBIGUOUS');
    expect(resolveErpMasterCode('', units).status).toBe('MISSING');
    expect(resolveErpMasterCode(null, units).status).toBe('MISSING');
    expect(resolveErpMasterCode('คืน', units).status).toBe('UNKNOWN');
    expect(resolveErpMasterCode('เที่ยว', []).status).toBe('UNKNOWN');
  });
});
