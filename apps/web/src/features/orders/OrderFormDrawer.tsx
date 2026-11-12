import { FormDrawer, FormField, FormSection, Icon, TextInput } from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { fieldErrors, isStale, problemText } from '../master/problems';
import { RefPicker } from '../master/RefPicker';
import { money, useDateText } from '../rate-cards/rateFormat';
import {
  editableOf,
  emptyLine,
  emptyStop,
  fromOrder,
  toCreateBody,
  toPatch,
  validate,
  type LineForm,
  type Order,
  type OrderForm,
  type StopForm,
  type StopType,
} from './orderForm';
import {
  searchCustomers,
  searchProducts,
  searchSites,
  searchUnits,
  useCreateOrder,
  useUpdateOrder,
  useVehicleTypeOptions,
} from './useOrders';

export type FormMode = 'create' | 'copy' | 'template' | 'edit';

const STOP_TYPES: StopType[] = ['PICKUP', 'DELIVERY', 'RETURN'];
/** สีป้ายจุด (ต้นแบบ drawer SO: รับ #2257C4 · ส่ง #17733F) */
export const STOP_COLOR: Record<string, string> = {
  PICKUP: '#2257C4',
  DELIVERY: '#17733F',
  RETURN: '#8F5500',
};

const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 32,
  padding: '0 12px',
  border: '1px solid #9DB6E3',
  borderRadius: 999,
  background: '#FFFFFF',
  color: '#2257C4',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  alignSelf: 'flex-start',
};
/** การ์ดรายการย่อยในฟอร์ม (ต้นแบบ cfOpen ช่องชนิด party: #F7F8F5, ขอบ #E4E6E0, มุม 12) */
const card: CSSProperties = {
  background: '#F7F8F5',
  border: '1px solid #E4E6E0',
  borderRadius: 12,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

/** ข้อความ error ของช่อง (code จากฟอร์ม/API) */
function msg(t: T, code: string | undefined): string | undefined {
  if (!code) return undefined;
  const k = `ord.v.${code}` as MessageKey;
  return t(k) === k ? code : t(k);
}

/** ช่องวันที่แบบต้นแบบ (ไอคอนปฏิทิน + วันที่ไทย, input date โปร่งใสทับ) */
function DateBox({
  id,
  value,
  onChange,
  invalid,
  disabled,
  name,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  name?: string;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  return (
    <label
      htmlFor={id}
      className="tms-input"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 40,
        padding: '0 12px',
        borderColor: invalid ? '#B3322A' : '#CDD1C8',
        background: disabled ? '#F4F5F2' : '#FFFFFF',
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxSizing: 'border-box',
        width: '100%',
      }}
    >
      <Icon n="calendar" s={16} style={{ color: '#59606B' }} />
      <span
        className="tms-num"
        style={{
          flex: 1,
          color: value ? '#101418' : '#59606B',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value ? dateText(value) : t('ord.f.pickDate')}
      </span>
      <input
        id={id}
        name={name}
        type="date"
        min="1980-01-01"
        max="2100-12-31"
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          width: '100%',
          height: '100%',
          border: 0,
          padding: 0,
          margin: 0,
          cursor: 'inherit',
        }}
      />
    </label>
  );
}

/**
 * ฟอร์มใบสั่งขนส่ง (ST3-T02) — drawer ฟอร์มของต้นแบบ (cfOpen "สร้างใบสั่งขนส่ง" / docForm "คัดลอกเป็นใบใหม่" / "แก้ไข …")
 * ต้นแบบมีแค่ ลูกค้า/เส้นทาง/น้ำหนัก/วันที่ส่ง + ข้อมูลเพิ่มเติม (PO) — ฟอร์มจริงใช้จุดรับ–ส่งจากสถานที่ + สินค้า + ประเภทรถ
 * ตาม spec/03 §2 (ORD-020/021/025) โดยใช้ชิ้นส่วนของต้นแบบ (การ์ดแบบ "คู่กรณี", ปุ่ม "+ เพิ่ม…") [OPEN spec/12 §3]
 * ทุกโหมดเรียก /v1/orders ชุดเดียวกับลูกค้า (API-first): สร้าง/คัดลอก/จากเทมเพลต = POST (+Idempotency-Key) · แก้ = PATCH (+If-Match)
 */
