import { ImportExcelButton } from '../imports/ImportExcelButton';
import {
  Button,
  DataTable,
  DocNo,
  EmptyState,
  RouteChip,
  StatusDot,
  StatusTabs,
  SummaryStrip,
  Toast,
  type Column,
} from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDeepOpen } from '../../shell/deepLink';
import { unwrap, api } from '../../api';
import { useI18n } from '../../i18n';
import { exportList } from '../exports/exportJob';
import { exportFailText } from '../master/download';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { addDays, bangkokToday, useDateText } from '../rate-cards/rateFormat';
import { OrderSourceBadge } from './OrderSource';
import { dueOf, orderStatusLabel, OrderDrawer, overdueDays, statusTone } from './OrderDrawer';
import { TripDrawer } from '../trips/TripDrawer';
import { OrderFormDrawer, type FormMode } from './OrderFormDrawer';
import {
  copyFromOrder,
  emptyForm,
  fromOrder,
  fromTemplate,
  toPayload,
  totalWeightKg,
  type Order,
  type OrderForm,
} from './orderForm';
import { SaveTemplateDialog, TemplatesDrawer } from './Templates';
import { useOrderList, useOrderSummary, type OrderFilters } from './useOrders';
import { SavedViewMenu } from '../views/SavedViewMenu';
import { pick, useSavedViews } from '../views/useSavedViews';

type Tab = 'all' | 'route' | 'match' | 'done';
const TABS: Tab[] = ['all', 'route', 'match', 'done'];
/** ค่าของมุมมอง "ทั้งหมด" (ST9-T11) — key = แท็บ + การ์ด + ตัวกรองคอลัมน์ */
const EMPTY_VIEW = { tab: 'all', overdue: false, doneToday: false, q: '', st: '', source: '' };
/** แท็บของต้นแบบ (specSo tabs) → ตัวกรอง API — "รอกำหนดเส้นทาง" = ค้างเพราะยังจับคู่สถานที่ไม่ได้ */
const TAB_FILTER: Record<Tab, Partial<OrderFilters>> = {
  all: {},
  route: { status: 'on_hold', holdReason: 'LOCATION_UNMAPPED' },
  match: { status: 'on_hold', holdReason: 'CUSTOMER_UNMAPPED' },
  done: { status: 'planned' },
};
const STATUS_OPTS = [
  'draft',
  'received',
  'on_hold',
  'planned',
  'in_transit',
  'partially_delivered',
  'delivered',
  'closed',
  'cancelled',
] as const;

interface FormState {
  key: number;
  mode: FormMode;
  initial: OrderForm;
  order?: Order;
  subtitle?: string;
}

/**
 * ปฏิบัติการ → ใบสั่งขนส่ง (SO) (ST3-T02) — ต้นแบบ TMS v4 specSo() + kpisX('so') + actions.so + vPanel 'so'
 * ข้อมูลจาก /v1/orders ชุดเดียวกับลูกค้า · หน้าใบค้างเต็มรูป (เคลียร์ตามรหัส) = ST3-T07 · จัดรถ = ST3-T11/T12
 */
