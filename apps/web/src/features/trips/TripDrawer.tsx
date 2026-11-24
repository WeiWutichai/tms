import {
  Badge,
  Drawer,
  EmptyState,
  Icon,
  ReasonDialog,
  Toast,
  useEscapeLayer,
  useModalFocus,
} from '@tms/ui';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { writeSession } from '../master/useCursorList';
import { toBangkok } from '../orders/orderForm';
import { useDateText, useDateTimeText } from '../rate-cards/rateFormat';
import {
  durationText,
  firstOrderViolation,
  legText,
  moveStop,
  routeDistanceText,
} from './tripStops';
import { BlockedDialog, type BlockedReason } from '../planning/RuleDialogs';
import {
  useAssignOptions,
  useAssignTrip,
  useDetachFromTrip,
  useDispatchTrip,
  usePrintTripSheet,
  useReorderStops,
  useRevokeTripSheetLinks,
  useTrip,
  useTripSheetLink,
  type TripDetail,
  type TripSheetLink,
} from './useTrips';
import { sortVehicles } from './assignForm';
import { SubconHireDrawer } from './SubconHireDrawer';
import { SubconOfferDrawer } from './SubconOfferDrawer';
import { tripProblemText } from './tripProblem';
import { RECORDABLE, restStops } from './tripStepper';
import { useTripEvents } from './useTripTimeline';
import { TripTimeline } from './TripTimeline';
import { TripDocsTab } from '../pod/TripDocsTab';
import { FieldChargesTab } from './FieldChargesTab';
import { TripCostCloseButton, TripMoneySection } from './TripCost';

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

/** เที่ยวที่ไม่ส่งลิงก์ใบคุมรถให้คนขับแล้ว */
const DONE_FOR_SHARE = new Set(['COMPLETED', 'COSTED', 'SETTLED', 'CANCELLED']);

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
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(true, box); // ST9-T20
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        ref={box}
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('trip.detach.title')}
        tabIndex={-1}
        data-modal-focus=""
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

const PICK_LABEL = { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } as const;
const PICK_CAP = { fontSize: 12.5, fontWeight: 500, color: '#59606B' } as const;
const PICK_SELECT = {
  height: 40,
  padding: '0 10px',
  border: '1px solid #CDD1C8',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
} as const;

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

/** ปัญหา 409 กฎตอนจัด (ST3-T14) จาก /assign /dispatch → รายการบล็อก/คำเตือนพร้อม `key` */
type RuleProblem = { kind: 'block' | 'warn'; reasons: BlockedReason[] };
const ruleProblem = (err: unknown): RuleProblem | null => {
  if (!(err instanceof ApiError)) return null;
  const p = err.problem as unknown as { blocks?: BlockedReason[]; warnings?: BlockedReason[] };
  if (err.problem.code === 'assignment_blocked') return { kind: 'block', reasons: p.blocks ?? [] };
  if (err.problem.code === 'assignment_warnings')
    return { kind: 'warn', reasons: p.warnings ?? [] };
  return null;
};

/**
 * "ส่งให้คนขับ" (ST3-T20 — ต้นแบบไม่มี: spec/12 §3 DECISION) — ลิงก์เปิด PDF ใบคุมรถไม่ต้อง login + คัดลอก
 * กรอบ `tms-dialog` + แถวลิงก์แบบเดียวกับ "ลิงก์อัปโหลดเอกสาร" ของผู้รับเหมา (ST2-T21) · ส่ง LINE/SMS ถึงคนขับโดยตรง = ST4
 */