export function OrderFormDrawer({
  mode,
  initial,
  order,
  subtitle,
  canSeePrice,
  onClose,
  onSaved,
  onReload,
}: {
  mode: FormMode;
  initial: OrderForm;
  /** ใบเดิม (แก้ไข) */
  order?: Order | null;
  subtitle?: string;
  canSeePrice: boolean;
  onClose: () => void;
  onSaved: (o: Order, how: 'created' | 'draft' | 'saved') => void;
  /** 412: โหลดใบล่าสุดแล้วเปิดฟอร์มใหม่ */
  onReload?: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const vts = useVehicleTypeOptions();
  const create = useCreateOrder();
  const update = useUpdateOrder();
  const [f, setF] = useState<OrderForm>(initial);
  const [tried, setTried] = useState<null | 'draft' | 'submit'>(null);
  // 1 การเปิดฟอร์ม = 1 Idempotency-Key (กดซ้ำได้ใบเดียว) — ถูกปฏิเสธแล้วแก้ = คำขอใหม่
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const ed = editableOf(mode === 'edit' ? (order ?? null) : null);
  const isDraft = mode !== 'edit' || order?.status === 'draft';
  const err = mode === 'edit' ? update.error : create.error;
  const busy = create.isPending || update.isPending;

  const local = tried ? validate(f, tried === 'draft') : {};
  const server = fieldErrors(err, t);
  const e = (k: string) => server[k] ?? msg(t, local[k]);
  const nLocal = Object.keys(local).length;
  const stale = isStale(err);
  const locked = err instanceof ApiError && err.problem.code === 'order_locked_for_update';
  const top = err && !Object.keys(server).length ? problemText(err, t) : null;

  const set = <K extends keyof OrderForm>(k: K, v: OrderForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const setStop = (i: number, p: Partial<StopForm>) =>
    setF((x) => ({ ...x, stops: x.stops.map((s, j) => (j === i ? { ...s, ...p } : s)) }));
  const setLine = (i: number, p: Partial<LineForm>) =>
    setF((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) }));

  const save = (draft: boolean) => {
    setTried(draft ? 'draft' : 'submit');
    if (Object.keys(validate(f, draft)).length || submitting.current) return;
    submitting.current = true;
    const done = {
      onSettled: () => {
        submitting.current = false;
      },
    };
    if (mode === 'edit' && order) {
      const body = toPatch(order, f, !draft);
      if (!Object.keys(body).length) {
        submitting.current = false;
        return onSaved(order, 'saved');
      }
      update.mutate(
        { id: order.id, version: order.version, body },
        {
          ...done,
          onSuccess: (o) => onSaved(o, 'saved'),
          onError: (x) => {
            // ช่องที่แก้ได้เปลี่ยน (เช่นใบถูกวางแผนระหว่างแก้) → โหลดใบใหม่ให้ปิดช่องตามสถานะล่าสุด
            if (x instanceof ApiError && x.problem.code === 'order_locked_for_update')
              void qc.invalidateQueries({ queryKey: ['orders', 'one', order.id] });
          },
        },
      );
      return;
    }
    create.mutate(
      { idempotencyKey: idemKey, body: toCreateBody(f, draft) },
      {
        ...done,
        onSuccess: (o) => onSaved(o, draft ? 'draft' : 'created'),
        onError: () => setIdemKey(crypto.randomUUID()),
      },
    );
  };

  const title =
    mode === 'edit'
      ? t('ord.form.editT', { no: order?.soNo ?? t('ord.draftNo') })
      : mode === 'copy'
        ? t('ord.form.copyT')
        : t('ord.form.newT');
  const primary =
    mode === 'copy'
      ? t('ord.form.copyOk')
      : mode === 'edit'
        ? isDraft
          ? t('ord.form.saveConfirm')
          : t('ord.form.saveEdit')
        : t('ord.create');
  // คัดลอก = ร่างใหม่ (ต้นแบบ docForm: "สร้าง … (ร่าง) จาก …")
  const primaryDraft = mode === 'copy';
  const vt = vts.data?.data ?? [];

  const section = (title: ReactNode, children: ReactNode) => (
    <FormSection title={title}>{children}</FormSection>
  );

  return (
    <FormDrawer
      open
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      {...(tried && nLocal ? { alert: t('form.incomplete', { n: nLocal }) } : {})}
      onSubmit={() => save(primaryDraft)}
      footer={
        <>
          <button type="button" className="tms-fdrawer__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {isDraft && !primaryDraft && (
            <button
              type="button"
              className="tms-drawer__sec"
              style={{ height: 40, padding: '0 16px' }}
              disabled={busy}
              onClick={() => save(true)}
            >
              {t('ord.form.saveDraft')}
            </button>
          )}
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 40, padding: '0 18px' }}
            disabled={busy || (mode === 'edit' && !ed.any)}
          >
            {primary}
          </button>
        </>
      }
    >
      {stale ? (
        <div className="tms-alert" role="alert">
          <span style={{ flex: 1 }}>{t('problem.precondition_failed')}</span>
          {onReload && (
            <button type="button" className="tms-linkbtn" onClick={onReload}>
              {t('ord.form.reload')}
            </button>
          )}
        </div>
      ) : (
        top && (
          <div className="tms-alert" role="alert">
            {top}
          </div>
        )
      )}
      {mode === 'edit' && order && (!ed.customer || locked) && (
        <div
          role="note"
          style={{
            background: '#EEF0EC',
            borderRadius: 8,
            padding: '10px 14px',
            display: 'flex',
            gap: 8,
          }}
        >
          <Icon n="lock" s={16} style={{ color: '#2257C4', marginTop: 4, flexShrink: 0 }} />
          <span>
            {ed.any
              ? t('ord.form.lockedSome', { st: t(`ord.st.${order.status}` as MessageKey) })
              : t('ord.form.lockedAll', { st: t(`ord.st.${order.status}` as MessageKey) })}
          </span>
        </div>
      )}
      {mode === 'edit' && order?.holdReason && (
        <div
          role="note"
          style={{
            background: '#FCF0DC',
            borderRadius: 8,
            padding: '12px 14px',
            display: 'flex',
            gap: 8,
          }}
        >
          <Icon n="triangle-alert" s={16} style={{ color: '#8F5500', marginTop: 3, flexShrink: 0 }} />
          <span>
            {t('ord.hold', { r: order.holdReason.label })}
            {order.holdReason.note ? ` — ${order.holdReason.note}` : ''}
          </span>
        </div>
      )}

      {section(
        t('ord.sec.main'),
        <>
          <FormField label={t('ord.f.customer')} required span={2} error={e('customer.id')}>
            {(p) => (
              <RefPicker
                id={p.id}
                value={f.customer}
                onChange={(v) => set('customer', v)}
                search={searchCustomers}
                queryKey="so-customer"
                placeholder={f.customerText || t('ord.f.pick')}
                noResult={t('ord.f.noResult')}
                invalid={p['aria-invalid']}
                disabled={!ed.customer}
              />
            )}
          </FormField>
          <FormField label={t('ord.f.vehicleType')} required error={e('vehicleTypeId')}>
            {(p) => (
              <select
                {...p}
                name="vehicleTypeId"
                className="tms-input tms-select"
                value={f.vehicleTypeId}
                disabled={!ed.vehicleTypeId}
                onChange={(x) => set('vehicleTypeId', x.target.value)}
              >
                <option value="">{t('ord.f.pick')}</option>
                {vt.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
                {f.vehicleTypeId && !vt.some((v) => v.id === f.vehicleTypeId) && (
                  <option value={f.vehicleTypeId}>{t('ord.f.inactiveType')}</option>
                )}
              </select>
            )}
          </FormField>
          <FormField label={t('ord.f.date')} required error={e('requestedDate')}>
            {(p) => (
              <DateBox
                id={p.id}
                name="requestedDate"
                value={f.requestedDate}
                invalid={p['aria-invalid']}
                disabled={!ed.requestedDate}
                onChange={(v) => {
                  // จุดที่อยู่วันเดียวกับวันรับของเดิมเลื่อนตาม (กรอกครั้งเดียว)
                  setF((x) => ({
                    ...x,
                    requestedDate: v,
                    stops: x.stops.map((s) =>
                      s.date === x.requestedDate || !s.date ? { ...s, date: v } : s,
                    ),
                  }));
                }}
              />
            )}
          </FormField>
        </>,
      )}

      {section(
        t('ord.sec.stops'),
        <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {e('stops') && <span className="tms-field-error">{e('stops')}</span>}
          {f.stops.map((s, i) => (
            <div key={s.key} style={card} data-testid="so-stop">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, color: STOP_COLOR[s.type] }}>
                  {t('ord.stopN', { n: i + 1, k: t(`ord.stop.${s.type}` as MessageKey) })}
                </span>
                {ed.stops && f.stops.length > 1 && (
                  <button
                    type="button"
                    className="tms-linkbtn"
                    style={{ color: '#B3322A' }}
                    onClick={() => set('stops', f.stops.filter((_, j) => j !== i))}
                  >
                    {t('ord.remove')}
                  </button>
                )}
              </div>
              <div className="tms-fgrid tms-fgrid--create">
                <FormField label={t('ord.f.site')} required span={2} error={e(`stops[${i}].siteId`)}>
                  {(p) => (
                    <RefPicker
                      id={p.id}
                      value={s.site}
                      onChange={(v) => setStop(i, { site: v })}
                      search={searchSites(f.customer?.id ?? null)}
                      queryKey={`so-site-${f.customer?.id ?? ''}`}
                      placeholder={
                        s.siteText ? t('ord.f.unmapped', { x: s.siteText }) : t('ord.f.pickSite')
                      }
                      noResult={t('ord.f.noSite')}
                      invalid={p['aria-invalid']}
                      disabled={!ed.stops}
                    />
                  )}
                </FormField>
                <FormField label={t('ord.f.stopType')}>
                  {(p) => (
                    <select
                      {...p}
                      className="tms-input tms-select"
                      value={s.type}
                      disabled={!ed.stops}
                      onChange={(x) => setStop(i, { type: x.target.value as StopType })}
                    >
                      {STOP_TYPES.map((k) => (
                        <option key={k} value={k}>
                          {t(`ord.stop.${k}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
                <FormField label={t('ord.f.stopDate')} error={e(`stops[${i}].windowStart`)}>
                  {(p) => (
                    <DateBox
                      id={p.id}
                      value={s.date}
                      invalid={p['aria-invalid']}
                      disabled={!ed.window}
                      onChange={(v) => setStop(i, { date: v })}
                    />
                  )}
                </FormField>
                <FormField label={t('ord.f.from')}>
                  {(p) => (
                    <input
                      {...p}
                      type="time"
                      className="tms-input tms-num"
                      value={s.from}
                      disabled={!ed.window}
                      onChange={(x) => setStop(i, { from: x.target.value })}
                    />
                  )}
                </FormField>
                <FormField label={t('ord.f.to')} error={e(`stops[${i}].windowEnd`)}>
                  {(p) => (
                    <input
                      {...p}
                      type="time"
                      className="tms-input tms-num"
                      value={s.to}
                      disabled={!ed.window}
                      onChange={(x) => setStop(i, { to: x.target.value })}
                    />
                  )}
                </FormField>
              </div>
            </div>
          ))}
          {ed.stops && f.stops.length < 50 && (
            <button
              type="button"
              style={pill}
              onClick={() => set('stops', [...f.stops, emptyStop('DELIVERY', f.requestedDate)])}
            >
              <Icon n="map-pin" s={16} />
              {t('ord.addStop')}
            </button>
          )}
        </div>,
      )}

      {section(
        t('ord.sec.items'),
        <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!f.lines.length && <span style={{ color: '#59606B' }}>{t('ord.noItems')}</span>}
          {f.lines.map((l, i) => (
            <div key={l.key} style={card} data-testid="so-line">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>{t('ord.lineN', { n: i + 1 })}</span>
                {ed.lines && (
                  <button
                    type="button"
                    className="tms-linkbtn"
                    style={{ color: '#B3322A' }}
                    onClick={() => set('lines', f.lines.filter((_, j) => j !== i))}
                  >
                    {t('ord.remove')}
                  </button>
                )}
              </div>
              <div className="tms-fgrid tms-fgrid--create">
                <FormField label={t('ord.f.product')} span={2}>
                  {(p) => (
                    <RefPicker
                      id={p.id}
                      value={l.product}
                      onChange={(v) => {
                        const pv = v as (typeof v & { unit?: { id: string; label: string } | null }) | null;
                        setLine(i, {
                          product: v,
                          ...(v && !l.description.trim() ? { description: v.label } : {}),
                          ...(pv?.unit && !l.unit ? { unit: pv.unit } : {}),
                        });
                      }}
                      search={searchProducts}
                      queryKey="so-product"
                      placeholder={t('ord.f.productPh')}
                      clearLabel={t('ord.f.noProduct')}
                      noResult={t('ord.f.noResult')}
                      disabled={!ed.lines}
                    />
                  )}
                </FormField>
                <FormField label={t('ord.f.desc')} required span={2} error={e(`lines[${i}].description`)}>
                  {(p) => (
                    <TextInput
                      {...p}
                      value={l.description}
                      maxLength={500}
                      disabled={!ed.lines}
                      onChange={(x) => setLine(i, { description: x.target.value })}
                    />
                  )}
                </FormField>
                <FormField label={t('ord.f.qty')} required error={e(`lines[${i}].qty`)}>
                  {(p) => (
                    <TextInput
                      {...p}
                      value={l.qty}
                      inputMode="decimal"
                      placeholder="0"
                      disabled={!ed.lines}
                      style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                      onChange={(x) => setLine(i, { qty: x.target.value })}
                    />
                  )}
                </FormField>
                <FormField label={t('ord.f.unit')} required error={e(`lines[${i}].unit`) ?? e(`lines[${i}].unitId`)}>
                  {(p) => (
                    <RefPicker
                      id={p.id}
                      value={l.unit}
                      onChange={(v) => setLine(i, { unit: v })}
                      search={searchUnits}
                      queryKey="so-unit"
                      placeholder={l.unitText || t('ord.f.pick')}
                      noResult={t('ord.f.noResult')}
                      invalid={p['aria-invalid']}
                      disabled={!ed.lines}
                    />
                  )}
                </FormField>
                <FormField label={t('ord.f.weight')} error={e(`lines[${i}].weightKg`)}>
                  {(p) => (
                    <TextInput
                      {...p}
                      value={l.weightKg}
                      inputMode="decimal"
                      placeholder="0"
                      disabled={!ed.lines}
                      style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                      onChange={(x) => setLine(i, { weightKg: x.target.value })}
                    />
                  )}
                </FormField>
              </div>
            </div>
          ))}
          {ed.lines && f.lines.length < 200 && (
            <button type="button" style={pill} onClick={() => set('lines', [...f.lines, emptyLine()])}>
              <Icon n="package-plus" s={16} />
              {t('ord.addLine')}
            </button>
          )}
        </div>,
      )}

      {section(
        t('ord.sec.price'),
        <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {mode === 'edit' && order ? (
            <>
              {order.pricingStatus !== 'AVAILABLE' && (
                <span style={{ display: 'flex', gap: 8, color: '#8F5500' }}>
                  <Icon n="triangle-alert" s={16} style={{ marginTop: 3 }} />
                  {t('ord.noRate')}
                </span>
              )}
              <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#3B424C' }}>{t('ord.subtotal')}</span>
                <span className="tms-num">
                  {canSeePrice && order.sellTotal ? money(order.sellTotal) : '—'}
                </span>
              </span>
            </>
          ) : null}
          <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('ord.priceHint')}</span>
        </div>,
      )}

      {section(
        t('ord.sec.extra'),
        <FormField
          label={t('ord.f.po')}
          error={e('customerRef')}
          hint={t('ord.f.poHint')}
        >
          {(p) => (
            <TextInput
              {...p}
              name="customerRef"
              value={f.customerRef}
              maxLength={50}
              disabled={!ed.customerRef}
              onChange={(x) => set('customerRef', x.target.value)}
            />
          )}
        </FormField>,
      )}
    </FormDrawer>
  );
}

/** ฟอร์มแก้ไขจากใบเดิม */
export const formForEdit = (o: Order) => fromOrder(o);
