import {
  Badge,
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
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { vehPlate } from '../vehicles/useVehicles';
import {
  DriverBadge,
  DriverDrawer,
  dayText,
  licLabel,
  licenceAlert,
  typeLabel,
} from './DriverDrawer';
import {
  DRIVER_STATUSES,
  EMPLOYMENT_TYPES,
  LICENCE_CLASSES,
  driverQuery,
  useDriverAction,
  useDriverList,
  useDriverSummary,
  type Driver,
  type DriverFilters,
  type DriverStatus,
  type DrvTabKey,
} from './useDrivers';

const EMPTY_FILTERS: DriverFilters = {
  name: '',
  employmentType: '',
  licenceClass: '',
  affiliation: '',
  status: '',
  licenceAlert: '',
};
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;
const STATUS_KEY: Record<DriverStatus, MessageKey> = {
  active: 'drv.st.active',
  on_leave: 'drv.st.on_leave',
  inactive: 'drv.st.inactive',
};

type Dialog = { kind: 'status'; d: Driver; to: DriverStatus } | { kind: 'delete'; d: Driver };

/**
 * รถ → คนขับและผู้รับเหมา แท็บ "คนขับ" (ST2-T08) — ต้นแบบ TMS v4 specVeh() drv + kpisX('veh' drv) + vPanel drv
 * แถบสรุป 4 ช่อง (ทั้งหมด · พร้อมใช้ · ใบขับขี่ใกล้หมดอายุ 30 วัน · คนขับรถร่วม), แท็บสถานะ, ตาราง ชื่อ · เบอร์ · ประเภท · ใบขับขี่ · สังกัด · รถประจำ · สถานะ
 * [OPEN spec/12 §3]: แท็บ/สถานะ "ระหว่างงาน" ต้องมีเที่ยว (ST3) — ยังไม่แสดง · เพิ่มแท็บ "ปิดใช้งาน" (คนขับที่พ้นสภาพ)
 */
export function DriversTab({
  creating,
  onCloseCreate,
}: {
  creating: boolean;
  onCloseCreate: () => void;
}) {
  const { t, lang } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const tenantName = me.data?.tenant.name ?? '';
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const [filters, setFilters] = useSessionState<DriverFilters>('tms.drv.filters', EMPTY_FILTERS);
  const [tab, setTab] = useSessionState<DrvTabKey>('tms.drv.tab', 'all');
  const query = driverQuery(tab, filters);
  const list = useDriverList(query);
  const summary = useDriverSummary();
  const action = useDriverAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Driver | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const s = summary.data;

  const setF = (k: keyof DriverFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (d: Driver) => {
    onCloseCreate();
    setOpenId(d.id);
    setSelected(d);
  };
  const closeDrawer = () => {
    setOpenId(null);
    setSelected(null);
    onCloseCreate();
  };
  const affiliation = (r: Driver) => (r.carrier ? r.carrier.legalName : tenantName);

  const columns: Column<Driver>[] = [
    {
      key: 'name',
      label: t('drv.col.name'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span
          title={r.name}
          style={{
            ...cell,
            display: 'inline-block',
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            verticalAlign: 'bottom',
          }}
        >
          {r.name}
        </span>
      ),
    },
    {
      key: 'phone',
      label: t('drv.col.phone'),
      width: '1%',
      render: (r) => (
        <span className="tms-num" style={cell}>
          {r.phone}
        </span>
      ),
    },
    {
      key: 'employmentType',
      label: t('drv.col.type'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...EMPLOYMENT_TYPES.map((e) => ({ value: e, label: typeLabel(t, e) })),
        ],
      },
      render: (r) => <Tag>{typeLabel(t, r.employmentType)}</Tag>,
    },
    {
      key: 'licenceClass',
      label: t('drv.col.lic'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...LICENCE_CLASSES.map((c) => ({ value: c, label: licLabel(t, c) })),
        ],
      },
      render: (r) => {
        const a = r.status !== 'inactive' ? licenceAlert(r) : null;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-testid="lic-cell">
            <span style={cell}>
              {`${licLabel(t, r.licenceClass)} · ${dayText(r.licenceExpiresOn, lang, ys)}`}
            </span>
            {a && <Badge label={t(a === 'expired' ? 'drv.lic.expired' : 'drv.lic.soon')} />}
          </div>
        );
      },
    },
    {
      key: 'affiliation',
      label: t('drv.col.aff'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span
          title={affiliation(r)}
          style={{
            ...cell,
            display: 'inline-block',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            verticalAlign: 'bottom',
          }}
        >
          {affiliation(r)}
        </span>
      ),
    },
    {
      key: 'veh',
      label: t('drv.col.veh'),
      width: '1%',
      render: (r) => (
        <span className="tms-num" style={cell}>
          {r.defaultVehicle ? vehPlate(t, r.defaultVehicle) : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      label: t('drv.col.st'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...DRIVER_STATUSES.map((x) => ({ value: x, label: t(STATUS_KEY[x]) })),
        ],
      },
      render: (r) => <DriverBadge d={r} t={t} />,
    },
  ];

  const tabCount = (k: DrvTabKey): number | undefined =>
    !s
      ? undefined
      : k === 'all'
        ? s.total
        : k === 'active'
          ? s.active
          : k === 'on_leave'
            ? s.onLeave
            : s.inactive;
  // ยอดรวม: ไม่กรองคอลัมน์ = ตัวนับของแท็บ · แท็บทั้งหมด + เฉพาะการ์ด "ใบขับขี่ใกล้หมด" / "คนขับรถร่วม" = ตัวนับการ์ด
  const only = (k: keyof DriverFilters, v: string) =>
    tab === 'all' &&
    filters[k] === v &&
    Object.entries(filters).every(([kk, vv]) => kk === k || vv === '');
  const shownTotal = only('licenceAlert', 'true')
    ? listTotal(list, filters, ['licenceAlert'], s?.licenceAlert)
    : listTotal(list, filters, [], tabCount(tab));
  const filtered = Object.values(filters).some((v) => v !== '') || tab !== 'all';

  const actionError = (): string | null => {
    const e = action.error;
    if (e instanceof ApiError && e.problem.code === 'duplicate') {
      const ex = (e.problem as { existing?: { code: string; name: string } }).existing;
      if (ex) return t('drv.v.dupReactivate', { code: ex.code, name: ex.name });
    }
    if (e instanceof ApiError && e.problem.code === 'in_use') return t('drv.delInUse');
    return problemText(e, t);
  };

  return (
    <>
      <SummaryStrip
        items={[
          {
            value: s?.total ?? '—',
            label: t('drv.sum.total'),
            onClick: () => {
              setTab('all');
              setFilters(EMPTY_FILTERS);
            },
          },
          {
            value: s?.active ?? '—',
            label: t('drv.sum.active'),
            color: '#17733F',
            onClick: () => setTab((x) => (x === 'active' ? 'all' : 'active')),
          },
          {
            value: s?.licenceAlert ?? '—',
            label: t('drv.sum.lic'),
            color: '#8F5500',
            onClick: () => setF('licenceAlert', filters.licenceAlert === 'true' ? '' : 'true'),
          },
          {
            value: s?.carrierDrivers ?? '—',
            label: t('drv.sum.sub'),
            color: '#2257C4',
            onClick: () =>
              setF(
                'employmentType',
                filters.employmentType === 'CARRIER_DRIVER' ? '' : 'CARRIER_DRIVER',
              ),
          },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={(k) => setTab(k as DrvTabKey)}
          items={(['all', ...DRIVER_STATUSES] as DrvTabKey[]).map((k) => {
            const n = tabCount(k);
            return {
              key: k,
              label: k === 'all' ? t('table.all') : t(STATUS_KEY[k]),
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
            title={t('drv.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('car.retry')}
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
            filters={{ ...filters }}
            onFilterChange={(k, v) => setF(k as keyof DriverFilters, v)}
            onRowClick={open}
            rowMenu={(r) => [
              canWrite
                ? { label: t('car.menu.edit'), icon: 'pencil', run: () => open(r) }
                : { label: t('car.menu.view'), icon: 'eye', run: () => open(r) },
              {
                label: t('drv.menu.call'),
                icon: 'phone',
                run: () => {
                  window.location.href = `tel:${r.phone.replace(/[^\d+]/g, '')}`;
                },
              },
            ]}
            {...(canExport
              ? {
                  bulkActions: [
                    {
                      label: t('car.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/drivers/export', {
                          format: 'xlsx',
                          ids: ids.join(','),
                        }).then(
                          () => setToast(t('car.toast.exported', { n: ids.length })),
                          () => setToast(t('car.exportFailed')),
                        ),
                    },
                  ],
                }
              : {})}
            onExportCsv={
              canExport && query
                ? () =>
                    void downloadFile('/v1/drivers/export', {
                      format: 'csv',
                      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '')),
                    }).catch(() => setToast(t('car.exportFailed')))
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
                  icon="id-card"
                  title={t('drv.emptyTitle')}
                  description={t('car.emptyDesc')}
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
      {(current || creating) && (
        <DriverDrawer
          key={current?.id ?? 'new'}
          driver={creating ? null : current}
          canWrite={canWrite}
          tenantName={tenantName}
          onSaved={(d, created) => {
            setToast(t(created ? 'car.toast.created' : 'car.toast.saved', { n: d.name }));
            if (created) open(d);
            else setSelected(d);
          }}
          onStatusChange={(d, to) => setDialog({ kind: 'status', d, to })}
          onDelete={() => current && setDialog({ kind: 'delete', d: current })}
          onClose={closeDrawer}
        />
      )}
      <ReasonDialog
        open={!!dialog}
        title={
          dialog
            ? dialog.kind === 'delete'
              ? t('drv.dlg.delT', { n: dialog.d.name })
              : t('drv.dlg.statusT', { n: dialog.d.name, s: t(STATUS_KEY[dialog.to]) })
            : ''
        }
        description={
          dialog
            ? t(
                dialog.kind === 'delete'
                  ? 'drv.dlg.delD'
                  : dialog.to === 'inactive'
                    ? 'drv.dlg.offD'
                    : 'drv.dlg.statusD',
              )
            : ''
        }
        label={t('car.dlg.reason')}
        placeholder={t('drv.dlg.reasonPh')}
        okLabel={dialog?.kind === 'delete' ? t('drv.menu.delete') : t('drv.dlg.ok')}
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
              ? { id: d.d.id, version: d.d.version, action: 'delete', reason }
              : { id: d.d.id, version: d.d.version, action: 'status', status: d.to, reason },
            {
              onSuccess: (u) => {
                setDialog(null);
                if (d.kind === 'delete') {
                  closeDrawer();
                  setToast(t('car.toast.deleted', { n: d.d.name }));
                } else {
                  if (u && openId === d.d.id) setSelected(u);
                  setToast(t('car.toast.status', { n: d.d.name }));
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
