import { Icon, useEscapeLayer } from '@tms/ui';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n';

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
  drivers,
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
  /** ตัวเลือกคนขับ (วันลา) */
  drivers: { id: string; name: string }[];
  busy?: boolean;
  error?: string | null;
  fieldErrors?: Record<string, string>;
  onOk: (d: ScheduleDraft) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [d, setD] = useState(initial);
  const sent = useRef(false);
  useEscapeLayer(true, onClose);
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
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
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
              <select
                id={`${id}-d`}
                value={d.driverId}
                onChange={(e) => set('driverId')(e.target.value)}
                style={INPUT}
                aria-invalid={!!fe.driverId}
              >
                <option value="">{t('plan.sch.pickDriver')}</option>
                {drivers.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              {fe.driverId && <span className="tms-field-error">{fe.driverId}</span>}
            </label>
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