function ShareDialog({
  tripId,
  link,
  driver,
  onCopied,
  onRevoked,
  onClose,
}: {
  tripId: string;
  link: TripSheetLink;
  driver: string | null;
  onCopied: () => void;
  onRevoked: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dateTime = useDateTimeText();
  const revoke = useRevokeTripSheetLinks();
  const [asking, setAsking] = useState(false);
  const [revokeErr, setRevokeErr] = useState<string | null>(null);
  useEscapeLayer(!asking, onClose);
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(true, box); // ST9-T20
  const copy = () => {
    void navigator.clipboard?.writeText(link.url).catch(() => undefined);
    onCopied();
  };
  return (
    <>
      <div className="tms-dialog__scrim" onClick={onClose}>
        <div
          ref={box}
          className="tms-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('trip.share.title')}
          tabIndex={-1}
          data-modal-focus=""
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tms-dialog__head">
            <div style={{ flex: 1 }}>
              <h2 className="tms-dialog__title">{t('trip.share.title')}</h2>
              <p className="tms-dialog__desc">
                {t('trip.share.desc', {
                  driver: driver ?? t('trip.share.driver'),
                  until: dateTime(link.expiresAt),
                })}
              </p>
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
            <div className="tms-vdoc__file" data-testid="trip-share-link">
              <Icon n="link" s={16} style={{ color: '#2257C4' }} />
              <span
                className="tms-num tms-ellipsis"
                style={{ flex: 1, fontSize: 13 }}
                title={link.url}
              >
                {link.url}
              </span>
              <button type="button" className="tms-vdoc__renew" onClick={copy}>
                {t('trip.share.copy')}
              </button>
            </div>
            <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('trip.share.snapshot')}</span>
          </div>
          <div className="tms-dialog__foot">
            <button
              type="button"
              className="tms-dialog__cancel"
              style={{ color: '#B3322A', marginRight: 'auto' }}
              onClick={() => {
                setRevokeErr(null);
                setAsking(true);
              }}
            >
              {t('trip.share.revoke')}
            </button>
            <button type="button" className="tms-dialog__cancel" onClick={onClose}>
              {t('trip.share.close')}
            </button>
          </div>
        </div>
      </div>
      <ReasonDialog
        open={asking}
        title={t('trip.share.revokeTitle')}
        description={t('trip.share.revokeDesc')}
        label={t('trip.share.revokeReason')}
        placeholder={t('trip.share.revokePh')}
        okLabel={t('trip.share.revokeOk')}
        cancelLabel={t('trip.share.close')}
        closeLabel={t('drawer.close')}
        minLength={10}
        hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
        busy={revoke.isPending}
        error={revokeErr}
        onClose={() => setAsking(false)}
        onOk={(reason) =>
          revoke.mutate(
            { id: tripId, reason },
            {
              onSuccess: () => {
                setAsking(false);
                onRevoked();
              },
              onError: (e) => setRevokeErr(problemText(e, t)),
            },
          )
        }
      />
    </>
  );
}

/**
 * Drawer เที่ยวรถ / ใบคุมรถ (ST3-T16 — ต้นแบบ TMS v4 vPanel kind 'trp'): ข้อมูลเที่ยว + "จุดรับ / ส่ง ตามลำดับ"
 * เลื่อนขึ้น/ลง (เรียงจุดเอง — กันส่งก่อนรับ) · นำออกจากเที่ยว · ระยะ/เวลารวม (เพิ่มจากต้นแบบ — spec/12 §3 DECISION)
 * ST3-T17: ส่วน "รถ / คนขับ" (ต้นแบบ drawer SO: ลิงก์ "จัดรถ" → select รถ + คนขับ) + footer "จัดรถ" (→ ASSIGNED ยังไม่ส่งงาน)
 * แยกจาก "ปล่อยเที่ยว" (จัดรถและปล่อย → DISPATCHED ทุก DO) — docs/04 D2 · 409 กฎตอนจัด → dialog ยกเว้น/ยืนยันแล้วส่งซ้ำ
 * ST3-T20: footer "พิมพ์ใบคุมรถ" (ต้นแบบ sec — สร้าง PDF ใหม่แล้วดาวน์โหลด) + "ส่งให้คนขับ" (คัดลอกลิงก์ PDF — spec/12 §3)
 * ST4-T04: แท็บ "ไทม์ไลน์" (ต้นแบบ tl — ความคืบหน้าเที่ยวต่อจุด) + บันทึกแทนคนขับ (`trips:dispatch`) + footer
 * "ส่งไม่สำเร็จจุดที่เหลือ" · แท็บเอกสาร (POD/ใบคุมรถ) = ST4-T07 · ST4-T13 แท็บ "ค่าใช้จ่ายหน้างาน" (FieldChargesTab)
 */
