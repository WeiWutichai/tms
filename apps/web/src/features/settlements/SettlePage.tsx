import {
  Button,
  DataTable,
  DocNo,
  EmptyState,
  KpiCard,
  StatusDot,
  StatusTabs,
  Toast,
  type Column,
} from '@tms/ui';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { money, useDateText } from '../rate-cards/rateFormat';
import { SavedViewMenu } from '../views/SavedViewMenu';
import { pick, useSavedViews } from '../views/useSavedViews';
import { ApproveDialog } from './ApproveDialog';
import { MarkPaidDialog } from './MarkPaidDialog';
import {
  canApproveStatus,
  canPayStatus,
  canPrintStatus,
  canRelinkStatus,
  viewOnlyLink,
  deductTotal,
  statusLabel,
  statusTone,
  TAB_STATUS,
  TABS,
  type Tab,
} from './settle';
import { SettlementDrawer } from './SettlementDrawer';
import {
  openVoucherPdf,
  useReissueLink,
  useSettlementKpi,
  useSettlementList,
  type SettlementLink,
  type SettlementSummary,
} from './useSettlements';

const ST_OPTS = ['DRAFT', 'SENT_TO_CARRIER', 'DISPUTED', 'APPROVED', 'PAID', 'CANCELLED'] as const;
const EMPTY_VIEW = { tab: 'all', no: '', who: '', st: '' };

/**
 * บัญชี → Settlement รถร่วม (ต้นแบบ TMS v4 `settle` = kpisX('settle') + ตาราง specSa + drawer vPanel 'sa' + askApproveSa + vSp)
 * สถานะตาม docs/01 §4.5 → แท็บ/การ์ดของต้นแบบ (ดู `settle.ts`) · อนุมัติ (ST6-T07 SoD + step-up) · บันทึกจ่าย (ST6-T09 + D-60) ·
 * "ออกลิงก์ใหม่" (D-63 — เมนูแถว/เมนู ⋯ ของ drawer; D-59 ใบอนุมัติแล้ว/จ่ายแล้ว = ลิงก์ดูอย่างเดียว) · พิมพ์ใบสำคัญจ่าย (ST6-T04)
 * ความต่างจากต้นแบบ [DECISION spec/12 §3 แถวหน้า settle]: ตัดคอลัมน์ "การแก้ไข" (ไม่มีข้อมูล) · "สร้างงวดใหม่" ปิด (หน้าติ๊กเที่ยว [OPEN Claude Design]) ·
 * "ส่งออกให้นักบัญชี" ปิด (งานส่งออก ST5) · "ตรวจแล้ว ส่งอนุมัติ" ไม่มี (ไม่มีสถานะนี้ใน docs) · "หนังสือรับรอง 50 ทวิ" ตัด (D-54/D-58)
 */
