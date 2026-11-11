import {
  Button,
  DataTable,
  DocNo,
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
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { CustomerCreateDrawer } from './CustomerCreateDrawer';
import { CustomerDrawer } from './CustomerDrawer';
import {
  useCustomerAction,
  useCustomerList,
  useCustomerSummary,
  type Customer,
  type CustomerFilters,
} from './useCustomers';

const CYCLES = ['PER_DO', 'WEEKLY', 'MONTHLY', 'MANUAL'] as const;

/**
 * ข้อมูลหลัก → ลูกค้า (ST2-T01) — ต้นแบบ TMS v4 specCust() + kpisX('cust') + vPanel cust
 * โครงหน้า (หัว + แถบสรุป + แท็บสถานะ + ตาราง + drawer) เป็นแบบของข้อมูลหลักทุกตัว
 */
export function CustomersPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const [filters, setFilters] = useState<CustomerFilters>({
    status: '',
    billingCycle: '',
    code: '',
    name: '',
  });
  const list = useCustomerList(filters);
  const summary = useCustomerSummary();
  const action = useCustomerAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; c: Customer } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const s = summary.data;

  const setF = (k: keyof CustomerFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const statusLabel = (st: string) => t(st === 'active' ? 'cust.st.active' : 'cust.st.inactive');
  const open = (c: Customer) => {
    setOpenId(c.id);
    setSelected(c);
  };

  const toggleStatus = (c: Customer) => {
    if (c.status === 'active') return setDialog({ kind: 'deactivate', c });
    action.mutate(
      { id: c.id, action: 'activate' },
      { onSuccess: () => setToast(t('cust.toast.status', { n: c.legalName })) },
    );
  };

  const columns: Column<Customer>[] = [
    {
      key: 'code',
      label: t('cust.col.code'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => <DocNo>{r.code}</DocNo>,
      csv: (r) => r.code,
    },
    {
      key: 'name',
      label: t('cust.col.name'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => <span style={{ color: '#101418' }}>{r.legalName}</span>,
      csv: (r) => r.legalName,
    },
    {
      key: 'tax',
      label: t('cust.col.tax'),
      width: '1%',
      render: (r) => (
        <span className="tms-num" style={{ fontSize: 13, fontWeight: 400, color: '#101418' }}>
          {r.taxId ? `${r.taxId} / ${r.branchCode ?? '00000'}` : '—'}
        </span>
      ),
      csv: (r) => `${r.taxId ?? ''} / ${r.branchCode ?? ''}`,
    },
    {
      key: 'credit',
      label: t('cust.col.credit'),
      width: '1%',
      align: 'right',
      render: (r) => (
        <span style={{ color: '#101418' }}>{t('cust.days', { n: r.creditTermDays })}</span>
      ),
      csv: (r) => String(r.creditTermDays),
    },
    {
      key: 'billingCycle',
      label: t('cust.col.cycle'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...CYCLES.map((c) => ({ value: c, label: t(`cust.cycle.${c}` as MessageKey) })),
        ],
      },
      render: (r) => <Tag>{t(`cust.cycle.${r.billingCycle}` as MessageKey)}</Tag>,
      csv: (r) => t(`cust.cycle.${r.billingCycle}` as MessageKey),
    },
    {
      // ยอดค้างมาจากใบแจ้งหนี้ (ST5) — ยังไม่มีจึงแสดง "—" [OPEN spec/12 §3]
      key: 'out',
      label: t('cust.col.out'),
      width: '1%',
      align: 'right',
      render: () => (
        <span className="tms-num" style={{ fontSize: 13, color: '#3B424C' }}>
          —
        </span>
      ),
      csv: () => '',
    },
    {
      key: 'status',
      label: t('cust.col.status'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'active', label: t('cust.st.active') },
          { value: 'inactive', label: t('cust.st.inactive') },
        ],
      },
      render: (r) => (
        <StatusDot label={statusLabel(r.status)} tone={r.status === 'active' ? 'ok' : 'off'} />
      ),
      csv: (r) => statusLabel(r.status),
    },
  ];

  const tabCount =
    filters.status === 'active'
      ? s?.active
      : filters.status === 'inactive'
        ? s?.inactive
        : s?.total;
  const onlyStatus = !filters.code && !filters.name && !filters.billingCycle;

  return (
    <>
      <PageHeader
        title={t('page.cust.title')}
        sub={t('page.cust.sub')}
        actions={
          <>
            {/* นำเข้า Excel = ST2-T23 — แสดงตามต้นแบบแต่ยังกดไม่ได้ [OPEN spec/12 §3] */}
            <Button
              variant="secondary"
              icon="file-spreadsheet"
              disabled
              title={t('cust.importSoon')}
            >
              {t('cust.import')}
            </Button>
            {canWrite && (
              <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>
                {t('cust.add')}
              </Button>
            )}
          </>
        }
      />
      <SummaryStrip
        items={[
          {
            value: s?.total ?? '—',
            label: t('cust.sum.total'),
            onClick: () => setF('status', ''),
          },
          {
            value: s?.active ?? '—',
            label: t('cust.sum.active'),
            color: '#2257C4',
            onClick: () => setF('status', 'active'),
          },
          // ยอดค้าง/เกินกำหนดมาจากใบแจ้งหนี้ (ST5) [OPEN spec/12 §3]
          { value: '—', label: t('cust.sum.outstanding') },
          { value: '—', label: t('cust.sum.overdue'), color: '#8F5500' },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={filters.status || 'all'}
          onChange={(k) => setF('status', k === 'all' ? '' : k)}
          items={[
            { key: 'all', label: t('table.all'), ...(s ? { count: s.total } : {}) },
            { key: 'active', label: t('cust.tab.on'), ...(s ? { count: s.active } : {}) },
            { key: 'inactive', label: t('cust.tab.off'), ...(s ? { count: s.inactive } : {}) },
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
            title={t('cust.loadError')}
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
            rows={list.rows}
            rowId={(r) => r.id}
            activeId={openId}
            loading={list.q.isLoading}
            labels={tableLabels(t)}
            filters={{ ...filters }}
            onFilterChange={(k, v) => setF(k as keyof CustomerFilters, v)}
            onRowClick={open}
            rowMenu={(r) =>
              canWrite
                ? [
                    { label: t('cust.menu.edit'), icon: 'pencil', run: () => open(r) },
                    {
                      label: t(r.status === 'active' ? 'cust.menu.off' : 'cust.menu.on'),
                      icon: 'ban',
                      run: () => toggleStatus(r),
                    },
                  ]
                : []
            }
            {...(canExport
              ? {
                  bulkActions: [
                    {
                      label: t('cust.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/customers/export', {
                          format: 'xlsx',
                          ids: ids.join(','),
                        }).then(() => setToast(t('cust.toast.exported', { n: ids.length }))),
                    },
                  ],
                }
              : {})}
            empty={<EmptyState title={t('cust.emptyTitle')} description={t('cust.emptyDesc')} />}
            page={list.page}
            onPageSize={list.setSize}
            onNext={list.next}
            onPrev={list.prev}
            onGoto={list.goto}
          />
        )}
      </div>
      {current && (
        <CustomerDrawer
          key={current.id}
          customer={current}
          canWrite={canWrite}
          canListUsers={can(scopes, 'users:read')}
          onSaved={(c) => {
            setSelected(c);
            setToast(t('cust.toast.saved', { n: c.legalName }));
          }}
          onToggleStatus={() => toggleStatus(current)}
          onDelete={() => setDialog({ kind: 'delete', c: current })}
          onClose={() => {
            setOpenId(null);
            setSelected(null);
          }}
        />
      )}
      <CustomerCreateDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => {
          setCreating(false);
          setToast(t('cust.toast.created', { code: c.code }));
          open(c);
        }}
      />
      <ReasonDialog
        open={!!dialog}
        title={
          dialog
            ? t(dialog.kind === 'delete' ? 'cust.dlg.delT' : 'cust.dlg.offT', {
                n: dialog.c.legalName,
              })
            : ''
        }
        description={dialog ? t(dialog.kind === 'delete' ? 'cust.dlg.delD' : 'cust.dlg.offD') : ''}
        label={t('cust.dlg.reason')}
        placeholder={t('cust.dlg.reasonPh')}
        okLabel={dialog?.kind === 'delete' ? t('cust.menu.delete') : t('cust.menu.off')}
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
          const c = dialog.c;
          action.mutate(
            { id: c.id, action: dialog.kind, reason },
            {
              onSuccess: (updated) => {
                setDialog(null);
                if (dialog.kind === 'delete') {
                  setOpenId(null);
                  setSelected(null);
                  setToast(t('cust.toast.deleted', { n: c.legalName }));
                } else {
                  if (updated && openId === c.id) setSelected(updated);
                  setToast(t('cust.toast.status', { n: c.legalName }));
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
