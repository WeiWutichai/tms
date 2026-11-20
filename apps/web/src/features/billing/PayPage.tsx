import {
  Button,
  DataTable,
  DocNo,
  EmptyState,
  StatusDot,
  StatusTabs,
  SummaryStrip,
  Toast,
  type Column,
} from '@tms/ui';
import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { bangkokToday, money, useDateText } from '../rate-cards/rateFormat';
import { invoiceDisplayStatus, overdueDays } from './billing';
import { InvoiceDrawer, invoiceStatusLabel } from './InvoiceDrawer';
import { PayDrawer } from './PayDrawer';
import { SavedViewMenu } from '../views/SavedViewMenu';
import { pick, useSavedViews } from '../views/useSavedViews';
import type { InvoiceSummary } from './useInvoices';
import { usePaymentSummary, useReceivableList } from './usePayments';

type Tab = 'all' | 'open' | 'over' | 'part' | 'paid';
const TABS: Tab[] = ['all', 'open', 'over', 'part', 'paid'];
/** แท็บ → ตัวกรอง API (ต้นแบบ specPay tabs) */
const TAB_QUERY: Record<Tab, Record<string, string>> = {
  all: { receivable: 'all' },
  open: { receivable: 'open' },
  over: { receivable: 'overdue' },
  // ต้นแบบ invSt: ใบเกินกำหนดอยู่แท็บ "เกินกำหนด" (ไม่ซ้ำในแท็บชำระบางส่วน — ST5-T18)
  part: { receivable: 'all', status: 'PARTIALLY_PAID', overdue: 'false' },
  paid: { receivable: 'all', status: 'PAID' },
};
/** ตัวกรองคอลัมน์สถานะ (ต้นแบบ: ทั้งหมด / ออกแล้ว / ชำระบางส่วน / ชำระแล้ว / เกินกำหนด) */
const EMPTY_VIEW = { tab: 'all', no: '', cust: '', st: '' };
const ST_OPTS = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;

/**
 * บัญชี → รับชำระ (ST5-T13; ต้นแบบ TMS v4 `pay` = kpisPay + ตาราง specPay + drawer vPanel 'pay')
 * D-54/D-56 บัญชีเบา: บันทึกเงิน/เช็ค ไม่ออกใบเสร็จ — คำบรรยายหน้าตัด "ออกใบเสร็จ" [DECISION spec/12 §3]
 * การ์ด "อายุลูกหนี้" (vPay) = ST5-T22 · "ส่งใบแจ้งเตือนชำระ" (อีเมลถึงลูกค้า) = ST5-T22 เตือนครบกำหนด · คอลัมน์ "ระบบบัญชี" = ST8-T16
 */
