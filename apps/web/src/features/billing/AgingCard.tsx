import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { money } from '../rate-cards/rateFormat';
import type { AgingBucketRow, AgingReport } from './usePayments';

export type AgingBucket = AgingBucketRow['bucket'];

/** สีต่อช่วง (ต้นแบบ TMS v4 vPay: ยังไม่ครบ เขียว · 1–60 ส้ม · เกิน 60 แดง) */
const COLOR: Record<AgingBucket, string> = {
  NOT_DUE: '#17733F',
  DAYS_1_30: '#8F5500',
  DAYS_31_60: '#8F5500',
  DAYS_61_90: '#B3322A',
  DAYS_OVER_90: '#B3322A',
};
export const AGING_ORDER: AgingBucket[] = [
  'NOT_DUE',
  'DAYS_1_30',
  'DAYS_31_60',
  'DAYS_61_90',
  'DAYS_OVER_90',
];

export function agingLabel(t: ReturnType<typeof useI18n>['t'], b: AgingBucket): string {
  return t(`pay.aging.${b}` as MessageKey);
}

/** ส่วนกว้างของแถบ (%) — ทศนิยม 2 ตำแหน่งแบบต้นแบบ */
export function agingPct(amount: string | undefined, total: string | undefined): string {
  const a = Number(amount ?? '0');
  const s = Number(total ?? '0');
  return `${(s ? (a / s) * 100 : 0).toFixed(2)}%`;
}

/**
 * การ์ด "อายุลูกหนี้" หน้ารับชำระ (ST5-T22; ต้นแบบ TMS v4 `is.pay` + `vPay()` — ใช้ CSS/ข้อความจากต้นแบบ)
 * ยอดจาก `GET /payments/aging` (ช่วงอายุนับจากวันครบกำหนด เวลาไทย) · กดช่วง = กรองตาราง (กดซ้ำ = เลิกกรอง)
 * ไม่มีสิทธิ์ดูราคาขาย = ยอดเป็น "—" (จำนวนใบยังแสดง)
 */
export function AgingCard({
  data,
  dateText,
  active,
  onPick,
}: {
  data: AgingReport | undefined;
  dateText: (iso: string) => string;
  active: AgingBucket | '';
  onPick: (b: AgingBucket) => void;
}) {
  const { t } = useI18n();
  const rows = AGING_ORDER.map(
    (b) => data?.buckets.find((x) => x.bucket === b) ?? { bucket: b, count: 0 },
  );
  return (
    <section
      data-testid="aging-card"
      style={{
        background: '#FFFFFF',
        border: '1px solid #CDD1C8',
        borderRadius: 12,
        boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('pay.aging.title')}</h2>
          <span style={{ color: '#3B424C' }}>
            {t('pay.aging.sub', {
              n: data ? data.count : '—',
              date: data ? dateText(data.asOf) : '—',
            })}
          </span>
        </div>
        <span
          className="tms-num"
          style={{ fontVariantNumeric: 'tabular-nums', fontSize: 16, fontWeight: 600 }}
        >
          {t('pay.aging.total', {
            n: data?.sellOutstanding !== undefined ? money(data.sellOutstanding) : '—',
          })}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          height: 10,
          borderRadius: 5,
          overflow: 'hidden',
          background: '#EBEDE8',
        }}
      >
        {rows.map((b) => (
          <span
            key={b.bucket}
            style={{
              width: agingPct(b.sellOutstanding, data?.sellOutstanding),
              background: COLOR[b.bucket],
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5,minmax(0,1fr))',
          gap: 10,
        }}
      >
        {rows.map((b) => {
          const on = active === b.bucket;
          return (
            <button
              key={b.bucket}
              type="button"
              className="tms-aging-bucket"
              aria-pressed={on}
              onClick={() => onPick(b.bucket)}
              style={{
                textAlign: 'left',
                border: `1px solid ${on ? '#2257C4' : '#D9DCD4'}`,
                background: on ? '#EEF0EC' : '#FFFFFF',
                borderRadius: 14,
                padding: '10px 12px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
                font: 'inherit',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: '#3B424C',
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: COLOR[b.bucket],
                    flexShrink: 0,
                  }}
                />
                {agingLabel(t, b.bucket)}
              </span>
              <span
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 15,
                  fontWeight: 600,
                  color: '#101418',
                }}
              >
                {b.sellOutstanding !== undefined ? money(b.sellOutstanding) : '—'}
              </span>
              <span style={{ fontSize: 13, color: '#3B424C' }}>
                {t('pay.aging.count', { n: b.count })}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
