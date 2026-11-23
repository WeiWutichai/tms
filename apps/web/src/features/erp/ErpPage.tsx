import {
  Button,
  DataTable,
  DocNo,
  EmptyState,
  StatusDot,
  StatusTabs,
  SummaryStrip,
  Tag,
  Toast,
  type Column,
} from '@tms/ui';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { useDeepOpen } from '../../shell/deepLink';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { useSessionState, useUrlSeed } from '../master/useCursorList';
import { adapterName } from '../settings/ConnectorSettings';
import { SavedViewMenu } from '../views/SavedViewMenu';
import { pick, useSavedViews } from '../views/useSavedViews';
import { CloseDialog, type DialogKind } from './ErpDialogs';
import { ErpDrawer } from './ErpDrawer';
import { bySeverity, diffFields, rowStatus, statusKey, TAB_QUERY, TABS, type Tab } from './erpq';
import { type ReconcileResult, useReconcileCounts, useReconcileList } from './useReconcile';

const EMPTY_COL = { no: '', type: '', cust: '', fields: '', st: '' };
const ST_OPTS = ['mm', 'resend', 'appr', 'closed'] as const;

/**
 * บัญชี → คิวเชื่อมระบบบัญชี — ส่วน "ไม่ตรง" (ST8-T12; ต้นแบบ TMS v4 หน้า `erp` = kpis('erp') + specErp + vPanel kind `erp` + askFix)
 * รายการ = ผลเทียบเนื้อหาเอกสาร (ST8-T11 `GET /reconcile-results?check=DOCUMENT&actionable=true`) เรียงตาม severity (MONEY ก่อน)
 * ปิดได้ 3 ทาง (docs/01 §6.5): รับค่า {ERP} → ยอมรับความต่าง / แก้ที่ TMS แล้ว (D-54 ยกเลิก+ออกใหม่) · ใช้ค่า TMS ส่งซ้ำ (ส่งตรง —
 * ลงบัญชีแล้ว/อายุเกินต้องอนุมัติตามประตูของ ST8-T13) · ขออนุมัติแก้ → ผู้อนุมัติ (≠ ผู้ขอ) อนุมัติด้วยปุ่ม "ใช้ค่า TMS ส่งซ้ำ" ของรายการรออนุมัติ
 * ความต่างจากต้นแบบ [DECISION spec/12 §3 แถว ST8-T12 — PO #86 ยังค้าง]: แท็บ "รอส่งซ้ำ" / "ถูกปฏิเสธ", การ์ด "รอส่งซ้ำ" / "ส่งไม่สำเร็จ" /
 * "สำเร็จ 24 ชม." และปุ่ม "ส่งซ้ำทั้งหมดที่รอ" / bulk = คิวส่งไม่สำเร็จ (ST7-T19) ยังไม่แสดง · ประเภทมีเฉพาะใบแจ้งหนี้ (เทียบเฉพาะใบแจ้งหนี้ — #87)
 */