export function TripDrawer({
  id,
  canEdit,
  canDispatch = false,
  canOverride = false,
  canPrint = false,
  canHire = false,
  canClose = false,
  canSeeBuy = false,
  canSeeSell = false,
  onDone,
  onClose,
}: {
  id: string;
  /** `trips:assign` */
  canEdit: boolean;
  /** `trips:dispatch` — ปุ่ม "ปล่อยเที่ยว" */
  canDispatch?: boolean;
  /** `trips:override` — ยกเว้นบล็อกกฎเอกสาร (D-07) */
  canOverride?: boolean;
  /** `documents:write` — พิมพ์ใบคุมรถ (สร้างไฟล์ PDF) · ส่งให้คนขับต้องมี `trips:dispatch` ด้วย */
  canPrint?: boolean;
  /** ST3-T22 จ้างรถร่วม: `trips:assign` + `prices.buy:read` — ปุ่ม "ส่งต่อรถร่วม" ของเที่ยวที่ยังวางแผน */
  canHire?: boolean;
  /** `trips:close` — ปุ่ม "ปิดต้นทุนเที่ยว" ของเที่ยวที่จบแล้ว (ST6-T01 API · UI UAT 24 พ.ย.) */
  canClose?: boolean;
  /** `prices.buy:read` — ยอดค่าเที่ยว/ต้นทุนในส่วนข้อมูล */
  canSeeBuy?: boolean;
  /** `prices.sell:read` — "รายได้จาก DO" ในส่วนยอดเงิน (กำไร = ต้องมีทั้งสองสิทธิ์) */
  canSeeSell?: boolean;
  /** ปล่อยเที่ยวสำเร็จ → ผู้เรียกแสดง toast แล้วปิด drawer (ต้นแบบ releaseTrp: ปิดแผง + toast) */
  onDone?: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const nav = useNavigate();
  const q = useTrip(id);
  const reorder = useReorderStops();
  const detach = useDetachFromTrip();
  const [err, setErr] = useState<string | null>(null);
  /** จุดที่กด × และมีหลายใบส่งของ → dialog ยืนยัน */
  const [ask, setAsk] = useState<TripDetail['stops'][number] | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const assign = useAssignTrip();
  const dispatch = useDispatchTrip();
  const print = usePrintTripSheet();
  const shareLink = useTripSheetLink();
  const [share, setShare] = useState<TripSheetLink | null>(null);
  /** ฟอร์มจัดรถ (ต้นแบบ pf.pick) — ค่าเริ่มจากเที่ยว (รถที่วางไว้ + คนขับเดิม) */
  const [picking, setPicking] = useState(false);
  /** `auto` = คนขับตามคนขับประจำของรถที่เลือก (ยังไม่เลือกเอง — ต้นแบบ onVeh: d = V[n].d) */
  const [form, setForm] = useState<{
    veh: string;
    drv: string;
    relief: string;
    auto: boolean;
  } | null>(null);
  /** 409 กฎตอนจัด → dialog · `retry(reason, keys)` ส่งคำขอเดิมซ้ำพร้อมกุญแจที่ยืนยันแล้วทั้งหมด */
  const [rule, setRule] = useState<
    (RuleProblem & { retry: (reason: string, keys: string[]) => void }) | null
  >(null);
  const [ruleErr, setRuleErr] = useState<string | null>(null);
  /** ST3-T22 เปิด drawer "จ่ายงานรถร่วม" ของเที่ยวนี้ */
  const [hiring, setHiring] = useState(false);
  const [nextHire, setNextHire] = useState(false);
  /** ST3-T25 เปลี่ยนผู้รับเหมา: เหตุผลจาก ReasonDialog ใน drawer จ่ายงานรถร่วม → drawer จ้างแบบเปลี่ยนราย */
  const [changeWhy, setChangeWhy] = useState<string | null>(null);
  /** ST4-T04 แท็บ รายละเอียด / ไทม์ไลน์ · ST4-T07 เอกสาร (ป้าย "เอกสารแนบ" ตามต้นแบบ) · ST4-T13 ค่าใช้จ่ายหน้างาน */
  const [tab, setTab] = useState<'sum' | 'tl' | 'docs' | 'exp'>('sum');
  const [failRest, setFailRest] = useState(false);
  /** ไทม์ไลน์ (แชร์ cache กับแท็บ) — footer "ส่งไม่สำเร็จจุดที่เหลือ" ไม่นับจุดที่มีปิดงานรอตัดสิน */
  const tl = useTripEvents(id, tab === 'tl');
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const tr = q.data;
  const assignable =
    !!tr && canEdit && (tr.status === 'PLANNING' || tr.status === 'ASSIGNED') && !tr.carrier;
  const opts = useAssignOptions(tr?.carrier?.id ?? null, assignable && picking);
  const vehicles = useMemo(
    () =>
      sortVehicles(opts.vehicles.data ?? [], tr?.vehicle?.id ?? null, Number(tr?.weightKg ?? 0)),
    [opts.vehicles.data, tr?.vehicle?.id, tr?.weightKg],
  );
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

  // ST3-T23 หลังส่งข้อเสนอ: drawer "จ่ายงานรถร่วม" สถานะรอตอบ/รับงาน (ลิงก์ · ส่ง LINE · กิจกรรม)
  // ST3-T24 "ส่งรายถัดไป" ระหว่างรอตอบ (ครบ N ชม.) → drawer จ้างรถร่วมแบบแทนรายเดิม (replaceOffer)
  // ST3-T25 เปลี่ยนผู้รับเหมา (รอตอบ / รับงานแล้วแต่ยังไม่ปล่อยรถ) → drawer จ้างแบบเปลี่ยนราย (changeReason)
  const replacing = hiring && nextHire && tr.status === 'OFFERED' && !!tr.hire;
  const changing =
    hiring &&
    changeWhy !== null &&
    !!tr.hire &&
    (tr.status === 'OFFERED' || tr.status === 'ASSIGNED');
  if (hiring && tr.hire && !replacing && !changing)
    return (
      <SubconOfferDrawer
        trip={tr}
        onClose={() => setHiring(false)}
        onNext={() => setNextHire(true)}
        onChangeCarrier={(why) => setChangeWhy(why)}
      />
    );
  if (hiring && (tr.status === 'PLANNING' || replacing || changing))
    return (
      <SubconHireDrawer
        trip={tr}
        replace={replacing && !changing}
        change={changing ? changeWhy : null}
        onClose={() => {
          setHiring(false);
          setNextHire(false);
          setChangeWhy(null);
        }}
        onDone={(m) => {
          setHiring(false);
          setNextHire(false);
          setChangeWhy(null);
          if (onDone) {
            onDone(m);
            onClose();
          } else setToast(m);
        }}
      />
    );
  const ed = canEdit && EDITABLE.has(tr.status);
  const busy = reorder.isPending || detach.isPending || assign.isPending || dispatch.isPending;
  const defaultDriverOf = (veh: string) => {
    const ds = (opts.drivers.data ?? []).filter((d) => d.defaultVehicle?.id === veh);
    return ds.length === 1 ? ds[0]!.id : '';
  };
  const f0 = form ?? {
    veh: tr.vehicle?.id ?? '',
    drv: tr.driver?.id ?? '',
    relief: tr.reliefDriver?.id ?? '',
    auto: !tr.driver,
  };
  const f = f0.auto ? { ...f0, drv: defaultDriverOf(f0.veh) } : f0;
  const drivers = opts.drivers.data ?? [];
  const startPick = () => {
    setErr(null);
    setForm(f);
    setPicking(true);
  };
  const doneMsg = (x: TripDetail) =>
    x.status === 'DISPATCHED'
      ? t('trip.toast.released', { n: 1 })
      : t('trip.toast.assigned', {
          no: x.tripNo,
          plate: x.vehicle?.plate ?? '—',
          driver: x.driver?.name ?? '—',
        });
  const onFail =
    (send: (keys: string[], reason: string | null) => void, keys: string[], fromDialog: boolean) =>
    (e: unknown) => {
      const r = ruleProblem(e);
      if (!r) {
        if (fromDialog) setRuleErr(tripProblemText(e, t));
        else setErr(tripProblemText(e, t));
        return;
      }
      setRuleErr(null);
      // ส่งซ้ำพร้อมกุญแจที่ยืนยัน/ยกเว้นแล้วทั้งหมด (บล็อกก่อน → คำเตือนตอนปล่อยรถ อาจถามสองรอบ)
      setRule({
        ...r,
        retry: (reason, more) => send([...new Set([...keys, ...more])], reason),
      });
    };
  /**
   * ส่งการจัดรถ: `release` = จัดรถและปล่อยเที่ยว · เที่ยว ASSIGNED ที่ไม่ได้เปิดฟอร์ม + ปล่อย = /dispatch อย่างเดียว
   * ไม่ได้เปิดฟอร์ม = รถที่วางไว้ + คนขับเดิม/คนขับประจำรถ (server เลือก — ไม่มี → 422 แล้วเปิดฟอร์ม)
   */
  const submit = (release: boolean) => {
    if (busy) return;
    setErr(null);
    const onlyDispatch = release && tr.status === 'ASSIGNED' && !picking;
    if (!onlyDispatch && !f.veh) {
      startPick();
      return;
    }
    const send = (keys: string[], reason: string | null) => {
      const rules = keys.length ? { ruleKeys: keys, overrideReason: reason } : {};
      const ok = (x: TripDetail) => {
        setRule(null);
        setPicking(false);
        setForm(null);
        const m = doneMsg(x);
        const i = x.warnings
          .filter((w) => !w.confirmed && w.severity !== 'info')
          .map((w) => w.message)
          .join(' · ');
        const msg = i ? t('plan.toast.issue', { m, i }) : m;
        if (x.status === 'DISPATCHED' && onDone) {
          onDone(msg);
          onClose();
        } else setToast(msg);
      };
      const fail = onFail(send, keys, reason !== null);
      if (onlyDispatch)
        dispatch.mutate(
          { id: tr.id, version: tr.version, body: rules },
          { onSuccess: ok, onError: fail },
        );
      else
        assign.mutate(
          {
            id: tr.id,
            version: tr.version,
            body: {
              vehicleId: f.veh,
              ...(picking || tr.driver ? { driverId: f.drv || null } : {}),
              ...(picking ? { reliefDriverId: f.relief || null } : {}),
              ...(release ? { dispatch: true } : {}),
              ...rules,
            },
          },
          {
            onSuccess: ok,
            onError: (e) => {
              if (!picking && !ruleProblem(e)) setPicking(true);
              fail(e);
            },
          },
        );
    };
    send([], null);
  };
  const assignedNow = tr.status === 'ASSIGNED';
  const showAssignBtn = assignable && (!assignedNow || picking);
  const showRelease =
    canDispatch &&
    tr.deliveryOrders.length > 0 &&
    (assignedNow || (tr.status === 'PLANNING' && assignable));
  // ST3-T20 ใบคุมรถ: เที่ยวที่ยกเลิกไม่มีปุ่ม (API 409) · ไม่มีจุดแวะ = กดไม่ได้ (API 409 trip_empty)
  const showPrint = canPrint && tr.status !== 'CANCELLED';
  // ST3-T22 ส่งต่อรถร่วม: เที่ยวที่ยังวางแผน มีใบส่งของ และยังไม่จ้าง (ต้นแบบ footer drawer SO "ส่งต่อรถร่วม")
  const showHire =
    canHire && canEdit && tr.status === 'PLANNING' && !tr.carrier && tr.deliveryOrders.length > 0;
  // ST3-T23 การจ้างที่ใช้งานอยู่ (รอตอบ/รับงาน) → เปิด drawer "จ่ายงานรถร่วม" ดูลิงก์/ส่ง LINE/กิจกรรม
  const showOffer = canHire && !!tr.hire && tr.status !== 'CANCELLED';
  // ไม่มีคนขับ (ยังไม่จัด/รถร่วมยังไม่ใส่คนขับ) = ไม่มีผู้รับลิงก์ (review ST3-T20 L6)
  // ST4-T04 (review L5): เที่ยวจบ/ยกเลิกแล้วไม่ส่งลิงก์ใบคุมรถให้คนขับ · ระหว่างวิ่งยังส่งซ้ำได้ (คนขับทำลิงก์หาย)
  const showShare = showPrint && canDispatch && !!tr.driver && !DONE_FOR_SHARE.has(tr.status);
  // ปิดต้นทุนเที่ยว (COMPLETED → COSTED — ST6-T01) [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ]
  const showCost = canClose && tr.status === 'COMPLETED' && tab === 'sum';
  const sheetBusy = print.isPending || shareLink.isPending;
  const printSheet = () => {
    setErr(null);
    print.mutate(tr.id, {
      onSuccess: () => setToast(t('trip.toast.printed', { no: tr.tripNo })),
      onError: (e) => setErr(problemText(e, t)),
    });
  };
  const openShare = () => {
    setErr(null);
    shareLink.mutate(tr.id, {
      onSuccess: setShare,
      onError: (e) => setErr(problemText(e, t)),
    });
  };
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
  // ST4-T04 บันทึกแทนคนขับ: เที่ยวปล่อยแล้ว/กำลังวิ่ง + `trips:dispatch` (API เดียวกับลิงก์/แอป)
  const canRecord = canDispatch && RECORDABLE.has(tr.status);
  const showFailRest = tab === 'tl' && canRecord && restStops(tr.stops, tl.data ?? []).length > 0;
  /** ธงของเที่ยวนี้ → ศูนย์ข้อยกเว้น กรองเลขเที่ยว แท็บ "ใหม่" */
  const openFlags = () => {
    writeSession('exc.tab', 'open');
    writeSession('exc.today', false);
    writeSession('exc.cols', { flag: '', q: tr.tripNo });
    onClose();
    nav('/exceptions');
  };
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
      tabs={[
        { key: 'sum', label: t('drawer.tab.sum') },
        { key: 'tl', label: t('trip.tab.tl') },
        { key: 'docs', label: t('trip.tab.docs') },
        // ST4-T13 ค่าใช้จ่ายหน้างาน (ต้นแบบ: แท็บของ drawer DO — ระบบยังไม่มี drawer DO)
        { key: 'exp', label: t('trip.tab.exp') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k === 'tl' || k === 'docs' || k === 'exp' ? k : 'sum')}
      labels={labels}
      footer={
        <>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>
              {t('trip.foot.dos')}
            </span>
            <span className="tms-num" style={{ fontSize: 20, fontWeight: 600, color: '#101418' }}>
              {t('trip.foot.n', {
                n: tr.deliveryOrders.length + (tr.rescheduledDeliveryOrders?.length ?? 0),
              })}
              {(tr.rescheduledDeliveryOrders?.length ?? 0) > 0 && (
                <span style={{ fontSize: 13, fontWeight: 500, color: '#3B424C' }}>
                  {t('trip.foot.rescheduled', { n: tr.rescheduledDeliveryOrders.length })}
                </span>
              )}
            </span>
          </div>
          <span style={{ flex: 1 }} />
          {err && (
            <span className="tms-field-error" role="alert">
              {err}
            </span>
          )}
          {(showAssignBtn ||
            showRelease ||
            showPrint ||
            showHire ||
            showOffer ||
            showFailRest ||
            showCost) && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                flexWrap: 'wrap',
                marginLeft: 'auto',
              }}
            >
              {showFailRest && (
                <button
                  type="button"
                  className="tms-drawer__sec"
                  style={{ color: '#B3322A' }}
                  onClick={() => {
                    setErr(null);
                    setFailRest(true);
                  }}
                >
                  {t('trip.tl.failRest')}
                </button>
              )}
              {showPrint && (
                <button
                  type="button"
                  className="tms-drawer__sec"
                  disabled={sheetBusy || !tr.stops.length}
                  onClick={printSheet}
                >
                  {t('trip.foot.print')}
                </button>
              )}
              {showShare && (
                <button
                  type="button"
                  className="tms-drawer__sec"
                  disabled={sheetBusy || !tr.stops.length}
                  onClick={openShare}
                >
                  {t('trip.foot.share')}
                </button>
              )}
              {showOffer && (
                <button
                  type="button"
                  className="tms-drawer__sec"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    setHiring(true);
                  }}
                >
                  {t('trip.foot.subconView')}
                </button>
              )}
              {showHire && (
                <button
                  type="button"
                  className="tms-drawer__sec"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    setHiring(true);
                  }}
                >
                  {t(
                    tr.assignmentStatus === 'REJECTED' || tr.assignmentStatus === 'EXPIRED'
                      ? 'trip.foot.subconNext'
                      : 'trip.foot.subcon',
                  )}
                </button>
              )}
              {showAssignBtn && (
                <button
                  type="button"
                  className="tms-drawer__sec"
                  disabled={busy}
                  onClick={() => submit(false)}
                >
                  {t('trip.foot.assign')}
                </button>
              )}
              {showCost && (
                <TripCostCloseButton
                  trip={tr}
                  onDone={(m) => {
                    setToast(m);
                  }}
                />
              )}
              {showRelease && (
                <button
                  type="button"
                  className="tms-drawer__pri"
                  disabled={busy}
                  onClick={() => submit(true)}
                >
                  <Icon n="send" s={16} />
                  {t('trip.foot.release')}
                </button>
              )}
            </div>
          )}
        </>
      }
    >
      {tab === 'exp' ? (
        <FieldChargesTab trip={tr} onToast={setToast} />
      ) : tab === 'docs' ? (
        <TripDocsTab
          trip={tr}
          canEdit={canDispatch}
          onPrintSheet={showPrint && tr.stops.length ? printSheet : undefined}
          printBusy={sheetBusy}
          onToast={setToast}
        />
      ) : tab === 'tl' ? (
        <TripTimeline
          trip={tr}
          canRecord={canRecord}
          failRest={failRest && canRecord}
          onFailRestClose={() => setFailRest(false)}
          onToast={setToast}
          onOpenFlags={openFlags}
        />
      ) : (
        <>
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
          <TripMoneySection trip={tr} canSeeBuy={canSeeBuy} canSeeSell={canSeeSell} />
          {assignable && (
            <section
              data-testid="trip-assign"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                paddingBottom: 20,
                borderBottom: '1px solid #E4E6E0',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3B424C' }}>
                  {t('trip.as.title')}
                </span>
              </div>
              {!picking && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ color: '#3B424C' }}>
                    {t(assignedNow ? 'trip.as.assigned' : 'trip.as.none')}
                  </span>
                  <button
                    type="button"
                    onClick={startPick}
                    style={{
                      border: 0,
                      background: 'transparent',
                      padding: 0,
                      color: '#2257C4',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {t(assignedNow ? 'trip.as.change' : 'trip.as.pick')}
                  </button>
                </div>
              )}
              {picking && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                    gap: 12,
                  }}
                >
                  <label style={PICK_LABEL}>
                    <span style={PICK_CAP}>{t('trip.as.vehicle')}</span>
                    <select
                      aria-label={t('trip.as.vehicle')}
                      value={f.veh}
                      onChange={(e) => setForm({ ...f, veh: e.target.value, auto: true })}
                      style={PICK_SELECT}
                    >
                      {!f.veh && <option value="">—</option>}
                      {vehicles.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.payloadKg
                            ? t('trip.as.vehOpt', {
                                p: v.plate,
                                t: v.vehicleType.name,
                                w: v.payloadKg.toLocaleString('th-TH'),
                              })
                            : t('trip.as.vehOptNoCap', { p: v.plate, t: v.vehicleType.name })}
                        </option>
                      ))}
                      {tr.vehicle && !vehicles.some((v) => v.id === tr.vehicle!.id) && (
                        <option value={tr.vehicle.id}>{tr.vehicle.plate}</option>
                      )}
                    </select>
                  </label>
                  <label style={PICK_LABEL}>
                    <span style={PICK_CAP}>{t('trip.as.driver')}</span>
                    <select
                      aria-label={t('trip.as.driver')}
                      value={f.drv}
                      onChange={(e) => setForm({ ...f, drv: e.target.value, auto: false })}
                      style={PICK_SELECT}
                    >
                      <option value="">{t('trip.as.pickDriver')}</option>
                      {drivers.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.licenceClass
                            ? t('plan.driver', {
                                n: d.name,
                                l: t(`vt.lic.${d.licenceClass}` as MessageKey),
                              })
                            : d.name}
                        </option>
                      ))}
                      {tr.driver && !drivers.some((d) => d.id === tr.driver!.id) && (
                        <option value={tr.driver.id}>{tr.driver.name}</option>
                      )}
                    </select>
                  </label>
                  <label style={PICK_LABEL}>
                    <span style={PICK_CAP}>{t('trip.as.relief')}</span>
                    <select
                      aria-label={t('trip.as.relief')}
                      value={f.relief}
                      onChange={(e) => setForm({ ...f, relief: e.target.value })}
                      style={PICK_SELECT}
                    >
                      <option value="">{t('trip.as.noRelief')}</option>
                      {drivers
                        .filter((d) => d.id !== f.drv)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      {tr.reliefDriver && !drivers.some((d) => d.id === tr.reliefDriver!.id) && (
                        <option value={tr.reliefDriver.id}>{tr.reliefDriver.name}</option>
                      )}
                    </select>
                  </label>
                </div>
              )}
              {picking && (opts.vehicles.isError || opts.drivers.isError) && (
                <span className="tms-field-error">{t('trip.as.loadError')}</span>
              )}
              {tr.warnings.some((w) => !w.confirmed && w.severity !== 'info') && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {tr.warnings
                    .filter((w) => !w.confirmed && w.severity !== 'info')
                    .map((w) => (
                      <span
                        key={`${w.code}|${w.message}`}
                        style={{ display: 'flex', gap: 6, color: '#8F5500', fontWeight: 500 }}
                      >
                        <Icon n="triangle-alert" s={16} style={{ marginTop: 3, flexShrink: 0 }} />
                        {w.message}
                      </span>
                    ))}
                </div>
              )}
            </section>
          )}
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
        </>
      )}
      {ask && (
        <DetachDialog
          dos={ask.deliveryOrderIds.map((x) => ({ id: x, doNo: doNo(x) }))}
          busy={detach.isPending}
          error={askErr}
          onOk={(ids) => detachDos(ids, true)}
          onClose={() => setAsk(null)}
        />
      )}
      <BlockedDialog
        open={rule?.kind === 'block'}
        plate={tr.vehicle?.plate ?? '—'}
        sub={[tr.vehicle?.vehicleTypeName, tr.driver?.name].filter(Boolean).join(' · ')}
        reasons={rule?.kind === 'block' ? rule.reasons : []}
        canOverride={canOverride}
        busy={busy}
        error={ruleErr}
        onLink={(code) => {
          setRule(null);
          onClose();
          nav(code.startsWith('DRIVER_') ? '/fleet/drivers' : '/fleet/documents');
        }}
        onClose={() => setRule(null)}
        onOk={(reason, keys) => rule?.retry(reason, keys)}
      />
      {rule?.kind === 'warn' && (
        <ReasonDialog
          open
          title={t('trip.warn.title')}
          description={t('trip.warn.desc', { no: tr.tripNo })}
          diff={{
            rows: rule.reasons.map((r) => ({
              f: t('plan.ack.field'),
              b: r.message,
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
          busy={busy}
          error={ruleErr}
          onClose={() => setRule(null)}
          onOk={(reason) =>
            rule.retry(
              reason,
              rule.reasons.map((r) => r.key).filter((k): k is string => !!k),
            )
          }
        />
      )}
      {share && (
        <ShareDialog
          tripId={tr.id}
          link={share}
          driver={tr.driver?.name ?? null}
          onCopied={() => setToast(t('trip.share.copied'))}
          onRevoked={() => {
            setShare(null);
            setToast(t('trip.share.revoked'));
          }}
          onClose={() => setShare(null)}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </Drawer>
  );
}
