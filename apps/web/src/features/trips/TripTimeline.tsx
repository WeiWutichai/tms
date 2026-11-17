import { ChoiceGroup, EmptyState, Icon, useEscapeLayer } from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { fromBangkok, toBangkok } from '../orders/orderForm';
import { useDateText, useDateTimeText } from '../rate-cards/rateFormat';
import { CATEGORIES, useReasonCodes } from '../settings/useReasonCodes';
import {
  beforeFloor,
  realDeparture,
  reasonRule,
  restStops as restOf,
  STEP_LOOK,
  stepActions,
  stepKey,
  timeError,
  timeFloor,
  TONE_COLORS,
  type Floor,
  type StepEvent,
  type TripStop,
} from './tripStepper';
import type { TripDetail } from './useTrips';
import {
  useRecordStopEvents,
  useTripEvents,
  type StopEvent,
  type StopEventStep,
  type TimelineEvent,
} from './useTripTimeline';

type Outcome = 'DELIVERED' | 'PARTIAL' | 'FAILED' | 'UNDELIVERED_RETAIN';
const OUTCOMES: Outcome[] = ['DELIVERED', 'PARTIAL', 'FAILED', 'UNDELIVERED_RETAIN'];

/** สิ่งที่กำลังบันทึก (dialog) */
type Ask =
  | { kind: 'arrive' | 'fail'; stop: TripStop }
  | { kind: 'complete'; stop: TripStop; needArrive: boolean }
  | { kind: 'depart'; from: TripStop; stop: TripStop }
  | { kind: 'failRest'; stops: TripStop[] };

/** ปุ่มแบบเม็ดยา (ต้นแบบ step "ลองใหม่": สูง 30, ขอบ #9DB6E3, ตัวอักษร #2257C4) */
const PILL = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 30,
  padding: '0 12px',
  border: '1px solid #9DB6E3',
  borderRadius: 999,
  background: '#FFFFFF',
  color: '#2257C4',
  fontWeight: 500,
  cursor: 'pointer',
} as const;

const stepTitle = (t: T, s: TripStop) =>
  t(`trip.tl.step.${s.type}` as MessageKey, { site: s.siteName });

/** ผลของจุด — จุดรับใช้คำของการรับ ("รับสำเร็จ") · จุดส่งใช้คำของการส่ง (review/QA L4) */
const outLabel = (t: T, type: string, o: string) =>
  type === 'PICKUP' ? t(`trip.tl.out.PICKUP.${o}` as MessageKey) : t(`exc.out.${o}` as MessageKey);

/** รอบโหลดซ้ำขณะเปิดแท็บ (เห็นสถานะจากลิงก์/แอปคนขับ — review/QA L5) */
const REFRESH_MS = 30_000;

