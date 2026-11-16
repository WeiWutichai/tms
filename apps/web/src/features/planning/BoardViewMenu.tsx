import { Icon } from '@tms/ui';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { CARD_FIELDS, type BoardView, type CardField } from './board';

const VIEWS: BoardView[] = ['FLEET', 'VEHICLE', 'DRIVER', 'CARRIER'];

/**
 * ตัวสลับมุมมองกระดาน + field บนการ์ด (ST3-T13) — [DECISION — ย้อนได้ PO 16 พ.ย. 2569] ใช้ปุ่ม "มุมมอง: …"
 * ของหน้ารายการในต้นแบบ (TMS v4 `toggleView` :1113 — ปุ่ม pill 32px + เมนู 220px) และส่วน checkbox แบบแผง
 * "คอลัมน์ที่แสดง" (:1214 หัวส่วน 12.5px #59606B + เส้นคั่น) ในเมนูเดียวกัน · ค่าบันทึกฝั่ง server ต่อผู้ใช้
 */
export function BoardViewMenu(props: {
  view: BoardView;
  fields: readonly string[];
  /** ระหว่างโหลดค่าของผู้ใช้ — กดไม่ได้ (QA ST3-T13) */
  disabled?: boolean;
  onChange: (v: { view: BoardView; cardFields: CardField[] }) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Esc ปิดเมนูแล้วคืนโฟกัสให้ปุ่ม
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const vl = (v: BoardView) => t(`plan.view.${v}` as MessageKey);
  const toggle = (f: CardField) => {
    const on = props.fields.includes(f);
    const next = CARD_FIELDS.filter((x) => (x === f ? !on : props.fields.includes(x)));
    if (next.length) props.onChange({ view: props.view, cardFields: next });
  };
  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        position: 'relative',
        minHeight: 32,
      }}
    >
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((o) => !o)}
        className="tms-plan-viewbtn"
        style={{
          height: 32,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 10px',
          border: '1px solid #D9DCD4',
          borderRadius: 999,
          background: '#FFFFFF',
          color: '#101418',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.6 : 1,
          font: 'inherit',
          fontWeight: 500,
        }}
      >
        <Icon n="bookmark" s={16} style={{ color: '#59606B' }} />
        {t('plan.view.btn', { v: vl(props.view) })}
        <Icon n="chevron-down" s={16} style={{ color: '#59606B' }} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 38,
            left: 0,
            zIndex: 20,
            width: 220,
            background: '#FFFFFF',
            border: '1px solid #D9DCD4',
            borderRadius: 14,
            boxShadow: '0 12px 32px rgba(16,24,40,.12)',
            padding: 4,
            boxSizing: 'border-box',
          }}
        >
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="menuitemradio"
              aria-checked={props.view === v}
              className="tms-plan-viewitem"
              onClick={() => {
                setOpen(false);
                if (v !== props.view)
                  props.onChange({ view: v, cardFields: [...cf(props.fields)] });
              }}
              style={{
                width: '100%',
                height: 36,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 10px',
                border: 0,
                borderRadius: 999,
                background: 'transparent',
                color: '#101418',
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
              }}
            >
              <span style={{ flex: 1 }}>{vl(v)}</span>
              {props.view === v && <Icon n="check" s={16} style={{ color: '#2257C4' }} />}
            </button>
          ))}
          <div
            style={{
              margin: '10px 10px 0',
              paddingTop: 10,
              borderTop: '1px solid #E4E6E0',
              fontSize: 12.5,
              fontWeight: 500,
              color: '#59606B',
            }}
          >
            {t('plan.view.fields')}
          </div>
          {CARD_FIELDS.map((f) => (
            <label
              key={f}
              style={{
                minHeight: 36,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 10px',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={props.fields.includes(f)}
                // อย่างน้อย 1 field (API ตรวจเช่นกัน)
                disabled={props.fields.length === 1 && props.fields.includes(f)}
                onChange={() => toggle(f)}
                style={{ width: 16, height: 16, accentColor: '#2257C4', margin: 0 }}
              />
              {t(`plan.field.${f}` as MessageKey)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const cf = (fields: readonly string[]) => CARD_FIELDS.filter((f) => fields.includes(f));
