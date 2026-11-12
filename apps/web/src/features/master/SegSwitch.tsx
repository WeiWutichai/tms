/** ปุ่มสลับส่วนของหน้า (คนขับ | ผู้รับเหมา, ขาขาย | ขาซื้อ) — ต้นแบบ vx.seg (พื้น #EBEDE8 ขอบ #D9DCD4 มุม 14, ปุ่มเลือก = ขาว ตัวหนา น้ำเงิน) */
export function SegSwitch<K extends string>({
  value,
  items,
  onChange,
}: {
  value: K;
  items: {
    key: K;
    label: string;
    count?: number | undefined;
    disabled?: boolean;
    title?: string;
  }[];
  onChange: (k: K) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        alignSelf: 'flex-start',
        gap: 2,
        padding: 3,
        background: '#EBEDE8',
        border: '1px solid #D9DCD4',
        borderRadius: 14,
      }}
    >
      {items.map((s) => {
        const on = s.key === value;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={s.disabled}
            title={s.title}
            onClick={() => onChange(s.key)}
            style={{
              height: 34,
              padding: '0 14px',
              border: 0,
              borderRadius: 999,
              background: on ? '#FFFFFF' : 'transparent',
              color: on ? '#2257C4' : '#3B424C',
              fontWeight: on ? 600 : 500,
              boxShadow: on ? '0 1px 2px rgba(16,24,40,.08), 0 0 0 1px #D9DCD4' : 'none',
              cursor: s.disabled ? 'not-allowed' : 'pointer',
              opacity: s.disabled ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              font: 'inherit',
            }}
          >
            {s.label}
            {s.count !== undefined && (
              <span style={{ color: '#3B424C', fontWeight: 500 }}>{s.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
