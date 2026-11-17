import {
  ActivityTimeline,
  Badge,
  Drawer,
  EmptyState,
  Icon,
  ReasonDialog,
  Toast,
  type TimelineItem,
} from '@tms/ui';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { toBangkok } from '../orders/orderForm';
import { money, useDateText, useDateTimeText } from '../rate-cards/rateFormat';
import { timeLeft } from '../../public/offerTime';
import { margin, plainNum } from './subconHire';
import {
  useHireOptions,
  useOfferLink,
  useSendOfferLink,
  useTripOffers,
  type SubconOffer,
  type TripDetail,
} from './useTrips';

/** ต้นแบบ TMS v4 (vPanel kind 'sub') — ค่าเดียวกับ SubconHireDrawer */
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
 * drawer "จ่ายงานรถร่วม" หลังส่งข้อเสนอ (ST3-T23 — ต้นแบบ TMS v4 vPanel kind 'sub' สถานะ รอตอบ / รับงาน):
 * - ส่งข้อเสนอ: ข้อมูล (เส้นทาง วันที่ส่ง ระยะทาง ส่งข้อเสนอล่าสุด + หมดเวลาใน) · รอตอบ = ผู้รับเหมา/ราคาและกำไรของข้อเสนอ
 *   (อ่านอย่างเดียว — แก้ราคาไม่ได้หลังส่ง PLN-142; เปลี่ยนรถร่วม = ST3-T25) · รับงาน = กล่อง "… รับงานแล้ว" ทะเบียน/คนขับ
 * - ใบสั่งงาน: ตัวอย่างที่ผู้รับเหมาเห็น + "ลิงก์ใบสั่งงาน" · กิจกรรม: ส่งข้อเสนอ/ส่งลิงก์/เปิดลิงก์/รับ/ปฏิเสธ/หมดเวลา/ถอน
 * - footer: รอตอบ = กำไรต่อเที่ยว + "คัดลอกลิงก์" + "ส่งผ่าน LINE" · รับงาน = ราคาจ้าง + "คัดลอกลิงก์"
 */
