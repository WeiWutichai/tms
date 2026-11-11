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
import { listTotal } from '../master/useCursorList';
import { ProductDrawer } from './ProductDrawer';
import { ProductFormDrawer } from './ProductFormDrawer';
import { UnitsDrawer } from './UnitsDrawer';
import { cbmText, kgText, num, specialSub, specialText } from './productFormat';
import {
  SPECIALS,
  useProductAction,
  useProductList,
  useProductSummary,
  useUnits,
  type Product,
  type ProductFilters,
} from './useProducts';

const EMPTY_FILTERS: ProductFilters = { name: '', unitId: '', special: '' };

const DIALOG = {
  deactivate: { title: 'prd.dlg.offT', desc: 'prd.dlg.offD', ok: 'prd.menu.off' },
  delete: { title: 'prd.dlg.delT', desc: 'prd.dlg.delD', ok: 'prd.menu.delete' },
} as const satisfies Record<string, Record<'title' | 'desc' | 'ok', MessageKey>>;

const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;

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
      {sub && (
        <span title={sub} style={{ ...clip, color: '#3B424C' }}>
          {sub}
        </span>
      )}
    </div>
  );
}

/**
 * ข้อมูลหลัก → สินค้าและหน่วย (ST2-T10) — ต้นแบบ TMS v4 specProd() + kpisX('prod') + cfProd() + vPanelApi prod
 * โครงหน้าเดียวกับสถานที่/ประเภทรถ: หัว + แถบสรุป 3 ช่อง + แท็บ ทั้งหมด/ทั่วไป/ประเภทพิเศษ + ตาราง 6 คอลัมน์ + drawer
 * ปุ่ม "จัดการหน่วย" (หน่วยนับ master — spec/02 §3) ต้นแบบไม่มี [OPEN spec/12 §3]
 */
