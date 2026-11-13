import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n';
import { groupWarnings, ImportWarnings } from './ImportWarnings';

const HOLD = 'ใบสั่งจะเข้าระบบเป็นใบค้าง — ยังไม่มีราคาขาย';
const issues = [
  { row: 2, code: 'order_on_hold', message: HOLD, severity: 'warning' },
  { row: 3, code: 'reference_not_found', column: 'จุดส่ง', message: 'ไม่พบ', severity: 'error' },
  { row: 5, code: 'order_on_hold', message: HOLD, severity: 'warning' },
  {
    row: 6,
    code: 'no_external_id',
    column: 'เลขอ้างอิงใบสั่ง',
    message: 'ไม่มีเลขอ้างอิงใบสั่ง — นำเข้าไฟล์นี้ซ้ำจะได้ใบใหม่ซ้ำ',
    severity: 'warning',
  },
  ...Array.from({ length: 10 }, (_, i) => ({
    row: 10 + i,
    code: 'order_unchanged',
    column: 'เลขอ้างอิงใบสั่ง',
    message: 'มีใบสั่งนี้แล้ว ข้อมูลเหมือนเดิม — ไม่เปลี่ยนแปลง',
    severity: 'warning',
  })),
];

describe('คำเตือนใน wizard นำเข้า (ST3-T04 QA)', () => {
  it('รวมตามข้อความ ไม่รวมแถวผิด', () => {
    const g = groupWarnings(issues);
    expect(g.map((x) => [x.code, x.rows.length])).toEqual([
      ['order_on_hold', 2],
      ['no_external_id', 1],
      ['order_unchanged', 10],
    ]);
    expect(g[1]!.message).toBe(
      'เลขอ้างอิงใบสั่ง: ไม่มีเลขอ้างอิงใบสั่ง — นำเข้าไฟล์นี้ซ้ำจะได้ใบใหม่ซ้ำ',
    );
  });

  it('แสดงหัว "คำเตือน N แถว" + แถวต่อกลุ่ม (ย่อเมื่อเกิน 8 แถว) แยกจากแถวผิด', () => {
    render(
      <I18nProvider lang="th">
        <ImportWarnings issues={issues} />
      </I18nProvider>,
    );
    const box = screen.getByRole('region', { name: 'คำเตือน 13 แถว — ไม่ขวางการนำเข้า' });
    const hold = box.querySelector('[data-warning="order_on_hold"]') as HTMLElement;
    expect(within(hold).getByText('แถว 2, 5')).toBeInTheDocument();
    expect(within(hold).getByText(HOLD)).toBeInTheDocument();
    const same = box.querySelector('[data-warning="order_unchanged"]') as HTMLElement;
    expect(
      within(same).getByText('แถว 10, 11, 12, 13, 14, 15, 16, 17 และอีก 2 แถว'),
    ).toBeInTheDocument();
    expect(box.querySelector('[data-warning="reference_not_found"]')).toBeNull();
  });

  it('ไม่มีคำเตือน = ไม่แสดงกล่อง (ข้อมูลหลักที่ไม่มีคำเตือนเหมือนเดิม)', () => {
    const { container } = render(
      <I18nProvider lang="th">
        <ImportWarnings issues={[issues[1]!]} />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
