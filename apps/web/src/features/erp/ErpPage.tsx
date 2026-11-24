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
import { useConnectorMetrics } from '../dashboard/ConnectorDash';
import { CloseDialog, type DialogKind } from './ErpDialogs';
import { ErpDrawer } from './ErpDrawer';
import {
  asTab,
  bySeverity,
  DEFAULT_TAB,
  diffFields,
  isQueueTab,
  rowStatus,
  statusKey,
  TAB_QUERY,
  TABS,
  type Tab,
} from './erpq';
import { QueuePanel } from './QueuePanel';
import { queueErrorText } from './queue';
import { useQueueSummary, useRetryAll } from './useQueue';
import { type ReconcileResult, useReconcileCounts, useReconcileList } from './useReconcile';

const EMPTY_COL = { no: '', type: '', cust: '', fields: '', st: '' };
const ST_OPTS = ['mm', 'resend', 'appr', 'closed'] as const;

/**
 * บัญชี → คิวเชื่อมระบบบัญชี (ต้นแบบ TMS v4 หน้า `erp` = kpis('erp') + specErp + vPanel kind `erp` + askFix + actions.erp)
 * **PO #86 ตัดสิน 24 พ.ย. 2569 ทางเลือก (ก):** หน้าตาตามต้นแบบ แต่แท็บตาม docs/04 G3 + docs/01 §6.4 — **รอคิว / ล้มเหลว / สำเร็จ**
 * (คิวส่งเข้าระบบบัญชี ST7-T19 ของ connector ที่เชื่อมอยู่ — ตัวเดียวกับการ์ดภาพรวม) + แท็บของต้นแบบที่เป็นงาน MISMATCH **ไม่ตรง / รออนุมัติ**
 * (ผลเทียบเนื้อหาเอกสาร ST8-T12 `GET /reconcile-results?check=DOCUMENT&actionable=true`) · แท็บเริ่ม = ล้มเหลว (ต้องมีคนทำ)
 * แถบสรุป: ไม่ตรง · รอคิว · ส่งไม่สำเร็จ (การ์ด "สำเร็จ 24 ชม." ไม่มี API) · ปุ่มหัว "ส่งซ้ำทั้งหมดที่รอ" = ส่งซ้ำแท็บล้มเหลวที่ส่งซ้ำได้
 * ไม่ตรง ปิดได้ 3 ทาง (docs/01 §6.5): รับค่า {ERP} → ยอมรับความต่าง / แก้ที่ TMS แล้ว (D-54) · ใช้ค่า TMS ส่งซ้ำ · ขออนุมัติแก้ →
 * ผู้อนุมัติ (≠ ผู้ขอ) อนุมัติด้วย "ใช้ค่า TMS ส่งซ้ำ" หรือ "ไม่อนุมัติ" (PO #94 24 พ.ย. 2569) [DECISION spec/12 §3 แถว ST7-T19 / ST8-T12]
 */
