import {
  Button,
  DataTable,
  DocNo,
  EmptyState,
  ReasonDialog,
  RouteChip,
  StatusDot,
  StatusTabs,
  SummaryStrip,
  Toast,
  type Column,
} from '@tms/ui';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { listTotal } from '../master/useCursorList';
import { RouteDrawer } from './RouteDrawer';
import { kmText, routeName, timeText, tollText } from './routeFormat';
import { RouteFormDrawer } from './RouteFormDrawer';
import {
  useRouteAction,
  useRouteList,
  useRouteSummary,
  type Route,
  type RouteFilters,
} from './useRoutes';
import { ImportExcelButton } from '../imports/ImportExcelButton';

const EMPTY_FILTERS: RouteFilters = { route: '', status: '' };

const DIALOG = {
  deactivate: { title: 'rt.dlg.offT', desc: 'rt.dlg.offD', ok: 'rt.menu.off' },
  delete: { title: 'rt.dlg.delT', desc: 'rt.dlg.delD', ok: 'rt.menu.delete' },
} as const satisfies Record<string, Record<'title' | 'desc' | 'ok', MessageKey>>;

const num = (n: number) => n.toLocaleString('th-TH');
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;

/**
 * ข้อมูลหลัก → เส้นทาง (ST2-T09; docs/04 B เส้นทาง) — ต้นแบบ TMS v4 ไม่มีหน้านี้ [OPEN spec/12 §3]
 * ประกอบจากแบบของหน้าข้อมูลหลักในต้นแบบ (ประเภทรถ/สถานที่: หัว + แถบสรุป + แท็บ + ตาราง + drawer)
 * และ route chip "ต้นทาง → ปลายทาง" ในเซลล์เดียว (docs/03 §Route chip, คอลัมน์ "เส้นทาง" ของ specRate)
 */
