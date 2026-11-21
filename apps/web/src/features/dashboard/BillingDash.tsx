import { Button, Icon } from '@tms/ui';
import type { CSSProperties, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { useInvoiceCounts, useQueueCustomers } from '../billing/useInvoices';
import { usePaymentSummary } from '../billing/usePayments';
import { money } from '../rate-cards/rateFormat';
import { AR_LINKS, BILL_TILES, type BillTileKey } from './billCards';

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
/** ช่องตัวเลขของการ์ดลูกหนี้ในต้นแบบ (`dash.ar`: border #D9DCD4 r8 padding 12px 14px · ตัวเลข 16/600 tabular · ป้าย 12.5/500) */
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
  fontVariantNumeric: 'tabular-nums',
  fontSize: 16,
  fontWeight: 600,
  color,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});
const tileL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const num = (n: number) => n.toLocaleString('th-TH');

function Tile(p: {
  id: string;
  value: ReactNode;
  label: ReactNode;
  color: string;
  onClick: () => void;
}) {
  return (
    <button type="button" style={tile} data-testid={p.id} onClick={p.onClick}>
      <span style={tileN(p.color)} data-testid={`${p.id}-v`}>
        {p.value}
      </span>
      <span style={tileL}>{p.label}</span>
    </button>
  );
}

/**
 * ST9-T02 Dashboard บิล บนหน้าภาพรวม — แถวการ์ดล่าง (ต้นแบบ is.dash grid 2fr / 1fr):
 * ซ้าย = "สถานะบิล" 5 ช่อง (ร่าง · ค้างวางบิล · ออกแล้วรอชำระ · เกินกำหนด · ชำระบางส่วน) + เดือนนี้ vs เดือนก่อน
 * ขวา = การ์ด "ลูกหนี้ค้างชำระ" ของต้นแบบ (ค้างรับ · เกินกำหนด → หน้ารับชำระ)
 * render เฉพาะผู้มี `invoices:read` (ผู้เรียกตรวจ) · ยอดเงินเฉพาะผู้มี `prices.sell:read` — ไม่มี = แสดงจำนวนใบ (API ตัดฟิลด์เงินเอง)
 * ยอดเงินเป็นข้อความจาก API (Decimal) — แสดงด้วย `money()` ไม่แปลงเป็น float · D-54 ไม่มีการ์ด "WHT รอ 50 ทวิ"
 */