export function ErpPage() {
  const { t, lang } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canAct = can(scopes, 'integrations:retry');
  const canApprove = can(scopes, 'credit-notes:approve');
  const [params, setParams] = useSearchParams();
  // ลิงก์จากแจ้งเตือน/การ์ด (`/erp?tab=mm`) — เขียนแท็บลง session ก่อนอ่าน แล้วลบออกจาก URL
  useUrlSeed(params, ['tab'], (p) => {
    const k = p.get('tab') ?? '';
    return { 'erp.tab': TABS.includes(k as Tab) ? k : 'all', 'erp.cols': EMPTY_COL };
  });
  useEffect(() => {
    if (params.has('tab')) {
      const next = new URLSearchParams(params);
      next.delete('tab');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ครั้งเดียวตอนเปิดหน้า
  }, []);
  const [tab, setTab] = useSessionState<Tab>('erp.tab', 'all');
  const [col, setCol] = useSessionState('erp.cols', EMPTY_COL);
  const [hidden, setHidden] = useSessionState<string[] | null>('erp.hidden', null);
  // มุมมองที่บันทึกไว้ (ต้นแบบ "มุมมอง: ของฉันวันนี้" — แบบหน้า settle): แท็บ + ตัวกรองคอลัมน์ + คอลัมน์ที่ซ่อน
  const views = useSavedViews({
    page: 'erp',
    state: { tab, ...col },
    hidden,
    empty: { tab: 'all', ...EMPTY_COL },
    apply: (v) => {
      const x = pick(v.state, { tab: 'all', ...EMPTY_COL });
      setTab(TABS.includes(x.tab as Tab) ? (x.tab as Tab) : 'all');
      setCol({ no: x.no, type: x.type, cust: x.cust, fields: x.fields, st: x.st });
      setHidden(v.hidden);
    },
  });
  const [open, setOpen] = useState<string | null>(null);
  const [ptab, setPtab] = useState('sum');
  const [dialog, setDialog] = useState<{ kind: DialogKind; x: ReconcileResult } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useDeepOpen('open', 'rec', (id) => {
    setPtab('sum');
    setOpen(id);
  });
  const curTab = TABS.includes(tab) ? tab : 'all';
  const list = useReconcileList(TAB_QUERY[curTab]);
  const countQ = useReconcileCounts();
  const allRows = countQ.data?.data ?? [];
  const openRows = allRows.filter((x) => x.status === 'OPEN');
  const more = countQ.data?.hasMore ?? false;
  const cnt = (n: number) => (more ? `${n}+` : n);
  // แถบสรุป "ไม่ตรง" = สถานะไม่ตรง · แท็บนับตามตัวกรองของแท็บ (TAB_QUERY) · "ทั้งหมด" = ทุกรายการ (ต้นแบบมีตัวนับทุกแท็บ)
  const kpiMm = openRows.filter((x) => rowStatus(x) === 'mm').length;
  const counts: Record<Tab, number> = {
    all: allRows.length,
    mm: openRows.filter((x) => x.overwrite?.status !== 'REQUESTED').length,
    appr: openRows.filter((x) => x.overwrite?.status === 'REQUESTED').length,
  };
  const erpName = (x: ReconcileResult) =>
    adapterName(t, x.connector.adapterKey, x.connector.displayName);
  const anyRow = list.rows[0] ?? allRows[0];
  const pageErp = anyRow ? erpName(anyRow) : t('erpq.erpDefault');
  const shown = list.rows
    .filter(
      (x) =>
        (!col.no || (x.localNumber ?? '').includes(col.no)) &&
        (!col.type || x.entityType === col.type) &&
        (!col.cust || (x.customer?.name ?? '').includes(col.cust)) &&
        (!col.fields || diffFields(t, x, erpName(x)).includes(col.fields)) &&
        (!col.st || rowStatus(x) === col.st),
    )
    .sort(bySeverity);
  const view = (x: ReconcileResult, p = 'sum') => {
    setPtab(p);
    setOpen(x.id);
  };
  const pickTab = (k: Tab) => setTab(curTab === k ? 'all' : k);
  const ask = (kind: DialogKind, x: ReconcileResult) => setDialog({ kind, x });
  // "ใช้ค่า TMS ส่งซ้ำ" = ส่งซ้ำตรง (ไม่ตรง · integrations:retry) หรือผู้อนุมัติอนุมัติคำขอ "ขออนุมัติแก้" ของผู้อื่น (รออนุมัติ)
  const useTmsKind = (x: ReconcileResult): DialogKind | null => {
    const st = rowStatus(x);
    if (st === 'mm' && canAct) return 'useTms';
    if (st === 'appr' && canApprove && !x.overwrite?.requestedByMe) return 'approve';
    return null;
  };

  const columns: Column<ReconcileResult>[] = [
    {
      key: 'no',
      label: t('erpq.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <DocNo>{x.localNumber ?? '—'}</DocNo>,
      csv: (x) => x.localNumber ?? '',
    },
    {
      key: 'type',
      label: t('erpq.col.type'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'INVOICE', label: t('erpq.type.INVOICE') },
        ],
      },
      render: (x) => <Tag>{t(`erpq.type.${x.entityType}` as MessageKey)}</Tag>,
      csv: (x) => t(`erpq.type.${x.entityType}` as MessageKey),
    },
    {
      key: 'cust',
      label: t('erpq.col.cust'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <span style={{ color: '#101418' }}>{x.customer?.name ?? '—'}</span>,
      csv: (x) => x.customer?.name ?? '',
    },
    {
      key: 'fields',
      label: t('erpq.col.fields'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <span style={{ color: '#101418' }}>{diffFields(t, x, erpName(x))}</span>,
      csv: (x) => diffFields(t, x, erpName(x)),
    },
    {
      key: 'att',
      label: t('erpq.col.att'),
      align: 'right',
      width: '1%',
      render: (x) => <span className="tms-num">{x.sends?.count ?? 0}</span>,
      csv: (x) => String(x.sends?.count ?? 0),
    },
    {
      key: 'last',
      label: t('erpq.col.last'),
      width: '1%',
      render: (x) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {x.sends?.lastSentAt ? formatDateTime(x.sends.lastSentAt, lang) : '—'}
        </span>
      ),
      csv: (x) => (x.sends?.lastSentAt ? formatDateTime(x.sends.lastSentAt, lang) : ''),
    },
    {
      key: 'st',
      label: t('erpq.col.st'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...ST_OPTS.map((v) => ({ value: v, label: t(statusKey(v)) })),
        ],
      },
      render: (x) => <StatusDot label={t(statusKey(rowStatus(x)))} />,
      csv: (x) => t(statusKey(rowStatus(x))),
    },
  ];

  return (
    <>
      <PageHeader title={t('page.erp.title')} sub={t('page.erp.sub', { erp: pageErp })} />
      {/* ต้นแบบ kpis('erp') บนหน้านี้ = แถบสรุปบรรทัดเดียว (hasBar) — เฉพาะ "ไม่ตรง" (การ์ดคิวส่งไม่สำเร็จรอ PO #86) */}
      <SummaryStrip
        items={[
          {
            value: countQ.data ? cnt(kpiMm) : '—',
            label: t('erpq.kpi.mm'),
            color: '#B3322A',
            onClick: () => pickTab('mm'),
            pressed: curTab === 'mm',
          },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={curTab}
          onChange={(k) => setTab(k as Tab)}
          items={TABS.map((k) => ({
            key: k,
            label: t(`erpq.tab.${k}` as MessageKey),
            ...(countQ.data ? { count: counts[k] } : {}),
          }))}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <SavedViewMenu b={views} onToast={setToast} />
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {list.page.total !== undefined && t('table.total', { n: list.page.total })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('erpq.loadError')}
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
            activeId={open}
            loading={list.loading}
            labels={tableLabels(t)}
            filters={col}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(x) => view(x)}
            rowMenu={(x) => [
              { label: t('erpq.menu.view'), icon: 'eye', run: () => view(x) },
              ...(useTmsKind(x)
                ? [
                    {
                      label: t('erpq.menu.useTms'),
                      icon: 'refresh-cw',
                      run: () => ask(useTmsKind(x)!, x),
                    },
                  ]
                : []),
              ...(canAct && rowStatus(x) === 'mm'
                ? [
                    {
                      label: t('erpq.menu.accept', { erp: erpName(x) }),
                      icon: 'download',
                      run: () => ask('accept', x),
                    },
                  ]
                : []),
              { label: t('erpq.menu.log'), icon: 'history', run: () => view(x, 'log') },
            ]}
            empty={
              <EmptyState
                icon="inbox"
                title={t('table.emptyTitle')}
                description={t('table.emptyDesc')}
              />
            }
            page={list.page}
            onPageSize={list.setSize}
            onNext={list.next}
            onPrev={list.prev}
            onGoto={list.goto}
          />
        )}
      </div>
      {open && (
        <ErpDrawer
          id={open}
          tab={ptab}
          onTab={setPtab}
          erpName={erpName}
          can={{ act: canAct, approve: canApprove }}
          onClose={() => setOpen(null)}
          onAccept={(x) => ask('accept', x)}
          onAskFix={(x) => ask('askFix', x)}
          onUseTms={(x) => {
            const k = useTmsKind(x);
            if (k) ask(k, x);
          }}
        />
      )}
      {dialog && (
        <CloseDialog
          kind={dialog.kind}
          x={dialog.x}
          erp={erpName(dialog.x)}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setToast(msg);
          }}
        />
      )}
      {toast && (
        <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
      )}
    </>
  );
}
