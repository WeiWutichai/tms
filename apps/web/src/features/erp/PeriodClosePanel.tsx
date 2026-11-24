import type { Schemas } from '@tms/contracts';
import { Button, EmptyState, KpiCard, type KpiTone } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { formatDateTime, formatMonth, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { exportList } from '../exports/exportJob';
import { exportFailText } from '../master/download';
import { problemText } from '../master/problems';
import { money, useDateText } from '../rate-cards/rateFormat';
import { TH, td, type Cell } from '../reports/ReportPage';
import { bangkokMonth, shiftMonth } from '../reports/useReports';

export type PeriodCloseReport = Schemas['PeriodCloseReportDto'];
type Section = 'out' | 'ack' | 'unsent';
const SECTIONS: Section[] = ['out', 'ack', 'unsent'];
/** งวดที่เลือกได้ — 24 เดือนล่าสุด (แบบหน้า "รายงาน") */
export const CLOSE_MONTHS_BACK = 24;

/** ค่าเริ่มของงวด = เดือนก่อน (เดือนที่ปิดงวดได้แล้ว) */
export const defaultCloseMonth = (now = new Date()) => shiftMonth(bangkokMonth(now), -1);

/** ผลของงวด → ป้าย + สีของการ์ด: ผ่าน · ไม่ผ่าน · ยังไม่จบเดือน (`passed` false เพราะเดือนยังไม่จบ ไม่ใช่ไม่ผ่าน) */
export function closeResult(r: Pick<PeriodCloseReport, 'passed' | 'monthEnded'>): {
  k: MessageKey;
  tone: KpiTone;
} {
  if (!r.monthEnded) return { k: 'erpq.pc.res.open', tone: 'warn' };
  return r.passed ? { k: 'erpq.pc.res.pass', tone: 'ok' } : { k: 'erpq.pc.res.fail', tone: 'err' };
}

export function usePeriodClose(connectorId: string | null, month: string) {
  return useQuery({
    queryKey: ['reconcile-results', 'period-close', connectorId, month],
    enabled: !!connectorId,
    retry: false,
    queryFn: () =>
      unwrap(
        api.GET('/v1/reconcile-reports/period-close', {
          params: { query: { connectorId: connectorId!, month } },
        }),
      ),
  });
}

/**
 * แท็บ "ปิดงวด" ของหน้า "คิวเชื่อมระบบบัญชี" (ST8-T14 รายงานปิดงวด — คำถามค้าง #95)
 * [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ] ต้นแบบไม่มีหน้ารายงานปิดงวด → ประกอบจากชิ้นที่มี:
 * การ์ด KPI (แบบหน้า settle `tms-kpis`) ผล · MISMATCH ค้าง ณ สิ้นเดือน · ยังไม่ส่ง · ยังไม่ได้ยืนยัน · ยอมรับความต่าง +
 * การ์ดรายงาน (แบบหน้า "รายงาน" `vRep`: แถบแท็บขีดเส้นใต้ + "งวด" เลือกเดือนขวาของแถบ + ตาราง) 3 ส่วนของ API ·
 * ปุ่ม "ส่งออก Excel / CSV / PDF" = งานส่งออก `reconcile-period-close` (`export:run`)
 * เกณฑ์ผ่าน = เดือนจบ + ค้าง 0 + ยังไม่ส่ง 0 + ยังไม่ได้ยืนยัน 0 (PO #95-b) — คำนวณที่ API (`passed`) หน้าไม่คิดเอง
 */
export function PeriodClosePanel({
  connectorId,
  erp,
  onOpenResult,
  onOpenQueue,
  onToast,
}: {
  connectorId: string | null;
  erp: string;
  /** เปิด drawer ผลเทียบ (ส่วนค้าง / ยอมรับ) */
  onOpenResult: (id: string) => void;
  /** ไปแท็บคิว (ส่วนยังไม่ส่ง) */
  onOpenQueue: (tab: 'queued' | 'failed') => void;
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const dateText = useDateText();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const monthText = (m: string) => formatMonth(m, 'th', ys);
  const current = bangkokMonth();
  const [month, setMonth] = useState(defaultCloseMonth);
  const [sec, setSec] = useState<Section>('out');
  const [busy, setBusy] = useState<string | null>(null);
  const q = usePeriodClose(connectorId, month);
  const r = q.data;
  const sell = can(scopes, 'prices.sell:read');
  const buy = can(scopes, 'prices.buy:read');

  if (!connectorId)
    return <EmptyState icon="plug" title={t('erpq.q.noConn')} description={t('erpq.q.noConnD')} />;

  const doExport = (format: 'xlsx' | 'csv' | 'pdf') => {
    setBusy(format);
    void exportList('reconcile-period-close', { connectorId, month }, format)
      .then(
        () => onToast(t('erpq.pc.exported')),
        (e) => {
          const m = exportFailText(t, e, t('export.failed'));
          if (m) onToast(m);
        },
      )
      .finally(() => setBusy(null));
  };
  const at = (iso: string | null | undefined) => (iso ? formatDateTime(iso, lang) : '—');
  const sevLabel = (s: string) => {
    const k = `erpq.pc.sev.${s}` as MessageKey;
    return t(k) === k ? s : t(k);
  };
  const res = r ? closeResult(r) : null;
  const sum = r?.summary;

  // ตารางของส่วนที่เลือก (หน้าตาเดียวกับตารางหน้า "รายงาน")
  let cols: { l: string; r?: boolean }[] = [];
  let rows: { key: string; cells: Cell[]; open: () => void }[] = [];
  if (r && sec === 'out') {
    cols = [
      { l: t('erpq.col.no') },
      { l: t('erpq.pc.c.sev') },
      { l: t('erpq.pc.c.found') },
      { l: t('erpq.pc.c.now') },
      ...(sell ? [{ l: t('erpq.pc.c.diff'), r: true }] : []),
    ];
    rows = r.outstanding.map((x) => ({
      key: x.id,
      open: () => onOpenResult(x.id),
      cells: [
        { v: x.localNumber ?? '—', mono: true, c: '#2257C4', fw: 500 },
        { v: sevLabel(x.severity), c: x.severity === 'MONEY' ? '#B3322A' : '#8F5500', fw: 500 },
        { v: at(x.foundAt) },
        {
          v:
            x.currentStatus === 'OPEN'
              ? t('erpq.pc.now.OPEN')
              : t(`erpq.pc.now.${x.currentStatus}` as MessageKey, { t: at(x.closedAt) }),
        },
        ...(sell
          ? [
              {
                v: x.sellDifferenceAmount ? money(x.sellDifferenceAmount) : '—',
                mono: true,
                r: true,
              },
            ]
          : []),
      ],
    }));
  } else if (r && sec === 'ack') {
    cols = [
      { l: t('erpq.col.no') },
      { l: t('erpq.pc.c.ackAt') },
      { l: t('erpq.pc.c.ackBy') },
      { l: t('erpq.pc.c.reason') },
      ...(sell ? [{ l: t('erpq.pc.c.diff'), r: true }] : []),
    ];
    rows = r.acknowledged.map((x) => ({
      key: x.id,
      open: () => onOpenResult(x.id),
      cells: [
        { v: x.localNumber ?? '—', mono: true, c: '#2257C4', fw: 500 },
        { v: at(x.acknowledgedAt) },
        { v: x.acknowledgedByName ?? '—' },
        { v: x.ackReason ?? '—' },
        ...(sell
          ? [
              {
                v: x.sellDifferenceAmount ? money(x.sellDifferenceAmount) : '—',
                mono: true,
                r: true,
              },
            ]
          : []),
      ],
    }));
  } else if (r) {
    cols = [
      { l: t('erpq.col.no') },
      { l: t('erpq.col.type') },
      { l: t('erpq.col.cust') },
      { l: t('erpq.pc.c.date') },
      { l: t('erpq.col.st') },
      ...(sell || buy ? [{ l: t('erpq.pc.c.amount'), r: true }] : []),
    ];
    rows = r.notSent.map((x) => ({
      key: x.commandId,
      open: () => onOpenQueue(x.queueTab === 'queued' ? 'queued' : 'failed'),
      cells: [
        { v: x.documentNo ?? '—', mono: true, c: '#2257C4', fw: 500 },
        { v: t(`erpq.type.${x.entityType.toUpperCase()}` as MessageKey) },
        { v: x.counterpartyName ?? '—' },
        { v: x.documentDate ? dateText(x.documentDate) : '—' },
        {
          v: t(x.queueTab === 'queued' ? 'erpq.tab.queued' : 'erpq.tab.failed'),
          c: x.queueTab === 'queued' ? '#8F5500' : '#B3322A',
          fw: 500,
        },
        ...(sell || buy
          ? [
              {
                v: money(x.sellTotalAmount ?? x.buyNetAmount ?? null),
                mono: true,
                r: true,
              },
            ]
          : []),
      ],
    }));
  }
  const count: Record<Section, number | undefined> = {
    out: sum?.outstanding,
    ack: sum?.acknowledged,
    unsent: sum?.notSent,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="period-close">
      <div className="tms-kpis">
        <KpiCard
          label={t('erpq.pc.k.res', { m: monthText(month) })}
          value={res ? t(res.k) : '—'}
          tone={res?.tone ?? 'neutral'}
          sub={r ? t('erpq.pc.asOf', { t: at(r.asOf) }) : undefined}
        />
        <KpiCard
          label={t('erpq.pc.k.out')}
          value={sum ? sum.outstanding : '—'}
          tone={sum && sum.outstanding > 0 ? 'err' : 'neutral'}
          sub={
            sum
              ? t('erpq.pc.k.outSub', { m: sum.outstandingMoney, f: sum.outstandingField })
              : undefined
          }
          onClick={() => setSec('out')}
          active={sec === 'out'}
        />
        <KpiCard
          label={t('erpq.pc.k.unsent', { erp })}
          value={sum ? sum.notSent : '—'}
          tone={sum && sum.notSent > 0 ? 'warn' : 'neutral'}
          sub={
            sum
              ? t('erpq.pc.k.unsentSub', { q: sum.notSentQueued, f: sum.notSentFailed })
              : undefined
          }
          onClick={() => setSec('unsent')}
          active={sec === 'unsent'}
        />
        <KpiCard
          label={t('erpq.pc.k.unverified')}
          value={sum ? sum.unverified : '—'}
          tone={sum && sum.unverified > 0 ? 'warn' : 'neutral'}
          sub={t('erpq.pc.k.unverifiedSub', { erp })}
        />
        <KpiCard
          label={t('erpq.pc.k.ack')}
          value={sum ? sum.acknowledged : '—'}
          onClick={() => setSec('ack')}
          active={sec === 'ack'}
        />
      </div>
      <div
        data-testid="report-card"
        style={{
          background: '#FFFFFF',
          border: '1px solid #CDD1C8',
          borderRadius: 12,
          boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
          overflow: 'auto',
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
          {SECTIONS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={sec === k}
              onClick={() => setSec(k)}
              style={{
                height: 48,
                padding: 0,
                marginBottom: -1,
                border: 0,
                borderBottom: `2px solid ${sec === k ? '#2257C4' : 'transparent'}`,
                background: 'transparent',
                color: sec === k ? '#2257C4' : '#3B424C',
                fontWeight: sec === k ? 600 : 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t(`erpq.pc.sec.${k}` as MessageKey)}
              {count[k] !== undefined ? ` (${count[k]})` : ''}
            </button>
          ))}
          {/* ต้นแบบ vRep: "งวด {เดือน}" ข้อความ 13px ขวาของแถบแท็บ — เลือกเดือนได้ (แบบหน้า "รายงาน") */}
          <label style={{ marginLeft: 'auto', fontSize: 13, color: '#3B424C' }}>
            {t('rpt.per')}{' '}
            <select
              aria-label={t('rpt.perLabel')}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              style={{
                border: 0,
                background: 'transparent',
                font: 'inherit',
                color: 'inherit',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              {Array.from({ length: CLOSE_MONTHS_BACK }, (_, i) => shiftMonth(current, -i)).map(
                (m) => (
                  <option key={m} value={m}>
                    {monthText(m)}
                  </option>
                ),
              )}
            </select>
          </label>
          {can(scopes, 'export:run') && (
            <span style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
              {(['xlsx', 'csv', 'pdf'] as const).map((f) => (
                <Button
                  key={f}
                  variant="secondary"
                  icon={f === 'pdf' ? 'printer' : 'download'}
                  disabled={!!busy || !r}
                  onClick={() => doExport(f)}
                >
                  {t(`erpq.pc.exp.${f}` as MessageKey)}
                </Button>
              ))}
            </span>
          )}
        </div>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('erpq.loadError')}
            description={problemText(q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => q.refetch()}>
                {t('cust.retry')}
              </Button>
            }
          />
        ) : !r ? (
          <EmptyState icon="loader" title={t('table.loading')} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="circle-check"
            title={t(`erpq.pc.empty.${sec}` as MessageKey)}
            description={t('erpq.pc.emptyD', { m: monthText(month) })}
          />
        ) : (
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
                  <tr
                    key={row.key}
                    className="tms-rpt-row"
                    onClick={row.open}
                    style={{ cursor: 'pointer' }}
                  >
                    {row.cells.map((c, i) => (
                      <td key={i} style={td(c)}>
                        {c.v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {r.truncated && (
              <p style={{ margin: 0, padding: '12px 20px', fontSize: 13, color: '#3B424C' }}>
                {t('erpq.pc.truncated')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
