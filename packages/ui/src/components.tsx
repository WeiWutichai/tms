import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';
import { statusOf } from './status-map';
import { tone as toneColors, type Tone } from './tokens';

/* ปุ่ม 4 แบบ — หัวข้อ "ปุ่ม · 4 แบบ ทุกสถานะ" (หลัก 1 ปุ่มต่อหน้า) */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    icon?: string;
    size?: 'md' | 'sm';
  }
>(function Button(
  { variant = 'secondary', icon, size = 'md', className = '', children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`tms-btn tms-btn--${variant}${size === 'sm' ? ' tms-btn--sm' : ''} ${className}`}
      {...rest}
    >
      {icon && <Icon n={icon} s={16} />}
      {children}
    </button>
  );
});

/* Input + label + ข้อความผิดพลาด — หัวข้อ "Input" */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: ReactNode;
  error?: string | undefined;
  hint?: ReactNode;
  children: (p: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <label className="tms-field" htmlFor={id}>
      <span className="tms-label">{label}</span>
      {children({ id, 'aria-invalid': !!error, ...(error ? { 'aria-describedby': errId } : {}) })}
      {error ? (
        <span id={errId} className="tms-field-error">
          {error}
        </span>
      ) : hint ? (
        <span className="tms-field-hint">{hint}</span>
      ) : null}
    </label>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`tms-input ${className}`} {...rest} />;
  },
);

/* Badge สถานะ — สีจาก badge() ของต้นแบบ, ไอคอน 12px, ข้อความไทยเสมอ */
export function Badge({ label, tone, icon }: { label: string; tone?: Tone; icon?: string }) {
  const m = statusOf(label);
  const t = toneColors[tone ?? m.tone];
  return (
    <span className="tms-badge" style={{ background: t.bg, color: t.c }}>
      <Icon n={icon ?? m.icon} s={12} />
      {label}
    </span>
  );
}

