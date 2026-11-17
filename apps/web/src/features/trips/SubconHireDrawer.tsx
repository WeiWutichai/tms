import { Badge, Drawer, EmptyState, Icon } from '@tms/ui';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useMe } from '../../shell/AppShell';
import { fieldErrors, problemText } from '../master/problems';
import { toBangkok } from '../orders/orderForm';
import { money, useDateText } from '../rate-cards/rateFormat';
import {
  defaultCarrier,
  margin,
  parseCost,
  plainNum,
  reasonRequired,
  SELECTION_REASON_MIN,
  toSatang,
} from './subconHire';
import { useHireOptions, useHireTrip, type TripDetail } from './useTrips';

/** ต้นแบบ TMS v4 (vPanel kind 'sub') — h3 ของส่วน, ช่องกรอก 36px, กล่องตัวเลข */
const H3: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };
const SEC: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const LABEL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const CONTROL: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
};
const BOX: CSSProperties = { border: '1px solid #D9DCD4', borderRadius: 8, padding: '8px 10px' };
const NUM: CSSProperties = { fontVariantNumeric: 'tabular-nums', fontSize: 13 };

function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>{k}</span>
      <span
        style={{ color: '#101418', wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}
      >
        {v}
      </span>
    </div>
  );
}

/**
 * จ้างรถร่วม (ST3-T22; docs/04 D3 "เลือก carrier + ราคาซื้อ" + "บันทึกเหตุผลการเลือก") — ต้นแบบ TMS v4 vPanel kind 'sub'
 * "จ่ายงานรถร่วม": แท็บ "ส่งข้อเสนอ" (ข้อมูล · ผู้รับเหมา + ตรงเวลา/ตีกลับ/ราคา 5 ครั้งล่าสุด · ราคาและกำไร) และ "ใบสั่งงาน"
 * (ตัวอย่างที่ผู้รับเหมาเห็น — ไม่มีราคาขาย) · footer "กำไรต่อเที่ยว" + ปุ่มหลัก
 * ต่างจากต้นแบบ [DECISION spec/12 §3]: ช่อง "เหตุผลที่เลือกรายนี้" เมื่อไม่ใช่ราคาถูกสุด (เกณฑ์ตรวจรับ) · ไม่มี "เปรียบเทียบตัวเลือกรถ"
 * (เสนอรถ — นอกเฟส 0) และ "ลำดับส่งต่อ (cascade)" (P1) · ตรงเวลา/ตีกลับ = "—" (ยังไม่มีข้อมูลจนกว่าจะมีเที่ยวจบ ST4)
 * · ปุ่มหลัก "ส่งข้อเสนอ" (spec/03 §8) แทน "ส่งผ่าน LINE" และไม่มี "คัดลอกลิงก์"/แท็บกิจกรรม จนกว่าจะมีลิงก์รับงาน (ST3-T23)
 */
