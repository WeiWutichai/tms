import { Button, EmptyState, Icon, ReasonDialog, StatusTabs, SummaryStrip, Toast } from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, unwrap } from '../../api';
import { formatDayHead, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { useSessionState } from '../master/useCursorList';
import { HoldBadge, holdLabel } from '../orders/HoldPage';
import { OrderDrawer } from '../orders/OrderDrawer';
import { TripDrawer } from '../trips/TripDrawer';
import { OrderFormDrawer } from '../orders/OrderFormDrawer';
import { fromOrder, type Order, type OrderForm } from '../orders/orderForm';
import { bangkokToday, useDateText } from '../rate-cards/rateFormat';
import {
  addDays,
  axisBox,
  blocksOn,
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
  tripMoveBlock,
  dropWindow,
  weekDropWindow,
  type BoardTrip,
  type BoardVehicle,
  type PoolFilter,
  type PoolOrder,
  cardLine,
  firstRule,
  RULE_OVERRIDDEN,
  RULE_PENDING,
  ruleState,
  DEFAULT_PREFS,
  orderVehicles,
  weekFields,
  type BoardView,
  DIM,
  issuesOn,
  LEVEL_COLOR,
  levelOn,
  moveNoneReason,
  moveTarget,
  orderDay,
  type EligItem,
  type EligLevel,
} from './board';
import { BoardViewMenu } from './BoardViewMenu';
import { BlockedDialog, ruleTagKey, type BlockedReason } from './RuleDialogs';
import {
  useBoard,
  useBoardPrefs,
  useConfirmRules,
  useDropOrder,
  useEligibility,
  useFetchTripEligibility,
  useMoveTrip,
  useSaveBoardPrefs,
  type EligSubject,
  type Trip,
} from './usePlanning';

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
/** แถวรถติดกฎห้ามจ่ายงาน (ต้นแบบ vPlan HATCH) */
const HATCH_ROW = 'repeating-linear-gradient(135deg,rgba(179,50,42,.07) 0 2px,transparent 2px 9px)';
const GRID =
  'repeating-linear-gradient(90deg,transparent 0,transparent calc(100% / 14 - 1px),#EBEDE8 calc(100% / 14 - 1px),#EBEDE8 calc(100% / 14))';
const RING_OK = 'inset 0 0 0 2px #17733F';
const RING_BAD = 'inset 0 0 0 2px #B3322A';
/** ขอบเน้นตามระดับกฎ (ST3-T15) — ชุดสีเดียวกับขอบตอนลาก + ส้ม = คำเตือน (spec/03 PLN-041) */
const ringFor = (l: EligLevel) => `inset 0 0 0 2px ${LEVEL_COLOR[l]}`;
/** พื้นของสิ่งที่เลือก (ต้นแบบ: แถว/แท็บที่เลือก `#E9F0FA`) */
const SELECTED_BG = '#E9F0FA';
/** legend ตามสถานะเที่ยว (spec/03 §5 — สีสถานะ) + ซ้อนเวลา (docs/04 D2) */
const LEGEND: { c: string; k: MessageKey }[] = [
  { c: STATUS_COLOR.PLANNING!, k: 'plan.lg.PLANNING' },
  { c: STATUS_COLOR.ASSIGNED!, k: 'plan.lg.ASSIGNED' },
  { c: STATUS_COLOR.DISPATCHED!, k: 'plan.lg.DISPATCHED' },
  { c: STATUS_COLOR.IN_PROGRESS!, k: 'plan.lg.IN_PROGRESS' },
  { c: STATUS_COLOR.COMPLETED!, k: 'plan.lg.COMPLETED' },
  { c: CLASH, k: 'plan.lg.clash' },
  // ST3-T14 (ต้นแบบ legend): คำเตือนรอยืนยัน / ยกเว้นแล้ว
  { c: RULE_PENDING, k: 'plan.lg.pending' },
  { c: RULE_OVERRIDDEN, k: 'plan.lg.overridden' },
];

/** ปัญหาจาก API (problem+json) — `assignment_blocked` → รายการบล็อก (ST3-T14) */
const blockedOf = (err: unknown): BlockedReason[] | null =>
  err instanceof ApiError && err.problem.code === 'assignment_blocked'
    ? ((err.problem as unknown as { blocks?: BlockedReason[] }).blocks ?? [])
    : null;

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
 * มุมมองตามคนขับ/รถร่วม (T13)
 * ST3-T15 Filter รถที่รับได้สองทาง: คลิกการ์ด SO (หรือเริ่มลาก) → แถวรถขอบเขียว = ผ่านทุกกฎ · ส้ม = คำเตือน · แดง = ห้ามจ่ายงาน
 * (ที่ไม่ผ่านจาง) · คลิกรถ → การ์ด SO ที่รถรับได้ถูกเน้นแบบเดียวกัน · เลข SO บนการ์ด = เปิด drawer · Esc/คลิกซ้ำ = ยกเลิกการเลือก
 * · "ย้ายไปรถอื่น" บนเที่ยวที่ติดกฎ = ย้ายไปรถที่ผ่านกฎทั้งหมด (ประเภทเดียวกัน → ความจุพอดี)
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
  // ST3-T14 D-07: ยกเว้นกฎเอกสาร (บล็อก) = ผู้จัดการ/ผู้ดูแล
  const canOverride = can(scopes, 'trips:override');
  const [tab, setTab] = useSessionState<Tab>('plan.tab', 'today');
  const [pf, setPf] = useSessionState<PoolFilter>('plan.pool', POOL_FILTER);
  // วันนี้ตาม server (เวลาไทย) — ไม่ส่ง date ทั้งตอนโหลดและแท็บ (review ST3-T12)
  const board = useBoard(7);
  // มุมมอง + field บนการ์ด จำต่อผู้ใช้ฝั่ง server (ST3-T13) — โหลดไม่ได้ = ค่าเริ่มต้น "รถบริษัท + รถร่วม"
  const prefs = useBoardPrefs();
  const view = (prefs.data?.view ?? DEFAULT_PREFS.view) as BoardView;
  const cf: readonly string[] = prefs.data?.cardFields ?? DEFAULT_PREFS.cardFields;
  const wf = weekFields(cf);
  const savePrefs = useSaveBoardPrefs((conflict) =>
    setToast(t(conflict ? 'plan.view.conflict' : 'plan.view.saveError')),
  );
  const drop = useDropOrder();
  const move = useMoveTrip();
  const confirm = useConfirmRules();
  const tripElig = useFetchTripEligibility();
  /** สิ่งที่เลือกเพื่อดูรถ/งานที่รับได้ (ST3-T15) */
  const [sel, setSel] = useState<EligSubject | null>(null);
  /**
   * "ห้ามจ่ายงาน · {ทะเบียน}" (ต้นแบบ BP): เปิดจาก (i) ดูสาเหตุ หรือเมื่อ API ตอบ 409 `assignment_blocked`
   * `retry(reason, keys)` = ยกเว้นเฉพาะกฎที่แสดง (`reasons[].key`) — ส่งคำขอเดิมซ้ำ / `/confirm-rules` ของเที่ยว
   * ไม่มี `retry` (เปิดจาก (i) ของแถวรถ) = ยกเว้นเอกสารรถของเที่ยวที่ค้างบนรถคันนี้ (`tripsBlocked`) — ไม่มีเที่ยว = ยกเว้นไม่ได้
   * ไม่มีการยกเว้นทั้งคันข้ามเที่ยว (PO 17 พ.ย. 2569 — ทุกเที่ยวต้องยืนยันเอง; เติมเหตุผลล่าสุดของรถคันนั้นให้)
   */
  const [bp, setBp] = useState<{
    v: BoardVehicle;
    reasons: BlockedReason[];
    retry?: (reason: string, keys: string[]) => void;
  } | null>(null);
  const [bpErr, setBpErr] = useState<string | null>(null);
  /** เหตุผลยกเว้นล่าสุดต่อรถ (เติมให้ในครั้งถัดไป — ผู้ใช้ยังต้องกดยืนยันเองทุกเที่ยว) */
  const [lastReason, setLastReason] = useState<Record<string, string>>({});
  /** การ์ด "… · ขออนุมัติ" → dialog ยืนยันคำเตือนพร้อมเหตุผล */
  const [ack, setAck] = useState<BoardTrip | null>(null);
  const [ackErr, setAckErr] = useState<string | null>(null);
  const nowH = useNowHour();
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<{ v: string; d: string } | null>(null);
  const [resize, setResize] = useState<Resize | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  const badRef = useRef('');
  const [pop, setPop] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** drawer เที่ยวรถ (ST3-T16) — เปิดจากเลขเที่ยวใน drawer SO (ต้นแบบ openTrp แทนที่ drawer เดิม) */
  const [tripId, setTripId] = useState<string | null>(null);
  const [form, setForm] = useState<{ key: number; initial: OrderForm; order: Order } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const b = board.data;
  const day0 = b?.today ?? bangkokToday();
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
  // ---------------------------------------------------------------- รถ/งานที่รับได้ (ST3-T15)
  // การเลือกที่ยังอยู่บนกระดาน (SO ลงเที่ยวแล้ว/รถหายไป → เลิกเน้นเอง)
  const selOn =
    sel && b && (sel.kind === 'order' ? b.pool : b.vehicles).some((x) => x.id === sel.id)
      ? sel
      : null;
  const elig = useEligibility(selOn);
  const eligBy = useMemo(() => {
    const m = new Map<string, EligItem>();
    for (const it of elig.data?.items ?? [])
      m.set((elig.data!.subject === 'VEHICLE' ? it.orderId : it.vehicleId) ?? '', it);
    return m;
  }, [elig.data]);
  /** ระดับของรถ `v` วัน `d` เมื่อเลือก SO (null = ไม่ได้เลือก/ยังโหลด) */
  const vehLevel = (v: string, d: string): EligLevel | null => {
    if (selOn?.kind !== 'order' || elig.data?.subject !== 'ORDER') return null;
    const it = eligBy.get(v);
    return it ? levelOn(it, d) : null;
  };
  /**
   * เหตุผลใน tooltip: กฎที่บังคับตอนวาง (น้ำหนัก/ปริมาตร = ของงานนี้ "ต่องาน") · ไม่มี = รับได้ ·
   * ข้อสังเกตคนขับประจำ (บังคับตอนจัดรถ /assign — ไม่เปลี่ยนสีขอบ) ต่อท้าย
   */
  const eligLines = (it: EligItem, d: string) => {
    const xs = issuesOn(it, d).map((i) =>
      i.code === 'OVERWEIGHT' || i.code === 'OVER_VOLUME'
        ? t('plan.elig.jobLoad', { m: i.message })
        : i.message,
    );
    return [
      ...(xs.length ? xs : [t('plan.elig.ok')]),
      ...issuesOn({ ...it, issues: it.driverHints }, d, true).map((i) =>
        t('plan.elig.driverHint', { m: i.message }),
      ),
    ];
  };
  const vehTip = (v: string, d: string) => {
    const it = selOn?.kind === 'order' ? eligBy.get(v) : undefined;
    if (!it || elig.data?.subject !== 'ORDER') return undefined;
    return eligLines(it, d).join('\n');
  };
  const pickVehicle = (v: BoardVehicle) =>
    setSel((s) => (s?.kind === 'vehicle' && s.id === v.id ? null : { kind: 'vehicle', id: v.id }));
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setSel(null);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  useEffect(() => {
    if (elig.isError) setToast(t('plan.elig.error', { m: problemText(elig.error, t) ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elig.isError]);

  const tabCount = (ds: string[]) =>
    b ? b.trips.filter((x) => x.vehicleId && ds.some((d) => onDay(x, d))).length : undefined;

  // ---------------------------------------------------------------- ลากวาง
  const orderOf = (id: string) => b?.pool.find((o) => o.id === id);
  const tripOf = (id: string) => b?.trips.find((x) => x.id === id);
  const vehOf = (id: string | null) => b?.vehicles.find((v) => v.id === id);
  const blkOn = blocksOn;
  /** เที่ยวบนรถ `v` (วันที่แสดง) ที่ค้างบล็อกเอกสารรถ + กฎเหล่านั้น — ยกเว้นจาก (i) ของแถวรถ */
  const docBlocked = (v: BoardVehicle) =>
    (tripsBy.get(v.id) ?? [])
      .filter((x) => days.some((d) => onDay(x, d)))
      .map((x) => ({
        x,
        rules: (x.pendingRules ?? []).filter(
          (r) => r.severity === 'block' && r.code.startsWith('DOC_'),
        ),
      }))
      .filter((e) => e.rules.length > 0);
  /**
   * วางไม่ได้จริงไหม — ผู้มีสิทธิ์ยกเว้น (`trips:override`) วางลงรถที่ติดเฉพาะกฎเอกสารได้ (server ตอบ 409 → dialog ยกเว้น
   * เฉพาะเที่ยวนี้) · ผู้วางแผนถูกกันฝั่ง client เหมือนเดิม (ขอบแดง + toast)
   */
  const stopsDrop = (d: Drag, v: BoardVehicle | undefined, day: string) => {
    const why = badOf(d, v, day);
    if (!why) return false;
    const blk = v ? blkOn(v, day) : [];
    const onlyBlocked = blk.length > 0 && why === t('plan.bad.blocked', { m: blk[0]!.message });
    return !(canOverride && onlyBlocked);
  };
  /**
   * เหตุที่วางสิ่งที่กำลังลากลงแถวรถ `v` วัน `day` ไม่ได้ (server ตรวจซ้ำเสมอ — PLN-042; กฎเต็ม = ST3-T14/T15):
   * รถติดกฎห้ามจ่ายงาน (ต้นแบบ "รถติดกฎห้ามจ่ายงาน (…)") · SO ต้นทางแก้รอตรวจ · เที่ยวปล่อยรถแล้ว ·
   * เที่ยวจัดรถแล้ว (ASSIGNED) ย้ายไปรถอื่น = ทางจัดรถใหม่ของ ST3-T17 (ไม่ทำ /assign + /schedule สองคำขอ)
   */
  const badOf = (d: Drag, v: BoardVehicle | undefined, day: string): string => {
    if (!d || !canPlan) return '';
    if (d.kind === 'order' && orderOf(d.id)?.sourceChangePending) return t('plan.bad.source');
    if (d.kind === 'trip') {
      const x = tripOf(d.id);
      const why = x ? tripMoveBlock(x, v?.id ?? x.vehicleId ?? '') : null;
      if (x && why === 'locked') return t('plan.bad.locked', { no: x.tripNo });
      if (x && why === 'assigned') return t('plan.bad.assigned', { no: x.tripNo });
      if (x && v && v.id === x.vehicleId) return '';
    }
    const blk = v ? blkOn(v, day) : [];
    return blk.length ? t('plan.bad.blocked', { m: blk[0]!.message }) : '';
  };
  const overVeh = over ? vehOf(over.v) : undefined;
  const bad = over ? badOf(drag, overVeh, over.d) : '';
  const ringOf = (v: string, d: string) => {
    if (drag && over && over.v === v && over.d === d) return bad ? RING_BAD : RING_OK;
    const l = vehLevel(v, d);
    return l ? ringFor(l) : 'none';
  };
  const dragOver = (v: string, d: string) => (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    const why = badOf(drag, vehOf(v), d);
    const stop = stopsDrop(drag, vehOf(v), d);
    badRef.current = stop ? why : '';
    e.dataTransfer.dropEffect = stop ? 'none' : 'move';
    if (!over || over.v !== v || over.d !== d) setOver({ v, d });
  };
  // ไม่ล้าง badRef ตอนออกจากแถว — ปล่อยบนแถวที่วางไม่ได้ Chromium ยิง dragleave ก่อน dragend
  const leave = () => setOver(null);
  const endDrag = () => {
    setDrag(null);
    setOver(null);
    badRef.current = '';
  };
  /** ปล่อยบนแถวที่วางไม่ได้ (dropEffect none → ไม่มี drop event) → ย้อนการ์ด + toast เหตุผล (PLN-042) */
  const dragEnd = () => {
    const why = badRef.current;
    endDrag();
    if (why) setToast(t('plan.cantDrop', { m: why }));
  };
  const fail = (err: unknown) => setToast(t('plan.cantDrop', { m: problemText(err, t) ?? '' }));
  /**
   * ผลปฏิเสธของ API: 409 `assignment_blocked` → toast "ห้ามจ่ายงานให้ …" + เปิด BP (ต้นแบบ assignToast) พร้อม `retry`
   * (ผู้จัดการกรอกเหตุผลแล้วส่งคำขอเดิมซ้ำพร้อมยกเว้น) · อื่น ๆ → toast "วางไม่ได้: …"
   */
  const failOn =
    (
      v: BoardVehicle,
      retry: (reason: string, keys: string[]) => void,
      other: (err: unknown) => void = fail,
    ) =>
    (err: unknown) => {
      const reasons = blockedOf(err);
      if (!reasons) return other(err);
      setToast(t('plan.cantDrop', { m: t('plan.bad.blocked', { m: reasons[0]?.message ?? '' }) }));
      setBpErr(null);
      setBp({ v, reasons, retry });
    };
  /** คำเตือนทั้งหมดของเที่ยว (QA ST3-T12) — ซ้อนเวลารถ = "เวลาชนกัน" */
  const issueText = (x: Trip) => {
    const ws = (x.warnings ?? []).map((w) =>
      w.code === 'vehicle_overlap' ? t('plan.clash') : w.message,
    );
    return ws.length ? [...new Set(ws)].join(' · ') : null;
  };

  /**
   * "ย้ายไปรถอื่น" (ต้นแบบ moveBlock; spec/03 PLN-093): ถามรถที่รับเที่ยวนี้ได้ (กฎเดียวกับตอนวาง) → ย้ายไปคันที่เหมาะสุด
   * ด้วย /schedule (คำขอเดียวกับการลากย้าย) · ไม่มีรถที่ผ่าน → toast ตามต้นแบบ · server ตรวจซ้ำเสมอ
   */
  const moveOther = async (x: BoardTrip) => {
    if (!b) return;
    setPop(null);
    let items: EligItem[];
    try {
      items = (await tripElig(x.id)).items;
    } catch (err) {
      return fail(err);
    }
    const v = moveTarget(x, items, b.vehicles);
    if (!v) {
      // เหตุหลักที่ไม่มีรถรับได้ — น้ำหนัก = ข้อความต้นแบบ · อื่น ๆ = เหตุจริงข้อที่พบมากสุด (QA L2)
      const why = moveNoneReason(x, items, b.vehicles);
      return setToast(
        why === null
          ? t('plan.move.none', { w: fmtNum(kg(x.weightKg)) })
          : t('plan.move.noneWhy', { m: why }),
      );
    }
    const send = (extra: object, viaDialog: boolean) =>
      move.mutate(
        { id: x.id, version: x.version, body: { vehicleId: v.id, ...extra } },
        {
          onSuccess: (r) => {
            if (viaDialog) setBp(null);
            const m = t('plan.toast.moved', {
              so: soText(x),
              from: x.vehiclePlate ?? '—',
              to: v.plate,
            });
            const i = issueText(r);
            setToast(i ? t('plan.toast.issue', { m, i }) : m);
          },
          onError: viaDialog
            ? (e) => setBpErr(problemText(e, t))
            : failOn(
                v,
                (reason, keys) => {
                  setLastReason((m) => ({ ...m, [v.id]: reason }));
                  send({ ruleKeys: keys, overrideReason: reason }, true);
                },
                // ย้ายไม่สำเร็จ (เช่น 412 มีคนแก้เที่ยวก่อน) — ไม่ใช่ "วางไม่ได้" (QA L3)
                (e) => setToast(t('plan.move.fail', { m: problemText(e, t) ?? '' })),
              ),
        },
      );
    send({}, false);
  };
  /** ลิงก์ "ย้ายไปรถอื่น" — เฉพาะเที่ยวที่ยังเปลี่ยนรถบนกระดานได้ (PLANNING; ASSIGNED = จัดรถใหม่ของ ST3-T17) */
  const canMoveOther = (x: BoardTrip) => canPlan && tripMoveBlock(x, '') === null;
  const moveLink = (x: BoardTrip, style: CSSProperties) => (
    <button
      type="button"
      data-testid={`plan-move-${x.tripNo}`}
      draggable={false}
      disabled={move.isPending}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void moveOther(x);
      }}
      style={{
        border: 0,
        background: 'transparent',
        padding: 0,
        color: '#2257C4',
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {t('plan.move')}
    </button>
  );

  /** ปล่อยบนแถวรถ `v` วัน `d` — `hour` = ชั่วโมงที่ปล่อย (มุมมองวันนี้) หรือ null (มุมมอง 7 วัน) */
  const onDropAt = (v: BoardVehicle, d: string, hour: number | null) => {
    const cur = drag;
    endDrag();
    if (!cur || !canPlan) return;
    const why = badOf(cur, v, d);
    if (why && stopsDrop(cur, v, d)) return setToast(t('plan.cantDrop', { m: why }));
    const own = tripsBy.get(v.id) ?? [];
    if (cur.kind === 'order') {
      const o = orderOf(cur.id);
      if (!o) return;
      const w = hour === null ? weekDropWindow(own, d) : dropWindow(hour);
      const send = (extra: object, viaDialog: boolean) =>
        drop.mutate(
          {
            idempotencyKey: crypto.randomUUID(),
            body: {
              tripDate: d,
              deliveryOrderIds: o.deliveryOrders.map((x) => x.id),
              vehicleId: v.id,
              plannedStartAt: isoAt(d, w.s),
              plannedEndAt: isoAt(d, w.e),
              ...extra,
            },
          },
          {
            onSuccess: (x) => {
              if (viaDialog) setBp(null);
              const m = t('plan.toast.assigned', { so: o.orderNo, plate: v.plate });
              const i = issueText(x);
              setToast(i ? t('plan.toast.issue', { m, i }) : m);
            },
            onError: viaDialog
              ? (e) => setBpErr(problemText(e, t))
              : failOn(v, (reason, keys) => {
                  setLastReason((m) => ({ ...m, [v.id]: reason }));
                  send({ ruleKeys: keys, overrideReason: reason }, true);
                }),
          },
        );
      send({}, false);
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
    const sendMove = (extra: object, viaDialog: boolean) =>
      move.mutate(
        {
          id: x.id,
          version: x.version,
          body: { ...(changeVeh ? { ...body, vehicleId: v.id } : body), ...extra },
        },
        {
          onSuccess: (r) => {
            if (viaDialog) setBp(null);
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
          onError: viaDialog
            ? (e) => setBpErr(problemText(e, t))
            : failOn(v, (reason, keys) => {
                setLastReason((m) => ({ ...m, [v.id]: reason }));
                sendMove({ ruleKeys: keys, overrideReason: reason }, true);
              }),
        },
      );
    sendMove({}, false);
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
      // ปรับขนาดไม่เปลี่ยนวันเที่ยว (review ST3-T12)
      const body = scheduleBody(r.day, r.s, r.e, x.tripDate);
      move.mutate(
        { id: x.id, version: x.version, body },
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
  type Issue = BoardVehicle['blocks'][number]['issues'][number];
  const vehicleCell = (v: BoardVehicle, load: number, blk: Issue[]) => {
    const cap = kg(v.capacityKg);
    const overCap = cap > 0 && load > cap;
    const picked = selOn?.kind === 'vehicle' && selOn.id === v.id;
    return (
      <div
        data-testid={`plan-veh-${v.plate}`}
        role="button"
        tabIndex={0}
        aria-pressed={picked}
        title={t('plan.elig.pickVehicle')}
        aria-label={t('plan.elig.pickVehicleAria', { plate: v.plate })}
        onClick={() => pickVehicle(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pickVehicle(v);
          }
        }}
        style={{
          position: 'relative',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0,
          borderRight: '1px solid #E4E6E0',
          background: picked ? SELECTED_BG : '#FFFFFF',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span className="tms-num" style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
            {plateText(v)}
          </span>
          <span style={{ fontSize: 13, color: '#3B424C', whiteSpace: 'nowrap' }}>
            {v.vehicleTypeName}
          </span>
          {blk.length > 0 && (
            <button
              type="button"
              title={t('plan.why')}
              aria-label={t('plan.why')}
              onClick={(e) => {
                e.stopPropagation();
                setBpErr(null);
                setBp({ v, reasons: blk });
              }}
              className="tms-plan-why"
              style={{
                marginLeft: 'auto',
                width: 24,
                height: 24,
                border: 0,
                borderRadius: 999,
                background: 'transparent',
                color: '#B3322A',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                padding: 0,
              }}
            >
              <Icon n="info" s={16} />
            </button>
          )}
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
        {blk.length > 0 && (
          <div
            data-testid={`plan-blocked-${v.plate}`}
            style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
          >
            <span
              title={blk.map((i) => i.message).join('\n')}
              style={{
                height: 22,
                padding: '0 8px',
                borderRadius: 999,
                background: '#FBE9E7',
                color: '#B3322A',
                fontSize: 12,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
              }}
            >
              <Icon n="ban" s={12} />
              {blk[0]!.message}
            </span>
            {blk.length > 1 && (
              <span
                style={{
                  height: 22,
                  padding: '0 6px',
                  borderRadius: 999,
                  background: '#EEF0EC',
                  color: '#3B424C',
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                +{blk.length - 1}
              </span>
            )}
          </div>
        )}
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
      ...((x.pendingRules ?? []).length
        ? [t('plan.rule.tip', { i: (x.pendingRules ?? []).map((r) => r.message).join(' · ') })]
        : []),
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

  /**
   * ป้ายกฎตอนจัดบนการ์ด (ST3-T14 — ต้นแบบ vPlan `mk`): บล็อกค้าง = "ต้องย้ายรถ" (แดง) · คำเตือนค้าง = ปุ่ม "{กฎ} · ขออนุมัติ"
   * (ส้ม — เปิด dialog ยืนยันพร้อมเหตุผล) · ยกเว้น/ยืนยันครบ = "อนุมัติยกเว้นแล้ว" (เทา)
   */
  const rulePill = (x: BoardTrip) => {
    const st = ruleState(x);
    if (st === 'block') {
      // บล็อกผูกรถ (เอกสารรถ) = "ต้องย้ายรถ" · ผูกคนขับ (ใบขับขี่) = "ต้องเปลี่ยนคนขับ" (QA L2)
      const blocks = (x.pendingRules ?? []).filter((r) => r.severity === 'block');
      const vehicleBound = blocks.some((r) => !r.code.startsWith('DRIVER_'));
      const label = t(vehicleBound ? 'plan.rule.mustMove' : 'plan.rule.mustChangeDriver');
      const style: CSSProperties = {
        alignSelf: 'flex-start',
        marginTop: 3,
        height: 22,
        padding: '0 8px',
        border: 0,
        borderRadius: 999,
        background: '#FBE9E7',
        color: '#B3322A',
        fontSize: 12,
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      };
      const v = vehOf(x.vehicleId);
      // ต้นแบบ mustMove: ป้าย "ต้องย้ายรถ" + ลิงก์ "ย้ายไปรถอื่น" (ST3-T15) — มุมมอง 7 วันอยู่ใน popover ของการ์ด
      const withMove = (pill: React.ReactNode) =>
        canMoveOther(x) && !week ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, minWidth: 0 }}>
            {pill}
            {moveLink(x, { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis' })}
          </div>
        ) : (
          pill
        );
      if (canMoveOther(x) && !week) style.marginTop = 0;
      // ผู้มีสิทธิ์ยกเว้น: กดป้าย → "ห้ามจ่ายงาน" ของเที่ยวนี้ (ยกเว้นเฉพาะกฎที่แสดง)
      return withMove(
        canOverride && canPlan && v ? (
          <button
            type="button"
            data-testid={`plan-mustmove-${x.tripNo}`}
            title={t('plan.rule.overrideTitle')}
            draggable={false}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setBpErr(null);
              setBp({
                v,
                reasons: blocks,
                retry: (reason, keys) =>
                  confirm.mutate(
                    { id: x.id, version: x.version, reason, ruleKeys: keys },
                    {
                      onSuccess: () => {
                        setLastReason((m) => ({ ...m, [v.id]: reason }));
                        setBp(null);
                        setToast(t('plan.ack.done', { so: soText(x) }));
                      },
                      onError: (er) => setBpErr(problemText(er, t)),
                    },
                  ),
              });
            }}
            style={{ ...style, cursor: 'pointer' }}
          >
            {label}
          </button>
        ) : (
          <span data-testid={`plan-mustmove-${x.tripNo}`} style={style}>
            {label}
          </span>
        ),
      );
    }
    if (st === 'pending') {
      const r = firstRule(x)!;
      const label = t('plan.rule.ask', { i: t(ruleTagKey(r.code)) });
      const pill: CSSProperties = {
        alignSelf: 'flex-start',
        marginTop: 3,
        height: 22,
        padding: '0 8px',
        border: 0,
        borderRadius: 999,
        background: '#FCF0DC',
        color: '#8F5500',
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      };
      return canPlan ? (
        <button
          type="button"
          data-testid={`plan-ask-${x.tripNo}`}
          title={t('plan.rule.askTitle')}
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setAckErr(null);
            setAck(x);
          }}
          style={{ ...pill, cursor: 'pointer' }}
        >
          {label}
        </button>
      ) : (
        <span style={{ ...pill, display: 'inline-flex', alignItems: 'center' }}>{label}</span>
      );
    }
    if (st === 'overridden')
      return (
        <span
          data-testid={`plan-overridden-${x.tripNo}`}
          style={{
            marginTop: 3,
            fontSize: 12,
            fontWeight: 600,
            color: '#59606B',
            whiteSpace: 'nowrap',
          }}
        >
          {t('plan.rule.overridden')}
        </span>
      );
    return null;
  };

  const dayRow = (v: BoardVehicle) => {
    const ts = (tripsBy.get(v.id) ?? []).filter((x) => onDay(x, dsel));
    const items = ts.map((x) => {
      const sp = resize?.id === x.id ? resize : span(x, dsel);
      return { id: x.id, s: sp.s, e: sp.e, x };
    });
    const ln = lanes(items);
    const showNow = tab === 'today' && nowH >= DAY_START && nowH < DAY_START + DAY_HOURS;
    const lv = vehLevel(v.id, dsel);
    return (
      <div
        key={v.id}
        data-testid={`plan-row-${v.plate}`}
        data-elig={lv ?? undefined}
        style={{
          display: 'grid',
          gridTemplateColumns: '220px minmax(0,1fr)',
          borderBottom: '1px solid #E4E6E0',
          opacity: lv && lv !== 'OK' ? DIM : 1,
        }}
      >
        {vehicleCell(v, rowLoad(ts), blkOn(v, dsel))}
        <div
          data-track
          data-testid={`plan-track-${v.plate}`}
          onDragOver={dragOver(v.id, dsel)}
          onDragLeave={leave}
          onDrop={(e) => {
            e.preventDefault();
            const rc = e.currentTarget.getBoundingClientRect();
            onDropAt(v, dsel, hourAt((e.clientX - rc.left) / rc.width));
          }}
          title={over?.v === v.id ? bad : (vehTip(v.id, dsel) ?? blkOn(v, dsel)[0]?.message)}
          style={{
            position: 'relative',
            minHeight: ln.count * LANE_H + 16,
            background: blkOn(v, dsel).length ? `${HATCH_ROW},${GRID}` : GRID,
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
                  onDragEnd={dragEnd}
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
                  {(cf.includes('ORDER_NO') || cf.includes('CUSTOMER')) && (
                    <div style={{ ...ELL, lineHeight: 1.45 }}>
                      {cf.includes('ORDER_NO') && (
                        <span className="tms-num" style={{ color: '#2257C4', fontWeight: 500 }}>
                          {soText(x)}
                        </span>
                      )}
                      {cf.includes('ORDER_NO') && cf.includes('CUSTOMER') && ' · '}
                      {cf.includes('CUSTOMER') && custText(x)}
                    </div>
                  )}
                  {(cf.includes('TIME') || cf.includes('ROUTE')) && (
                    <div
                      className="tms-num"
                      style={{ fontSize: 12.5, color: '#3B424C', ...ELL, lineHeight: 1.45 }}
                    >
                      {cardLine(cf, [
                        ['TIME', timeText(x, dsel)],
                        ['ROUTE', routeText(x)],
                      ])}
                    </div>
                  )}
                  {cf.includes('WEIGHT') && (
                    <div
                      className="tms-num"
                      style={{ fontSize: 12.5, color: wl.color, ...ELL, lineHeight: 1.45 }}
                    >
                      {wl.text}
                    </div>
                  )}
                  {x.overlapsWith.length > 0 && clashBadge}
                  {rulePill(x)}
                </div>
                {/* ขอบที่ล้นแกน 06:00–20:00 ไม่มีที่จับ (กันตัดเที่ยวนอกช่วง/ข้ามคืน — review ST3-T12) */}
                {canMove && !box.clipS && (
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
                )}
                {canMove && !box.clipE && (
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
    // จางเมื่อไม่มีวันไหนที่รับได้เลย (ขอบต่อวันบอกรายละเอียด)
    const lvs = days.map((d) => vehLevel(v.id, d));
    const dim = lvs.every((l) => l !== null && l !== 'OK');
    return (
      <div
        key={v.id}
        data-testid={`plan-row-${v.plate}`}
        data-elig={lvs[0] === null ? undefined : dim ? 'NONE' : 'SOME'}
        style={{
          display: 'grid',
          gridTemplateColumns: '220px repeat(7,minmax(130px,1fr))',
          borderBottom: '1px solid #E4E6E0',
          opacity: dim ? DIM : 1,
        }}
      >
        {vehicleCell(
          v,
          load,
          days
            .flatMap((d) => blkOn(v, d))
            .filter((i, n, a) => a.findIndex((j) => j.message === i.message) === n),
        )}
        {days.map((d) => {
          const ts = own.filter((x) => onDay(x, d)).sort((a, c) => span(a, d).s - span(c, d).s);
          return (
            <div
              key={d}
              data-testid={`plan-cell-${v.plate}-${d}`}
              data-elig={vehLevel(v.id, d) ?? undefined}
              onDragOver={dragOver(v.id, d)}
              onDragLeave={leave}
              onDrop={(e) => {
                e.preventDefault();
                onDropAt(v, d, null);
              }}
              title={
                over?.v === v.id && over.d === d
                  ? bad
                  : (vehTip(v.id, d) ?? blkOn(v, d)[0]?.message)
              }
              style={{
                borderLeft: '1px solid #E4E6E0',
                padding: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                background: blkOn(v, d).length ? HATCH_ROW : d === day0 ? '#F7F8F5' : '#FFFFFF',
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
                      onDragEnd={dragEnd}
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
                      {wf.includes('ORDER_NO') && (
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
                      )}
                      {wf.includes('CUSTOMER') && (
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
                      )}
                      {wf.includes('WEIGHT') && (
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
                      )}
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
                      {rulePill(x)}
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
                          {canMoveOther(x) &&
                            (ruleState(x) === 'block' || ruleState(x) === 'pending') &&
                            moveLink(x, { fontSize: 13, textAlign: 'left' })}
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
    const picked = selOn?.kind === 'order' && selOn.id === o.id;
    // เลือกรถอยู่ → ระดับกฎของ SO นี้กับรถคันนั้น (ST3-T15)
    const it =
      selOn?.kind === 'vehicle' && elig.data?.subject === 'VEHICLE' ? eligBy.get(o.id) : undefined;
    const day = orderDay(o, days);
    const lv = it ? levelOn(it, day) : null;
    const why = it ? eligLines(it, day) : [];
    return (
      <div
        key={o.id}
        data-testid={`plan-pool-${o.orderNo}`}
        data-elig={lv ?? undefined}
        aria-pressed={picked}
        draggable={canPlan}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', o.id);
          e.dataTransfer.effectAllowed = 'move';
          setDrag({ kind: 'order', id: o.id });
          // เริ่มลาก = เลือก SO นี้ → แถวรถที่รับได้ถูกเน้นระหว่างลาก (spec/03 PLN-041)
          setSel({ kind: 'order', id: o.id });
        }}
        onDragEnd={dragEnd}
        onClick={() =>
          setSel((x) => (x?.kind === 'order' && x.id === o.id ? null : { kind: 'order', id: o.id }))
        }
        title={[
          `${o.orderNo} · ${o.customerName ?? '—'}`,
          route,
          dateText(o.requestedDate) + (late ? t('plan.pool.over') : ''),
          t('plan.kg', { n: w }),
          ...(it ? why : [t('plan.elig.pickOrder')]),
        ].join('\n')}
        className="tms-plan-card"
        style={{
          background: picked ? SELECTED_BG : '#FFFFFF',
          // กำหนดทีละด้าน — ไม่ผสม shorthand `border` กับ `borderLeft` (React ลบขอบซ้ายเมื่อเลือก — QA M2)
          borderTop: `1px solid ${picked ? '#9DB6E3' : '#CDD1C8'}`,
          borderRight: `1px solid ${picked ? '#9DB6E3' : '#CDD1C8'}`,
          borderBottom: `1px solid ${picked ? '#9DB6E3' : '#CDD1C8'}`,
          borderLeft: `3px solid ${late ? '#B3322A' : '#2257C4'}`,
          borderRadius: 8,
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          cursor: canPlan ? 'grab' : 'pointer',
          opacity: drag?.kind === 'order' && drag.id === o.id ? 0.5 : lv && lv !== 'OK' ? DIM : 1,
          boxShadow: lv
            ? `0 0 0 2px ${LEVEL_COLOR[lv]},0 1px 2px rgba(16,20,24,.06)`
            : '0 1px 2px rgba(16,20,24,.06)',
          minWidth: 0,
        }}
      >
        <div style={{ ...ELL, lineHeight: 1.45 }}>
          {/* เลข SO = เปิด drawer (คลิกการ์ด = เลือกเพื่อเน้นรถที่รับได้ — docs/04 D2, spec/03 §5) */}
          <button
            type="button"
            className="tms-num"
            title={t('plan.pop.open')}
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              setOpenId(o.id);
            }}
            style={{
              border: 0,
              background: 'transparent',
              padding: 0,
              font: 'inherit',
              color: '#2257C4',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {o.orderNo}
          </button>{' '}
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
      <BoardViewMenu
        view={view}
        fields={cf}
        disabled={prefs.isPending}
        onChange={(body) => void savePrefs(body)}
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
              {b && !prefs.isPending
                ? orderVehicles(b.vehicles, view).map((v) => (week ? weekRow(v) : dayRow(v)))
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
          canSeeTrips={can(scopes, 'trips:read')}
          onOpenTrip={(x) => {
            setOpenId(null);
            setTripId(x);
          }}
          onClose={() => setOpenId(null)}
          onEdit={openEdit}
          onDone={(m) => {
            setToast(m);
            void board.refetch();
          }}
        />
      )}
      {tripId && (
        <TripDrawer
          key={tripId}
          id={tripId}
          canEdit={can(scopes, 'trips:assign')}
          onClose={() => setTripId(null)}
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
      {ack &&
        (() => {
          const r = firstRule(ack);
          const ow = (ack.pendingRules ?? []).some((p) => p.code === 'OVERWEIGHT');
          const cap = capOf(ack);
          return (
            <ReasonDialog
              open
              title={t('plan.ack.title')}
              description={t('plan.ack.desc', {
                so: soText(ack),
                plate: ack.vehiclePlate ?? '—',
                i: r ? t(ruleTagKey(r.code)) : '',
                w:
                  ow && cap > 0
                    ? t('plan.ack.weight', { w: fmtNum(kg(ack.weightKg)), c: fmtNum(cap) })
                    : '',
              })}
              diff={{
                rows: (ack.pendingRules ?? [])
                  .filter((p) => p.severity === 'warning')
                  .map((p) => ({
                    f: t('plan.ack.field'),
                    b: p.message,
                    a: t('plan.ack.approve'),
                  })),
                labels: [t('plan.ack.field'), t('plan.ack.before'), t('plan.ack.after')],
              }}
              hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
              label={t('ord.dlg.reason')}
              placeholder={t('plan.ack.ph')}
              okLabel={t('plan.ack.ok')}
              cancelLabel={t('common.cancel')}
              closeLabel={t('drawer.close')}
              busy={confirm.isPending}
              error={ackErr}
              onClose={() => setAck(null)}
              onOk={(reason) =>
                confirm.mutate(
                  {
                    id: ack.id,
                    version: ack.version,
                    reason,
                    // ยืนยันเฉพาะคำเตือนที่แสดงใน dialog
                    ruleKeys: (ack.pendingRules ?? [])
                      .filter((p) => p.severity === 'warning')
                      .map((p) => p.key),
                  },
                  {
                    onSuccess: () => {
                      setToast(t('plan.ack.done', { so: soText(ack) }));
                      setAck(null);
                    },
                    onError: (e) => setAckErr(problemText(e, t)),
                  },
                )
              }
            />
          );
        })()}
      <BlockedDialog
        open={bp !== null}
        plate={bp ? plateText(bp.v) : ''}
        sub={
          bp
            ? t('plan.bp.sub', {
                type: bp.v.vehicleTypeName,
                driver:
                  bp.v.ownership === 'SUBCONTRACT'
                    ? t('plan.subcon', { n: bp.v.carrierName ?? '—' })
                    : (bp.v.driver?.name ?? t('plan.noDriver')),
              })
            : ''
        }
        reasons={bp?.reasons ?? []}
        canOverride={canOverride}
        initialReason={bp ? (lastReason[bp.v.id] ?? '') : ''}
        nothing={!!bp && !bp.retry && docBlocked(bp.v).length === 0}
        busy={drop.isPending || move.isPending || confirm.isPending}
        error={bpErr}
        onLink={(code) => {
          setBp(null);
          nav(code.startsWith('DRIVER_') ? '/fleet/drivers' : '/fleet/documents');
        }}
        onClose={() => setBp(null)}
        onOk={(reason, keys) => {
          if (!bp) return;
          setBpErr(null);
          if (bp.retry) return bp.retry(reason, keys);
          // จาก (i) ของแถวรถ: ยกเว้นเฉพาะเอกสารรถที่แสดง ของเที่ยวที่ค้างบนรถคันนี้ (ทีละเที่ยว — ไม่ยกเว้นทั้งคันล่วงหน้า)
          const v = bp.v;
          for (const { x, rules } of docBlocked(v))
            confirm.mutate(
              { id: x.id, version: x.version, reason, ruleKeys: rules.map((r) => r.key) },
              { onError: fail },
            );
          setLastReason((m) => ({ ...m, [v.id]: reason }));
          setBp(null);
          setToast(t('plan.bp.done', { plate: plateText(v) }));
        }}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