export function SubconOfferDrawer({
  trip,
  onClose,
  onNext,
  onChangeCarrier,
}: {
  trip: TripDetail;
  onClose: () => void;
  /** ST3-T24 "ส่งรายถัดไป" (ครบเวลาตอบ N ชม. แล้วยังไม่ตอบ) → เปิด drawer จ้างรถร่วมแบบแทนรายเดิม */
  onNext?: () => void;
  /**
   * ST3-T25 เมนู ⋯ "เปลี่ยนผู้รับเหมา" (รอตอบ หรือรับงานแล้วแต่ยังไม่ปล่อยรถ): ReasonDialog เหตุผล ≥ 10 ตัว →
   * เปิด drawer จ้างรถร่วมแบบเปลี่ยนราย (ยกเลิกการจ้างเดิมตอนกดส่งข้อเสนอ — คำขอเดียว)
   */
  onChangeCarrier?: (reason: string) => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const dtText = useDateTimeText();
  const me = useMe();
  const hire = trip.hire!;
  const acc = hire.status === 'ACCEPTED';
  const [tab, setTab] = useState<'sum' | 'prev' | 'log'>('sum');
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // เปลี่ยนผู้รับเหมาได้ระหว่างรอตอบ หรือรับงานแล้วแต่ยังไม่ปล่อยรถ (docs/01 §4.2 — หลังปล่อยรถห้ามแก้ snapshot)
  const canChange =
    !!onChangeCarrier &&
    ((trip.status === 'OFFERED' && !acc) || (trip.status === 'ASSIGNED' && acc));
  const opts = useHireOptions(trip.id, !acc);
  const link = useOfferLink(trip.id, true);
  const offers = useTripOffers(trip.id, true);
  const send = useSendOfferLink(trip.id);
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const carrierName = trip.carrier?.name ?? '—';
  const cur: SubconOffer | undefined = offers.data?.find((o) => o.id === hire.id);
  const o = opts.data;
  const opt = o?.options.find((x) => x.carrier.id === hire.carrierId);
  const buy = hire.buyAmount ?? null;
  const m = margin(o?.sellAmount, buy);
  const left = trip.offerExpiresAt ? timeLeft(trip.offerExpiresAt) : null;
  // ST3-T24 ครบเวลาตอบ N ชม. ยังไม่ตอบ (ลิงก์ยังไม่หมดอายุ) → ข้อความ + ปุ่ม "ส่งรายถัดไป"
  const due = hire.responseDueAt ? Date.parse(hire.responseDueAt) : null;
  const timedOut = !acc && due !== null && due <= Date.now() && !!left;
  const dueHours = due !== null ? Math.round((due - Date.parse(hire.offeredAt)) / 3600_000) : 0;
  const km = trip.route.distanceKm;
  const route = `${o?.origin?.name ?? trip.stops[0]?.siteName ?? '—'} → ${
    o?.destination?.name ?? trip.stops[trip.stops.length - 1]?.siteName ?? '—'
  }`;
  const first = trip.stops[0];
  const pickupIso = first?.plannedArrival ?? first?.windowStart ?? null;
  const url = link.data?.link?.url ?? null;
  // "ส่งผ่าน LINE" เฉพาะเมื่อส่งถึงรายนี้ได้ (ช่อง LINE เปิด + ผู้รับเหมามี LINE userId — #49) ไม่งั้นเหลือคัดลอกลิงก์
  const canLine = !!link.data?.channels.line;

  const copy = () => {
    if (!url) {
      setErr(t('sub.noLink'));
      return;
    }
    setErr(null);
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    setToast(t(acc ? 'sub.toast.copiedAcc' : 'sub.toast.copied'));
  };
  const line = () => {
    if (!url || send.isPending) {
      if (!url) setErr(t('sub.noLink'));
      return;
    }
    setErr(null);
    send.mutate(
      { channel: 'line', url, idempotencyKey: crypto.randomUUID() },
      {
        onSuccess: () => setToast(t('sub.toast.line', { n: carrierName })),
        onError: (e) => {
          const code =
            e instanceof ApiError
              ? (e.problem as { errors?: { code: string }[] }).errors?.[0]?.code
              : undefined;
          setErr(
            e instanceof ApiError && e.problem.code === 'channel_unavailable'
              ? t('cdoc.send.unavailable', { ch: 'LINE' })
              : code === 'recipient_missing'
                ? t('cdoc.send.noRecipient', { ch: 'LINE' })
                : e instanceof ApiError && e.problem.code === 'rate_limited'
                  ? t('cdoc.send.limit')
                  : problemText(e, t),
          );
        },
      },
    );
  };

  // ใบสั่งงาน — ชุดเดียวกับ ST3-T22 (หัก ณ ที่จ่าย = ธงจาก rate card เมื่อจ้างตามราคา rate card เท่านั้น)
  const wht = hire.buyPriceSource === 'RATE_CARD' ? (opt?.whtRate ?? null) : null;
  const wo: [MessageKey, string][] = [
    ['sub.wo.no', trip.tripNo],
    [
      'sub.wo.route',
      km === null ? route : `${route} (${t('sub.km', { n: Number(km).toLocaleString('th-TH') })})`,
    ],
    [
      'sub.wo.pickup',
      `${dateText(trip.tripDate)}${pickupIso ? ` ${toBangkok(pickupIso).time}` : ''}`,
    ],
    ['sub.wo.price', buy ? t('sub.wo.priceV', { p: money(buy) }) : '—'],
    [
      'sub.wo.terms',
      [
        ...(wht ? [t('sub.wo.wht', { w: plainNum(wht) })] : []),
        ...(opt
          ? [
              t(opt.carrier.requirePodToPay ? 'sub.wo.payPod' : 'sub.wo.pay', {
                d: opt.carrier.paymentTermDays,
              }),
            ]
          : []),
      ].join(' · ') || '—',
    ],
    ['sub.wo.contact', cur?.offeredByName ?? me.data?.user?.name ?? '—'],
  ];

  const logs = activity(offers.data ?? [], t, dtText);

  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('sub.kind')}
      title={trip.tripNo}
      badge={
        <Badge
          label={t(acc ? 'ofl.st.ACCEPTED' : 'ofl.st.OFFERED')}
          tone={acc ? 'ok' : 'warn'}
          icon={acc ? 'circle-check' : 'clock'}
        />
      }
      labels={labels}
      menu={
        canChange
          ? [
              {
                label: t('sub.menu.change'),
                icon: 'repeat',
                danger: true,
                onClick: () => setAsking(true),
              },
            ]
          : undefined
      }
      tabs={[
        { key: 'sum', label: t('sub.tab.sum') },
        { key: 'prev', label: t('sub.tab.prev') },
        { key: 'log', label: t('sub.tab.log') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as 'sum' | 'prev' | 'log')}
      footer={
        <>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>
              {t(acc ? 'sub.foot.price' : 'sub.foot.profit')}
            </span>
            <span className="tms-num" style={{ fontSize: 20, fontWeight: 600, color: '#101418' }}>
              {acc
                ? buy
                  ? t('sub.baht', { p: money(buy) })
                  : '—'
                : m
                  ? t('sub.baht', { p: money(m.profit) })
                  : '—'}
            </span>
          </div>
          <span style={{ flex: 1 }} />
          {err && (
            <span className="tms-field-error" role="alert">
              {err}
            </span>
          )}
          <div className="tms-drawer__acts">
            <button type="button" className="tms-drawer__sec" onClick={copy}>
              {t('sub.foot.copy')}
            </button>
            {timedOut && onNext && (
              <button type="button" className="tms-drawer__sec" onClick={onNext}>
                {t('sub.foot.next')}
              </button>
            )}
            {!acc && canLine && (
              <button
                type="button"
                className="tms-drawer__pri"
                disabled={send.isPending}
                onClick={line}
              >
                <Icon n="send" s={16} />
                {t('sub.foot.line')}
              </button>
            )}
          </div>
        </>
      }
    >
      {tab === 'sum' && (
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
              <Kv k={t('sub.kv.sent')} v={dtText(hire.offeredAt)} />
              {!acc && (
                <Kv
                  k={t('sub.kv.expires')}
                  v={
                    left
                      ? t(left.unit === 'h' ? 'sub.left.h' : 'sub.left.m', { n: left.n })
                      : t('sub.left.none')
                  }
                />
              )}
            </div>
          </section>
          {acc ? (
            <div
              data-testid="sub-accepted"
              style={{
                background: '#EEF0EC',
                border: '1px solid #E9F0FA',
                borderRadius: 8,
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                <Icon n="circle-check" s={16} style={{ color: '#17733F' }} />
                {t('sub.acc.title', { n: carrierName })}
              </span>
              <span>
                {t('sub.acc.v', {
                  p: trip.vehicle?.plate ?? cur?.acceptedPlate ?? '—',
                  d: trip.driver?.name ?? cur?.acceptedDriverName ?? '—',
                })}
              </span>
              <span style={{ fontSize: 12, color: '#3B424C' }}>
                {t(cur?.respondedVia === 'USER' ? 'sub.acc.viaUser' : 'sub.acc.via')}
              </span>
            </div>
          ) : (
            <>
              <div style={SEC}>
                <h3 style={H3}>{t('sub.con')}</h3>
                <select aria-label={t('sub.con')} value="x" disabled style={CONTROL}>
                  <option value="x">
                    {buy ? t('sub.opt', { n: carrierName, p: money(buy) }) : carrierName}
                  </option>
                </select>
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
                    <div style={NUM}>
                      {opt?.buyRecentAmounts?.length
                        ? opt.buyRecentAmounts.map(money).join(' · ')
                        : '—'}
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
                    value={buy ? money(buy) : ''}
                    disabled
                    readOnly
                    style={{ ...CONTROL, ...NUM, textAlign: 'right' }}
                  />
                  {timedOut ? (
                    <span style={{ fontSize: 13, color: '#8F5500' }} data-testid="sub-timeout">
                      {t('sub.timeout', { n: carrierName, h: dueHours })}
                    </span>
                  ) : (
                    <span style={{ fontSize: 13, color: '#3B424C' }} data-testid="sub-wait">
                      {t('sub.wait.title', { n: carrierName })}
                    </span>
                  )}
                </label>
                <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                    }}
                  >
                    <span>{t('sub.sell')}</span>
                    <span style={NUM}>{o?.sellAmount ? money(o.sellAmount) : '—'}</span>
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
                    <span style={NUM}>{buy ? money(buy) : '—'}</span>
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
              </div>
            </>
          )}
        </>
      )}
      {tab === 'prev' && (
        <>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={LABEL}>{t('sub.wo.link')}</span>
            <span
              data-testid="sub-link"
              style={{
                ...NUM,
                padding: '8px 10px',
                background: '#EBEDE8',
                borderRadius: 8,
                wordBreak: 'break-all',
              }}
            >
              {url ?? '—'}
            </span>
            <span style={{ fontSize: 13, color: '#3B424C' }}>
              {url ? t('sub.wo.linkExp') : t('sub.noLink')}
            </span>
          </div>
        </>
      )}
      {tab === 'log' &&
        (logs.length ? (
          <ActivityTimeline items={logs} />
        ) : (
          <EmptyState icon="history" title={t('sub.log.empty')} description="" />
        ))}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
      <ReasonDialog
        open={asking}
        title={t('sub.change.title')}
        description={
          acc
            ? t('sub.change.descAcc', {
                n: carrierName,
                p: trip.vehicle?.plate ?? cur?.acceptedPlate ?? '—',
              })
            : t('sub.change.desc', { n: carrierName })
        }
        label={t('sub.change.reason')}
        placeholder={t('sub.change.ph')}
        okLabel={t('sub.change.ok')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        minLength={10}
        hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
        onClose={() => setAsking(false)}
        onOk={(reason) => {
          setAsking(false);
          onChangeCarrier?.(reason);
        }}
      />
    </Drawer>
  );
}

/** แท็บกิจกรรม (ต้นแบบ logs ของ kind 'sub') — เรียงตามเวลาเก่า → ใหม่ */
export function activity(
  offers: SubconOffer[],
  t: (k: MessageKey, v?: Record<string, string | number>) => string,
  dt: (iso: string) => string,
): TimelineItem[] {
  const ok = { label: t('sub.log.ok'), tone: 'ok' as const, icon: 'circle-check' };
  const fail = { label: t('sub.log.fail'), tone: 'err' as const, icon: 'circle-x' };
  const wait = { label: t('sub.log.wait'), tone: 'warn' as const, icon: 'clock' };
  const json = (o: Record<string, unknown>) => JSON.stringify(o, null, 2);
  const out: (TimelineItem & { at: string })[] = [];
  for (const o of offers) {
    const n = o.carrierName;
    out.push({
      key: `${o.id}-offered`,
      at: o.offeredAt,
      title: t('sub.log.offered', { n }),
      sub: `${dt(o.offeredAt)} · OFFERED`,
      badge: ok,
      detail: json({
        to: n,
        ...(o.buyAmount ? { price: o.buyAmount } : {}),
        ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}),
        ...(o.offeredByName ? { by: o.offeredByName } : {}),
      }),
    });
    for (const msg of o.messages) {
      const ch = msg.channel === 'sms' ? 'SMS' : 'LINE';
      out.push({
        key: msg.id,
        at: msg.createdAt,
        title: t('sub.log.msg', { n, ch }),
        sub: `${dt(msg.sentAt ?? msg.createdAt)} · ${ch} ${msg.errorCode ?? msg.status.toUpperCase()}`,
        badge: msg.status === 'sent' ? ok : msg.status === 'failed' ? fail : wait,
        detail: json({ channel: ch, to: msg.recipient, status: msg.status }),
      });
    }
    if (o.viewedAt)
      out.push({
        key: `${o.id}-viewed`,
        at: o.viewedAt,
        title: t('sub.log.viewed'),
        sub: `${dt(o.viewedAt)} · VIEWED`,
        badge: ok,
      });
    const at = o.respondedAt ?? o.closedAt;
    // รับงานแล้วถูกยกเลิกภายหลัง (ST3-T25 เปลี่ยนผู้รับเหมา / ยกเลิกเที่ยว) — การรับงานยังอยู่ในประวัติ
    const wasAccepted = o.status === 'ACCEPTED' || (o.status === 'WITHDRAWN' && !!o.acceptedPlate);
    if (wasAccepted && o.respondedAt)
      out.push({
        key: `${o.id}-acc`,
        at: o.respondedAt,
        title: t(o.respondedVia === 'USER' ? 'sub.log.accUser' : 'sub.log.acc', {
          p: o.acceptedPlate ?? '—',
        }),
        sub: `${dt(o.respondedAt)} · ACCEPTED`,
        badge: ok,
        detail: json({ plate: o.acceptedPlate, driver: o.acceptedDriverName }),
      });
    if (o.status === 'REJECTED' && at)
      out.push({
        key: `${o.id}-dec`,
        at,
        title: t('sub.log.dec', {
          r: o.rejectReason ? t(`ofl.reason.${o.rejectReason}` as MessageKey) : '—',
        }),
        sub: `${dt(at)} · DECLINED`,
        badge: fail,
        detail: json({ reason: o.rejectReason, ...(o.rejectNote ? { note: o.rejectNote } : {}) }),
      });
    if (o.status === 'EXPIRED')
      out.push({
        key: `${o.id}-exp`,
        at: o.expiresAt ?? o.offeredAt,
        title: t('sub.log.exp'),
        sub: `${dt(o.expiresAt ?? o.offeredAt)} · EXPIRED`,
        badge: wait,
      });
    if (o.status === 'WITHDRAWN' && o.closedAt)
      out.push({
        key: `${o.id}-wd`,
        at: o.closedAt,
        title: t(o.acceptedPlate ? 'sub.log.cancelled' : 'sub.log.wd'),
        sub: `${dt(o.closedAt)} · WITHDRAWN`,
        badge: { label: t('sub.log.ok'), tone: 'off', icon: 'ban' },
        ...(o.closedReason ? { detail: o.closedReason } : {}),
      });
  }
  // เวลาเท่ากัน (ST3-T25 ยกเลิกการจ้างเดิม + เสนอรายใหม่ในคำขอเดียว) → การปิดของรายเดิมมาก่อนการเสนอรายใหม่
  const rank = (k: string) => (k.endsWith('-offered') ? 1 : 0);
  return out
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || rank(a.key) - rank(b.key))
    .map(({ at: _at, ...x }) => x);
}
