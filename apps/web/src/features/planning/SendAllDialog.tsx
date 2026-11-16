import { Icon, useEscapeLayer } from '@tms/ui';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { formatDayHead, useI18n } from '../../i18n';
import { tripProblemText } from '../trips/tripProblem';
import { sendHint, unsentOn, type Board, type BoardTrip } from './board';

const CHECK: CSSProperties = {
  width: 16,
  height: 16,
  accentColor: '#2257C4',
  margin: 0,
  flexShrink: 0,
};
const SELECT: CSSProperties = {
  height: 32,
  padding: '0 8px',
  border: '1px solid #CDD1C8',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  fontSize: 13,
};

/** ส่งได้ครั้งละไม่เกิน (ตาม API `SEND_ALL_MAX`) */
export const SEND_MAX = 400;
const noCheck = (): Record<string, unknown> | undefined => undefined;

/**
 * "ส่งแผนให้คนขับ" (ST3-T18 Send all — docs/04 D2 "checkbox ส่งงานทั้งวันของทุกรถทีเดียว"; spec/03 §9 dialog):
 * เลือกวัน → checkbox "ส่งงานทั้งวันของทุกรถ" (ติ๊กไว้ก่อน) + รายการเที่ยวที่ยังไม่ส่งของวันนั้นให้ติ๊กออกได้ ·
 * เที่ยวที่คาดว่าส่งไม่ได้ (รอรถร่วมตอบ / ยังไม่ได้วางลงรถ / ติดเงื่อนไข) แสดงเหตุผลแต่ยังส่งได้ — server ตรวจและตอบผลต่อเที่ยว
 * ต้นแบบมีแค่ปุ่มหัวหน้า "ส่งแผนให้คนขับ" (toast) — กรอบ dialog ชุดเดียวกับ BulkFailDialog (`tms-dialog`) · spec/12 §3 DECISION
 */