export function OrdersPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const me = useMe();
  const dateText = useDateText();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'orders:write');
  const canCancel = can(scopes, 'orders:cancel');
  const canSeePrice = can(scopes, 'prices.sell:read');
  const canUnlock = can(scopes, 'orders:unlock');
  const canEditPrice = can(scopes, 'prices.sell:write');
  const [tab, setTab] = useSessionState<Tab>('so.tab', 'all');
  const [overdue, setOverdue] = useSessionState('so.over', false);
  // "จัดแล้ววันนี้" (ต้นแบบ kpisX so): แท็บจัดรถแล้ว + วันรับของ = วันนี้ — ตัวเลขเดียวกับ summary.plannedToday
  const [doneToday, setDoneToday] = useSessionState('so.today', false);
  const [col, setCol] = useSessionState('so.cols', { q: '', st: '', source: '' });
  const [hidden, setHidden] = useSessionState<string[] | null>('so.hidden', null);
  // มุมมองที่บันทึกไว้ (ST9-T11): แท็บ + การ์ด (เกินกำหนด/จัดแล้ววันนี้) + ตัวกรองคอลัมน์ + คอลัมน์ที่ซ่อน
  const views = useSavedViews({
    page: 'orders',
    state: { tab, overdue, doneToday, ...col },
    hidden,
    empty: EMPTY_VIEW,
    apply: (v) => {
      const s = pick(v.state, EMPTY_VIEW);
      setTab(TABS.includes(s.tab as Tab) ? (s.tab as Tab) : 'all');
      setOverdue(s.overdue);
      setDoneToday(s.doneToday);
      setCol({ q: s.q, st: s.st, source: s.source });
      setHidden(v.hidden);
    },
  });
  const today = bangkokToday();
  const base: OrderFilters = {
    status: '',
    holdReason: '',
    q: col.q,
    source: col.source,
    requestedFrom: '',
    requestedTo: '',
  };
  const filters: OrderFilters = {
    ...base,
    ...TAB_FILTER[tab],
    ...(col.st && tab === 'all'
      ? col.st.startsWith('hold:')
        ? { status: 'on_hold', holdReason: col.st.slice(5) }
        : { status: col.st }
      : {}),
    // เกินกำหนด (ต้นแบบ kfs.over): ยังไม่ออกรถ + วันรับของก่อนวันนี้
    ...(overdue ? { status: 'received,on_hold,planned', requestedTo: addDays(today, -1) } : {}),
    ...(doneToday && tab === 'done' ? { requestedFrom: today, requestedTo: today } : {}),
  };
  const list = useOrderList(filters);
  const summary = useOrderSummary();
  const s = summary.data;
  const [openId, setOpenId] = useState<string | null>(null);
  // ST9-T09 ค้นหา ⌘K → `/so?open=ord_…` เปิด drawer ใบนั้น
  useDeepOpen('open', 'ord', setOpenId);
  /** drawer เที่ยวรถ (ST3-T16) — เปิดจากเลขเที่ยวใน drawer SO (ต้นแบบ openTrp แทนที่ drawer เดิม) */
  const [tripId, setTripId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [saveTpl, setSaveTpl] = useState<Order | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const openForm = (f: Omit<FormState, 'key'>) => setForm({ ...f, key: Date.now() });
  const reloadEdit = async (id: string) => {
    const o = (await unwrap(api.GET('/v1/orders/{id}', { params: { path: { id } } }))) as Order;
    qc.setQueryData(['orders', 'one', id], o);
    openForm({ mode: 'edit', initial: fromOrder(o), order: o, subtitle: t('ord.kind') });
  };

  // ST9-T01 ทางลัด "สร้าง SO" บนหน้าภาพรวม → `/so?new=1` เปิดฟอร์มสร้างทันที (แล้วล้างพารามิเตอร์)
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('new') !== '1' || !canWrite) return;
    setForm({ key: Date.now(), mode: 'create', initial: emptyForm(today) });
    setParams(new URLSearchParams(), { replace: true });
  }, [params, canWrite, setParams, today]);

  const goTab = (k: Tab) => {
    setOverdue(false);
    setDoneToday(false);
    setTab(k);
  };

  const columns: Column<Order>[] = [
    {
      key: 'q',
      label: t('ord.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) =>
        r.soNo ? (
          <DocNo>{r.soNo}</DocNo>
        ) : (
          <span style={{ color: '#59606B' }}>{t('ord.draftNo')}</span>
        ),
      csv: (r) => r.soNo ?? '',
    },
    {
      key: 'cust',
      label: t('ord.col.cust'),
      render: (r) => {
        const n = r.customer.legalName ?? r.customer.name ?? r.customer.externalId ?? '—';
        return (
          <span
            title={n}
            style={{
              color: '#101418',
              display: 'inline-block',
              maxWidth: 240,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              verticalAlign: 'bottom',
            }}
          >
            {n}
          </span>
        );
      },
      csv: (r) => r.customer.legalName ?? r.customer.name ?? '',
    },
    {
      key: 'route',
      label: t('ord.col.route'),
      width: '1%',
      render: (r) => {
        const a = r.stops.find((x) => x.type === 'PICKUP') ?? r.stops[0];
        const b =
          [...r.stops].reverse().find((x) => x.type === 'DELIVERY') ?? r.stops[r.stops.length - 1];
        return a && b && a !== b ? (
          // ชื่อยาวตัด … (ข้อความเต็มใน title) — ไม่ให้ดันคอลัมน์สถานะ/ที่มาพ้นจอ
          <span className="tms-route-cell" title={`${a.siteText} → ${b.siteText}`}>
            <RouteChip
              from={
                <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                  {a.siteText}
                </span>
              }
              to={
                <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                  {b.siteText}
                </span>
              }
            />
          </span>
        ) : (
          (a?.siteText ?? '—')
        );
      },
      csv: (r) => r.stops.map((x) => x.siteText).join(' → '),
    },
    {
      key: 'w',
      label: t('ord.col.weight'),
      align: 'right',
      width: '1%',
      render: (r) => {
        const w = totalWeightKg(r.lines);
        return <span className="tms-num">{w ? Number(w).toLocaleString('th-TH') : '—'}</span>;
      },
      csv: (r) => totalWeightKg(r.lines) ?? '',
    },
    {
      key: 'due',
      label: t('ord.col.due'),
      width: '1%',
      render: (r) => {
        const d = dueOf(r);
        const late = overdueDays(r, today) > 0;
        return (
          <span
            className="tms-num"
            style={{ color: late ? '#B3322A' : '#101418', whiteSpace: 'nowrap' }}
          >
            {dateText(d.date)}
            {late && <span style={{ marginLeft: 6, fontWeight: 500 }}>{t('ord.over')}</span>}
          </span>
        );
      },
      csv: (r) => dueOf(r).date,
    },
    {
      key: 'st',
      label: t('ord.col.status'),
      width: '1%',
      ...(tab === 'all' && !overdue
        ? {
            filter: {
              type: 'select' as const,
              options: [
                { value: '', label: t('table.all') },
                ...STATUS_OPTS.filter((x) => x !== 'on_hold').map((x) => ({
                  value: x,
                  label: t(`ord.st.${x}`),
                })),
                { value: 'hold:LOCATION_UNMAPPED', label: t('ord.tab.route') },
                { value: 'hold:CUSTOMER_UNMAPPED', label: t('ord.tab.match') },
                { value: 'on_hold', label: t('ord.st.on_hold') },
              ],
            },
          }
        : {}),
      render: (r) => <StatusDot label={orderStatusLabel(t, r)} tone={statusTone(r)} />,
      csv: (r) => orderStatusLabel(t, r),
    },
    {
      key: 'source',
      label: t('so.src.col'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'ERP', label: 'ERP' },
          { value: 'EXCEL', label: t('so.src.IMPORT') },
          { value: 'API', label: t('so.src.API') },
          { value: 'MANUAL', label: t('so.src.MANUAL') },
        ],
      },
      render: (r) => (
        <OrderSourceBadge source={r.sourceType} connector={r.connector} externalId={r.externalId} />
      ),
      csv: (r) => r.source,
    },
  ];

  const tabCount: Record<Tab, number | undefined> = {
    all: s?.total,
    route: s?.locationUnmapped,
    match: s?.customerUnmapped,
    done: s?.planned,
  };
  const colFiltered = !!(col.q || col.st || col.source);
  const shownTotal = listTotal(
    list,
    { tab, overdue: overdue ? '1' : '', today: doneToday && tab === 'done' ? '1' : '', ...col },
    ['tab', 'overdue', 'today'],
    overdue ? s?.overdue : doneToday && tab === 'done' ? s?.plannedToday : tabCount[tab],
  );

  return (
    <>
      <PageHeader
        title={t('page.so.title')}
        sub={t('page.so.sub')}
        actions={
          canWrite ? (
            <>
              {/* ต้นแบบ SO: "นำเข้า CSV" (upload) อยู่หน้าปุ่มอื่น — ใช้ wizard นำเข้า Excel/CSV ตัวเดียวกับข้อมูลหลัก (ST3-T04) */}
              <ImportExcelButton
                kind="order"
                icon="upload"
                label={t('so.importCsv')}
                onDone={(m) => setToast(m)}
              />
              <Button variant="secondary" icon="bookmark" onClick={() => setTplOpen(true)}>
                {t('tpl.fromTpl')}
              </Button>
              <Button
                variant="secondary"
                icon="plus"
                onClick={() => openForm({ mode: 'create', initial: emptyForm(today) })}
              >
                {t('ord.create')}
              </Button>
            </>
          ) : undefined
        }
      />
      <SummaryStrip
        items={[
          {
            value: s?.locationUnmapped ?? '—',
            label: t('ord.tab.route'),
            color: '#8F5500',
            onClick: () => goTab('route'),
            pressed: tab === 'route' && !overdue,
          },
          {
            value: s?.customerUnmapped ?? '—',
            label: t('ord.tab.match'),
            color: '#8F5500',
            onClick: () => goTab('match'),
            pressed: tab === 'match' && !overdue,
          },
          {
            value: s?.overdue ?? '—',
            label: t('ord.kpi.over'),
            color: '#B3322A',
            onClick: () => {
              setTab('all');
              setDoneToday(false);
              setOverdue((v) => !v);
            },
            pressed: overdue,
          },
          {
            value: s?.plannedToday ?? '—',
            label: t('ord.kpi.today'),
            color: '#17733F',
            onClick: () => {
              goTab('done');
              setDoneToday(true);
            },
            pressed: tab === 'done' && doneToday && !overdue,
          },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={(k) => goTab(k as Tab)}
          items={(['all', 'route', 'match', 'done'] as Tab[]).map((k) => ({
            key: k,
            label: k === 'all' ? t('table.all') : t(`ord.tab.${k}`),
            ...(tabCount[k] !== undefined ? { count: tabCount[k]! } : {}),
          }))}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <SavedViewMenu b={views} onToast={setToast} />
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('ord.loadError')}
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
            loading={list.loading}
            labels={tableLabels(t)}
            selectable={false}
            // ส่งออก CSV จากแผงตัวเลือก = ส่งออกจาก API ตามตัวกรองเดียวกับตาราง (ทุกแถว — งานเบื้องหลัง ST9-T10)
            onExportCsv={
              can(scopes, 'export:run')
                ? () =>
                    void exportList('orders', { ...filters }).then(
                      (n) => setToast(t('export.done', { n: n.toLocaleString('en-US') })),
                      (e) => setToast(exportFailText(t, e, t('export.failed'))),
                    )
                : false
            }
            filters={{ q: col.q, st: col.st, source: col.source }}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(r) => setOpenId(r.id)}
            rowMenu={(r) => [
              { label: t('ord.menu.view'), icon: 'eye', run: () => setOpenId(r.id) },
              ...(canWrite
                ? [
                    {
                      label: t('ord.menu.copy'),
                      icon: 'copy',
                      run: () =>
                        openForm({
                          mode: 'copy',
                          initial: copyFromOrder(r, today),
                          subtitle: t('ord.form.copySub', { no: r.soNo ?? t('ord.draftNo') }),
                        }),
                    },
                  ]
                : []),
            ]}
            empty={
              colFiltered || tab !== 'all' || overdue || doneToday ? (
                <EmptyState
                  icon="search-x"
                  title={t('table.emptyTitle')}
                  description={t('table.noMatch')}
                />
              ) : (
                <EmptyState
                  icon="clipboard-list"
                  title={t('ord.emptyTitle')}
                  description={t('ord.emptyDesc')}
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
      {openId && !form && (
        <OrderDrawer
          key={openId}
          id={openId}
          canWrite={canWrite}
          canCancel={canCancel}
          canSeePrice={canSeePrice}
          canEditPrice={canEditPrice}
          canUnlock={canUnlock}
          canSeeTrips={can(scopes, 'trips:read')}
          onOpenTrip={(x) => {
            setOpenId(null);
            setTripId(x);
          }}
          onClose={() => setOpenId(null)}
          onEdit={(o) =>
            openForm({ mode: 'edit', initial: fromOrder(o), order: o, subtitle: t('ord.kind') })
          }
          onCopy={(o) =>
            openForm({
              mode: 'copy',
              initial: copyFromOrder(o, today),
              subtitle: t('ord.form.copySub', { no: o.soNo ?? t('ord.draftNo') }),
            })
          }
          onSaveTemplate={(o) => setSaveTpl(o)}
          onDone={(m) => setToast(m)}
        />
      )}
      {tripId && (
        <TripDrawer
          key={tripId}
          id={tripId}
          canEdit={can(scopes, 'trips:assign')}
          canDispatch={can(scopes, 'trips:dispatch')}
          canOverride={can(scopes, 'trips:override')}
          canPrint={can(scopes, 'documents:write')}
          canHire={can(scopes, 'trips:assign') && can(scopes, 'prices.buy:read')}
          canClose={can(scopes, 'trips:close')}
          canSeeBuy={can(scopes, 'prices.buy:read')}
          canSeeSell={can(scopes, 'prices.sell:read')}
          onDone={setToast}
          onClose={() => setTripId(null)}
        />
      )}
      {form && (
        <OrderFormDrawer
          key={form.key}
          mode={form.mode}
          initial={form.initial}
          order={form.order ?? null}
          {...(form.subtitle ? { subtitle: form.subtitle } : {})}
          canSeePrice={canSeePrice}
          canUnlock={canUnlock}
          onClose={() => setForm(null)}
          onReload={form.order ? () => void reloadEdit(form.order!.id) : undefined}
          onSaved={(o, how) => {
            setForm(null);
            setOpenId(o.id);
            setToast(
              how === 'saved'
                ? t('ord.toast.saved', { no: o.soNo ?? t('ord.draftNo') })
                : how === 'draft'
                  ? t('ord.toast.draft')
                  : t('ord.toast.created', { no: o.soNo ?? '' }),
            );
          }}
        />
      )}
      {tplOpen && (
        <TemplatesDrawer
          canWrite={canWrite}
          onClose={() => setTplOpen(false)}
          onDeleted={(n) => setToast(t('tpl.toast.deleted', { n }))}
          onUse={(x) => {
            setTplOpen(false);
            openForm({
              mode: 'template',
              initial: fromTemplate(x.payload, x.customer, addDays(today, 1)),
              subtitle: t('tpl.fromSub', { n: x.name }),
            });
          }}
        />
      )}
      {saveTpl && (
        <SaveTemplateDialog
          payload={{ ...toPayload(fromOrder(saveTpl)), customerRef: null }}
          defaultName={[
            saveTpl.customer.legalName,
            saveTpl.stops.map((x) => x.siteText).join(' → '),
          ]
            .filter(Boolean)
            .join(' · ')
            .slice(0, 100)}
          onClose={() => setSaveTpl(null)}
          onSaved={(n) => {
            setSaveTpl(null);
            setToast(t('tpl.toast.saved', { n }));
          }}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
