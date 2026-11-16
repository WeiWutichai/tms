import { Icon, ReasonDialog, useEscapeLayer } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { fieldErrors, problemText } from '../master/problems';
import { RefPicker, type RefOption } from '../master/RefPicker';
import { useDebounced } from '../master/useCursorList';
import { money } from '../rate-cards/rateFormat';
import type { Order } from './orderForm';
import { RECHECKABLE } from './hold';
import {
  searchCustomers,
  searchStopSites,
  useMapCustomer,
  useMapSite,
  useReevaluate,
  useManualPrice,
  useResolveSourceError,
  type SiteOption,
} from './useOrders';

/**
 * การเคลียร์ใบค้างใน drawer SO (ST3-T07) — ต้นแบบ TMS v4 vPanel 'so':
 * - ยังไม่จับคู่ลูกค้า: กล่องเตือน #FCF0DC "ไม่พบลูกค้า "…" ในข้อมูลหลัก …" + ช่องเลือก + ปุ่ม footer "จับคู่ลูกค้า" (link)
 * - จุดรับ–ส่ง: ลิงก์ "เปลี่ยนสถานที่" + popover ค้นหา "ค้นหาชื่อหรือที่อยู่" / "ไม่พบสถานที่" / "+ เพิ่มสถานที่ใหม่" (soStops)
 * - ราคา: แถวเตือน "ไม่พบ rate card ของลูกค้านี้สำหรับเส้นทางนี้" + pill "กำหนดราคาเอง" → ช่องราคา 140px (sox.noRate/setManual/mp)
 * endpoint: map-customer / map-site (ST3-T06) · reevaluate / resolve-source-error / manual-price (ST3-T07)
 */

/** ข้อความผลหลังเคลียร์: กลับรอจัดรถ / ยังค้างด้วยเหตุอื่น */
export function useClearedText() {
  const { t } = useI18n();
  return (o: Order) => {
    const no = o.soNo ?? t('ord.draftNo');
    if (o.status === 'on_hold' && o.holdReason) {
      const k = `ord.hold.${o.holdReason.code}` as Parameters<typeof t>[0];
      return t('hold.toast.still', { no, r: t(k) === k ? o.holdReason.label : t(k) });
    }
    return t('hold.toast.cleared', { no });
  };
}

/** ข้อความ error ของการเคลียร์ — error ระดับช่อง (422) ก่อน แล้วข้อความ problem */
export function clearErrorText(err: unknown, t: ReturnType<typeof useI18n>['t']) {
  const f = Object.values(fieldErrors(err, t));
  return f[0] ?? problemText(err, t);
}

/** ปุ่ม pill ของต้นแบบ (สูง 32, ขอบ #9DB6E3, ตัวอักษร #2257C4 500) */
export function PillButton({
  icon,
  children,
  onClick,
  disabled,
}: {
  /** ไม่ส่ง = ไม่มีไอคอน (pill "กำหนดราคาเอง" ของต้นแบบ) */
  icon?: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
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
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        whiteSpace: 'nowrap',
        font: 'inherit',
      }}
    >
      {icon && <Icon n={icon} s={16} />}
      {children}
    </button>
  );
}

/** จุดที่เป็นต้นเหตุของเหตุค้างหลัก (`holdReason.field` = `stops[i].site`) — ไม่มี = null */
export function holdStopIndex(o: Pick<Order, 'holdReason'>): number | null {
  const m = /^stops\[(\d+)\]/.exec(o.holdReason?.field ?? '');
  return m ? Number(m[1]) : null;
}

/** ทุกจุดที่เป็นต้นเหตุของเหตุค้างหลัก (`holdReason.fields` — เช่น ทุกจุดที่หาพิกัดไม่ได้) */
export function holdStopIndexes(o: Pick<Order, 'holdReason'>): number[] {
  const f = o.holdReason?.fields?.length
    ? o.holdReason.fields
    : o.holdReason?.field
      ? [o.holdReason.field]
      : [];
  return f.flatMap((x) => {
    const m = /^stops\[(\d+)\]/.exec(x);
    return m ? [Number(m[1])] : [];
  });
}

