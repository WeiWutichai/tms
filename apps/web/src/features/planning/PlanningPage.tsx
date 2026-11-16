import { Button, EmptyState, Icon, StatusTabs, SummaryStrip, Toast } from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, unwrap } from '../../api';
import { formatDayHead, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { useSessionState } from '../master/useCursorList';
import { HoldBadge, holdLabel } from '../orders/HoldPage';
import { OrderDrawer } from '../orders/OrderDrawer';
import { OrderFormDrawer } from '../orders/OrderFormDrawer';
import { fromOrder, type Order, type OrderForm } from '../orders/orderForm';
import { bangkokToday, useDateText } from '../rate-cards/rateFormat';
import {
  addDays,
  axisBox,
  boardStats,
  CLASH,
  custShort,
  DAY_HOURS,
  DAY_START,
  dayDiff,
  fmtNum,
  hhmm,
  hourAt,
  hourOf,
  isoAt,
  kg,
  LANE_H,
  lanes,
  movable,
  movedWindow,
  onDay,
  placeText,
  POOL_FILTER,
  poolOptions,
  poolView,
  resizedWindow,
  rowLoad,
  scheduleBody,
  span,
  STATUS_COLOR,
  tripColor,
  dropWindow,
  weekDropWindow,
  type BoardTrip,
  type BoardVehicle,
  type PoolFilter,
  type PoolOrder,
} from './board';
import { useBoard, useDropOrder, useMoveTrip, type Trip } from './usePlanning';

type Tab = 'today' | 'tomorrow' | '7d';
type Drag =
  { kind: 'order'; id: string } | { kind: 'trip'; id: string; day: string; grab: number } | null;
interface Resize {
  id: string;
  edge: 's' | 'e';
  day: string;
  left: number;
  width: number;
  s0: number;
  e0: number;
  s: number;
  e: number;
}

const CARD_SHADOW = '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)';
const PANEL: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #CDD1C8',
  borderRadius: 12,
  boxShadow: CARD_SHADOW,
};
const SELECT: CSSProperties = {
  height: 32,
  padding: '0 8px',
  border: '1px solid #CDD1C8',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  fontSize: 13,
  minWidth: 0,
};
const ELL: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const HATCH = 'repeating-linear-gradient(135deg,rgba(179,50,42,.18) 0 2px,transparent 2px 5px)';
const GRID =
  'repeating-linear-gradient(90deg,transparent 0,transparent calc(100% / 14 - 1px),#EBEDE8 calc(100% / 14 - 1px),#EBEDE8 calc(100% / 14))';
const RING_OK = 'inset 0 0 0 2px #17733F';
const RING_BAD = 'inset 0 0 0 2px #B3322A';
/** legend ตามสถานะเที่ยว (spec/03 §5 — สีสถานะ) + ซ้อนเวลา (docs/04 D2) */
const LEGEND: { c: string; k: MessageKey }[] = [
  { c: STATUS_COLOR.PLANNING!, k: 'plan.lg.PLANNING' },
  { c: STATUS_COLOR.ASSIGNED!, k: 'plan.lg.ASSIGNED' },
  { c: STATUS_COLOR.DISPATCHED!, k: 'plan.lg.DISPATCHED' },
  { c: STATUS_COLOR.IN_PROGRESS!, k: 'plan.lg.IN_PROGRESS' },
  { c: STATUS_COLOR.COMPLETED!, k: 'plan.lg.COMPLETED' },
  { c: CLASH, k: 'plan.lg.clash' },
];

/** ชั่วโมงทศนิยมของตอนนี้ (เวลาไทย) — อัปเดตทุก 1 นาที (spec/03 §5 เส้น "ตอนนี้") */
function useNowHour(): number {
  const calc = () => {
    const d = new Date(Date.now() + 7 * 3_600_000);
    return d.getUTCHours() + d.getUTCMinutes() / 60;
  };
  const [h, setH] = useState(calc);
  useEffect(() => {
    const id = setInterval(() => setH(calc()), 60_000);
    return () => clearInterval(id);
  }, []);
  return h;
}

const soText = (t: BoardTrip) => t.orders.map((o) => o.orderNo).join(', ') || t.tripNo;
const custText = (t: BoardTrip) => t.orders[0]?.customerName ?? '—';
const routeText = (t: BoardTrip) => `${placeText(t.origin)} → ${placeText(t.dest)}`;
const licence = (tr: T, c: string | null) =>
  c
    ? tr(`vt.lic.${c}` as MessageKey) === `vt.lic.${c}`
      ? c
      : tr(`vt.lic.${c}` as MessageKey)
    : '';

