import { Icon } from '@tms/ui';
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { formatDate, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { toBangkok } from '../features/orders/orderForm';
import { usePrivacyMeta } from './privacyMeta';
import {
  stepViews,
  telHref,
  TRACKING_BADGE,
  useTrackingLookup,
  useTrackingView,
  type TrackingShipment,
  type TrackingStage,
} from './trackingApi';

/* ค่าจากต้นแบบ TMS Tracking.dc.html */
const CARD: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #E5E7EB',
  borderRadius: 10,
  boxShadow: '0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)',
};
const H2: CSSProperties = { margin: '0 0 6px', fontSize: 15, fontWeight: 600 };
const LABEL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#6B7280' };
const NUM: CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const ROW: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 0',
  borderBottom: '1px solid #F3F4F6',
};
const INPUT: CSSProperties = {
  height: 44,
  border: '1px solid #D1D5DB',
  borderRadius: 8,
  padding: '0 12px',
  fontSize: 16,
  fontFamily: 'inherit',
  color: '#111827',
  background: '#FFFFFF',
  width: '100%',
  boxSizing: 'border-box',
};

const hm = (iso: string) => toBangkok(iso).time;
const dayOf = (iso: string) => formatDate(new Date(`${toBangkok(iso).date}T00:00:00`), 'th', 'BE');
const dayOfDate = (d: string) => formatDate(new Date(`${d}T00:00:00`), 'th', 'BE');

/** ต้นแบบสลับ layout ที่ 1024 px */
function useWide() {
  const q = '(min-width: 1024px)';
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(q).matches,
  );
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return !!wide;
}

/**
 * หน้าติดตามของผู้รับ (ST4-T14; docs/04 E2 "Tracking link สาธารณะ", spec/04 §4 EXE-D) — `/t/{token}` ไม่ต้อง login
 * ต้นแบบ `TMS Tracking.dc.html`: หัวแบรนด์บริษัท · การ์ดเลขใบส่งของ + ป้ายสถานะ + stepper 4 ขั้น · การ์ด ETA ·
 * รถและคนขับ · ข้อมูลอ้างอิง · รายการสินค้า · ข้อความติดต่อ
 * ต่างจากต้นแบบ [DECISION spec/12 §3]: ไม่มีแผนที่ (P1 — จอกว้างเป็นคอลัมน์เดียวกลางจอ) · ไม่มีชื่อ/เบอร์คนขับและทะเบียนเต็ม
 * (EXE-061 — ทะเบียนปิด 2 หลัก, ปุ่มโทร = เบอร์บริษัท) · ETA = ช่วงเวลาตามแผน · ไม่มีปุ่ม "ยืนยันรับของ" (ไม่อยู่ใน docs/spec) ·
 * การ์ด "หลักฐานการส่ง" เมื่อบริษัทเปิด · ลิงก์ของลูกค้า = การ์ดค้นหา (เลข DO/PO + เบอร์ 4 ตัวท้าย — EXE-062)
 */
