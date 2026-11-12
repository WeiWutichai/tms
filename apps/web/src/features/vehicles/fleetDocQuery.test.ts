import { describe, expect, it } from 'vitest';
import { fleetDocQuery, type FleetDocFilters } from './useVehicleDocs';

const F: FleetDocFilters = { plate: '', docType: '', docNo: '', issuer: '', st: '' };
const f = (o: Partial<FleetDocFilters>) => ({ ...F, ...o });

describe('หน้าเอกสารรถรวม: แท็บ ∩ ตัวกรองสถานะ → query (ST2-T19)', () => {
  it('แท็บ: หมดแล้ว = status expired · ภายใน N วัน = expiresWithinDays', () => {
    expect(fleetDocQuery('all', F)).toEqual({ plate: '', docType: '', docNo: '', issuer: '' });
    expect(fleetDocQuery('exp', F)).toMatchObject({ status: 'expired' });
    expect(fleetDocQuery('d30', F)).toMatchObject({ expiresWithinDays: '30' });
    expect(fleetDocQuery('d60', F)?.status).toBeUndefined();
  });
  it('สถานะ: ใกล้หมดอายุ = ≤ 30 วัน · ปกติ = > 30 วัน · หมดอายุ', () => {
    expect(fleetDocQuery('all', f({ st: 'soon' }))).toMatchObject({ expiresWithinDays: '30' });
    expect(fleetDocQuery('d7', f({ st: 'soon' }))).toMatchObject({ expiresWithinDays: '7' });
    expect(fleetDocQuery('d60', f({ st: 'soon' }))).toMatchObject({ expiresWithinDays: '30' });
    expect(fleetDocQuery('all', f({ st: 'ok' }))).toMatchObject({ expiresBeyondDays: '30' });
    expect(fleetDocQuery('d60', f({ st: 'ok' }))).toMatchObject({
      expiresBeyondDays: '30',
      expiresWithinDays: '60',
    });
    expect(fleetDocQuery('all', f({ st: 'expired' }))).toMatchObject({ status: 'expired' });
    expect(fleetDocQuery('exp', f({ st: 'expired', plate: '70' }))).toMatchObject({
      status: 'expired',
      plate: '70',
    });
  });
  it('ขัดกันเอง → null (ตารางว่าง ไม่เรียก API)', () => {
    expect(fleetDocQuery('exp', f({ st: 'soon' }))).toBeNull();
    expect(fleetDocQuery('exp', f({ st: 'ok' }))).toBeNull();
    expect(fleetDocQuery('d30', f({ st: 'expired' }))).toBeNull();
    expect(fleetDocQuery('d30', f({ st: 'ok' }))).toBeNull();
    expect(fleetDocQuery('d7', f({ st: 'ok' }))).toBeNull();
  });
});
