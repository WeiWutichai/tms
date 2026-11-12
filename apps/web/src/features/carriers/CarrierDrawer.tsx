import { Badge, ChoiceGroup, Drawer, DrawerFooterButtons, EmptyState, TextInput } from '@tms/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useCompanyOptions } from '../customers/useCustomers';
import { HistoryTab } from '../master/HistoryTab';
import { fieldErrors, isStale, problemText } from '../master/problems';
import { RefPicker, type RefOption } from '../master/RefPicker';
import { can } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { money } from '../rate-cards/rateFormat';
import { useRecentPrices } from '../rate-cards/useRateCards';
import {
  BANK_CODES,
  searchCarriers,
  useCreateCarrier,
  useUpdateCarrier,
  type BankCode,
  type Carrier,
  type CarrierCreate,
  type CarrierInput,
  type EntityType,
  type WhtRate,
} from './useCarriers';

type Tab = 'sum' | 'docs' | 'act';

interface Form {
  legalName: string;
  /** แก้รายการบุคคลธรรมดา: ว่าง = คงเลขเดิม (เลขเต็มไม่ส่งมาที่หน้าจอ) */
  taxId: string;
  entityType: EntityType;
  whtRate: WhtRate;
  lineContact: string;
  bankCode: BankCode | '';
  /** แก้รายการที่มีบัญชีแล้ว: ว่าง = คงเลขเดิม */
  accountNo: string;
  accountName: string;
  status: Carrier['status'];
  branchCode: string;
  address: string;
  phone: string;
  paymentTermDays: string;
  requirePodToPay: 'yes' | 'no';
  parent: RefOption | null;
  billingCompanyId: string;
  maxTripsPerDay: string;
  priority: string;
}

/** ค่าเริ่มต้นของผู้รับเหมาใหม่ตามต้นแบบ (นิติบุคคล, หัก 1%, ใช้งาน) */
const EMPTY: Form = {
  legalName: '',
  taxId: '',
  entityType: 'JURISTIC',
  whtRate: '1.00',
  lineContact: '',
  bankCode: '',
  accountNo: '',
  accountName: '',
  status: 'active',
  branchCode: '00000',
  address: '',
  phone: '',
  paymentTermDays: '30',
  requirePodToPay: 'yes',
  parent: null,
  billingCompanyId: '',
  maxTripsPerDay: '',
  priority: '',
};

function toForm(c: Carrier): Form {
  return {
    legalName: c.legalName,
    taxId: c.taxId ?? '',
    entityType: c.entityType,
    whtRate: c.whtRate,
    lineContact: c.lineContact ?? '',
    bankCode: c.bankAccount?.bankCode ?? '',
    accountNo: '',
    accountName: c.bankAccount?.accountName ?? '',
    status: c.status,
    branchCode: c.branchCode ?? (c.entityType === 'JURISTIC' ? '00000' : ''),
    address: c.address?.line1 ?? '',
    phone: c.phone ?? '',
    paymentTermDays: String(c.paymentTermDays),
    requirePodToPay: c.requirePodToPay ? 'yes' : 'no',
    parent: c.parent ? { id: c.parent.id, label: c.parent.legalName, sub: c.parent.code } : null,
    billingCompanyId: c.billingCompanyId ?? '',
    maxTripsPerDay: c.maxTripsPerDay === null ? '' : String(c.maxTripsPerDay),
    priority: c.priority === null ? '' : String(c.priority),
  };
}

const digits = (s: string) => s.replace(/[\s-]/g, '');
const intOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

/** ค่าที่แสดงแทนเลขลับ (spec/11 NFR-304) */
export const masked = (last4: string | null | undefined) => (last4 ? `•••• ${last4}` : '—');
export const bankName = (t: T, code: string) => t(`car.bank.${code}` as MessageKey);
export const taxText = (c: Carrier) => c.taxId ?? masked(c.taxIdLast4);

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

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="tms-kv__item">
      <span className="tms-kv__k">{k}</span>
      <span className="tms-kv__v" style={{ overflowWrap: 'anywhere' }}>
        {v}
      </span>
    </div>
  );
}

