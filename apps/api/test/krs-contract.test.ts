import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** ST0-T19: contract ของ mock KRS เป็น JSON schema ที่ใช้ได้จริง */
const dir = join(__dirname, '../../../packages/contracts/krs');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateReq = ajv.compile(
  JSON.parse(readFileSync(join(dir, 'invoice-request.schema.json'), 'utf8')),
);
const validateRes = ajv.compile(
  JSON.parse(readFileSync(join(dir, 'invoice-response.schema.json'), 'utf8')),
);

const valid = {
  tmsVoucherNo: 'INV-00000-2611-0001',
  voucherDate: '2026-11-30',
  dueDate: '2026-12-30',
  paymentInDay: 30,
  custOrSuppCode: 'C0001',
  custOrSuppName: 'บจก. ตัวอย่างลูกค้า',
  address: '1 ถนนตัวอย่าง กรุงเทพฯ 10110',
  deliveryAddress: '1 ถนนตัวอย่าง กรุงเทพฯ 10110',
  salePerson: 'S01',
  saleName: 'ฝ่ายขาย',
  entryBy: 'TMS',
  lines: [
    {
      lineId: 1,
      mainQuantity: 1,
      mainUnits: 'เที่ยว',
      unitPrice: 6500,
      flowNo: 'DO-2611-00042',
      flowDate: '2026-11-03',
      carId: '70-1234',
      carPerson: 'สมชาย',
      frWay: 'บางนา',
      toWay: 'แหลมฉบัง',
    },
  ],
};

describe('KRS invoice contract', () => {
  it('payload ครบตามสัญญาผ่าน', () => {
    expect(validateReq(valid), JSON.stringify(validateReq.errors)).toBe(true);
  });
  it('ฟิลด์นอก whitelist (เช่น voucherNo ที่ KRS ออกเอง) ถูกปฏิเสธ — KRS ตอบ 400', () => {
    expect(validateReq({ ...valid, voucherNo: 'SA-S2611-0001' })).toBe(false);
    expect(validateReq({ ...valid, lines: [{ ...valid.lines[0], vatType: 'EXEMPT' }] })).toBe(
      false,
    );
  });
  it('วันที่ผิดรูปแบบ / lineId ไม่ใช่ int / ไม่มีรายการ ถูกปฏิเสธ', () => {
    expect(validateReq({ ...valid, voucherDate: '30/11/2026' })).toBe(false);
    expect(validateReq({ ...valid, lines: [{ ...valid.lines[0], lineId: 1.5 }] })).toBe(false);
    expect(validateReq({ ...valid, lines: [] })).toBe(false);
  });
  it('response ต้องมี transactionNo และ voucherNo รูปแบบ SA-S{YYMM}-{NNNN}', () => {
    expect(validateRes({ transactionNo: '123', voucherNo: 'SA-S2611-0042' })).toBe(true);
    expect(validateRes({ transactionNo: '123', voucherNo: 'X' })).toBe(false);
  });
});
