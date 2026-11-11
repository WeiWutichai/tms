import {
  Button,
  DataTable,
  EmptyState,
  ReasonDialog,
  StatusDot,
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
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { VehicleTypeDrawer, cbmText, kgText, licLabel } from './VehicleTypeDrawer';
import { VehicleTypeFormDrawer } from './VehicleTypeFormDrawer';
import {
  LICENCE_CLASSES,
  useVehicleTypeAction,
  useVehicleTypeList,
  useVehicleTypeSummary,
  type VehicleType,
  type VehicleTypeFilters,
} from './useVehicleTypes';

const EMPTY_FILTERS: VehicleTypeFilters = { name: '', minLicenceClass: '' };

const DIALOG = {
  deactivate: { title: 'vt.dlg.offT', desc: 'vt.dlg.offD', ok: 'vt.menu.off' },
  delete: { title: 'vt.dlg.delT', desc: 'vt.dlg.delD', ok: 'vt.menu.delete' },
} as const satisfies Record<string, Record<'title' | 'desc' | 'ok', MessageKey>>;

const num = (n: number) => n.toLocaleString('th-TH');
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;

/**
 * ข้อมูลหลัก → ประเภทรถ (ST2-T04) — ต้นแบบ TMS v4 specVt() + kpisX('vtype') + cfVt() + vPanelApi vt
 * โครงหน้าเดียวกับลูกค้า/สถานที่ (หัว + แถบสรุป + แท็บ + ตาราง + drawer) · ต้นแบบมีแท็บเดียว "ทั้งหมด"
 * ความสามารถพิเศษ (ห้องเย็น ติดเครน ลากตู้ …) แสดงเป็นป้ายต่อท้ายชื่อ — ต้นแบบไม่มี [OPEN spec/12 §3]
 */
export function VehicleTypesPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const [filters, setFilters] = useState<VehicleTypeFilters>(EMPTY_FILTERS);
  const list = useVehicleTypeList(filters);
  const summary = useVehicleTypeSummary();
  const action = useVehicleTypeAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<VehicleType | null>(null);
  const [form, setForm] = useState<{ vt: VehicleType | null } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; v: VehicleType } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof VehicleTypeFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (v: VehicleType) => {
    setOpenId(v.id);
    setSelected(v);
  };
  const toggleStatus = (v: VehicleType) => {
    if (v.status === 'active') return setDialog({ kind: 'deactivate', v });
    action.mutate(
      { id: v.id, version: v.version, action: 'activate' },
      {
        onSuccess: (u) => {
          if (u && openId === v.id) setSelected(u);
          setToast(t('vt.toast.status', { n: v.name }));
        },
        onError: (e) => setToast(problemText(e, t)),
      },
    );
  };
  /** ปิดใช้ไม่ได้เพราะยังมีรถในทะเบียน (MD-094) → ข้อความเฉพาะ แทน "ลบไม่ได้…" ของ problem.in_use */
  const actionError = (): string | null => {
    const e = action.error;
    if (dialog?.kind === 'deactivate' && e instanceof ApiError && e.problem.code === 'in_use') {
      const refs = (e.problem as { references?: { vehicles?: number } }).references;
      return t('vt.offInUse', { n: num(refs?.vehicles ?? 0) });
    }
    return problemText(e, t);
  };

  const columns: Column<VehicleType>[] = [
    {
      key: 'name',
      label: t('vt.col.name'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: 420 }}>
          <span
            title={r.name}
            style={{ ...cell, overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}
          >
            {r.name}
          </span>
          {r.capabilityTags.map((c) => (
            <Tag key={c}>{t(`vt.tag.${c}` as MessageKey)}</Tag>
          ))}
        </span>
      ),
      csv: (r) => r.name,
    },
    {
      key: 'cap',
      label: t('vt.col.cap'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{kgText(t, r)}</span>,
      csv: (r) => String(r.payloadKg ?? ''),
    },
    {
      key: 'vol',
      label: t('vt.col.vol'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{cbmText(t, r)}</span>,
      csv: (r) => String(r.volumeCbm ?? ''),
    },
    {
      key: 'minLicenceClass',
      label: t('vt.col.lic'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...LICENCE_CLASSES.map((k) => ({ value: k, label: licLabel(t, k) })),
        ],
      },
      render: (r) => <Tag>{licLabel(t, r.minLicenceClass)}</Tag>,
      csv: (r) => licLabel(t, r.minLicenceClass),
    },
    {
      key: 'veh',
      label: t('vt.col.veh'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{t('vt.units', { n: num(r.usage.vehicles) })}</span>,
      csv: (r) => String(r.usage.vehicles),
    },
    {
      key: 'rc',
      label: t('vt.col.rc'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{t('vt.items', { n: num(r.usage.rateCards) })}</span>,
      csv: (r) => String(r.usage.rateCards),
    },
    {
      key: 'status',
      label: t('vt.col.st'),
      width: '1%',
      render: (r) => (
        <StatusDot
          label={t(r.status === 'active' ? 'vt.st.active' : 'vt.st.inactive')}
          tone={r.status === 'active' ? 'ok' : 'off'}
        />
      ),
      csv: (r) => t(r.status === 'active' ? 'vt.st.active' : 'vt.st.inactive'),
    },
  ];

  const filtered = Object.values(filters).some((v) => v !== '');

  return (
    <>
      <PageHeader
        title={t('page.vtype.title')}
        sub={t('page.vtype.sub')}
        actions={
          canWrite && (
            <Button variant="primary" icon="plus" onClick={() => setForm({ vt: null })}>
              {t('vt.add')}
            </Button>
          )
        }
      />
      <SummaryStrip
        items={[
          { value: sum ? num(sum.total) : '—', label: t('vt.sum.types') },
          {
            value: sum ? t('vt.units', { n: num(sum.vehicles) }) : '—',
            label: t('vt.sum.vehicles'),
            color: '#2257C4',
          },
          { value: sum ? num(sum.rateCards) : '—', label: t('vt.sum.rates') },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value="all"
          onChange={() => undefined}
          items={[{ key: 'all', label: t('table.all'), ...(sum ? { count: sum.total } : {}) }]}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {t('table.total', {
              n: !filtered && sum ? sum.total : list.page.rowsOnPage,
            })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('vt.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('vt.retry')}
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
            onFilterChange={(k, v) => setF(k as keyof VehicleTypeFilters, v)}
            onRowClick={open}
            rowMenu={(r) => [
              { label: t('vt.menu.view'), icon: 'eye', run: () => open(r) },
              ...(canWrite
                ? [
                    { label: t('vt.menu.edit'), icon: 'pencil', run: () => setForm({ vt: r }) },
                    {
                      label: t(r.status === 'active' ? 'vt.menu.off' : 'vt.menu.on'),
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
                      label: t('vt.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/vehicle-types/export', {
                          format: 'xlsx',
                          ids: ids.join(','),
                        }).then(
                          () => setToast(t('vt.toast.exported', { n: ids.length })),
                          () => setToast(t('vt.exportFailed')),
                        ),
                    },
                  ],
                }
              : {})}
            onExportCsv={
              canExport
                ? () =>
                    void downloadFile('/v1/vehicle-types/export', {
                      format: 'csv',
                      ...filters,
                    }).catch(() => setToast(t('vt.exportFailed')))
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
                  title={t('vt.emptyTitle')}
                  description={t('vt.emptyDesc')}
                />
              )
            }
            page={{ ...list.page, ...(!filtered && sum ? { total: sum.total } : {}) }}
            onPageSize={list.setSize}
            onNext={list.next}
            onPrev={list.prev}
            onGoto={list.goto}
          />
        )}
      </div>
      {current && (
        <VehicleTypeDrawer
          key={current.id}
          vt={current}
          canWrite={canWrite}
          onEdit={() => setForm({ vt: current })}
          onToggleStatus={() => toggleStatus(current)}
          onDelete={() => setDialog({ kind: 'delete', v: current })}
          onClose={() => {
            setOpenId(null);
            setSelected(null);
          }}
        />
      )}
      <VehicleTypeFormDrawer
        open={!!form}
        vt={form?.vt ?? null}
        onClose={() => setForm(null)}
        onSaved={(v, created) => {
          setForm(null);
          setToast(t(created ? 'vt.toast.created' : 'vt.toast.saved', { n: v.name }));
          open(v);
        }}
      />
      <ReasonDialog
        open={!!dialog}
        title={dialog ? t(DIALOG[dialog.kind].title, { n: dialog.v.name }) : ''}
        description={dialog ? t(DIALOG[dialog.kind].desc) : ''}
        label={t('vt.dlg.reason')}
        placeholder={t('vt.dlg.reasonPh')}
        okLabel={dialog ? t(DIALOG[dialog.kind].ok) : ''}
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
          const { v, kind } = dialog;
          action.mutate(
            { id: v.id, version: v.version, action: kind, reason },
            {
              onSuccess: (updated) => {
                setDialog(null);
                if (kind === 'delete') {
                  setOpenId(null);
                  setSelected(null);
                  setToast(t('vt.toast.deleted', { n: v.name }));
                } else {
                  if (updated && openId === v.id) setSelected(updated);
                  setToast(t('vt.toast.status', { n: v.name }));
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