/**
 * ต้นแบบ this.num() = toLocaleString('en-US'): คอมมาหลักพัน ไม่เติมทศนิยมศูนย์ (5,200 · 5,200.5)
 * เงินจาก API เป็นสตริง 2 ตำแหน่ง — จัดรูปจากสตริง (ไม่แปลงเป็น float)
 */
const plainNum = (v: string) =>
  money(v)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

/** ราคา 5 ครั้งล่าสุดที่จ้างรายนี้ (ต้นแบบ kv mono 13px) — ไม่มี `prices.buy:read` ไม่เรียก API */
function Last5({ id }: { id: string }) {
  const me = useMe();
  const allowed = can(me.data?.scopes ?? [], 'prices.buy:read');
  const q = useRecentPrices(id, allowed);
  const list = (q.data?.data ?? []).filter((p) => p.buyAmount !== undefined);
  if (!list.length) return <>—</>;
  return (
    <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
      {list.map((p) => plainNum(p.buyAmount!)).join(' · ')}
    </span>
  );
}

export function CarrierBadge({ c, t }: { c: Carrier | null; t: T }) {
  if (!c) return <Badge label={t('car.st.draft')} tone="off" icon="file" />;
  return c.status === 'active' ? (
    <Badge label={t('car.st.active')} tone="ok" icon="check" />
  ) : (
    <Badge label={t('car.st.inactive')} tone="warn" icon="pause" />
  );
}

/**
 * Drawer ผู้รับเหมา — ต้นแบบ vPanel con: หัว "ผู้รับเหมา · นิติบุคคล" / "เพิ่มผู้รับเหมาใหม่", แท็บ ข้อมูลผู้รับเหมา / เอกสารแนบ / กิจกรรม
 * ส่วน "ข้อมูล" 4 ช่องตามต้นแบบ + ฟอร์มตามลำดับต้นแบบ (ชื่อ, เลขผู้เสียภาษี, ประเภท, หัก ณ ที่จ่าย, LINE ID, บัญชีรับเงิน, สถานะ)
 * ปุ่ม "บันทึก" เดียว (สร้าง = POST + Idempotency-Key, แก้ = PATCH + If-Match) · สถานะเป็นระงับ → ขอเหตุผลก่อน (A3/กฎร่วม)
 * ส่วนที่ต้นแบบไม่มี [OPEN spec/12 §3]: "ข้อมูลเพิ่มเติม" (สาขา ที่อยู่ เบอร์ เงื่อนไขจ่าย ไม่มี POD ไม่จ่าย สังกัด จ้างในนาม
 * เพดานเที่ยว/วัน ลำดับ — ฟิลด์ตาม backlog ST2-T05), บัญชีรับเงินแยก ธนาคาร/เลขบัญชี/ชื่อบัญชี (เลขบัญชีเข้ารหัส แสดง •••• 1234),
 * คะแนนตรงเวลา/ตีกลับ = "—" จนกว่าจะมีเที่ยว (ST3/ST6), เอกสารแนบยังไม่มีที่เก็บต่อผู้รับเหมา (ST2-T20/T21)
 * ราคา 5 ครั้งล่าสุด (ST2-T14) = `GET /v1/carriers/{id}/recent-prices` ใหม่สุดก่อน คั่น " · " (ต้นแบบ c.last) — ไม่มีสิทธิ์ดูราคาซื้อ/ยังไม่เคยจ้าง = "—"
 */
