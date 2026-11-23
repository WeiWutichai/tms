import { describe, expect, it } from 'vitest';
import {
  canIssueTaxDocumentNumber,
  DEFAULT_SOR_FIELD_SYNC,
  fieldChangePolicy,
  fieldSyncErrors,
  normalizeFieldSync,
  SOR_TAX_OWNER_WARNINGS,
  SOR_TAX_PUSH_CAPABILITIES,
  STANDALONE_SOR,
  taxDocumentOwnerWarning,
} from './system-of-record';

const sync = { fieldSync: { ...DEFAULT_SOR_FIELD_SYNC } };

describe('System-of-record rules (ST7-T17; docs/04 G3, docs/01 §8.1)', () => {
  it('เกณฑ์ตรวจรับ: taxDocumentOwner = ERP → TMS ไม่ออกเลขใบกำกับภาษี', () => {
    expect(canIssueTaxDocumentNumber({ taxDocumentOwner: 'ERP' })).toBe(false);
  });

  it('D68-04: ERP = ห้ามออกเลขทุกกรณี (แม้ connector ยังส่งไม่ถึง ERP) + คำเตือน ERP_NOT_CONNECTED', () => {
    // ไม่มีทางที่ ERP + connector ไม่พร้อม แล้ว TMS ออกเลขเอง (เดิม standalone-first ออกเอง — เสี่ยงเลขซ้ำสองระบบ)
    expect(canIssueTaxDocumentNumber({ taxDocumentOwner: 'ERP' })).toBe(false);
    expect(taxDocumentOwnerWarning({ taxDocumentOwner: 'ERP' }, false)).toBe('ERP_NOT_CONNECTED');
    expect(taxDocumentOwnerWarning({ taxDocumentOwner: 'ERP' }, true)).toBeNull();
    expect(SOR_TAX_OWNER_WARNINGS).toEqual(['ERP_NOT_CONNECTED']);
  });

  it('TMS / ยังไม่เลือก / Standalone → TMS ออกเลข · ไม่มีคำเตือน', () => {
    expect(canIssueTaxDocumentNumber({ taxDocumentOwner: 'TMS' })).toBe(true);
    expect(canIssueTaxDocumentNumber({ taxDocumentOwner: null })).toBe(true);
    expect(canIssueTaxDocumentNumber(STANDALONE_SOR)).toBe(true);
    for (const o of ['TMS', null] as const)
      for (const reach of [true, false])
        expect(taxDocumentOwnerWarning({ taxDocumentOwner: o }, reach)).toBeNull();
    expect(STANDALONE_SOR.customerOwner).toBe('TMS');
    expect([...SOR_TAX_PUSH_CAPABILITIES]).toEqual([
      'pushInvoice',
      'pushCreditNote',
      'replaceDocument',
    ]);
  });

  it('ค่าเริ่มต้นกลุ่ม field ตาม docs/04 G3: ราคา/วันที่/accessorial = auto-sync · เปลี่ยนลูกค้า = regenerate', () => {
    expect(DEFAULT_SOR_FIELD_SYNC).toEqual({
      PRICE: 'AUTO_SYNC',
      DATES: 'AUTO_SYNC',
      ACCESSORIAL: 'AUTO_SYNC',
      CUSTOMER: 'REGENERATE',
    });
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

  it('fieldChangePolicy: ไม่อยู่ใน ERP = LOCAL · ตามกลุ่ม · รับชำระแล้ว (บางส่วนก็นับ) = BLOCKED เสมอ (กฎ)', () => {
    expect(fieldChangePolicy(sync, 'PRICE', 'ISSUED', false)).toEqual({ mode: 'LOCAL' });
    expect(fieldChangePolicy(sync, 'PRICE', 'ISSUED', true)).toEqual({ mode: 'AUTO_SYNC' });
    expect(fieldChangePolicy(sync, 'CUSTOMER', 'ISSUED', true)).toEqual({ mode: 'REGENERATE' });
    for (const st of ['PARTIALLY_PAID', 'PAID'])
      expect(fieldChangePolicy(sync, 'DATES', st, true)).toEqual({
        mode: 'BLOCKED',
        code: 'paid_locked',
      });
    expect(
      fieldChangePolicy(
        { fieldSync: { ...DEFAULT_SOR_FIELD_SYNC, PRICE: 'REGENERATE' } },
        'PRICE',
        'ADJUSTED',
        true,
      ),
    ).toEqual({ mode: 'REGENERATE' });
  });
});
