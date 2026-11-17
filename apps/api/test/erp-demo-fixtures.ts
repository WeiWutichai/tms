import type { CanonicalDocument } from '../src/modules/erp/erp-adapter';

/** ST7-T14 ค่าทดสอบของ DemoProvider (ใช้ร่วม test หน่วย + integration) */
export function connectorIdOf(name: string): string {
  const hex = Buffer.from(name).toString('hex').padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

/** canonical document ขั้นต่ำ (ฉบับเต็มใน ST7-T15) — เงินเป็นสตริงทศนิยม */
export function docOf(id: string, number: string, total = '100.00'): CanonicalDocument {
  return { id, number, totals: { total } };
}
