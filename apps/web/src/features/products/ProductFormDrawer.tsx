import { FormDrawer, FormField, FormSection, Icon, TextInput } from '@tms/ui';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { RefPicker, type RefOption } from '../master/RefPicker';
import { fieldErrors, isStale, problemText } from '../master/problems';
import { searchCustomers } from '../sites/useSites';
import { num } from './productFormat';
import {
  HAZARD_CLASSES,
  SPECIALS,
  type HazardClass,
  useCreateProduct,
  useNextProductCode,
  useUnits,
  useUpdateProduct,
  type Product,
  type ProductCreate,
  type ProductInput,
  type Special,
  type Unit,
} from './useProducts';

interface AltRow {
  unitId: string;
  factor: string;
}
interface Form {
  code: string;
  unitId: string;
  name: string;
  w: string;
  vol: string;
  sp: Special[];
  cust: RefOption | null;
  tmin: string;
  tmax: string;
  un: string;
  cls: string;
  alt: AltRow[];
  stack: boolean;
  barcode: string;
}

const EMPTY: Form = {
  code: '',
  unitId: '',
  name: '',
  w: '',
  vol: '',
  sp: [],
  cust: null,
  tmin: '',
  tmax: '',
  un: '',
  cls: '',
  alt: [],
  stack: true,
  barcode: '',
};

const str = (n: number | null) => (n === null ? '' : String(n));
function toForm(p: Product): Form {
  return {
    code: p.code,
    unitId: p.unit.id,
    name: p.name,
    w: str(p.weightPerUnitKg),
    vol: str(p.volumePerUnitCbm),
    sp: SPECIALS.filter((s) =>
      s === 'fragile' ? p.fragile : s === 'hazardous' ? p.hazardous : p.tempControlled,
    ),
    cust: p.customer ? { id: p.customer.id, label: p.customer.name, sub: p.customer.code } : null,
    tmin: str(p.tempMinC),
    tmax: str(p.tempMaxC),
    un: p.unNumber ?? '',
    cls: p.hazardClass ?? '',
    alt: p.altUnits.map((a) => ({ unitId: a.unit.id, factor: String(a.factorToBase) })),
    stack: p.stackable,
    barcode: p.barcode ?? '',
  };
}

/** สไตล์ช่องของฟอร์มต้นแบบ (cfOpen: สูง 40, ขอบ #CDD1C8) */
const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;
const decOf = (s: string, places: number) =>
  new RegExp(`^-?\\d{1,9}(\\.\\d{1,${places}})?$`).test(s.trim()) ? Number(s) : NaN;
const CODE_RE = /^[A-Z0-9][A-Z0-9_\-./]{0,29}$/;

/**
 * "เพิ่มสินค้า" (ต้นแบบ TMS v4 cfProd) และ "แก้ไข" (ฟอร์มเดียวกัน — ต้นแบบไม่มีฟอร์มแก้ [OPEN spec/12 §3])
 * ช่องตามต้นแบบ: รหัสสินค้า (ค่าตั้งต้น = รหัสถัดไป), หน่วย, ชื่อสินค้า, น้ำหนัก/ปริมาตรต่อหน่วย, ประเภทพิเศษ, ลูกค้า
 * ต่างจากต้นแบบตาม spec/02 §3 [OPEN spec/12 §3]: ประเภทพิเศษเลือกได้หลายอย่าง (ต้นแบบเลือกได้อย่างเดียว),
 * อุณหภูมิ = ต่ำสุด/สูงสุดเป็นตัวเลข (ต้นแบบช่องข้อความ "2–8 °C"), เลข UN กับ Class แยกช่อง,
 * น้ำหนักบังคับเฉพาะหน่วยนับ — หน่วยน้ำหนัก/ปริมาตรระบบใส่ค่าตามหน่วยให้
 * "ข้อมูลเพิ่มเติม" (หน่วยแปลง วางซ้อนได้ บาร์โค้ด) ต้นแบบไม่มี [OPEN spec/12 §3]
 */
