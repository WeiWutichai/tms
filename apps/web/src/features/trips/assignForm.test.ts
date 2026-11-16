import { describe, expect, it } from 'vitest';
import { sortVehicles } from './assignForm';

const v = (id: string, payloadKg: number | null, status = 'ready') => ({
  id,
  plate: id,
  payloadKg,
  status,
});

describe('sortVehicles (ST3-T17 รถเรียงตามความเหมาะสม)', () => {
  it('รถของเที่ยวก่อน → พร้อมใช้ที่รับน้ำหนักได้ (ความจุน้อยสุดที่พอ) → ไม่ทราบความจุ → รับไม่พอ → ซ่อม/จอด', () => {
    const out = sortVehicles(
      [
        v('small', 3000),
        v('big', 15000),
        v('fit', 6000),
        v('nocap', null),
        v('cur', 1000),
        v('shop', 6000, 'maintenance'),
      ],
      'cur',
      5000,
    );
    expect(out.map((x) => x.id)).toEqual(['cur', 'fit', 'big', 'nocap', 'small', 'shop']);
  });
  it('ไม่มีรถของเที่ยว / น้ำหนัก 0 → เรียงความจุน้อยไปมาก แล้วทะเบียน', () => {
    expect(
      sortVehicles([v('b', 6000), v('a', 6000), v('c', 3000)], null, 0).map((x) => x.id),
    ).toEqual(['c', 'a', 'b']);
  });
});