/**
 * ปฏิบัติการ → กระดานวางแผน (ST3-T12; docs/04 D2; spec/03 §5) — ต้นแบบ TMS v4 `is.plan` / vPlan:
 * หัว + แถบสรุป + แท็บ วันนี้/พรุ่งนี้/7 วัน + "SO รอจัด" ซ้าย (340px) / timeline รถ ขวา + แถบสรุปล่าง
 * ลาก SO ลงแถวรถ = สร้างเที่ยว PLANNING (POST /v1/trips + vehicleId) · ลากเที่ยว = ย้ายเวลา/รถ · ลากขอบ = ปรับเวลา
 * (POST /v1/trips/{id}/schedule) · ซ้อนเวลาบนรถเดียว = แถบแดง + "เวลาชนกัน" แต่บันทึกได้ (คำเตือน ไม่บล็อก)
 * ยังไม่ทำ (task อื่น): ส่งแผนให้คนขับ (T17/T18), เสนอรถ (P1), กำหนดคนขับ/ห้ามจ่ายงาน/ขออนุมัติ/ย้ายไปรถอื่น (T14),
 * มุมมองตามคนขับ/รถร่วม (T13), เน้นรถที่รับได้ (T15)
 */
export function PlanningPage() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useMe();
  const dateText = useDateText();
  const scopes = me.data?.scopes ?? [];
  const canPlan = can(scopes, 'trips:assign');
  const canWrite = can(scopes, 'orders:write');
  const canCancel = can(scopes, 'orders:cancel');
  const canSeePrice = can(scopes, 'prices.sell:read');
  const canEditPrice = can(scopes, 'prices.sell:write');
  const canUnlock = can(scopes, 'orders:unlock');
  const today = bangkokToday();
  const [tab, setTab] = useSessionState<Tab>('plan.tab', 'today');
  const [pf, setPf] = useSessionState<PoolFilter>('plan.pool', POOL_FILTER);
  const board = useBoard(today, 7);
  const drop = useDropOrder();
  const move = useMoveTrip();
  const nowH = useNowHour();
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<{ v: string; d: string } | null>(null);
  const [resize, setResize] = useState<Resize | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  const [pop, setPop] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ key: number; initial: OrderForm; order: Order } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const b = board.data;
  const day0 = b?.today ?? today;
  const week = tab === '7d';
  const days = useMemo(
    () =>
      week
        ? Array.from({ length: 7 }, (_, i) => addDays(day0, i))
        : [tab === 'tomorrow' ? addDays(day0, 1) : day0],
    [week, tab, day0],
  );
  const dsel = days[0]!;
  const prefixes = t('plan.custPrefixes');
  const tripsBy = useMemo(() => {
    const m = new Map<string, BoardTrip[]>();
    for (const x of b?.trips ?? [])
      if (x.vehicleId) m.set(x.vehicleId, [...(m.get(x.vehicleId) ?? []), x]);
    return m;
  }, [b]);
  const pool = useMemo(() => (b ? poolView(b.pool, pf, day0) : []), [b, pf, day0]);
  const opts = useMemo(() => poolOptions(b?.pool ?? []), [b]);
  const stats = b ? boardStats(b, days) : null;
  const tabCount = (ds: string[]) =>
    b ? b.trips.filter((x) => x.vehicleId && ds.some((d) => onDay(x, d))).length : undefined;

  // ---------------------------------------------------------------- ลากวาง
  const orderOf = (id: string) => b?.pool.find((o) => o.id === id);
  const tripOf = (id: string) => b?.trips.find((x) => x.id === id);
  const vehOf = (id: string | null) => b?.vehicles.find((v) => v.id === id);
  /** เหตุที่วางไม่ได้ของสิ่งที่กำลังลาก (กฎเต็มฝั่ง client = ST3-T14/T15; server ตรวจซ้ำเสมอ — PLN-042) */
  const badOf = (d: Drag): string => {
    if (!d || !canPlan) return '';
    if (d.kind === 'order') return orderOf(d.id)?.sourceChangePending ? t('plan.bad.source') : '';
    const x = tripOf(d.id);
    return x && !movable(x) ? t('plan.bad.locked', { no: x.tripNo }) : '';
  };
  const bad = badOf(drag);
  const ringOf = (v: string, d: string) =>
    drag && over && over.v === v && over.d === d ? (bad ? RING_BAD : RING_OK) : 'none';
  const dragOver = (v: string, d: string) => (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = bad ? 'none' : 'move';
    if (!over || over.v !== v || over.d !== d) setOver({ v, d });
  };
  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const fail = (err: unknown) => setToast(t('plan.cantDrop', { m: problemText(err, t) ?? '' }));
  const issueText = (x: Trip) => {
    const w = x.warnings?.[0];
    if (!w) return null;
    return w.code === 'vehicle_overlap' ? t('plan.clash') : w.message;
  };

  /** ปล่อยบนแถวรถ `v` วัน `d` — `hour` = ชั่วโมงที่ปล่อย (มุมมองวันนี้) หรือ null (มุมมอง 7 วัน) */
  const onDropAt = (v: BoardVehicle, d: string, hour: number | null) => {
    const cur = drag;
    endDrag();
    if (!cur || !canPlan) return;
    const why = badOf(cur);
    if (why) return setToast(t('plan.cantDrop', { m: why }));
    const own = tripsBy.get(v.id) ?? [];
    if (cur.kind === 'order') {
      const o = orderOf(cur.id);
      if (!o) return;
      const w = hour === null ? weekDropWindow(own, d) : dropWindow(hour);
      drop.mutate(
        {
          idempotencyKey: crypto.randomUUID(),
          body: {
            tripDate: d,
            deliveryOrderIds: o.deliveryOrders.map((x) => x.id),
            vehicleId: v.id,
            plannedStartAt: isoAt(d, w.s),
            plannedEndAt: isoAt(d, w.e),
          },
        },
        {
          onSuccess: (x) => {
            const m = t('plan.toast.assigned', { so: o.orderNo, plate: v.plate });
            const i = issueText(x);
            setToast(i ? t('plan.toast.issue', { m, i }) : m);
          },
          onError: fail,
        },
      );
      return;
    }
    const x = tripOf(cur.id);
    if (!x) return;
    const sp = span(x, cur.day);
    const w =
      hour === null
        ? { s: sp.s + 24 * dayDiff(cur.day, d), e: sp.e + 24 * dayDiff(cur.day, d) }
        : movedWindow(x, cur.day, hour + 24 * dayDiff(cur.day, d), cur.grab);
    const body = scheduleBody(cur.day, w.s, w.e);
    const changeVeh = v.id !== x.vehicleId;
    if (
      !changeVeh &&
      body.plannedStartAt === x.plannedStartAt &&
      body.plannedEndAt === x.plannedEndAt
    )
      return;
    move.mutate(
      {
        id: x.id,
        version: x.version,
        status: x.status,
        ...(changeVeh ? { vehicleId: v.id } : {}),
        body,
      },
      {
        onSuccess: (r) => {
          const m = changeVeh
            ? t('plan.toast.moved', {
                so: soText(x),
                from: x.vehiclePlate ?? '—',
                to: v.plate,
              })
            : t('plan.toast.time', {
                so: soText(x),
                t: `${hhmm(hourOf(body.plannedStartAt, d))}–${hhmm(hourOf(body.plannedEndAt, d))}`,
              });
          const i = issueText(r);
          setToast(i ? t('plan.toast.issue', { m, i }) : m);
        },
        onError: fail,
      },
    );
  };

  // ---------------------------------------------------------------- ปรับขนาด (ลากขอบ)
  useEffect(() => {
    if (!resize) return;
    const mv = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const w = resizedWindow(r.s0, r.e0, r.edge, hourAt((e.clientX - r.left) / r.width));
      resizeRef.current = { ...r, ...w };
      setResize(resizeRef.current);
    };
    const up = () => {
      const r = resizeRef.current;
      resizeRef.current = null;
      setResize(null);
      const x = r && tripOf(r.id);
      if (!r || !x || (r.s === r.s0 && r.e === r.e0)) return;
      const body = scheduleBody(r.day, r.s, r.e);
      move.mutate(
        { id: x.id, version: x.version, status: x.status, body },
        {
          onSuccess: (res) => {
            const m = t('plan.toast.time', { so: soText(x), t: `${hhmm(r.s)}–${hhmm(r.e)}` });
            const i = issueText(res);
            setToast(i ? t('plan.toast.issue', { m, i }) : m);
          },
          onError: fail,
        },
      );
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up, { once: true });
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resize?.id, resize?.edge]);

  const startResize = (x: BoardTrip, edge: 's' | 'e', d: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const track = (e.currentTarget as HTMLElement).closest('[data-track]') as HTMLElement | null;
    if (!track) return;
    const rc = track.getBoundingClientRect();
    const sp = span(x, d);
    resizeRef.current = {
      id: x.id,
      edge,
      day: d,
      left: rc.left,
      width: rc.width,
      s0: sp.s,
      e0: sp.e,
      s: sp.s,
      e: sp.e,
    };
    setResize(resizeRef.current);
  };

  // ---------------------------------------------------------------- SO drawer
  const openEdit = (o: Order) => setForm({ key: Date.now(), initial: fromOrder(o), order: o });
  const reloadEdit = async (id: string) => {
    const o = (await unwrap(api.GET('/v1/orders/{id}', { params: { path: { id } } }))) as Order;
    qc.setQueryData(['orders', 'one', id], o);
    openEdit(o);
  };

  // ---------------------------------------------------------------- ส่วนแสดงผล
  /** ทะเบียน + ตัวย่อจังหวัด (ต้นแบบ "70-1234 กทม.") */
  const plateText = (v: BoardVehicle) => {
    const k = `provAbbr.${v.plateProvince}` as MessageKey;
    return t(k) === k ? v.plate : `${v.plate} ${t(k)}`;
  };
  const vehicleCell = (v: BoardVehicle, load: number) => {
    const cap = kg(v.capacityKg);
    const overCap = cap > 0 && load > cap;
    return (
      <div
        style={{
          position: 'relative',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0,
          borderRight: '1px solid #E4E6E0',
          background: '#FFFFFF',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span className="tms-num" style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
            {plateText(v)}
          </span>
          <span style={{ fontSize: 13, color: '#3B424C', whiteSpace: 'nowrap' }}>
            {v.vehicleTypeName}
          </span>
        </div>
        {v.ownership === 'SUBCONTRACT' ? (
          <span style={{ fontSize: 13, color: '#3B424C', ...ELL }}>
            {t('plan.subcon', { n: v.carrierName ?? '—' })}
          </span>
        ) : v.driver ? (
          <span style={{ fontSize: 13, color: '#3B424C', ...ELL }}>
            {t('plan.driver', { n: v.driver.name, l: licence(t, v.driver.licenceClass) })}
          </span>
        ) : (
          <span style={{ fontSize: 13, color: '#8F5500', whiteSpace: 'nowrap' }}>
            {t('plan.noDriver')}
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: '#EBEDE8',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${cap > 0 ? Math.min(100, (load / cap) * 100).toFixed(0) : 0}%`,
                background: overCap ? '#B3322A' : '#2257C4',
              }}
            />
          </div>
          <span
            className="tms-num"
            style={{ fontSize: 12.5, color: overCap ? '#B3322A' : '#3B424C', whiteSpace: 'nowrap' }}
          >
            {cap > 0
              ? t('plan.load', { w: fmtNum(load), c: fmtNum(cap) })
              : t('plan.kg', { n: fmtNum(load) })}
          </span>
        </div>
      </div>
    );
  };

  const capOf = (x: BoardTrip) => kg(vehOf(x.vehicleId)?.capacityKg);
  const weightLine = (x: BoardTrip) => {
    const cap = capOf(x);
    const w = kg(x.weightKg);
    return {
      text:
        cap > 0 ? t('plan.load', { w: fmtNum(w), c: fmtNum(cap) }) : t('plan.kg', { n: fmtNum(w) }),
      color: cap > 0 && w > cap ? '#B3322A' : '#3B424C',
      short: t('plan.kg', { n: fmtNum(w) }),
    };
  };
  const timeText = (x: BoardTrip, d: string) => {
    const sp = resize?.id === x.id ? resize : span(x, d);
    return `${hhmm(sp.s)}–${hhmm(sp.e)}`;
  };
  const tipOf = (x: BoardTrip, d: string) =>
    [
      `${soText(x)} · ${custText(x)}`,
      `${timeText(x, d)} · ${routeText(x)}`,
      weightLine(x).text,
      ...(x.overlapsWith.length ? [`${t('plan.clash')}: ${x.overlapsWith.join(', ')}`] : []),
    ].join('\n');
  const tripDragStart = (x: BoardTrip, d: string) => (e: DragEvent<HTMLDivElement>) => {
    const track = e.currentTarget.closest('[data-track]') as HTMLElement | null;
    let grab = 0;
    if (track && !week) {
      const rc = track.getBoundingClientRect();
      grab = hourAt((e.clientX - rc.left) / rc.width) - span(x, d).s;
    }
    e.dataTransfer.setData('text/plain', x.id);
    e.dataTransfer.effectAllowed = 'move';
    setPop(null);
    setDrag({ kind: 'trip', id: x.id, day: d, grab });
  };
  const clashBadge = (
    <span
      style={{
        alignSelf: 'flex-start',
        marginTop: 3,
        height: 22,
        padding: '0 8px',
        borderRadius: 999,
        background: '#FCF0DC',
        color: '#8F5500',
        fontSize: 12,
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon n="clock-alert" s={12} />
      {t('plan.clash')}
    </span>
  );

  const dayRow = (v: BoardVehicle) => {
    const ts = (tripsBy.get(v.id) ?? []).filter((x) => onDay(x, dsel));
    const items = ts.map((x) => {
      const sp = resize?.id === x.id ? resize : span(x, dsel);
      return { id: x.id, s: sp.s, e: sp.e, x };
    });
    const ln = lanes(items);
    const showNow = tab === 'today' && nowH >= DAY_START && nowH < DAY_START + DAY_HOURS;
    return (
      <div
        key={v.id}
        data-testid={`plan-row-${v.plate}`}
        style={{
          display: 'grid',
          gridTemplateColumns: '220px minmax(0,1fr)',
          borderBottom: '1px solid #E4E6E0',
        }}
      >
        {vehicleCell(v, rowLoad(ts))}
        <div
          data-track
          data-testid={`plan-track-${v.plate}`}
          onDragOver={dragOver(v.id, dsel)}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            const rc = e.currentTarget.getBoundingClientRect();
            onDropAt(v, dsel, hourAt((e.clientX - rc.left) / rc.width));
          }}
          title={over?.v === v.id ? bad : undefined}
          style={{
            position: 'relative',
            minHeight: ln.count * LANE_H + 16,
            background: GRID,
            boxShadow: ringOf(v.id, dsel),
          }}
        >
          {showNow && (
            <span
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${((nowH - DAY_START) / DAY_HOURS) * 100}%`,
                width: 2,
                background: '#B3322A',
                opacity: 0.6,
                zIndex: 2,
                pointerEvents: 'none',
              }}
            />
          )}
          {items.map(({ id, s, e, x }) => {
            const box = axisBox(s, e);
            const wl = weightLine(x);
            const canMove = canPlan && movable(x);
            return (
              <div
                key={id}
                data-testid={`plan-trip-${x.tripNo}`}
                data-clash={x.overlapsWith.length > 0 ? 'true' : 'false'}
                style={{
                  position: 'absolute',
                  top: 8 + ln.lane[id]! * LANE_H,
                  height: 100,
                  left: `${box.left * 100}%`,
                  width: `${box.width * 100}%`,
                  padding: '0 3px',
                  boxSizing: 'border-box',
                  zIndex: 1,
                  minWidth: 0,
                  opacity: drag?.kind === 'trip' && drag.id === id ? 0.5 : 1,
                }}
              >
                <div
                  draggable={canMove}
                  onDragStart={tripDragStart(x, dsel)}
                  onDragEnd={endDrag}
                  onClick={() => x.orders[0] && setOpenId(x.orders[0].id)}
                  title={tipOf(x, dsel)}
                  className="tms-plan-card"
                  style={{
                    height: '100%',
                    boxSizing: 'border-box',
                    background: '#FFFFFF',
                    border: '1px solid #CDD1C8',
                    borderLeft: `3px solid ${tripColor(x)}`,
                    borderRadius: 8,
                    padding: '6px 8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                    overflow: 'hidden',
                    boxShadow: '0 1px 2px rgba(16,20,24,.06)',
                    cursor: canMove ? 'grab' : 'pointer',
                    minWidth: 0,
                  }}
                >
                  <div style={{ ...ELL, lineHeight: 1.45 }}>
                    <span className="tms-num" style={{ color: '#2257C4', fontWeight: 500 }}>
                      {soText(x)}
                    </span>{' '}
                    · {custText(x)}
                  </div>
                  <div
                    className="tms-num"
                    style={{ fontSize: 12.5, color: '#3B424C', ...ELL, lineHeight: 1.45 }}
                  >
                    {timeText(x, dsel)} · {routeText(x)}
                  </div>
                  <div
                    className="tms-num"
                    style={{ fontSize: 12.5, color: wl.color, ...ELL, lineHeight: 1.45 }}
                  >
                    {wl.text}
                  </div>
                  {x.overlapsWith.length > 0 && clashBadge}
                </div>
                {canMove && (
                  <>
                    <span
                      role="separator"
                      aria-label={t('plan.resize.s')}
                      data-testid={`plan-resize-s-${x.tripNo}`}
                      onMouseDown={startResize(x, 's', dsel)}
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: 8,
                        cursor: 'ew-resize',
                        zIndex: 2,
                      }}
                    />
                    <span
                      role="separator"
                      aria-label={t('plan.resize.e')}
                      data-testid={`plan-resize-e-${x.tripNo}`}
                      onMouseDown={startResize(x, 'e', dsel)}
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: 0,
                        bottom: 0,
                        width: 8,
                        cursor: 'ew-resize',
                        zIndex: 2,
                      }}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const weekRow = (v: BoardVehicle) => {
    const own = tripsBy.get(v.id) ?? [];
    const load = rowLoad(own.filter((x) => days.some((d) => onDay(x, d))));
    return (
      <div
        key={v.id}
        data-testid={`plan-row-${v.plate}`}
        style={{
          display: 'grid',
          gridTemplateColumns: '220px repeat(7,minmax(130px,1fr))',
          borderBottom: '1px solid #E4E6E0',
        }}
      >
        {vehicleCell(v, load)}
        {days.map((d) => {
          const ts = own.filter((x) => onDay(x, d)).sort((a, c) => span(a, d).s - span(c, d).s);
          return (
            <div
              key={d}
              data-testid={`plan-cell-${v.plate}-${d}`}
              onDragOver={dragOver(v.id, d)}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                onDropAt(v, d, null);
              }}
              title={over?.v === v.id && over.d === d ? bad : undefined}
              style={{
                borderLeft: '1px solid #E4E6E0',
                padding: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                background: d === day0 ? '#F7F8F5' : '#FFFFFF',
                boxShadow: ringOf(v.id, d),
                minWidth: 0,
                minHeight: 96,
              }}
            >
              {ts.map((x) => {
                const wl = weightLine(x);
                const canMove = canPlan && movable(x);
                const key = `${x.id}:${d}`;
                return (
                  <div key={x.id} style={{ position: 'relative' }}>
                    <div
                      data-testid={`plan-trip-${x.tripNo}`}
                      data-clash={x.overlapsWith.length > 0 ? 'true' : 'false'}
                      draggable={canMove}
                      onDragStart={tripDragStart(x, d)}
                      onDragEnd={endDrag}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPop((p) => (p === key ? null : key));
                      }}
                      title={tipOf(x, d)}
                      className="tms-plan-card"
                      style={{
                        background: '#FFFFFF',
                        border: '1px solid #CDD1C8',
                        borderLeft: `3px solid ${tripColor(x)}`,
                        borderRadius: 8,
                        padding: '6px 8px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                        boxShadow: '0 1px 2px rgba(16,20,24,.06)',
                        cursor: canMove ? 'grab' : 'pointer',
                        minWidth: 0,
                        opacity: drag?.kind === 'trip' && drag.id === x.id ? 0.5 : 1,
                      }}
                    >
                      <span
                        className="tms-num"
                        style={{
                          color: '#2257C4',
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                          lineHeight: 1.45,
                        }}
                      >
                        {soText(x)}
                      </span>
                      <span
                        style={{
                          fontSize: 12.5,
                          color: '#101418',
                          lineHeight: 1.45,
                          overflowWrap: 'normal',
                          wordBreak: 'normal',
                        }}
                      >
                        {custShort(custText(x), prefixes)}
                      </span>
                      <span
                        className="tms-num"
                        style={{
                          fontSize: 12.5,
                          color: wl.color,
                          lineHeight: 1.45,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {wl.short}
                      </span>
                      {x.overlapsWith.length > 0 && (
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: '#8F5500',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {t('plan.clash')}
                        </span>
                      )}
                    </div>
                    {pop === key && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          setPop(null);
                        }}
                        style={{
                          position: 'absolute',
                          top: 'calc(100% + 4px)',
                          left: 0,
                          zIndex: 20,
                          width: 260,
                          background: '#FFFFFF',
                          border: '1px solid #CDD1C8',
                          borderRadius: 10,
                          boxShadow: '0 8px 24px rgba(16,20,24,.12)',
                          padding: 12,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          cursor: 'default',
                        }}
                      >
                        <span>
                          <span className="tms-num" style={{ color: '#2257C4', fontWeight: 600 }}>
                            {soText(x)}
                          </span>{' '}
                          · {custText(x)}
                        </span>
                        <span className="tms-num" style={{ fontSize: 12.5, color: '#3B424C' }}>
                          {timeText(x, d)} · {routeText(x)}
                        </span>
                        <span className="tms-num" style={{ fontSize: 12.5, color: wl.color }}>
                          {wl.text}
                        </span>
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                            marginTop: 6,
                            paddingTop: 8,
                            borderTop: '1px solid #E4E6E0',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => x.orders[0] && setOpenId(x.orders[0].id)}
                            style={{
                              border: 0,
                              background: 'transparent',
                              padding: 0,
                              color: '#2257C4',
                              fontSize: 13,
                              fontWeight: 600,
                              cursor: 'pointer',
                              textAlign: 'left',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('plan.pop.open')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  const poolCard = (o: PoolOrder) => {
    const late = o.requestedDate < day0;
    const route = `${placeText(o.origin)} → ${placeText(o.dest)}`;
    const w = fmtNum(kg(o.weightKg));
    return (
      <div
        key={o.id}
        data-testid={`plan-pool-${o.orderNo}`}
        draggable={canPlan}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', o.id);
          e.dataTransfer.effectAllowed = 'move';
          setDrag({ kind: 'order', id: o.id });
        }}
        onDragEnd={endDrag}
        onClick={() => setOpenId(o.id)}
        title={[
          `${o.orderNo} · ${o.customerName ?? '—'}`,
          route,
          dateText(o.requestedDate) + (late ? t('plan.pool.over') : ''),
          t('plan.kg', { n: w }),
        ].join('\n')}
        className="tms-plan-card"
        style={{
          background: '#FFFFFF',
          border: '1px solid #CDD1C8',
          borderLeft: `3px solid ${late ? '#B3322A' : '#2257C4'}`,
          borderRadius: 8,
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          cursor: canPlan ? 'grab' : 'pointer',
          opacity: drag?.kind === 'order' && drag.id === o.id ? 0.5 : 1,
          boxShadow: '0 1px 2px rgba(16,20,24,.06)',
          minWidth: 0,
        }}
      >
        <div style={{ ...ELL, lineHeight: 1.45 }}>
          <span className="tms-num" style={{ color: '#2257C4', fontWeight: 500 }}>
            {o.orderNo}
          </span>{' '}
          · {o.customerName ?? '—'}
        </div>
        <div style={{ fontSize: 12.5, color: '#3B424C', ...ELL, lineHeight: 1.45 }}>
          {t('plan.pool.l2', { d: dateText(o.requestedDate), r: route })}
          {late && <span style={{ color: '#B3322A', fontWeight: 600 }}>{t('plan.pool.over')}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="tms-num"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              color: '#3B424C',
              ...ELL,
              lineHeight: 1.45,
            }}
          >
            {o.vehicleTypeName
              ? t('plan.pool.need', { w, vt: o.vehicleTypeName })
              : t('plan.kg', { n: w })}
          </span>
          {/* ป้ายเหตุค้าง (docs/04 D2 "badge reason code" — ต้นแบบไม่มี; spec/12 §3 ST3-T12) */}
          {(o.sourceChangePending || o.holdReason) && (
            <HoldBadge
              code={o.sourceChangePending ? 'SOURCE_CHANGED_AFTER_PLAN' : o.holdReason!}
              label={holdLabel(
                t,
                o.sourceChangePending ? 'SOURCE_CHANGED_AFTER_PLAN' : o.holdReason!,
              )}
            />
          )}
        </div>
      </div>
    );
  };

  const nowL = `${((nowH - DAY_START) / DAY_HOURS) * 100}%`;
  const showNowPill = tab === 'today' && nowH >= DAY_START && nowH < DAY_START + DAY_HOURS;
  const skeleton = (h: number, n: number) =>
    Array.from({ length: n }, (_, i) => (
      <div key={i} style={{ height: h, borderRadius: 8, background: '#F4F5F2' }} />
    ));

  return (
    <>
      <PageHeader title={t('page.plan.title')} sub={t('page.plan.sub')} />
      <SummaryStrip
        items={[
          { value: stats?.pend ?? '—', label: t('plan.kpi.pend'), color: '#8F5500' },
          { value: stats?.free ?? '—', label: t('plan.kpi.free'), color: '#17733F' },
          { value: stats ? fmtNum(stats.w) : '—', label: t('plan.kpi.weight'), color: '#101418' },
          { value: stats ? fmtNum(stats.km) : '—', label: t('plan.kpi.km'), color: '#2257C4' },
        ]}
      />
      <StatusTabs
        value={tab}
        onChange={(k) => {
          setTab(k as Tab);
          setPop(null);
        }}
        items={[
          { key: 'today', label: t('plan.tab.today'), count: tabCount([day0]) },
          { key: 'tomorrow', label: t('plan.tab.tomorrow'), count: tabCount([addDays(day0, 1)]) },
          {
            key: '7d',
            label: t('plan.tab.week'),
            count: tabCount(Array.from({ length: 7 }, (_, i) => addDays(day0, i))),
          },
        ].map((x) => (x.count === undefined ? { key: x.key, label: x.label } : x))}
      />
      <div
        onClick={() => setPop(null)}
        style={{
          display: 'grid',
          gridTemplateColumns: '340px minmax(0,1fr)',
          gridTemplateRows: 'minmax(0,1fr)',
          gap: 20,
          alignItems: 'stretch',
          flex: '1 1 0',
          minHeight: 'max(520px,calc(100vh - 360px))',
          maxHeight: 'calc(100vh - 104px)',
        }}
      >
        <section
          aria-label={t('plan.pool.title')}
          style={{
            ...PANEL,
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid #E4E6E0',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {t('plan.pool.title')}
              </h2>
              <span
                className="tms-num"
                style={{
                  minWidth: 22,
                  height: 20,
                  padding: '0 7px',
                  borderRadius: 999,
                  background: '#FFFFFF',
                  border: '1px solid #D9DCD4',
                  color: '#3B424C',
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxSizing: 'border-box',
                }}
              >
                {b?.pool.length ?? '—'}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 12.5,
                  color: '#59606B',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('plan.pool.hint')}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <select
                aria-label={t('plan.f.day')}
                value={pf.d}
                onChange={(e) => setPf((f) => ({ ...f, d: e.target.value as PoolFilter['d'] }))}
                style={{ ...SELECT, gridColumn: 'span 2' }}
              >
                <option value="all">{t('plan.f.all')}</option>
                <option value="today">{t('plan.f.today')}</option>
                <option value="tomorrow">{t('plan.f.tomorrow')}</option>
              </select>
              <select
                aria-label={t('plan.f.vt')}
                value={pf.vt}
                onChange={(e) => setPf((f) => ({ ...f, vt: e.target.value }))}
                style={SELECT}
              >
                <option value="">{t('plan.f.allVt')}</option>
                {opts.vt.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('plan.f.cust')}
                value={pf.c}
                onChange={(e) => setPf((f) => ({ ...f, c: e.target.value }))}
                style={SELECT}
              >
                <option value="">{t('plan.f.allCust')}</option>
                {opts.c.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div
            style={{
              overflowY: 'auto',
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {board.isLoading ? (
              skeleton(64, 4)
            ) : board.isError ? null : pool.length ? (
              pool.map(poolCard)
            ) : (
              <div
                style={{
                  padding: '40px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'center',
                }}
              >
                <Icon n="inbox" s={40} style={{ color: '#C9CDC3' }} />
                <div style={{ fontSize: 15, fontWeight: 600 }}>{t('plan.empty.title')}</div>
                <div style={{ color: '#3B424C' }}>{t('plan.empty.desc')}</div>
                <button
                  type="button"
                  onClick={() => nav('/so')}
                  style={{
                    marginTop: 6,
                    height: 36,
                    padding: '0 14px',
                    border: '1px solid #9DB6E3',
                    borderRadius: 999,
                    background: '#FFFFFF',
                    color: '#2257C4',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {t('plan.empty.go')}
                </button>
              </div>
            )}
          </div>
        </section>
        <section
          aria-label={t('page.plan.title')}
          style={{
            ...PANEL,
            overflow: 'auto',
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              position: 'sticky',
              left: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              padding: '10px 16px',
              borderBottom: '1px solid #E4E6E0',
              flexWrap: 'wrap',
              flexShrink: 0,
              background: '#FFFFFF',
            }}
          >
            {LEGEND.map((lg) => (
              <span
                key={lg.k}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12.5,
                  color: '#3B424C',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ width: 3, height: 14, borderRadius: 2, background: lg.c }} />
                {t(lg.k)}
              </span>
            ))}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12.5,
                color: '#3B424C',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: '1px solid #E4E6E0',
                  background: HATCH,
                }}
              />
              {t('plan.lg.blocked')}
            </span>
            <span
              style={{ marginLeft: 'auto', fontSize: 12.5, color: '#59606B', whiteSpace: 'nowrap' }}
            >
              {t('plan.lg.hint')}
            </span>
          </div>
          {board.isError ? (
            <EmptyState
              icon="circle-alert"
              title={t('plan.loadError')}
              description={problemText(board.error, t) ?? ''}
              action={
                <Button variant="secondary" icon="refresh-cw" onClick={() => board.refetch()}>
                  {t('cust.retry')}
                </Button>
              }
            />
          ) : b && !b.vehicles.length ? (
            <EmptyState
              icon="truck"
              title={t('plan.noVeh.title')}
              description={t('plan.noVeh.desc')}
              action={
                <Button variant="secondary" icon="plus" onClick={() => nav('/fleet/vehicles')}>
                  {t('plan.noVeh.add')}
                </Button>
              }
            />
          ) : (
            <div style={{ minWidth: 1180 }}>
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 3,
                  display: 'grid',
                  gridTemplateColumns: week
                    ? '220px repeat(7,minmax(130px,1fr))'
                    : '220px minmax(0,1fr)',
                  background: '#F4F5F2',
                  borderBottom: '1px solid #E4E6E0',
                }}
              >
                <div
                  style={{
                    padding: '10px 12px',
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: '#3B424C',
                    borderRight: '1px solid #E4E6E0',
                  }}
                >
                  {t('plan.col.vehicle')}
                </div>
                {week ? (
                  days.map((d) => (
                    <div
                      key={d}
                      style={{
                        padding: '10px 8px',
                        fontSize: 12.5,
                        fontWeight: d === day0 ? 600 : 500,
                        color: d === day0 ? '#2257C4' : '#3B424C',
                        borderLeft: '1px solid #E4E6E0',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {d === day0
                        ? t('plan.col.today', { d: formatDayHead(d, lang) })
                        : formatDayHead(d, lang)}
                    </div>
                  ))
                ) : (
                  <div
                    style={{
                      position: 'relative',
                      display: 'grid',
                      gridTemplateColumns: 'repeat(14,minmax(0,1fr))',
                    }}
                  >
                    {Array.from({ length: DAY_HOURS }, (_, i) => (
                      <div
                        key={i}
                        className="tms-num"
                        style={{
                          padding: '10px 6px',
                          fontSize: 12.5,
                          color: '#3B424C',
                          borderLeft: '1px solid #E4E6E0',
                        }}
                      >
                        {hhmm(DAY_START + i)}
                      </div>
                    ))}
                    {showNowPill && (
                      <span
                        className="tms-num"
                        style={{
                          position: 'absolute',
                          top: 4,
                          left: nowL,
                          transform: 'translateX(-50%)',
                          height: 20,
                          padding: '0 6px',
                          borderRadius: 999,
                          background: '#B3322A',
                          color: '#FFFFFF',
                          fontSize: 12,
                          fontWeight: 600,
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        {hhmm(nowH)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {b
                ? b.vehicles.map((v) => (week ? weekRow(v) : dayRow(v)))
                : Array.from({ length: 6 }, (_, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '220px minmax(0,1fr)',
                        borderBottom: '1px solid #E4E6E0',
                        height: 96,
                      }}
                    >
                      <div style={{ padding: '10px 12px', borderRight: '1px solid #E4E6E0' }}>
                        {skeleton(14, 1)}
                      </div>
                      <div style={{ background: GRID }} />
                    </div>
                  ))}
            </div>
          )}
        </section>
      </div>
      <div
        style={{
          position: 'sticky',
          bottom: 16,
          zIndex: 5,
          ...PANEL,
          height: 56,
          display: 'flex',
          alignItems: 'center',
          gap: 28,
          padding: '0 20px',
        }}
      >
        {[
          {
            l: t('plan.sum.free'),
            v: stats ? `${stats.free} / ${stats.total}` : '—',
            c: '#17733F',
          },
          { l: t('plan.sum.used'), v: stats ? String(stats.used) : '—', c: '#2257C4' },
          {
            l: t('plan.sum.weight'),
            v: stats ? t('plan.kg', { n: fmtNum(stats.w) }) : '—',
            c: '#101418',
          },
          {
            l: t('plan.sum.km'),
            v: stats ? t('plan.km', { n: fmtNum(stats.km) }) : '—',
            c: '#101418',
          },
          {
            l: t('plan.sum.iss'),
            v: stats ? String(stats.iss) : '—',
            c: stats?.iss ? '#8F5500' : '#101418',
          },
        ].map((x) => (
          <div key={x.l} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: '#3B424C' }}>{x.l}</span>
            <span className="tms-num" style={{ fontWeight: 600, color: x.c }}>
              {x.v}
            </span>
          </div>
        ))}
      </div>
      {openId && !form && (
        <OrderDrawer
          key={openId}
          id={openId}
          canWrite={canWrite}
          canCancel={canCancel}
          canSeePrice={canSeePrice}
          canEditPrice={canEditPrice}
          canUnlock={canUnlock}
          onClose={() => setOpenId(null)}
          onEdit={openEdit}
          onDone={(m) => {
            setToast(m);
            void board.refetch();
          }}
        />
      )}
      {form && (
        <OrderFormDrawer
          key={form.key}
          mode="edit"
          initial={form.initial}
          order={form.order}
          subtitle={t('ord.kind')}
          canSeePrice={canSeePrice}
          canUnlock={canUnlock}
          onClose={() => setForm(null)}
          onReload={() => void reloadEdit(form.order.id)}
          onSaved={(o) => {
            setForm(null);
            setOpenId(o.id);
            setToast(t('ord.toast.saved', { no: o.soNo ?? t('ord.draftNo') }));
            void board.refetch();
          }}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