export function SettlePage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canApprove = can(scopes, 'settlements:approve');
  const canPay = can(scopes, 'settlements:pay');
  const canRelink = can(scopes, 'settlements:create');
  const dateText = useDateText();
  const [tab, setTab] = useSessionState<Tab>('settle.tab', 'all');
  const [col, setCol] = useSessionState('settle.cols', { no: '', who: '', st: '' });
  const [hidden, setHidden] = useSessionState<string[] | null>('settle.hidden', null);
  // มุมมองที่บันทึกไว้ (ต้นแบบ "มุมมอง: ของฉันวันนี้" — แบบหน้ารับชำระ): แท็บ + ตัวกรองคอลัมน์ + คอลัมน์ที่ซ่อน
  const views = useSavedViews({
    page: 'settlements',
    state: { tab, ...col },
    hidden,
    empty: EMPTY_VIEW,
    apply: (v) => {
      const x = pick(v.state, EMPTY_VIEW);
      setTab(TABS.includes(x.tab as Tab) ? (x.tab as Tab) : 'all');
      setCol({ no: x.no, who: x.who, st: x.st });
      setHidden(v.hidden);
    },
  });
  const [open, setOpen] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  // viewOnly ตรึงตอนออกลิงก์ (D-59: ใบ APPROVED/PAID = ดูอย่างเดียว) — ไม่อ่านจากสถานะปัจจุบัน (review L2)
  const [link, setLink] = useState<{
    id: string;
    link: SettlementLink;
    viewOnly: boolean;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const kpi = useSettlementKpi().data;
  const reissue = useReissueLink();
  const curTab = TABS.includes(tab) ? tab : 'all';
  const list = useSettlementList(TAB_STATUS[curTab] ? { status: TAB_STATUS[curTab] } : {});
  const shown = list.rows.filter(
    (x) =>
      (!col.no || (x.settlementNo ?? '').includes(col.no)) &&
      (!col.who || x.carrier.legalName.includes(col.who)) &&
      (!col.st || x.status === col.st),
  );
  const tabCount: Record<Tab, number | undefined> = kpi
    ? {
        all: kpi.total,
        chk: kpi.draft + kpi.disputed,
        appr: kpi.sentToCarrier,
        ok: kpi.approved,
        paid: kpi.paid,
      }
    : { all: undefined, chk: undefined, appr: undefined, ok: undefined, paid: undefined };
  const shownTotal = listTotal(list, { tab: curTab, ...col }, ['tab'], tabCount[curTab]);
  const pickTab = (k: Tab) => setTab(curTab === k ? 'all' : k);
  const kpiSub = (k: Tab) => t(curTab === k ? 'dash.kpi.clear' : 'bill.kpi.click');

  const relink = (id: string, status: string) => {
    // กดซ้ำระหว่างรอ = ไม่ทำ (ออกซ้ำจะเพิกถอนลิงก์ที่เพิ่งออก — review L3)
    if (reissue.isPending) return;
    reissue.mutate(id, {
      onSuccess: (l) => {
        setLink({ id, link: l, viewOnly: viewOnlyLink(status) });
        setOpen(id);
        setToast(t('settle.link.done'));
      },
      onError: (e) => setToast(problemText(e, t)),
    });
  };
  const print = (x: { id: string; settlementNo: string | null }) =>
    openVoucherPdf(x.id, x.settlementNo).catch((e: unknown) => setToast(problemText(e, t)));

  const per = (x: SettlementSummary) =>
    x.periodFrom && x.periodTo
      ? t('settle.per', { a: dateText(x.periodFrom), b: dateText(x.periodTo) })
      : '—';
  const columns: Column<SettlementSummary>[] = [
    {
      key: 'no',
      label: t('settle.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <DocNo>{x.settlementNo ?? t('settle.draftNo')}</DocNo>,
      csv: (x) => x.settlementNo ?? '',
    },
    {
      key: 'who',
      label: t('settle.col.who'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <span style={{ color: '#101418' }}>{x.carrier.legalName}</span>,
      csv: (x) => x.carrier.legalName,
    },
    {
      key: 'per',
      label: t('settle.col.per'),
      width: '1%',
      render: (x) => <span style={{ whiteSpace: 'nowrap' }}>{per(x)}</span>,
      csv: per,
    },
    {
      key: 'n',
      label: t('settle.col.n'),
      align: 'right',
      width: '1%',
      render: (x) => <span className="tms-num">{x.tripCount}</span>,
      csv: (x) => String(x.tripCount),
    },
    {
      key: 'buy',
      label: t('settle.col.buy'),
      align: 'right',
      width: '1%',
      render: (x) => <span className="tms-num">{money(x.buyGrossAmount)}</span>,
      csv: (x) => x.buyGrossAmount ?? '',
    },
    {
      key: 'ded',
      label: t('settle.col.ded'),
      align: 'right',
      width: '1%',
      render: (x) => (
        <span className="tms-num" style={{ color: '#3B424C' }}>
          {money(deductTotal(x))}
        </span>
      ),
      csv: (x) => deductTotal(x) ?? '',
    },
    {
      key: 'net',
      label: t('settle.col.net'),
      align: 'right',
      width: '1%',
      render: (x) => (
        <span className="tms-num" style={{ color: '#101418', fontWeight: 600 }}>
          {money(x.buyNetAfterWht)}
        </span>
      ),
      csv: (x) => x.buyNetAfterWht ?? '',
    },
    {
      key: 'st',
      label: t('settle.col.st'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...ST_OPTS.map((v) => ({ value: v, label: statusLabel(t, v) })),
        ],
      },
      render: (x) => (
        <StatusDot
          label={statusLabel(t, x.status)}
          {...(statusTone(x.status) ? { tone: statusTone(x.status)! } : {})}
        />
      ),
      csv: (x) => statusLabel(t, x.status),
    },
  ];

  const exportRows = (ids: string[]) => {
    const rows = shown.filter((x) => ids.includes(x.id));
    const esc = (raw: string) => {
      const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const lines = [columns.map((c) => esc(c.label)).join(',')];
    for (const r of rows) lines.push(columns.map((c) => esc(c.csv?.(r) ?? '')).join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
    );
    a.download = 'settlements.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setToast(t('settle.csvDone', { n: rows.length }));
  };

  return (
    <>
      <PageHeader
        title={t('page.settle.title')}
        sub={t('page.settle.sub')}
        actions={
          <>
            {/* ส่งออกให้นักบัญชี (spec/05 §14) — งานส่งออกยังไม่มี (แบบหน้าวางบิล/รับชำระ) */}
            <Button variant="secondary" icon="file-down" disabled title={t('bill.xpSoon')}>
              {t('bill.xp')}
            </Button>
            {/* สร้างงวดใหม่ = หน้าติ๊กเที่ยวจากคิวจ่าย (ต้นแบบเป็น toast — [OPEN Claude Design] spec/12 §3 ST6-T03) */}
            <Button variant="secondary" icon="plus" disabled title={t('settle.newSoon')}>
              {t('settle.newPeriod')}
            </Button>
          </>
        }
      />
      <div className="tms-kpis">
        <KpiCard
          label={t('settle.kpi.chk')}
          tone="warn"
          value={tabCount.chk ?? '—'}
          sub={kpiSub('chk')}
          active={curTab === 'chk'}
          onClick={() => pickTab('chk')}
        />
        <KpiCard
          label={t('settle.kpi.appr')}
          tone="warn"
          value={tabCount.appr ?? '—'}
          sub={kpiSub('appr')}
          active={curTab === 'appr'}
          onClick={() => pickTab('appr')}
        />
        <KpiCard
          label={t('settle.kpi.ok')}
          tone="info"
          value={tabCount.ok ?? '—'}
          sub={kpiSub('ok')}
          active={curTab === 'ok'}
          onClick={() => pickTab('ok')}
        />
        <KpiCard
          label={t('settle.kpi.paid')}
          tone="ok"
          value={kpi?.buyPaidThisMonth !== undefined ? money(kpi.buyPaidThisMonth) : '—'}
          sub={kpiSub('paid')}
          active={curTab === 'paid'}
          onClick={() => pickTab('paid')}
        />
      </div>

      <div className="tms-listbody">
        <StatusTabs
          value={curTab}
          onChange={(k) => setTab(k as Tab)}
          items={TABS.map((k) => ({
            key: k,
            label: t(`settle.tab.${k}` as MessageKey),
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
            title={t('settle.loadError')}
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
            bulkActions={[{ label: t('settle.bulk.csv'), icon: 'download', run: exportRows }]}
            filters={col}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(x) => setOpen(x.id)}
            rowMenu={(x) => [
              { label: t('settle.menu.view'), icon: 'eye', run: () => setOpen(x.id) },
              ...(canApprove && canApproveStatus(x.status)
                ? [
                    {
                      label: t('settle.menu.approve'),
                      icon: 'circle-check',
                      run: () => setApproving(x.id),
                    },
                  ]
                : []),
              ...(canPay && canPayStatus(x.status)
                ? [{ label: t('settle.menu.pay'), icon: 'banknote', run: () => setPaying(x.id) }]
                : []),
              ...(canRelink && canRelinkStatus(x.status)
                ? [
                    {
                      label: t('settle.menu.relink'),
                      icon: 'link',
                      run: () => relink(x.id, x.status),
                    },
                  ]
                : []),
              ...(canPrintStatus(x.status)
                ? [{ label: t('settle.menu.print'), icon: 'printer', run: () => void print(x) }]
                : []),
            ]}
            empty={
              <EmptyState
                icon="wallet"
                title={t('settle.list.emptyTitle')}
                description={t('settle.list.emptyDesc')}
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
      {open && (
        <SettlementDrawer
          id={open}
          link={link?.id === open ? link : null}
          canApprove={canApprove}
          canPay={canPay}
          canRelink={canRelink}
          onApprove={(x) => setApproving(x.id)}
          onPay={(s) => setPaying(s.id)}
          onRelink={(s) => relink(s.id, s.status)}
          onClose={() => setOpen(null)}
          onToast={setToast}
        />
      )}
      {approving && (
        <ApproveDialog
          id={approving}
          onClose={() => setApproving(null)}
          onDone={(no) => {
            setApproving(null);
            setToast(t('settle.appr.done', { no }));
          }}
        />
      )}
      {paying && (
        <MarkPaidDialog
          id={paying}
          onClose={() => setPaying(null)}
          onDone={(no) => {
            setPaying(null);
            setToast(t('settle.pay.done', { no }));
          }}
        />
      )}
      {toast && (
        <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
      )}
    </>
  );
}
