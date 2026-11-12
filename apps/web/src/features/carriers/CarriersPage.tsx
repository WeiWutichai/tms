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
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { DriversTab } from '../drivers/DriversTab';
import { useDriverSummary } from '../drivers/useDrivers';
import { listTotal } from '../master/useCursorList';
import { SegSwitch } from '../master/SegSwitch';
import { CarrierDrawer, taxText } from './CarrierDrawer';
import {
  useCarrierAction,
  useCarrierList,
  useCarrierSummary,
  type Carrier,
  type CarrierFilters,
} from './useCarriers';
import { ImportExcelButton } from '../imports/ImportExcelButton';

const DIALOG = {
  deactivate: { title: 'car.dlg.offT', desc: 'car.dlg.offD', ok: 'car.menu.off' },
  delete: { title: 'car.dlg.delT', desc: 'car.dlg.delD', ok: 'car.menu.delete' },
} as const satisfies Record<string, Record<'title' | 'desc' | 'ok', MessageKey>>;

type Seg = 'drv' | 'con';
/** แท็บเริ่มต้นของหน้า = "คนขับ" ตามต้นแบบ (vehTab: 'drv') */
const DEFAULT_SEG: Seg = 'drv';

const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;

/**
 * รถ → คนขับและผู้รับเหมา (ST2-T05 ผู้รับเหมา; ST2-T08 คนขับ — `DriversTab`) — ต้นแบบ TMS v4 specVeh() con + kpisX('veh' con) + vPanel con
 * โครงหน้าเดียวกับข้อมูลหลักอื่น (หัว + ปุ่มสลับ + แถบสรุป + แท็บสถานะ + ตาราง + drawer)
 * ตรงเวลา/ตีกลับ ยังไม่มีข้อมูล (คำนวณจากเที่ยว — ST3/ST9) → "—" [OPEN spec/12 §3]
 */
