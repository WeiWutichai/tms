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
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { CarrierDrawer, taxText } from './CarrierDrawer';
import {
  useCarrierAction,
  useCarrierList,
  useCarrierSummary,
  type Carrier,
  type CarrierFilters,
} from './useCarriers';

const DIALOG = {
  deactivate: { title: 'car.dlg.offT', desc: 'car.dlg.offD', ok: 'car.menu.off' },
  delete: { title: 'car.dlg.delT', desc: 'car.dlg.delD', ok: 'car.menu.delete' },
} as const satisfies Record<string, Record<'title' | 'desc' | 'ok', MessageKey>>;

type Seg = 'drv' | 'con';
/**
 * แท็บเริ่มต้นของหน้า: ต้นแบบเริ่มที่ "คนขับ" แต่หน้าคนขับยังไม่ทำ (ST2-T08) → เริ่มที่ผู้รับเหมาไปก่อน
 * [OPEN spec/12 §3] เปลี่ยนกลับเป็น 'drv' เมื่อ ST2-T08 เสร็จ
 */
const DEFAULT_SEG: Seg = 'con';

const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;

/** ปุ่มสลับ คนขับ | ผู้รับเหมา — ต้นแบบ vx.seg (พื้น #EBEDE8 ขอบ #D9DCD4 มุม 14, ปุ่มเลือก = ขาว ตัวหนา น้ำเงิน) */
function SegSwitch({
  value,
  items,
  onChange,
}: {
  value: Seg;
  items: { key: Seg; label: string; count?: number | undefined }[];
  onChange: (k: Seg) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        alignSelf: 'flex-start',
        gap: 2,
        padding: 3,
        background: '#EBEDE8',
        border: '1px solid #D9DCD4',
        borderRadius: 14,
      }}
    >
      {items.map((s) => {
        const on = s.key === value;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(s.key)}
            style={{
              height: 34,
              padding: '0 14px',
              border: 0,
              borderRadius: 999,
              background: on ? '#FFFFFF' : 'transparent',
              color: on ? '#2257C4' : '#3B424C',
              fontWeight: on ? 600 : 500,
              boxShadow: on ? '0 1px 2px rgba(16,24,40,.08), 0 0 0 1px #D9DCD4' : 'none',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              font: 'inherit',
            }}
          >
            {s.label}
            {s.count !== undefined && (
              <span style={{ color: '#3B424C', fontWeight: 500 }}>{s.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * รถ → คนขับและผู้รับเหมา (ST2-T05 ผู้รับเหมา; คนขับ = ST2-T08) — ต้นแบบ TMS v4 specVeh() con + kpisX('veh' con) + vPanel con
 * โครงหน้าเดียวกับข้อมูลหลักอื่น (หัว + ปุ่มสลับ + แถบสรุป + แท็บสถานะ + ตาราง + drawer)
 * ตรงเวลา/ตีกลับ ยังไม่มีข้อมูล (คำนวณจากเที่ยว — ST3/ST9) → "—" [OPEN spec/12 §3]
 */
export function CarriersPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const [params, setParams] = useSearchParams();
  const seg: Seg =
    params.get('tab') === 'drv' ? 'drv' : params.get('tab') === 'con' ? 'con' : DEFAULT_SEG;
  const [filters, setFilters] = useState<CarrierFilters>({ status: '', name: '', entityType: '' });
  const list = useCarrierList(filters);
  const summary = useCarrierSummary();
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

  return (
    <>
      <PageHeader
        title={t('page.veh.title')}
        sub={t('page.veh.sub')}
        actions={
          seg === 'con' && (
            <>
              {/* นำเข้า Excel = ST2-T23 — แสดงตามต้นแบบแต่ยังกดไม่ได้ [OPEN spec/12 §3] */}
              <Button
                variant="secondary"
                icon="file-spreadsheet"
                disabled
                title={t('car.importSoon')}
              >
                {t('car.import')}
              </Button>
              {canWrite && (
                <Button
                  variant="secondary"
                  icon="plus"
                  onClick={() => {
                    setOpenId(null);
                    setSelected(null);
                    setCreating(true);
                  }}
                >
                  {t('car.add')}
                </Button>
              )}
            </>
          )
        }
      />
      <SegSwitch
        value={seg}
        onChange={(k) => {
          closeDrawer();
          setParams(k === DEFAULT_SEG ? {} : { tab: k }, { replace: true });
        }}
        items={[
          { key: 'drv', label: t('car.seg.drv') },
          { key: 'con', label: t('car.seg.con'), count: s?.total },
        ]}
      />
      {seg === 'drv' ? (
        <EmptyState
          variant="page"
          icon="construction"
          title={t('empty.notReady.title')}
          description={t('empty.notReady.desc', { stage: 'ST2-T08' })}
        />
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
                {t('table.total', {
                  n: onlyStatus && tabCount !== undefined ? tabCount : list.page.rowsOnPage,
                })}
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
                loading={list.q.isLoading}
                labels={tableLabels(t)}
                filters={{ ...filters }}
                onFilterChange={(k, v) => setF(k as keyof CarrierFilters, v)}
                onRowClick={open}
                rowMenu={(r) =>
                  canWrite
                    ? [
                        { label: t('car.menu.edit'), icon: 'pencil', run: () => open(r) },
                        {
                          label: t(r.status === 'active' ? 'car.menu.off' : 'car.menu.on'),
                          icon: r.status === 'active' ? 'pause' : 'play',
                          run: () => toggleStatus(r),
                        },
                      ]
                    : [{ label: t('car.menu.view'), icon: 'eye', run: () => open(r) }]
                }
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
                  ...(onlyStatus && tabCount !== undefined ? { total: tabCount } : {}),
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
        error={problemText(action.error, t)}
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
