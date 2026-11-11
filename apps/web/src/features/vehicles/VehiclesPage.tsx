import {
  Button,
  DataTable,
  EmptyState,
  KpiCard,
  ReasonDialog,
  StatusTabs,
  Tag,
  Toast,
  type Column,
} from '@tms/ui';
import { useState } from 'react';
import { ApiError } from '../../api';
import { formatDate, useI18n } from '../../i18n';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { VehBadge, VehicleDrawer, type VehTab } from './VehicleDrawer';
import { VehicleFormDrawer } from './VehicleFormDrawer';
import {
  VEHICLE_STATUSES,
  useVehicleAction,
  useVehicleList,
  useVehicleSummary,
  useVehicleTypeOptions,
  vehPlate,
  type Vehicle,
  type VehicleFilters,
  type VehicleStatus,
} from './useVehicles';

const EMPTY_FILTERS: VehicleFilters = { plate: '', vehicleTypeId: '', ownership: '', status: '' };
const num = (n: number) => n.toLocaleString('th-TH');
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;
const sub = { color: '#3B424C', whiteSpace: 'nowrap' } as const;

type Dialog = { kind: 'status'; v: Vehicle; to: VehicleStatus } | { kind: 'delete'; v: Vehicle };

/**
 * รถ → ทะเบียนรถ (ST2-T06) — ต้นแบบ TMS v4 specFVeh() + kpisF('fveh') + newWithCf('veh') + vPanel veh
 * ST2-T07 จะเพิ่ม: แท็บสถานะพร้อมตัวนับ (พร้อมใช้/ซ่อม/จอด/ปลดระวาง/รถร่วม), คอลัมน์เอกสารใกล้หมด, หน้าโปรไฟล์รถ
 * (ตอนนี้แท็บมี "ทั้งหมด" และคลิกแถวเปิด drawer แก้ไข) · PM ถัดไป = P1 แสดง "—" [OPEN spec/12 §3]
 */
