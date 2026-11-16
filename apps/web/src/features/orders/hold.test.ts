import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOLD_CODES, HOLD_META, holdMeta } from './hold';
import { holdStopIndexes } from './HoldClear';

/** ชุดรหัสเหตุค้างของหน้าใบค้าง (ST3-T07) ต้องตรงกับ enum ใน OpenAPI (`ORDER_HOLD_CODES` ของ @tms/domain) */
describe('hold codes (ST3-T07)', () => {
  it('HOLD_CODES = enum OrderHoldCountDto.code ใน OpenAPI (ลำดับเดียวกัน)', () => {
    const spec = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi.json'), 'utf8'),
    ) as { components: { schemas: Record<string, { properties: { code: { enum: string[] } } }> } };
    expect([...HOLD_CODES]).toEqual(
      spec.components.schemas.OrderHoldCountDto!.properties.code.enum,
    );
    expect(Object.keys(HOLD_META).sort()).toEqual([...HOLD_CODES].sort());
  });

  it('ป้าย SOURCE_ERROR ใช้นิยามเดียว (แดง + circle-alert) ทั้งตารางและหัว drawer', () => {
    expect(holdMeta('SOURCE_ERROR')).toMatchObject({ tone: 'err', icon: 'circle-alert' });
  });

  it('holdStopIndexes: ทุกจุดของ GEOCODING_ERROR (fields) · ไม่มี fields = field เดียว', () => {
    const r = (field: string | null, fields: string[]) => ({
      holdReason: { code: 'GEOCODING_ERROR', label: '', note: null, field, fields },
    });
    expect(holdStopIndexes(r('stops[0].site', ['stops[0].site', 'stops[2].site']))).toEqual([0, 2]);
    expect(holdStopIndexes(r('stops[1].site', []))).toEqual([1]);
    expect(holdStopIndexes({ holdReason: null })).toEqual([]);
  });
});