// ---------- ยังไม่จับคู่ลูกค้า ----------

/** state ของการจับคู่ลูกค้า — กล่องในเนื้อ drawer + ปุ่มใน footer ใช้ร่วมกัน */
export function useCustomerMatch(o: Order | undefined, onDone: (msg: string) => void) {
  const { t } = useI18n();
  const map = useMapCustomer();
  const cleared = useClearedText();
  const [picked, setPicked] = useState<RefOption | null>(null);
  const [conflict, setConflict] = useState<{ value: string } | null>(null);
  const run = (confirm?: string) => {
    if (!o || !picked) return;
    map.mutate(
      {
        id: o.id,
        version: o.version,
        body: {
          customerId: picked.id,
          ...(confirm ? { confirmReassign: true, reason: confirm } : {}),
        },
      },
      {
        onSuccess: (x) => {
          setConflict(null);
          onDone(
            `${t('hold.toast.matched', { no: x.soNo ?? t('ord.draftNo'), c: picked.label })} · ${cleared(x)}`,
          );
        },
        onError: (e) => {
          if (e instanceof ApiError && e.problem.code === 'alias_conflict')
            setConflict({
              value: String((e.problem as { aliasValue?: unknown }).aliasValue ?? ''),
            });
        },
      },
    );
  };
  return {
    picked,
    setPicked,
    run: () => run(),
    busy: map.isPending,
    error: conflict ? null : clearErrorText(map.error, t),
    dialog: (
      <ReasonDialog
        open={!!conflict}
        title={t('hold.match.reassignTitle', { c: picked?.label ?? '' })}
        description={t('hold.match.reassignDesc', { v: conflict?.value ?? '' })}
        label={t('hold.reasonLabel')}
        placeholder={t('hold.reasonPh')}
        okLabel={t('hold.match.reassignOk')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={map.isPending}
        error={
          conflict && map.error && !isAliasConflict(map.error) ? problemText(map.error, t) : null
        }
        onOk={(reason) => run(reason)}
        onClose={() => setConflict(null)}
      />
    ),
  };
}

const isAliasConflict = (e: unknown) =>
  e instanceof ApiError && e.problem.code === 'alias_conflict';

/** กล่องเตือน "ไม่พบลูกค้า …" + ช่องเลือกลูกค้า (ลูกค้าที่ระบบแนะนำขึ้นก่อน) */
export function MatchCustomerBox({
  order,
  value,
  onChange,
  disabled,
}: {
  order: Order;
  value: RefOption | null;
  onChange: (v: RefOption | null) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const raw = order.customer.name ?? order.customer.externalId ?? '';
  const cands: RefOption[] = order.customer.match.candidates.map((c) => ({
    id: c.id,
    label: c.name,
    sub: `${c.code} · ${t('hold.match.suggest', { p: Math.round(c.score * 100) })}`,
  }));
  const search = async (q: string) => {
    const found = await searchCustomers(q);
    if (q) return found;
    const seen = new Set(cands.map((c) => c.id));
    return [...cands, ...found.filter((c) => !seen.has(c.id))];
  };
  return (
    <div
      style={{
        background: '#FCF0DC',
        borderRadius: 8,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <Icon n="triangle-alert" s={16} style={{ color: '#8F5500', marginTop: 3, flexShrink: 0 }} />
        <span>
          {raw && !order.customer.id
            ? t('hold.match.msg', { raw })
            : order.customer.id
              ? t('hold.match.inactive')
              : t('hold.match.msg', { raw: '—' })}
        </span>
      </div>
      <RefPicker
        value={value}
        onChange={onChange}
        search={search}
        queryKey={`hold-cust-${order.id}`}
        placeholder={t('hold.match.ph')}
        noResult={t('hold.match.none')}
        disabled={disabled}
        style={{ background: '#FFFFFF', borderRadius: 8 }}
      />
    </div>
  );
}

// ---------- จุดรับ–ส่ง: เปลี่ยน/เลือกสถานที่ ----------

/** ลิงก์ "เปลี่ยนสถานที่" + popover ค้นหาสถานที่ (ต้นแบบ soStops) → POST map-site */
export function StopSitePicker({
  order,
  sequence,
  onDone,
}: {
  order: Order;
  sequence: number;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  const map = useMapSite();
  const cleared = useClearedText();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim().slice(0, 100), 250);
  const stop = order.stops.find((s) => s.sequence === sequence)!;
  const box = useRef<HTMLDivElement>(null);
  useEscapeLayer(open, () => setOpen(false));
  const list = useQuery({
    queryKey: ['hold-sites', order.id, order.customer.id, dq],
    enabled: open,
    queryFn: () => searchStopSites(order.customer.id, dq),
  });
  const suggested = new Map(stop.match.candidates.map((c) => [c.id, c]));
  const rows: SiteOption[] = list.data ?? [];
  // ที่ระบบแนะนำขึ้นก่อน (ตอนยังไม่พิมพ์ค้น)
  const sorted = dq
    ? rows
    : [...rows.filter((r) => suggested.has(r.id)), ...rows.filter((r) => !suggested.has(r.id))];
  const pick = (s: SiteOption) =>
    map.mutate(
      { id: order.id, version: order.version, sequence, siteId: s.id },
      {
        onSuccess: (x) => {
          setOpen(false);
          onDone(
            `${t('hold.toast.site', { n: sequence, no: x.soNo ?? t('ord.draftNo') })} · ${cleared(x)}`,
          );
        },
      },
    );
  const err = clearErrorText(map.error, t);
  return (
    <div ref={box} style={{ display: 'flex', flexDirection: 'column' }}>
      <button
        type="button"
        className="tms-textlink"
        style={{ alignSelf: 'flex-start', marginTop: 2 }}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {stop.siteId ? t('hold.site.change') : t('hold.site.choose')}
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            border: '1px solid #CDD1C8',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(16,20,24,.12)',
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            background: '#FFFFFF',
          }}
        >
          <input
            className="tms-input"
            value={q}
            maxLength={100}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('hold.site.ph')}
            aria-label={t('hold.site.ph')}
            style={{ height: 36, padding: '0 10px', border: '1px solid #CDD1C8', borderRadius: 8 }}
          />
          <div
            role="listbox"
            style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
          >
            {sorted.map((l) => {
              const on = l.id === stop.siteId;
              const sug = suggested.get(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={map.isPending}
                  onClick={() => pick(l)}
                  className="tms-hold-site"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 1,
                    padding: '8px 10px',
                    border: 0,
                    borderRadius: 6,
                    background: on ? '#E9F0FA' : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: '#101418',
                    font: 'inherit',
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{l.name}</span>
                  <span style={{ fontSize: 12.5, color: '#3B424C' }}>
                    {[l.address?.line1, l.address?.district, l.address?.province]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                  <span style={{ fontSize: 12.5, color: '#59606B' }}>
                    {[
                      l.code,
                      l.openTime && l.closeTime
                        ? t('hold.site.meta', { h: `${l.openTime}–${l.closeTime}` })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {sug && (
                      <span style={{ color: '#2257C4', fontWeight: 600 }}>
                        {' · '}
                        {t('hold.site.suggest')}
                      </span>
                    )}
                    {l.geocodeStatus === 'FAILED' && (
                      <span style={{ color: '#B3322A', fontWeight: 600 }}>
                        {' · '}
                        {t('hold.site.noCoords')}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {list.isSuccess && sorted.length === 0 && (
              <span style={{ padding: '8px 10px', color: '#59606B' }}>{t('hold.site.none')}</span>
            )}
            {list.isLoading && (
              <span style={{ padding: '8px 10px', color: '#59606B' }}>{t('table.loading')}</span>
            )}
          </div>
          {err && (
            <span className="tms-field-error" role="alert">
              {err}
            </span>
          )}
          <button
            type="button"
            className="tms-textlink"
            style={{ alignSelf: 'flex-start', padding: '4px 2px' }}
            onClick={() => nav('/master/locations?new=1')}
          >
            {t('hold.site.add')}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- ปุ่มเคลียร์ในกล่องเหตุค้าง ----------

/**
 * ปุ่มใต้ข้อความ "ค้าง: …" ตามเหตุหลัก (ผู้อื่นเปิดแก้อยู่ — ST3-T08 — ผู้เรียกส่ง canWrite = false):
 * RATE_MISSING → ตรวจอีกครั้ง (เพิ่ม/อนุมัติ rate แล้ว) — "กำหนดราคาเอง" อยู่ในส่วนราคาตามต้นแบบ
 * GEOCODING_ERROR → ปักหมุด (หน้าสถานที่ — ปักแล้วใบพ้นค้างเอง) + ตรวจอีกครั้ง
 * SOURCE_ERROR → แก้ไขใบ + ยืนยันข้อมูลถูกต้อง (เหตุผล) · CUSTOMER/LOCATION_UNMAPPED → ตรวจอีกครั้ง (alias/ข้อมูลหลักที่เพิ่งแก้)
 * เหตุจากการจัดรถ/เวลาส่ง → ข้อความ "เคลียร์ได้เมื่อจัดรถใหม่ที่กระดานวางแผน"
 */
export function HoldActions({
  order,
  canWrite,
  canEdit,
  onEdit,
  onDone,
}: {
  order: Order;
  canWrite: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  const recheck = useReevaluate();
  const resolve = useResolveSourceError();
  const cleared = useClearedText();
  const [confirmSrc, setConfirmSrc] = useState(false);
  const code = order.holdReason?.code ?? '';
  const no = order.soNo ?? t('ord.draftNo');
  const doRecheck = () =>
    recheck.mutate(
      { id: order.id, version: order.version },
      { onSuccess: (x) => onDone(cleared(x)) },
    );
  const btns: ReactNode[] = [];
  if (canWrite && code === 'GEOCODING_ERROR') {
    // ทุกจุดที่หาพิกัดไม่ได้ (review ST3-T07) — หลายจุด = ปุ่มต่อจุด "ปักหมุดสถานที่ · จุดที่ n"
    const idx = holdStopIndexes(order);
    for (const i of idx) {
      const site = order.stops[i]?.siteId;
      if (site)
        btns.push(
          <PillButton
            key={`pin${i}`}
            icon="map-pin"
            onClick={() => nav(`/master/locations?open=${encodeURIComponent(site)}`)}
          >
            {idx.length > 1 ? t('hold.act.pinStop', { n: i + 1 }) : t('hold.act.pin')}
          </PillButton>,
        );
    }
  }
  if (canWrite && code === 'SOURCE_ERROR') {
    if (canEdit)
      btns.push(
        <PillButton key="fix" icon="pencil" onClick={onEdit}>
          {t('hold.source.fix')}
        </PillButton>,
      );
    btns.push(
      <PillButton key="ok" icon="circle-check" onClick={() => setConfirmSrc(true)}>
        {t('hold.source.ok')}
      </PillButton>,
    );
  }
  if (canWrite && RECHECKABLE.includes(code))
    btns.push(
      <PillButton key="re" icon="refresh-cw" onClick={doRecheck} disabled={recheck.isPending}>
        {t('hold.recheck')}
      </PillButton>,
    );
  const planNote = [
    'UNALLOCATED_NO_VEHICLE',
    'CAPACITY_EXCEEDED',
    'VEHICLE_TYPE_INCOMPATIBLE',
    'CARRIER_REJECTED',
    'DELIVERY_WINDOW_EXHAUSTED',
    'RESCHEDULES_EXHAUSTED',
  ].includes(code);
  if (!btns.length && !planNote) return null;
  const err = clearErrorText(recheck.error, t);
  return (
    <>
      {planNote && <span style={{ color: '#3B424C' }}>{t('hold.planNote')}</span>}
      {btns.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{btns}</div>}
      {err && (
        <span className="tms-field-error" role="alert">
          {err}
        </span>
      )}
      <ReasonDialog
        open={confirmSrc}
        title={t('hold.source.title', { no })}
        description={t('hold.source.desc')}
        label={t('hold.reasonLabel')}
        placeholder={t('hold.source.ph')}
        okLabel={t('hold.source.ok')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={resolve.isPending}
        error={problemText(resolve.error, t)}
        onOk={(reason) =>
          resolve.mutate(
            { id: order.id, version: order.version, reason },
            {
              onSuccess: (x) => {
                setConfirmSrc(false);
                onDone(`${t('hold.toast.source', { no })} · ${cleared(x)}`);
              },
            },
          )
        }
        onClose={() => setConfirmSrc(false)}
      />
    </>
  );
}

// ---------- ราคา: กำหนดราคาเอง (ORD-043) ----------

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * ต้นแบบ drawer SO ส่วนราคา (sox.noRate / setManual / mp): แถวเตือนสี #8F5500 "ไม่พบ rate card …" + pill "กำหนดราคาเอง"
 * → แถว "ค่าขนส่ง (กำหนดเอง)" + ช่องราคา 140×34 ชิดขวา · บันทึก = dialog เหตุผล ≥ 10 (กฎ ORD-043 — ต้นแบบไม่มี)
 * `allowed` = orders:write + prices.sell:write + ไม่ติดล็อกผู้อื่น + ก่อนวางแผน (ผู้เรียกตัดสิน)
 */
export function ManualPrice({
  order,
  allowed,
  onDone,
}: {
  order: Order;
  allowed: boolean;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const save = useManualPrice();
  const cleared = useClearedText();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [dlg, setDlg] = useState(false);
  const amount = value.replace(/,/g, '').trim();
  const valid = MONEY.test(amount) && Number(amount) > 0;
  const no = order.soNo ?? t('ord.draftNo');
  const first = order.stops[0]?.siteText;
  const last = order.stops[order.stops.length - 1]?.siteText;
  if (!editing)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#8F5500' }}>
        <Icon n="triangle-alert" s={16} />
        <span style={{ flex: 1 }}>{t('ord.noRate')}</span>
        {allowed && <PillButton onClick={() => setEditing(true)}>{t('ord.mp.btn')}</PillButton>}
      </div>
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '6px 0' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span>{t('ord.mp.line')}</span>
          {first && last && first !== last && (
            <span style={{ fontSize: 12.5, color: '#59606B' }}>{`${first} → ${last}`}</span>
          )}
        </div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          inputMode="decimal"
          autoFocus
          aria-label={t('ord.mp.amount')}
          aria-invalid={touched && !valid}
          className="tms-num"
          style={{
            width: 140,
            height: 34,
            padding: '0 10px',
            border: `1px solid ${touched && !valid ? '#B3322A' : '#CDD1C8'}`,
            borderRadius: 8,
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
            font: 'inherit',
          }}
        />
      </div>
      {touched && !valid && (
        <span className="tms-field-error" role="alert" style={{ alignSelf: 'flex-end' }}>
          {t('ord.mp.invalid')}
        </span>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          className="tms-textlink"
          onClick={() => {
            setEditing(false);
            setValue('');
            setTouched(false);
          }}
        >
          {t('common.cancel')}
        </button>
        <PillButton
          onClick={() => {
            setTouched(true);
            if (valid) setDlg(true);
          }}
          disabled={save.isPending}
        >
          {t('ord.mp.save')}
        </PillButton>
      </div>
      <ReasonDialog
        open={dlg}
        title={t('ord.mp.title', { no })}
        description={t('ord.mp.desc')}
        diff={{
          rows: [
            {
              f: t('ord.mp.field'),
              b: '—',
              a: valid ? money(amount) : '—',
            },
          ],
          labels: [t('ord.dlg.field'), t('ord.dlg.before'), t('ord.dlg.after')],
        }}
        hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
        label={t('hold.reasonLabel')}
        placeholder={t('ord.mp.ph')}
        okLabel={t('ord.mp.save')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={save.isPending}
        error={clearErrorText(save.error, t)}
        onClose={() => {
          setDlg(false);
          save.reset();
        }}
        onOk={(reason) =>
          save.mutate(
            { id: order.id, version: order.version, sellAmount: amount, reason },
            {
              onSuccess: (x) => {
                setDlg(false);
                setEditing(false);
                onDone(`${t('ord.mp.toast', { no })} · ${cleared(x)}`);
              },
            },
          )
        }
      />
    </div>
  );
}
