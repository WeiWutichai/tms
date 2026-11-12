import {
  Button,
  DataTable,
  EmptyState,
  Icon,
  KpiCard,
  StatusTabs,
  Tag,
  Toast,
  type Column,
} from '@tms/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate, useI18n, type T } from '../../i18n';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { VehicleActionDialog, type VehicleDialog } from './VehicleActionDialog';
import { VehBadge, VehicleDrawer } from './VehicleDrawer';
import { VehicleFormDrawer } from './VehicleFormDrawer';
import {
  VEHICLE_STATUSES,
  useVehicleList,
  useVehicleSummary,
  useVehicleTypeOptions,
  vehPlate,
  type Vehicle,
  vehicleQuery,
  type VehicleFilters,
  type VehicleStatus,
  type VehTabKey,
} from './useVehicles';
import { ImportExcelButton } from '../imports/ImportExcelButton';

const EMPTY_FILTERS: VehicleFilters = {
  plate: '',
  vehicleTypeId: '',
  ownership: '',
  status: '',
  docAlert: '',
};
const num = (n: number) => n.toLocaleString('th-TH');
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;
const sub = { color: '#3B424C', whiteSpace: 'nowrap' } as const;

/** ป้ายเอกสารใกล้หมด (ต้นแบบ cell isIco: triangle-alert + "N ฉบับ" — มีที่หมดแล้ว = แดง, ใกล้หมด = เหลือง) */
export function DocAlertCell({ v, t }: { v: Vehicle; t: T }) {
  const a = v.docAlert;
  if (!a?.count) return <span style={sub}>—</span>;
  const ex = a.expired > 0;
  return (
    <span
      className="tms-icocell"
      style={{ color: ex ? '#B3322A' : '#8F5500' }}
      data-testid="doc-alert"
    >
      <span className="tms-icocell__i" style={{ background: ex ? '#FBE9E7' : '#FCF0DC' }}>
        <Icon n="triangle-alert" s={16} />
      </span>
      {t('veh.doc.n', { n: a.count })}
    </span>
  );
}

/**
 * รถ → ทะเบียนรถ (ST2-T06 + ST2-T07) — ต้นแบบ TMS v4 specFVeh() + kpisF('fveh') + newWithCf('veh')
 * แท็บ ทั้งหมด/พร้อมใช้/ซ่อม/จอด/ปลดระวาง/รถร่วม พร้อมตัวนับ (GET /vehicles/summary), คอลัมน์ "เอกสารใกล้หมด" (docAlert ≤ 30 วัน),
 * คลิกแถว → โปรไฟล์รถ /fleet/vehicles/:id · PM ถัดไป = P1 แสดง "—" [OPEN spec/12 §3]
 */
