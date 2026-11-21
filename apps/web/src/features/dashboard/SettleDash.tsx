import { Button, Icon } from '@tms/ui';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { can, isLocked } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { money } from '../rate-cards/rateFormat';
import { countOf } from '../settlements/settle';
import { useSettlementKpi } from '../settlements/useSettlements';
import { AP_TILES } from './apCards';

const card: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #CDD1C8',
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};
const h2: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };
/** ช่องจำนวนแบบการ์ดการเชื่อมต่อของต้นแบบ (`dash.krs`: border #D9DCD4 r8 padding 12px 14px · ตัวเลข 24/600 tabular · ป้าย 12.5/500) */
const tile: CSSProperties = {
  border: '1px solid #D9DCD4',
  borderRadius: 8,
  padding: '12px 14px',
  background: '#FFFFFF',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  font: 'inherit',
  minWidth: 0,
};
const tileN = (color: string): CSSProperties => ({
  fontSize: 24,
  fontWeight: 600,
  color,
  fontVariantNumeric: 'tabular-nums',
});
const tileL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const num = (n: number) => n.toLocaleString('th-TH');

/**
 * ST9-T03 Dashboard AP รถร่วม บนหน้าภาพรวม — การ์ด "Settlement รถร่วม" เต็มแถว ใต้การ์ดล่างของ ST9-T01/T02
 * (ต้นแบบ is.dash ไม่มีการ์ด AP — หน้าตาตามการ์ดการเชื่อมต่อ/ลูกหนี้ของต้นแบบ [DECISION + OPEN Claude Design spec/12 §3])
 * render เฉพาะผู้มี `settlements:read` และแพ็กเกจเปิดโมดูล `settle` (ไม่มี = ไม่ render ไม่เรียก API — RPT-011)
 * ยอดจ่ายแล้วเดือนนี้เฉพาะผู้มี `prices.buy:read` (API ตัดฟิลด์เอง) · D-54 ไม่มี "50 ทวิ ที่ยังไม่ออก"
 */
export function SettleDash() {
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  if (!me.data || !can(scopes, 'settlements:read') || isLocked('settle', me.data.features))
    return null;
  return <SettleDashCard canBuy={can(scopes, 'prices.buy:read')} />;
}

function SettleDashCard({ canBuy }: { canBuy: boolean }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const q = useSettlementKpi();
  const k = q.data;
  return (
    <section style={card} data-testid="dash-ap">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={h2}>{t('dash.ap.title')}</h2>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        {AP_TILES.map((x) => (
          <button
            key={x.key}
            type="button"
            style={tile}
            data-testid={`ap-${x.key}`}
            onClick={() => (q.isError ? void q.refetch() : nav(x.link))}
          >
            <span style={tileN(x.color)} data-testid={`ap-${x.key}-n`}>
              {k && !q.isError ? num(countOf(k, x.statuses)) : '—'}
            </span>
            <span style={tileL}>{q.isError ? t('dash.kpi.err') : t(x.label)}</span>
          </button>
        ))}
      </div>
      {canBuy && k?.buyPaidThisMonth !== undefined && !q.isError && (
        // แถวข้อมูลแบบ "ซิงก์ล่าสุด" ของการ์ดการเชื่อมต่อในต้นแบบ — ยอดเดียวกับ KPI "จ่ายแล้วเดือนนี้ (฿)" ของหน้า settle
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#3B424C' }}>
          <span>{t('dash.ap.paidMonth')}</span>
          <span className="tms-num" style={{ color: '#101418' }} data-testid="ap-paid-month">
            {money(k.buyPaidThisMonth)}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        <Button variant="secondary" onClick={() => nav('/settle')}>
          {t('dash.ap.go')}
          <Icon n="arrow-right" s={16} />
        </Button>
      </div>
    </section>
  );
}