export function RoutesPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const [filters, setFilters] = useState<RouteFilters>(EMPTY_FILTERS);
  const list = useRouteList(filters);
  const summary = useRouteSummary();
  const action = useRouteAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Route | null>(null);
  const [form, setForm] = useState<{ route: Route | null } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; r: Route } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof RouteFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (r: Route) => {
    setOpenId(r.id);
    setSelected(r);
  };
  const toggleStatus = (r: Route) => {
    if (r.status === 'active') return setDialog({ kind: 'deactivate', r });
    action.mutate(
      { id: r.id, version: r.version, action: 'activate' },
      {
        onSuccess: (u) => {
          if (u && openId === r.id) setSelected(u);
          setToast(t('rt.toast.status', { n: r.code }));
        },
        onError: (e) => setToast(problemText(e, t)),
      },
    );
  };

  /** ฟอร์มเพิ่มชนคู่ที่ปิดใช้อยู่ → เปิดใช้เส้นทางเดิม (version ล่าสุดจาก GET) แล้วเปิด drawer */
  const activateExisting = async (id: string) => {
    try {
      const r = await unwrap(api.GET('/v1/routes/{id}', { params: { path: { id } } }));
      action.mutate(
        { id: r.id, version: r.version, action: 'activate' },
        {
          onSuccess: (u) => {
            setForm(null);
            if (u) open(u);
            setToast(t('rt.toast.reactivated', { n: r.code }));
          },
          onError: (e) => setToast(problemText(e, t)),
        },
      );
    } catch (e) {
      setToast(problemText(e, t));
    }
  };

  const columns: Column<Route>[] = [
    {
      key: 'route',
      label: t('rt.col.route'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span title={routeName(r)} className="tms-route-cell">
          <RouteChip
            from={<span className="tms-ellipsis">{r.origin.name}</span>}
            to={<span className="tms-ellipsis">{r.destination.name}</span>}
          />
        </span>
      ),
      csv: (r) => routeName(r),
    },
    {
      key: 'code',
      label: t('rt.col.code'),
      width: '1%',
      render: (r) => <DocNo>{r.code}</DocNo>,
      csv: (r) => r.code,
    },
    {
      key: 'km',
      label: t('rt.col.km'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{kmText(t, r)}</span>,
      csv: (r) => String(r.distanceKm),
    },
    {
      key: 'time',
      label: t('rt.col.time'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{timeText(t, r.standardMinutes)}</span>,
      csv: (r) => String(r.standardMinutes ?? ''),
    },
    {
      key: 'toll',
      label: t('rt.col.toll'),
      width: '1%',
      align: 'right',
      render: (r) => (
        <span style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{tollText(r)}</span>
      ),
      csv: (r) => r.tollAmount ?? '',
    },
    {
      key: 'st',
      label: t('rt.col.st'),
      width: '1%',
      render: (r) => (
        <StatusDot
          label={t(r.status === 'active' ? 'rt.st.active' : 'rt.st.inactive')}
          tone={r.status === 'active' ? 'ok' : 'off'}
        />
      ),
      csv: (r) => t(r.status === 'active' ? 'rt.st.active' : 'rt.st.inactive'),
    },
  ];

  const filtered = filters.route !== '';
  const tabCount =
    filters.status === 'active'
      ? sum?.active
      : filters.status === 'inactive'
        ? sum?.inactive
        : sum?.total;
  const shownTotal = listTotal(list, filters, ['status'], tabCount);

  return (
    <>
      <PageHeader
        title={t('page.route.title')}
        sub={t('page.route.sub')}
        actions={
          <>
            {/* นำเข้า Excel (ST2-T23) — ต้นแบบไม่มีปุ่มนี้ในหน้าเส้นทาง: ใช้แบบเดียวกับหน้าลูกค้า [OPEN spec/12 §3] */}
            <ImportExcelButton kind="route" label={t('cust.import')} onDone={setToast} />
            {canWrite && (
              <Button variant="primary" icon="plus" onClick={() => setForm({ route: null })}>
                {t('rt.add')}
              </Button>
            )}
          </>
        }
      />
      <SummaryStrip
        items={[
          { value: sum ? num(sum.total) : '—', label: t('rt.sum.total') },
          { value: sum ? num(sum.active) : '—', label: t('rt.sum.active'), color: '#2257C4' },
          { value: sum ? num(sum.withToll) : '—', label: t('rt.sum.toll') },
          {
            value: sum ? num(sum.noStandardTime) : '—',
            label: t('rt.sum.noTime'),
            ...(sum && sum.noStandardTime > 0 ? { color: '#8F5500' } : {}),
          },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={filters.status || 'all'}
          onChange={(k) => setF('status', k === 'all' ? '' : k)}
          items={[
            { key: 'all', label: t('table.all'), ...(sum ? { count: sum.total } : {}) },
            { key: 'active', label: t('rt.st.active'), ...(sum ? { count: sum.active } : {}) },
            {
              key: 'inactive',
              label: t('rt.st.inactive'),
              ...(sum ? { count: sum.inactive } : {}),
            },
          ]}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('rt.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('rt.retry')}
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={list.rows}
            rowId={(r) => r.id}
            activeId={openId}
            loading={list.loading}
            labels={tableLabels(t)}
            filters={{ route: filters.route }}
            onFilterChange={(k, v) => setF(k as keyof RouteFilters, v)}
            onRowClick={open}
            rowMenu={(r) => [
              { label: t('rt.menu.view'), icon: 'eye', run: () => open(r) },
              ...(canWrite
                ? [
                    { label: t('rt.menu.edit'), icon: 'pencil', run: () => setForm({ route: r }) },
                    {
                      label: t(r.status === 'active' ? 'rt.menu.off' : 'rt.menu.on'),
                      icon: 'ban',
                      run: () => toggleStatus(r),
                    },
                  ]
                : []),
            ]}
            {...(canExport
              ? {
                  bulkActions: [
                    {
                      label: t('rt.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/routes/export', {
                          format: 'xlsx',
                          ids: ids.join(','),
                        }).then(
                          () => setToast(t('rt.toast.exported', { n: ids.length })),
                          () => setToast(t('rt.exportFailed')),
                        ),
                    },
                  ],
                }
              : {})}
            onExportCsv={
              canExport
                ? () =>
                    void downloadFile('/v1/routes/export', {
                      format: 'csv',
                      ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')),
                    }).catch(() => setToast(t('rt.exportFailed')))
                : false
            }
            empty={
              filtered ? (
                <EmptyState
                  icon="search-x"
                  title={t('table.emptyTitle')}
                  description={t('table.noMatch')}
                />
              ) : (
                <EmptyState
                  icon="route"
                  title={t('rt.emptyTitle')}
                  description={t('rt.emptyDesc')}
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
      {current && (
        <RouteDrawer
          key={current.id}
          route={current}
          canWrite={canWrite}
          onEdit={() => setForm({ route: current })}
          onToggleStatus={() => toggleStatus(current)}
          onDelete={() => setDialog({ kind: 'delete', r: current })}
          onClose={() => {
            setOpenId(null);
            setSelected(null);
          }}
        />
      )}
      <RouteFormDrawer
        open={!!form}
        route={form?.route ?? null}
        onClose={() => setForm(null)}
        onSaved={(r, created) => {
          setForm(null);
          setToast(t(created ? 'rt.toast.created' : 'rt.toast.saved', { n: r.code }));
          open(r);
        }}
        onActivateExisting={(id) => void activateExisting(id)}
      />
      <ReasonDialog
        open={!!dialog}
        title={dialog ? t(DIALOG[dialog.kind].title, { n: routeName(dialog.r) }) : ''}
        description={dialog ? t(DIALOG[dialog.kind].desc) : ''}
        label={t('rt.dlg.reason')}
        placeholder={t('rt.dlg.reasonPh')}
        okLabel={dialog ? t(DIALOG[dialog.kind].ok) : ''}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={action.isPending}
        error={problemText(action.error, t)}
        onClose={() => {
          setDialog(null);
          action.reset();
        }}
        onOk={(reason) => {
          if (!dialog) return;
          const { r, kind } = dialog;
          action.mutate(
            { id: r.id, version: r.version, action: kind, reason },
            {
              onSuccess: (updated) => {
                setDialog(null);
                if (kind === 'delete') {
                  setOpenId(null);
                  setSelected(null);
                  setToast(t('rt.toast.deleted', { n: r.code }));
                } else {
                  if (updated && openId === r.id) setSelected(updated);
                  setToast(t('rt.toast.status', { n: r.code }));
                }
              },
            },
          );
        }}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
