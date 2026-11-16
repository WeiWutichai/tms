import { Badge, Drawer, EmptyState, Icon, Toast, useEscapeLayer } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { toBangkok } from '../orders/orderForm';
import { useDateText } from '../rate-cards/rateFormat';
import {
  durationText,
  firstOrderViolation,
  legText,
  moveStop,
  routeDistanceText,
} from './tripStops';
import { useDetachFromTrip, useReorderStops, useTrip, type TripDetail } from './useTrips';

/** ป้ายสถานะเที่ยว — สี/ไอคอนตามกลุ่มสถานะของต้นแบบ (วางแผน / จัดรถแล้ว / ระหว่างส่ง / ส่งแล้ว) */
const TONE: Record<string, { tone: 'off' | 'ok' | 'info' | 'warn' | 'err'; icon: string }> = {
  PLANNING: { tone: 'off', icon: 'calendar' },
  OFFERED: { tone: 'warn', icon: 'clock' },
  ASSIGNED: { tone: 'ok', icon: 'truck' },
  DISPATCHED: { tone: 'info', icon: 'navigation' },
  IN_PROGRESS: { tone: 'info', icon: 'navigation' },
  COMPLETED: { tone: 'ok', icon: 'circle-check' },
  COSTED: { tone: 'ok', icon: 'circle-check' },
  SETTLED: { tone: 'ok', icon: 'circle-check' },
  CANCELLED: { tone: 'off', icon: 'ban' },
};

/** แก้จุดได้เฉพาะก่อนปล่อยรถ (API: PLANNING/ASSIGNED — ต้นแบบ `ed = t.st === 'วางแผน'`) */
const EDITABLE = new Set(['PLANNING', 'ASSIGNED']);

/** ชิป รับ/ส่ง (ต้นแบบ kc/kbg) */
const CHIP: Record<string, { c: string; bg: string }> = {
  PICKUP: { c: '#2257C4', bg: '#E9F0FA' },
  DELIVERY: { c: '#17733F', bg: '#E6F4EC' },
  RETURN: { c: '#17733F', bg: '#E6F4EC' },
};

function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>{k}</span>
      <span className="tms-num" style={{ color: '#101418', wordBreak: 'break-word' }}>
        {v}
      </span>
    </div>
  );
}

/**
 * ยืนยันนำใบส่งของออกจากเที่ยว เมื่อจุดนั้นมีหลายใบ (QA ST3-T16 — ต้นแบบลบทันทีเพราะ 1 จุด = 1 DO) · เลือกบางใบได้
 * ใช้ dialog ชุดเดียวกับ ReasonDialog (`tms-dialog`) · ไม่ต้องใส่เหตุผล (`/detach` ไม่บังคับ — เป็นงานก่อนปล่อยรถ)
 */
function DetachDialog({
  dos,
  busy,
  error,
  onOk,
  onClose,
}: {
  dos: { id: string; doNo: string }[];
  busy: boolean;
  error: string | null;
  onOk: (ids: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string[]>(dos.map((d) => d.id));
  useEscapeLayer(true, onClose);
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('trip.detach.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{t('trip.detach.title')}</h2>
            <p className="tms-dialog__desc">{t('trip.detach.desc', { n: dos.length })}</p>
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            aria-label={t('drawer.close')}
            title={t('drawer.close')}
            onClick={onClose}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-dialog__body">
          {dos.map((d) => (
            <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={picked.includes(d.id)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, d.id] : p.filter((x) => x !== d.id)))
                }
              />
              <span className="tms-num" style={{ color: '#2257C4' }}>
                {d.doNo}
              </span>
            </label>
          ))}
          {error && <span className="tms-field-error">{error}</span>}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('trip.detach.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px', background: '#B3322A', borderColor: '#B3322A' }}
            disabled={!picked.length || busy}
            onClick={() => onOk(dos.filter((d) => picked.includes(d.id)).map((d) => d.id))}
          >
            {t('trip.detach.ok', { n: picked.length })}
          </button>
        </div>
      </div>
    </div>
  );
}

const ROUND_BTN = {
  width: 28,
  height: 28,
  border: 0,
  borderRadius: 999,
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
} as const;

/**
 * Drawer เที่ยวรถ / ใบคุมรถ (ST3-T16 — ต้นแบบ TMS v4 vPanel kind 'trp'): ข้อมูลเที่ยว + "จุดรับ / ส่ง ตามลำดับ"
 * เลื่อนขึ้น/ลง (เรียงจุดเอง — กันส่งก่อนรับ) · นำออกจากเที่ยว · ระยะ/เวลารวม (เพิ่มจากต้นแบบ — spec/12 §3 DECISION)
 * แท็บไทม์ไลน์/เอกสาร และปุ่ม "พิมพ์ใบคุมรถ"/"ปล่อยเที่ยว" ยังไม่ทำ (ST4 / ST3-T20 / ST3-T17)
 */
