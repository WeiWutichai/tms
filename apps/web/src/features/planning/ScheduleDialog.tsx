import { Icon, useEscapeLayer, useModalFocus } from '@tms/ui';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n';
import { RefPicker, type RefOption } from '../master/RefPicker';
import type { ScheduleEntry } from './board';

const INPUT: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #CDD1C8',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  fontSize: 14,
  width: '100%',
  boxSizing: 'border-box',
};

export interface ScheduleDraft {
  driverId: string;
  startsOn: string;
  endsOn: string;
  note: string;
}

/**
 * ใส่วันลาคนขับ / เพิ่มโน้ต (ST3-T19 ตารางรถ/คนขับรายวัน — docs/04 D2 "คลิกขวาใส่วันลา/โน้ต")
 * ต้นแบบไม่มีหน้าจอนี้ → กรอบ dialog ชุดเดียวกับกระดาน (`tms-dialog` ของ ReasonDialog/SendAllDialog) ·
 * ช่อง: คนขับ (วันลา) · ตั้งแต่/ถึงวันที่ (ค่าเริ่ม = วันของช่องที่คลิกขวา) · เหตุผลการลา/โน้ต · spec/12 §3 DECISION
 */
export function ScheduleDialog({
  kind,
  title,
  description,
  initial,
  initialDriver,
  searchDrivers,
  useLeaves,
  dayRange,
  onCancelLeave,
  busy,
  error,
  fieldErrors,
  onOk,
  onClose,
}: {
  kind: 'LEAVE' | 'NOTE';
  title: string;
  description: string;
  initial: ScheduleDraft;
  /** คนขับที่เลือกไว้ตอนเปิด (คนขับประจำของรถ) */
  initialDriver: RefOption | null;
  /** ค้นคนขับ (ACTIVE) — ค้นหาแทนรายการ 200 คน (review L4) */
  searchDrivers: (q: string) => Promise<RefOption[]>;
  /** วันลาที่ยังไม่ยกเลิกของคนขับที่เลือก (QA M1 — หา/ยกเลิกวันลาของคนขับที่ไม่มีแถวรถได้) */
  useLeaves: (driverId: string | null) => { data?: ScheduleEntry[] };
  dayRange: (e: ScheduleEntry) => string;
  onCancelLeave: (e: ScheduleEntry) => void;
  busy?: boolean;
  error?: string | null;
  fieldErrors?: Record<string, string>;
  onOk: (d: ScheduleDraft) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [d, setD] = useState(initial);
  const [drv, setDrv] = useState<RefOption | null>(initialDriver);
  const leaves = useLeaves(kind === 'LEAVE' ? d.driverId || null : null).data ?? [];
  const sent = useRef(false);
  useEscapeLayer(true, onClose);
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(true, box); // ST9-T20 focus เข้า/วน/คืน
  // คำขอจบ (ผิดพลาด) → กดบันทึกใหม่ได้ · สำเร็จ = parent ปิด dialog
  useEffect(() => {
    if (!busy) sent.current = false;
  }, [busy, error]);
  const set = (k: keyof ScheduleDraft) => (v: string) => {
    sent.current = false;
    setD((x) => ({ ...x, [k]: v }));
  };
  const ok =
    !!d.startsOn &&
    !!d.endsOn &&
    d.endsOn >= d.startsOn &&
    d.note.trim().length > 0 &&
    (kind === 'NOTE' || !!d.driverId) &&
    !busy;
  const fe = fieldErrors ?? {};
  const label = (text: string) => (
    <span className="tms-label">
      {text} <span style={{ color: '#B3322A' }}>*</span>
    </span>
  );
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        ref={box}
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        data-modal-focus=""
        aria-labelledby={`${id}-t`}
        data-testid="schedule-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 id={`${id}-t`} className="tms-dialog__title">
              {title}
            </h2>
            <p className="tms-dialog__desc">{description}</p>
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
          {kind === 'LEAVE' && (
            <label className="tms-field" htmlFor={`${id}-d`}>
              {label(t('plan.sch.driver'))}
              <RefPicker
                id={`${id}-d`}
                value={drv}
                onChange={(v) => {
                  setDrv(v);
                  set('driverId')(v?.id ?? '');
                }}
                search={searchDrivers}
                queryKey="plan-leave-drivers"
                placeholder={t('plan.sch.pickDriver')}
                noResult={t('plan.sch.noDriver')}
                invalid={!!fe.driverId}
                style={{ height: 36 }}
              />
              {fe.driverId && <span className="tms-field-error">{fe.driverId}</span>}
            </label>
          )}
          {kind === 'LEAVE' && leaves.length > 0 && (
            <div
              data-testid="schedule-existing"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '10px 12px',
                borderRadius: 10,
                background: '#F4F5F2',
              }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3B424C' }}>
                {t('plan.sch.existing')}
              </span>
              {leaves.map((e) => (
                <div
                  key={e.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    minWidth: 0,
                  }}
                >
                  <Icon n="coffee" s={14} style={{ color: '#59606B', flexShrink: 0 }} />
                  <span className="tms-num" style={{ whiteSpace: 'nowrap' }}>
                    {dayRange(e)}
                  </span>
                  <span
                    style={{
                      color: '#3B424C',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {e.note}
                  </span>
                  <button
                    type="button"
                    onClick={() => onCancelLeave(e)}
                    style={{
                      border: 0,
                      background: 'transparent',
                      padding: 0,
                      color: '#B3322A',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('plan.sch.cancelShort')}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label className="tms-field" htmlFor={`${id}-f`}>
              {label(t('plan.sch.from'))}
              <input
                id={`${id}-f`}
                type="date"
                value={d.startsOn}
                onChange={(e) => {
                  const v = e.target.value;
                  set('startsOn')(v);
                  // เลื่อนวันเริ่มเลยวันสิ้นสุด → ตามไปด้วย
                  if (v && d.endsOn < v) set('endsOn')(v);
                }}
                style={INPUT}
                aria-invalid={!!fe.startsOn}
              />
              {fe.startsOn && <span className="tms-field-error">{fe.startsOn}</span>}
            </label>
            <label className="tms-field" htmlFor={`${id}-e`}>
              {label(t('plan.sch.to'))}
              <input
                id={`${id}-e`}
                type="date"
                value={d.endsOn}
                min={d.startsOn}
                onChange={(e) => set('endsOn')(e.target.value)}
                style={INPUT}
                aria-invalid={!!fe.endsOn}
              />
              {fe.endsOn && <span className="tms-field-error">{fe.endsOn}</span>}
            </label>
          </div>
          <label className="tms-field" htmlFor={`${id}-n`}>
            {label(kind === 'LEAVE' ? t('plan.sch.reason') : t('plan.sch.note'))}
            <textarea
              id={`${id}-n`}
              className="tms-textarea"
              rows={3}
              maxLength={500}
              value={d.note}
              placeholder={kind === 'LEAVE' ? t('plan.sch.reasonPh') : t('plan.sch.notePh')}
              onChange={(e) => set('note')(e.target.value)}
              autoFocus={kind === 'NOTE' || !!initial.driverId}
            />
            {fe.note && <span className="tms-field-error">{fe.note}</span>}
          </label>
          {error && <span className="tms-field-error">{error}</span>}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('plan.send.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={!ok}
            aria-busy={busy}
            onClick={() => {
              if (!ok || sent.current) return;
              sent.current = true;
              onOk({ ...d, note: d.note.trim() });
            }}
          >
            <Icon n="check" s={16} />
            {t('plan.sch.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
