import {
  Badge,
  Button,
  DataTable,
  DocNo,
  EmptyState,
  Icon,
  KpiCard,
  RouteChip,
  StatusDot,
  StatusTabs,
  Toast,
  statusOf,
  type Column,
} from '@tms/ui';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { SavedViewMenu } from '../views/SavedViewMenu';
import { pick, useSavedViews } from '../views/useSavedViews';
import { bangkokToday, money, useDateText } from '../rate-cards/rateFormat';
import { billRanges, selectionTotals } from './billing';
import { finalizeErrorText, InvoiceDrawer, invoiceStatusLabel } from './InvoiceDrawer';
import { PayDrawer } from './PayDrawer';
import {
  BillingNoteDrawer,
  BillingNoteForm,
  billingNoteErrorText,
  billingNoteStatusLabel,
} from './BillingNoteDrawer';
import {
  openBillingNotePdf,
  useBillingNoteCounts,
  useBillingNoteList,
  useFinalizeBillingNote,
  type BillingNoteSummary,
} from './useBillingNotes';
import {
  openIssuedPdf,
  openProforma,
  previewDraft,
  useBillQueue,
  useCreateDraft,
  useCustomerTerms,
  useFinalize,
  useInvoiceCounts,
  useInvoiceList,
  useQueueCustomers,
  type InvoiceSummary,
  type QueueRow,
} from './useInvoices';

type Tab = 'all' | 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED';
const TABS: Tab[] = ['all', 'DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'];
const EMPTY_VIEW = { tab: 'all', q: '', type: '' };
/** แท็บของต้นแบบ → สถานะใบวางบิล (ST5-T11) — ชำระบางส่วน/เกินกำหนด ไม่มีในใบวางบิล (ว่าง) · COLLECTED = แท็บ "ชำระแล้ว" */
const BN_STATUS: Partial<Record<Tab, string>> = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  PAID: 'COLLECTED',
  CANCELLED: 'CANCELLED',
};
const STEPS: MessageKey[] = ['bill.step.1', 'bill.step.2', 'bill.step.3', 'bill.step.4'];

const card = {
  background: '#FFFFFF',
  border: '1px solid #CDD1C8',
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
} as const;
const lbl = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' } as const;
const sel = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
} as const;
const th = {
  position: 'sticky',
  top: 56,
  zIndex: 2,
  background: '#EEF0EC',
  height: 40,
  padding: '0 12px',
  borderBottom: '1px solid #E4E6E0',
  textAlign: 'left',
  fontSize: 12.5,
  fontWeight: 500,
  color: '#3B424C',
  whiteSpace: 'nowrap',
} as const;
const td = { padding: '0 12px', borderBottom: '1px solid #E4E6E0', whiteSpace: 'nowrap' } as const;
const num = { fontVariantNumeric: 'tabular-nums', fontSize: 13 } as const;

/**
 * บัญชี → วางบิลและใบแจ้งหนี้ (ST5-T07; ต้นแบบ TMS v4 `bill` = kpisX('bill') + การ์ด "สร้างใบวางบิล" (vBill) + ตาราง specInv + drawer vPanel inv)
 * D-54 บัญชีเบา: ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี — ตัดชิป/ข้อความ/ตัวกรองเอกสารภาษี (spec/12 §3) · DO มาจากคิวพร้อมวางบิล (ST5-T04)
 * "ออกเอกสาร" ในงานนี้ = ส่งบัญชี + สร้างร่าง (ไม่มีเลข) → เปิด drawer ร่าง · ออกเลข/ล็อก = ST5-T09 [DECISION spec/12 §3]
 */
