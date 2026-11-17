import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  KpiCard,
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
import { useDateTimeText } from '../rate-cards/rateFormat';
import { FlagDrawer } from './FlagDrawer';
import { flagDetail, flagTypeLabel, STATUS_BADGE } from './flagText';
import { useFlagList, useFlagSummary, type FlagTab, type StopEventFlag } from './useStopEventFlags';

const FLAG_KINDS = ['LATE', 'SEQUENCE_CONFLICT', 'CLOCK_SKEW'] as const;

/** สองบรรทัดในเซลล์ (ต้นแบบ cTwo: บรรทัดแรก 14px ปกติ · บรรทัดสองสี #3B424C) */
function Two({ a, b, max }: { a: string; b?: string | null; max: number }) {
  const ell = {
    maxWidth: max,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
      <span title={a} style={{ fontSize: 14, fontWeight: 400, ...ell }}>
        {a}
      </span>
      <span title={b ?? ''} style={{ color: '#3B424C', fontSize: 14, fontWeight: 400, ...ell }}>
        {b ?? ''}
      </span>
    </div>
  );
}

/**
 * ปฏิบัติการ → ศูนย์ข้อยกเว้น (ST4-T02; docs/04 E1 "ขัดแย้ง → เก็บทั้งคู่ + flag ให้ dispatcher ตัดสิน")
 * โครงหน้า/ข้อความ/สีตามต้นแบบ TMS v4 หน้า exc (หัว + การ์ด KPI + แท็บ + ตาราง + drawer + ReasonDialog "ปิดเหตุ")
 * ขอบเขตเฟส 0 = เฉพาะธงของ stop event — ไม่มีเลขเหตุ/SLA/ผู้รับผิดชอบ/มอบหมาย/มุมมอง/ตั้งค่า SLA
 * (ศูนย์ข้อยกเว้นเต็มรูป spec/04 §2 = ผู้สมัครเพิ่ม #11) [DECISION — ย้อนได้ spec/12 §3, 17 พ.ย. 2569]
 */