export function PayPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canRecord = can(scopes, 'payments:record');
  const canReverse = can(scopes, 'payments:reverse');
  const canDraft = can(scopes, 'invoices:draft');
  const canFinalize = can(scopes, 'invoices:finalize');
  // ST5-T10 ยกเลิกใบที่ออกแล้ว (owner/admin/manager — spec/05 §19)
  const canVoid = can(scopes, 'invoices:void');
  const dateText = useDateText();
  const today = bangkokToday();
  const [tab, setTab] = useSessionState<Tab>('pay.tab', 'all');
  const [col, setCol] = useSessionState('pay.cols', { no: '', cust: '', st: '' });
  const [hidden, setHidden] = useSessionState<string[] | null>('pay.hidden', null);
  // มุมมองที่บันทึกไว้ (ST9-T11 — ต้นแบบ "มุมมอง: ของฉันวันนี้"): แท็บ + ตัวกรองคอลัมน์ + คอลัมน์ที่ซ่อน
  const views = useSavedViews({
    page: 'payments',
    state: { tab, ...col },
    hidden,
    empty: EMPTY_VIEW,
    apply: (v) => {
      const x = pick(v.state, EMPTY_VIEW);
      setTab(TABS.includes(x.tab as Tab) ? (x.tab as Tab) : 'all');
      setCol({ no: x.no, cust: x.cust, st: x.st });
      setHidden(v.hidden);
    },
  });
  const [open, setOpen] = useState<{ id: string; kind: 'pay' | 'inv' } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const sum = usePaymentSummary().data;

  const filters = useMemo(() => TAB_QUERY[tab], [tab]);
  const list = useReceivableList(filters);
  const shown = list.rows.filter(
    (x) =>
      (!col.no || (x.invoiceNo ?? '').includes(col.no)) &&
      (!col.cust || x.customer.legalName.includes(col.cust)) &&
      (!col.st || invoiceDisplayStatus(x) === col.st),
  );
  const tabCount: Record<Tab, number | undefined> = {
    all: sum?.total,
    open: sum?.open,
    over: sum?.overdue,
    part: sum?.partiallyPaid,
    paid: sum?.paid,
  };
  const shownTotal = listTotal(
    list,
    { tab, ...col },
    ['tab'],
    col.no || col.cust || col.st ? undefined : tabCount[tab],
  );
  const outOf = (x: InvoiceSummary) => Number(x.sellOutstanding ?? '0');

  const columns: Column<InvoiceSummary>[] = [
    {
      key: 'no',
      label: t('pay.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <DocNo>{x.invoiceNo}</DocNo>,
      csv: (x) => x.invoiceNo ?? '',
    },
    {
      key: 'cust',
      label: t('bill.col.cust'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <span style={{ color: '#101418' }}>{x.customer.legalName}</span>,
      csv: (x) => x.customer.legalName,
    },
    {
      key: 'due',
      label: t('bill.col.due'),
      width: '1%',
      render: (x) => {
        const late = overdueDays(x, today);
        return (
          <span style={{ whiteSpace: 'nowrap', color: late ? '#B3322A' : '#101418' }}>
            {x.dueDate ? dateText(x.dueDate) : '—'}
            {late > 0 && ` ${t('pay.late', { n: late })}`}
          </span>
        );
      },
      csv: (x) => x.dueDate ?? '',
    },
    {
      key: 'net',
      label: t('bill.col.amt'),
      align: 'right',
      width: '1%',
      render: (x) => <span className="tms-num">{money(x.sellTotal)}</span>,
      csv: (x) => x.sellTotal ?? '',
    },
    {
      key: 'paid',
      label: t('pay.col.paid'),
      align: 'right',
      width: '1%',
      render: (x) => (
        <span
          className="tms-num"
          style={{ color: Number(x.sellPaidAmount ?? '0') ? '#101418' : '#3B424C' }}
        >
          {money(x.sellPaidAmount)}
        </span>
      ),
      csv: (x) => x.sellPaidAmount ?? '',
    },
    {
      key: 'out',
      label: t('bill.col.out'),
      align: 'right',
      width: '1%',
      render: (x) => (
        <span
          className="tms-num"
          style={{ color: outOf(x) ? '#101418' : '#3B424C', fontWeight: 600 }}
        >
          {money(x.sellOutstanding)}
        </span>
      ),
      csv: (x) => x.sellOutstanding ?? '',
    },
    {
      key: 'st',
      label: t('bill.col.st'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...ST_OPTS.map((s) => ({ value: s, label: invoiceStatusLabel(t, s) })),
        ],
      },
      render: (x) => <StatusDot label={invoiceStatusLabel(t, invoiceDisplayStatus(x))} />,
      csv: (x) => invoiceStatusLabel(t, invoiceDisplayStatus(x)),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('page.pay.title')}
        sub={t('page.pay.sub')}
        actions={
          // ส่งออกให้นักบัญชี (spec/05 §14) — งานส่งออกยังไม่มี (เหมือนหน้าวางบิล) [DECISION spec/12 §3]
          <Button variant="secondary" icon="file-down" disabled title={t('bill.xpSoon')}>
            {t('bill.xp')}
          </Button>
        }
      />
      {/* ต้นแบบ kpisPay บนหน้า "รับชำระ" = แถบสรุปบรรทัดเดียว (ตัวเลข + ป้าย) กดเพื่อกรองแท็บ */}
      <SummaryStrip
        items={[
          {
            value: sum ? money(sum.sellOutstanding) : '—',
            label: t('pay.kpi.out'),
            onClick: () => setTab(tab === 'open' ? 'all' : 'open'),
            pressed: tab === 'open',
          },
          {
            value: sum ? money(sum.sellOverdueOutstanding) : '—',
            label: t('pay.kpi.over'),
            color: '#B3322A',
            onClick: () => setTab(tab === 'over' ? 'all' : 'over'),
            pressed: tab === 'over',
          },
          {
            value: sum ? money(sum.sellReceivedThisMonth) : '—',
            label: t('pay.kpi.month'),
            color: '#17733F',
            onClick: () => setTab(tab === 'paid' ? 'all' : 'paid'),
            pressed: tab === 'paid',
          },
          { value: sum?.dueSoon ?? '—', label: t('pay.kpi.soon'), color: '#8F5500' },
        ]}
      />

      <h2 style={{ margin: '28px 0 0', fontSize: 15, fontWeight: 600 }}>{t('pay.listTitle')}</h2>
      <div className="tms-listbody" style={{ marginTop: 12 }}>
        <StatusTabs
          value={tab}
          onChange={(k) => setTab(k as Tab)}
          items={TABS.map((k) => ({
            key: k,
            label: t(`pay.tab.${k}` as MessageKey),
            ...(tabCount[k] !== undefined ? { count: tabCount[k]! } : {}),
          }))}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <SavedViewMenu b={views} onToast={setToast} />
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('bill.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('cust.retry')}
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={shown}
            rowId={(x) => x.id}
            activeId={open?.id ?? null}
            loading={list.loading}
            labels={tableLabels(t)}
            bulkActions={[
              { label: t('bill.xp'), icon: 'file-down', run: () => setToast(t('bill.xpSoon')) },
            ]}
            filters={col}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(x) => setOpen({ id: x.id, kind: 'pay' })}
            rowMenu={(x) => [
              ...(outOf(x) > 0 && canRecord
                ? [
                    {
                      label: t('pay.save'),
                      icon: 'banknote',
                      run: () => setOpen({ id: x.id, kind: 'pay' }),
                    },
                  ]
                : []),
              {
                label: t('pay.viewInv'),
                icon: 'eye',
                run: () => setOpen({ id: x.id, kind: 'inv' }),
              },
            ]}
            empty={
              <EmptyState
                icon="banknote"
                title={t('pay.list.emptyTitle')}
                description={t('pay.list.emptyDesc')}
              />
            }
            page={{
              ...list.page,
              ...(shownTotal !== undefined ? { total: shownTotal } : {}),
            }}
            onPageSize={list.setSize}
            onNext={list.next}
            onPrev={list.prev}
            onGoto={list.goto}
          />
        )}
      </div>
      {open?.kind === 'pay' && (
        <PayDrawer
          id={open.id}
          canRecord={canRecord}
          canReverse={canReverse}
          onClose={() => setOpen(null)}
          onOpenInvoice={() => setOpen({ id: open.id, kind: 'inv' })}
          onToast={setToast}
        />
      )}
      {open?.kind === 'inv' && (
        <InvoiceDrawer
          id={open.id}
          canDraft={canDraft}
          canFinalize={canFinalize}
          canVoid={canVoid}
          canRecord={canRecord}
          onPay={() => setOpen({ id: open.id, kind: 'pay' })}
          onOpenInvoice={(id) => setOpen({ id, kind: 'inv' })}
          onClose={() => setOpen(null)}
          onToast={setToast}
        />
      )}
      {toast && (
        <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
      )}
    </>
  );
}