export function VehiclesPage() {
  const { t, lang } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const finance = can(scopes, 'reports.finance:read');
  const tenantName = me.data?.tenant.name ?? '';
  const [filters, setFilters] = useState<VehicleFilters>(EMPTY_FILTERS);
  const list = useVehicleList(filters);
  const summary = useVehicleSummary();
  const types = useVehicleTypeOptions();
  const action = useVehicleAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<VehTab>('info');
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof VehicleFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (v: Vehicle, tab: VehTab = 'info') => {
    setOpenTab(tab);
    setOpenId(v.id);
    setSelected(v);
  };
  const close = () => {
    setOpenId(null);
    setSelected(null);
  };

  const actionError = (): string | null => {
    const e = action.error;
    if (e instanceof ApiError && e.problem.code === 'in_use_active') {
      const refs = (e.problem as { references?: { trips?: number } }).references;
      return t('veh.retireBusy', { n: num(refs?.trips ?? 0) });
    }
    return problemText(e, t);
  };

  const pairText = (r: Vehicle) =>
    r.paired && r.unitRole !== 'SINGLE'
      ? t(r.unitRole === 'TRACTOR' ? 'veh.pair.TRACTOR' : 'veh.pair.TRAILER', {
          p: vehPlate(t, r.paired),
        })
      : '—';

  const columns: Column<Vehicle>[] = [
    {
      key: 'plate',
      label: t('veh.col.plate'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span className="tms-num" style={{ ...cell, fontWeight: 500 }}>
          {vehPlate(t, r)}
        </span>
      ),
      csv: (r) => vehPlate(t, r),
    },
    {
      key: 'model',
      label: t('veh.col.model'),
      render: (r) => {
        const bm = [r.brand, r.model].filter(Boolean).join(' ');
        return (
          <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 240 }}>
            <span title={bm} style={{ ...cell, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {bm || '—'}
            </span>
            {r.year !== null && <span style={sub}>{t('veh.year', { y: r.year })}</span>}
          </div>
        );
      },
      csv: (r) => [r.brand, r.model, r.year].filter(Boolean).join(' '),
    },
    {
      key: 'vehicleTypeId',
      label: t('veh.col.type'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...(types.data ?? []).map((x) => ({ value: x.id, label: x.name })),
        ],
      },
      render: (r) => <Tag>{r.vehicleType.name}</Tag>,
      csv: (r) => r.vehicleType.name,
    },
    {
      key: 'pair',
      label: t('veh.col.pair'),
      render: (r) => {
        const s = pairText(r);
        return <span style={s === '—' ? sub : cell}>{s}</span>;
      },
      csv: (r) => pairText(r),
    },
    {
      key: 'odo',
      label: t('veh.col.odo'),
      width: '1%',
      align: 'right',
      render: (r) => (
        <span className="tms-num" style={cell}>
          {r.odometerKm === null ? '—' : num(r.odometerKm)}
        </span>
      ),
      csv: (r) => (r.odometerKm === null ? '' : String(r.odometerKm)),
    },
    {
      key: 'ownership',
      label: t('veh.col.own'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'OWN', label: t('veh.own.OWN') },
          { value: 'SUBCONTRACT', label: t('veh.own.SUBCONTRACT') },
        ],
      },
      render: (r) => {
        const n = r.ownership === 'OWN' ? tenantName : (r.carrier?.name ?? '');
        return (
          <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 200 }}>
            <span style={cell}>
              {t(r.ownership === 'OWN' ? 'veh.own.OWN' : 'veh.own.SUBCONTRACT')}
            </span>
            <span title={n} style={{ ...sub, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {n}
            </span>
          </div>
        );
      },
      csv: (r) => (r.ownership === 'OWN' ? tenantName : (r.carrier?.name ?? '')),
    },
    {
      key: 'pm',
      label: t('veh.col.pm'),
      // PM = P1 (docs/04 B2.1 ส่วน 3) — ต้นแบบมีคอลัมน์ แสดง "—" [OPEN spec/12 §3]
      render: () => <span style={sub}>—</span>,
      csv: () => '',
    },
    {
      key: 'status',
      label: t('veh.col.st'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...VEHICLE_STATUSES.map((s) => ({ value: s, label: t(`veh.st.${s}`) })),
        ],
      },
      render: (r) => <VehBadge v={r} t={t} />,
      csv: (r) => t(`veh.st.${r.status}`),
    },
  ];

  const filtered = Object.values(filters).some((v) => v !== '');
  // จำนวนรายการ: ไม่กรอง = ทั้งหมด · กรองเฉพาะสถานะ (การ์ด/คอลัมน์สถานะ) = ตัวนับจาก summary · กรองอื่น = ไม่แสดง (รู้แค่หน้านี้ — QA ST2-T06)
  const statusOnly =
    !!filters.status && !filters.plate && !filters.vehicleTypeId && !filters.ownership;
  const shownTotal = !sum
    ? undefined
    : !filtered
      ? sum.total
      : statusOnly
        ? sum[filters.status as VehicleStatus]
        : undefined;
  const today = formatDate(new Date(), lang, (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE');

  return (
    <>
      <PageHeader
        title={t('page.fveh.title')}
        sub={t('page.fveh.sub')}
        actions={
          <>
            {canWrite && (
              <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>
                {t('veh.add')}
              </Button>
            )}
            {/* นำเข้า Excel = ST2-T23 · ใบสั่งซ่อม = P1 — แสดงตามต้นแบบแต่ยังกดไม่ได้ [OPEN spec/12 §3] */}
            <Button
              variant="secondary"
              icon="file-spreadsheet"
              disabled
              title={t('veh.importSoon')}
            >
              {t('veh.import')}
            </Button>
            <Button variant="secondary" icon="wrench" disabled title={t('veh.woSoon')}>
              {t('veh.newWo')}
            </Button>
          </>
        }
      />
      <div className="tms-kpis">
        <KpiCard
          label={t('veh.kpi.total')}
          value={sum ? num(sum.total) : '—'}
          sub={t('veh.kpi.asOf', { d: today })}
        />
        <KpiCard
          label={t('veh.kpi.ready')}
          tone="ok"
          value={sum ? num(sum.ready) : '—'}
          sub={t('veh.kpi.click')}
          active={filters.status === 'ready'}
          onClick={() => setF('status', filters.status === 'ready' ? '' : 'ready')}
        />
        <KpiCard
          label={t('veh.kpi.repair')}
          tone="warn"
          value={sum ? num(sum.maintenance) : '—'}
          sub={t('veh.kpi.click')}
          active={filters.status === 'maintenance'}
          onClick={() => setF('status', filters.status === 'maintenance' ? '' : 'maintenance')}
        />
        {/* เอกสารรถ = ST2-T17 — ยังไม่มีข้อมูล แสดง "—" [OPEN spec/12 §3] */}
        <KpiCard label={t('veh.kpi.doc')} tone="err" value="—" sub={t('veh.kpi.docSoon')} />
      </div>
      <div className="tms-listbody">
        <StatusTabs
          value="all"
          onChange={() => undefined}
          items={[{ key: 'all', label: t('table.all'), ...(sum ? { count: sum.total } : {}) }]}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('veh.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('veh.retry')}
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
            filters={{
              plate: filters.plate,
              vehicleTypeId: filters.vehicleTypeId,
              ownership: filters.ownership,
              status: filters.status,
            }}
            onFilterChange={(k, v) => setF(k as keyof VehicleFilters, v)}
            onRowClick={(r) => open(r)}
            rowMenu={(r) => [
              { label: t('veh.menu.view'), icon: 'eye', run: () => open(r) },
              { label: t('veh.menu.docs'), icon: 'file-badge', run: () => open(r, 'docs') },
            ]}
            {...(canExport
              ? {
                  bulkActions: [
                    {
                      label: t('veh.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/vehicles/export', {
                          format: 'xlsx',
                          ids: ids.join(','),
                        }).then(
                          () => setToast(t('veh.toast.exported', { n: ids.length })),
                          () => setToast(t('veh.exportFailed')),
                        ),
                    },
                  ],
                }
              : {})}
            onExportCsv={
              canExport
                ? () =>
                    void downloadFile('/v1/vehicles/export', { format: 'csv', ...filters }).catch(
                      () => setToast(t('veh.exportFailed')),
                    )
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
                  icon="truck"
                  title={t('veh.emptyTitle')}
                  description={t('veh.emptyDesc')}
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
        <VehicleDrawer
          key={current.id}
          v={current}
          canWrite={canWrite}
          finance={finance}
          tenantName={tenantName}
          initialTab={openTab}
          onStatusChange={(v, to) => setDialog({ kind: 'status', v, to })}
          onDelete={() => setDialog({ kind: 'delete', v: current })}
          onSaved={(u) => {
            setSelected(u);
            setToast(t('veh.toast.saved', { n: vehPlate(t, u) }));
          }}
          onClose={close}
        />
      )}
      <VehicleFormDrawer
        open={creating}
        finance={finance}
        tenantName={tenantName}
        quota={sum?.quota}
        onClose={() => setCreating(false)}
        onSaved={(v) => {
          setCreating(false);
          setToast(t('veh.toast.created', { n: vehPlate(t, v) }));
          open(v);
        }}
      />
      <ReasonDialog
        open={!!dialog}
        title={
          dialog
            ? dialog.kind === 'delete'
              ? t('veh.dlg.delT', { n: vehPlate(t, dialog.v) })
              : t('veh.dlg.statusT', { n: vehPlate(t, dialog.v), s: t(`veh.st.${dialog.to}`) })
            : ''
        }
        description={
          dialog
            ? t(
                dialog.kind === 'delete'
                  ? 'veh.dlg.delD'
                  : dialog.to === 'retired'
                    ? 'veh.dlg.retireD'
                    : 'veh.dlg.statusD',
              )
            : ''
        }
        label={t('veh.dlg.reason')}
        placeholder={t('veh.dlg.reasonPh')}
        okLabel={dialog?.kind === 'delete' ? t('veh.menu.delete') : t('veh.dlg.ok')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={action.isPending}
        error={actionError()}
        onClose={() => {
          setDialog(null);
          action.reset();
        }}
        onOk={(reason) => {
          if (!dialog) return;
          const d = dialog;
          action.mutate(
            d.kind === 'delete'
              ? { id: d.v.id, version: d.v.version, action: 'delete', reason }
              : { id: d.v.id, version: d.v.version, action: 'status', status: d.to, reason },
            {
              onSuccess: (u) => {
                setDialog(null);
                if (d.kind === 'delete') {
                  close();
                  setToast(t('veh.toast.deleted', { n: vehPlate(t, d.v) }));
                } else {
                  if (u && openId === d.v.id) setSelected(u);
                  setToast(t('veh.toast.status', { n: vehPlate(t, d.v) }));
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
