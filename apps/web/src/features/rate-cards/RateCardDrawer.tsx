import { Badge, Drawer, DrawerFooterButtons, EmptyState, Icon, statusOf, TextInput } from '@tms/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { RefPicker, type RefOption } from '../master/RefPicker';
import { fieldErrors, isStale, problemText } from '../master/problems';
import { money, modelLabel, rateStatusLabel, rateUnit, routeText, useDateText } from './rateFormat';
import {
  PRICING_MODELS,
  searchCustomers,
  searchRoutes,
  useCreateRate,
  useRateOptions,
  useReviseRate,
  useUpdateRate,
  type PricingModel,
  type RateCard,
  type RateCardCreate,
  type RateCardInput,
} from './useRateCards';

type Tab = 'sum' | 'docs' | 'act';

interface Form {
  party: RefOption | null;
  route: RefOption | null;
  vt: string;
  model: PricingModel | '';
  unit: string;
  price: string;
  min: string;
  ex: string;
  n: string;
  from: string;
  to: string;
  /** serviceItemId → ราคาที่กรอก ('' = ใช้ราคาตั้งต้น) */
  acc: Record<string, string>;
}

const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
/** "1,234.50" → "1234.50" */
const moneyIn = (s: string) => s.replace(/,/g, '').trim();
/** ช่องเงินในฟอร์มแสดงแบบมีคอมมา (ต้นแบบ fmt) */
const moneyOut = (v: string | null | undefined) => (v ? money(v) : '');

const EMPTY: Form = {
  party: null,
  route: null,
  vt: '',
  model: 'PER_TRIP',
  unit: '',
  price: '',
  min: '',
  ex: '',
  n: '2',
  from: '',
  to: '',
  acc: {},
};

function toForm(r: RateCard): Form {
  return {
    party: r.customer ? { id: r.customer.id, label: r.customer.name, sub: r.customer.code } : null,
    route: {
      id: `${r.origin.id}>${r.destination.id}`,
      label: routeText(r),
    },
    vt: r.vehicleType.id,
    model: (PRICING_MODELS as string[]).includes(r.pricingModel)
      ? (r.pricingModel as PricingModel)
      : '',
    unit: r.unit?.id ?? '',
    price: moneyOut(r.sellRate),
    min: moneyOut(r.sellMinCharge),
    ex: moneyOut(r.sellExtraStopRate),
    n: String(r.includedStops),
    from: r.validFrom,
    to: r.validTo ?? '',
    acc: Object.fromEntries(
      r.accessorials.map((a) => [a.serviceItem.id, a.sellPrice ? money(a.sellPrice) : '']),
    ),
  };
}

/** ช่องใน drawer (label 12.5/500 + input — ต้นแบบ this.fld()) */
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

export function RateBadge({ r, t }: { r: Pick<RateCard, 'status'>; t: T }) {
  const label = rateStatusLabel(t, r.status);
  const s = statusOf(label);
  return <Badge label={label} tone={s.tone} icon={s.icon} />;
}

/** ข้อความของ error ช่องที่เฉพาะ rate card (ไม่ใช้ข้อความกลางที่ความหมายต่าง) */
function rateFieldError(t: T, err: unknown): Record<string, string> {
  const out = fieldErrors(err, t);
  if (!(err instanceof ApiError)) return out;
  for (const e of err.problem.errors ?? []) {
    if (e.code === 'not_applicable') out[e.field] = t('rc.v.notApplicable');
    if (/_inactive$/.test(e.code)) out[e.field] = t('rc.v.inactive');
    if (e.code === 'before_start') out[e.field] = t('rc.v.to');
    if (e.code === 'overlap') {
      const c = (err.problem as { conflicts?: { code: string; revision: number }[] }).conflicts;
      out[e.field] = t('rc.v.overlap', {
        c: (c ?? []).map((x) => (x.revision > 1 ? `${x.code} v${x.revision}` : x.code)).join(', '),
      });
    }
    if (e.code === 'draft_exists') {
      const x = (err.problem as { existing?: { code: string; revision: number } }).existing;
      out.top = t('rc.v.draftExists', { c: x?.code ?? '', n: x?.revision ?? '' });
    }
  }
  return out;
}

