import { Icon } from '@tms/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type CSSProperties } from 'react';
import { useDebounced } from './useCursorList';

export interface RefOption {
  id: string;
  label: string;
  /** บรรทัดรอง (เช่น รหัส) */
  sub?: string;
}

/**
 * ช่องเลือกข้อมูลหลักที่อ้างถึง (ลูกค้า, รถร่วม, รถ, rate card …) แบบค้นหาได้ — ใช้ร่วมทุก master (ST2-T02)
 * หน้าตาตอนปิด = select ของต้นแบบ (สูง 40, ขอบ #CDD1C8, ลูกศรลง); โฟกัส = พิมพ์ค้น → API `q` (หน่วง 250 ms)
 * แสดงสูงสุดตามที่ `search` คืน (แนะนำ 20) — ไม่โหลดทั้งตาราง
 */
export function RefPicker({
  id,
  value,
  onChange,
  search,
  queryKey,
  placeholder,
  noResult,
  clearLabel,
  invalid,
  disabled,
  style,
}: {
  id?: string;
  value: RefOption | null;
  onChange: (v: RefOption | null) => void;
  search: (q: string) => Promise<RefOption[]>;
  queryKey: string;
  placeholder: string;
  noResult: string;
  /** ตัวเลือกแรก "ล้างค่า" (เช่น "— เลือก —") — ไม่ส่ง = ล้างไม่ได้ */
  clearLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const auto = useId();
  const listId = `${id ?? auto}-list`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const q = useDebounced(text.trim(), 250);
  const res = useQuery({
    queryKey: ['ref-picker', queryKey, q],
    enabled: open,
    placeholderData: keepPreviousData,
    queryFn: () => search(q),
  });
  const blurT = useRef<ReturnType<typeof setTimeout>>(undefined);
  const opts: (RefOption | null)[] = [
    ...(clearLabel !== undefined ? [null] : []),
    ...(res.data ?? []),
  ];
  const pick = (o: RefOption | null) => {
    onChange(o);
    setOpen(false);
    setText('');
  };

  return (
    <div style={{ position: 'relative', ...style }}>
      <input
        id={id}
        className="tms-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid}
        disabled={disabled}
        autoComplete="off"
        placeholder={value ? value.label : (clearLabel ?? placeholder)}
        value={open ? text : (value?.label ?? '')}
        onFocus={() => {
          setOpen(true);
          setText('');
          setHi(0);
        }}
        onBlur={() => {
          blurT.current = setTimeout(() => setOpen(false), 150);
        }}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setOpen(true);
          setText(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, opts.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (opts[hi] !== undefined) pick(opts[hi]!);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        style={{
          height: 40,
          padding: '0 36px 0 12px',
          borderColor: invalid ? '#B3322A' : '#CDD1C8',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
      <span
        style={{
          position: 'absolute',
          right: 12,
          top: 12,
          color: '#59606B',
          pointerEvents: 'none',
        }}
      >
        <Icon n={open ? 'search' : 'chevron-down'} s={16} />
      </span>
      {open && (
        <ul
          id={listId}
          role="listbox"
          onMouseDown={(e) => {
            e.preventDefault();
            clearTimeout(blurT.current);
          }}
          style={{
            position: 'absolute',
            zIndex: 30,
            left: 0,
            right: 0,
            top: 44,
            margin: 0,
            padding: 4,
            listStyle: 'none',
            background: '#FFFFFF',
            border: '1px solid #CDD1C8',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(16,20,24,.12)',
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {opts.map((o, i) => (
            <li
              key={o?.id ?? '__clear'}
              role="option"
              aria-selected={o ? value?.id === o.id : !value}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(o)}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                background: i === hi ? '#E9F0FA' : 'transparent',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <span style={{ color: o ? '#101418' : '#59606B' }}>{o ? o.label : clearLabel}</span>
              {o?.sub && <span style={{ fontSize: 12.5, color: '#59606B' }}>{o.sub}</span>}
            </li>
          ))}
          {!res.isFetching && res.data && res.data.length === 0 && (
            <li style={{ padding: '8px 10px', color: '#59606B' }}>{noResult}</li>
          )}
        </ul>
      )}
    </div>
  );
}