export function CarriersPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const nav = useNavigate();
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const canBank = can(scopes, 'settlements:pay');
  const [params, setParams] = useSearchParams();
  const seg: Seg =
    params.get('tab') === 'drv' ? 'drv' : params.get('tab') === 'con' ? 'con' : DEFAULT_SEG;
  const [filters, setFilters] = useState<CarrierFilters>({ status: '', name: '', entityType: '' });
  const list = useCarrierList(filters);
  const summary = useCarrierSummary();
  const drvSummary = useDriverSummary();
  const [drvCreating, setDrvCreating] = useState(false);
  const action = useCarrierAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Carrier | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; c: Carrier } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const s = summary.data;

  const setF = (k: keyof CarrierFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const stLabel = (st: string) => t(st === 'active' ? 'car.st.active' : 'car.st.inactive');
  const etLabel = (et: string) => t(et === 'JURISTIC' ? 'car.et.J' : 'car.et.I');
  const open = (c: Carrier) => {
    setCreating(false);
    setOpenId(c.id);
    setSelected(c);
  };
  const closeDrawer = () => {
    setOpenId(null);
    setSelected(null);
    setCreating(false);
  };
  const toggleStatus = (c: Carrier) => {
    if (c.status === 'active') return setDialog({ kind: 'deactivate', c });
    action.mutate(
      { id: c.id, version: c.version, action: 'activate' },
      {
        onSuccess: (u) => {
          if (u && openId === c.id) setSelected(u);
          setToast(t('car.toast.status', { n: c.legalName }));
        },
        onError: (e) => setToast(problemText(e, t)),
      },
    );
  };

  /** ลบไม่ได้ (409 in_use) → บอกว่ามีอะไรอ้างถึง รวมรถปลดระวาง (ไม่นับใน "จำนวนรถ") และให้ใช้ "ระงับชั่วคราว" แทน */
  const actionError = (): string | null => {
    const e = action.error;
    if (e instanceof ApiError && e.problem.code === 'in_use') {
      const refs = (e.problem as { references?: Record<string, number> }).references ?? {};
      const parts = Object.entries(refs)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => t(`car.ref.${k}` as MessageKey, { n }));
      return t('car.delInUse', { refs: parts.join(' · ') });
    }
    return problemText(e, t);
  };

  const columns: Column<Carrier>[] = [
    {
      key: 'name',
      label: t('car.col.name'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span
          title={r.legalName}
          style={{
            ...cell,
            fontWeight: 500,
            display: 'inline-block',
            maxWidth: 420,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            verticalAlign: 'bottom',
          }}
        >
          {r.legalName}
        </span>
      ),
      csv: (r) => r.legalName,
    },
    {
      key: 'tax',
      label: t('car.col.tax'),
      width: '1%',
      render: (r) => (
        <span className="tms-num" style={{ ...cell, fontSize: 13, fontWeight: 400 }}>
          {taxText(r)}
        </span>
      ),
      csv: (r) => taxText(r),
    },
    {
      key: 'entityType',
      label: t('car.col.kind'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'INDIVIDUAL', label: t('car.et.I') },
          { value: 'JURISTIC', label: t('car.et.J') },
        ],
      },
      render: (r) => <Tag>{etLabel(r.entityType)}</Tag>,
      csv: (r) => etLabel(r.entityType),
    },
    {
      key: 'veh',
      label: t('car.col.veh'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{t('car.units', { n: r.usage.vehicles })}</span>,
      csv: (r) => String(r.usage.vehicles),
    },
    {
      key: 'ot',
      label: t('car.col.ot'),
      width: '1%',
      align: 'right',
      render: () => <span style={cell}>—</span>,
      csv: () => '',
    },
    {
      key: 'ret',
      label: t('car.col.ret'),
      width: '1%',
      align: 'right',
      render: () => <span style={cell}>—</span>,
      csv: () => '',
    },
    {
      key: 'wht',
      label: t('car.col.wht'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{`${Number(r.whtRate)}%`}</span>,
      csv: (r) => `${Number(r.whtRate)}%`,
    },
    {
      key: 'status',
      label: t('car.col.st'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'active', label: t('car.st.active') },
          { value: 'inactive', label: t('car.st.inactive') },
        ],
      },
      render: (r) => (
        <StatusDot label={stLabel(r.status)} tone={r.status === 'active' ? 'ok' : 'warn'} />
      ),
      csv: (r) => stLabel(r.status),
    },
  ];

  const tabCount =
    filters.status === 'active'
      ? s?.active
      : filters.status === 'inactive'
        ? s?.inactive
        : s?.total;
  const onlyStatus = !filters.name && !filters.entityType;
  const filtered = !!(filters.status || !onlyStatus);
  // ยอดรวม: ไม่กรองอื่น = ตัวนับของแท็บ · กรองอื่น = รู้เมื่อถึงหน้าสุดท้ายเท่านั้น (ไม่ใช่จำนวนแถวในหน้า)
  const shownTotal = listTotal(list, filters, ['status'], tabCount);

  return (
    <>
      <PageHeader
        title={t('page.veh.title')}
        sub={t('page.veh.sub')}
        actions={
          <>
            {/* นำเข้า Excel (ST2-T23) — ต้นแบบ: ชนิดตามแท็บ (คนขับ / ผู้รับเหมา) */}
            <ImportExcelButton
              key={seg}
              kind={seg === 'drv' ? 'driver' : 'carrier'}
              label={t('car.import')}
              onDone={setToast}
            />
            {canWrite && (
              <Button
                variant="secondary"
                icon="plus"
                onClick={() => {
                  if (seg === 'drv') return setDrvCreating(true);
                  setOpenId(null);
                  setSelected(null);
                  setCreating(true);
                }}
              >
                {t(seg === 'drv' ? 'drv.add' : 'car.add')}
              </Button>
            )}
          </>
        }
      />
      <SegSwitch
        value={seg}
        onChange={(k) => {
          closeDrawer();
          setDrvCreating(false);
          setParams(k === DEFAULT_SEG ? {} : { tab: k }, { replace: true });
        }}
        items={[
          { key: 'drv', label: t('car.seg.drv'), count: drvSummary.data?.total },
          { key: 'con', label: t('car.seg.con'), count: s?.total },
        ]}
      />
      {seg === 'drv' ? (
        <DriversTab creating={drvCreating} onCloseCreate={() => setDrvCreating(false)} />
      ) : (
        <>
          <SummaryStrip
            items={[
              {
                value: s?.total ?? '—',
                label: t('car.sum.total'),
                onClick: () => setF('status', ''),
              },
              {
                value: s?.active ?? '—',
                label: t('car.sum.active'),
                color: '#17733F',
                onClick: () => setF('status', 'active'),
              },
              // ตรงเวลาเฉลี่ยคำนวณจากเที่ยว (ST3/ST9) [OPEN spec/12 §3]
              { value: '—', label: t('car.sum.ot'), color: '#2257C4' },
              {
                value: s?.inactive ?? '—',
                label: t('car.sum.inactive'),
                color: '#8F5500',
                onClick: () => setF('status', 'inactive'),
              },
            ]}
          />
          <div className="tms-listbody">
            <StatusTabs
              value={filters.status || 'all'}
              onChange={(k) => setF('status', k === 'all' ? '' : k)}
              items={[
                { key: 'all', label: t('table.all'), ...(s ? { count: s.total } : {}) },
                { key: 'active', label: t('car.st.active'), ...(s ? { count: s.active } : {}) },
                {
                  key: 'inactive',
                  label: t('car.st.inactive'),
                  ...(s ? { count: s.inactive } : {}),
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
                title={t('car.loadError')}
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
                onFilterChange={(k, v) => setF(k as keyof CarrierFilters, v)}
                onRowClick={open}
                rowMenu={(r) => [
                  ...(canWrite
                    ? [{ label: t('car.menu.edit'), icon: 'pencil', run: () => open(r) }]
                    : [{ label: t('car.menu.view'), icon: 'eye', run: () => open(r) }]),
                  // ต้นแบบ :3735 "ดู rate ขาซื้อ" → หน้า Rate card ฝั่งขาซื้อ กรองผู้รับเหมานี้ (ST2-T14)
                  {
                    label: t('car.menu.rateBuy'),
                    icon: 'tags',
                    run: () =>
                      nav(
                        `/master/rate-cards?side=buy&carrier=${encodeURIComponent(r.id)}&party=${encodeURIComponent(r.legalName)}`,
                      ),
                  },
                  ...(canWrite
                    ? [
                        {
                          label: t(r.status === 'active' ? 'car.menu.off' : 'car.menu.on'),
                          icon: r.status === 'active' ? 'pause' : 'play',
                          run: () => toggleStatus(r),
                        },
                      ]
                    : []),
                ]}
                {...(canExport
                  ? {
                      bulkActions: [
                        {
                          label: t('car.bulk.export'),
                          icon: 'download',
                          run: (ids: string[]) =>
                            downloadFile('/v1/carriers/export', {
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
                  canExport
                    ? () =>
                        void downloadFile('/v1/carriers/export', {
                          format: 'csv',
                          ...filters,
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
                      icon="handshake"
                      title={t('car.emptyTitle')}
                      description={t('car.emptyDesc')}
                    />
                  )
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
        </>
      )}
      {(current || creating) && (
        <CarrierDrawer
          key={current?.id ?? 'new'}
          carrier={creating ? null : current}
          canWrite={canWrite}
          canBank={canBank}
          onSaved={(c, created) => {
            setToast(t(created ? 'car.toast.created' : 'car.toast.saved', { n: c.legalName }));
            if (created) open(c);
            else setSelected(c);
          }}
          onStatusChange={toggleStatus}
          onDelete={() => current && setDialog({ kind: 'delete', c: current })}
          onClose={closeDrawer}
        />
      )}
      <ReasonDialog
        open={!!dialog}
        title={dialog ? t(DIALOG[dialog.kind].title, { n: dialog.c.legalName }) : ''}
        description={dialog ? t(DIALOG[dialog.kind].desc) : ''}
        label={t('car.dlg.reason')}
        placeholder={t('car.dlg.reasonPh')}
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
          const { c, kind } = dialog;
          action.mutate(
            { id: c.id, version: c.version, action: kind, reason },
            {
              onSuccess: (updated) => {
                setDialog(null);
                if (kind === 'delete') {
                  closeDrawer();
                  setToast(t('car.toast.deleted', { n: c.legalName }));
                } else {
                  if (updated && openId === c.id) setSelected(updated);
                  setToast(t('car.toast.status', { n: c.legalName }));
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
