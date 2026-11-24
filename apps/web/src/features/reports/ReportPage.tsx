import { Button, Icon, Toast } from '@tms/ui';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatMonth, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { NotReady } from '../../pages/Simple';
import { useMe } from '../../shell/AppShell';
import { PageHeader } from '../../shell/Header';
import { AGING_ORDER, agingLabel } from '../billing/AgingCard';
import { exportList, type ExportResource } from '../exports/exportJob';
import { exportFailText } from '../master/download';
import { money, useDateText } from '../rate-cards/rateFormat';
import {
  bangkokMonth,
  shiftMonth,
  useAgingByCustomer,
  useRevenueReport,
  useUnbilledDays,
  UNBILLED_QUERY,
  useUnbilledReport,
  type RevenueGroupBy,
} from './useReports';

/**
 * แท็บที่ทำในเฟส 0 (D-54) — แท็บอื่นของต้นแบบ (กำไร/OTIF/fleet …) มากับงานของมัน [DECISION spec/12 §3 แถว ST9-T06]
 * รายได้ 6 แท็บ (ST9-T05) อยู่ตำแหน่งแท็บกำไรของต้นแบบ (หน้าแรกของรายงาน) [DECISION spec/12 §3 แถว ST9-T05]
 */
const REV_TABS = ['rcust', 'rroute', 'rveh', 'rvtype', 'rent', 'rmonth'] as const;
type RevTab = (typeof REV_TABS)[number];
export type ReportTab = RevTab | 'ar' | 'unbilled';
const GROUP: Record<RevTab, RevenueGroupBy> = {
  rcust: 'customer',
  rroute: 'route',
  rveh: 'vehicle',
  rvtype: 'vehicleType',
  rent: 'legalEntity',
  rmonth: 'month',
};
const isRev = (k: ReportTab | undefined): k is RevTab => !!k && k in GROUP;
const RESOURCE: Record<'ar' | 'unbilled', ExportResource> = {
  ar: 'receivables-aging',
  unbilled: 'unbilled-delivery-orders',
};
/** งวดที่เลือกได้ — 24 เดือนล่าสุด (เพดานช่วงของ API) · รายเดือน = 12 เดือนถึงเดือนที่เลือก */
const MONTHS_BACK = 24;
const MONTH_TAB_SPAN = 12;

/** เซลล์ตาราง (ต้นแบบ vRep `cell()` — mono = 13px) */
export interface Cell {
  v: string;
  r?: boolean;
  mono?: boolean;
  c?: string;
  fw?: number;
}
export const td = (c: Cell): CSSProperties => ({
  height: 52,
  padding: '0 12px',
  borderBottom: '1px solid #E4E6E0',
  textAlign: c.r ? 'right' : 'left',
  fontSize: c.mono ? 13 : 14,
  color: c.c ?? '#101418',
  fontWeight: c.fw ?? 400,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
});
export const TH: CSSProperties = {
  background: '#F4F5F2',
  height: 40,
  padding: '0 12px',
  borderBottom: '1px solid #E4E6E0',
  fontSize: 12.5,
  fontWeight: 500,
  color: '#3B424C',
  whiteSpace: 'nowrap',
};

/**
 * หน้า "รายงาน" (ST9-T06; ต้นแบบ TMS v4 `is.report` + `vRep()` — การ์ด + แท็บขีดเส้นใต้ + ตาราง + ว่าง)
 * - รายได้ 6 แท็บ (ST9-T05): ต่อลูกค้า / เส้นทาง / รถ / ประเภทรถ / นิติบุคคล / รายเดือน จาก `GET /v1/reports/revenue`
 *   (บรรทัดใบแจ้งหนี้ที่ออกแล้ว ก่อน VAT) + แถวรวม · "งวด" ขวาของแถบแท็บเลือกเดือนได้ (`?month=`)
 * - ลูกหนี้คงค้าง (`ar`): ลูกค้า × ช่วงอายุ + รวม จาก `GET /payments/aging` (ST5-T22 ตัวเดียวกับหน้ารับชำระ) เรียงยอดมากไปน้อย
 * - DO ยังไม่วางบิลเกิน N วัน: แท็บเพิ่ม (ต้นแบบไม่มี — docs/04 H) ใช้หน้าตาตารางเดียวกัน · รวม DO ในร่างใบแจ้งหนี้ค้างเกิน N วัน
 *   (D-71 — คอลัมน์ "ร่างใบแจ้งหนี้")
 * - "ส่งออก Excel" = งานส่งออก (`POST /v1/exports`) ของแท็บที่เปิด · "ตั้งเวลาส่งรายงาน" = P1 (ปิดไว้)
 */
