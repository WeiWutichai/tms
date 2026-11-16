import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { BlockedDialog, ruleTagKey } from './RuleDialogs';

const REASONS = [
  { key: 'DOC_CMI_EXPIRED|v=1', code: 'DOC_CMI_EXPIRED', message: 'พ.ร.บ. หมดอายุ 15 พ.ย. 2569' },
];
const setup = (canOverride: boolean, extra: { initialReason?: string; nothing?: boolean } = {}) => {
  const onOk = vi.fn();
  const onLink = vi.fn();
  render(
    <I18nProvider lang="th">
      <BlockedDialog
        open
        plate="70-1234 กทม."
        sub="6 ล้อ · สมชาย · รถคันนี้จ่ายงานไม่ได้"
        reasons={REASONS}
        canOverride={canOverride}
        {...extra}
        onLink={onLink}
        onOk={onOk}
        onClose={() => {}}
      />
    </I18nProvider>,
  );
  return { onOk, onLink };
};

/** ST3-T14 "ห้ามจ่ายงาน · {ทะเบียน}" (ต้นแบบ BP) — D-07: ยกเว้นได้เฉพาะ `trips:override` + เหตุผล ≥ 10 */
describe('BlockedDialog', () => {
  it('แสดงกฎที่ติด (ป้าย + รายละเอียด + ลิงก์ไปแก้) · ผู้วางแผน: ช่องเหตุผล/ปุ่มยกเว้นปิด พร้อมคำอธิบาย', () => {
    const { onLink } = setup(false);
    expect(screen.getByRole('heading', { name: 'ห้ามจ่ายงาน · 70-1234 กทม.' })).toBeInTheDocument();
    expect(screen.getByText('เอกสารรถหมดอายุ')).toBeInTheDocument();
    expect(screen.getByText('พ.ร.บ. หมดอายุ 15 พ.ย. 2569')).toBeInTheDocument();
    expect(
      screen.getByText('สิทธิ์ผู้วางแผนยกเว้นไม่ได้ ต้องให้ผู้จัดการอนุมัติ'),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /ยกเว้นและบันทึก log/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'เอกสารรถ' }));
    expect(onLink).toHaveBeenCalledWith('DOC_CMI_EXPIRED');
  });

  it('ผู้จัดการ: เหตุผลสั้นกว่า 10 ตัว → ปุ่มปิด · ครบ → ส่งเหตุผล (ตัดช่องว่าง)', () => {
    const { onOk } = setup(true);
    const btn = screen.getByRole('button', { name: /ยกเว้นและบันทึก log/ });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'สั้นไป' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  ต่ออายุแล้วรอกรมธรรม์  ' },
    });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onOk).toHaveBeenCalledWith('ต่ออายุแล้วรอกรมธรรม์', ['DOC_CMI_EXPIRED|v=1']);
  });
});

describe('BlockedDialog — ยกเว้นทีละเที่ยว (PO 17 พ.ย. 2569)', () => {
  it('เติมเหตุผลล่าสุดให้ แต่ต้องกดยืนยันเอง', () => {
    const { onOk } = setup(true, { initialReason: 'เหตุผลเดิมของรถคันนี้' });
    expect(screen.getByRole('textbox')).toHaveValue('เหตุผลเดิมของรถคันนี้');
    expect(onOk).not.toHaveBeenCalled();
  });
  it('ไม่มีเที่ยวให้ยกเว้น → ปุ่ม/ช่องปิด พร้อมคำอธิบาย', () => {
    setup(true, { nothing: true });
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByText(/ยังไม่มีเที่ยวที่ติดกฎบนรถคันนี้/)).toBeInTheDocument();
  });
});

describe('ruleTagKey — ป้ายสั้นของกฎ (ต้นแบบ issueOf)', () => {
  it.each([
    ['OVERWEIGHT', 'plan.tag.weight'],
    ['DOC_INSURANCE_EXPIRED', 'plan.tag.doc'],
    ['DOC_MISSING', 'plan.tag.docMissing'],
    ['DRIVER_LICENCE_CLASS', 'plan.tag.licClass'],
    ['DRIVER_LICENCE_EXPIRED', 'plan.tag.licExpired'],
    ['vehicle_overlap', 'plan.tag.clash'],
    ['DRIVING_HOURS_EXCEEDED', 'plan.tag.hours'],
    ['LOCATION_VEHICLE_LIMIT', 'plan.tag.site'],
    ['TEMP_MISMATCH', 'plan.tag.compat'],
    ['vehicle_not_ready', 'plan.tag.notReady'],
    ['SOMETHING_NEW', 'plan.tag.other'],
  ])('%s → %s', (code, key) => expect(ruleTagKey(code)).toBe(key));
});