export function TrackingPage() {
  const { t } = useI18n();
  const { token = '' } = useParams();
  const q = useTrackingView(token);
  const find = useTrackingLookup(token);
  const wide = useWide();
  usePrivacyMeta();
  const [ref, setRef] = useState('');
  const [last4, setLast4] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [found, setFound] = useState<TrackingShipment | null>(null);

  useEffect(() => {
    document.title = t('trk.title');
  }, [t]);

  const v = q.data;
  const bad = q.error instanceof ApiError && q.error.problem.status === 404;
  const company = v?.company;
  const shipment = v?.mode === 'SHIPMENT' ? v.shipment : found;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const r = ref.trim();
    if (r.length < 3 || !/^[0-9]{4}$/.test(last4)) {
      setErr(t('trk.search.invalid'));
      return;
    }
    try {
      setFound(await find.mutateAsync({ ref: r, phoneLast4: last4 }));
    } catch (x) {
      const st = x instanceof ApiError ? x.problem.status : 0;
      setErr(
        st === 404
          ? t('trk.search.nf')
          : st === 429
            ? t('trk.search.locked')
            : st === 422
              ? t('trk.search.invalid')
              : t('trk.err'),
      );
    }
  };

  const L = wide
    ? { max: '100%', px: 24, pb: 24, gap: 20 }
    : { max: '480px', px: 16, pb: 32, gap: 12 };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#F4F6FA',
        display: 'flex',
        justifyContent: 'center',
        color: '#111827',
        fontSize: 14,
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: L.max,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: `0 0 ${L.pb}px`,
          minHeight: '100vh',
          boxSizing: 'border-box',
        }}
      >
        <header
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 16px',
            background: '#FFFFFF',
            borderBottom: '1px solid #E5E7EB',
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: '#0B1F3A',
              color: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon n="truck" s={16} />
          </div>
          <span
            data-testid="trk-company"
            style={{
              fontWeight: 600,
              color: '#0B1F3A',
              fontSize: 15,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {company?.name ?? ''}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#6B7280', flexShrink: 0 }}>
            {t('trk.title')}
          </span>
        </header>
        <div
          style={{
            padding: `0 ${L.px}px`,
            display: 'grid',
            gridTemplateColumns: wide ? 'minmax(360px,480px)' : 'minmax(0,1fr)',
            justifyContent: 'center',
            gap: L.gap,
            flex: 1,
            minHeight: 0,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            {q.isLoading && (
              <section style={{ ...CARD, padding: 16, color: '#6B7280' }}>
                {t('trk.loading')}
              </section>
            )}
            {(bad || (q.isError && !bad)) && (
              <section
                role="alert"
                style={{
                  ...CARD,
                  padding: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'center',
                }}
              >
                <span style={{ color: '#6B7280' }}>
                  <Icon n={bad ? 'link-2-off' : 'circle-alert'} s={28} />
                </span>
                <span style={{ fontSize: 16, fontWeight: 600 }}>
                  {bad ? t('trk.bad.title') : t('trk.err')}
                </span>
                {bad && <span style={{ color: '#374151' }}>{t('trk.bad.sub')}</span>}
              </section>
            )}
            {v && !shipment && (
              <form
                onSubmit={submit}
                aria-label={t('trk.title')}
                style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                <span style={{ color: '#374151' }}>{t('trk.search.hint')}</span>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={LABEL}>{t('trk.search.ref')}</span>
                  <input
                    style={INPUT}
                    value={ref}
                    maxLength={50}
                    autoComplete="off"
                    placeholder={t('trk.search.refPh')}
                    onChange={(e) => setRef(e.target.value)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={LABEL}>{t('trk.search.phone')}</span>
                  <input
                    style={{ ...INPUT, ...NUM }}
                    value={last4}
                    inputMode="numeric"
                    maxLength={4}
                    autoComplete="off"
                    placeholder={t('trk.search.phonePh')}
                    onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  />
                </label>
                {err && (
                  <span role="alert" style={{ color: '#B3322A', fontSize: 13 }}>
                    {err}
                  </span>
                )}
                <button
                  type="submit"
                  disabled={find.isPending}
                  style={{
                    height: 48,
                    border: '1px solid #2257C4',
                    borderRadius: 8,
                    background: '#2257C4',
                    color: '#FFFFFF',
                    fontWeight: 600,
                    fontSize: 16,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    fontFamily: 'inherit',
                  }}
                >
                  <Icon n="search" s={18} />
                  {t('trk.search.go')}
                </button>
              </form>
            )}
            {shipment && <Shipment s={shipment} phone={company?.phone ?? null} />}
            {v && (
              <p style={{ margin: '4px 0 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
                {company?.phone ? t('trk.contact', { phone: company.phone }) : t('trk.contactNone')}
              </p>
            )}
            {v?.mode === 'SEARCH' && found && (
              <button
                type="button"
                onClick={() => {
                  setFound(null);
                  setErr(null);
                }}
                style={{
                  alignSelf: 'center',
                  border: 0,
                  background: 'transparent',
                  color: '#2257C4',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {t('trk.search.again')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Shipment({ s, phone }: { s: TrackingShipment; phone: string | null }) {
  const { t } = useI18n();
  const stage = s.status as TrackingStage;
  const B = TRACKING_BADGE[stage];
  const steps = stepViews(s);
  const delivered = stage === 'DELIVERED';

  let etaLabel = t('trk.eta.label');
  let eta: string;
  let etaColor = '#111827';
  let etaSub: string;
  if (delivered) {
    etaLabel = t('trk.done.label');
    etaColor = '#15803D';
    const at = s.deliveredAt ?? s.updatedAt;
    eta = t('trk.eta.one', { t: hm(at) });
    etaSub = s.route.to
      ? t('trk.done.sub', { to: s.route.to, d: dayOf(at) })
      : t('trk.done.subNoTo', { d: dayOf(at) });
  } else if (stage === 'FAILED') {
    etaLabel = t('trk.fail.label');
    etaColor = '#B3322A';
    eta = t('trk.fail.big');
    etaSub = t('trk.fail.sub');
  } else if (stage === 'CANCELLED') {
    etaLabel = t('trk.cancel.label');
    etaColor = '#6B7280';
    eta = t('trk.cancel.big');
    etaSub = t('trk.cancel.sub');
  } else if (s.eta) {
    const a = hm(s.eta.from);
    const b = hm(s.eta.to);
    eta = a === b ? t('trk.eta.one', { t: a }) : t('trk.eta.range', { a, b });
    etaSub = `${t('trk.eta.sub', { d: dayOf(s.eta.from) })} · ${t('trk.eta.updated', { t: hm(s.updatedAt) })}`;
  } else {
    eta = dayOfDate(s.doDate);
    etaSub = `${t('trk.eta.none')} · ${t('trk.eta.updated', { t: hm(s.updatedAt) })}`;
  }

  return (
    <>
      <section
        data-testid="trk-status"
        style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={LABEL}>{t('trk.doNo')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ ...NUM, fontSize: 18, fontWeight: 600, color: '#2257C4' }}>
              {s.doNo}
            </span>
            <span
              data-testid="trk-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                height: 24,
                padding: '0 8px',
                borderRadius: 6,
                background: B.c,
                color: '#FFFFFF',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <Icon n={B.i} s={12} />
              {t(`trk.st.${stage}` as MessageKey)}
            </span>
          </div>
          <span style={{ color: '#374151' }}>{s.customerName}</span>
        </div>
        <ol
          aria-label={t('trk.title')}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4,minmax(0,1fr))',
            margin: 0,
            padding: 0,
            listStyle: 'none',
          }}
        >
          {steps.map((x, i) => (
            <li
              key={x.key}
              aria-current={x.fw === 600 ? 'step' : undefined}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                position: 'relative',
              }}
            >
              <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                <span style={{ flex: 1, height: 2, background: x.lineL }} />
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    border: `2px solid ${x.bd}`,
                    background: x.bg,
                    color: x.fg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    boxSizing: 'border-box',
                  }}
                >
                  <Icon n={x.icon} s={14} />
                </span>
                <span style={{ flex: 1, height: 2, background: x.lineR }} />
              </div>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: x.fw,
                  color: x.lc,
                  textAlign: 'center',
                  lineHeight: 1.35,
                }}
              >
                {t(`trk.st.${x.label}` as MessageKey)}
              </span>
              <span style={{ fontSize: 12, color: '#6B7280' }}>
                {x.at ? hm(x.at) : s.steps[i]?.done ? '' : '—'}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section data-testid="trk-eta" style={{ ...CARD, overflow: 'hidden' }}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={LABEL}>{etaLabel}</span>
          <span
            style={{ ...NUM, fontSize: 28, fontWeight: 600, lineHeight: 1.25, color: etaColor }}
          >
            {eta}
          </span>
          <span style={{ color: '#374151' }}>{etaSub}</span>
        </div>
      </section>

      {s.vehicle && (
        <section
          data-testid="trk-vehicle"
          style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <h2 style={{ ...H2, margin: 0 }}>{t('trk.vehicle')}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: '#E9F0FA',
                color: '#2257C4',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon n="user" s={20} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{s.vehicle.typeName ?? ''}</span>
              {s.vehicle.plateMasked && (
                <span style={{ ...NUM, fontSize: 13, color: '#111827' }}>
                  {s.vehicle.plateMasked}
                </span>
              )}
            </div>
            {phone && (
              <a
                href={telHref(phone)}
                style={{
                  height: 44,
                  minWidth: 44,
                  padding: '0 12px',
                  border: '1px solid #2257C4',
                  borderRadius: 8,
                  color: '#2257C4',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 500,
                  textDecoration: 'none',
                }}
              >
                <Icon n="phone" s={16} />
                <span style={{ ...NUM, fontSize: 13 }}>{phone}</span>
              </a>
            )}
          </div>
          {s.route.from && s.route.to && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 28,
                  padding: '0 10px',
                  borderRadius: 8,
                  background: '#F3F4F6',
                }}
              >
                {s.route.from}
                <Icon n="arrow-right" s={14} style={{ color: '#6B7280' }} />
                {s.route.to}
              </span>
            </div>
          )}
        </section>
      )}

      {s.customerRef && (
        <section
          data-testid="trk-refs"
          style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <h2 style={H2}>{t('trk.refs')}</h2>
          <div style={ROW}>
            <span style={{ color: '#6B7280' }}>{t('trk.doNo')}</span>
            <span style={{ ...NUM, fontWeight: 500 }}>{s.doNo}</span>
          </div>
          <div style={ROW}>
            <span style={{ color: '#6B7280' }}>{t('trk.ref.po')}</span>
            <span style={{ ...NUM, fontWeight: 500, textAlign: 'right' }}>{s.customerRef}</span>
          </div>
        </section>
      )}

      <section
        data-testid="trk-items"
        style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <h2 style={H2}>{t('trk.items')}</h2>
        {s.items.map((it, i) => (
          <div key={i} style={{ ...ROW, padding: '10px 0' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span>{it.description}</span>
              {it.qtyDelivered != null && it.qtyDelivered !== it.qty && (
                <span style={{ fontSize: 13, color: '#6B7280' }}>
                  {t('trk.item.delivered', { q: it.qtyDelivered, u: it.unit })}
                </span>
              )}
            </div>
            <span style={{ ...NUM, whiteSpace: 'nowrap' }}>
              {it.qty} {it.unit}
            </span>
          </div>
        ))}
      </section>

      {s.pod && (
        <section
          data-testid="trk-pod"
          style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <h2 style={{ ...H2, margin: 0 }}>{t('trk.pod')}</h2>
          {(s.pod.photos.length > 0 || s.pod.signature) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {s.pod.photos.map((p, i) => (
                <a key={p.url} href={p.url} target="_blank" rel="noreferrer noopener">
                  <img
                    src={p.url}
                    alt={t('trk.pod.photo', { n: i + 1 })}
                    referrerPolicy="no-referrer"
                    style={{
                      width: 72,
                      height: 72,
                      objectFit: 'cover',
                      borderRadius: 8,
                      border: '1px solid #E5E7EB',
                      display: 'block',
                    }}
                  />
                </a>
              ))}
              {s.pod.signature && (
                <img
                  src={s.pod.signature.url}
                  alt={t('trk.pod.sig')}
                  referrerPolicy="no-referrer"
                  style={{
                    width: 120,
                    height: 72,
                    objectFit: 'contain',
                    borderRadius: 8,
                    border: '1px solid #E5E7EB',
                    background: '#FFFFFF',
                  }}
                />
              )}
            </div>
          )}
          <span style={{ fontSize: 13, color: '#374151' }}>
            {s.pod.receiverName
              ? t('trk.pod.receiver', { name: s.pod.receiverName, t: hm(s.pod.recordedAt) })
              : t('trk.pod.recorded', { t: hm(s.pod.recordedAt) })}
          </span>
        </section>
      )}
    </>
  );
}
