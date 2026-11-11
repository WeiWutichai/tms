import { FormDrawer, FormField, FormSection, TextInput } from '@tms/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { fieldErrors, problemText } from '../master/problems';
import { useCreateCustomer, useNextCustomerCode, type Customer } from './useCustomers';

interface Form {
  name: string;
  tax: string;
  branch: string;
  credit: string;
  ext: string;
}
const EMPTY: Form = { name: '', tax: '', branch: '00000', credit: '30', ext: '' };

/**
 * "เพิ่มลูกค้า" — drawer ฟอร์มของต้นแบบ (cfOpen cust): ข้อมูลหลัก (ชื่อ, เลขผู้เสียภาษี, รหัสสาขา, เครดิต)
 * + ข้อมูลเพิ่มเติม "รหัสลูกค้าในระบบเขา" = externalId [OPEN spec/12 §3]
 * ฟิลด์อื่น (ที่อยู่ ผู้ติดต่อ เงื่อนไข) กรอกต่อใน drawer ของลูกค้าหลังสร้าง (ตามต้นแบบ)
 */
export function CustomerCreateDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: Customer) => void;
}) {
  const { t } = useI18n();
  const next = useNextCustomerCode(open);
  const create = useCreateCustomer();
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState(false);
  // 1 การเปิดฟอร์ม = 1 Idempotency-Key — กดซ้ำ/เน็ตช้าส่งซ้ำได้ลูกค้ารายเดียว
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  useEffect(() => {
    if (open) {
      setF(EMPTY);
      setTried(false);
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      create.reset();
    }
  }, [open]);

  const local: Record<string, string> = {};
  if (f.name.trim().length < 3) local.legalName = t('cust.v.name');
  if (!/^\d{13}$/.test(f.tax.trim())) local.taxId = t('cust.v.tax');
  if (f.branch && !/^\d{5}$/.test(f.branch.trim())) local.branchCode = t('cust.v.branch');
  // ว่าง = ค่าเริ่มต้น 30 วัน (ตามต้นแบบ); ไม่ใช่ตัวเลข/เกิน 365 = แจ้ง ไม่ส่ง 0 เงียบ ๆ
  const credit =
    f.credit.trim() === '' ? 30 : /^\d{1,3}$/.test(f.credit.trim()) ? Number(f.credit) : NaN;
  if (!(credit >= 0 && credit <= 365)) local.creditTermDays = t('cust.v.credit');
  const server = fieldErrors(create.error, t);
  const dup =
    create.error instanceof ApiError && create.error.problem.code === 'duplicate'
      ? (create.error.problem as { existing?: { code: string; legalName: string } }).existing
      : undefined;
  if (dup) server.taxId = t('cust.v.dup', { code: dup.code, name: dup.legalName });
  const errs = { ...(tried ? local : {}), ...server };
  const top = create.error && !Object.keys(server).length ? problemText(create.error, t) : null;

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current) return;
    submitting.current = true;
    create.mutate(
      {
        idempotencyKey: idemKey,
        body: {
          legalName: f.name.trim(),
          taxId: f.tax.trim(),
          branchCode: f.branch.trim() || '00000',
          creditTermDays: credit,
          ...(f.ext.trim() ? { externalId: f.ext.trim() } : {}),
        },
      },
      {
        onSuccess: (c) => onCreated(c),
        // ข้อมูลถูกปฏิเสธ → แก้แล้วส่งใหม่เป็นคำขอใหม่ (key เดิมผูกกับ body เดิม)
        onError: () => setIdemKey(crypto.randomUUID()),
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  const input =
    (k: keyof Form, extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {}) =>
    (p: { id: string; 'aria-invalid': boolean }) => (
      <TextInput
        {...p}
        {...extra}
        value={f[k]}
        onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))}
      />
    );

  return (
    <FormDrawer
      open={open}
      title={t('cust.add')}
      subtitle={next.data ? t('cust.nextCode', { code: next.data.code }) : undefined}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      {...(tried && Object.keys(local).length
        ? { alert: t('form.incomplete', { n: Object.keys(local).length }) }
        : {})}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="tms-fdrawer__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 40, padding: '0 18px' }}
            disabled={create.isPending}
          >
            {t('cust.add')}
          </button>
        </>
      }
    >
      {top && <div className="tms-alert">{top}</div>}
      <FormSection title={t('cust.sec.main')}>
        <FormField label={t('cust.f.name')} required span={2} error={errs.legalName}>
          {input('name', { autoFocus: true })}
        </FormField>
        <FormField label={t('cust.f.tax')} required error={errs.taxId}>
          {input('tax', { inputMode: 'numeric', maxLength: 13 })}
        </FormField>
        <FormField label={t('cust.f.branch')} error={errs.branchCode}>
          {input('branch', { inputMode: 'numeric', maxLength: 5 })}
        </FormField>
        <FormField label={t('cust.f.credit')} error={errs.creditTermDays}>
          {input('credit', {
            inputMode: 'decimal',
            placeholder: '0',
            style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
          })}
        </FormField>
      </FormSection>
      <FormSection title={t('cust.sec.extra')}>
        <FormField label={t('cust.f.ext')} hint={t('cust.f.extHint')} error={errs.externalId}>
          {input('ext')}
        </FormField>
      </FormSection>
    </FormDrawer>
  );
}
