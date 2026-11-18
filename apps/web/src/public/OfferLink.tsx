import type { Schemas } from '@tms/contracts';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { formatDate, formatMoney, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { toBangkok } from '../features/orders/orderForm';
import { useOfferView, useRespondOffer, type OfferView } from '../features/trips/useTrips';
import { initials, isThaiPhone, timeLeft } from './offerTime';
import './carrier-link.css';
import './offer-link.css';

/* สีป้ายสถานะ (ต้นแบบ B: รอตอบ / รับงาน / ปฏิเสธ — หมดเวลา/ยกเลิกใช้สีกลาง) */
export const BADGE: Record<string, { bg: string; c: string }> = {
  OFFERED: { bg: '#FCF0DC', c: '#8F5500' },
  ACCEPTED: { bg: '#E6F4EC', c: '#17733F' },
  REJECTED: { bg: '#FBE9E7', c: '#B3322A' },
  EXPIRED: { bg: '#ECEDEA', c: '#3B424C' },
  WITHDRAWN: { bg: '#ECEDEA', c: '#3B424C' },
};

export const day = (iso: string) => formatDate(new Date(`${iso}T00:00:00`), 'th', 'BE');
const plainNum = (v: string) => v.replace(/\.?0+$/, '');

/**
 * หน้าลิงก์ข้อเสนองานของรถร่วม (ST3-T23; docs/04 D3 "ส่งลิงก์ LINE/SMS ไม่ต้อง login", M10) — เปิดบนมือถือไม่ต้อง login
 * ต้นแบบ `TMS Subcon.dc.html` แท็บ "งาน": หัวพอร์ทัล · ใบสั่งงาน (เลขเที่ยว เส้นทาง เวลารับ ลูกค้า ประเภทรถ น้ำหนัก ส่งที่
 * เงื่อนไข ผู้ติดต่อ ราคาจ้าง) · แถบหมดอายุ · รับงาน (ทะเบียน + ชื่อ/เบอร์คนขับ) / ปฏิเสธ (เหตุผล 4 ข้อ) · การ์ดผล · toast
 * ต่างจากต้นแบบ [DECISION spec/12 §3]: แท็บ "ส่ง POD" แสดงเมื่อรับงานแล้ว (ไปหน้าลิงก์งาน ST4-T08) · "การเงิน" = ST6 · เลขงาน = เลขเที่ยว · ไม่มีราคาขาย/ที่อยู่
 * ลูกค้า · เบอร์คนขับบังคับ · สถานะหมดเวลา/ถูกยกเลิก
 */
export function OfferLinkPage() {
  const { t } = useI18n();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const q = useOfferView(token);
  const respond = useRespondOffer(token);
  const [mode, setMode] = useState<'' | 'acc' | 'dec'>('');
  const [plate, setPlate] = useState('');
  const [drv, setDrv] = useState('');
  const [ph, setPh] = useState('');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  /** ชื่อคนขับที่พิมพ์ (ระบบใช้ชื่อที่ลงทะเบียน — review L4) */
  const [typed, setTyped] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const sending = useRef(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(h);
  }, [toast]);
  // นับถอยหลังทุกนาที (แถบ "ลิงก์หมดอายุใน …")
  useEffect(() => {
    const h = setInterval(() => tick((x) => x + 1), 60_000);
    return () => clearInterval(h);
  }, []);
  const v = q.data;
  const bad = q.error instanceof ApiError && q.error.problem.status === 404;
  // เวลาเครื่องเทียบเวลาเซิร์ฟเวอร์ (server ตัดสินหมดเวลา — spec/04 §5 ข้อ 8)
  const skew = v ? Date.parse(v.serverTime) - (q.dataUpdatedAt || Date.now()) : 0;
  const left = v ? timeLeft(v.expiresAt, Date.now() + skew) : null;
  const status = v ? (v.status === 'OFFERED' && !left ? 'EXPIRED' : v.status) : 'OFFERED';
  const wait = status === 'OFFERED';

  const serverErr = (e: unknown): string => {
    if (!(e instanceof ApiError)) return t('ofl.e.failed');
    const p = e.problem as {
      code: string;
      status: number;
      reasons?: string[];
      errors?: { code: string }[];
    };
    if (p.status === 429) return t('cdl.v.tooMany');
    // ST9-T12 QA Q3: ลิงก์ถูกเพิกถอนระหว่างเปิดหน้าค้าง (เที่ยวถูกยกเลิก ฯลฯ) → 404 = ข้อความเดียวกับหน้าลิงก์ใช้ไม่ได้
    if (p.status === 404) return t('cdl.badD');
    if (p.code === 'assignment_blocked')
      return t('ofl.e.blocked', { r: (p.reasons ?? []).join(' · ') });
    if (p.code === 'offer_closed') return t('ofl.e.closed');
    const map: Record<string, MessageKey> = {
      registration_mismatch: 'ofl.e.mismatch',
      carrier_mismatch: 'ofl.e.mismatch',
      vehicle_not_registered: 'ofl.e.mismatch',
      driver_not_registered: 'ofl.e.mismatch',
      vehicle_retired: 'ofl.e.mismatch',
      driver_inactive: 'ofl.e.mismatch',
      plate_ambiguous: 'ofl.e.ambiguous',
      invalid_phone: 'ofl.f.phReq',
      carrier_inactive: 'ofl.e.carrierInactive',
    };
    const code = p.errors?.[0]?.code;
    return code && map[code] ? t(map[code]) : t('ofl.e.failed');
  };
  const onDone = (msg: string) => {
    setMode('');
    setErr(null);
    setToast(msg);
  };
  const onFail = (e: unknown) => {
    // เครื่องที่ค้างหน้าเก่า: 409 offer_closed → ข้อความยังแสดงแม้หน้าเปลี่ยนเป็นสถานะสุดท้าย (QA L2)
    setErr(serverErr(e));
    if (e instanceof ApiError && (e.problem.code === 'offer_closed' || e.problem.status === 404)) {
      setMode('');
      void q.refetch();
    }
  };
  const accept = () => {
    if (!plate.trim() || !drv.trim()) {
      setErr(t('ofl.f.req'));
      return;
    }
    if (!isThaiPhone(ph)) {
      setErr(t('ofl.f.phReq'));
      return;
    }
    if (sending.current || !v) return;
    sending.current = true;
    respond.mutate(
      {
        kind: 'accept',
        body: { vehiclePlate: plate.trim(), driverName: drv.trim(), driverPhone: ph.trim() },
      },
      {
        onSuccess: () => {
          setTyped(drv.trim());
          onDone(t('ofl.toast.acc', { no: v.tripNo, c: v.company }));
        },
        onError: onFail,
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  };
  const decline = () => {
    if (!why || sending.current) return;
    sending.current = true;
    respond.mutate(
      { kind: 'reject', body: { reason: why as Schemas['RejectOfferDto']['reason'] } },
      {
        onSuccess: () => onDone(t('ofl.toast.dec')),
        onError: onFail,
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  };
  const back = () => {
    setMode('');
    setErr(null);
  };

  return (
    <div className="cdl">
      <div className="cdl__phone">
        <div className="cdl__hd">
          <div className="cdl__mark">{v ? initials(v.company) : ''}</div>
          <div className="cdl__hdtxt">
            <b>{v ? t('cdl.title', { c: v.company }) : ' '}</b>
            <span>{v ? t('cdl.sub', { n: v.carrierName }) : ' '}</span>
          </div>
        </div>
        {v && (
          <div className="cdl__tabs" role="tablist">
            <button type="button" role="tab" className="cdl__tab" aria-selected>
              {t('ofl.tab.job')}
            </button>
            {/* ST4-T08: รับงานแล้ว → แท็บ "ส่ง POD" เปิดหน้าลิงก์งาน (ค้น DO + กดถึง/ออก) */}
            {v.podUrl && (
              <button
                type="button"
                role="tab"
                className="cdl__tab"
                aria-selected={false}
                onClick={() => navigate(new URL(v.podUrl!).pathname)}
              >
                {t('ofl.tab.pod')}
              </button>
            )}
          </div>
        )}
        <div className="cdl__body">
          {q.isLoading && <span className="cdl__muted">{t('cdl.loading')}</span>}
          {(bad || (q.isError && !bad)) && (
            <div className="cdl__empty" role="alert">
              <i>⌕</i>
              <b>{t(bad ? 'cdl.bad' : 'cdl.loadError')}</b>
              {bad ? (
                <span className="cdl__muted">{t('cdl.badD')}</span>
              ) : (
                <button type="button" className="cdl__ghost" onClick={() => void q.refetch()}>
                  {t('cdl.retry')}
                </button>
              )}
            </div>
          )}
          {v && (
            <>
              <div className="ofl__top">
                <span className="cdl__eyebrow">{t('ofl.eyebrow')}</span>
                <span
                  className="cdl__chip"
                  data-testid="ofl-status"
                  style={{ background: BADGE[status]!.bg, color: BADGE[status]!.c }}
                >
                  {t(`ofl.st.${status}` as MessageKey)}
                </span>
              </div>
              <Job v={v} />
              {wait && left && (
                <div className="cdl__notice">
                  <span className="cdl__dot" style={{ background: '#8F5500' }} />
                  <span>
                    {t(left.unit === 'h' ? 'ofl.wait.h' : 'ofl.wait.m', {
                      n: left.n,
                      at: t('ofl.at', {
                        d: day(toBangkok(v.expiresAt).date),
                        t: toBangkok(v.expiresAt).time,
                      }),
                    })}
                  </span>
                </div>
              )}
              {wait && mode === 'acc' && (
                <div className="cdl__card" data-testid="ofl-form">
                  <span style={{ fontWeight: 600 }}>{t('ofl.f.title')}</span>
                  <label className="cdl__label">
                    <span>{t('ofl.f.plate')}</span>
                    <input
                      className="cdl__input cdl__num"
                      value={plate}
                      maxLength={40}
                      placeholder={t('ofl.f.platePh')}
                      onChange={(e) => {
                        setPlate(e.target.value);
                        setErr(null);
                      }}
                    />
                  </label>
                  <label className="cdl__label">
                    <span>{t('ofl.f.drv')}</span>
                    <input
                      className="cdl__input"
                      value={drv}
                      maxLength={120}
                      placeholder={t('ofl.f.drvPh')}
                      onChange={(e) => {
                        setDrv(e.target.value);
                        setErr(null);
                      }}
                    />
                  </label>
                  <label className="cdl__label">
                    <span>{t('ofl.f.ph')}</span>
                    <input
                      className="cdl__input cdl__num"
                      value={ph}
                      inputMode="tel"
                      maxLength={20}
                      placeholder={t('ofl.f.phPh')}
                      onChange={(e) => {
                        setPh(e.target.value);
                        setErr(null);
                      }}
                    />
                  </label>
                  {err && (
                    <span className="cdl__err" role="alert">
                      {err}
                    </span>
                  )}
                  <button
                    type="button"
                    className="cdl__primary"
                    disabled={respond.isPending}
                    onClick={accept}
                  >
                    {t('ofl.f.ok')}
                  </button>
                  <button type="button" className="cdl__ghost" onClick={back}>
                    {t('ofl.back')}
                  </button>
                </div>
              )}
              {wait && mode === 'dec' && (
                <div className="cdl__card" data-testid="ofl-decline">
                  <span style={{ fontWeight: 600 }}>{t('ofl.d.title')}</span>
                  {v.rejectReasons.map((r) => (
                    <button
                      key={r.code}
                      type="button"
                      className="ofl__opt"
                      aria-pressed={why === r.code}
                      onClick={() => {
                        setWhy(r.code);
                        setErr(null);
                      }}
                    >
                      {t(`ofl.reason.${r.code}` as MessageKey)}
                    </button>
                  ))}
                  {err && (
                    <span className="cdl__err" role="alert">
                      {err}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ofl__decline"
                    disabled={respond.isPending}
                    style={{ opacity: why ? 1 : 0.5 }}
                    onClick={decline}
                  >
                    {t('ofl.d.ok')}
                  </button>
                  <button type="button" className="cdl__ghost" onClick={back}>
                    {t('ofl.back')}
                  </button>
                </div>
              )}
              {wait && !mode && (
                <>
                  <button
                    type="button"
                    className="cdl__primary"
                    onClick={() => {
                      setMode('acc');
                      setErr(null);
                    }}
                  >
                    {t('ofl.accept')}
                  </button>
                  <button
                    type="button"
                    className="ofl__reject"
                    onClick={() => {
                      setMode('dec');
                      setErr(null);
                    }}
                  >
                    {t('ofl.reject')}
                  </button>
                  {err && (
                    <span className="cdl__err" role="alert">
                      {err}
                    </span>
                  )}
                </>
              )}
              {!wait && err && (
                <span className="cdl__err" role="alert">
                  {err}
                </span>
              )}
              {status === 'ACCEPTED' && (
                <div className="ofl__done ofl__done--ok" data-testid="ofl-accepted">
                  <b>{t('ofl.accd')}</b>
                  <span>
                    {t('ofl.accdV', {
                      p: v.accepted?.plate ?? '—',
                      d: v.accepted?.driverName ?? '—',
                    })}
                  </span>
                  {typed &&
                    v.accepted?.driverName &&
                    typed.replace(/\s+/g, ' ') !== v.accepted.driverName.replace(/\s+/g, ' ') && (
                      <span className="cdl__muted" data-testid="ofl-name-note">
                        {t('ofl.nameNote', { n: v.accepted.driverName })}
                      </span>
                    )}
                  {v.podUrl && <span className="cdl__muted">{t('ofl.accdPod')}</span>}
                </div>
              )}
              {status === 'REJECTED' && (
                <div className="ofl__done" data-testid="ofl-rejected">
                  <b>{t('ofl.decd')}</b>
                  <span className="cdl__muted">
                    {t('ofl.decdV', {
                      r: v.rejectReason ? t(`ofl.reason.${v.rejectReason}` as MessageKey) : '—',
                    })}
                  </span>
                </div>
              )}
              {status === 'EXPIRED' && (
                <div className="ofl__done" data-testid="ofl-expired">
                  <b>{t('ofl.exp')}</b>
                  <span className="cdl__muted">{t('ofl.expD', { c: v.company })}</span>
                </div>
              )}
              {status === 'WITHDRAWN' && (
                <div className="ofl__done">
                  <b>{t('ofl.wd')}</b>
                  <span className="cdl__muted">{t('ofl.wdD')}</span>
                </div>
              )}
            </>
          )}
        </div>
        {toast && (
          <div className="cdl__toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

/** การ์ดใบสั่งงาน (ต้นแบบ: หัวเลขงาน/เส้นทาง/เวลารับ + แถว 120px + แถบราคาจ้าง) */
export function Job({ v }: { v: OfferView }) {
  const { t } = useI18n();
  const pick = v.pickupAt ? toBangkok(v.pickupAt) : null;
  const terms = [
    t('ofl.t.vat'),
    ...(v.terms.whtRate ? [t('ofl.t.wht', { w: plainNum(v.terms.whtRate) })] : []),
    t(v.terms.requirePodToPay ? 'ofl.t.payPod' : 'ofl.t.pay', { d: v.terms.paymentTermDays }),
  ].join(' · ');
  const rows: [MessageKey, string][] = [
    ['ofl.r.customer', v.customerName ?? '—'],
    ['ofl.r.vt', v.vehicleTypeName ?? '—'],
    [
      'ofl.r.weight',
      v.weightKg ? t('ofl.kg', { n: Number(v.weightKg).toLocaleString('th-TH') }) : '—',
    ],
    ['ofl.r.to', v.destination ?? '—'],
    ['ofl.r.terms', terms],
    ['ofl.r.contact', v.contactName ?? '—'],
  ];
  return (
    <div className="ofl__job" data-testid="ofl-job">
      <div className="ofl__head">
        <span className="ofl__no">{v.tripNo}</span>
        <span className="ofl__route">{`${v.origin ?? '—'} → ${v.destination ?? '—'}`}</span>
        <span className="cdl__muted">
          {pick
            ? t('ofl.pickup', { d: day(pick.date), t: pick.time })
            : t('ofl.pickupDay', { d: day(v.tripDate) })}
        </span>
      </div>
      {rows.map(([k, val]) => (
        <div key={k} className="ofl__row">
          <span className="cdl__muted">{t(k)}</span>
          <span>{val}</span>
        </div>
      ))}
      <div className="ofl__price">
        <span style={{ fontWeight: 600 }}>{t('ofl.price')}</span>
        <span className="ofl__amt" data-testid="ofl-price">
          {v.buyAmount ? formatMoney(v.buyAmount) : '—'}
        </span>
      </div>
    </div>
  );
}