export function SendAllDialog({
  board,
  days,
  initialDay,
  busy,
  onSend,
  onClose,
  useCheck = noCheck,
}: {
  board: Board;
  /** วันที่เลือกได้ (กระดาน 7 วัน) */
  days: string[];
  initialDay: string;
  busy: boolean;
  onSend: (day: string, trips: BoardTrip[]) => void;
  onClose: () => void;
  /**
   * ตรวจล่วงหน้า (dryRun ของ API — กฎ T14 ชุดเดียวกับตอนส่ง): tripId → problem ที่คาดว่าจะไม่ผ่าน (null = ผ่าน) ·
   * undefined = ยังไม่รู้ (ใช้คำใบ้จากกระดาน)
   */
  useCheck?: (day: string, trips: BoardTrip[]) => Record<string, unknown> | undefined;
}) {
  const { t, lang } = useI18n();
  useEscapeLayer(true, onClose);
  const [day, setDay] = useState(initialDay);
  const list = useMemo(() => unsentOn(board.trips, day), [board.trips, day]);
  /** ส่งได้ตามสถานะ — รอรถร่วมตอบ (OFFERED) ไม่ติ๊กไว้ก่อน (review M1 — ติ๊กเองได้ แต่จะไม่ผ่าน) */
  const sendable = useMemo(() => list.filter((x) => x.status !== 'OFFERED'), [list]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sendable.map((x) => x.id)));
  // เปลี่ยนวัน = ติ๊กทุกเที่ยวที่ส่งได้ของวันใหม่ (ค่าเริ่มต้น "ส่งทั้งวัน")
  const lastDay = useRef(day);
  useEffect(() => {
    if (lastDay.current === day) return;
    lastDay.current = day;
    setPicked(new Set(sendable.map((x) => x.id)));
  }, [day, sendable]);
  const chosen = list.filter((x) => picked.has(x.id));
  const all = sendable.length > 0 && sendable.every((x) => picked.has(x.id));
  const tooMany = chosen.length > SEND_MAX;
  const check = useCheck(day, list.length <= SEND_MAX ? list : []);
  // กดซ้ำ/ดับเบิลคลิก (QA M1): ปิดปุ่มทันทีแบบ synchronous จนคำขอจบ
  const sentRef = useRef(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!busy) {
      sentRef.current = false;
      setSending(false);
    }
  }, [busy]);
  const masterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = chosen.length > 0 && !all;
  }, [chosen.length, all]);
  const send = () => {
    if (sentRef.current || busy || !chosen.length || tooMany) return;
    sentRef.current = true;
    setSending(true);
    onSend(day, chosen);
  };
  const state = board.days.find((d) => d.date === day);
  const vehicles = new Set(sendable.flatMap((x) => (x.vehicleId ? [x.vehicleId] : []))).size;
  const dayLabel = (d: string) =>
    d === board.today ? t('plan.col.today', { d: formatDayHead(d, lang) }) : formatDayHead(d, lang);
  /** คนขับประจำรถ (เที่ยวที่ยังไม่จัดรถ — ส่งแล้วใช้คนขับประจำรถเหมือน bulk จัดรถ) */
  const defDriver = (x: BoardTrip) =>
    board.vehicles.find((v) => v.id === x.vehicleId)?.driver?.name ?? null;
  const driverText = (x: BoardTrip) => {
    if (x.driverName) return x.driverName;
    if (x.carrierName) return x.carrierName;
    const d = defDriver(x);
    // ไม่มีคนขับ = "—" (เหตุผลอยู่ในบรรทัดคำเตือน ไม่พิมพ์ซ้ำ — QA L3)
    return d ? t('plan.send.defaultDriver', { n: d }) : '—';
  };
  const hintText = (x: BoardTrip) => {
    const h = sendHint(x);
    if (h === 'offered') return t('plan.send.hintOffered');
    // ผลตรวจล่วงหน้าจาก server (รวมบล็อกที่จะติดตอนปล่อย เช่น ใบขับขี่หมดอายุ — QA L2)
    const c = check?.[x.id];
    if (c) return tripProblemText(c, t);
    if (check && c === null) return null;
    if (h === 'noVehicle') return t('plan.bulk.noVehicle');
    if (x.status === 'PLANNING' && !defDriver(x)) return t('plan.send.noDriver');
    if (h === 'rule') return x.pendingRules![0]!.message;
    return null;
  };
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('plan.send.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{t('plan.send.title')}</h2>
            <p className="tms-dialog__desc">{t('plan.send.desc')}</p>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: '#3B424C' }}>
              {t('plan.send.day')}
            </span>
            <select
              aria-label={t('plan.send.day')}
              value={day}
              onChange={(e) => setDay(e.target.value)}
              style={SELECT}
            >
              {days.map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d)}
                </option>
              ))}
            </select>
            {state && state.trips > 0 && (
              <span
                className="tms-num"
                style={{
                  marginLeft: 'auto',
                  fontSize: 12.5,
                  color: state.complete ? '#17733F' : '#59606B',
                }}
              >
                {t('plan.send.sentOf', { s: state.sent, n: state.trips })}
              </span>
            )}
          </label>
          {list.length === 0 ? (
            <div
              data-testid="send-all-empty"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 14px',
                borderRadius: 10,
                background: state?.complete ? '#E7F3EC' : '#F4F5F2',
                color: state?.complete ? '#17733F' : '#3B424C',
                fontWeight: 500,
              }}
            >
              <Icon n={state?.complete ? 'circle-check' : 'calendar'} s={16} />
              {state?.complete ? t('plan.send.allSent') : t('plan.send.none')}
            </div>
          ) : (
            <>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  border: '1px solid #9DB6E3',
                  borderRadius: 10,
                  background: '#E9F0FA',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                <input
                  ref={masterRef}
                  type="checkbox"
                  data-testid="send-all-master"
                  checked={all}
                  onChange={() => setPicked(all ? new Set() : new Set(sendable.map((x) => x.id)))}
                  style={CHECK}
                />
                {t('plan.send.all', { n: sendable.length, v: vehicles })}
              </label>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  border: '1px solid #E4E6E0',
                  borderRadius: 10,
                  maxHeight: 320,
                  overflowY: 'auto',
                }}
              >
                {list.map((x, i) => {
                  const plateText = x.vehiclePlate ?? '—';
                  const drv = driverText(x);
                  const raw = hintText(x);
                  // ไม่ซ้ำกับบรรทัดทะเบียน/คนขับ (QA L3)
                  const hint = raw && raw !== plateText && raw !== drv ? raw : null;
                  return (
                    <label
                      key={x.id}
                      data-testid="send-all-row"
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '10px 12px',
                        borderTop: i ? '1px solid #EBEDE8' : 0,
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(x.id)}
                        onChange={() => toggle(x.id)}
                        aria-label={x.tripNo}
                        style={{ ...CHECK, marginTop: 3 }}
                      />
                      <span
                        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
                      >
                        <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                          <span className="tms-num" style={{ fontWeight: 500, color: '#2257C4' }}>
                            {x.tripNo}
                          </span>
                          <span style={{ color: '#101418' }}>{plateText}</span>
                          <span
                            style={{
                              marginLeft: 'auto',
                              fontSize: 12.5,
                              color: '#59606B',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t(`trip.st.${x.status}` as 'trip.st.PLANNING')}
                          </span>
                        </span>
                        <span style={{ fontSize: 12.5, color: '#3B424C' }}>{drv}</span>
                        {hint && (
                          <span
                            style={{
                              display: 'flex',
                              gap: 6,
                              alignItems: 'center',
                              fontSize: 12.5,
                              color: '#8F5500',
                            }}
                          >
                            <Icon n="triangle-alert" s={14} />
                            {hint}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>
        {tooMany && (
          <p
            className="tms-field-error"
            data-testid="send-all-too-many"
            style={{ margin: 0, padding: '0 24px 12px' }}
          >
            {t('plan.send.tooMany', { n: SEND_MAX })}
          </p>
        )}
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('plan.send.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={!chosen.length || busy || sending || tooMany}
            aria-busy={busy || sending}
            onClick={send}
          >
            <Icon n="send" s={16} />
            {t('plan.send.ok', { n: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