export function VehiclesPage() {
  const { t, lang } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const finance = can(scopes, 'reports.finance:read');
  const tenantName = me.data?.tenant.name ?? '';
  const navigate = useNavigate();
  // แท็บ/ตัวกรอง/หน้า จำใน sessionStorage — ไปโปรไฟล์รถแล้วกลับมาอยู่ที่เดิม (review ST2-T07)
  const [filters, setFilters] = useSessionState<VehicleFilters>('tms.fveh.filters', EMPTY_FILTERS);
  const [tab, setTab] = useSessionState<VehTabKey>('tms.fveh.tab', 'all');
  const query = vehicleQuery(tab, filters);
  const list = useVehicleList(query, 'tms.fveh.page');
  const summary = useVehicleSummary();
  const types = useVehicleTypeOptions();
  // drawer รถเปิดจากที่นี่เฉพาะหลังเพิ่มรถ (แก้ไขอยู่ในโปรไฟล์รถ — ต้นแบบ pr.edit)
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<VehicleDialog | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const current = selected ? (list.rows.find((r) => r.id === selected.id) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof VehicleFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const profile = (v: Vehicle, docs = false) =>
    navigate(`/fleet/vehicles/${v.id}${docs ? '?tab=docs' : ''}`);
  const close = () => setSelected(null);

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
        <span className="tms-num" style={{ ...cell, color: '#2257C4', fontWeight: 500 }}>
          {vehPlate(t, r)}
        </span>
      ),
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
    },
    {
      key: 'pair',
      label: t('veh.col.pair'),
      render: (r) => {
        const s = pairText(r);
        return <span style={s === '—' ? sub : cell}>{s}</span>;
      },
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
    },
    {
      key: 'pm',
      label: t('veh.col.pm'),
      // PM = P1 (docs/04 B2.1 ส่วน 3) — ต้นแบบมีคอลัมน์ แสดง "—" [OPEN spec/12 §3]
      render: () => <span style={sub}>—</span>,
    },
    {
      key: 'docAlert',
      label: t('veh.col.doc'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'true', label: t('veh.docf.has') },
          { value: 'false', label: t('veh.docf.ok') },
        ],
      },
      render: (r) => <DocAlertCell v={r} t={t} />,
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
    },
  ];

  const filtered = Object.values(filters).some((v) => v !== '');
  const tabCount = (k: VehTabKey): number | undefined =>
    !sum ? undefined : k === 'all' ? sum.total : k === 'sub' ? sum.subcontract : sum[k];
  // จำนวนรายการ: ไม่กรองคอลัมน์ = ตัวนับของแท็บ · แท็บทั้งหมด + เฉพาะ "มีเอกสารใกล้หมด" = ตัวนับการ์ดเอกสาร
  // · กรองอื่น = รู้เมื่อถึงหน้าสุดท้ายเท่านั้น (API ไม่มี count)
  const docOnly = tab === 'all' && filters.docAlert === 'true';
  const shownTotal = docOnly
    ? listTotal(list, filters, ['docAlert'], sum?.docAlert)
    : listTotal(list, filters, [], tabCount(tab));
  const toggleTab = (k: VehTabKey) => setTab((x) => (x === k ? 'all' : k));
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
            {/* นำเข้า Excel (ST2-T23) · ใบสั่งซ่อม = P1 — แสดงตามต้นแบบแต่ยังกดไม่ได้ [OPEN spec/12 §3] */}
            <ImportExcelButton kind="vehicle" label={t('veh.import')} onDone={setToast} />
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
          active={tab === 'ready'}
          onClick={() => toggleTab('ready')}
        />
        <KpiCard
          label={t('veh.kpi.repair')}
          tone="warn"
          value={sum ? num(sum.maintenance) : '—'}
          sub={t('veh.kpi.click')}
          active={tab === 'maintenance'}
          onClick={() => toggleTab('maintenance')}
        />
        <KpiCard
          label={t('veh.kpi.doc')}
          tone="err"
          value={sum ? num(sum.docAlert) : '—'}
          sub={t('veh.kpi.click')}
          active={filters.docAlert === 'true'}
          onClick={() => setF('docAlert', filters.docAlert === 'true' ? '' : 'true')}
        />
      </div>
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={(k) => setTab(k as VehTabKey)}
          items={(['all', ...VEHICLE_STATUSES, 'sub'] as VehTabKey[]).map((k) => {
            const n = tabCount(k);
            return {
              key: k,
              label:
                k === 'all'
                  ? t('table.all')
                  : k === 'sub'
                    ? t('veh.own.SUBCONTRACT')
                    : t(`veh.st.${k}`),
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
            activeId={null}
            loading={list.loading}
            labels={tableLabels(t)}
            filters={{ ...filters }}
            onFilterChange={(k, v) => setF(k as keyof VehicleFilters, v)}
            onRowClick={(r) => profile(r)}
            rowMenu={(r) => [
              { label: t('veh.menu.view'), icon: 'eye', run: () => profile(r) },
              { label: t('veh.menu.docs'), icon: 'file-badge', run: () => profile(r, true) },
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
              canExport && query
                ? () =>
                    void downloadFile('/v1/vehicles/export', {
                      format: 'csv',
                      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '')),
                    }).catch(() => setToast(t('veh.exportFailed')))
                : false
            }
            empty={
              filtered || tab !== 'all' ? (
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
          setSelected(v);
        }}
      />
      <VehicleActionDialog
        dialog={dialog}
        onClose={() => setDialog(null)}
        onDone={(d, u) => {
          setDialog(null);
          if (d.kind === 'delete') {
            close();
            setToast(t('veh.toast.deleted', { n: vehPlate(t, d.v) }));
          } else {
            if (u && selected?.id === d.v.id) setSelected(u);
            setToast(t('veh.toast.status', { n: vehPlate(t, d.v) }));
          }
        }}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