export function TripDrawer({
  id,
  canEdit,
  onClose,
}: {
  id: string;
  /** `trips:assign` */
  canEdit: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const q = useTrip(id);
  const reorder = useReorderStops();
  const detach = useDetachFromTrip();
  const [err, setErr] = useState<string | null>(null);
  /** จุดที่กด × และมีหลายใบส่งของ → dialog ยืนยัน */
  const [ask, setAsk] = useState<TripDetail['stops'][number] | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const tr = q.data;
  if (!tr)
    return (
      <Drawer open onClose={onClose} kind={t('trip.kind')} title="…" labels={labels}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('trip.loadError')}
            description={problemText(q.error, t) ?? ''}
          />
        ) : (
          <span style={{ color: '#59606B' }}>{t('table.loading')}</span>
        )}
      </Drawer>
    );

  const ed = canEdit && EDITABLE.has(tr.status);
  const busy = reorder.isPending || detach.isPending;
  const ids = tr.stops.map((s) => s.id);
  const doNo = (x: string) => tr.deliveryOrders.find((d) => d.id === x)?.doNo ?? '';
  const mv = (i: number, d: -1 | 1) => {
    const next = moveStop(ids, i, d);
    if (!next || busy) return;
    const bad = firstOrderViolation(tr, next);
    if (bad) {
      setErr(t('trip.stops.orderErr', { doNo: bad.doNo }));
      return;
    }
    setErr(null);
    const wk = (w: TripDetail['warnings'][number]) => `${w.code}|${w.message}`;
    const before = new Set(tr.warnings.map(wk));
    reorder.mutate(
      { id: tr.id, version: tr.version, stopIds: next },
      {
        onError: (e) => setErr(problemText(e, t)),
        // คำเตือนใหม่หลังเรียง (เช่น เวลาตามแผนถอยหลัง) — drawer ไม่มีส่วนคำเตือนในต้นแบบ → toast แบบเดียวกับกระดาน (QA ST3-T16)
        onSuccess: (x) => {
          const m = t('trip.toast.reordered', { no: x.tripNo });
          const i = [
            ...new Set(x.warnings.filter((w) => !before.has(wk(w))).map((w) => w.message)),
          ].join(' · ');
          setToast(i ? t('plan.toast.issue', { m, i }) : m);
        },
      },
    );
  };
  const detachDos = (doIds: string[], fromDialog: boolean) => {
    setErr(null);
    setAskErr(null);
    detach.mutate(
      { id: tr.id, version: tr.version, doIds },
      {
        onSuccess: () => {
          setAsk(null);
          setToast(t('trip.toast.detached', { dos: doIds.map(doNo).join(', ') }));
        },
        onError: (e) => (fromDialog ? setAskErr(problemText(e, t)) : setErr(problemText(e, t))),
      },
    );
  };
  const rm = (s: TripDetail['stops'][number]) => {
    if (busy || !s.deliveryOrderIds.length) return;
    // 1 ใบ = ลบทันทีตามต้นแบบ · หลายใบ = ยืนยันก่อน (เลือกบางใบได้)
    if (s.deliveryOrderIds.length > 1) {
      setAskErr(null);
      setAsk(s);
      return;
    }
    detachDos(s.deliveryOrderIds, false);
  };
  const st = TONE[tr.status] ?? TONE.PLANNING!;
  const time = (s: TripDetail['stops'][number]) => {
    const iso = s.plannedArrival ?? s.windowStart;
    return iso ? toBangkok(iso).time : '';
  };

  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('trip.kind')}
      title={tr.tripNo}
      subtitle={`${tr.driver?.name ?? '—'} · ${dateText(tr.tripDate)}`}
      badge={
        <Badge label={t(`trip.st.${tr.status}` as MessageKey)} tone={st.tone} icon={st.icon} />
      }
      tabs={[{ key: 'sum', label: t('drawer.tab.sum') }]}
      tab="sum"
      onTab={() => undefined}
      labels={labels}
      footer={
        <>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>
              {t('trip.foot.dos')}
            </span>
            <span className="tms-num" style={{ fontSize: 20, fontWeight: 600, color: '#101418' }}>
              {t('trip.foot.n', { n: tr.deliveryOrders.length })}
            </span>
          </div>
          <span style={{ flex: 1 }} />
          {err && (
            <span className="tms-field-error" role="alert">
              {err}
            </span>
          )}
        </>
      }
    >
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          paddingBottom: 20,
          borderBottom: '1px solid #E4E6E0',
        }}
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
          <Kv k={t('trip.kv.date')} v={dateText(tr.tripDate)} />
          <Kv
            k={t('trip.kv.vehicle')}
            v={
              tr.vehicle
                ? [tr.vehicle.plate, tr.vehicle.vehicleTypeName].filter(Boolean).join(' · ')
                : '—'
            }
          />
          <Kv k={t('trip.kv.trailer')} v={tr.trailer?.plate ?? '—'} />
          <Kv k={t('trip.kv.driver')} v={tr.driver?.name ?? '—'} />
          {tr.carrier && <Kv k={t('trip.kv.carrier')} v={tr.carrier.name} />}
          <Kv
            k={t('trip.kv.weight')}
            v={t('trip.kg', { n: Number(tr.weightKg).toLocaleString('th-TH') })}
          />
          <Kv k={t('trip.kv.distance')} v={routeDistanceText(t, tr.route)} />
          <Kv
            k={t('trip.kv.duration')}
            v={tr.route.minutes === null ? '—' : durationText(t, tr.route.minutes)}
          />
        </div>
      </section>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#13213F' }}>
          {t('trip.stops.title')}
        </h3>
        {tr.stops.map((s, i) => {
          const chip = CHIP[s.type] ?? CHIP.DELIVERY!;
          // ต้นแบบ: เลข DO แสดงที่จุดส่ง (จุดรับไม่แสดง)
          const dos =
            s.type === 'PICKUP' ? '' : s.deliveryOrderIds.map(doNo).filter(Boolean).join(', ');
          const right = [legText(t, s, i === 0), time(s)].filter(Boolean).join(' · ');
          return (
            <div
              key={s.id}
              data-testid="trip-stop"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                background: '#F4F5F2',
                border: '1px solid #E4E6E0',
                borderRadius: 12,
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: '#FFFFFF',
                  border: '1px solid #D9DCD4',
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  height: 22,
                  padding: '0 8px',
                  borderRadius: 999,
                  background: chip.bg,
                  color: chip.c,
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                {t(`trip.stops.${s.type}` as MessageKey)}
              </span>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span
                  style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {s.siteName}
                </span>
                {dos && (
                  <span className="tms-num" style={{ fontSize: 13, color: '#2257C4' }}>
                    {dos}
                  </span>
                )}
              </div>
              {right && (
                <span className="tms-num" style={{ fontSize: 12, color: '#3B424C' }}>
                  {right}
                </span>
              )}
              {ed && (
                <div style={{ display: 'flex', gap: 2 }}>
                  <button
                    type="button"
                    title={t('trip.stops.up')}
                    aria-label={t('trip.stops.up')}
                    onClick={() => mv(i, -1)}
                    disabled={busy}
                    style={{ ...ROUND_BTN, color: '#3B424C' }}
                  >
                    <Icon n="chevron-up" s={16} />
                  </button>
                  <button
                    type="button"
                    title={t('trip.stops.down')}
                    aria-label={t('trip.stops.down')}
                    onClick={() => mv(i, 1)}
                    disabled={busy}
                    style={{ ...ROUND_BTN, color: '#3B424C' }}
                  >
                    <Icon n="chevron-down" s={16} />
                  </button>
                  {s.type !== 'PICKUP' && s.deliveryOrderIds.length > 0 && (
                    <button
                      type="button"
                      title={t('trip.stops.remove')}
                      aria-label={t('trip.stops.remove')}
                      onClick={() => rm(s)}
                      disabled={busy}
                      style={{ ...ROUND_BTN, color: '#B3322A' }}
                    >
                      <Icon n="x" s={16} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {tr.stops.length === 0 && (
          <div
            style={{
              border: '1.5px dashed #C9CDC3',
              borderRadius: 12,
              padding: 20,
              textAlign: 'center',
              color: '#3B424C',
            }}
          >
            {t('trip.stops.empty')}
          </div>
        )}
      </div>
      {ask && (
        <DetachDialog
          dos={ask.deliveryOrderIds.map((x) => ({ id: x, doNo: doNo(x) }))}
          busy={detach.isPending}
          error={askErr}
          onOk={(ids) => detachDos(ids, true)}
          onClose={() => setAsk(null)}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </Drawer>
  );
}
