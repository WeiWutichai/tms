import {
  Button,
  DataTable,
  EmptyState,
  ReasonDialog,
  StatusTabs,
  SummaryStrip,
  Tag,
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
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { SiteDrawer, hoursText } from './SiteDrawer';
import { SiteFormDrawer } from './SiteFormDrawer';
import { formatContact } from './siteFormat';
import {
  SITE_KINDS,
  VEHICLE_CLASSES,
  useSiteAction,
  useSiteList,
  useSiteSummary,
  type Site,
  type SiteFilters,
} from './useSites';

const EMPTY_FILTERS: SiteFilters = {
  kind: '',
  q: '',
  customerName: '',
  maxVehicleClass: '',
  pinned: '',
  customerId: '',
};

/** ข้อความสองบรรทัดของต้นแบบ (cW): บรรทัดบน 14px, บรรทัดล่างสีรอง — ยาวเกินตัด … */
function TwoLine({ top, sub, muted }: { top: string; sub: string; muted?: string | undefined }) {
  const clip = {
    display: 'block',
    maxWidth: 440,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
      <span title={top} style={{ ...clip, color: '#101418' }}>
        {top}
        {muted && <span style={{ marginLeft: 8, color: '#59606B', fontSize: 12.5 }}>{muted}</span>}
      </span>
      <span title={sub} style={{ ...clip, color: '#3B424C' }}>
        {sub}
      </span>
    </div>
  );
}

/**
 * ข้อมูลหลัก → สถานที่ / จุดรับส่ง (ST2-T02) — ต้นแบบ TMS v4 specLoc() + kpisX('loc') + cfLoc() + vPanelApi loc
 * โครงหน้าเดียวกับลูกค้า (หัว + แถบสรุป + แท็บ + ตาราง + drawer) — แท็บตามประเภท (ต้นทาง/ปลายทาง/คลัง)
 */
export function SitesPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const ownerName = me.data?.tenant.name ?? '—';
  const [filters, setFilters] = useState<SiteFilters>(EMPTY_FILTERS);
  const list = useSiteList(filters);
  const summary = useSiteSummary();
  const action = useSiteAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Site | null>(null);
  const [form, setForm] = useState<{ site: Site | null } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; s: Site } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof SiteFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (s: Site) => {
    setOpenId(s.id);
    setSelected(s);
  };
  const kindLabel = (k: Site['kind']) => t(`loc.k.${k}` as MessageKey);
  const vcLabel = (s: Site) =>
    s.maxVehicleClass ? t(`loc.vc.${s.maxVehicleClass}` as MessageKey) : t('loc.vc.none');
  const toggleStatus = (s: Site) => {
    if (s.status === 'active') return setDialog({ kind: 'deactivate', s });
    action.mutate(
      { id: s.id, version: s.version, action: 'activate' },
      {
        onSuccess: (u) => {
          if (u && openId === s.id) setSelected(u);
          setToast(t('loc.toast.status', { n: s.name }));
        },
      },
    );
  };

  const num = (n: number) => n.toLocaleString('th-TH');
  const columns: Column<Site>[] = [
    {
      key: 'q',
      label: t('loc.col.name'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <TwoLine
          top={r.name}
          sub={r.address.line1}
          muted={r.status === 'inactive' ? t('loc.inactive') : undefined}
        />
      ),
      csv: (r) => `${r.name} ${r.address.line1}`,
    },
    {
      key: 'kind',
      label: t('loc.col.kind'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...SITE_KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
        ],
      },
      render: (r) => <Tag>{kindLabel(r.kind)}</Tag>,
      csv: (r) => kindLabel(r.kind),
    },
    {
      key: 'customerName',
      label: t('loc.col.cust'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span
          title={r.customer?.name ?? ownerName}
          style={{
            color: '#101418',
            display: 'inline-block',
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            verticalAlign: 'bottom',
          }}
        >
          {r.customer?.name ?? ownerName}
        </span>
      ),
      csv: (r) => r.customer?.name ?? ownerName,
    },
    {
      key: 'll',
      label: t('loc.col.ll'),
      width: '1%',
      render: (r) => (
        <span
          className="tms-num"
          style={{ color: r.lat === null ? '#8F5500' : '#101418', whiteSpace: 'nowrap' }}
        >
          {r.lat === null || r.lng === null
            ? t('loc.noPin')
            : `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`}
        </span>
      ),
      csv: (r) => (r.lat === null ? '' : `${r.lat}, ${r.lng}`),
    },
    {
      key: 'r',
      label: t('loc.col.r'),
      width: '1%',
      align: 'right',
      render: (r) => (
        <span style={{ color: '#101418', whiteSpace: 'nowrap' }}>
          {t('loc.m', { n: num(r.geofenceRadiusM) })}
        </span>
      ),
      csv: (r) => String(r.geofenceRadiusM),
    },
    {
      key: 'hrs',
      label: t('loc.col.hrs'),
      width: '1%',
      render: (r) => (
        <span style={{ color: '#101418', whiteSpace: 'nowrap' }}>
          {hoursText(r, t('loc.allDay'))}
        </span>
      ),
      csv: (r) => hoursText(r, t('loc.allDay')),
    },
    {
      key: 'maxVehicleClass',
      label: t('loc.col.mx'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...VEHICLE_CLASSES.map((k) => ({ value: k, label: t(`loc.vc.${k}` as MessageKey) })),
        ],
      },
      render: (r) => <Tag>{vcLabel(r)}</Tag>,
      csv: (r) => vcLabel(r),
    },
    {
      key: 'ct',
      label: t('loc.col.ct'),
      width: '1%',
      render: (r) => (
        <span style={{ color: '#101418', whiteSpace: 'nowrap' }}>
          {formatContact(r.contact) || '—'}
        </span>
      ),
      csv: (r) => formatContact(r.contact),
    },
  ];

  const kinds = sum?.byKind;
  const onlyKind = !filters.q && !filters.customerName && !filters.maxVehicleClass;
  const tabCount = !onlyKind
    ? undefined
    : filters.pinned === 'false'
      ? filters.kind
        ? undefined
        : sum?.unpinned
      : filters.kind
        ? kinds?.[filters.kind as keyof typeof kinds]
        : sum?.total;
  const filtered = Object.values(filters).some((v) => v !== '');

  return (
    <>
      <PageHeader
        title={t('page.loc.title')}
        sub={t('page.loc.sub')}
        actions={
          <>
            {/* นำเข้า Excel = ST2-T23 — แสดงตามต้นแบบแต่ยังกดไม่ได้ [OPEN spec/12 §3] */}
            <Button
              variant="secondary"
              icon="file-spreadsheet"
              disabled
              title={t('loc.importSoon')}
            >
              {t('loc.import')}
            </Button>
            {canWrite && (
              <Button variant="primary" icon="plus" onClick={() => setForm({ site: null })}>
                {t('loc.add')}
              </Button>
            )}
          </>
        }
      />
      <SummaryStrip
        items={[
          {
            value: sum ? num(sum.total) : '—',
            label: t('loc.sum.total'),
            onClick: () => setFilters(EMPTY_FILTERS),
          },
          { value: sum ? num(sum.pinned) : '—', label: t('loc.sum.pinned'), color: '#17733F' },
          {
            value: sum ? num(sum.unpinned) : '—',
            label: t('loc.sum.unpinned'),
            color: '#8F5500',
            pressed: filters.pinned === 'false',
            onClick: () => setF('pinned', filters.pinned === 'false' ? '' : 'false'),
          },
          { value: sum ? num(sum.restricted) : '—', label: t('loc.sum.restricted') },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={filters.kind || 'all'}
          onChange={(k) => setF('kind', k === 'all' ? '' : k)}
          items={[
            { key: 'all', label: t('table.all'), ...(sum ? { count: sum.total } : {}) },
            ...SITE_KINDS.map((k) => ({
              key: k,
              label: kindLabel(k),
              ...(kinds ? { count: kinds[k] } : {}),
            })),
          ]}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {t('table.total', { n: tabCount ?? list.page.rowsOnPage })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('loc.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('loc.retry')}
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={list.rows}
            rowId={(r) => r.id}
            activeId={openId}
            loading={list.q.isLoading}
            labels={tableLabels(t)}
            filters={{ ...filters }}
            onFilterChange={(k, v) => setF(k as keyof SiteFilters, v)}
            onRowClick={open}
            rowMenu={(r) => [
              { label: t('loc.menu.view'), icon: 'eye', run: () => open(r) },
              ...(canWrite
                ? [
                    { label: t('loc.menu.edit'), icon: 'pencil', run: () => setForm({ site: r }) },
                    {
                      label: t(r.status === 'active' ? 'loc.menu.off' : 'loc.menu.on'),
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
                      label: t('loc.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/customer-sites/export', {
                          format: 'xlsx',
                          ids: ids.join(','),
                        }).then(
                          () => setToast(t('loc.toast.exported', { n: ids.length })),
                          () => setToast(t('loc.exportFailed')),
                        ),
                    },
                  ],
                }
              : {})}
            onExportCsv={
              canExport
                ? () =>
                    void downloadFile('/v1/customer-sites/export', {
                      format: 'csv',
                      ...filters,
                    }).catch(() => setToast(t('loc.exportFailed')))
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
                  icon="map-pin"
                  title={t('loc.emptyTitle')}
                  description={t('loc.emptyDesc')}
                />
              )
            }
            page={{ ...list.page, ...(tabCount !== undefined ? { total: tabCount } : {}) }}
            onPageSize={list.setSize}
            onNext={list.next}
            onPrev={list.prev}
            onGoto={list.goto}
          />
        )}
      </div>
      {current && (
        <SiteDrawer
          key={current.id}
          site={current}
          ownerName={ownerName}
          canWrite={canWrite}
          onEdit={() => setForm({ site: current })}
          onToggleStatus={() => toggleStatus(current)}
          onDelete={() => setDialog({ kind: 'delete', s: current })}
          onClose={() => {
            setOpenId(null);
            setSelected(null);
          }}
        />
      )}
      <SiteFormDrawer
        open={!!form}
        site={form?.site ?? null}
        onClose={() => setForm(null)}
        onSaved={(s, created) => {
          setForm(null);
          setToast(t(created ? 'loc.toast.created' : 'loc.toast.saved', { n: s.name }));
          open(s);
        }}
      />
      <ReasonDialog
        open={!!dialog}
        title={
          dialog
            ? t(dialog.kind === 'delete' ? 'loc.dlg.delT' : 'loc.dlg.offT', { n: dialog.s.name })
            : ''
        }
        description={dialog ? t(dialog.kind === 'delete' ? 'loc.dlg.delD' : 'loc.dlg.offD') : ''}
        label={t('loc.dlg.reason')}
        placeholder={t('loc.dlg.reasonPh')}
        okLabel={dialog?.kind === 'delete' ? t('loc.menu.delete') : t('loc.menu.off')}
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
          const s = dialog.s;
          action.mutate(
            { id: s.id, version: s.version, action: dialog.kind, reason },
            {
              onSuccess: (updated) => {
                setDialog(null);
                if (dialog.kind === 'delete') {
                  setOpenId(null);
                  setSelected(null);
                  setToast(t('loc.toast.deleted', { n: s.name }));
                } else {
                  if (updated && openId === s.id) setSelected(updated);
                  setToast(t('loc.toast.status', { n: s.name }));
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
