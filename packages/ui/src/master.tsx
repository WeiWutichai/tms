import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { tone as toneColors, type Tone } from './tokens';

/**
 * ชิ้นส่วนหน้าข้อมูลหลัก (ST2-T01 — ใช้ซ้ำทุก master) พอร์ตจากต้นแบบ TMS v4:
 * - SummaryStrip: "แถบสรุปบรรทัดเดียว" ใต้หัวหน้า (spec/02 MD-010; ต้นแบบ data-dc-tpl 191)
 * - FormDrawer + FormSection + FormField: drawer ฟอร์มสร้างรายการใหม่ (ต้นแบบ cfOpen — tpl 4107)
 * - ChoiceGroup: ตัวเลือกแบบปุ่มกลม (ต้นแบบ radio() ในแท็บ "เงื่อนไข")
 * - ActivityTimeline: แท็บ "กิจกรรม" (ต้นแบบ P.isLog)
 * - ReasonDialog: กล่องยืนยันพร้อมเหตุผล (ต้นแบบ CN — ทุกการปิดใช้/ลบต้องมีเหตุผล)
 * - Toast: แจ้งผลมุมขวาล่าง (ต้นแบบ toast())
 */

/** ref ของ callback ล่าสุด — ให้ effect ไม่ผูกกับ callback ที่สร้างใหม่ทุก render (กัน state รีเซ็ตเอง) */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

/** ปิดด้วย Esc ขณะเปิดอยู่ */
function useEscape(open: boolean, onClose: () => void) {
  const cb = useLatest(onClose);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cb.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, cb]);
}

export interface SummaryItem {
  value: ReactNode;
  label: ReactNode;
  /** สีตัวเลข (ต้นแบบ: #101418 ปกติ, #2257C4 ข้อมูล, #8F5500 เตือน) */
  color?: string;
  onClick?: () => void;
  pressed?: boolean;
}

export function SummaryStrip({ items }: { items: SummaryItem[] }) {
  return (
    <div className="tms-strip">
      {items.map((x, i) => (
        <button
          key={i}
          type="button"
          className="tms-strip__item"
          onClick={x.onClick}
          aria-pressed={x.pressed}
          disabled={!x.onClick}
        >
          <span className="tms-strip__v" style={{ color: x.color ?? '#101418' }}>
            {x.value}
          </span>
          <span className="tms-strip__l">{x.label}</span>
        </button>
      ))}
    </div>
  );
}

export function FormDrawer({
  open,
  title,
  subtitle,
  onClose,
  footer,
  closeLabel,
  children,
  onSubmit,
  alert,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  footer: ReactNode;
  /** ข้อความสรุปสีแดงซ้ายของแถบปุ่ม เช่น "กรอกข้อมูลให้ครบ 2 ช่อง" (ต้นแบบ cfOpen msg) */
  alert?: ReactNode;
  closeLabel: string;
  children: ReactNode;
  onSubmit?: () => void;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="tms-fdrawer__scrim" onClick={onClose}>
      <form
        className="tms-fdrawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
        noValidate
      >
        <div className="tms-fdrawer__head">
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <h2 className="tms-fdrawer__title">{title}</h2>
            {subtitle && <span style={{ color: '#3B424C' }}>{subtitle}</span>}
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            title={closeLabel}
            aria-label={closeLabel}
            onClick={onClose}
            style={{ color: '#59606B' }}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-fdrawer__body">{children}</div>
        <div className="tms-fdrawer__foot">
          {alert && (
            <span className="tms-fdrawer__alert" role="alert">
              <Icon n="circle-alert" s={16} />
              {alert}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {footer}
        </div>
      </form>
    </div>
  );
}

export function FormSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="tms-fsec">
      <h3 className="tms-fsec__h">{title}</h3>
      <div className="tms-fgrid tms-fgrid--create">{children}</div>
    </section>
  );
}