/** ชิปเล็กของบรรทัด event */
function Chip({ label, c, bg }: { label: string; c: string; bg: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        padding: '0 6px',
        marginLeft: 6,
        borderRadius: 999,
        background: bg,
        color: c,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

/**
 * แท็บ "ไทม์ไลน์" ของ drawer เที่ยวรถ (ST4-T04 — ต้นแบบ TMS v4 vPanel 'trp' แท็บ tl: "ความคืบหน้าเที่ยว" ขั้นต่อจุด
 * "รับสินค้า · …" / "ส่งสินค้า · …" + ป้ายสถานะ + เวลา + เลข DO) · เพิ่มจากต้นแบบ (spec/12 §3 DECISION ST4-T04):
 * บรรทัด event พร้อมผู้บันทึก/แหล่ง, ธง → ศูนย์ข้อยกเว้น, ปุ่มบันทึกแทนคนขับ (`trips:dispatch`) และ dialog เวลา (ย้อนได้)
 */
export function TripTimeline({
  trip,
  canRecord,
  failRest,
  onFailRestClose,
  onToast,
  onOpenFlags,
}: {
  trip: TripDetail;
  /** `trips:dispatch` + เที่ยวปล่อยแล้ว/กำลังวิ่ง */
  canRecord: boolean;
  /** footer "ส่งไม่สำเร็จจุดที่เหลือ" ถูกกด */
  failRest: boolean;
  onFailRestClose: () => void;
  onToast: (m: string) => void;
  onOpenFlags: () => void;
}) {
  const { t } = useI18n();
  const dt = useDateTimeText();
  const dd = useDateText();
  const qc = useQueryClient();
  const q = useTripEvents(trip.id, true);
  const events = q.data ?? [];
  const [ask, setAsk] = useState<Ask | null>(null);
  // เปิดแท็บ = โหลดเที่ยว + ไทม์ไลน์ใหม่ แล้วโหลดซ้ำทุก 30 วินาทีขณะเปิดอยู่
  useEffect(() => {
    const refresh = () => qc.invalidateQueries({ queryKey: ['trip', trip.id] });
    void refresh();
    const h = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(h);
  }, [qc, trip.id]);
  /** วันเดียวกับวันเที่ยว = เวลาอย่างเดียว · วันอื่น = วันที่แบบเดียวกับ drawer ("17 พ.ย. 2569 13:25") */
  const hm = (iso: string) =>
    toBangkok(iso).date === trip.tripDate ? toBangkok(iso).time : dt(iso);
  const doNo = (id: string) => trip.deliveryOrders.find((d) => d.id === id)?.doNo ?? '';
  const rest = restOf(trip.stops, events);
  const current: Ask | null = failRest && rest.length ? { kind: 'failRest', stops: rest } : ask;

  if (!trip.stops.length)
    return (
      <span style={{ color: '#3B424C' }} data-testid="trip-tl-empty">
        {t('trip.tl.empty')}
      </span>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{t('trip.tl.title')}</h3>
      {q.isError && (
        <EmptyState
          icon="circle-alert"
          title={t('trip.tl.loadError')}
          description={problemText(q.error, t) ?? ''}
        />
      )}
      {q.isLoading && (
        <span style={{ fontSize: 12, color: '#59606B', marginBottom: 8 }} role="status">
          {t('table.loading')}
        </span>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {trip.stops.map((s, i) => {
          const key = stepKey(s);
          const look = STEP_LOOK[key] ?? STEP_LOOK.PENDING!;
          const tone = TONE_COLORS[look.tone];
          const evs = events.filter((e) => e.stopId === s.id);
          const acts = canRecord ? stepActions(trip.stops, events, i) : null;
          const planned = s.plannedArrival ?? s.windowStart;
          // "ออก" เฉพาะเมื่อมี DEPART จริงของจุดถัดไป (departedAt ถอยไปเป็นเวลาปิดงานได้ — ไม่ใช่เวลาออกจริง)
          const left = realDeparture(trip.stops, events, i);
          const at = [
            s.arrivedAt ? t('trip.tl.arrived', { t: hm(s.arrivedAt) }) : '',
            left ? t('trip.tl.departed', { t: hm(left) }) : '',
          ].filter(Boolean);
          if (!at.length && planned) at.push(t('trip.tl.planned', { t: hm(planned) }));
          // ต้นแบบ: เลข DO แสดงที่จุดส่ง (จุดรับไม่แสดง — เหมือนแท็บรายละเอียด)
          const dos =
            s.type === 'PICKUP' ? '' : s.deliveryOrderIds.map(doNo).filter(Boolean).join(', ');
          const flagged = evs.filter((e) => e.flags.length && !e.resolution);
          return (
            <div
              key={s.id}
              data-testid="trip-step"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '10px 12px',
                background: '#F4F5F2',
                border: '1px solid #E4E6E0',
                borderRadius: 12,
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: '#FFFFFF',
                  border: '1px solid #D9DCD4',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  color: look.ic,
                }}
              >
                <Icon n={look.icon} s={16} />
              </span>
              <div
                style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{stepTitle(t, s)}</span>
                  {look.done ? (
                    <Icon
                      n="check"
                      s={18}
                      style={{ color: '#2257C4' }}
                      aria-hidden={false}
                      role="img"
                      aria-label={t('trip.tl.st.COMPLETED')}
                    />
                  ) : (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        height: 24,
                        padding: '0 10px',
                        borderRadius: 999,
                        background: tone.bg,
                        color: tone.c,
                        fontSize: 12,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {key === 'PARTIAL'
                        ? outLabel(t, s.type, 'PARTIAL')
                        : t(`trip.tl.st.${s.status}` as MessageKey)}
                    </span>
                  )}
                </div>
                {at.length > 0 && (
                  <span className="tms-num" style={{ fontSize: 12, color: '#3B424C' }}>
                    {at.join(' · ')}
                    {s.outcome &&
                      ` · ${t('trip.tl.outcome', { o: outLabel(t, s.type, s.outcome) })}`}
                  </span>
                )}
                {dos && <span style={{ color: '#3B424C' }}>{dos}</span>}
                {evs.map((e) => (
                  <EventLine key={e.id} e={e} t={t} hm={hm} stopType={s.type} />
                ))}
                {s.status === 'SKIPPED' && (
                  <span style={{ fontSize: 12, color: '#3B424C' }}>{t('trip.tl.skippedNote')}</span>
                )}
                {/* ST4-T12 จุดที่ไม่สำเร็จ → DO ส่งใหม่ (นัดส่งใหม่อัตโนมัติ/ส่งซ้ำ) — ต้นแบบไม่มี: spec/12 §3 */}
                {s.reschedules.map((r) => (
                  <span
                    key={r.deliveryOrderId}
                    data-testid="trip-reschedule"
                    className="tms-num"
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 6,
                      fontSize: 12,
                      color: '#3B424C',
                    }}
                  >
                    <Icon n="calendar-clock" s={14} style={{ flex: 'none', marginTop: 1 }} />
                    <span style={{ minWidth: 0 }}>
                      {r.attempt > 0 && !r.manual
                        ? t('trip.tl.resched', {
                            n: r.attempt,
                            from: r.fromDoNo,
                            no: r.doNo,
                            d: dd(r.doDate),
                            st: t(`do.st.${r.status}` as MessageKey),
                          })
                        : t('trip.tl.redeliver', {
                            from: r.fromDoNo,
                            no: r.doNo,
                            d: dd(r.doDate),
                            st: t(`do.st.${r.status}` as MessageKey),
                          })}
                      {r.exhausted && t('trip.tl.reschedExhausted')}
                    </span>
                  </span>
                ))}
                {flagged.length > 0 && (
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      color: '#8F5500',
                    }}
                  >
                    <Icon n="triangle-alert" s={14} />
                    {t('trip.tl.flagged', {
                      f: [
                        ...new Set(
                          flagged.flatMap((e) =>
                            e.flags.map((f) => t(`exc.flag.${f}` as MessageKey)),
                          ),
                        ),
                      ].join(', '),
                    })}{' '}
                    ·
                    <button
                      type="button"
                      onClick={onOpenFlags}
                      style={{
                        border: 0,
                        background: 'transparent',
                        padding: 0,
                        color: '#2257C4',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {t('trip.tl.flagLink')}
                    </button>
                  </span>
                )}
                {acts?.pendingClose && (
                  <span
                    data-testid="trip-pending-close"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                      color: '#3B424C',
                    }}
                  >
                    {t('trip.tl.pendingClose')}
                    <button
                      type="button"
                      onClick={onOpenFlags}
                      style={{
                        border: 0,
                        background: 'transparent',
                        padding: 0,
                        color: '#2257C4',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {t('trip.tl.flagLink')}
                    </button>
                  </span>
                )}
                {acts && (acts.arrive || acts.complete || acts.fail || acts.depart) && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {acts.arrive && (
                      <button
                        type="button"
                        style={PILL}
                        onClick={() => setAsk({ kind: 'arrive', stop: s })}
                      >
                        <Icon n="map-pin" s={16} />
                        {t('trip.tl.do.arrive')}
                      </button>
                    )}
                    {acts.complete && (
                      <button
                        type="button"
                        style={PILL}
                        onClick={() =>
                          setAsk({ kind: 'complete', stop: s, needArrive: s.status === 'PENDING' })
                        }
                      >
                        <Icon n="circle-check" s={16} />
                        {t('trip.tl.do.complete')}
                      </button>
                    )}
                    {acts.fail && (
                      <button
                        type="button"
                        style={{ ...PILL, borderColor: '#E7B4AE', color: '#B3322A' }}
                        onClick={() => setAsk({ kind: 'fail', stop: s })}
                      >
                        <Icon n="circle-x" s={16} />
                        {t('trip.tl.do.fail')}
                      </button>
                    )}
                    {acts.depart && (
                      <button
                        type="button"
                        style={PILL}
                        onClick={() => setAsk({ kind: 'depart', from: s, stop: acts.depart! })}
                      >
                        <Icon n="navigation" s={16} />
                        {t('trip.tl.do.depart')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {current && (
        <RecordDialog
          key={current.kind === 'failRest' ? 'rest' : `${current.kind}:${current.stop.id}`}
          ask={current}
          events={events}
          onClose={() => (current.kind === 'failRest' ? onFailRestClose() : setAsk(null))}
          onDone={(m) => {
            if (current.kind === 'failRest') onFailRestClose();
            else setAsk(null);
            onToast(m);
          }}
        />
      )}
    </div>
  );
}

/** บรรทัด event: "ถึงจุด 09:10 · บันทึกโดย … · บันทึกผ่านเว็บ" (+ เหตุผล/หมายเหตุ) */
function EventLine({
  e,
  t,
  hm,
  stopType,
}: {
  e: TimelineEvent;
  t: T;
  hm: (iso: string) => string;
  stopType: string;
}) {
  const ev =
    e.type === 'DEPART'
      ? t('trip.tl.ev.DEPART')
      : e.outcome
        ? `${t(`exc.ev.${e.type}` as MessageKey)} (${outLabel(t, stopType, e.outcome)})`
        : t(`exc.ev.${e.type}` as MessageKey);
  const by = e.recordedByName ? t('trip.tl.by', { n: e.recordedByName }) : t('trip.tl.byUnknown');
  const extra = [e.reason ? t('trip.tl.reason', { r: e.reason.label }) : '', e.note ?? ''].filter(
    Boolean,
  );
  return (
    <span
      data-testid="trip-event"
      className="tms-num"
      style={{ fontSize: 12, color: e.counted ? '#3B424C' : '#8F5500' }}
    >
      {t('trip.tl.ev', {
        ev,
        t: hm(e.occurredAt),
        by,
        src: t(`exc.src.${e.source}` as MessageKey),
      })}
      {extra.length > 0 && ` · ${extra.join(' · ')}`}
      {e.seqStatus === 'REDUNDANT' && (
        <Chip label={t('trip.tl.redundant')} c="#3B424C" bg="#ECEDEA" />
      )}
      {!e.counted && <Chip label={t('trip.tl.notCounted')} c="#8F5500" bg="#FCF0DC" />}
    </span>
  );
}

const nowBkk = () => toBangkok(new Date().toISOString());

/** ค่าที่ server คืน (event เดิมเมื่อส่งซ้ำ) ต่างจากที่ส่ง: เวลา / ผล / เหตุผล */
export function replayDiffers(e: StopEvent, s: StopEventStep): boolean {
  if (Date.parse(e.occurredAt) !== Date.parse(s.body.occurredAt)) return true;
  if (s.body.outcome && s.action === 'complete' && e.outcome !== s.body.outcome) return true;
  if ((s.body.reasonCodeId ?? null) !== (e.reason?.id ?? null)) return true;
  return false;
}

function TimeInputs({
  label,
  value,
  onChange,
}: {
  label: ReactNode;
  value: { date: string; time: string };
  onChange: (v: { date: string; time: string }) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
      <label className="tms-field" htmlFor={`${id}-d`}>
        <span className="tms-label">
          {t('trip.tl.dlg.date')} <span style={{ color: '#B3322A' }}>*</span>
        </span>
        <input
          id={`${id}-d`}
          type="date"
          className="tms-input"
          value={value.date}
          onChange={(e) => onChange({ ...value, date: e.target.value })}
        />
      </label>
      <label className="tms-field" htmlFor={`${id}-t`}>
        <span className="tms-label">
          {label} <span style={{ color: '#B3322A' }}>*</span>
        </span>
        <input
          id={`${id}-t`}
          type="time"
          className="tms-input"
          value={value.time}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
        />
      </label>
    </div>
  );
}

/**
 * dialog บันทึกแทนคนขับ (กรอบ `tms-dialog` ชุดเดียวกับ ReasonDialog) — เวลาเริ่ม = ตอนนี้ (เวลาไทย) แก้ย้อนได้
 * `clientEventId` สร้างครั้งเดียวตอนเปิด → กดซ้ำ/ลองใหม่หลัง error = server คืน event เดิม (ไม่เกิดซ้ำ)
 */
function RecordDialog({
  ask,
  events,
  onClose,
  onDone,
}: {
  ask: Ask;
  events: readonly StepEvent[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useI18n();
  const dt = useDateTimeText();
  const rec = useRecordStopEvents();
  const reasons = useReasonCodes();
  /**
   * clientEventId ต่อ (จุด, การกระทำ, ค่าในฟอร์ม): ลองใหม่ด้วยค่าเดิม = id เดิม (server คืน event เดิม ไม่เกิดซ้ำ)
   * · แก้ค่าหลังส่งไม่สำเร็จ/ไม่รู้ผล = id ใหม่ (review L1 — ไม่ถูกกลืนเป็นการส่งซ้ำของค่าเก่า)
   */
  const [ids] = useState(() => new Map<string, string>());
  const idFor = (stopId: string, action: string, values: object) => {
    const k = `${stopId}:${action}:${JSON.stringify(values)}`;
    if (!ids.has(k)) ids.set(k, crypto.randomUUID());
    return ids.get(k)!;
  };
  const floorMsg = (f: Floor, stop?: TripStop) =>
    t(stop ? 'trip.tl.err.beforeStop' : 'trip.tl.err.before', {
      what: t(`trip.tl.what.${f.what}` as MessageKey),
      t: dt(f.at),
      ...(stop ? { stop: stepTitle(t, stop) } : {}),
    });
  const [when, setWhen] = useState(nowBkk);
  const [arriveAt, setArriveAt] = useState(nowBkk);
  const [outcome, setOutcome] = useState<Outcome>('DELIVERED');
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEscapeLayer(true, onClose);

  const kind = ask.kind;
  const rule =
    kind === 'complete'
      ? reasonRule('complete', outcome)
      : kind === 'fail' || kind === 'failRest'
        ? reasonRule('fail', null)
        : null;
  const options = (reasons.data ?? []).filter(
    (r) => r.status === 'active' && !!rule && rule.categories.includes(r.category),
  );
  /** เหตุผลจัดกลุ่มตามหมวด (QA L2) */
  const groups = CATEGORIES.map((c) => ({ c, rs: options.filter((r) => r.category === c) })).filter(
    (g) => g.rs.length,
  );
  /** จุดรับไม่มี "ของยังอยู่บนรถ" (ของยังไม่ขึ้นรถ) */
  const outcomes =
    ask.kind === 'complete' && ask.stop.type === 'PICKUP'
      ? OUTCOMES.filter((o) => o !== 'UNDELIVERED_RETAIN')
      : OUTCOMES;
  const picked = options.find((r) => r.id === reasonId) ?? null;
  const needArrive = ask.kind === 'complete' && ask.needArrive;

  const title =
    kind === 'failRest'
      ? t('trip.tl.dlg.failRest', { n: ask.stops.length })
      : t(`trip.tl.dlg.${kind}` as MessageKey);
  const desc =
    ask.kind === 'failRest'
      ? t('trip.tl.dlg.failRestDesc', {
          stops: ask.stops.map((s) => stepTitle(t, s)).join(', '),
        })
      : ask.kind === 'depart'
        ? t('trip.tl.dlg.departDesc', { from: ask.from.siteName, to: ask.stop.siteName })
        : t('trip.tl.dlg.desc', { stop: stepTitle(t, ask.stop) });

  const submit = () => {
    if (rec.isPending) return;
    const at = fromBangkok(when.date, when.time);
    const arr = needArrive ? fromBangkok(arriveAt.date, arriveAt.time) : null;
    const te = timeError(needArrive ? [arr, at] : [at], new Date());
    if (te) {
      setErr(t(`trip.tl.err.${te}` as MessageKey));
      return;
    }
    // ไม่ก่อนเวลาที่บันทึกไว้แล้ว (กันสร้าง event ขัดลำดับเอง — review/QA M1)
    let floorErr: string | null = null;
    if (ask.kind === 'arrive') {
      const f = timeFloor('arrive', ask.stop.id, events);
      if (beforeFloor(at, f)) floorErr = floorMsg(f!);
    } else if (ask.kind === 'depart') {
      const f = timeFloor('depart', ask.from.id, events);
      if (beforeFloor(at, f)) floorErr = floorMsg(f!);
    } else if (ask.kind === 'complete' && needArrive) {
      const f = timeFloor('arrive', ask.stop.id, events);
      if (beforeFloor(arr, f)) floorErr = floorMsg(f!);
    } else if (ask.kind === 'complete' || ask.kind === 'fail') {
      const f = timeFloor('close', ask.stop.id, events);
      if (beforeFloor(at, f)) floorErr = floorMsg(f!);
    } else if (ask.kind === 'failRest') {
      for (const s of ask.stops) {
        const f = timeFloor('close', s.id, events);
        if (beforeFloor(at, f)) {
          floorErr = floorMsg(f!, s);
          break;
        }
      }
    }
    if (floorErr) {
      setErr(floorErr);
      return;
    }
    if (rule?.required && !picked) {
      setErr(t('trip.tl.err.reason'));
      return;
    }
    if (picked?.requiresNote && !note.trim()) {
      setErr(t('trip.tl.err.note'));
      return;
    }
    setErr(null);
    const extra = {
      ...(rule && picked ? { reasonCodeId: picked.id } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    let steps: StopEventStep[];
    let msg: string;
    switch (ask.kind) {
      case 'arrive':
      case 'depart':
        steps = [
          {
            stopId: ask.stop.id,
            action: ask.kind,
            body: { clientEventId: idFor(ask.stop.id, ask.kind, { at }), occurredAt: at! },
          },
        ];
        msg = t(`trip.tl.toast.${ask.kind}` as MessageKey, {
          site: ask.kind === 'depart' ? ask.from.siteName : ask.stop.siteName,
        });
        break;
      case 'complete':
        steps = [
          ...(needArrive
            ? [
                {
                  stopId: ask.stop.id,
                  action: 'arrive' as const,
                  body: { clientEventId: idFor(ask.stop.id, 'arrive', { arr }), occurredAt: arr! },
                },
              ]
            : []),
          {
            stopId: ask.stop.id,
            action: 'complete',
            body: {
              clientEventId: idFor(ask.stop.id, 'complete', { at, outcome, extra }),
              occurredAt: at!,
              outcome,
              ...extra,
            },
          },
        ];
        msg = t('trip.tl.toast.complete', { site: ask.stop.siteName });
        break;
      case 'fail':
        steps = [
          {
            stopId: ask.stop.id,
            action: 'fail',
            body: {
              clientEventId: idFor(ask.stop.id, 'fail', { at, extra }),
              occurredAt: at!,
              ...extra,
            },
          },
        ];
        msg = t('trip.tl.toast.fail', { site: ask.stop.siteName });
        break;
      case 'failRest':
        steps = ask.stops.map((s) => ({
          stopId: s.id,
          action: 'fail' as const,
          body: { clientEventId: idFor(s.id, 'fail', { at, extra }), occurredAt: at!, ...extra },
        }));
        msg = t('trip.tl.toast.failRest', { n: ask.stops.length });
        break;
    }
    rec.mutate(steps, {
      onSuccess: (out: StopEvent[]) => {
        // server คืน event เดิม (ส่งซ้ำ) แต่ค่าไม่ตรงกับฟอร์ม → เตือน ไม่ขึ้นว่าสำเร็จ (review L1)
        if (out.some((e, i) => replayDiffers(e, steps[i]!))) {
          setErr(t('trip.tl.err.replayDiff'));
          return;
        }
        onDone(out.some((e) => e.flags.length) ? t('trip.tl.toast.flagged', { m: msg }) : msg);
      },
      onError: (e) => {
        const done = (e as { done?: number }).done ?? 0;
        const base = problemText(e, t) ?? '';
        setErr(
          steps.length > 1 && done > 0
            ? `${base} · ${t('trip.tl.err.partial', { done, n: steps.length })}`
            : base,
        );
      },
    });
  };

  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{title}</h2>
            <p className="tms-dialog__desc">{desc}</p>
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
          {needArrive && (
            <TimeInputs
              label={t('trip.tl.dlg.arriveTime')}
              value={arriveAt}
              onChange={setArriveAt}
            />
          )}
          <TimeInputs
            label={t(kind === 'complete' ? 'trip.tl.dlg.closeTime' : 'trip.tl.dlg.time')}
            value={when}
            onChange={setWhen}
          />
          <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('trip.tl.dlg.backdate')}</span>
          {ask.kind === 'complete' && (
            <ChoiceGroup
              label={t('trip.tl.dlg.outcome')}
              options={outcomes.map((o) => ({ value: o, label: outLabel(t, ask.stop.type, o) }))}
              value={outcome}
              onChange={(o) => {
                setOutcome(o);
                setReasonId('');
              }}
            />
          )}
          {rule && (
            <label className="tms-field">
              <span className="tms-label">
                {t('trip.tl.dlg.reason')}
                {rule.required && <span style={{ color: '#B3322A' }}> *</span>}
              </span>
              <select
                className="tms-select"
                value={reasonId}
                onChange={(e) => setReasonId(e.target.value)}
              >
                <option value="">{t('trip.tl.dlg.pickReason')}</option>
                {groups.map((g) => (
                  <optgroup key={g.c} label={t(`rsn.cat.${g.c}` as MessageKey)}>
                    {g.rs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {reasons.isError && (
                <span className="tms-field-error">{t('trip.tl.err.reasons')}</span>
              )}
            </label>
          )}
          {rule && (
            <label className="tms-field">
              <span className="tms-label">
                {t('trip.tl.dlg.note')}
                {picked?.requiresNote && <span style={{ color: '#B3322A' }}> *</span>}
              </span>
              <textarea
                className="tms-textarea"
                rows={2}
                maxLength={500}
                value={note}
                placeholder={t('trip.tl.dlg.notePh')}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          )}
          {err && (
            <span className="tms-field-error" role="alert">
              {err}
            </span>
          )}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('trip.tl.dlg.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={rec.isPending}
            onClick={submit}
          >
            {t('trip.tl.dlg.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
