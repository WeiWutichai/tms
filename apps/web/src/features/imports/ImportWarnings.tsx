import { Icon } from '@tms/ui';
import { useI18n } from '../../i18n';

interface Issue {
  row: number;
  column?: string | null;
  code: string;
  message: string;
  severity: string;
}

export interface WarningGroup {
  code: string;
  message: string;
  rows: number[];
}

/** คำเตือน (ไม่ขวางการนำเข้า) รวมตามข้อความ — แถวเรียงตามไฟล์ · สูงสุด 20 กลุ่ม (ที่เหลือในไฟล์แถวที่ผิด/ผลตรวจ) */
export function groupWarnings(issues: readonly Issue[], max = 20): WarningGroup[] {
  const m = new Map<string, WarningGroup>();
  for (const x of issues) {
    if (x.severity !== 'warning') continue;
    const message = x.column ? `${x.column}: ${x.message}` : x.message;
    const k = `${x.code}\u0000${message}`;
    const g = m.get(k) ?? { code: x.code, message, rows: [] };
    if (!g.rows.includes(x.row)) g.rows.push(x.row);
    m.set(k, g);
  }
  return [...m.values()].slice(0, max);
}

const ROWS_SHOWN = 8;

/**
 * กล่องคำเตือนของ wizard นำเข้า (ขั้นจับคู่คอลัมน์ + ผลลัพธ์) — สีเตือนของต้นแบบ TMS v4 (#FCF0DC / #8F5500)
 * แยกจากแถวผิด (พื้นแดง) · เช่น ใบสั่งจะเข้าเป็นใบค้าง, อัปเดตใบเดิม, ไม่มีเลขอ้างอิง, ยังไม่มีพิกัด
 */
export function ImportWarnings({ issues }: { issues: readonly Issue[] }) {
  const { t } = useI18n();
  const groups = groupWarnings(issues);
  if (!groups.length) return null;
  const rows = new Set(issues.filter((x) => x.severity === 'warning').map((x) => x.row)).size;
  return (
    <section
      aria-label={t('imp.warnTitle', { n: rows })}
      style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: '#FCF0DC',
          color: '#8F5500',
          fontWeight: 500,
          fontSize: 13,
        }}
      >
        <Icon n="triangle-alert" s={16} />
        {t('imp.warnTitle', { n: rows })}
      </div>
      {groups.map((g) => (
        <div
          key={`${g.code}:${g.message}`}
          data-warning={g.code}
          style={{
            display: 'flex',
            gap: 12,
            padding: '8px 12px',
            borderTop: '1px solid #E4E6E0',
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 600, whiteSpace: 'nowrap', color: '#8F5500' }}>
            {g.rows.length > ROWS_SHOWN
              ? t('imp.warnRowsMore', {
                  rows: g.rows.slice(0, ROWS_SHOWN).join(', '),
                  n: g.rows.length - ROWS_SHOWN,
                })
              : t('imp.warnRows', { rows: g.rows.join(', ') })}
          </span>
          <span>{g.message}</span>
        </div>
      ))}
    </section>
  );
}