export function CarrierDrawer({
  carrier: c,
  canWrite,
  canBank,
  onSaved,
  onStatusChange,
  onDelete,
  onClose,
}: {
  /** null = เพิ่มผู้รับเหมาใหม่ */
  carrier: Carrier | null;
  canWrite: boolean;
  /** แก้บัญชีรับเงินได้ (settlements:pay — ชั่วคราวจนกว่าจะตัดสิน step-up NFR-107) */
  canBank: boolean;
  onSaved: (c: Carrier, created: boolean) => void;
  /** เปลี่ยนสถานะ (ระงับ → page เปิด dialog เหตุผล) */
  onStatusChange: (c: Carrier) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const isNew = !c;
  const [tab, setTab] = useState<Tab>('sum');
  const [base, setBase] = useState<Form>(() => (c ? toForm(c) : EMPTY));
  // version ที่ฟอร์มโหลดมา — ส่งเป็น If-Match (ไม่ใช้ version ล่าสุดจากรายการ ไม่งั้นทับงานคนอื่นเงียบ ๆ)
  const [baseVersion, setBaseVersion] = useState(c?.version ?? 0);
  const [f, setF] = useState<Form>(base);
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const create = useCreateCarrier();
  const update = useUpdateCarrier();
  const m = isNew ? create : update;
  const companies = useCompanyOptions();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const ro = !canWrite;
  const juristic = f.entityType === 'JURISTIC';
  const stale = !!c && c.version !== baseVersion;

  // ---------- ตรวจในฟอร์ม ----------
  const local: Record<string, string> = {};
  if (!f.legalName.trim()) local.legalName = t('car.v.name');
  const tax = digits(f.taxId);
  // แก้รายการเดิมโดยไม่เปลี่ยนประเภท + ช่องว่าง = คงเลขเดิม · เปลี่ยนประเภทต้องกรอกเลขใหม่ (เลขบัตรไม่ย้ายไปเก็บแบบเปิด)
  const typeChanged = !!c && f.entityType !== c.entityType;
  const keepTax = !!c && !typeChanged && tax === '';
  if (!keepTax) {
    if (!tax) local.taxId = t(typeChanged ? 'car.v.taxRetype' : 'car.v.tax');
    else if (!/^\d{13}$/.test(tax)) local.taxId = t('field.thai_tax_id');
    else if (juristic && !tax.startsWith('0')) local.taxId = t('field.juristic_prefix');
  }
  const acc = digits(f.accountNo);
  const hasBank = !!(f.bankCode || acc || f.accountName.trim());
  if (hasBank && canBank) {
    if (!f.bankCode) local['bankAccount.bankCode'] = t('car.v.bank');
    if (!acc && !c?.bankAccount) local['bankAccount.accountNo'] = t('car.v.accountNo');
    else if (acc && !/^\d{10,15}$/.test(acc))
      local['bankAccount.accountNo'] = t('car.v.accountBad');
    if (!f.accountName.trim()) local['bankAccount.accountName'] = t('car.v.accountName');
  }
  if (juristic && f.branchCode.trim() && !/^\d{5}$/.test(f.branchCode.trim()))
    local.branchCode = t('car.v.branch');
  const term = f.paymentTermDays.trim();
  if (!/^\d{1,3}$/.test(term) || Number(term) > 365) local.paymentTermDays = t('car.v.term');
  for (const k of ['maxTripsPerDay', 'priority'] as const) {
    const v = f[k].trim();
    if (v && (!/^\d{1,3}$/.test(v) || Number(v) < 1)) local[k] = t('car.v.range');
  }

  const server = fieldErrors(m.error, t);
  const dup =
    m.error instanceof ApiError && m.error.problem.code === 'duplicate'
      ? (m.error.problem as { existing?: { code: string; legalName: string } }).existing
      : undefined;
  if (dup) server.taxId = t('car.v.dup', { code: dup.code, name: dup.legalName });
  const errs = { ...(tried ? local : {}), ...server };
  const top =
    m.error && !Object.keys(server).length && !isStale(m.error) ? problemText(m.error, t) : null;

  const bankBody = (): CarrierCreate['bankAccount'] =>
    hasBank
      ? {
          bankCode: f.bankCode as BankCode,
          ...(acc ? { accountNo: acc } : {}),
          accountName: f.accountName.trim(),
        }
      : null;
  const body = (): CarrierCreate => ({
    legalName: f.legalName.trim(),
    entityType: f.entityType,
    taxId: tax,
    whtRate: f.whtRate,
    lineContact: f.lineContact.trim() || null,
    ...(canBank ? { bankAccount: bankBody() } : {}),
    ...(juristic ? { branchCode: f.branchCode.trim() || null } : {}),
    address: f.address.trim() ? { line1: f.address.trim() } : null,
    phone: f.phone.trim() || null,
    paymentTermDays: Number(term),
    requirePodToPay: f.requirePodToPay === 'yes',
    parentCarrierId: f.parent?.id ?? null,
    billingCompanyId: f.billingCompanyId || null,
    maxTripsPerDay: intOrNull(f.maxTripsPerDay),
    priority: intOrNull(f.priority),
  });
  /** แก้ไข: ส่งเฉพาะช่องที่เปลี่ยน (สถานะไปทางปุ่มระงับ/เปิดใช้ ไม่อยู่ใน PATCH) */
  const diff = (cur: Carrier): CarrierInput => {
    const a = base;
    const b = body();
    const out: CarrierInput = {};
    if (a.legalName !== f.legalName) out.legalName = b.legalName;
    if (a.entityType !== f.entityType) out.entityType = b.entityType;
    if ((a.taxId !== f.taxId || a.entityType !== f.entityType) && tax) out.taxId = tax;
    if (a.whtRate !== f.whtRate) out.whtRate = b.whtRate!;
    if (a.lineContact !== f.lineContact) out.lineContact = b.lineContact ?? null;
    if (
      canBank &&
      (a.bankCode !== f.bankCode || f.accountNo !== '' || a.accountName !== f.accountName)
    )
      out.bankAccount = b.bankAccount ?? null;
    if (juristic && a.branchCode !== f.branchCode) out.branchCode = b.branchCode ?? null;
    if (a.address !== f.address)
      out.address = f.address.trim() ? { ...(cur.address ?? {}), line1: f.address.trim() } : null;
    if (a.phone !== f.phone) out.phone = b.phone ?? null;
    if (a.paymentTermDays !== f.paymentTermDays) out.paymentTermDays = b.paymentTermDays!;
    if (a.requirePodToPay !== f.requirePodToPay) out.requirePodToPay = b.requirePodToPay!;
    if ((a.parent?.id ?? '') !== (f.parent?.id ?? '')) out.parentCarrierId = f.parent?.id ?? null;
    if (a.billingCompanyId !== f.billingCompanyId)
      out.billingCompanyId = b.billingCompanyId ?? null;
    if (a.maxTripsPerDay !== f.maxTripsPerDay) out.maxTripsPerDay = b.maxTripsPerDay ?? null;
    if (a.priority !== f.priority) out.priority = b.priority ?? null;
    return out;
  };

  const reload = () => {
    if (!c) return;
    const nf = toForm(c);
    setBase(nf);
    setF(nf);
    setBaseVersion(c.version);
    update.reset();
  };
  const dirty = c ? Object.keys(diff(c)).length > 0 : true;
  // ถูกแก้ (เช่น ระงับจากเมนู/ผู้อื่นแก้) ระหว่างที่ฟอร์มยังไม่ได้แก้ → โหลดค่าใหม่เงียบ ๆ
  useEffect(() => {
    if (c && c.version !== baseVersion && !dirty) reload();
  }, [c?.version]);

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current || stale) return;
    const done = {
      onError: () => setIdemKey(crypto.randomUUID()),
      onSettled: () => {
        submitting.current = false;
      },
    };
    if (!c) {
      submitting.current = true;
      create.mutate(
        { idempotencyKey: idemKey, body: body() },
        { ...done, onSuccess: (u) => onSaved(u, true) },
      );
      return;
    }
    const statusChanged = f.status !== c.status;
    const d = diff(c);
    if (!Object.keys(d).length) {
      if (statusChanged) onStatusChange(c);
      return;
    }
    submitting.current = true;
    update.mutate(
      { id: c.id, version: baseVersion, body: d },
      {
        ...done,
        onSuccess: (u) => {
          const nf = { ...toForm(u), status: f.status };
          setBase({ ...nf, status: u.status });
          setF(nf);
          setBaseVersion(u.version);
          onSaved(u, false);
          if (statusChanged) onStatusChange(u);
        },
      },
    );
  };

  const input = (
    k: 'legalName' | 'taxId' | 'lineContact' | 'accountNo' | 'accountName' | 'branchCode' | 'phone',
    extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {},
  ) =>
    function Inp(id: string) {
      return (
        <TextInput
          id={id}
          readOnly={ro}
          aria-invalid={!!errs[k === 'accountNo' || k === 'accountName' ? `bankAccount.${k}` : k]}
          {...extra}
          value={f[k]}
          onChange={(e) => set(k, e.target.value)}
        />
      );
    };
  const numInput = (k: 'paymentTermDays' | 'maxTripsPerDay' | 'priority') =>
    function Num(id: string) {
      return (
        <TextInput
          id={id}
          readOnly={ro}
          inputMode="numeric"
          aria-invalid={!!errs[k]}
          value={f[k]}
          onChange={(e) => set(k, e.target.value.replace(/\D/g, ''))}
        />
      );
    };

  return (
    <Drawer
      open
      onClose={onClose}
      kind={
        c
          ? t('car.kindOf', { k: t(c.entityType === 'JURISTIC' ? 'car.et.J' : 'car.et.I') })
          : t('car.new.kind')
      }
      title={c ? c.legalName : t('car.new.title')}
      badge={<CarrierBadge c={c} t={t} />}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite && c
        ? {
            menu: [
              {
                label: t(c.status === 'active' ? 'car.menu.off' : 'car.menu.on'),
                icon: c.status === 'active' ? 'pause' : 'play',
                onClick: () => onStatusChange(c),
              },
              { label: t('car.menu.delete'), icon: 'trash-2', danger: true, onClick: onDelete },
            ],
          }
        : {})}
      tabs={[
        { key: 'sum', label: t('car.tab.sum') },
        { key: 'docs', label: t('car.tab.docs') },
        { key: 'act', label: t('car.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
      footer={
        canWrite && tab === 'sum' ? (
          <DrawerFooterButtons
            primary={{
              label: t('common.save'),
              icon: 'save',
              onClick: submit,
              disabled: m.isPending,
            }}
          />
        ) : undefined
      }
    >
      {(stale || isStale(m.error)) && (
        <div className="tms-alert" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>{t('car.stale')}</span>
          <button type="button" className="tms-textlink" onClick={reload}>
            {t('car.reload')}
          </button>
        </div>
      )}
      {tried && Object.keys(local).length > 0 && (
        <div className="tms-alert">{t('form.incomplete', { n: Object.keys(local).length })}</div>
      )}
      {top && <div className="tms-alert">{top}</div>}
      {tab === 'sum' && (
        <>
          {c && (
            <section className="tms-kv">
              <span className="tms-kv__title">{t('car.sec.info')}</span>
              <div className="tms-kv__grid">
                <Kv k={t('car.k.ot')} v="—" />
                <Kv k={t('car.k.ret')} v="—" />
                <Kv k={t('car.k.veh')} v={t('car.units', { n: c.usage.vehicles })} />
                <Kv k={t('car.k.last5')} v={<Last5 id={c.id} />} />
                <Kv k={t('car.k.code')} v={<span className="tms-num">{c.code}</span>} />
              </div>
            </section>
          )}
          <div className="tms-fgrid">
            <Fld label={t('car.f.name')} span={2} error={errs.legalName}>
              {input('legalName', { maxLength: 200, autoFocus: isNew })}
            </Fld>
            <Fld label={t('car.f.tax')} error={errs.taxId}>
              {input('taxId', {
                inputMode: 'numeric',
                maxLength: 17,
                className: 'tms-num',
                ...(c?.entityType === 'INDIVIDUAL' && c.taxIdLast4
                  ? { placeholder: masked(c.taxIdLast4) }
                  : {}),
              })}
            </Fld>
            <Fld label={t('car.f.kind')} error={errs.entityType}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro}
                  value={f.entityType}
                  onChange={(e) => {
                    const v = e.target.value as EntityType;
                    setF((x) => ({
                      ...x,
                      entityType: v,
                      // เปลี่ยนประเภท = กรอกเลขใหม่ (ไม่ใช้เลขเดิม) · กลับเป็นประเภทเดิม = คืนค่าเดิม
                      taxId: c && v === c.entityType ? base.taxId : '',
                      branchCode: v === 'JURISTIC' ? x.branchCode || '00000' : '',
                    }));
                  }}
                >
                  <option value="INDIVIDUAL">{t('car.et.I')}</option>
                  <option value="JURISTIC">{t('car.et.J')}</option>
                </select>
              )}
            </Fld>
            <Fld label={t('car.f.wht')} error={errs.whtRate}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro}
                  value={f.whtRate}
                  onChange={(e) => set('whtRate', e.target.value as WhtRate)}
                >
                  <option value="1.00">1%</option>
                  <option value="3.00">3%</option>
                </select>
              )}
            </Fld>
            <Fld label={t('car.f.line')} error={errs.lineContact}>
              {input('lineContact', { maxLength: 51, className: 'tms-num' })}
            </Fld>
            <Fld
              label={t('car.f.bank')}
              span={2}
              error={
                errs['bankAccount.bankCode'] ?? errs['bankAccount.accountNo'] ?? errs.bankAccount
              }
              hint={
                !canBank
                  ? t('car.f.bankLocked')
                  : c?.bankAccount
                    ? t('car.f.accountKeep')
                    : undefined
              }
            >
              {(id) => (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <select
                    id={id}
                    className="tms-select"
                    disabled={ro || !canBank}
                    aria-label={t('car.f.bankName')}
                    aria-invalid={!!errs['bankAccount.bankCode']}
                    value={f.bankCode}
                    onChange={(e) => set('bankCode', e.target.value as BankCode | '')}
                  >
                    <option value="">{t('car.f.bankPick')}</option>
                    {BANK_CODES.map((b) => (
                      <option key={b} value={b}>
                        {bankName(t, b)}
                      </option>
                    ))}
                  </select>
                  {input('accountNo', {
                    inputMode: 'numeric',
                    maxLength: 20,
                    className: 'tms-num',
                    'aria-label': t('car.f.accountNo'),
                    readOnly: ro || !canBank,
                    placeholder: c?.bankAccount
                      ? masked(c.bankAccount.last4)
                      : t('car.f.accountNoPh'),
                  })(`${id}-no`)}
                </div>
              )}
            </Fld>
            <Fld label={t('car.f.accountName')} span={2} error={errs['bankAccount.accountName']}>
              {input('accountName', { maxLength: 200, readOnly: ro || !canBank })}
            </Fld>
            <Fld label={t('car.f.status')}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro || isNew}
                  value={f.status}
                  onChange={(e) => set('status', e.target.value as Carrier['status'])}
                >
                  <option value="active">{t('car.st.active')}</option>
                  <option value="inactive">{t('car.st.inactive')}</option>
                </select>
              )}
            </Fld>
          </div>
          <section className="tms-kv" style={{ borderBottom: 0, paddingBottom: 0 }}>
            <span className="tms-kv__title">{t('car.sec.extra')}</span>
          </section>
          <div className="tms-fgrid">
            {juristic && (
              <Fld label={t('car.f.branch')} error={errs.branchCode}>
                {input('branchCode', { inputMode: 'numeric', maxLength: 5, className: 'tms-num' })}
              </Fld>
            )}
            <Fld label={t('car.f.phone')} error={errs.phone}>
              {input('phone', { maxLength: 25, className: 'tms-num' })}
            </Fld>
            {!juristic && <div />}
            <Fld label={t('car.f.addr')} span={2} error={errs.address ?? errs['address.line1']}>
              {(id) => (
                <textarea
                  id={id}
                  readOnly={ro}
                  className="tms-textarea"
                  rows={2}
                  maxLength={400}
                  value={f.address}
                  onChange={(e) => set('address', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('car.f.term')} error={errs.paymentTermDays}>
              {numInput('paymentTermDays')}
            </Fld>
            <Fld label={t('car.f.billAs')} error={errs.billingCompanyId}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro}
                  value={f.billingCompanyId}
                  onChange={(e) => set('billingCompanyId', e.target.value)}
                >
                  <option value="">{t('car.f.billAsDefault')}</option>
                  {(companies.data?.data ?? []).map((co) => (
                    <option key={co.id} value={co.id}>
                      {co.legalName}
                    </option>
                  ))}
                </select>
              )}
            </Fld>
            <Fld label={t('car.f.parent')} span={2} error={errs.parentCarrierId}>
              {(id) => (
                <RefPicker
                  id={id}
                  value={f.parent}
                  onChange={(v) => set('parent', v)}
                  search={(q) => searchCarriers(q, c?.id)}
                  queryKey={`carriers-parent-${c?.id ?? 'new'}`}
                  placeholder={t('car.f.parentPh')}
                  noResult={t('car.f.parentNone')}
                  clearLabel={t('car.f.parentClear')}
                  invalid={!!errs.parentCarrierId}
                  disabled={ro}
                  style={{ height: 36 }}
                />
              )}
            </Fld>
            <Fld
              label={t('car.f.maxTrips')}
              hint={t('car.f.maxTripsHint')}
              error={errs.maxTripsPerDay}
            >
              {numInput('maxTripsPerDay')}
            </Fld>
            <Fld label={t('car.f.priority')} hint={t('car.f.priorityHint')} error={errs.priority}>
              {numInput('priority')}
            </Fld>
          </div>
          <ChoiceGroup
            label={t('car.f.pod')}
            disabled={ro}
            value={f.requirePodToPay}
            onChange={(v) => set('requirePodToPay', v)}
            options={[
              { value: 'yes', label: t('car.f.podYes') },
              { value: 'no', label: t('car.f.podNo') },
            ]}
          />
        </>
      )}
      {tab === 'docs' && (
        <EmptyState
          icon="file-text"
          title={t('car.docs.empty')}
          description={t('car.docs.emptyD')}
        />
      )}
      {tab === 'act' &&
        (c ? (
          <HistoryTab
            path="/v1/carriers/{id}/history"
            id={c.id}
            fieldLabel={(k) => fieldLabel(t, k)}
            fieldValue={(k, v) => fieldValue(t, k, v)}
          />
        ) : (
          <EmptyState icon="history" title={t('car.act.empty')} description="" />
        ))}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  legalName: 'car.f.name',
  code: 'car.k.code',
  entityType: 'car.f.kind',
  taxId: 'car.f.tax',
  branchCode: 'car.f.branch',
  address: 'car.f.addr',
  whtRate: 'car.f.wht',
  bankAccount: 'car.f.bank',
  paymentTermDays: 'car.f.term',
  requirePodToPay: 'car.f.pod',
  phone: 'car.f.phone',
  lineContact: 'car.f.line',
  parentCarrierId: 'car.f.parent',
  billingCompanyId: 'car.f.billAs',
  maxTripsPerDay: 'car.f.maxTrips',
  priority: 'car.f.priority',
  externalId: 'car.f.ext',
  status: 'car.f.status',
};
function fieldLabel(t: T, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
function fieldValue(t: T, k: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (k === 'entityType') return t(v === 'JURISTIC' ? 'car.et.J' : 'car.et.I');
  if (k === 'status') return t(v === 'active' ? 'car.st.active' : 'car.st.inactive');
  if (k === 'whtRate') return `${Number(v)}%`;
  if (k === 'requirePodToPay') return t(v ? 'car.f.podYes' : 'car.f.podNo');
  if (k === 'address' && typeof v === 'object') return (v as { line1?: string }).line1;
  if (k === 'bankAccount' && typeof v === 'string') {
    const [code, ...rest] = v.split(' ');
    return BANK_CODES.includes(code as BankCode) ? `${bankName(t, code!)} ${rest.join(' ')}` : v;
  }
  return undefined;
}
