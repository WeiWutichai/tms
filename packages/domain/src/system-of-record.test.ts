import { describe, expect, it } from 'vitest';
import {
  canIssueTaxDocumentNumber,
  DEFAULT_CONNECTOR_SOR,
  DEFAULT_SOR_FIELD_SYNC,
  fieldChangePolicy,
  fieldSyncErrors,
  normalizeFieldSync,
  STANDALONE_SOR,
  type SystemOfRecord,
} from './system-of-record';

const erpOwned: SystemOfRecord = {
  ...DEFAULT_CONNECTOR_SOR,
  fieldSync: { ...DEFAULT_SOR_FIELD_SYNC },
};

describe('System-of-record rules (ST7-T17; docs/04 G3, docs/01 §8.1)', () => {
  it('เกณฑ์ตรวจรับ: taxDocumentOwner = ERP → TMS ไม่ออกเลขใบกำกับภาษี · TMS/Standalone → ออกได้', () => {
    expect(canIssueTaxDocumentNumber({ taxDocumentOwner: 'ERP' })).toBe(false);
    expect(canIssueTaxDocumentNumber({ taxDocumentOwner: 'TMS' })).toBe(true);
    expect(canIssueTaxDocumentNumber(STANDALONE_SOR)).toBe(true);
  });

  it('ค่าเริ่มต้นตาม docs/04 G3: ราคา/วันที่/accessorial = auto-sync · เปลี่ยนลูกค้า = regenerate · แก้ได้จนรับชำระ', () => {
    expect(DEFAULT_CONNECTOR_SOR).toMatchObject({
      customerOwner: 'ERP',
      taxDocumentOwner: 'ERP',
      editableUntilPaid: true,
      fieldSync: {
        PRICE: 'AUTO_SYNC',
        DATES: 'AUTO_SYNC',
        ACCESSORIAL: 'AUTO_SYNC',
        CUSTOMER: 'REGENERATE',
      },
    });
    expect(STANDALONE_SOR.taxDocumentOwner).toBe('TMS');
    expect(STANDALONE_SOR.customerOwner).toBe('TMS');
  });

  it('normalizeFieldSync: เติมค่าเริ่มต้น · ทิ้งค่าที่ไม่รู้จัก · CUSTOMER เป็น REGENERATE เสมอ', () => {
    expect(normalizeFieldSync(null)).toEqual(DEFAULT_SOR_FIELD_SYNC);
    expect(normalizeFieldSync({ PRICE: 'REGENERATE', FOO: 'AUTO_SYNC', DATES: 'x' })).toEqual({
      ...DEFAULT_SOR_FIELD_SYNC,
      PRICE: 'REGENERATE',
    });
    expect(normalizeFieldSync({ CUSTOMER: 'AUTO_SYNC' }).CUSTOMER).toBe('REGENERATE');
  });

  it('fieldSyncErrors: กลุ่มไม่รู้จัก / ค่าไม่ถูก / CUSTOMER auto-sync ไม่ได้', () => {
    expect(fieldSyncErrors({ PRICE: 'REGENERATE', DATES: 'AUTO_SYNC' })).toEqual([]);
    expect(fieldSyncErrors({ FOO: 'AUTO_SYNC' })[0]!.code).toBe('unknown_field_group');
    expect(fieldSyncErrors({ PRICE: 'MAYBE' })[0]!.code).toBe('invalid_option');
    expect(fieldSyncErrors({ CUSTOMER: 'AUTO_SYNC' })[0]).toMatchObject({
      field: 'fieldSync.CUSTOMER',
      code: 'regenerate_required',
    });
  });

  it('fieldChangePolicy: ไม่มีสำเนาใน ERP = LOCAL · ตามกลุ่ม · รับชำระแล้ว (บางส่วนก็นับ) = BLOCKED เมื่อ editableUntilPaid', () => {
    expect(fieldChangePolicy(erpOwned, 'PRICE', 'ISSUED', false)).toEqual({ mode: 'LOCAL' });
    expect(fieldChangePolicy(erpOwned, 'PRICE', 'ISSUED', true)).toEqual({ mode: 'AUTO_SYNC' });
    expect(fieldChangePolicy(erpOwned, 'CUSTOMER', 'ISSUED', true)).toEqual({ mode: 'REGENERATE' });
    for (const st of ['PARTIALLY_PAID', 'PAID'])
      expect(fieldChangePolicy(erpOwned, 'DATES', st, true)).toEqual({
        mode: 'BLOCKED',
        code: 'paid_locked',
      });
    expect(
      fieldChangePolicy({ ...erpOwned, editableUntilPaid: false }, 'DATES', 'PAID', true),
    ).toEqual({ mode: 'AUTO_SYNC' });
    expect(
      fieldChangePolicy(
        { ...erpOwned, fieldSync: { ...erpOwned.fieldSync, PRICE: 'REGENERATE' } },
        'PRICE',
        'ADJUSTED',
        true,
      ),
    ).toEqual({ mode: 'REGENERATE' });
  });
});
