import { Badge, Icon, statusOf } from '@tms/ui';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { money, rateStatusLabel, rateUnit } from './rateFormat';
import { useCustomerRates } from './useRateCards';

/**
 * แท็บ "Rate card" ใน drawer ลูกค้า — ต้นแบบ P.isRateT / cux.rates:
 * หัว "Rate ขาขายของลูกค้านี้" · แถว (route chip, ประเภทรถ, ราคา/หน่วย, ป้าย) · ว่าง = ข้อความ · ปุ่มเปิดหน้า Rate card กรองลูกค้านี้
 */
export function CustomerRatesTab({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  const q = useCustomerRates(customerId);
  const rows = q.data?.data ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('rc.cust.title')}</h3>
      {rows.length > 0 && (
        <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
          {rows.map((x) => {
            const label = rateStatusLabel(t, x.status);
            const b = statusOf(label);
            return (
              <div
                key={x.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  borderBottom: '1px solid #E4E6E0',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 28,
                    padding: '0 10px',
                    borderRadius: 999,
                    background: '#EBEDE8',
                  }}
                >
                  {x.origin.name}
                  <Icon n="arrow-right" s={14} style={{ color: '#59606B' }} />
                  {x.destination.name}
                </span>
                <span style={{ color: '#3B424C' }}>{x.vehicleType.name}</span>
                <span
                  style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}
                >
                  {x.sellRate !== undefined
                    ? `${money(x.sellRate)} / ${rateUnit(t, x.pricingModel, x.unit?.name)}`
                    : '—'}
                </span>
                <Badge label={label} tone={b.tone} icon={b.icon} />
              </div>
            );
          })}
        </div>
      )}
      {q.isSuccess && rows.length === 0 && (
        <span style={{ color: '#3B424C' }}>{t('rc.cust.empty')}</span>
      )}
      <button
        type="button"
        onClick={() =>
          nav(
            `/master/rate-cards?customer=${encodeURIComponent(customerId)}&party=${encodeURIComponent(customerName)}`,
          )
        }
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 32,
          padding: '0 12px',
          border: '1px solid #9DB6E3',
          borderRadius: 999,
          background: '#FFFFFF',
          color: '#2257C4',
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          alignSelf: 'flex-start',
          font: 'inherit',
        }}
      >
        <Icon n="tags" s={16} />
        {t('rc.cust.go')}
      </button>
    </div>
  );
}
