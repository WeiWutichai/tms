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
import { ServiceItemDrawer } from './ServiceItemDrawer';
import { ServiceItemFormDrawer } from './ServiceItemFormDrawer';
import { condText, priceText, unitText, vatText, whtText } from './serviceItemFormat';
import {
  CALC_UNIT_FILTER,
  useServiceItemAction,
  useServiceItemList,
  useServiceItemSummary,
  type ServiceItem,
  type ServiceItemFilters,
} from './useServiceItems';

const EMPTY_FILTERS: ServiceItemFilters = { name: '', calcUnit: '', vatType: '' };

const DIALOG = {
  deactivate: { title: 'svc.dlg.offT', desc: 'svc.dlg.offD', ok: 'svc.menu.off' },
  delete: { title: 'svc.dlg.delT', desc: 'svc.dlg.delD', ok: 'svc.menu.delete' },
} as const satisfies Record<string, Record<'title' | 'desc' | 'ok', MessageKey>>;

const num = (n: number) => n.toLocaleString('th-TH');
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;

/** ข้อความสองบรรทัดของต้นแบบ (cW): ชื่อ + เงื่อนไข (สีรอง) — ยาวเกินตัด … · ปิดใช้แสดง "ปิดใช้" สีจางต่อท้าย */
function TwoLine({ top, sub, muted }: { top: string; sub: string; muted?: string | undefined }) {
  const clip = {
    display: 'block',
    maxWidth: 420,
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
 * ข้อมูลหลัก → ค่าบริการเสริม (ST2-T11) — ต้นแบบ TMS v4 specAx() + kpisX('accsr') + cfAx() + vPanelApi acx
 * หัว + แถบสรุป 3 ช่อง (ทั้งหมด / มี VAT 7% / ยกเว้น VAT — กดแล้วไปแท็บนั้น) + แท็บ ทั้งหมด/VAT 7%/ยกเว้น VAT
 * + ตาราง 5 คอลัมน์ (รายการ/เงื่อนไข, หน่วยคิด, ราคา, VAT, หัก ณ ที่จ่าย) + drawer
 * ต่างจากต้นแบบ [OPEN spec/12 §3]: เมนู ⋯ มี แก้ไข/ปิดใช้ (ข้อมูลหลักอื่นเหมือนกัน), รายการปิดใช้มี "ปิดใช้" ต่อท้ายชื่อ
 */
export function ServiceItemsPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const [filters, setFilters] = useState<ServiceItemFilters>(EMPTY_FILTERS);
  const list = useServiceItemList(filters);
  const summary = useServiceItemSummary();
  const action = useServiceItemAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ServiceItem | null>(null);
  const [form, setForm] = useState<{ r: ServiceItem | null } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; r: ServiceItem } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof ServiceItemFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (r: ServiceItem) => {
    setOpenId(r.id);
    setSelected(r);
  };
  const toggleStatus = (r: ServiceItem) => {
    if (r.status === 'active') return setDialog({ kind: 'deactivate', r });
    action.mutate(
      { id: r.id, version: r.version, action: 'activate' },
      {
        onSuccess: (u) => {
          if (u && openId === r.id) setSelected(u);
          setToast(t('svc.toast.status', { n: r.name }));
        },
        onError: (e) => setToast(problemText(e, t)),
      },
    );
  };
  // แท็บตามต้นแบบ = ตัวกรอง VAT (VAT 7% / ยกเว้น VAT); VAT 0% อยู่ใน "ทั้งหมด"
  const tab =
    filters.vatType === 'VAT_7'
      ? 'vat7'
      : filters.vatType === 'EXEMPT_TRANSPORT'
        ? 'exempt'
        : 'all';

  const columns: Column<ServiceItem>[] = [
    {
      key: 'name',
      label: t('svc.col.n'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <TwoLine
          top={r.name}
          sub={condText(t, r)}
          muted={r.status === 'inactive' ? t('svc.st.inactive') : undefined}
        />
      ),
      csv: (r) => [r.name, condText(t, r)].filter(Boolean).join(' · '),
    },
    {
      key: 'calcUnit',
      label: t('svc.col.u'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...CALC_UNIT_FILTER.map((u) => ({ value: u, label: unitText(t, u) })),
        ],
      },
      render: (r) => <span style={cell}>{unitText(t, r.calcUnit)}</span>,
      csv: (r) => unitText(t, r.calcUnit),
    },
    {
      key: 'p',
      label: t('svc.col.p'),
      width: '1%',
      align: 'right',
      render: (r) => (
        <span style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{priceText(t, r)}</span>
      ),
      csv: (r) => priceText(t, r),
    },
    {
      key: 'vatType',
      label: t('svc.col.vat'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'VAT_7', label: vatText(t, 'VAT_7') },
          { value: 'EXEMPT_TRANSPORT', label: vatText(t, 'EXEMPT_TRANSPORT') },
          { value: 'ZERO_RATED', label: vatText(t, 'ZERO_RATED') },
        ],
      },
      render: (r) => <Tag>{vatText(t, r.vatType)}</Tag>,
      csv: (r) => vatText(t, r.vatType),
    },
    {
      key: 'wht',
      label: t('svc.col.wht'),
      width: '1%',
      align: 'right',
      render: (r) => <span style={cell}>{whtText(t, r.whtRate)}</span>,
      csv: (r) => whtText(t, r.whtRate),
    },
  ];

  const filtered = Object.values(filters).some((v) => v !== '');
  const tabTotal = tab === 'vat7' ? sum?.vat7 : tab === 'exempt' ? sum?.exempt : sum?.total;
  const shownTotal = listTotal(
    list,
    filters,
    ['', 'VAT_7', 'EXEMPT_TRANSPORT'].includes(filters.vatType) ? ['vatType'] : [],
    tabTotal,
  );
  const goTab = (k: string) =>
    setF('vatType', k === 'vat7' ? 'VAT_7' : k === 'exempt' ? 'EXEMPT_TRANSPORT' : '');

  return (
    <>
      <PageHeader
        title={t('page.accsr.title')}
        sub={t('page.accsr.sub')}
        actions={
          canWrite && (
            <Button variant="primary" icon="plus" onClick={() => setForm({ r: null })}>
              {t('svc.add')}
            </Button>
          )
        }
      />
      <SummaryStrip
        items={[
          { value: sum ? num(sum.total) : '—', label: t('svc.sum.total') },
          {
            value: sum ? num(sum.vat7) : '—',
            label: t('svc.sum.vat7'),
            pressed: tab === 'vat7',
            onClick: () => goTab(tab === 'vat7' ? 'all' : 'vat7'),
          },
          {
            value: sum ? num(sum.exempt) : '—',
            label: t('svc.sum.exempt'),
            pressed: tab === 'exempt',
            onClick: () => goTab(tab === 'exempt' ? 'all' : 'exempt'),
          },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={goTab}
          items={[
            { key: 'all', label: t('table.all'), ...(sum ? { count: sum.total } : {}) },
            { key: 'vat7', label: t('svc.tab.vat7'), ...(sum ? { count: sum.vat7 } : {}) },
            { key: 'exempt', label: t('svc.tab.exempt'), ...(sum ? { count: sum.exempt } : {}) },
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
            title={t('svc.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('svc.retry')}
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
            onFilterChange={(k, v) => setF(k as keyof ServiceItemFilters, v)}
            onRowClick={open}
            rowMenu={(r) => [
              { label: t('svc.menu.view'), icon: 'eye', run: () => open(r) },
              ...(canWrite
                ? [
                    { label: t('svc.menu.edit'), icon: 'pencil', run: () => setForm({ r }) },
                    ...(r.reserved
                      ? []
                      : [
                          {
                            label: t(r.status === 'active' ? 'svc.menu.off' : 'svc.menu.on'),
                            icon: 'ban',
                            run: () => toggleStatus(r),
                          },
                        ]),
                  ]
                : []),
            ]}
            {...(canExport
              ? {
                  bulkActions: [
                    {
                      label: t('svc.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/service-items/export', {
                          format: 'xlsx',
                          ids: ids.join(','),
                        }).then(
                          () => setToast(t('svc.toast.exported', { n: ids.length })),
                          () => setToast(t('svc.exportFailed')),
                        ),
                    },
                  ],
                }
              : {})}
            onExportCsv={
              canExport
                ? () =>
                    void downloadFile('/v1/service-items/export', {
                      format: 'csv',
                      ...filters,
                    }).catch(() => setToast(t('svc.exportFailed')))
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
                  icon="receipt"
                  title={t('svc.emptyTitle')}
                  description={t('svc.emptyDesc')}
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
        <ServiceItemDrawer
          key={current.id}
          item={current}
          canWrite={canWrite}
          onEdit={() => setForm({ r: current })}
          onToggleStatus={() => toggleStatus(current)}
          onDelete={() => setDialog({ kind: 'delete', r: current })}
          onClose={() => {
            setOpenId(null);
            setSelected(null);
          }}
        />
      )}
      <ServiceItemFormDrawer
        open={!!form}
        item={form?.r ?? null}
        onClose={() => setForm(null)}
        onSaved={(r, created) => {
          setForm(null);
          const done = t(created ? 'svc.toast.created' : 'svc.toast.saved', { n: r.name });
          // คำเตือนที่ไม่บล็อกจาก API (คู่ VAT × หัก ณ ที่จ่ายไม่ปกติ) — บันทึกแล้ว แต่ให้ผู้ใช้ทบทวน
          const warn = r.warnings.map((w) => t(`svc.warn.${w.reason}` as MessageKey)).join(' ');
          setToast(warn ? `${done} — ${warn}` : done);
          const { warnings: _w, ...item } = r;
          open(item);
        }}
      />
      <ReasonDialog
        open={!!dialog}
        title={dialog ? t(DIALOG[dialog.kind].title, { n: dialog.r.name }) : ''}
        description={dialog ? t(DIALOG[dialog.kind].desc) : ''}
        label={t('svc.dlg.reason')}
        placeholder={t('svc.dlg.reasonPh')}
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
                  setToast(t('svc.toast.deleted', { n: r.name }));
                } else {
                  if (updated && openId === r.id) setSelected(updated);
                  setToast(t('svc.toast.status', { n: r.name }));
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