export function SubconHireDrawer({
  trip,
  onDone,
  onClose,
  replace = false,
  change = null,
}: {
  trip: TripDetail;
  onDone: (message: string) => void;
  onClose: () => void;
  /**
   * ST3-T24 "ส่งรายถัดไป" ระหว่างรอตอบ (เที่ยว OFFERED ที่ครบเวลาตอบ N ชม.): ส่ง `replaceOffer` — API ยกเลิกข้อเสนอเดิม
   * แล้วจ้างรายนี้ในคำขอเดียว · รายเริ่มต้น = รายถัดไปที่ถูกสุด (รายที่ไม่ตอบรับไม่นับเป็นถูกสุด)
   */
  replace?: boolean;
  /**
   * ST3-T25 เปลี่ยนผู้รับเหมา: เหตุผลที่ผู้ใช้กรอกใน ReasonDialog (≥ 10 ตัว) — ส่ง `changeReason` แทน `replaceOffer`:
   * API ยกเลิกการจ้างที่ใช้งานอยู่ (รอตอบ/รับงานแล้ว) แล้วจ้างรายนี้ในคำขอเดียว · ตัวเลือกไม่รวมรายเดิม (`?change=true`)
   */
  change?: string | null;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const me = useMe();
  const q = useHireOptions(trip.id, true, !!change);
  const hire = useHireTrip();
  const [tab, setTab] = useState<'sum' | 'prev'>('sum');
  const [pick, setPick] = useState<string | null>(null);
  /** ราคาที่ผู้ใช้พิมพ์ — null = ยังไม่แก้ (ใช้ราคา rate card ของรายที่เลือก) */
  const [price, setPrice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const o = q.data;
  const head = {
    kind: t('sub.kind'),
    title: trip.tripNo,
    badge:
      change && trip.hire?.status === 'ACCEPTED' ? (
        <Badge label={t('ofl.st.ACCEPTED')} tone="ok" icon="circle-check" />
      ) : replace || change ? (
        <Badge label={t('ofl.st.OFFERED')} tone="warn" icon="clock" />
      ) : (
        <Badge label={t('trip.st.PLANNING')} tone="off" icon="calendar" />
      ),
    labels,
  };
  if (!o)
    return (
      <Drawer open onClose={onClose} {...head}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('sub.loadError')}
            description={problemText(q.error, t) ?? ''}
          />
        ) : (
          <span style={{ color: '#59606B' }}>{t('table.loading')}</span>
        )}
      </Drawer>
    );
  if (!o.options.length)
    return (
      <Drawer open onClose={onClose} {...head}>
        <EmptyState icon="handshake" title={t('sub.empty')} description={t('sub.emptyDesc')} />
      </Drawer>
    );

  const cid = pick ?? defaultCarrier(o);
  const opt = o.options.find((x) => x.carrier.id === cid) ?? o.options[0]!;
  const rate = opt.buyRateAmount ?? null;
  const shown = price ?? (rate ? money(rate) : '');
  const cost = parseCost(shown);
  /** ราคาที่ส่ง = ราคา rate card ของรายนี้ (ยังไม่แก้ หรือแก้แล้วเท่าเดิม) */
  const asRate = rate !== null && cost !== null && toSatang(cost) === toSatang(rate);
  const needReason =
    !!opt.blockedReason || !!opt.priorOutcome || reasonRequired(cost, o.buyCheapestAmount);
  const cheapestName =
    o.options.find((x) => x.cheapest)?.carrier.name ?? o.options[0]!.carrier.name;
  const m = margin(o.sellAmount, cost);
  const route = `${o.origin?.name ?? '—'} → ${o.destination?.name ?? '—'}`;
  const km = trip.route.distanceKm;
  const first = trip.stops[0];
  const pickupIso = first?.plannedArrival ?? first?.windowStart ?? null;
  // ใบสั่งงาน: แสดงเฉพาะค่าที่มาจากข้อมูล — หัก ณ ที่จ่าย = ธงที่คัดลอกจาก rate card (ราคาตาม rate เท่านั้น — ราคากรอกเอง
  // ธงว่าง #58 → ไม่แสดง) · เงื่อนไขจ่าย = ข้อมูลผู้รับเหมา (paymentTermDays / requirePodToPay)
  const wht = asRate ? opt.whtRate : null;
  const recent = opt.buyRecentAmounts ?? [];
  const optLabel = (x: (typeof o.options)[number]) =>
    (x.buyRateAmount
      ? t(x.cheapest ? 'sub.optCheapest' : 'sub.opt', {
          n: x.carrier.name,
          p: money(x.buyRateAmount),
        })
      : t('sub.optNoRate', { n: x.carrier.name })) +
    (x.blockedReason ? t('sub.optBlocked') : '') +
    (x.priorOutcome ? t(`sub.optPrior.${x.priorOutcome}` as MessageKey) : '');

  const submit = () => {
    if (hire.isPending) return;
    setErr(null);
    setFe({});
    if (cost === null) {
      setFe({ cost: t('sub.badPrice') });
      return;
    }
    const why = reason.trim();
    if (needReason && [...why].length < SELECTION_REASON_MIN) {
      setFe({ selectionReason: t('sub.reasonShort') });
      return;
    }
    hire.mutate(
      {
        id: trip.id,
        version: trip.version,
        body: {
          carrierId: opt.carrier.id,
          cost,
          ...(why ? { selectionReason: why } : {}),
          ...(o.vehicleTypeId ? { vehicleTypeId: o.vehicleTypeId } : {}),
          ...(change ? { changeReason: change } : replace ? { replaceOffer: true } : {}),
        },
      },
      {
        onSuccess: () => {
          onDone(t(change ? 'sub.toast.changed' : 'sub.toast.offered', { n: opt.carrier.name }));
          onClose();
        },
        onError: (e) => {
          const f = fieldErrors(e, t);
          if (Object.keys(f).length && (f.cost || f.selectionReason)) setFe(f);
          else setErr(Object.values(f)[0] ?? problemText(e, t));
          void q.refetch();
        },
      },
    );
  };

  const wo: [MessageKey, string][] = [
    ['sub.wo.no', trip.tripNo],
    [
      'sub.wo.route',
      km === null
        ? route
        : t('sub.wo.routeKm', {
            a: o.origin?.name ?? '—',
            b: o.destination?.name ?? '—',
            km: Number(km).toLocaleString('th-TH'),
          }),
    ],
    [
      'sub.wo.pickup',
      `${dateText(trip.tripDate)}${pickupIso ? ` ${toBangkok(pickupIso).time}` : ''}`,
    ],
    ['sub.wo.price', cost ? t('sub.wo.priceV', { p: money(cost) }) : '—'],
    [
      'sub.wo.terms',
      [
        ...(wht ? [t('sub.wo.wht', { w: plainNum(wht) })] : []),
        t(opt.carrier.requirePodToPay ? 'sub.wo.payPod' : 'sub.wo.pay', {
          d: opt.carrier.paymentTermDays,
        }),
      ].join(' · '),
    ],
    ['sub.wo.contact', me.data?.user?.name ?? '—'],
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      {...head}
      tabs={[
        { key: 'sum', label: t('sub.tab.sum') },
        { key: 'prev', label: t('sub.tab.prev') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as 'sum' | 'prev')}
      footer={
        <>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>
              {t('sub.foot.profit')}
            </span>
            <span className="tms-num" style={{ fontSize: 20, fontWeight: 600, color: '#101418' }}>
              {m ? t('sub.baht', { p: money(m.profit) }) : '—'}
            </span>
          </div>
          <span style={{ flex: 1 }} />
          {err && (
            <span className="tms-field-error" role="alert">
              {err}
            </span>
          )}
          <div className="tms-drawer__acts">
            <button
              type="button"
              className="tms-drawer__pri"
              disabled={hire.isPending}
              onClick={submit}
            >
              <Icon n="send" s={16} />
              {t('sub.foot.send')}
            </button>
          </div>
        </>
      }
    >
      {tab === 'sum' ? (
        <>
          <section
            style={{ ...SEC, paddingBottom: 20, borderBottom: '1px solid #E4E6E0' }}
            data-testid="sub-info"
          >
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3B424C' }}>
              {t('drawer.info')}
            </span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                gap: '14px 20px',
              }}
            >
              <Kv k={t('sub.kv.route')} v={route} />
              <Kv k={t('sub.kv.date')} v={dateText(trip.tripDate)} />
              <Kv
                k={t('sub.kv.distance')}
                v={km === null ? '—' : t('sub.km', { n: Number(km).toLocaleString('th-TH') })}
              />
              <Kv k={t('sub.kv.vehicleType')} v={o.vehicleTypeName ?? '—'} />
            </div>
          </section>
          <div style={SEC}>
            <h3 style={H3}>{t('sub.con')}</h3>
            <select
              aria-label={t('sub.con')}
              value={opt.carrier.id}
              onChange={(e) => {
                setPick(e.target.value);
                setPrice(null);
                setFe({});
              }}
              style={CONTROL}
            >
              {o.options.map((x) => (
                <option key={x.carrier.id} value={x.carrier.id}>
                  {optLabel(x)}
                </option>
              ))}
            </select>
            {(replace || change) && (
              <span style={{ fontSize: 13, color: '#8F5500' }} data-testid="sub-replace">
                {t(change ? 'sub.change.note' : 'sub.replaceNote', {
                  n: trip.carrier?.name ?? '—',
                })}
              </span>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 8 }}>
              <div style={BOX}>
                <div style={{ fontWeight: 600 }}>—</div>
                <div style={LABEL}>{t('sub.ot')}</div>
              </div>
              <div style={BOX}>
                <div style={{ fontWeight: 600 }}>—</div>
                <div style={LABEL}>{t('sub.ret')}</div>
              </div>
              <div style={BOX}>
                <div style={NUM} data-testid="sub-last">
                  {recent.length ? recent.map(money).join(' · ') : '—'}
                </div>
                <div style={LABEL}>{t('sub.last')}</div>
              </div>
            </div>
          </div>
          <div style={SEC}>
            <h3 style={H3}>{t('sub.price')}</h3>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={LABEL}>{t('sub.buy')}</span>
              <input
                aria-label={t('sub.buy')}
                value={shown}
                inputMode="decimal"
                onChange={(e) => {
                  setPrice(e.target.value);
                  setFe({});
                }}
                onBlur={() => {
                  if (cost !== null) setPrice(money(cost));
                }}
                style={{ ...CONTROL, ...NUM, textAlign: 'right' }}
              />
              <span style={{ fontSize: 13, color: '#3B424C' }}>
                {asRate
                  ? t('sub.prefill', { n: opt.carrier.name })
                  : rate
                    ? t('sub.manual', { p: money(rate) })
                    : t('sub.prefillNone', { n: opt.carrier.name })}
              </span>
              {opt.blockedReason && (
                <span style={{ fontSize: 13, color: '#8F5500' }} data-testid="sub-blocked">
                  {t('sub.blocked', { r: opt.blockedReason })}
                </span>
              )}
              {fe.cost && <span className="tms-field-error">{fe.cost}</span>}
            </label>
            <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px' }}
              >
                <span>{t('sub.sell')}</span>
                <span style={NUM}>{o.sellAmount ? money(o.sellAmount) : '—'}</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderTop: '1px solid #D9DCD4',
                }}
              >
                <span>{t('sub.minusBuy')}</span>
                <span style={NUM}>{cost ? money(cost) : '—'}</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderTop: '1px solid #D9DCD4',
                  background: '#EEF0EC',
                }}
              >
                <span style={{ fontWeight: 600 }}>{t('sub.profit')}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {m && (
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: m.negative ? '#B3322A' : '#17733F',
                      }}
                    >
                      {m.pct}%
                    </span>
                  )}
                  <span
                    style={{
                      ...NUM,
                      fontSize: 15,
                      fontWeight: 600,
                      color: m ? (m.negative ? '#B3322A' : '#17733F') : '#101418',
                    }}
                  >
                    {m ? money(m.profit) : '—'}
                  </span>
                </span>
              </div>
            </div>
            {needReason && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={LABEL}>{t('sub.reason')}</span>
                <textarea
                  aria-label={t('sub.reason')}
                  value={reason}
                  rows={3}
                  placeholder={t('sub.reasonPh')}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setFe({});
                  }}
                  style={{ ...CONTROL, height: 'auto', padding: '8px 10px', resize: 'vertical' }}
                />
                <span style={{ fontSize: 13, color: '#8F5500' }} data-testid="sub-reason-hint">
                  {opt.blockedReason
                    ? t('sub.reasonBlocked')
                    : opt.priorOutcome
                      ? t('sub.reasonPrior')
                      : o.buyCheapestAmount
                        ? t('sub.reasonNotCheapest', {
                            p: money(o.buyCheapestAmount),
                            n: cheapestName,
                          })
                        : t('sub.reasonNoCompare')}
                </span>
                {fe.selectionReason && (
                  <span className="tms-field-error">{fe.selectionReason}</span>
                )}
              </label>
            )}
          </div>
        </>
      ) : (
        <div
          style={{
            border: '1px solid #E4E6E0',
            borderRadius: 12,
            overflow: 'hidden',
            background: '#F7F8F5',
          }}
          data-testid="sub-wo"
        >
          <div
            style={{
              padding: '12px 14px',
              background: '#F4F5F2',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: '#13213F',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon n="truck" s={14} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 600 }}>
                {t('sub.wo.title', { c: me.data?.tenant.name ?? '' })}
              </span>
              <span style={{ fontSize: 12, color: '#3B424C' }}>{t('sub.wo.sub')}</span>
            </div>
          </div>
          {wo.map(([k, v]) => (
            <div
              key={k}
              style={{
                display: 'grid',
                gridTemplateColumns: '130px minmax(0,1fr)',
                gap: 10,
                padding: '8px 14px',
                borderTop: '1px solid #EBEDE8',
              }}
            >
              <span style={LABEL}>{t(k)}</span>
              <span>{v}</span>
            </div>
          ))}
          <div
            style={{
              padding: '12px 14px',
              borderTop: '1px solid #D9DCD4',
              display: 'flex',
              gap: 8,
            }}
          >
            <span
              style={{
                flex: 1,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 8,
                background: '#17733F',
                color: '#FFFFFF',
                fontWeight: 600,
              }}
            >
              {t('sub.wo.accept')}
            </span>
            <span
              style={{
                flex: 1,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 8,
                border: '1px solid #C9CDC3',
                color: '#3B424C',
                fontWeight: 500,
              }}
            >
              {t('sub.wo.reject')}
            </span>
          </div>
        </div>
      )}
    </Drawer>
  );
}