export function ProductsPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const [filters, setFilters] = useState<ProductFilters>(EMPTY_FILTERS);
  const list = useProductList(filters);
  const summary = useProductSummary();
  const units = useUnits();
  const action = useProductAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const [form, setForm] = useState<{ p: Product | null } | null>(null);
  const [unitsOpen, setUnitsOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; p: Product } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof ProductFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (p: Product) => {
    setOpenId(p.id);
    setSelected(p);
  };
  const toggleStatus = (p: Product) => {
    if (p.status === 'active') return setDialog({ kind: 'deactivate', p });
    action.mutate(
      { id: p.id, version: p.version, action: 'activate' },
      {
        onSuccess: (u) => {
          if (u && openId === p.id) setSelected(u);
          setToast(t('prd.toast.status', { n: p.name }));
        },
        onError: (e) => setToast(problemText(e, t)),
      },
    );
  };
  const tab =
    filters.special === 'none' ? 'general' : filters.special === 'any' ? 'special' : 'all';

  const columns: Column<Product>[] = [
    {
      key: 'name',
      label: t('prd.col.n'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <TwoLine
          top={r.name}
          sub={r.code}
          muted={r.status === 'inactive' ? t('prd.st.inactive') : undefined}
        />
      ),
      csv: (r) => `${r.name} ${r.code}`,
    },
    {
      key: 'unitId',
      label: t('prd.col.u'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...(units.data ?? []).map((u) => ({ value: u.id, label: u.name })),
        ],
      },
      render: (r) => <Tag>{r.unit.name}</Tag>,
      csv: (r) => r.unit.name,
    },
    {
      key: 'w',
      label: t('prd.col.w'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{kgText(t, r)}</span>,
      csv: (r) => String(r.weightPerUnitKg ?? ''),
    },
    {
      key: 'vol',
      label: t('prd.col.vol'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{cbmText(t, r)}</span>,
      csv: (r) => String(r.volumePerUnitCbm ?? ''),
    },
    {
      key: 'special',
      label: t('prd.col.sp'),
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'none', label: '—' },
          ...SPECIALS.map((s) => ({ value: s, label: t(`prd.sp.${s}` as MessageKey) })),
        ],
      },
      render: (r) => {
        const sp = specialText(t, r);
        return sp ? (
          <TwoLine top={sp} sub={specialSub(t, r)} />
        ) : (
          <span style={{ color: '#59606B' }}>—</span>
        );
      },
      csv: (r) => specialText(t, r) || '—',
    },
    {
      key: 'cust',
      label: t('prd.col.cust'),
      render: (r) => (
        <span
          title={r.customer?.name ?? ''}
          style={{
            ...cell,
            display: 'block',
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {r.customer?.name ?? '—'}
        </span>
      ),
      csv: (r) => r.customer?.name ?? '—',
    },
  ];

  const filtered = Object.values(filters).some((v) => v !== '');
  const tabTotal = tab === 'general' ? sum?.general : tab === 'special' ? sum?.special : sum?.total;
  const shownTotal = listTotal(
    list,
    filters,
    ['', 'none', 'any'].includes(filters.special) ? ['special'] : [],
    tabTotal,
  );
  const colFilters = {
    name: filters.name,
    unitId: filters.unitId,
    special: ['none', ...SPECIALS].includes(filters.special as never) ? filters.special : '',
  };

  return (
    <>
      <PageHeader
        title={t('page.prod.title')}
        sub={t('page.prod.sub')}
        actions={
          <>
            <Button variant="secondary" icon="ruler" onClick={() => setUnitsOpen(true)}>
              {t('prd.manageUnits')}
            </Button>
            {canWrite && (
              <Button variant="primary" icon="plus" onClick={() => setForm({ p: null })}>
                {t('prd.add')}
              </Button>
            )}
          </>
        }
      />
      <SummaryStrip
        items={[
          { value: sum ? num(sum.total, 0) : '—', label: t('prd.sum.total') },
          {
            value: sum ? num(sum.special, 0) : '—',
            label: t('prd.sum.special'),
            color: '#8F5500',
            pressed: tab === 'special',
            onClick: () => setF('special', tab === 'special' ? '' : 'any'),
          },
          {
            value: sum ? t('prd.unitsN', { n: num(sum.unitsUsed, 0) }) : '—',
            label: t('prd.sum.units'),
          },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={(k) => setF('special', k === 'general' ? 'none' : k === 'special' ? 'any' : '')}
          items={[
            { key: 'all', label: t('table.all'), ...(sum ? { count: sum.total } : {}) },
            { key: 'general', label: t('prd.tab.general'), ...(sum ? { count: sum.general } : {}) },
            { key: 'special', label: t('prd.tab.special'), ...(sum ? { count: sum.special } : {}) },
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
            title={t('prd.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('prd.retry')}
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
            filters={colFilters}
            onFilterChange={(k, v) => setF(k as keyof ProductFilters, v)}
            onRowClick={open}
            rowMenu={(r) => [
              { label: t('prd.menu.view'), icon: 'eye', run: () => open(r) },
              ...(canWrite
                ? [
                    { label: t('prd.menu.edit'), icon: 'pencil', run: () => setForm({ p: r }) },
                    {
                      label: t(r.status === 'active' ? 'prd.menu.off' : 'prd.menu.on'),
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
                      label: t('prd.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/products/export', {
                          format: 'xlsx',
                          ids: ids.join(','),
                        }).then(
                          () => setToast(t('prd.toast.exported', { n: ids.length })),
                          () => setToast(t('prd.exportFailed')),
                        ),
                    },
                  ],
                }
              : {})}
            onExportCsv={
              canExport
                ? () =>
                    void downloadFile('/v1/products/export', {
                      format: 'csv',
                      ...filters,
                    }).catch(() => setToast(t('prd.exportFailed')))
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
                  icon="package"
                  title={t('prd.emptyTitle')}
                  description={t('prd.emptyDesc')}
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
        <ProductDrawer
          key={current.id}
          product={current}
          canWrite={canWrite}
          onEdit={() => setForm({ p: current })}
          onToggleStatus={() => toggleStatus(current)}
          onDelete={() => setDialog({ kind: 'delete', p: current })}
          onClose={() => {
            setOpenId(null);
            setSelected(null);
          }}
        />
      )}
      {unitsOpen && (
        <UnitsDrawer
          canWrite={canWrite}
          onClose={() => setUnitsOpen(false)}
          onToast={(m) => setToast(m)}
        />
      )}
      <ProductFormDrawer
        open={!!form}
        product={form?.p ?? null}
        onClose={() => setForm(null)}
        onSaved={(p, created) => {
          setForm(null);
          setToast(t(created ? 'prd.toast.created' : 'prd.toast.saved', { n: p.name }));
          open(p);
        }}
      />
      <ReasonDialog
        open={!!dialog}
        title={dialog ? t(DIALOG[dialog.kind].title, { n: dialog.p.name }) : ''}
        description={dialog ? t(DIALOG[dialog.kind].desc) : ''}
        label={t('prd.dlg.reason')}
        placeholder={t('prd.dlg.reasonPh')}
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
          const { p, kind } = dialog;
          action.mutate(
            { id: p.id, version: p.version, action: kind, reason },
            {
              onSuccess: (updated) => {
                setDialog(null);
                if (kind === 'delete') {
                  setOpenId(null);
                  setSelected(null);
                  setToast(t('prd.toast.deleted', { n: p.name }));
                } else {
                  if (updated && openId === p.id) setSelected(updated);
                  setToast(t('prd.toast.status', { n: p.name }));
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
