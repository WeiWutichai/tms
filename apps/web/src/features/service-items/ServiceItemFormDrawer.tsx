import { FormDrawer, FormField, TextInput } from '@tms/ui';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { fieldErrors, isStale, problemText } from '../master/problems';
import {
  CALC_UNITS,
  SIDES,
  VAT_TYPES,
  WHT_RATES,
  useCreateServiceItem,
  useUpdateServiceItem,
  type CalcUnit,
  type ServiceItem,
  type ServiceItemCreate,
  type ServiceItemInput,
  type ServiceItemSaved,
  type Side,
  type VatType,
  type WhtRate,
} from './useServiceItems';

interface Form {
  name: string;
  u: CalcUnit;
  p: string;
  fb: string;
  cond: string;
  vat: VatType;
  wht: WhtRate;
  side: Side;
}

/**
 * ค่าเริ่มต้นตามต้นแบบ cfAx(): หน่วยคิด ต่อเที่ยว, VAT 7%
 * หัก ณ ที่จ่าย: ต้นแบบตั้ง 1% แต่ VAT 7% + 1% ขัดกฎ (ค่าบริการหัก 3% — research §3.1) → 3% [OPEN spec/12 §3]
 */
const EMPTY: Form = {
  name: '',
  u: 'PER_TRIP',
  p: '',
  fb: '',
  cond: '',
  vat: 'VAT_7',
  wht: '3.00',
  side: 'BOTH',
};

function toForm(r: ServiceItem): Form {
  return {
    name: r.name,
    u: r.calcUnit,
    p: r.defaultPrice ?? '',
    fb: r.fuelRefPrice ?? '',
    cond: r.condition ?? '',
    vat: r.vatType,
    wht: r.whtRate,
    side: r.side,
  };
}

/** สไตล์ช่องของฟอร์มต้นแบบ (cfOpen: สูง 40, ขอบ #CDD1C8) */
const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;
/** เงิน numeric(14,2): ตัวเลขไม่ติดลบ ทศนิยม ≤ 2 (คั่นหลักพันได้) → สตริงที่ส่ง API */
const moneyOf = (s: string): string | null => {
  const v = s.replace(/,/g, '').trim();
  return /^\d{1,12}(\.\d{1,2})?$/.test(v) ? v : null;
};

/**
 * "เพิ่มค่าบริการเสริม" (ต้นแบบ TMS v4 cfAx) และ "แก้ไข" (ฟอร์มเดียวกัน — ต้นแบบไม่มีฟอร์มแก้ [OPEN spec/12 §3])
 * ช่องตามต้นแบบ: ชื่อรายการ, หน่วยคิด, ราคา (ซ่อนเมื่อ "ตามจริง"), ราคาน้ำมันอ้างอิง (เฉพาะ % ของค่าขนส่ง), เงื่อนไข, VAT, หัก ณ ที่จ่าย
 * เพิ่มจากต้นแบบ [OPEN spec/12 §3]: VAT 0% (ZERO_RATED — docs/01), "ใช้กับ" ขาย/ซื้อ/ทั้งคู่ (backlog ST2-T11)
 * แก้รายการที่ยังไม่มีราคาตั้งต้น (ค่าขนส่ง/FSC ของชุดเริ่มต้น) เว้นราคาว่างได้
 */