export function BillingDash({ canSell }: { canSell: boolean }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const inv = useInvoiceCounts();
  const pay = usePaymentSummary();
  const queue = useQueueCustomers();
  const s = inv.data;
  const p = pay.data;
  const q = queue.data?.totals;
  const baht = (v: string | undefined) => (v === undefined ? '—' : money(v));

  // ช่อง: ยอดเงิน (มีสิทธิ์ — ป้าย "ชื่อ · n ใบ") หรือจำนวน (ไม่มีสิทธิ์ — API ไม่ส่งฟิลด์เงิน)
  const show = (amt: string | undefined, count: string) =>
    canSell ? { v: baht(amt), n: count } : { v: count, n: null };
  const tileOf = (k: BillTileKey): { v: ReactNode; n: string | null } | null => {
    if (k === 'ready')
      return q ? show(q.sellTotal, t('dash.bill.nDo', { n: num(q.deliveryOrderCount) })) : null;
    if (!s) return null;
    const inv1 = (n: number) => t('dash.bill.nInv', { n: num(n) });
    switch (k) {
      case 'draft':
        return show(s.sellDraftTotal, inv1(s.draft));
      case 'issued':
        return show(s.sellIssuedOutstanding, inv1(s.issued));
      case 'overdue':
        return show(s.sellOverdueOutstanding, inv1(s.overdue));
      case 'partial':
        return show(s.sellPartiallyPaidOutstanding, inv1(s.partiallyPaid));
    }
  };
  const failed = (k: BillTileKey) => (k === 'ready' ? queue.isError : inv.isError);
  const retry = (k: BillTileKey) => void (k === 'ready' ? queue.refetch() : inv.refetch());

  const month = (
    label: string,
    id: string,
    cur: { count: number; amt: string | undefined } | undefined,
    prev: { count: number; amt: string | undefined } | undefined,
  ) => {
    const cell = (x: typeof cur, which: string) => (
      <span
        className="tms-num"
        style={{ textAlign: 'right', whiteSpace: 'nowrap' }}
        data-testid={`${id}-${which}`}
      >
        {x === undefined ? '—' : canSell ? baht(x.amt) : t('dash.bill.nInv', { n: num(x.count) })}
      </span>
    );
    return (
      <div className="tms-dash-month__row">
        <span>{label}</span>
        {cell(cur, 'this')}
        {cell(prev, 'last')}
      </div>
    );
  };

  return (
    <div className="tms-dash-bottom" data-testid="dash-bill">
      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={h2}>{t('dash.bill.title')}</h2>
        </div>
        <div className="tms-dash-bill">
          {BILL_TILES.map((x) => {
            const id = `bill-${x.key}`;
            if (failed(x.key))
              return (
                <Tile
                  key={x.key}
                  id={id}
                  value="—"
                  label={t('dash.kpi.err')}
                  color={x.color}
                  onClick={() => retry(x.key)}
                />
              );
            const v = tileOf(x.key);
            return (
              <Tile
                key={x.key}
                id={id}
                value={v ? v.v : '—'}
                label={
                  <>
                    {t(x.label)}
                    {v?.n && (
                      <>
                        {' · '}
                        <span data-testid={`${id}-n`}>{v.n}</span>
                      </>
                    )}
                  </>
                }
                color={x.color}
                onClick={() => nav(x.link)}
              />
            );
          })}
        </div>
        <div className="tms-dash-month" data-testid="dash-month">
          <div className="tms-dash-month__row tms-dash-month__head">
            <span>{t('dash.month.title')}</span>
            <span style={{ textAlign: 'right' }}>{t('dash.month.this')}</span>
            <span style={{ textAlign: 'right' }}>{t('dash.month.last')}</span>
          </div>
          {inv.isError || pay.isError ? (
            <div className="tms-dash-month__row">
              <Button
                variant="secondary"
                icon="refresh-cw"
                onClick={() => void (inv.isError ? inv.refetch() : pay.refetch())}
              >
                {t('dash.kpi.err')}
              </Button>
            </div>
          ) : (
            <>
              {month(
                t('dash.month.issued'),
                'month-issued',
                s && { count: s.issuedThisMonth.count, amt: s.issuedThisMonth.sellTotal },
                s && { count: s.issuedLastMonth.count, amt: s.issuedLastMonth.sellTotal },
              )}
              {month(
                t('dash.month.received'),
                'month-received',
                p && { count: p.receivedThisMonth, amt: p.sellReceivedThisMonth },
                p && { count: p.receivedLastMonth, amt: p.sellReceivedLastMonth },
              )}
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
          <Button variant="secondary" onClick={() => nav('/bill')}>
            {t('dash.bill.go')}
          </Button>
        </div>
      </section>
      <section style={card} data-testid="dash-ar">
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <h2 style={h2}>{t('dash.ar.title')}</h2>
        </div>
        {pay.isError ? (
          <Button variant="secondary" icon="refresh-cw" onClick={() => void pay.refetch()}>
            {t('dash.kpi.err')}
          </Button>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Tile
              id="ar-open"
              value={p ? (canSell ? baht(p.sellOutstanding) : num(p.open)) : '—'}
              label={t('dash.ar.open', { n: p ? t('dash.bill.nInv', { n: num(p.open) }) : '—' })}
              color="#101418"
              onClick={() => nav(AR_LINKS.open)}
            />
            <Tile
              id="ar-over"
              value={p ? (canSell ? baht(p.sellOverdueOutstanding) : num(p.overdue)) : '—'}
              label={t('dash.ar.over', {
                n: p ? t('dash.bill.nInv', { n: num(p.overdue) }) : '—',
              })}
              color="#B3322A"
              onClick={() => nav(AR_LINKS.over)}
            />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
          {/* ต้นแบบ: ปุ่มขอบฟ้า "ไปหน้ารับชำระ" + ลูกศรท้าย */}
          <Button variant="secondary" onClick={() => nav(AR_LINKS.pay)}>
            {t('dash.ar.go')}
            <Icon n="arrow-right" s={16} />
          </Button>
        </div>
      </section>
    </div>
  );
}