export function ExceptionsPage() {
  const { t } = useI18n();
  const me = useMe();
  const dt = useDateTimeText();
  const canResolve = can(me.data?.scopes ?? [], 'trips:dispatch');
  const [tab, setTab] = useSessionState<FlagTab>('exc.tab', 'all');
  const [col, setCol] = useSessionState('exc.cols', { flag: '', q: '' });
  // การ์ด "ปิดแล้ววันนี้" = แท็บปิดแล้ว + เฉพาะที่ตัดสินวันนี้
  const [today, setToday] = useSessionState('exc.today', false);
  const list = useFlagList({ status: tab, flag: col.flag, q: col.q, today });
  const summary = useFlagSummary();
  const s = summary.data;
  const [open, setOpen] = useState<StopEventFlag | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const tabCount = (k: FlagTab) =>
    !s ? undefined : k === 'open' ? s.open : k === 'resolved' ? s.resolved : s.open + s.resolved;
  const shownTotal = listTotal(list, col, [], today ? s?.resolvedToday : tabCount(tab));
  const filtered = !!(col.flag || col.q);

  const columns: Column<StopEventFlag>[] = [
    {
      key: 'flag',
      label: t('exc.col.type'),
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...FLAG_KINDS.map((k) => ({ value: k, label: t(`exc.flag.${k}` as MessageKey) })),
        ],
      },
      render: (r) => <Two max={340} a={flagTypeLabel(t, r)} b={flagDetail(t, r, dt)} />,
      csv: (r) => `${flagTypeLabel(t, r)} — ${flagDetail(t, r, dt)}`,
    },
    {
      key: 'q',
      label: t('exc.col.ref'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <Two
          max={200}
          a={r.tripNo ?? '—'}
          b={t('exc.stop', { n: r.stopSequence, site: r.siteName })}
        />
      ),
      csv: (r) => `${r.tripNo ?? ''} ${t('exc.stop', { n: r.stopSequence, site: r.siteName })}`,
    },
    {
      key: 'veh',
      label: t('exc.col.veh'),
      render: (r) => <Two max={180} a={r.vehiclePlate ?? '—'} b={r.customerName} />,
      csv: (r) => `${r.vehiclePlate ?? ''} ${r.customerName ?? ''}`,
    },
    {
      key: 'at',
      label: t('exc.col.at'),
      render: (r) => (
        <span style={{ color: '#101418', whiteSpace: 'nowrap' }}>{dt(r.event.receivedAt)}</span>
      ),
      csv: (r) => r.event.receivedAt,
    },
    {
      key: 'status',
      label: t('exc.col.status'),
      render: (r) => (
        <Badge
          label={t(`exc.st.${r.status}` as MessageKey)}
          tone={STATUS_BADGE[r.status]!.tone}
          icon={STATUS_BADGE[r.status]!.icon}
        />
      ),
      csv: (r) => t(`exc.st.${r.status}` as MessageKey),
    },
  ];

  const kpi = (k: 'open' | 'today', tone: 'err' | 'ok') => {
    const target: FlagTab = k === 'open' ? 'open' : 'resolved';
    const active = k === 'today' ? today : tab === 'open' && !today;
    return (
      <KpiCard
        label={t(`exc.kpi.${k}`)}
        tone={tone}
        value={s ? (k === 'open' ? s.open : s.resolvedToday) : '—'}
        sub={active ? t('exc.kpi.clear') : t('exc.kpi.click')}
        active={active}
        activeLabel={t('exc.kpi.on')}
        onClick={() => {
          if (active) {
            setTab('all');
            setToday(false);
          } else {
            setTab(target);
            setToday(k === 'today');
          }
        }}
      />
    );
  };

  return (
    <>
      <PageHeader title={t('page.exc.title')} sub={t('page.exc.sub')} />
      {/* ต้นแบบมี 4 การ์ด — "กำลังจัดการ" / "เกิน SLA" ไม่มีในเฟส 0 (ไม่มีผู้รับเรื่อง/SLA) · คงขนาดการ์ดเดิม */}
      <div
        className="tms-kpis"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
      >
        {kpi('open', 'err')}
        {kpi('today', 'ok')}
      </div>
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={(k) => {
            setTab(k as FlagTab);
            setToday(false);
          }}
          items={(['all', 'open', 'resolved'] as const).map((k) => {
            const n = tabCount(k);
            return {
              key: k,
              label: k === 'all' ? t('table.all') : t(`exc.tab.${k}`),
              ...(n !== undefined ? { count: n } : {}),
            };
          })}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('exc.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('exc.retry')}
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={list.loading ? [] : list.rows}
            rowId={(r) => r.id}
            activeId={open?.id ?? null}
            loading={list.loading}
            labels={tableLabels(t)}
            selectable={false}
            filters={{ flag: col.flag, q: col.q }}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(r) => setOpen(r)}
            rowMenu={(r) => [{ label: t('exc.menu.view'), icon: 'eye', run: () => setOpen(r) }]}
            empty={
              filtered || today || tab !== 'all' ? (
                <EmptyState
                  icon="search-x"
                  title={t('table.emptyTitle')}
                  description={t('table.noMatch')}
                />
              ) : (
                <EmptyState
                  icon="circle-check"
                  title={t('exc.emptyTitle')}
                  description={t('exc.emptyDesc')}
                />
              )
            }
            page={{ ...list.page, ...(shownTotal !== undefined ? { total: shownTotal } : {}) }}
            onPageSize={list.setSize}
            onNext={list.next}
            onPrev={list.prev}
            onGoto={list.goto}
          />
        )}
      </div>
      {open && (
        <FlagDrawer
          key={open.id}
          flag={open}
          canResolve={canResolve}
          onClose={() => setOpen(null)}
          onResolved={(f) => {
            setOpen(f);
            setToast(t('exc.toast.resolved', { no: f.tripNo ?? '' }));
          }}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