/**
 * Drawer rate — ต้นแบบ vPanel rate: หัว "Rate ขาขาย · ลูกค้า" + รหัส + ป้าย · แท็บ ข้อมูล rate / เอกสารแนบ / กิจกรรม
 * แท็บข้อมูล = คำเตือนใกล้หมด/หมดอายุ + ฟอร์ม + ตารางค่าบริการเพิ่ม (accessorial)
 * ท้าย: รออนุมัติ (ร่าง) → [คัดลอกเป็น rate ใหม่] [บันทึก] + อนุมัติ · มีผล/หมดอายุ → [คัดลอกเป็น rate ใหม่] + ส่งขออนุมัติ (= ฉบับแก้ไข MD-118)
 * rate ใหม่/คัดลอก (ต้นแบบไม่มีฟอร์มสร้าง — [OPEN spec/12 §3]) ใช้ drawer เดียวกัน ปุ่ม "บันทึกร่าง"
 */
export function RateCardDrawer({
  rate,
  copyFrom,
  canWrite,
  canSeePrice,
  onSaved,
  onApprove,
  onCopy,
  onCancelRate,
  onDelete,
  onClose,
}: {
  /** null = rate ใหม่ */
  rate: RateCard | null;
  /** rate ใหม่ที่คัดลอกจาก rate เดิม */
  copyFrom?: RateCard | null;
  canWrite: boolean;
  canSeePrice: boolean;
  onSaved: (r: RateCard, kind: 'created' | 'saved' | 'revised') => void;
  onApprove: (r: RateCard) => void;
  onCopy: (r: RateCard) => void;
  onCancelRate: (r: RateCard) => void;
  onDelete: (r: RateCard) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const opts = useRateOptions();
  const create = useCreateRate();
  const update = useUpdateRate();
  const revise = useReviseRate();
  const isNew = !rate;
  const isDraft = rate?.status === 'draft' || rate?.status === 'pending_approval';
  const approved = rate?.status === 'active' || rate?.status === 'expired';
  /** ฟอร์มแก้ได้: rate ใหม่ / ร่าง / ที่อนุมัติแล้ว (แก้แล้วส่งขออนุมัติ = ฉบับแก้ไข) */
  const editable = canWrite && rate?.status !== 'retired';
  const keyEditable = canWrite && (isNew || (isDraft && !rate?.parentId));
  const [tab, setTab] = useState<Tab>('sum');
  const initial = (): Form => {
    if (rate) return toForm(rate);
    if (copyFrom) {
      const f = toForm(copyFrom);
      // ต่อจากวันสิ้นสุดเดิม (ต้นแบบ "คัดลอกเป็น rate ใหม่เพื่อต่ออายุ") — ไม่มีวันสิ้นสุด = ให้ผู้ใช้เลือกเอง
      const next = copyFrom.validTo
        ? new Date(Date.parse(`${copyFrom.validTo}T00:00:00Z`) + 86_400_000)
            .toISOString()
            .slice(0, 10)
        : '';
      return { ...f, from: next, to: '' };
    }
    return EMPTY;
  };
  const [base, setBase] = useState<Form>(initial);
  const [baseVersion, setBaseVersion] = useState(rate?.version ?? 0);
  const [f, setF] = useState<Form>(base);
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const stale = !!rate && rate.version !== baseVersion;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const m = isNew ? create : approved ? revise : update;

  const reload = () => {
    if (!rate) return;
    const nf = toForm(rate);
    setBase(nf);
    setF(nf);
    setBaseVersion(rate.version);
    update.reset();
    revise.reset();
  };

  // ---------- ค่าบริการเพิ่ม: catalog ขาขาย/ทั้งคู่ ที่ไม่ใช่ค่าขนส่ง/ค่าจุดเพิ่ม/FSC/% ----------
  const accItems = opts.serviceItems.filter(
    (s) => s.side !== 'BUY' && s.isSurcharge && !s.reserved && s.calcUnit !== 'PERCENT_OF_FREIGHT',
  );
  const extra = (rate ?? copyFrom)?.accessorials.filter(
    (a) => !accItems.some((s) => s.id === a.serviceItem.id),
  );

  // ---------- ตรวจในฟอร์ม ----------
  const local: Record<string, string> = {};
  if (!f.party) local.party = t('rc.v.party');
  if (!f.route) local.route = t('rc.v.route');
  if (!f.vt) local.vt = t('rc.v.vt');
  if (f.model === 'PER_UNIT' && !f.unit) local.unit = t('rc.v.unit');
  if (canSeePrice) {
    if (!moneyIn(f.price)) local.price = t('rc.v.price');
    else if (!MONEY_RE.test(moneyIn(f.price))) local.price = t('rc.v.money');
    if (moneyIn(f.min) && !MONEY_RE.test(moneyIn(f.min))) local.min = t('rc.v.money');
    if (moneyIn(f.ex) && !MONEY_RE.test(moneyIn(f.ex))) local.ex = t('rc.v.money');
    for (const [id, v] of Object.entries(f.acc))
      if (moneyIn(v) && !MONEY_RE.test(moneyIn(v))) local[`acc:${id}`] = t('rc.v.money');
  }
  if (!/^\d{1,2}$/.test(f.n.trim())) local.n = t('rc.v.n');
  if (!f.from) local.from = t('rc.v.from');
  if (f.to && f.from && f.to < f.from) local.to = t('rc.v.to');

  const server = rateFieldError(t, m.error);
  const MAP: Record<string, string> = {
    customerId: 'party',
    originId: 'route',
    destinationId: 'route',
    vehicleTypeId: 'vt',
    pricingModel: 'model',
    unitId: 'unit',
    sellRate: 'price',
    sellMinCharge: 'min',
    sellExtraStopRate: 'ex',
    includedStops: 'n',
    validFrom: 'from',
    validTo: 'to',
  };
  const serverErrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(server)) {
    const acc = /^accessorials\.(\d+)\./.exec(k);
    if (acc) {
      const sent = accBody(f)[Number(acc[1])];
      if (sent) serverErrs[`acc:${sent.serviceItemId}`] = v;
    } else if (k !== 'top') serverErrs[MAP[k] ?? k] = v;
  }
  const errs: Record<string, string> = { ...(tried ? local : {}), ...serverErrs };
  const topErr =
    server.top ??
    (m.error && !Object.keys(serverErrs).length && !isStale(m.error)
      ? problemText(m.error, t)
      : null);

  // ---------- body ----------
  function accBody(x: Form) {
    return Object.entries(x.acc)
      .filter(([, v]) => moneyIn(v) !== '')
      .map(([serviceItemId, v]) => ({ serviceItemId, sellPrice: moneyIn(v) }))
      .sort((a, b) => a.serviceItemId.localeCompare(b.serviceItemId));
  }
  const terms = (x: Form) => ({
    pricingModel: x.model as PricingModel,
    unitId: x.model === 'PER_UNIT' ? x.unit || null : null,
    ...(canSeePrice
      ? {
          sellRate: moneyIn(x.price),
          sellMinCharge: moneyIn(x.min) || null,
          sellExtraStopRate: moneyIn(x.ex) || null,
        }
      : {}),
    includedStops: Number(x.n),
    validFrom: x.from,
    validTo: x.to || null,
    ...(canSeePrice ? { accessorials: accBody(x) } : {}),
  });
  const keyBody = (x: Form) => {
    const [originId = '', destinationId = ''] = (x.route?.id ?? '').split('>');
    return { customerId: x.party!.id, originId, destinationId, vehicleTypeId: x.vt };
  };
  /** แก้ไข: เฉพาะช่องที่เปลี่ยน */
  const diff = (a: Form, b: Form, withKey: boolean): RateCardInput => {
    const ta = terms(a) as Record<string, unknown>;
    const tb = terms(b) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(tb))
      if (JSON.stringify(ta[k]) !== JSON.stringify(tb[k])) out[k] = tb[k];
    if (withKey) {
      if (a.party?.id !== b.party?.id) out.customerId = b.party!.id;
      if (a.route?.id !== b.route?.id) {
        const k = keyBody(b);
        out.originId = k.originId;
        out.destinationId = k.destinationId;
      }
      if (a.vt !== b.vt) out.vehicleTypeId = b.vt;
    }
    return out as RateCardInput;
  };
  const changes = rate ? diff(base, f, keyEditable) : {};
  const dirty = Object.keys(changes).length > 0;

  useEffect(() => {
    // รายการถูกแก้ (อนุมัติจากเมนู/ผู้อื่นแก้) ระหว่างที่ฟอร์มยังไม่แก้ → โหลดค่าใหม่เงียบ ๆ
    if (rate && rate.version !== baseVersion && !dirty) reload();
  }, [rate?.version]);

  const done = {
    onError: () => setIdemKey(crypto.randomUUID()),
    onSettled: () => {
      submitting.current = false;
    },
  };
  const valid = () => {
    setTried(true);
    return !Object.keys(local).length && !submitting.current && !stale;
  };
  const afterSave = (u: RateCard) => {
    const nf = toForm(u);
    setBase(nf);
    setF(nf);
    setBaseVersion(u.version);
    setTried(false);
  };

  /** บันทึกร่าง / แก้ร่าง แล้วทำต่อ (อนุมัติ) */
  const save = (then?: (r: RateCard) => void) => {
    if (!valid()) return;
    if (isNew) {
      submitting.current = true;
      return create.mutate(
        {
          idempotencyKey: idemKey,
          body: { side: 'SELL', ...keyBody(f), ...terms(f) } as RateCardCreate,
        },
        { ...done, onSuccess: (r) => onSaved(r, 'created') },
      );
    }
    if (!dirty) return then?.(rate!);
    submitting.current = true;
    update.mutate(
      { id: rate!.id, version: baseVersion, body: changes },
      {
        ...done,
        onSuccess: (u) => {
          afterSave(u);
          if (then) then(u);
          else onSaved(u, 'saved');
        },
      },
    );
  };
  /** ส่งขออนุมัติ = ออกฉบับแก้ไข (ร่าง) ของ rate ที่อนุมัติแล้ว */
  const submitRevision = () => {
    if (!valid() || !dirty || !rate) return;
    submitting.current = true;
    const {
      customerId: _c,
      originId: _o,
      destinationId: _d,
      vehicleTypeId: _v,
      ...body
    } = changes as Record<string, unknown>;
    revise.mutate(
      { id: rate.id, version: baseVersion, body },
      { ...done, onSuccess: (r) => onSaved(r, 'revised') },
    );
  };

  // ---------- หน้าตา ----------
  const ro = !editable;
  const roKey = !keyEditable;
  const priceRo = ro || !canSeePrice;
  const unitText = f.model
    ? rateUnit(t, f.model, opts.units.find((u) => u.id === f.unit)?.name ?? rate?.unit?.name)
    : '';
  const warn =
    rate?.status === 'active' && rate.nearExpiry && rate.validTo
      ? t('rc.warn.soon', { d: dateText(rate.validTo) })
      : rate?.status === 'expired'
        ? t('rc.warn.expired')
        : rate?.status === 'retired'
          ? t('rc.warn.retired')
          : rate && isDraft && rate.parentId
            ? t('rc.warn.revDraft', { c: rate.code })
            : '';
  const title = rate
    ? rate.revision > 1
      ? t('rc.rev', { c: rate.code, n: rate.revision })
      : rate.code
    : t('rc.new');
  const busy = m.isPending;

  let footer: ReactNode;
  if (canWrite && tab === 'sum') {
    const copy = rate ? [{ label: t('rc.btn.copy'), onClick: () => onCopy(rate) }] : [];
    if (isNew)
      footer = (
        <DrawerFooterButtons
          primary={{
            label: t('rc.btn.saveDraft'),
            icon: 'save',
            onClick: () => save(),
            disabled: busy,
          }}
        />
      );
    else if (isDraft)
      footer = (
        <DrawerFooterButtons
          secondary={[
            ...copy,
            ...(dirty ? [{ label: t('rc.btn.save'), onClick: () => save() }] : []),
          ]}
          primary={{
            label: t('rc.btn.approve'),
            icon: 'circle-check',
            onClick: () => save((u) => onApprove(u)),
            disabled: busy || stale,
          }}
        />
      );
    else if (approved)
      footer = (
        <DrawerFooterButtons
          secondary={copy}
          primary={{
            label: t('rc.btn.submit'),
            icon: 'send',
            onClick: submitRevision,
            disabled: busy || !dirty || stale,
          }}
        />
      );
    else footer = <DrawerFooterButtons secondary={copy} />;
  }

  const menu =
    canWrite && rate
      ? [
          ...(isDraft
            ? [
                {
                  label: t('rc.menu.delete'),
                  icon: 'trash-2',
                  danger: true,
                  onClick: () => onDelete(rate),
                },
              ]
            : []),
          ...(rate.status === 'active' && rate.validFrom > new Date().toISOString().slice(0, 10)
            ? [
                {
                  label: t('rc.menu.cancel'),
                  icon: 'ban',
                  danger: true,
                  onClick: () => onCancelRate(rate),
                },
              ]
            : []),
        ]
      : [];

  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('rc.kind')}
      title={title}
      {...(rate ? { badge: <RateBadge r={rate} t={t} /> } : {})}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(menu.length ? { menu } : {})}
      tabs={[
        { key: 'sum', label: t('rc.tab.sum') },
        { key: 'docs', label: t('rc.tab.docs') },
        ...(rate ? [{ key: 'act', label: t('rc.tab.act') }] : []),
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
      footer={footer}
    >
      {(stale || isStale(m.error)) && (
        <div className="tms-alert" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>{t('rc.stale')}</span>
          <button type="button" className="tms-textlink" onClick={reload}>
            {t('rc.reload')}
          </button>
        </div>
      )}
      {tab === 'sum' && tried && Object.keys(local).length > 0 && (
        <div className="tms-alert">{t('form.incomplete', { n: Object.keys(local).length })}</div>
      )}
      {tab === 'sum' && topErr && <div className="tms-alert">{topErr}</div>}
      {tab === 'sum' && (
        <>
          {warn && (
            <div
              role="note"
              style={{
                background: '#FCF0DC',
                borderRadius: 8,
                padding: '10px 14px',
                display: 'flex',
                gap: 8,
              }}
            >
              <Icon
                n="triangle-alert"
                s={16}
                style={{ color: '#8F5500', marginTop: 3, flexShrink: 0 }}
              />
              <span>{warn}</span>
            </div>
          )}
          <div className="tms-fgrid">
            <Fld
              label={t('rc.fld.party')}
              span={2}
              error={errs.party}
              {...(rate && !keyEditable && canWrite && editable
                ? { hint: t('rc.fld.keyLocked') }
                : {})}
            >
              {(id) => (
                <RefPicker
                  id={id}
                  invalid={!!errs.party}
                  disabled={roKey}
                  queryKey="rate-customers"
                  value={f.party}
                  onChange={(v) => {
                    set('party', v);
                    create.reset();
                    update.reset();
                  }}
                  search={searchCustomers}
                  placeholder={t('rc.fld.pick')}
                  noResult={t('table.emptyTitle')}
                />
              )}
            </Fld>
            <Fld label={t('rc.fld.route')} span={2} error={errs.route}>
              {(id) => (
                <RefPicker
                  id={id}
                  invalid={!!errs.route}
                  disabled={roKey}
                  queryKey="rate-routes"
                  value={f.route}
                  onChange={(v) => {
                    set('route', v);
                    create.reset();
                    update.reset();
                  }}
                  search={searchRoutes}
                  placeholder={t('rc.fld.pickRoute')}
                  noResult={t('table.emptyTitle')}
                />
              )}
            </Fld>
            <Fld label={t('rc.fld.vt')} error={errs.vt}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={roKey}
                  aria-invalid={!!errs.vt}
                  value={f.vt}
                  onChange={(e) => set('vt', e.target.value)}
                >
                  {!f.vt && <option value="">{t('rc.fld.pick')}</option>}
                  {opts.vehicleTypes.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                  {rate && !opts.vehicleTypes.some((v) => v.id === rate.vehicleType.id) && (
                    <option value={rate.vehicleType.id}>{rate.vehicleType.name}</option>
                  )}
                </select>
              )}
            </Fld>
            <Fld label={t('rc.fld.f')} error={errs.model}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro}
                  value={f.model}
                  onChange={(e) => set('model', e.target.value as PricingModel)}
                >
                  {!f.model && <option value="">{modelLabel(t, rate?.pricingModel ?? '')}</option>}
                  {PRICING_MODELS.map((x) => (
                    <option key={x} value={x}>
                      {modelLabel(t, x)}
                    </option>
                  ))}
                </select>
              )}
            </Fld>
            {f.model === 'PER_UNIT' && (
              <Fld label={t('rc.fld.unit')} span={2} error={errs.unit}>
                {(id) => (
                  <select
                    id={id}
                    className="tms-select"
                    disabled={ro}
                    aria-invalid={!!errs.unit}
                    value={f.unit}
                    onChange={(e) => set('unit', e.target.value)}
                  >
                    <option value="">{t('rc.fld.pick')}</option>
                    {opts.units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                    {rate?.unit && !opts.units.some((u) => u.id === rate.unit!.id) && (
                      <option value={rate.unit.id}>{rate.unit.name}</option>
                    )}
                  </select>
                )}
              </Fld>
            )}
            <Fld
              label={unitText ? t('rc.fld.price', { u: unitText }) : t('rc.fld.priceAny')}
              error={errs.price}
            >
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={priceRo}
                  inputMode="decimal"
                  aria-invalid={!!errs.price}
                  placeholder={canSeePrice ? '0.00' : t('rc.hidden')}
                  value={f.price}
                  onChange={(e) => set('price', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('rc.fld.min')} error={errs.min}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={priceRo}
                  inputMode="decimal"
                  aria-invalid={!!errs.min}
                  placeholder={canSeePrice ? '0.00' : t('rc.hidden')}
                  value={f.min}
                  onChange={(e) => set('min', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('rc.fld.ex')} error={errs.ex}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={priceRo}
                  inputMode="decimal"
                  aria-invalid={!!errs.ex}
                  placeholder={canSeePrice ? '0.00' : t('rc.hidden')}
                  value={f.ex}
                  onChange={(e) => set('ex', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('rc.fld.n')} error={errs.n}>
              {(id) => (
                <TextInput
                  id={id}
                  readOnly={ro}
                  inputMode="numeric"
                  aria-invalid={!!errs.n}
                  value={f.n}
                  onChange={(e) => set('n', e.target.value.replace(/\D/g, ''))}
                />
              )}
            </Fld>
            <Fld label={t('rc.fld.from')} error={errs.from}>
              {(id) => (
                <input
                  id={id}
                  type="date"
                  min="2000-01-01"
                  max="2100-12-31"
                  className="tms-input"
                  readOnly={ro}
                  aria-invalid={!!errs.from}
                  value={f.from}
                  onChange={(e) => set('from', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('rc.fld.to')} error={errs.to} {...(!f.to ? { hint: t('rc.noEnd') } : {})}>
              {(id) => (
                <input
                  id={id}
                  type="date"
                  min="2000-01-01"
                  max="2100-12-31"
                  className="tms-input"
                  readOnly={ro}
                  aria-invalid={!!errs.to}
                  value={f.to}
                  onChange={(e) => set('to', e.target.value)}
                />
              )}
            </Fld>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('rc.acc.title')}</h3>
            <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1.2fr 130px',
                  background: '#EBEDE8',
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: '#3B424C',
                }}
              >
                <span style={{ padding: '8px 12px' }}>{t('rc.acc.item')}</span>
                <span style={{ padding: '8px 12px' }}>{t('rc.acc.unit')}</span>
                <span style={{ padding: '8px 12px', textAlign: 'right' }}>{t('rc.acc.price')}</span>
              </div>
              {[
                ...accItems.map((s) => ({
                  id: s.id,
                  n: s.name,
                  u:
                    s.calcUnit === 'ACTUAL'
                      ? t('rc.acc.actual')
                      : [t('rc.per', { u: s.unitLabel }), s.condition].filter(Boolean).join(' '),
                  actual: s.calcUnit === 'ACTUAL',
                  def: s.defaultPrice,
                })),
                ...(extra ?? []).map((a) => ({
                  id: a.serviceItem.id,
                  n: a.serviceItem.name,
                  u: t('rc.per', { u: a.serviceItem.unitLabel }),
                  actual: false,
                  def: null as string | null,
                })),
              ].map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1.2fr 130px',
                    alignItems: 'center',
                    borderTop: '1px solid #D9DCD4',
                  }}
                >
                  <span style={{ padding: '8px 12px' }}>{a.n}</span>
                  <span style={{ padding: '8px 12px', color: '#3B424C' }}>{a.u}</span>
                  <span style={{ padding: '6px 8px' }} title={errs[`acc:${a.id}`]}>
                    <input
                      aria-label={a.n}
                      readOnly={priceRo || a.actual}
                      inputMode="decimal"
                      aria-invalid={!!errs[`acc:${a.id}`]}
                      placeholder={
                        a.actual ? t('rc.acc.actual') : a.def && canSeePrice ? money(a.def) : ''
                      }
                      value={f.acc[a.id] ?? ''}
                      onChange={(e) => set('acc', { ...f.acc, [a.id]: e.target.value })}
                      style={{
                        width: '100%',
                        height: 32,
                        padding: '0 8px',
                        border: `1px solid ${errs[`acc:${a.id}`] ? '#B3322A' : '#C9CDC3'}`,
                        borderRadius: 6,
                        fontVariantNumeric: 'tabular-nums',
                        fontSize: 13,
                        textAlign: 'right',
                        boxSizing: 'border-box',
                        font: 'inherit',
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {tab === 'docs' && (
        <EmptyState icon="file-text" title={t('rc.docs.empty')} description={t('rc.docs.emptyD')} />
      )}
      {tab === 'act' && rate && (
        <HistoryTab
          path="/v1/rate-cards/{id}/history"
          id={rate.id}
          fieldLabel={(k) => fieldLabel(t, k)}
          fieldValue={(k, v) => fieldValue(t, k, v)}
        />
      )}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  code: 'rc.f.code',
  revision: 'rc.f.revision',
  customerId: 'rc.fld.party',
  originId: 'rc.col.route',
  destinationId: 'rc.col.route',
  vehicleTypeId: 'rc.fld.vt',
  pricingModel: 'rc.fld.f',
  unitId: 'rc.fld.unit',
  sellRate: 'rc.fld.priceAny',
  sellMinCharge: 'rc.fld.min',
  sellExtraStopRate: 'rc.fld.ex',
  includedStops: 'rc.fld.n',
  accessorials: 'rc.acc.title',
  validFrom: 'rc.fld.from',
  validTo: 'rc.fld.to',
  status: 'rc.f.status',
  notes: 'rc.f.notes',
  externalId: 'rc.f.ext',
};
function fieldLabel(t: T, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
function fieldValue(t: T, k: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (k === 'pricingModel') return modelLabel(t, String(v));
  if (k === 'status')
    return rateStatusLabel(
      t,
      v === 'APPROVED' ? 'active' : v === 'RETIRED' ? 'retired' : ('draft' as const),
    );
  if (k === 'accessorials' && Array.isArray(v)) return String(v.length);
  return undefined;
}