export function ProductFormDrawer({
  open,
  product,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** มีค่า = แก้ไข */
  product?: Product | null;
  onClose: () => void;
  onSaved: (p: Product, created: boolean) => void;
}) {
  const { t } = useI18n();
  const editing = !!product;
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const m = editing ? update : create;
  const units = useUnits();
  const next = useNextProductCode(open && !editing);
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState(false);
  const [altRecheck, setAltRecheck] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const codeTouched = useRef(false);
  const all = units.data ?? [];
  /** หน่วยที่เลือกได้: ใช้งานอยู่ + หน่วยเดิมของสินค้า (แม้ปิดใช้แล้ว) */
  const choosable = (keep: string[]) =>
    all.filter((u) => u.status === 'active' || keep.includes(u.id));
  const defaultUnit = () =>
    (all.find((u) => u.code === 'BAG' && u.status === 'active') ?? choosable([])[0])?.id ?? '';

  const openKey = open ? (product?.id ?? 'new') : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (openKey !== shownFor) {
    setShownFor(openKey);
    if (openKey !== null) {
      setF(product ? toForm(product) : { ...EMPTY, unitId: defaultUnit() });
      setTried(false);
      setAltRecheck(false);
      codeTouched.current = false;
    }
  }
  useEffect(() => {
    if (open) {
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      create.reset();
      update.reset();
    }
  }, [open, product?.id]);
  // หน่วยโหลดเสร็จทีหลัง → ตั้งหน่วยเริ่มต้น (ต้นแบบ: ถุง)
  useEffect(() => {
    if (open && !product && !f.unitId && all.length) setF((x) => ({ ...x, unitId: defaultUnit() }));
  }, [open, all.length]);
  // รหัสถัดไปจาก API (ต้นแบบเติม P-00NN ให้) — ไม่ทับที่ผู้ใช้พิมพ์เอง
  useEffect(() => {
    if (open && !product && next.data && !codeTouched.current)
      setF((x) => ({ ...x, code: next.data!.code }));
  }, [open, next.data?.code]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  /**
   * เปลี่ยนหน่วยหลัก (review ST2-T10 #2/#3): ล้างค่าที่ได้จากตัวแปลงของหน่วยเดิม (น้ำหนัก/ปริมาตร)
   * และล้างอัตราแปลงทุกแถว — อัตราเทียบหน่วยหลักเดิม ผู้ใช้ต้องกรอกยืนยันใหม่
   */
  const changeUnit = (id: string) => {
    const old = all.find((u) => u.id === f.unitId);
    if (f.alt.length) setAltRecheck(true);
    setF((x) => ({
      ...x,
      unitId: id,
      w: old?.kind === 'WEIGHT' ? '' : x.w,
      vol: old?.kind === 'VOLUME' ? '' : x.vol,
      alt: x.alt.map((a) => ({ ...a, factor: '' })),
    }));
  };
  const unit: Unit | undefined = all.find((u) => u.id === f.unitId);
  const kind = unit?.kind ?? 'COUNT';
  const fixedW = kind === 'WEIGHT' && unit?.toKg != null ? Number(unit.toKg.toFixed(3)) : null;
  const fixedV = kind === 'VOLUME' && unit?.toCbm != null ? Number(unit.toCbm.toFixed(4)) : null;
  const hasSp = (s: Special) => f.sp.includes(s);
  const cold = hasSp('temp');
  const haz = hasSp('hazardous');

  // ---------- ตรวจในฟอร์ม (กฎ spec/02 §3) ----------
  const local: Record<string, string> = {};
  const code = f.code.trim().toUpperCase();
  if (!editing || code !== product?.code) {
    if (!code) local.code = t('prd.v.code');
    else if (!CODE_RE.test(code)) local.code = t('field.matches');
  }
  if (!f.unitId) local.unitId = t('prd.v.unit');
  if (!f.name.trim()) local.name = t('prd.v.name');
  const w = fixedW ?? (f.w.trim() === '' ? null : decOf(f.w, 3));
  if (w === null && kind === 'COUNT') local.weightPerUnitKg = t('prd.v.w');
  else if (w !== null && !(w > 0)) local.weightPerUnitKg = t('prd.v.wBad');
  const vol = fixedV ?? (f.vol.trim() === '' ? null : decOf(f.vol, 4));
  if (vol !== null && !(vol >= 0)) local.volumePerUnitCbm = t('prd.v.vol');
  const tmin = cold ? decOf(f.tmin, 1) : null;
  const tmax = cold ? decOf(f.tmax, 1) : null;
  const tempOk = (v: number | null) => v !== null && !Number.isNaN(v) && v >= -40 && v <= 30;
  if (cold) {
    if (!tempOk(tmin)) local.tempMinC = t('prd.v.temp');
    if (!tempOk(tmax)) local.tempMaxC = t('prd.v.temp');
    else if (tempOk(tmin) && tmin! >= tmax!) local.tempMaxC = t('prd.v.tempRange');
  }
  const un = f.un.replace(/^\s*UN\s*/i, '').trim();
  if (haz) {
    if (!/^\d{4}$/.test(un)) local.unNumber = t('prd.v.un');
    if (!(HAZARD_CLASSES as readonly string[]).includes(f.cls.trim()))
      local.hazardClass = t('prd.v.cls');
  }
  f.alt.forEach((a, i) => {
    if (!a.unitId || a.unitId === f.unitId || f.alt.findIndex((x) => x.unitId === a.unitId) !== i)
      local[`altUnits.${i}.unitId`] = t('prd.v.alt');
    const fac = decOf(a.factor, 6);
    if (!(fac > 0)) local[`altUnits.${i}.factorToBase`] = t('prd.v.altFactor');
  });
  const server = fieldErrors(m.error, t);
  // รหัสซ้ำ → ข้อความตามต้นแบบ cfProd ("รหัสนี้มีแล้ว")
  if (
    m.error instanceof ApiError &&
    m.error.problem.errors?.some((e) => e.field === 'code' && e.code === 'duplicate')
  )
    server.code = t('prd.v.dup');
  const errs = { ...(tried ? local : {}), ...server };
  const topErr =
    m.error && !Object.keys(server).length
      ? isStale(m.error)
        ? t('prd.stale')
        : problemText(m.error, t)
      : null;

  const altBody = () => f.alt.map((a) => ({ unitId: a.unitId, factorToBase: decOf(a.factor, 6) }));
  const body = (): ProductCreate => ({
    code,
    name: f.name.trim(),
    unitId: f.unitId,
    ...(fixedW === null ? { weightPerUnitKg: w } : {}),
    ...(fixedV === null ? { volumePerUnitCbm: vol } : {}),
    fragile: hasSp('fragile'),
    hazardous: haz,
    unNumber: haz ? un : null,
    hazardClass: haz ? (f.cls.trim() as HazardClass) : null,
    tempControlled: cold,
    tempMinC: cold ? tmin : null,
    tempMaxC: cold ? tmax : null,
    customerId: f.cust?.id ?? null,
    altUnits: altBody(),
    stackable: f.stack,
    barcode: f.barcode.trim() || null,
  });
  /** แก้ไข: ส่งเฉพาะช่องที่เปลี่ยน */
  const diff = (p: Product): ProductInput => {
    const a = toForm(p);
    const b = body();
    const out: ProductInput = {};
    if (a.code !== code) out.code = b.code!;
    if (a.name !== f.name) out.name = b.name;
    if (a.unitId !== f.unitId) out.unitId = b.unitId;
    if (fixedW === null && (a.w !== f.w || a.unitId !== f.unitId))
      out.weightPerUnitKg = b.weightPerUnitKg ?? null;
    if (fixedV === null && (a.vol !== f.vol || a.unitId !== f.unitId))
      out.volumePerUnitCbm = b.volumePerUnitCbm ?? null;
    const was = (s: Special) => a.sp.includes(s);
    if (was('fragile') !== hasSp('fragile')) out.fragile = b.fragile!;
    if (was('hazardous') !== haz || (haz && (a.un !== f.un || a.cls !== f.cls))) {
      out.hazardous = haz;
      out.unNumber = b.unNumber ?? null;
      out.hazardClass = b.hazardClass ?? null;
    }
    if (was('temp') !== cold || (cold && (a.tmin !== f.tmin || a.tmax !== f.tmax))) {
      out.tempControlled = cold;
      out.tempMinC = b.tempMinC ?? null;
      out.tempMaxC = b.tempMaxC ?? null;
    }
    if ((a.cust?.id ?? null) !== (f.cust?.id ?? null)) out.customerId = b.customerId ?? null;
    if (JSON.stringify(a.alt) !== JSON.stringify(f.alt)) out.altUnits = b.altUnits!;
    if (a.stack !== f.stack) out.stackable = f.stack;
    if (a.barcode !== f.barcode) out.barcode = b.barcode ?? null;
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
    if (product) {
      const d = diff(product);
      if (!Object.keys(d).length) {
        submitting.current = false;
        return onClose();
      }
      update.mutate(
        { id: product.id, version: product.version, body: d },
        { ...done, onSuccess: (p) => onSaved(p, false) },
      );
    } else
      create.mutate(
        { idempotencyKey: idemKey, body: body() },
        { ...done, onSuccess: (p) => onSaved(p, true) },
      );
  };

  const input =
    (
      k: 'code' | 'name' | 'w' | 'vol' | 'tmin' | 'tmax' | 'un' | 'cls' | 'barcode',
      extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {},
    ) =>
    (p: { id: string; 'aria-invalid': boolean }) => (
      <TextInput
        {...p}
        {...extra}
        value={f[k]}
        onChange={(e) => {
          const v = e.target.value;
          if (k === 'code') codeTouched.current = true;
          setF((x) => ({ ...x, [k]: v }));
        }}
      />
    );
  const toggleSp = (s: Special, on: boolean) =>
    setF((x) => ({
      ...x,
      sp: on ? SPECIALS.filter((y) => y === s || x.sp.includes(y)) : x.sp.filter((y) => y !== s),
    }));
  const unitOptions = choosable([product?.unit.id ?? '', ...f.alt.map((a) => a.unitId)]);
  const fixedHint = (n: number, unitKey: 'prd.kg' | 'prd.cbm') =>
    t('prd.f.fixedHint', { u: unit?.name ?? '', n: t(unitKey, { n: num(n, 4) }) });
  const check = (on: boolean, onChange: (v: boolean) => void, label: string) => (
    <label
      key={label}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
    >
      <input
        type="checkbox"
        className="set-check"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );

  return (
    <FormDrawer
      open={open}
      title={editing ? t('prd.edit.title') : t('prd.create.title')}
      subtitle={editing ? product?.code : t('prd.create.sub')}
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
            {editing ? t('common.save') : t('prd.add')}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          <FormField label={t('prd.f.code')} required error={errs.code}>
            {input('code', { maxLength: 30, autoComplete: 'off' })}
          </FormField>
          <FormField label={t('prd.f.unit')} required error={errs.unitId}>
            {(p) => (
              <select
                {...p}
                className="tms-select"
                style={SEL}
                value={f.unitId}
                onChange={(e) => changeUnit(e.target.value)}
              >
                {!f.unitId && <option value="" disabled />}
                {unitOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('prd.f.name')} required span={2} error={errs.name}>
            {input('name', { autoFocus: true, maxLength: 200 })}
          </FormField>
          <FormField
            label={t('prd.f.w')}
            required={kind === 'COUNT'}
            error={errs.weightPerUnitKg}
            hint={fixedW !== null ? fixedHint(fixedW, 'prd.kg') : undefined}
          >
            {(p) => (
              <TextInput
                {...p}
                inputMode="decimal"
                placeholder="0"
                style={NUM}
                disabled={fixedW !== null}
                value={fixedW !== null ? String(fixedW) : f.w}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, w: v }));
                }}
              />
            )}
          </FormField>
          <FormField
            label={t('prd.f.vol')}
            error={errs.volumePerUnitCbm}
            hint={fixedV !== null ? fixedHint(fixedV, 'prd.cbm') : undefined}
          >
            {(p) => (
              <TextInput
                {...p}
                inputMode="decimal"
                placeholder="0"
                style={NUM}
                disabled={fixedV !== null}
                value={fixedV !== null ? String(fixedV) : f.vol}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, vol: v }));
                }}
              />
            )}
          </FormField>
          <FormField label={t('prd.f.sp')} error={errs.hazardous ?? errs.tempControlled}>
            {(p) => (
              <div
                id={p.id}
                role="group"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px 16px',
                  minHeight: 40,
                  alignItems: 'center',
                }}
              >
                {SPECIALS.map((s) =>
                  check(hasSp(s), (on) => toggleSp(s, on), t(`prd.sp.${s}` as MessageKey)),
                )}
              </div>
            )}
          </FormField>
          <FormField label={t('prd.f.cust')} error={errs.customerId}>
            {(p) => (
              <RefPicker
                id={p.id}
                invalid={p['aria-invalid']}
                queryKey="customers"
                value={f.cust}
                onChange={(v) => set('cust', v)}
                search={searchCustomers}
                clearLabel={t('prd.f.custAll')}
                placeholder={t('table.search')}
                noResult={t('table.emptyTitle')}
              />
            )}
          </FormField>
          {cold && (
            <>
              <FormField label={t('prd.f.tmin')} required error={errs.tempMinC}>
                {input('tmin', { inputMode: 'decimal', placeholder: '2', style: NUM })}
              </FormField>
              <FormField label={t('prd.f.tmax')} required error={errs.tempMaxC}>
                {input('tmax', { inputMode: 'decimal', placeholder: '8', style: NUM })}
              </FormField>
            </>
          )}
          {haz && (
            <>
              <FormField label={t('prd.f.un')} required error={errs.unNumber}>
                {input('un', { placeholder: t('prd.f.unPh'), maxLength: 10 })}
              </FormField>
              <FormField label={t('prd.f.cls')} required error={errs.hazardClass}>
                {input('cls', { placeholder: t('prd.f.clsPh'), maxLength: 3 })}
              </FormField>
            </>
          )}
        </div>
      </section>
      <FormSection title={t('prd.sec.extra')}>
        <FormField
          label={t('prd.f.alt')}
          span={2}
          error={errs.altUnits}
          hint={altRecheck ? t('prd.f.altRecheck') : undefined}
        >
          {(p) => (
            <div id={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {f.alt.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <select
                      className="tms-select"
                      style={SEL}
                      aria-label={t('prd.f.altPick')}
                      aria-invalid={!!errs[`altUnits.${i}.unitId`]}
                      value={a.unitId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setF((x) => ({
                          ...x,
                          alt: x.alt.map((y, j) => (j === i ? { ...y, unitId: v } : y)),
                        }));
                      }}
                    >
                      <option value="" disabled>
                        {t('prd.f.altPick')}
                      </option>
                      {unitOptions
                        .filter((u) => u.id !== f.unitId)
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                    </select>
                    {errs[`altUnits.${i}.unitId`] && (
                      <span className="tms-field-error">{errs[`altUnits.${i}.unitId`]}</span>
                    )}
                  </div>
                  <span style={{ lineHeight: '40px', color: '#3B424C' }}>=</span>
                  <div style={{ width: 120, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <TextInput
                      aria-label={t('prd.f.altEq')}
                      aria-invalid={!!errs[`altUnits.${i}.factorToBase`]}
                      inputMode="decimal"
                      style={NUM}
                      value={a.factor}
                      onChange={(e) => {
                        const v = e.target.value;
                        setF((x) => ({
                          ...x,
                          alt: x.alt.map((y, j) => (j === i ? { ...y, factor: v } : y)),
                        }));
                      }}
                    />
                    {errs[`altUnits.${i}.factorToBase`] && (
                      <span className="tms-field-error">{errs[`altUnits.${i}.factorToBase`]}</span>
                    )}
                  </div>
                  <span style={{ lineHeight: '40px', color: '#3B424C', minWidth: 48 }}>
                    {unit?.name ?? ''}
                  </span>
                  <button
                    type="button"
                    className="tms-iconbtn tms-iconbtn--plain"
                    title={t('prd.f.altRemove')}
                    aria-label={t('prd.f.altRemove')}
                    style={{ marginTop: 4 }}
                    onClick={() => setF((x) => ({ ...x, alt: x.alt.filter((_, j) => j !== i) }))}
                  >
                    <Icon n="trash-2" s={16} />
                  </button>
                </div>
              ))}
              {f.alt.length < 10 && (
                <button
                  type="button"
                  className="tms-linkbtn"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() =>
                    setF((x) => ({ ...x, alt: [...x.alt, { unitId: '', factor: '' }] }))
                  }
                >
                  <Icon n="plus" s={14} /> {t('prd.f.altAdd')}
                </button>
              )}
            </div>
          )}
        </FormField>
        <FormField label={t('prd.f.barcode')} error={errs.barcode}>
          {input('barcode', { maxLength: 50, autoComplete: 'off' })}
        </FormField>
        <FormField label={t('prd.f.stack')} error={errs.stackable}>
          {(p) => (
            <div id={p.id} style={{ display: 'flex', alignItems: 'center', minHeight: 40 }}>
              {check(f.stack, (on) => set('stack', on), t('prd.f.stack'))}
            </div>
          )}
        </FormField>
      </FormSection>
    </FormDrawer>
  );
}
