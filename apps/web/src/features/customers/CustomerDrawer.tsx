import { Badge, ChoiceGroup, Drawer, DrawerFooterButtons, TextInput } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { api, ApiError, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { CustomerSitesTab } from '../sites/CustomerSitesTab';
import { fieldErrors, problemText } from '../master/problems';
import {
  useCompanyOptions,
  useUpdateCustomer,
  type Customer,
  type CustomerInput,
} from './useCustomers';

type Tab = 'sum' | 'addr' | 'cond' | 'act';
const CYCLES = ['PER_DO', 'WEEKLY', 'MONTHLY', 'MANUAL'] as const;

interface Form {
  legalName: string;
  taxId: string;
  branchCode: string;
  addr: string;
  contact: string;
  phone: string;
  credit: string;
  billingCycle: Customer['billingCycle'];
  salesOwnerUserId: string;
  externalId: string;
  /** '' = ยังไม่ระบุ (null ใน API) — ไม่แสดงเป็นค่าเริ่มต้นที่ทำให้เข้าใจผิด */
  vat: 'EXEMPT_TRANSPORT' | 'VAT_7' | '';
  wht: '1.00' | '0.00' | '';
  taxInvoiceMode: Customer['taxInvoiceMode'];
  billingCompanyId: string;
  vatRegistered: 'yes' | 'no';
  etaxCapable: 'yes' | 'no';
  freeTimeMin: string;
}

function toForm(c: Customer): Form {
  const primary = c.contacts.find((x) => x.isPrimary) ?? c.contacts[0];
  return {
    legalName: c.legalName,
    taxId: c.taxId ?? '',
    branchCode: c.branchCode ?? '',
    addr: c.billingAddress?.line1 ?? '',
    contact: primary?.name ?? '',
    phone: primary?.phone ?? '',
    credit: String(c.creditTermDays),
    billingCycle: c.billingCycle,
    salesOwnerUserId: c.salesOwner?.id ?? '',
    externalId: c.externalId ?? '',
    vat:
      c.defaultVatType === 'VAT_7' || c.defaultVatType === 'EXEMPT_TRANSPORT'
        ? c.defaultVatType
        : '',
    wht: c.whtExpectedRate === '1.00' || c.whtExpectedRate === '0.00' ? c.whtExpectedRate : '',
    taxInvoiceMode: c.taxInvoiceMode,
    billingCompanyId: c.billingCompanyId ?? '',
    vatRegistered: c.vatRegistered ? 'yes' : 'no',
    etaxCapable: c.etaxCapable ? 'yes' : 'no',
    freeTimeMin: c.freeTimeMin === null ? '' : String(c.freeTimeMin),
  };
}

/** ฟอร์ม → PATCH เฉพาะช่องที่เปลี่ยน */
function diffBody(c: Customer, a: Form, b: Form): CustomerInput {
  const out: CustomerInput = {};
  if (a.legalName !== b.legalName) out.legalName = b.legalName.trim();
  if (a.taxId !== b.taxId) out.taxId = b.taxId.trim() || null;
  if (a.branchCode !== b.branchCode) out.branchCode = b.branchCode.trim();
  if (a.addr !== b.addr)
    out.billingAddress = b.addr.trim()
      ? { ...(c.billingAddress ?? {}), line1: b.addr.trim() }
      : null;
  if (a.contact !== b.contact || a.phone !== b.phone) {
    // ผู้ติดต่อหลักเดิม (คงอีเมล/ช่องอื่นไว้ — แก้ได้แค่ชื่อ/เบอร์ในหน้านี้)
    const pIdx = Math.max(
      0,
      c.contacts.findIndex((x) => x.isPrimary),
    );
    const old = c.contacts[pIdx];
    const rest = c.contacts.filter((_, i) => i !== pIdx || !old);
    const { phone: _p, ...keep } = old ?? { name: '' };
    out.contacts = b.contact.trim()
      ? [
          {
            ...keep,
            name: b.contact.trim(),
            ...(b.phone.trim() ? { phone: b.phone.trim() } : {}),
            isPrimary: true,
          },
          ...rest.map((x) => ({ ...x, isPrimary: false })),
        ]
      : rest;
  }
  if (a.credit !== b.credit) out.creditTermDays = Number(b.credit);
  if (a.billingCycle !== b.billingCycle) out.billingCycle = b.billingCycle;
  if (a.salesOwnerUserId !== b.salesOwnerUserId) out.salesOwnerUserId = b.salesOwnerUserId || null;
  if (a.externalId !== b.externalId) out.externalId = b.externalId.trim() || null;
  if (a.vat !== b.vat) out.defaultVatType = b.vat || null;
  if (a.wht !== b.wht) out.whtExpectedRate = b.wht || null;
  if (a.taxInvoiceMode !== b.taxInvoiceMode) out.taxInvoiceMode = b.taxInvoiceMode;
  if (a.billingCompanyId !== b.billingCompanyId) out.billingCompanyId = b.billingCompanyId || null;
  if (a.vatRegistered !== b.vatRegistered) out.vatRegistered = b.vatRegistered === 'yes';
  if (a.etaxCapable !== b.etaxCapable) out.etaxCapable = b.etaxCapable === 'yes';
  if (a.freeTimeMin !== b.freeTimeMin)
    out.freeTimeMin = b.freeTimeMin.trim() === '' ? null : Number(b.freeTimeMin);
  return out;
}

/** หัวตัวเลือก + "ยังไม่ระบุ" เมื่อค่าเป็น null */
function Unset({ label, unset, hint }: { label: string; unset: boolean; hint: string }) {
  return (
    <>
      {label}
      {unset && <span style={{ marginLeft: 8, color: '#8F5500', fontWeight: 400 }}>· {hint}</span>}
    </>
  );
}

/** ช่องใน drawer (label 12.5/500 + input 36px — ต้นแบบ this.fld()) */
function Fld({
  label,
  span = 1,
  error,
  hint,
  children,
}: {
  label: ReactNode;
  span?: 1 | 2;
  error?: string | undefined;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="tms-ffield" style={{ gridColumn: `span ${span}` }}>
      <label htmlFor={id} className="tms-label">
        {label}
      </label>
      {children(id)}
      {error ? (
        <span className="tms-field-error">{error}</span>
      ) : hint ? (
        <span className="tms-field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

/**
 * Drawer ลูกค้า — ต้นแบบ vPanel cust: แท็บ ทั่วไป / เงื่อนไข (+ กิจกรรม ตาม spec/02 §0.2)
 * ปุ่ม "บันทึก" เดียวบันทึกทุกแท็บ (PATCH + If-Match) · เมนู ⋯ = ปิดใช้/เปิดใช้, ลบ
 * แท็บ ที่อยู่ส่ง = สถานที่ของลูกค้า (ST2-T02) · Rate card (ST2-T13), การเชื่อมต่อ API (P1) ยังไม่แสดง [OPEN spec/12 §3]
 */
export function CustomerDrawer({
  customer: c,
  canWrite,
  canListUsers,
  onSaved,
  onToggleStatus,
  onDelete,
  onClose,
}: {
  customer: Customer;
  canWrite: boolean;
  canListUsers: boolean;
  onSaved: (c: Customer) => void;
  onToggleStatus: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('sum');
  const [base, setBase] = useState<Form>(() => toForm(c));
  // version ที่ฟอร์มโหลดมา — ส่งเป็น If-Match (ไม่ใช้ version ล่าสุดจากรายการ ไม่งั้นทับงานคนอื่นเงียบ ๆ)
  const [baseVersion, setBaseVersion] = useState(c.version);
  const stale = c.version !== baseVersion;
  const [f, setF] = useState<Form>(base);
  const [editExt, setEditExt] = useState(false);
  const save = useUpdateCustomer();
  const companies = useCompanyOptions();
  const users = useQuery({
    queryKey: ['users', 'options'],
    enabled: canListUsers && canWrite,
    queryFn: () => unwrap(api.GET('/v1/users', { params: { query: { limit: 200 } } })),
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const body = diffBody(c, base, f);
  const dirty = Object.keys(body).length > 0;
  const errs = fieldErrors(save.error, t);
  if (errs.billingAddress === undefined && errs['billingAddress.line1'])
    errs.billingAddress = errs['billingAddress.line1'];
  const dup =
    save.error instanceof ApiError && save.error.problem.code === 'duplicate'
      ? (save.error.problem as { existing?: { code: string; legalName: string } }).existing
      : undefined;
  if (dup) errs.taxId = t('cust.v.dup', { code: dup.code, name: dup.legalName });
  const creditBad = f.credit.trim() === '' || Number(f.credit) > 365;
  if (creditBad) errs.creditTermDays = t('cust.v.credit');
  const top =
    save.error && !Object.keys(fieldErrors(save.error, t)).length && !dup
      ? problemText(save.error, t)
      : null;
  const ro = !canWrite;
  const reload = () => {
    const nf = toForm(c);
    setBase(nf);
    setF(nf);
    setBaseVersion(c.version);
    save.reset();
  };

  // รายการถูกแก้ (เช่น ปิดใช้จากเมนู/ผู้อื่นแก้) ระหว่างที่ฟอร์มยังไม่ได้แก้อะไร → โหลดค่าใหม่เงียบ ๆ
  // ถ้าแก้ค้างอยู่ → แสดงแถบ "ถูกแก้โดยผู้อื่น" ให้กดโหลดใหม่ (ไม่ทับงานกัน)
  useEffect(() => {
    if (c.version !== baseVersion && !dirty) reload();
  }, [c.version]);

  const submit = () => {
    if (!dirty || creditBad || stale) return;
    save.mutate(
      { id: c.id, version: baseVersion, body },
      {
        onSuccess: (u) => {
          const nf = toForm(u);
          setBase(nf);
          setF(nf);
          setBaseVersion(u.version);
          setEditExt(false);
          onSaved(u);
        },
      },
    );
  };

  const owners = users.data?.data ?? [];
  const ownerOpts = [
    { value: '', label: '—' },
    ...owners.map((u) => ({ value: u.id, label: u.name })),
    ...(c.salesOwner && !owners.some((u) => u.id === c.salesOwner!.id)
      ? [{ value: c.salesOwner.id, label: c.salesOwner.name ?? c.salesOwner.id }]
      : []),
  ];
  const yesNo = (k: 'vatRegistered' | 'etaxCapable', yes: MessageKey, no: MessageKey) => [
    { value: 'yes' as const, label: t(yes) },
    { value: 'no' as const, label: t(no) },
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('cust.kind')}
      title={c.code}
      badge={
        <Badge
          label={t(c.status === 'active' ? 'cust.st.active' : 'cust.st.inactive')}
          tone={c.status === 'active' ? 'ok' : 'off'}
          icon={c.status === 'active' ? 'check' : 'ban'}
        />
      }
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite
        ? {
            menu: [
              {
                label: t(c.status === 'active' ? 'cust.menu.off' : 'cust.menu.on'),
                icon: 'ban',
                onClick: onToggleStatus,
              },
              { label: t('cust.menu.delete'), icon: 'trash-2', danger: true, onClick: onDelete },
            ],
          }
        : {})}
      tabs={[
        { key: 'sum', label: t('cust.tab.sum') },
        { key: 'addr', label: t('cust.tab.addr') },
        { key: 'cond', label: t('cust.tab.cond') },
        { key: 'act', label: t('cust.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
      footer={
        canWrite && tab !== 'act' && tab !== 'addr' ? (
          <DrawerFooterButtons
            primary={{
              label: t('common.save'),
              icon: 'save',
              onClick: submit,
              disabled: save.isPending,
            }}
          />
        ) : undefined
      }
    >
      {(stale ||
        (save.error instanceof ApiError && save.error.problem.code === 'precondition_failed')) && (
        <div className="tms-alert" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>{t('cust.stale')}</span>
          <button type="button" className="tms-textlink" onClick={reload}>
            {t('cust.reload')}
          </button>
        </div>
      )}
      {top &&
        !(save.error instanceof ApiError && save.error.problem.code === 'precondition_failed') && (
          <div className="tms-alert">{top}</div>
        )}
      {tab === 'sum' && (
        <>
          <section className="tms-kv">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span className="tms-kv__title">{t('cust.sec.extra')}</span>
              {canWrite && !editExt && (
                <button type="button" className="tms-textlink" onClick={() => setEditExt(true)}>
                  {t('common.edit')}
                </button>
              )}
            </div>
            <div className="tms-kv__grid">
              {editExt ? (
                <Fld label={t('cust.f.ext')} hint={t('cust.f.extHint')} error={errs.externalId}>
                  {(id) => (
                    <TextInput
                      id={id}
                      value={f.externalId}
                      onChange={(e) => set('externalId', e.target.value)}
                    />
                  )}
                </Fld>
              ) : (
                <div className="tms-kv__item" style={{ gap: 4 }}>
                  <span className="tms-kv__k">{t('cust.f.ext')}</span>
                  <span className="tms-kv__v tms-num">{c.externalId ?? '—'}</span>
                </div>
              )}
            </div>
          </section>
          <div className="tms-fgrid">
            <Fld label={t('cust.f.name')} span={2} error={errs.legalName}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={ro}
                  value={f.legalName}
                  onChange={(e) => set('legalName', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('cust.f.tax')} error={errs.taxId}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={ro}
                  inputMode="numeric"
                  maxLength={13}
                  value={f.taxId}
                  onChange={(e) => set('taxId', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('cust.f.branch')} error={errs.branchCode}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={ro}
                  inputMode="numeric"
                  maxLength={5}
                  value={f.branchCode}
                  onChange={(e) => set('branchCode', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('cust.f.addr')} span={2} error={errs.billingAddress}>
              {(id) => (
                <textarea
                  id={id}
                  readOnly={ro}
                  className="tms-textarea"
                  rows={3}
                  value={f.addr}
                  onChange={(e) => set('addr', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('cust.f.contact')} error={errs['contacts.0.name']}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={ro}
                  value={f.contact}
                  onChange={(e) => set('contact', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('cust.f.phone')} error={errs['contacts.0.phone']}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={ro}
                  value={f.phone}
                  onChange={(e) => set('phone', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('cust.f.credit')} error={errs.creditTermDays}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={ro}
                  inputMode="numeric"
                  value={f.credit}
                  onChange={(e) => set('credit', e.target.value.replace(/\D/g, ''))}
                />
              )}
            </Fld>
            <Fld label={t('cust.f.cycle')} error={errs.billingCycle}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro}
                  value={f.billingCycle}
                  onChange={(e) => set('billingCycle', e.target.value as Form['billingCycle'])}
                >
                  {CYCLES.map((x) => (
                    <option key={x} value={x}>
                      {t(`cust.cycle.${x}` as MessageKey)}
                    </option>
                  ))}
                </select>
              )}
            </Fld>
            <Fld label={t('cust.f.sales')} span={2} error={errs.salesOwnerUserId}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro || !canListUsers}
                  value={f.salesOwnerUserId}
                  onChange={(e) => set('salesOwnerUserId', e.target.value)}
                >
                  {ownerOpts.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
            </Fld>
          </div>
        </>
      )}
      {tab === 'cond' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ChoiceGroup
            label={<Unset label={t('cust.c.vat')} unset={f.vat === ''} hint={t('cust.c.unset')} />}
            disabled={ro}
            value={f.vat}
            onChange={(v) => set('vat', v)}
            options={[
              { value: 'EXEMPT_TRANSPORT', label: t('cust.c.vat.exempt') },
              { value: 'VAT_7', label: t('cust.c.vat.all') },
            ]}
          />
          <ChoiceGroup
            label={<Unset label={t('cust.c.wht')} unset={f.wht === ''} hint={t('cust.c.unset')} />}
            disabled={ro}
            value={f.wht}
            onChange={(v) => set('wht', v)}
            options={[
              { value: '1.00', label: t('cust.c.wht.1') },
              { value: '0.00', label: t('cust.c.wht.none') },
            ]}
          />
          <ChoiceGroup
            label={t('cust.c.iss')}
            disabled={ro}
            value={f.taxInvoiceMode}
            onChange={(v) => set('taxInvoiceMode', v)}
            options={[
              { value: 'ON_PAYMENT', label: t('cust.c.iss.pay') },
              { value: 'ON_ISSUE', label: t('cust.c.iss.issue') },
            ]}
          />
          {/* ช่องด้านล่างไม่มีในต้นแบบ — ฟิลด์ตาม backlog ST2-T01 / docs/04 B [OPEN spec/12 §3] */}
          <ChoiceGroup
            label={t('cust.c.vatReg')}
            disabled={ro}
            value={f.vatRegistered}
            onChange={(v) => set('vatRegistered', v)}
            options={yesNo('vatRegistered', 'cust.c.vatReg.yes', 'cust.c.vatReg.no')}
          />
          <ChoiceGroup
            label={t('cust.c.etax')}
            disabled={ro}
            value={f.etaxCapable}
            onChange={(v) => set('etaxCapable', v)}
            options={yesNo('etaxCapable', 'cust.c.etax.yes', 'cust.c.etax.no')}
          />
          <div className="tms-fgrid">
            <Fld label={t('cust.c.billAs')} error={errs.billingCompanyId}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro}
                  value={f.billingCompanyId}
                  onChange={(e) => set('billingCompanyId', e.target.value)}
                >
                  <option value="">{t('cust.c.billAs.default')}</option>
                  {(companies.data?.data ?? []).map((co) => (
                    <option key={co.id} value={co.id}>
                      {co.legalName}
                    </option>
                  ))}
                </select>
              )}
            </Fld>
            <Fld label={t('cust.c.free')} hint={t('cust.c.freeHint')} error={errs.freeTimeMin}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={ro}
                  inputMode="numeric"
                  value={f.freeTimeMin}
                  onChange={(e) => set('freeTimeMin', e.target.value.replace(/\D/g, ''))}
                />
              )}
            </Fld>
          </div>
        </div>
      )}
      {tab === 'addr' && (
        <CustomerSitesTab customerId={c.id} customerName={c.legalName} canWrite={canWrite} />
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/customers/{id}/history"
          id={c.id}
          fieldLabel={(k) => fieldLabel(t, k)}
        />
      )}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  legalName: 'cust.f.name',
  taxId: 'cust.f.tax',
  branchCode: 'cust.f.branch',
  billingAddress: 'cust.f.addr',
  contacts: 'cust.f.contact',
  creditTermDays: 'cust.f.credit',
  billingCycle: 'cust.f.cycle',
  salesOwner: 'cust.f.sales',
  externalId: 'cust.f.ext',
  defaultVatType: 'cust.c.vat',
  whtExpectedRate: 'cust.c.wht',
  taxInvoiceMode: 'cust.c.iss',
  billingCompanyId: 'cust.c.billAs',
  vatRegistered: 'cust.c.vatReg',
  etaxCapable: 'cust.c.etax',
  freeTimeMin: 'cust.c.free',
  status: 'cust.col.status',
};
function fieldLabel(t: (k: MessageKey) => string, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
