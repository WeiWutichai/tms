import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * ตั้งค่า → ภาษี: ช่องที่ต้นแบบไม่มี (ST1-T16/T17 — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ)
 * แยกเอกสาร VAT · รอบวางบิลเริ่มต้น · free time · ออกบิลในนาม/จ้างในนาม (เฉพาะมีหลายนิติบุคคล) — บันทึกผ่าน PATCH /v1/settings ปุ่มเดียว
 */
const mutate = vi.fn();
let companies: { id: string; legalName: string; status: string }[] = [];
const SETTINGS = [
  ['tax.vatDefault', 'EXEMPT_TRANSPORT'],
  ['tax.invoiceModePolicy', 'ON_PAYMENT'],
  ['tax.wht1Enabled', true],
  ['tax.wht3Enabled', false],
  ['tax.separateVatDocs', false],
  ['billing.cycleDefault', 'MONTHLY'],
  ['billing.freeTimeMinutes', null],
  ['routing.invoiceAsCompanyId', null],
  ['routing.tenderAsCompanyId', null],
].map(([key, value]) => ({ key, value, version: 2 }));
const LOADED = { data: SETTINGS };
const refetch = vi.fn();
vi.mock('./useSettings', () => ({
  // ค่าเดิมทุก render (useDraft ตั้ง draft ใหม่เมื่อ data เปลี่ยน — object ใหม่ทุกครั้ง = วนไม่จบ)
  useTenantSettings: () => ({ isError: false, data: LOADED, refetch }),
  useSaveTenantSettings: () => ({ isPending: false, mutate }),
  useCompaniesAll: () => ({ data: { data: companies } }),
  useBranches: () => ({ data: undefined }),
  stepUp: vi.fn(),
}));

const { TaxSection } = await import('./OrgSections');
const wrap = (canWrite = true) =>
  render(
    <I18nProvider lang="th">
      <TaxSection canWrite={canWrite} />
    </I18nProvider>,
  );

describe('TaxSection: ค่าเริ่มต้นการวางบิล/นิติบุคคล', () => {
  beforeEach(() => {
    mutate.mockClear();
    companies = [{ id: 'cmp_1', legalName: 'บริษัท เอ จำกัด', status: 'active' }];
  });

  it('แก้หลายช่อง → บันทึกครั้งเดียวด้วยค่าที่เปลี่ยน + version', () => {
    wrap();
    fireEvent.click(screen.getByRole('switch', { name: /แยกรายการ VAT 7%/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'รายสัปดาห์' }));
    fireEvent.change(screen.getByLabelText('free time ค่ารอ (นาที)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      values: {
        'tax.separateVatDocs': true,
        'billing.cycleDefault': 'WEEKLY',
        'billing.freeTimeMinutes': 60,
      },
      versions: {
        'tax.separateVatDocs': 2,
        'billing.cycleDefault': 2,
        'billing.freeTimeMinutes': 2,
      },
    });
  });

  it('free time นอกช่วง 0–1440 → ปุ่มบันทึกกดไม่ได้ · นิติบุคคลเดียว = ไม่มีช่องออกบิล/จ้างในนาม', () => {
    wrap();
    fireEvent.change(screen.getByLabelText('free time ค่ารอ (นาที)'), {
      target: { value: '2000' },
    });
    expect(screen.getByRole('button', { name: 'บันทึก' })).toBeDisabled();
    expect(screen.getByRole('alert').textContent).toBe('ใส่จำนวนเต็ม 0–1440 นาที หรือเว้นว่าง');
    expect(screen.getByRole('button', { name: 'บันทึก' }).getAttribute('aria-busy')).toBeNull();
    expect(screen.queryByLabelText('ออกบิลในนาม')).toBeNull();
  });

  it('ค่าที่บันทึกชี้นิติบุคคลที่เลิกใช้ = แสดงชื่อพร้อมป้าย "เลิกใช้แล้ว" (ไม่ตกเป็น "ไม่ระบุ")', () => {
    const row = SETTINGS.find((x) => x.key === 'routing.invoiceAsCompanyId')!;
    row.value = 'cmp_old';
    companies = [
      ...companies,
      { id: 'cmp_old', legalName: 'บริษัท เก่า จำกัด', status: 'inactive' },
    ];
    try {
      wrap();
      const sel = screen.getByLabelText('ออกบิลในนาม') as HTMLSelectElement;
      expect(sel.value).toBe('cmp_old');
      expect(sel.selectedOptions[0]!.textContent).toBe('บริษัท เก่า จำกัด (เลิกใช้แล้ว)');
      // นิติบุคคลที่เลิกใช้ไม่เป็นตัวเลือกของช่องอื่น
      expect((screen.getByLabelText('จ้างในนาม') as HTMLSelectElement).textContent).not.toContain(
        'บริษัท เก่า',
      );
    } finally {
      row.value = null;
    }
  });

  it('หลายนิติบุคคล → เลือก "ออกบิลในนาม" / "จ้างในนาม" ได้', () => {
    companies = [...companies, { id: 'cmp_2', legalName: 'บริษัท บี จำกัด', status: 'active' }];
    wrap();
    fireEvent.change(screen.getByLabelText('ออกบิลในนาม'), { target: { value: 'cmp_2' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(mutate.mock.calls[0]![0].values).toEqual({ 'routing.invoiceAsCompanyId': 'cmp_2' });
    expect(screen.getByLabelText('จ้างในนาม')).toBeInTheDocument();
  });

  it('ไม่มีสิทธิ์แก้ = ช่องปิด ไม่มีปุ่มบันทึก', () => {
    wrap(false);
    expect(screen.getByLabelText('free time ค่ารอ (นาที)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'บันทึก' })).toBeNull();
  });
});