export function ReportPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const dateText = useDateText();
  const [params, setParams] = useSearchParams();
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tabs: ReportTab[] = [
    ...(can(scopes, 'reports.finance:read') ? REV_TABS : []),
    ...(can(scopes, 'invoices:read') ? (['ar'] as const) : []),
    ...(can(scopes, 'reports.finance:read') ? (['unbilled'] as const) : []),
  ];
  const want = params.get('tab') as ReportTab | null;
  const tab: ReportTab | undefined = want && tabs.includes(want) ? want : tabs[0];
  const current = bangkokMonth();
  const wantMonth = params.get('month');
  const month =
    wantMonth &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(wantMonth) &&
    wantMonth <= current &&
    wantMonth >= shiftMonth(current, -(MONTHS_BACK - 1))
      ? wantMonth
      : current;
  const revQ = {
    groupBy: isRev(tab) ? GROUP[tab] : ('customer' as const),
    fromMonth: tab === 'rmonth' ? shiftMonth(month, -(MONTH_TAB_SPAN - 1)) : month,
    toMonth: month,
  };
  const revenue = useRevenueReport(isRev(tab), revQ);
  const aging = useAgingByCustomer(tab === 'ar');
  const unbilled = useUnbilledReport(tab === 'unbilled');
  const days = useUnbilledDays(tabs.includes('unbilled') && tab !== 'unbilled');
  const minDays = unbilled.data?.minDays ?? days.data;
  const sell = can(scopes, 'prices.sell:read');

  if (!me.data) return null;
  if (!tab) return <NotReady page="report" stage="ST9" />;

  const ys = (me.data.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const monthText = (m: string) => formatMonth(m, 'th', ys);
  const label = (k: ReportTab) =>
    isRev(k)
      ? t(`rpt.tab.${k}` as MessageKey)
      : k === 'ar'
        ? t('rpt.tab.ar')
        : minDays !== undefined
          ? t('rpt.tab.unbilledN', { n: minDays })
          : t('rpt.tab.unbilled');

  let cols: { l: string; r?: boolean }[] = [];
  let rows: { key: string; cells: Cell[] }[] = [];
  let loading = false;
  let asOf: string | undefined;
  let more: { shown: number; total: number | null } | null = null;

  if (isRev(tab)) {
    loading = revenue.isLoading;
    const g = GROUP[tab];
    const r = revenue.data;
    // คอลัมน์ตามต้นแบบ (กำไรต่อลูกค้า/รถ — ตัดต้นทุน/กำไร/Margin ที่เป็น P1) + ใบแจ้งหนี้สำหรับนิติบุคคล/เดือน
    const dimCol: Record<RevenueGroupBy, MessageKey> = {
      customer: 'rpt.col.customer',
      route: 'rpt.col.route',
      vehicle: 'rpt.col.vehicle',
      vehicleType: 'rpt.col.vehicleTypeName',
      legalEntity: 'rpt.col.legalEntity',
      month: 'rpt.col.month',
    };
    const byInvoice = g === 'legalEntity' || g === 'month';
    cols = [
      { l: t(dimCol[g]) },
      ...(g === 'vehicle' ? [{ l: t('rpt.col.vehicleType') }] : []),
      byInvoice ? { l: t('rpt.col.invoices'), r: true } : { l: t('rpt.col.dos'), r: true },
      ...(sell ? [{ l: t('rpt.col.revenue'), r: true }] : [{ l: t('rpt.col.lines'), r: true }]),
    ];
    const n = (x: { invoiceCount: number; deliveryOrderCount: number }) =>
      (byInvoice ? x.invoiceCount : x.deliveryOrderCount).toLocaleString('en-US');
    const last = (x: { lineCount: number; sellAmount?: string }, fw?: number): Cell =>
      sell
        ? { v: money(x.sellAmount), mono: true, r: true, ...(fw ? { fw } : {}) }
        : { v: x.lineCount.toLocaleString('en-US'), r: true, ...(fw ? { fw } : {}) };
    rows = (r?.data ?? []).map((x) => ({
      key: x.id,
      cells: [
        x.label === null
          ? { v: t('rpt.unassigned'), c: '#59606B' }
          : g === 'month'
            ? { v: monthText(x.label), fw: 500 }
            : g === 'vehicle'
              ? { v: x.label, mono: true, fw: 500 }
              : g === 'route' && x.originName && x.destinationName
                ? { v: `${x.originName} → ${x.destinationName}` }
                : { v: x.label },
        ...(g === 'vehicle' ? [{ v: x.detail ?? '—' }] : []),
        { v: n(x), r: true },
        last(x),
      ],
    }));
    // แถว "รวม" (ต้นแบบ fcost: แถวรวมตัวหนา) — Σ ทุกแถว = ยอดรวมทั้งงวด
    if (r && rows.length)
      rows.push({
        key: 'total',
        cells: [
          { v: t('rpt.col.total'), fw: 600 },
          ...(g === 'vehicle' ? [{ v: '' }] : []),
          { v: n(r), r: true, fw: 600 },
          last(r, 600),
        ],
      });
  } else if (tab === 'ar') {
    loading = aging.isLoading;
    asOf = aging.data?.asOf;
    cols = [
      { l: t('rpt.col.customer') },
      ...AGING_ORDER.map((b) => ({ l: agingLabel(t, b), r: true })),
      { l: t('rpt.col.total'), r: true },
    ];
    rows = (aging.data?.data ?? []).map((x) => ({
      key: x.customer.id,
      cells: [
        { v: x.customer.legalName },
        ...AGING_ORDER.map((b, j) => {
          const k = x.buckets.find((y) => y.bucket === b);
          const has = sell ? Number(k?.sellOutstanding ?? 0) !== 0 : (k?.count ?? 0) > 0;
          return {
            v: !has
              ? '—'
              : sell
                ? money(k?.sellOutstanding)
                : t('pay.aging.count', { n: k?.count ?? 0 }),
            mono: true,
            r: true,
            // ต้นแบบ: ช่วงที่ 3 ขึ้นไป (31–60 วัน+) สีแดง · ไม่มียอด = — สีจาง
            c: has && j >= 2 ? '#B3322A' : has ? '#101418' : '#59606B',
          };
        }),
        {
          v: sell ? money(x.sellOutstanding) : t('pay.aging.count', { n: x.count }),
          mono: true,
          r: true,
          fw: 600,
        },
      ],
    }));
    if (aging.data?.hasMore) more = { shown: rows.length, total: null };
  } else {
    loading = unbilled.isLoading;
    asOf = unbilled.data?.asOf;
    cols = [
      { l: t('rpt.col.doNo') },
      { l: t('rpt.col.customer') },
      { l: t('rpt.col.doDate') },
      { l: t('rpt.col.delivered') },
      { l: t('rpt.col.age'), r: true },
      { l: t('rpt.col.status') },
      // D-71 ธง "ร่างค้างเกิน N วัน" — ต้นแบบไม่มีคอลัมน์นี้ ใช้รูปแบบเซลล์เดียวกับ "ค้างวางบิล" — หน้าตาคอลัมน์ [OPEN — Claude Design] (spec/12 §3 แถว ST9-T06 ข้อ 17)
      { l: t('rpt.col.draft') },
      ...(sell ? [{ l: t('rpt.col.amount'), r: true }] : []),
    ];
    rows = (unbilled.data?.data ?? []).map((x) => ({
      key: x.id,
      cells: [
        { v: x.doNo ?? '—', mono: true, c: '#2257C4', fw: 500 },
        { v: x.customer.legalName },
        { v: dateText(x.doDate) },
        { v: dateText(x.deliveredOn) },
        { v: t('rpt.days', { n: x.daysSinceDelivery }), r: true, fw: 600, c: '#8F5500' },
        { v: t(`do.st.${x.status}` as MessageKey) },
        x.draftInvoice
          ? { v: t('rpt.draftAge', { n: x.draftInvoice.ageDays }), fw: 600, c: '#8F5500' }
          : { v: '—', c: '#59606B' },
        ...(sell ? [{ v: money(x.sellAmount), mono: true, r: true }] : []),
      ],
    }));
    const total = unbilled.data?.count ?? 0;
    if (total > rows.length) more = { shown: rows.length, total };
  }

  const doExport = () => {
    setBusy(true);
    void (
      isRev(tab)
        ? exportList('revenue', revQ, 'xlsx')
        : exportList(RESOURCE[tab], tab === 'unbilled' ? UNBILLED_QUERY : {}, 'xlsx')
    )
      .then(
        () => setToast(t('rpt.exported')),
        (e) => setToast(exportFailText(t, e, t('export.failed'))),
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <PageHeader
        title={t('page.report.title')}
        sub={t('page.report.sub')}
        actions={
          <>
            <Button
              variant="secondary"
              icon="download"
              disabled={!can(scopes, 'export:run') || busy}
              onClick={doExport}
            >
              {t('rpt.export')}
            </Button>
            {/* ตั้งเวลาส่งรายงาน = P1 (spec/09 §9, spec/12 §1) — คงปุ่มตามต้นแบบแต่ปิดไว้ */}
            <Button variant="secondary" icon="calendar-clock" disabled title={t('rpt.schedSoon')}>
              {t('rpt.sched')}
            </Button>
          </>
        }
      />
      <div
        data-testid="report-card"
        style={{
          background: '#FFFFFF',
          border: '1px solid #CDD1C8',
          borderRadius: 12,
          boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
          overflow: 'auto',
          flex: '1 1 0',
          minHeight: 'max(360px,calc(100vh - 280px))',
        }}
      >
        <div
          role="tablist"
          style={{
            padding: '0 20px',
            borderBottom: '1px solid #E4E6E0',
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() =>
                setParams(isRev(k) && wantMonth ? { tab: k, month: wantMonth } : { tab: k }, {
                  replace: true,
                })
              }
              style={{
                height: 48,
                padding: 0,
                marginBottom: -1,
                border: 0,
                borderBottom: `2px solid ${tab === k ? '#2257C4' : 'transparent'}`,
                background: 'transparent',
                color: tab === k ? '#2257C4' : '#3B424C',
                fontWeight: tab === k ? 600 : 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {label(k)}
            </button>
          ))}
          {isRev(tab) ? (
            // ต้นแบบ: "งวด {ช่วง}" ข้อความ 13px ขวาของแถบแท็บ — เลือกงวดได้ (select หน้าตาเป็นข้อความเดียวกัน)
            <label style={{ marginLeft: 'auto', fontSize: 13, color: '#3B424C' }}>
              {t('rpt.per')}{' '}
              <select
                aria-label={t('rpt.perLabel')}
                value={month}
                onChange={(e) => setParams({ tab, month: e.target.value }, { replace: true })}
                style={{
                  border: 0,
                  background: 'transparent',
                  font: 'inherit',
                  color: 'inherit',
                  padding: 0,
                  cursor: 'pointer',
                }}
              >
                {Array.from({ length: MONTHS_BACK }, (_, i) => shiftMonth(current, -i)).map((m) => (
                  <option key={m} value={m}>
                    {tab === 'rmonth'
                      ? `${monthText(shiftMonth(m, -(MONTH_TAB_SPAN - 1)))} – ${monthText(m)}`
                      : monthText(m)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span style={{ marginLeft: 'auto', fontSize: 13, color: '#3B424C' }}>
              {asOf ? t('rpt.asOf', { date: dateText(asOf) }) : ''}
            </span>
          )}
        </div>
        {rows.length > 0 ? (
          <>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.l} style={{ ...TH, textAlign: c.r ? 'right' : 'left' }}>
                      {c.l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="tms-rpt-row">
                    {row.cells.map((c, i) => (
                      <td key={i} style={td(c)}>
                        {c.v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {more && (
              <p style={{ margin: 0, padding: '12px 20px', fontSize: 13, color: '#3B424C' }}>
                {more.total === null
                  ? t('rpt.moreAr', { shown: more.shown.toLocaleString('en-US') })
                  : t('rpt.more', {
                      shown: more.shown.toLocaleString('en-US'),
                      total: more.total.toLocaleString('en-US'),
                    })}
              </p>
            )}
          </>
        ) : loading ? (
          <Center>
            <span style={{ color: '#3B424C' }}>{t('table.loading')}</span>
          </Center>
        ) : (
          <Center>
            <Icon n="chart-column" s={40} style={{ color: '#C9CDC3' }} />
            <div style={{ fontSize: 16, fontWeight: 600 }}>{t('rpt.empty.title')}</div>
            <div style={{ color: '#3B424C' }}>{t('rpt.empty.desc')}</div>
          </Center>
        )}
      </div>
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}

function Center({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '48px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}