export function BillPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canDraft = can(scopes, 'invoices:draft');
  const canFinalize = can(scopes, 'invoices:finalize');
  const canRecord = can(scopes, 'payments:record');
  const canReverse = can(scopes, 'payments:reverse');
  const dateText = useDateText();
  const today = bangkokToday();
  const ranges = useMemo(() => billRanges(today), [today]);
  const [cust, setCust] = useState('');
  const [range, setRange] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [tab, setTab] = useSessionState<Tab>('bill.tab', 'all');
  const [col, setCol] = useSessionState('bill.cols', { q: '', type: '' });
  const [hidden, setHidden] = useSessionState<string[] | null>('bill.hidden', null);
  // มุมมองที่บันทึกไว้ (ST9-T11 — ต้นแบบ "มุมมอง: ของฉันวันนี้"): แท็บ + ตัวกรองคอลัมน์ + คอลัมน์ที่ซ่อน
  const views = useSavedViews({
    page: 'invoices',
    state: { tab, ...col },
    hidden,
    empty: EMPTY_VIEW,
    apply: (v) => {
      const x = pick(v.state, EMPTY_VIEW);
      setTab(TABS.includes(x.tab as Tab) ? (x.tab as Tab) : 'all');
      // ประเภทเอกสาร: ใบแจ้งหนี้ (ค่าเริ่ม) / ใบวางบิล (ST5-T11) — มุมมองเก่าที่เก็บ 'INV' = ใบแจ้งหนี้
      setCol({ q: x.q, type: x.type === 'BN' ? 'BN' : '' });
      setHidden(v.hidden);
    },
  });
  const [openId, setOpenId] = useState<string | null>(null);
  /** ST5-T13 drawer รับชำระ (จากปุ่ม "บันทึกรับชำระ" ใน drawer ใบแจ้งหนี้) */
  const [payId, setPayId] = useState<string | null>(null);
  const [openBn, setOpenBn] = useState<string | null>(null);
  const [bnForm, setBnForm] = useState<{
    customerId: string;
    customerName: string;
    preselected: string[];
  } | null>(null);
  const isBn = col.type === 'BN';
  const [toast, setToast] = useState<string | null>(null);

  const custQ = useQueueCustomers();
  const customers = custQ.data?.customers ?? [];
  useEffect(() => {
    if (!cust && customers[0]) setCust(customers[0].customerId);
  }, [cust, customers]);
  const terms = useCustomerTerms(cust || undefined);
  const r = ranges[range]!;
  const queue = useBillQueue({ customerId: cust || undefined, dateFrom: r.from, dateTo: r.to });
  const rows = cust ? (queue.data?.data ?? []) : [];
  const chosen = rows.filter((x) => picked.includes(x.id));
  const totals = selectionTotals(chosen);
  const create = useCreateDraft();
  const finalize = useFinalize();
  const finalizeBn = useFinalizeBillingNote();
  /** ออกเอกสารใบวางบิลจากเมนูแถว */
  const issueBn = (x: BillingNoteSummary) =>
    finalizeBn.mutate(
      { id: x.id, version: x.version },
      {
        onSuccess: (r) => setToast(t('bill.toast.issued', { no: r.billingNoteNo ?? '' })),
        onError: (e) => setToast(billingNoteErrorText(e, t)),
      },
    );
  /** สร้างใบวางบิลจากใบแจ้งหนี้ที่ออกแล้ว (ลูกค้าเดียว) — เปิดฟอร์ม (ติ๊กใบ + วันนัดรับเช็ค) */
  const startBn = (rows: InvoiceSummary[]) => {
    const ok = rows.filter((x) => x.status === 'ISSUED');
    if (!ok.length || ok.length !== rows.length) {
      setToast(t('bn.pickIssued'));
      return;
    }
    if (new Set(ok.map((x) => x.customer.id)).size > 1) {
      setToast(t('bn.oneCustomer'));
      return;
    }
    setBnForm({
      customerId: ok[0]!.customer.id,
      customerName: ok[0]!.customer.legalName,
      preselected: ok.map((x) => x.id),
    });
  };
  /** ออกเอกสารจากเมนูแถว (ต้นแบบ specInv menu "ออกเอกสาร" → issueInv) */
  const issue = (x: InvoiceSummary) =>
    finalize.mutate(
      { id: x.id, version: x.version },
      {
        onSuccess: (r) => setToast(t('bill.toast.issued', { no: r.invoiceNo ?? '' })),
        onError: (e) => setToast(finalizeErrorText(e, t)),
      },
    );
  const counts = useInvoiceCounts().data;
  const [busy, setBusy] = useState(false);

  const allVat = terms.data?.defaultVatType === 'VAT_7';
  const step = chosen.length ? 3 : 2;
  const reset = () => setPicked([]);

  /** ออกเอกสาร = ส่งบัญชี + สร้างร่าง (คำขอเดียว) → เปิด drawer ร่าง */
  const create1 = () => {
    if (!chosen.length) return;
    create.mutate(
      { customerId: cust, rows: chosen, from: r.from, to: r.to },
      {
        onSuccess: (inv) => {
          reset();
          setOpenId(inv.id);
          setToast(t('bill.toast.drafted', { n: inv.deliveryOrderCount }));
        },
        onError: (e) => setToast(problemText(e, t) ?? t('bill.createFail')),
      },
    );
  };
  /** พิมพ์ตัวอย่าง = PDF จาก DO ที่ติ๊ก — ไม่บันทึกอะไร (review M2) */
  const preview = () => {
    if (!chosen.length) {
      setToast(t('bill.pickFirst'));
      return;
    }
    setBusy(true);
    void previewDraft({ customerId: cust, rows: chosen, from: r.from, to: r.to })
      .catch((e) => setToast(problemText(e, t) ?? t('bill.pdfFail')))
      .finally(() => setBusy(false));
  };
  /** ร่าง = PDF ตัวอย่าง · ใบที่ออกแล้ว = ไฟล์ต้นฉบับที่เก็บ · ยกเลิก = ไม่มี */
  const printOne = (x: InvoiceSummary) =>
    void (
      x.status === 'DRAFT' ? openProforma(x.id) : openIssuedPdf(x.id, `${x.invoiceNo}.pdf`)
    ).catch(() => setToast(t('bill.pdfFail')));
  const printable = (x: InvoiceSummary) => !['CANCELLED', 'VOIDED'].includes(x.status);
  const printMany = (ids: string[]) => {
    const docs = shownRowsQ.filter((x) => ids.includes(x.id) && printable(x));
    if (!docs.length) setToast(t('bill.pdfDraftOnly'));
    for (const x of docs) printOne(x);
  };

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (tab !== 'all' && tab !== 'OVERDUE') f.status = tab;
    return f;
  }, [tab]);
  const list = useInvoiceList(filters);
  // ST5-T11 ใบวางบิล: ตัวกรองประเภท "ใบวางบิล" สลับตารางเป็นรายการใบวางบิล (แท็บเดียวกัน — BN_STATUS)
  const bnFilters = useMemo(() => {
    const f: Record<string, string> = {};
    if (tab !== 'all' && BN_STATUS[tab]) f.status = BN_STATUS[tab]!;
    return f;
  }, [tab]);
  const bnList = useBillingNoteList(bnFilters, isBn);
  const bnCounts = useBillingNoteCounts().data;
  // เกินกำหนด: ยังไม่มีใบที่ออกแล้ว/ครบกำหนด (ST5-T09/T22) — แท็บว่าง
  const shownRows = isBn || tab === 'OVERDUE' ? [] : list.rows;
  const shownRowsQ = col.q
    ? shownRows.filter((x) => (x.invoiceNo ?? t('bill.draftNo')).includes(col.q))
    : shownRows;
  const bnRows = !isBn || (tab !== 'all' && !BN_STATUS[tab]) ? [] : bnList.rows;
  const bnRowsQ = col.q
    ? bnRows.filter((x) => (x.billingNoteNo ?? t('bill.draftNo')).includes(col.q))
    : bnRows;
  const tabCount: Record<Tab, number | undefined> = isBn
    ? {
        all: bnCounts?.total,
        DRAFT: bnCounts?.draft,
        ISSUED: bnCounts?.issued,
        PARTIALLY_PAID: bnCounts ? 0 : undefined,
        PAID: bnCounts?.collected,
        OVERDUE: bnCounts ? 0 : undefined,
        CANCELLED: bnCounts?.cancelled,
      }
    : {
        all: counts?.total,
        DRAFT: counts?.draft,
        ISSUED: counts?.issued,
        PARTIALLY_PAID: counts?.partiallyPaid,
        PAID: counts?.paid,
        OVERDUE: counts?.overdue,
        CANCELLED: counts?.cancelled,
      };
  const shownTotal = listTotal(
    isBn ? bnList : list,
    { tab, ...col },
    ['tab', 'type'],
    col.q ? undefined : tabCount[tab],
  );
  const typeFilter = {
    type: 'select' as const,
    // ต้นแบบ: ทั้งหมด · ใบแจ้งหนี้ · ใบลดหนี้ · ใบเพิ่มหนี้ — ใบลด/เพิ่มหนี้ไม่ทำ (D-54) · ใบวางบิล (ST5-T11) เป็นรายการแยก
    // จึงเป็นตัวเลือกประเภทเอกสารของตาราง (ไม่มี "ทั้งหมด") [DECISION spec/12 §3 — ST5-T11]
    options: [
      { value: '', label: t('bill.type.inv') },
      { value: 'BN', label: t('bn.kind') },
    ],
  };
  const chip = (label: string) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 24,
        padding: '0 8px',
        borderRadius: 999,
        background: '#EBEDE8',
        fontSize: 12.5,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );

  const columns: Column<InvoiceSummary>[] = [
    {
      key: 'q',
      label: t('bill.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) =>
        x.invoiceNo ? (
          <DocNo>{x.invoiceNo}</DocNo>
        ) : (
          <span style={{ color: '#59606B' }}>{t('bill.draftNo')}</span>
        ),
      csv: (x) => x.invoiceNo ?? '',
    },
    {
      key: 'type',
      label: t('bill.col.type'),
      width: '1%',
      filter: typeFilter,
      render: () => chip(t('bill.type.inv')),
      csv: () => t('bill.type.inv'),
    },
    {
      key: 'cust',
      label: t('bill.col.cust'),
      render: (x) => <span style={{ color: '#101418' }}>{x.customer.legalName}</span>,
      csv: (x) => x.customer.legalName,
    },
    {
      key: 'per',
      label: t('bill.col.per'),
      render: (x) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {x.periodFrom && x.periodTo ? `${dateText(x.periodFrom)} – ${dateText(x.periodTo)}` : '—'}
        </span>
      ),
      csv: (x) => `${x.periodFrom ?? ''}–${x.periodTo ?? ''}`,
    },
    {
      key: 'due',
      label: t('bill.col.due'),
      width: '1%',
      // วันครบกำหนด (ใบที่ออกแล้ว — ST5-T09) · เกินกำหนด (สีแดง + "เกิน n วัน") = ST5-T22
      render: (x) =>
        x.dueDate ? (
          <span style={{ whiteSpace: 'nowrap' }}>{dateText(x.dueDate)}</span>
        ) : (
          <span style={{ color: '#3B424C' }}>—</span>
        ),
      csv: (x) => x.dueDate ?? '',
    },
    {
      key: 'amt',
      label: t('bill.col.amt'),
      align: 'right',
      width: '1%',
      render: (x) => (
        <span className="tms-num" style={{ fontWeight: 500 }}>
          {money(x.sellTotal)}
        </span>
      ),
      csv: (x) => x.sellTotal ?? '',
    },
    {
      key: 'out',
      label: t('bill.col.out'),
      align: 'right',
      width: '1%',
      // ร่าง/ยกเลิก = ไม่มียอดค้าง (ต้นแบบ closed → 0) · ใบที่ออกแล้ว: ยอดรวม − รับชำระแล้ว (ST5-T13)
      render: (x) => (
        <span className="tms-num" style={{ color: '#3B424C' }}>
          {money(x.sellOutstanding)}
        </span>
      ),
      csv: (x) => x.sellOutstanding ?? '',
    },
    {
      key: 'st',
      label: t('bill.col.st'),
      width: '1%',
      render: (x) => <StatusDot label={invoiceStatusLabel(t, x.status)} />,
      csv: (x) => invoiceStatusLabel(t, x.status),
    },
  ];

  /** ใบวางบิลในตารางเดียวกัน (คอลัมน์ต้นแบบ specInv): งวด / อ้างอิง = จำนวนใบแจ้งหนี้ · ครบกำหนด = วันนัดรับเช็ค/โอน · คงค้าง = ยอดของใบที่ออกแล้ว */
  const bnColumns: Column<BillingNoteSummary>[] = [
    {
      key: 'q',
      label: t('bill.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) =>
        x.billingNoteNo ? (
          <DocNo>{x.billingNoteNo}</DocNo>
        ) : (
          <span style={{ color: '#59606B' }}>{t('bill.draftNo')}</span>
        ),
      csv: (x) => x.billingNoteNo ?? '',
    },
    {
      key: 'type',
      label: t('bill.col.type'),
      width: '1%',
      filter: typeFilter,
      render: () => chip(t('bn.kind')),
      csv: () => t('bn.kind'),
    },
    {
      key: 'cust',
      label: t('bill.col.cust'),
      render: (x) => <span style={{ color: '#101418' }}>{x.customer.legalName}</span>,
      csv: (x) => x.customer.legalName,
    },
    {
      key: 'per',
      label: t('bill.col.per'),
      render: (x) => (
        <span style={{ whiteSpace: 'nowrap' }}>{t('bn.kv.nInv', { n: x.invoiceCount })}</span>
      ),
      csv: (x) => String(x.invoiceCount),
    },
    {
      key: 'due',
      label: t('bill.col.due'),
      width: '1%',
      render: (x) =>
        x.collectionDate && x.status !== 'CANCELLED' ? (
          <span style={{ whiteSpace: 'nowrap' }} title={t('bn.kv.collect')}>
            {dateText(x.collectionDate)}
          </span>
        ) : (
          <span style={{ color: '#3B424C' }}>—</span>
        ),
      csv: (x) => x.collectionDate ?? '',
    },
    {
      key: 'amt',
      label: t('bill.col.amt'),
      align: 'right',
      width: '1%',
      render: (x) => (
        <span className="tms-num" style={{ fontWeight: 500 }}>
          {money(x.sellTotal)}
        </span>
      ),
      csv: (x) => x.sellTotal ?? '',
    },
    {
      key: 'out',
      label: t('bill.col.out'),
      align: 'right',
      width: '1%',
      render: (x) => (
        <span className="tms-num" style={{ color: x.status === 'ISSUED' ? '#101418' : '#3B424C' }}>
          {x.status === 'ISSUED' ? money(x.sellTotal) : '0.00'}
        </span>
      ),
      csv: () => '',
    },
    {
      key: 'st',
      label: t('bill.col.st'),
      width: '1%',
      render: (x) => <StatusDot label={billingNoteStatusLabel(t, x.status)} />,
      csv: (x) => billingNoteStatusLabel(t, x.status),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('page.bill.title')}
        sub={t('page.bill.sub')}
        actions={
          // ส่งออกให้นักบัญชี (spec/05 §14) — ต้องมีใบที่ออกแล้ว (ST5-T09) จึงยังปิด [DECISION spec/12 §3]
          <Button variant="secondary" icon="file-down" disabled title={t('bill.xpSoon')}>
            {t('bill.xp')}
          </Button>
        }
      />
      <div className="tms-kpis">
        <KpiCard
          label={t('bill.kpi.ready')}
          tone="warn"
          value={custQ.data ? customers.reduce((a, c) => a + c.deliveryOrderCount, 0) : '—'}
          sub={t('bill.kpi.asOf', { d: dateText(today) })}
        />
        <KpiCard
          label={t('bill.kpi.drafts')}
          value={counts?.draft ?? '—'}
          sub={t('bill.kpi.click')}
          active={tab === 'DRAFT'}
          onClick={() => setTab(tab === 'DRAFT' ? 'all' : 'DRAFT')}
        />
        {/* เกินกำหนด / ยอดค้าง: ต้องมีใบที่ออกแล้ว + รับชำระ (ST5-T09/T22) — ยังไม่มีข้อมูล */}
        <KpiCard
          label={t('bill.kpi.overdue')}
          tone="err"
          value="—"
          sub={t('bill.kpi.click')}
          active={tab === 'OVERDUE'}
          onClick={() => setTab(tab === 'OVERDUE' ? 'all' : 'OVERDUE')}
        />
        <KpiCard label={t('bill.kpi.outstanding')} value="—" sub={t('bill.kpi.click')} />
      </div>

      <div style={card} data-testid="bill-create">
        <div
          style={{
            padding: '16px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            borderBottom: '1px solid #E4E6E0',
            flexWrap: 'wrap',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('bill.title')}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {STEPS.map((k, i) => {
              const n = i + 1;
              const done = n < step;
              const cur = n === step;
              return (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      border: `1.5px solid ${done || cur ? '#2257C4' : '#C9CDC3'}`,
                      background: done ? '#2257C4' : '#FFFFFF',
                      color: done ? '#FFFFFF' : cur ? '#2257C4' : '#3B424C',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {done ? <Icon n="check" s={14} /> : n}
                  </span>
                  <span
                    style={{
                      color: done || cur ? '#101418' : '#3B424C',
                      fontWeight: cur ? 600 : 500,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t(k)}
                  </span>
                  {n < 4 && (
                    <span
                      style={{
                        width: 28,
                        height: 2,
                        background: n < step ? '#2257C4' : '#D9DCD4',
                        borderRadius: 1,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div
          style={{
            padding: '16px 20px',
            display: 'flex',
            gap: 16,
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 300 }}>
            <span style={lbl}>{t('bill.f.cust')}</span>
            <select
              value={cust}
              onChange={(e) => {
                setCust(e.target.value);
                reset();
              }}
              style={sel}
            >
              {!customers.length && <option value="">{t('bill.noCust')}</option>}
              {customers.map((c) => (
                <option key={c.customerId} value={c.customerId}>
                  {c.customerName}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 240 }}>
            <span style={lbl}>{t('bill.f.range')}</span>
            <select
              value={String(range)}
              onChange={(e) => {
                setRange(Number(e.target.value));
                reset();
              }}
              style={sel}
            >
              {ranges.map((x, i) => (
                <option key={i} value={String(i)}>
                  {i === 2 ? t('bill.range.7d') : `${dateText(x.from)} – ${dateText(x.to)}`}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={lbl}>{t('bill.f.code')}</span>
            <span style={{ height: 36, display: 'flex', alignItems: 'center', ...num }}>
              {customers.find((c) => c.customerId === cust)?.customerCode ?? '—'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={lbl}>{t('bill.f.docs')}</span>
            <div style={{ height: 36, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 28,
                  padding: '0 10px',
                  borderRadius: 999,
                  background: '#E9F0FA',
                  color: '#2257C4',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon n="file-text" s={14} />
                {t('bill.type.inv')}
              </span>
            </div>
          </div>
        </div>
        {terms.data && (
          <div
            style={{
              padding: '0 20px 14px',
              color: '#3B424C',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon n="info" s={16} style={{ color: '#59606B' }} />
            {t('bill.cond', {
              vat: t(allVat ? 'bill.vat.all' : 'bill.vat.split'),
              n: terms.data.creditTermDays,
            })}
          </div>
        )}
        <table
          style={{
            width: '100%',
            borderCollapse: 'separate',
            borderSpacing: 0,
            borderTop: '1px solid #D9DCD4',
          }}
        >
          <thead>
            <tr>
              <th style={{ ...th, width: 44, padding: '0 0 0 20px' }}>
                <input
                  type="checkbox"
                  aria-label={t('bill.pickAll')}
                  checked={rows.length > 0 && rows.every((x) => picked.includes(x.id))}
                  onChange={() =>
                    setPicked(rows.every((x) => picked.includes(x.id)) ? [] : rows.map((x) => x.id))
                  }
                  style={{
                    width: 16,
                    height: 16,
                    accentColor: '#2257C4',
                    margin: 0,
                    cursor: 'pointer',
                  }}
                />
              </th>
              <th style={th}>{t('bill.c.no')}</th>
              <th style={th}>{t('bill.c.date')}</th>
              <th style={th}>{t('bill.c.route')}</th>
              <th style={th}>{t('bill.c.goods')}</th>
              <th style={{ ...th, textAlign: 'right' }}>{t('bill.c.qty')}</th>
              <th style={{ ...th, textAlign: 'right' }}>{t('bill.c.price')}</th>
              <th style={{ ...th, textAlign: 'right' }}>{t('bill.c.svc')}</th>
              <th style={{ ...th, textAlign: 'right' }}>{t('bill.c.amt')}</th>
              <th style={{ ...th, padding: '0 20px 0 12px', whiteSpace: undefined }}>
                {t('bill.c.st')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <QueueTr
                key={x.id}
                x={x}
                on={picked.includes(x.id)}
                dateText={dateText}
                badge={t('bill.badge.sent')}
                onToggle={() =>
                  setPicked((p) => (p.includes(x.id) ? p.filter((y) => y !== x.id) : [...p, x.id]))
                }
              />
            ))}
          </tbody>
        </table>
        {!queue.isLoading && rows.length === 0 && (
          <div
            style={{
              padding: '40px 24px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              textAlign: 'center',
            }}
          >
            <Icon n="package-open" s={40} style={{ color: '#C9CDC3' }} />
            <div style={{ fontSize: 16, fontWeight: 600 }}>{t('bill.empty.title')}</div>
            <div style={{ color: '#3B424C' }}>{t('bill.empty.desc')}</div>
          </div>
        )}
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 4,
            background: '#FFFFFF',
            borderTop: '1px solid #D9DCD4',
            borderRadius: '0 0 10px 10px',
            padding: '12px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            flexWrap: 'wrap',
            boxShadow: '0 -4px 12px rgba(16,24,40,.05)',
          }}
        >
          <span style={{ color: '#3B424C' }}>
            {t('bill.picked.a')}{' '}
            <b style={{ fontVariantNumeric: 'tabular-nums' }}>{chosen.length}</b>{' '}
            {t('bill.picked.b', { n: rows.length })}
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 20, marginLeft: 'auto' }}>
            <Sum label={t(allVat ? 'bill.sum.fr' : 'bill.sum.frEx')} v={money(totals.freight)} />
            <Sum label={t('bill.sum.svc')} v={money(totals.service)} />
            <Sum label={t(allVat ? 'bill.vat.all' : 'bill.sum.vatSvc')} v={money(totals.vat)} />
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={lbl}>{t('bill.sum.net')}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 16, fontWeight: 600 }}>
                {t('ord.baht', { n: money(totals.net) })}
              </span>
            </span>
          </div>
          {canDraft && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="ghost" icon="printer" onClick={preview} disabled={busy}>
                {t('bill.print')}
              </Button>
              <Button
                variant="primary"
                icon="lock"
                onClick={create1}
                disabled={!chosen.length || create.isPending}
              >
                {t('bill.create')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ต้นแบบ: "ใบแจ้งหนี้ ใบลดหนี้ และใบเพิ่มหนี้" — ใบลด/เพิ่มหนี้ไม่ทำในเฟส 0 (D-54) */}
      <h2 style={{ margin: '28px 0 0', fontSize: 15, fontWeight: 600 }}>{t('bill.listTitle')}</h2>
      <div className="tms-listbody" style={{ marginTop: 12 }}>
        <StatusTabs
          value={tab}
          onChange={(k) => setTab(k as Tab)}
          items={TABS.map((k) => ({
            key: k,
            label: k === 'all' ? t('table.all') : invoiceStatusLabel(t, k),
            ...(tabCount[k] !== undefined ? { count: tabCount[k]! } : {}),
          }))}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <SavedViewMenu b={views} onToast={setToast} />
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {isBn ? (
          bnList.q.isError ? (
            <EmptyState
              icon="circle-alert"
              title={t('bn.loadError')}
              description={problemText(bnList.q.error, t) ?? ''}
              action={
                <Button variant="secondary" icon="refresh-cw" onClick={() => bnList.q.refetch()}>
                  {t('cust.retry')}
                </Button>
              }
            />
          ) : (
            <DataTable
              key="bn"
              columns={bnColumns}
              rows={bnRowsQ}
              rowId={(x) => x.id}
              activeId={openBn}
              loading={bnList.loading}
              labels={tableLabels(t)}
              bulkActions={[
                {
                  label: t('bill.menu.pdf'),
                  icon: 'printer',
                  run: (ids) => {
                    const docs = bnRowsQ.filter(
                      (x) => ids.includes(x.id) && x.status !== 'CANCELLED',
                    );
                    if (!docs.length) setToast(t('bill.pdfDraftOnly'));
                    for (const x of docs)
                      void openBillingNotePdf(x).catch(() => setToast(t('bill.pdfFail')));
                  },
                },
              ]}
              filters={{ q: col.q, type: col.type }}
              hiddenColumns={hidden}
              onHiddenColumnsChange={setHidden}
              onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
              onRowClick={(x) => setOpenBn(x.id)}
              rowMenu={(x) => [
                { label: t('bill.menu.view'), icon: 'eye', run: () => setOpenBn(x.id) },
                ...(x.status === 'DRAFT' && canFinalize
                  ? [{ label: t('bill.create'), icon: 'lock', run: () => issueBn(x) }]
                  : []),
                ...(x.status !== 'CANCELLED'
                  ? [
                      {
                        label: t('bill.menu.pdf'),
                        icon: 'printer',
                        run: () =>
                          void openBillingNotePdf(x).catch(() => setToast(t('bill.pdfFail'))),
                      },
                    ]
                  : []),
              ]}
              empty={
                <EmptyState
                  icon="receipt"
                  title={t('bn.list.emptyTitle')}
                  description={t('bn.list.emptyDesc')}
                />
              }
              page={{
                ...bnList.page,
                ...(shownTotal !== undefined ? { total: shownTotal } : {}),
              }}
              onPageSize={bnList.setSize}
              onNext={bnList.next}
              onPrev={bnList.prev}
              onGoto={bnList.goto}
            />
          )
        ) : list.q.isError ? (
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
            key="inv"
            columns={columns}
            rows={shownRowsQ}
            rowId={(x) => x.id}
            activeId={openId}
            loading={list.loading}
            labels={tableLabels(t)}
            bulkActions={[
              ...(canDraft
                ? [
                    {
                      label: t('bill.title'),
                      icon: 'receipt',
                      run: (ids: string[]) => startBn(shownRowsQ.filter((x) => ids.includes(x.id))),
                    },
                  ]
                : []),
              { label: t('bill.menu.pdf'), icon: 'printer', run: printMany },
              { label: t('bill.xp'), icon: 'file-down', run: () => setToast(t('bill.xpSoon')) },
            ]}
            filters={{ q: col.q, type: col.type }}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(x) => setOpenId(x.id)}
            rowMenu={(x) => [
              { label: t('bill.menu.view'), icon: 'eye', run: () => setOpenId(x.id) },
              ...(x.status === 'DRAFT' && canFinalize
                ? [{ label: t('bill.create'), icon: 'lock', run: () => issue(x) }]
                : []),
              ...(x.status === 'ISSUED' && canDraft
                ? [{ label: t('bill.title'), icon: 'receipt', run: () => startBn([x]) }]
                : []),
              ...(printable(x)
                ? [{ label: t('bill.menu.pdf'), icon: 'printer', run: () => printOne(x) }]
                : []),
            ]}
            empty={
              <EmptyState
                icon="receipt"
                title={t('bill.list.emptyTitle')}
                description={t('bill.list.emptyDesc')}
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
      {openId && (
        <InvoiceDrawer
          id={openId}
          canDraft={canDraft}
          canFinalize={canFinalize}
          canRecord={canRecord}
          onPay={() => {
            setPayId(openId);
            setOpenId(null);
          }}
          onClose={() => setOpenId(null)}
          onToast={setToast}
        />
      )}
      {payId && (
        <PayDrawer
          id={payId}
          canRecord={canRecord}
          canReverse={canReverse}
          onClose={() => setPayId(null)}
          onOpenInvoice={() => {
            setOpenId(payId);
            setPayId(null);
          }}
          onToast={setToast}
        />
      )}
      {openBn && (
        <BillingNoteDrawer
          id={openBn}
          canDraft={canDraft}
          canFinalize={canFinalize}
          onClose={() => setOpenBn(null)}
          onToast={setToast}
        />
      )}
      {bnForm && (
        <BillingNoteForm
          {...bnForm}
          onClose={() => setBnForm(null)}
          onSaved={(bn) => {
            setBnForm(null);
            setCol((c) => ({ ...c, type: 'BN', q: '' }));
            setOpenBn(bn.id);
            setToast(t('bn.toast.drafted', { n: bn.invoiceCount }));
          }}
        />
      )}
      {toast && (
        <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
      )}
    </>
  );
}

function Sum({ label, v }: { label: string; v: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={lbl}>{label}</span>
      <span style={num}>{v}</span>
    </span>
  );
}

function QueueTr({
  x,
  on,
  onToggle,
  dateText,
  badge,
}: {
  x: QueueRow;
  on: boolean;
  onToggle: () => void;
  dateText: (iso: string) => string;
  /** ต้นแบบ: DO ที่วางบิลได้ = ป้าย "ส่งแล้ว" */
  badge: string;
}) {
  const b = statusOf(badge);
  return (
    <tr
      onClick={onToggle}
      className="tms-bill-row"
      style={{ background: on ? '#E9F0FA' : '#FFFFFF', cursor: 'pointer' }}
    >
      <td style={{ height: 52, padding: '0 0 0 20px', borderBottom: '1px solid #E4E6E0' }}>
        <input
          type="checkbox"
          checked={on}
          readOnly
          aria-label={x.doNo}
          style={{
            width: 16,
            height: 16,
            accentColor: '#2257C4',
            margin: 0,
            pointerEvents: 'none',
          }}
        />
      </td>
      <td style={{ ...td, ...num, fontWeight: 500, color: '#2257C4' }}>{x.doNo}</td>
      <td style={td}>{dateText(x.doDate)}</td>
      <td style={{ ...td, whiteSpace: undefined }}>
        <span className="tms-route-cell" title={`${x.originSiteName} → ${x.destSiteName}`}>
          <RouteChip
            from={
              <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                {x.originSiteName}
              </span>
            }
            to={
              <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                {x.destSiteName}
              </span>
            }
          />
        </span>
      </td>
      <td style={td}>
        <span className="tms-ellipsis" style={{ maxWidth: 140 }} title={x.goods ?? ''}>
          {x.goods ?? '—'}
        </span>
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        {x.freightQty ? `${x.freightQty} ${x.freightUnit ?? ''}`.trim() : '—'}
      </td>
      <td style={{ ...td, ...num, textAlign: 'right' }}>
        {x.sellFreightUnitPrice ? money(x.sellFreightUnitPrice) : '—'}
      </td>
      <td style={{ ...td, ...num, textAlign: 'right' }}>
        {x.sellServiceAmount && x.sellServiceAmount !== '0.00' ? money(x.sellServiceAmount) : '—'}
      </td>
      <td style={{ ...td, ...num, textAlign: 'right', fontWeight: 500 }}>{money(x.sellTotal)}</td>
      <td style={{ padding: '0 20px 0 12px', borderBottom: '1px solid #E4E6E0' }}>
        <Badge label={badge} tone={b.tone} icon={b.icon} />
      </td>
    </tr>
  );
}