/* Route chip "A → B" */
export function RouteChip({ from, to }: { from: ReactNode; to: ReactNode }) {
  return (
    <span className="tms-route">
      {from}
      <Icon n="arrow-right" s={14} style={{ color: '#59606B' }} />
      {to}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tms-tag">{children}</span>;
}

export function FilterChip({
  label,
  onRemove,
  removeLabel,
}: {
  label: ReactNode;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="tms-filterchip">
      {label}
      <button type="button" onClick={onRemove} aria-label={removeLabel}>
        <Icon n="x" s={14} />
      </button>
    </span>
  );
}

/* ที่อยู่บรรทัดเดียว + tooltip ที่อยู่เต็ม (spec00 §6) */
export function AddressLine({ short, full }: { short: string; full: string }) {
  return (
    <span
      title={full}
      style={{
        display: 'block',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {short}
    </span>
  );
}

/* Tab สถานะ + ตัวนับ */
export interface TabItem {
  key: string;
  label: ReactNode;
  count?: number;
}
export function StatusTabs({
  items,
  value,
  onChange,
}: {
  items: TabItem[];
  value: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="tms-tabs" role="tablist">
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === value}
          className="tms-tab"
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count !== undefined && <span className="tms-tab__n">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* KPI card — แบบที่ใช้ในหน้าจริง (cur.kpis): ขาว + แถบซ้าย 3px ตามความหมาย */
export type KpiTone = 'neutral' | 'info' | 'warn' | 'err' | 'ok';
const KPI_TONE: Record<KpiTone, string> = {
  neutral: '#101418',
  info: '#2257C4',
  warn: '#8F5500',
  err: '#B3322A',
  ok: '#17733F',
};
export function KpiCard({
  label,
  value,
  sub,
  tone = 'neutral',
  active = false,
  activeLabel,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: KpiTone;
  active?: boolean;
  activeLabel?: ReactNode;
  onClick?: () => void;
}) {
  const color = KPI_TONE[tone];
  const stripe =
    tone === 'warn' || tone === 'err' || tone === 'ok' ? color : active ? '#2257C4' : 'transparent';
  const dot = tone === 'warn' || tone === 'err' || tone === 'ok' ? color : '';
  return (
    <button
      type="button"
      className={`tms-kpi${onClick ? ' tms-kpi--click' : ''}`}
      aria-pressed={active}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <span className="tms-kpi__bar" style={{ background: stripe }} />
      <span className="tms-kpi__label">
        {dot && <span className="tms-kpi__dot" style={{ background: dot }} />}
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        {active && (
          <span className="tms-kpi__on">
            <Icon n="filter" s={12} />
            {activeLabel}
          </span>
        )}
      </span>
      <span className="tms-kpi__value" style={{ color }}>
        {value}
      </span>
      {sub && <span className="tms-kpi__sub">{sub}</span>}
    </button>
  );
}

/* Empty state — แบบในการ์ด (dashed) และแบบเต็มหน้า */
export function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
  variant = 'inline',
}: {
  icon?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  variant?: 'inline' | 'page';
}) {
  return (
    <div className={`tms-empty${variant === 'page' ? ' tms-empty--page' : ''}`}>
      <Icon n={icon} s={40} style={{ color: '#C9CDC3' }} />
      <span className="tms-empty__t" style={variant === 'page' ? { marginTop: 4 } : undefined}>
        {title}
      </span>
      {description && <span className="tms-empty__d">{description}</span>}
      {action && <div style={{ marginTop: variant === 'page' ? 8 : 6 }}>{action}</div>}
    </div>
  );
}

/* การ์ด section */
export function Card({
  title,
  actions,
  children,
  padded = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <section
      className="tms-card"
      style={
        padded
          ? { padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }
          : { overflow: 'hidden' }
      }
    >
      {(title || actions) && (
        <div
          style={
            padded
              ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
              : {
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }
          }
        >
          {title && <h2 className="tms-card__h">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/* Drawer มาตรฐาน 600px: หัว 3 บรรทัด, เมนู ⋯, แท็บ, body, footer ติดล่าง */
export function Drawer({
  open,
  onClose,
  kind,
  title,
  badge,
  subtitle,
  menu,
  tabs,
  tab,
  onTab,
  footer,
  labels,
  children,
}: {
  open: boolean;
  onClose: () => void;
  kind: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  subtitle?: ReactNode;
  menu?: { label: ReactNode; icon: string; onClick: () => void; danger?: boolean }[];
  tabs?: TabItem[];
  tab?: string;
  onTab?: (k: string) => void;
  footer?: ReactNode;
  labels: { close: string; more: string };
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="tms-scrim" onClick={onClose} />
      <aside className="tms-drawer" role="dialog" aria-modal="true">
        <div className="tms-drawer__head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 2 }}>
              <span className="tms-drawer__kind">{kind}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="tms-drawer__no">{title}</span>
                {badge}
              </div>
              {subtitle && (
                <span
                  style={{
                    color: '#3B424C',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {subtitle}
                </span>
              )}
            </div>
            <DrawerActions menu={menu} onClose={onClose} labels={labels} />
          </div>
          {tabs && (
            <div className="tms-drawer__tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  className="tms-drawer__tab"
                  aria-selected={t.key === tab}
                  onClick={() => onTab?.(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="tms-drawer__body">{children}</div>
        {footer && <div className="tms-drawer__foot">{footer}</div>}
      </aside>
    </>
  );
}

function DrawerActions({
  menu,
  onClose,
  labels,
}: {
  menu?: { label: ReactNode; icon: string; onClick: () => void; danger?: boolean }[];
  onClose: () => void;
  labels: { close: string; more: string };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'flex', gap: 2, flexShrink: 0 }}>
      {menu && menu.length > 0 && (
        <button
          type="button"
          className="tms-drawer__iconbtn"
          title={labels.more}
          aria-label={labels.more}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon n="ellipsis" s={18} />
        </button>
      )}
      <button
        type="button"
        className="tms-drawer__iconbtn"
        title={labels.close}
        aria-label={labels.close}
        onClick={onClose}
      >
        <Icon n="x" s={18} />
      </button>
      {open && menu && (
        <div className="tms-menu" style={{ top: 36, right: 34 }} role="menu">
          {menu.map((m, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              style={{ color: m.danger ? '#B3322A' : '#101418' }}
              onClick={() => {
                setOpen(false);
                m.onClick();
              }}
            >
              <Icon n={m.icon} s={16} />
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ส่วน "ข้อมูล" แบบ key-value 2 คอลัมน์ใน drawer */
export function KeyValues({
  title,
  items,
}: {
  title: ReactNode;
  items: { k: ReactNode; v: ReactNode }[];
}) {
  return (
    <section className="tms-kv">
      <span className="tms-kv__title">{title}</span>
      <div className="tms-kv__grid">
        {items.map((x, i) => (
          <div key={i} className="tms-kv__item">
            <span className="tms-kv__k">{x.k}</span>
            <span className="tms-kv__v">{x.v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DrawerFooterButtons({
  secondary,
  primary,
}: {
  secondary?: { label: ReactNode; onClick: () => void }[];
  primary?: {
    label: ReactNode;
    icon?: string;
    onClick?: () => void;
    type?: 'button' | 'submit';
    form?: string;
    disabled?: boolean;
  };
}) {
  return (
    <div className="tms-drawer__acts">
      {secondary?.map((b, i) => (
        <button key={i} type="button" className="tms-drawer__sec" onClick={b.onClick}>
          {b.label}
        </button>
      ))}
      {primary && (
        <button
          type={primary.type ?? 'button'}
          form={primary.form}
          className="tms-drawer__pri"
          onClick={primary.onClick}
          disabled={primary.disabled}
        >
          {primary.icon && <Icon n={primary.icon} s={16} />}
          {primary.label}
        </button>
      )}
    </div>
  );
}