export function ServiceItemFormDrawer({
  open,
  item,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** มีค่า = แก้ไข */
  item?: ServiceItem | null;
  onClose: () => void;
  onSaved: (r: ServiceItemSaved, created: boolean) => void;
}) {
  const { t } = useI18n();
  const editing = !!item;
  const create = useCreateServiceItem();
  const update = useUpdateServiceItem();
  const m = editing ? update : create;
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  // ล้างฟอร์มตั้งแต่ render แรกที่เปิด (ไม่รอ effect) — กันค่าเก่าค้างแล้วถูกล้างทับสิ่งที่เพิ่งพิมพ์
  const openKey = open ? (item?.id ?? 'new') : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (openKey !== shownFor) {
    setShownFor(openKey);
    if (openKey !== null) {
      setF(item ? toForm(item) : EMPTY);
      setTried(false);
    }
  }
  useEffect(() => {
    if (open) {
      setF(item ? toForm(item) : EMPTY);
      setTried(false);
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      create.reset();
      update.reset();
    }
  }, [open, item?.id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const actual = f.u === 'ACTUAL';
  const percent = f.u === 'PERCENT_OF_FREIGHT';
  // รายการเดิมที่ไม่มีราคาตั้งต้น (ราคาจาก rate card) แก้แล้วเว้นว่างได้
  const priceOptional = editing && item?.defaultPrice === null;
  const fuelOptional = editing && item?.fuelRefPrice === null;

  // ---------- ตรวจในฟอร์ม (ช่องบังคับตามต้นแบบ + numeric(14,2)) ----------
  const local: Record<string, string> = {};
  if (!f.name.trim()) local.name = t('svc.v.name');
  const price = actual || f.p.trim() === '' ? null : moneyOf(f.p);
  if (!actual) {
    if (f.p.trim() === '') {
      if (!priceOptional) local.defaultPrice = t('svc.v.gt0'); // ต้นแบบ: ช่องตัวเลขบังคับว่าง → "กรอกตัวเลขมากกว่า 0"
    } else if (price === null || (percent && Number(price) > 100))
      local.defaultPrice = t(percent ? 'svc.v.pct' : 'svc.v.price');
  }
  const fuel = percent && f.fb.trim() !== '' ? moneyOf(f.fb) : null;
  if (percent) {
    if (f.fb.trim() === '') {
      if (!fuelOptional) local.fuelRefPrice = t('svc.v.gt0');
    } else if (fuel === null) local.fuelRefPrice = t('svc.v.fuel');
    else if (!(Number(fuel) > 0)) local.fuelRefPrice = t('svc.v.gt0');
  }
  const server = fieldErrors(m.error, t);
  // ชื่อซ้ำ → ข้อความตามต้นแบบ cfAx ("มีรายการนี้แล้ว")
  if (
    m.error instanceof ApiError &&
    m.error.problem.errors?.some((e) => e.field === 'name' && e.code === 'duplicate')
  )
    server.name = t('svc.v.dup');
  const errs = { ...(tried ? local : {}), ...server };
  const topErr =
    m.error && !Object.keys(server).length
      ? isStale(m.error)
        ? t('svc.stale')
        : problemText(m.error, t)
      : null;

  const body = (): ServiceItemCreate => ({
    name: f.name.trim(),
    calcUnit: f.u,
    defaultPrice: actual ? null : price,
    fuelRefPrice: percent ? fuel : null,
    condition: f.cond.trim() || null,
    vatType: f.vat,
    whtRate: f.wht,
    side: f.side,
  });
  /** แก้ไข: ส่งเฉพาะช่องที่เปลี่ยน */
  const diff = (r: ServiceItem): ServiceItemInput => {
    const a = toForm(r);
    const b = body();
    const out: ServiceItemInput = {};
    if (a.name !== f.name) out.name = b.name;
    if (a.u !== f.u) out.calcUnit = b.calcUnit;
    if ((b.defaultPrice ?? null) !== r.defaultPrice) out.defaultPrice = b.defaultPrice ?? null;
    if ((b.fuelRefPrice ?? null) !== r.fuelRefPrice) out.fuelRefPrice = b.fuelRefPrice ?? null;
    if ((b.condition ?? null) !== r.condition) out.condition = b.condition ?? null;
    if (a.vat !== f.vat) out.vatType = b.vatType;
    if (a.wht !== f.wht) out.whtRate = b.whtRate;
    if (a.side !== f.side) out.side = b.side!;
    // ตัวเลขเท่ากันแต่เขียนต่างกัน (500 กับ 500.00) ไม่นับว่าเปลี่ยน
    if (out.defaultPrice && r.defaultPrice && Number(out.defaultPrice) === Number(r.defaultPrice))
      delete out.defaultPrice;
    if (out.fuelRefPrice && r.fuelRefPrice && Number(out.fuelRefPrice) === Number(r.fuelRefPrice))
      delete out.fuelRefPrice;
    return out;
  };
  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current) return;
    submitting.current = true;
    const done = {
      onError: () => setIdemKey(crypto.randomUUID()),
      onSettled: () => {
        submitting.current = false;
      },
    };
    if (item) {
      const d = diff(item);
      if (!Object.keys(d).length) {
        submitting.current = false;
        return onClose();
      }
      update.mutate(
        { id: item.id, version: item.version, body: d },
        { ...done, onSuccess: (r) => onSaved(r, false) },
      );
    } else
      create.mutate(
        { idempotencyKey: idemKey, body: body() },
        { ...done, onSuccess: (r) => onSaved(r, true) },
      );
  };

  const input =
    (
      k: 'name' | 'p' | 'fb' | 'cond',
      extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {},
    ) =>
    (p: { id: string; 'aria-invalid': boolean }) => (
      <TextInput
        {...p}
        {...extra}
        value={f[k]}
        onChange={(e) => {
          const v = e.target.value;
          setF((x) => ({ ...x, [k]: v }));
        }}
      />
    );
  const select = <K extends 'u' | 'vat' | 'wht' | 'side'>(
    k: K,
    opts: readonly Form[K][],
    label: (v: Form[K]) => string,
  ) =>
    function Sel(p: { id: string; 'aria-invalid': boolean }) {
      return (
        <select
          {...p}
          className="tms-select"
          style={SEL}
          value={f[k]}
          onChange={(e) => set(k, e.target.value as Form[K])}
        >
          {opts.map((o) => (
            <option key={o} value={o}>
              {label(o)}
            </option>
          ))}
        </select>
      );
    };

  return (
    <FormDrawer
      open={open}
      title={editing ? t('svc.edit.title') : t('svc.create.title')}
      subtitle={editing ? item?.code : t('svc.create.sub')}
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
            disabled={m.isPending}
          >
            {editing ? t('common.save') : t('svc.add')}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          <FormField label={t('svc.f.name')} required span={2} error={errs.name}>
            {input('name', { autoFocus: true, maxLength: 100 })}
          </FormField>
          <FormField label={t('svc.f.u')} required error={errs.calcUnit}>
            {select('u', CALC_UNITS, (v) => t(`svc.u.${v}` as MessageKey))}
          </FormField>
          {!actual && (
            <FormField
              label={t('svc.f.p')}
              required={!priceOptional}
              error={errs.defaultPrice}
              hint={t(percent ? 'svc.f.pHintPct' : 'svc.f.pHintBaht')}
            >
              {input('p', { inputMode: 'decimal', placeholder: '0', style: NUM })}
            </FormField>
          )}
          {percent && (
            <FormField label={t('svc.f.fuel')} required={!fuelOptional} error={errs.fuelRefPrice}>
              {input('fb', { inputMode: 'decimal', placeholder: '0', style: NUM })}
            </FormField>
          )}
          <FormField label={t('svc.f.cond')} span={2} error={errs.condition}>
            {input('cond', { maxLength: 200, placeholder: t('svc.f.condPh') })}
          </FormField>
          <FormField label={t('svc.f.vat')} required error={errs.vatType}>
            {select('vat', VAT_TYPES, (v) => t(`svc.vat.${v}` as MessageKey))}
          </FormField>
          <FormField label={t('svc.f.wht')} required error={errs.whtRate}>
            {select('wht', WHT_RATES, (v) => t(`svc.wht.${v}` as MessageKey))}
          </FormField>
          <FormField label={t('svc.f.side')} required error={errs.side}>
            {select('side', SIDES, (v) => t(`svc.side.${v}` as MessageKey))}
          </FormField>
        </div>
      </section>
    </FormDrawer>
  );
}
