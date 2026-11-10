import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/app.module';
import { priceFieldNames } from '../src/common/price-fields';

/**
 * ST1-T13 guard: ทุก property ใน OpenAPI ที่ชื่อขึ้นต้น sell/buy ต้องติด @PriceField
 * (ลืมติด = ราคารั่ว) และชื่อที่ลงทะเบียนต้องขึ้นต้น sell/buy (กันชื่อกลางที่ไปซ่อน field อื่นทั้งระบบ)
 */
describe('price field guard', () => {
  const spec = JSON.parse(
    readFileSync(resolve(__dirname, '../../../packages/contracts/openapi.json'), 'utf8'),
  ) as { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
  const names = priceFieldNames();

  it('property sell*/buy* ใน OpenAPI ลงทะเบียนเป็น field ราคาทั้งหมด', () => {
    const missing: string[] = [];
    for (const [schema, def] of Object.entries(spec.components.schemas))
      for (const prop of Object.keys(def.properties ?? {}))
        if (/^(sell|buy)[A-Z]/.test(prop) && !names.has(prop)) missing.push(`${schema}.${prop}`);
    expect(missing, 'ติด @PriceField ที่ field เหล่านี้').toEqual([]);
  });

  it('field ราคาที่ลงทะเบียนในโค้ดจริงใช้ชื่อขึ้นต้น sell/buy', () => {
    // test DTO ใน test/ ก็ลงทะเบียนชื่อแบบเดียวกัน — ตรวจรวมได้
    const bad = [...names.keys()].filter((n) => !/^(sell|buy)[A-Z]/.test(n));
    expect(bad).toEqual([]);
  });
});