/** ช่องในฟอร์ม — span 2 = เต็มแถว; children รับ id/aria ไปผูกกับ input */
export function FormField({
  label,
  required,
  span = 1,
  error,
  hint,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  span?: 1 | 2;
  error?: string | undefined;
  hint?: ReactNode;
  children: (p: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <div className="tms-ffield" style={{ gridColumn: `span ${span}` }}>
      <label htmlFor={id} className="tms-label">
        {label}
        {required && <span style={{ color: '#B3322A' }}> *</span>}
      </label>
      {children({ id, 'aria-invalid': !!error, ...(error ? { 'aria-describedby': errId } : {}) })}
      {error ? (
        <span id={errId} className="tms-field-error">
          {error}
        </span>
      ) : hint ? (
        <span className="tms-field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function ChoiceGroup<V extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: ReactNode;
  options: { value: V; label: ReactNode }[];
  value: V;
  onChange: (v: V) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="tms-choice" role="radiogroup" aria-labelledby={id}>
      <span id={id} className="tms-label">
        {label}
      </span>
      <div className="tms-choice__opts">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              className="tms-choice__opt"
              disabled={disabled}
              onClick={() => onChange(o.value)}
            >
              <span className="tms-choice__dot">
                <span />
              </span>
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface TimelineItem {
  key: string;
  title: ReactNode;
  sub: ReactNode;
  badge: { label: ReactNode; tone: Tone; icon: string };
  detail?: ReactNode;
}

export function ActivityTimeline({ items }: { items: TimelineItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((x, i) => {
        const t = toneColors[x.badge.tone];
        const isOpen = open === x.key;
        return (
          <div key={x.key} className="tms-tl">
            <div className="tms-tl__rail">
              <span className="tms-tl__dot" style={{ background: t.c }} />
              <span
                className="tms-tl__line"
                style={{ background: i < items.length - 1 ? '#D9DCD4' : 'transparent' }}
              />
            </div>
            <div className="tms-tl__body">
              <button
                type="button"
                className="tms-tl__head"
                aria-expanded={x.detail ? isOpen : undefined}
                onClick={() => x.detail && setOpen(isOpen ? null : x.key)}
              >
                <span style={{ fontWeight: 500, flex: 1 }}>{x.title}</span>
                <span className="tms-tl__badge" style={{ background: t.bg, color: t.c }}>
                  <Icon n={x.badge.icon} s={12} />
                  {x.badge.label}
                </span>
                {x.detail && (
                  <Icon
                    n={isOpen ? 'chevron-up' : 'chevron-down'}
                    s={16}
                    style={{ color: '#59606B' }}
                  />
                )}
              </button>
              <span className="tms-tl__sub">{x.sub}</span>
              {isOpen && <div className="tms-tl__detail">{x.detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ReasonDialog({
  open,
  title,
  description,
  label,
  placeholder,
  okLabel,
  cancelLabel,
  closeLabel,
  minLength = 10,
  error,
  busy,
  okIcon,
  onOk,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  label: ReactNode;
  placeholder?: string;
  okLabel: ReactNode;
  cancelLabel: ReactNode;
  closeLabel: string;
  minLength?: number;
  error?: string | null;
  busy?: boolean;
  okIcon?: string;
  onOk: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const id = useId();
  // ล้างเหตุผลเฉพาะตอนเปิดใหม่ (ไม่ผูกกับ onClose ที่ parent สร้างใหม่ทุก render)
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  useEscape(open, onClose);
  if (!open) return null;
  const ok = reason.trim().length >= minLength && !busy;
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 id={`${id}-t`} className="tms-dialog__title">
              {title}
            </h2>
            {description && <p className="tms-dialog__desc">{description}</p>}
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-dialog__body">
          <label className="tms-field" htmlFor={id}>
            <span className="tms-label">
              {label} <span style={{ color: '#B3322A' }}>*</span>
            </span>
            <textarea
              id={id}
              className="tms-textarea"
              rows={3}
              value={reason}
              placeholder={placeholder}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </label>
          {error && <span className="tms-field-error">{error}</span>}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={!ok}
            onClick={() => onOk(reason.trim())}
          >
            {okIcon && <Icon n={okIcon} s={16} />}
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toast({
  message,
  onClose,
  closeLabel,
}: {
  message: ReactNode | null;
  onClose: () => void;
  closeLabel: string;
}) {
  const cb = useLatest(onClose);
  useEffect(() => {
    if (!message) return;
    const h = setTimeout(() => cb.current(), 3600);
    return () => clearTimeout(h);
  }, [message, cb]);
  if (!message) return null;
  return (
    <div role="status" className="tms-toast">
      <span className="tms-toast__ic">
        <Icon n="check" s={14} />
      </span>
      <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{message}</span>
      <button type="button" className="tms-toast__x" aria-label={closeLabel} onClick={onClose}>
        <Icon n="x" s={16} />
      </button>
    </div>
  );
}