export function ErpPage() {
  const { t, lang } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canAct = can(scopes, 'integrations:retry');
  // คิว: ทำรายการได้ด้วย `integrations:retry` หรือ `settings:write` (ตาม API ST7-T19)
  const canQueue = canAct || can(scopes, 'settings:write');
  const canApprove = can(scopes, 'credit-notes:approve');
  const [params, setParams] = useSearchParams();
  // ลิงก์จากแจ้งเตือน/การ์ด (`/erp?tab=mm`) — เขียนแท็บลง session ก่อนอ่าน แล้วลบออกจาก URL
  useUrlSeed(params, ['tab'], (p) => {
    const k = p.get('tab') ?? '';
    return { 'erp.tab': asTab(k), 'erp.cols': EMPTY_COL };
  });
  useEffect(() => {
    if (params.has('tab')) {
      const next = new URLSearchParams(params);
      next.delete('tab');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ครั้งเดียวตอนเปิดหน้า
  }, []);
  const [tab, setTabRaw] = useSessionState<Tab>('erp.tab', DEFAULT_TAB);
  const [col, setCol] = useSessionState('erp.cols', EMPTY_COL);
  const [hidden, setHidden] = useSessionState<string[] | null>('erp.hidden', null);
  // มุมมองที่บันทึกไว้ (ต้นแบบ "มุมมอง: ของฉันวันนี้" — แบบหน้า settle): แท็บ + ตัวกรองคอลัมน์ + คอลัมน์ที่ซ่อน
  const views = useSavedViews({
    page: 'erp',
    state: { tab, ...col },
    hidden,
    empty: { tab: DEFAULT_TAB, ...EMPTY_COL },
    apply: (v) => {
      const x = pick(v.state, { tab: DEFAULT_TAB, ...EMPTY_COL });
      setTabRaw(asTab(x.tab));
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
  const curTab = asTab(tab);
  const queueTab = isQueueTab(curTab);
  // สถานะ (ตัวกรองคอลัมน์) ต่างชุดกันต่อแท็บ (ErrorClass ของคิว / สถานะของไม่ตรง) — เปลี่ยนแท็บล้างตัวกรองสถานะ
  const setTab = (k: Tab) => {
    setTabRaw(k);
    setCol((c) => (c.st ? { ...c, st: '' } : c));
  };
  const list = useReconcileList(TAB_QUERY[queueTab ? 'mm' : curTab], !queueTab);
  const conn = useConnectorMetrics();
  const connector = conn.data;
  const qSum = useQueueSummary(connector?.id ?? null);
  const retryAll = useRetryAll(connector?.id ?? null);
  const countQ = useReconcileCounts();
  const allRows = countQ.data?.data ?? [];
  const openRows = allRows.filter((x) => x.status === 'OPEN');
  const more = countQ.data?.hasMore ?? false;
  const cnt = (n: number) => (more ? `${n}+` : n);
  // แถบสรุป "ไม่ตรง" = สถานะไม่ตรง · แท็บนับตามตัวกรองของแท็บ (TAB_QUERY) · "ทั้งหมด" = ทุกรายการ (ต้นแบบมีตัวนับทุกแท็บ)
  const kpiMm = openRows.filter((x) => rowStatus(x) === 'mm').length;
  const counts: Partial<Record<Tab, number>> = {
    ...(qSum.data
      ? { queued: qSum.data.queued, failed: qSum.data.failed, done: qSum.data.done }
      : {}),
    ...(countQ.data
      ? {
          mm: openRows.filter((x) => x.overwrite?.status !== 'REQUESTED').length,
          appr: openRows.filter((x) => x.overwrite?.status === 'REQUESTED').length,
        }
      : {}),
  };
  const byClass = qSum.data?.failedByClass ?? {};
  // ยอดรวมของแท็บคิว = ตัวนับของ API (กลุ่ม ErrorClass = ตัวนับของกลุ่ม) · แท็บไม่ตรง = ยอดจากรายการเมื่อรู้แน่
  const total = queueTab
    ? curTab === 'failed' && col.st
      ? byClass[col.st]
      : counts[curTab]
    : list.page.total;
  const erpName = (x: ReconcileResult) =>
    adapterName(t, x.connector.adapterKey, x.connector.displayName);
  const anyRow = list.rows[0] ?? allRows[0];
  const connErp = connector ? adapterName(t, connector.adapterKey, connector.displayName) : null;
  const pageErp = connErp ?? (anyRow ? erpName(anyRow) : t('erpq.erpDefault'));
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
  const pickTab = (k: Tab) => setTab(curTab === k ? DEFAULT_TAB : k);
  const ask = (kind: DialogKind, x: ReconcileResult) => setDialog({ kind, x });
  // "ใช้ค่า TMS ส่งซ้ำ" = ส่งซ้ำตรง (ไม่ตรง · integrations:retry) หรือผู้อนุมัติอนุมัติคำขอ "ขออนุมัติแก้" ของผู้อื่น (รออนุมัติ)
  const useTmsKind = (x: ReconcileResult): DialogKind | null => {
    const st = rowStatus(x);
    if (st === 'mm' && canAct) return 'useTms';
    if (st === 'appr' && canApprove && !x.overwrite?.requestedByMe) return 'approve';
    return null;
  };
  // #94 "ไม่อนุมัติ" = ผู้อนุมัติ (≠ ผู้ขอ) บนรายการรออนุมัติ
  const canReject = (x: ReconcileResult) =>
    rowStatus(x) === 'appr' && canApprove && !x.overwrite?.requestedByMe;
  const doRetryAll = () =>
    retryAll.mutate(undefined, {
      onSuccess: (r) =>
        setToast(
          r.notRetryable
            ? t('dash.conn.retriedSome', { n: r.retried, m: r.notRetryable })
            : t('dash.conn.retried', { n: r.retried }),
        ),
      onError: (e) => setToast(queueErrorText(e, t) ?? t('erpq.loadError')),
    });

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
      <PageHeader
        title={t('page.erp.title')}
        sub={t('page.erp.sub', { erp: pageErp })}
        actions={
          canQueue && connector ? (
            <Button
              variant="secondary"
              icon="refresh-cw"
              disabled={retryAll.isPending}
              onClick={doRetryAll}
            >
              {t('erpq.q.retryAll')}
            </Button>
          ) : undefined
        }
      />
      {/* ต้นแบบ kpis('erp') = แถบสรุปบรรทัดเดียว: ไม่ตรง · รอส่งซ้ำ→รอคิว · ส่งไม่สำเร็จ (สำเร็จ 24 ชม. — ไม่มี API) */}
      <SummaryStrip
        items={[
          {
            value: countQ.data ? cnt(kpiMm) : '—',
            label: t('erpq.kpi.mm'),
            color: '#B3322A',
            onClick: () => pickTab('mm'),
            pressed: curTab === 'mm',
          },
          {
            value: qSum.data ? qSum.data.queued : '—',
            label: t('erpq.kpi.queued'),
            color: '#8F5500',
            onClick: () => pickTab('queued'),
            pressed: curTab === 'queued',
          },
          {
            value: qSum.data ? qSum.data.failed : '—',
            label: t('erpq.kpi.failed'),
            color: '#B3322A',
            onClick: () => pickTab('failed'),
            pressed: curTab === 'failed',
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
            ...(counts[k] !== undefined ? { count: counts[k] } : {}),
          }))}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <SavedViewMenu b={views} onToast={setToast} />
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {total !== undefined && t('table.total', { n: total })}
          </span>
        </div>
        {queueTab ? (
          connector ? (
            <QueuePanel
              key={`${connector.id}:${curTab}`}
              connectorId={connector.id}
              erp={pageErp}
              tab={curTab}
              col={col}
              setCol={setCol}
              hidden={hidden}
              setHidden={setHidden}
              byClass={byClass}
              canAct={canQueue}
              canApprove={canApprove}
              onToast={setToast}
            />
          ) : (
            <EmptyState icon="plug" title={t('erpq.q.noConn')} description={t('erpq.q.noConnD')} />
          )
        ) : list.q.isError ? (
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
              ...(canReject(x)
                ? [{ label: t('erpq.menu.reject'), icon: 'x', run: () => ask('reject', x) }]
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
          onReject={(x) => ask('reject', x)}
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
