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
import { useState } from 'react';
import {
  DO_TAB_BILLED,
  DO_TAB_DELIVERED,
  DO_TAB_DRAFT,
  DO_TAB_FAILED,
  DO_TAB_IN_TRANSIT,
} from '@tms/domain/src/ops-lists';
import { OPS_DO_DELIVERED } from '@tms/domain/src/ops-dashboard';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { useDeepOpen } from '../../shell/deepLink';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { OrderDrawer } from '../orders/OrderDrawer';
import { addDays, bangkokToday, useDateText } from '../rate-cards/rateFormat';
import { TripDrawer } from '../trips/TripDrawer';
import { SavedViewMenu } from '../views/SavedViewMenu';
import { pick, useSavedViews } from '../views/useSavedViews';
import { DO_TONE, DoDrawer, canConfirm, canReturnDo, type DoPerms } from './DoDrawer';
import { api, unwrap } from '../../api';
import { BulkFailDialog } from '../planning/BulkFailDialog';
import { ReturnDialog } from '../pod/ReturnDialog';
import { modeOf } from '../pod/returnForm';
import { useDoPods } from '../pod/usePod';
import { useBulkAssign, type BulkResults, type TripDetail } from '../trips/useTrips';
import { useDoList, useDoSummary, type Do, type DoFilters } from './useDos';

type Tab = 'all' | 'draft' | 'transit' | 'delivered' | 'rejected' | 'failed' | 'billed';
const TABS: Tab[] = ['all', 'draft', 'transit', 'delivered', 'rejected', 'failed', 'billed'];
/**
 * แท็บของต้นแบบ (specDo: ร่าง / ระหว่างส่ง / ส่งแล้ว / ตีกลับบางส่วน / ส่งไม่สำเร็จ / วางบิลแล้ว) → สถานะจริงของ DO (docs/01 §4.3)
 * "ส่งแล้ว" / "ตีกลับบางส่วน" = ส่งถึงแล้วยังไม่วางบิล แยกด้วยบรรทัดปฏิเสธรับ (`rejected=false|true` — ตีกลับบางส่วนไม่ใช่สถานะ)
 * · "ส่งไม่สำเร็จ" = FAILED + RETURNED (ต้นแบบไม่มีแท็บคืนคลัง — อยู่แท็บที่ใกล้ที่สุดตาม state machine `FAILED → RETURNED`)
 */
const TAB_STATUS: Record<Tab, readonly string[]> = {
  all: [],
  draft: DO_TAB_DRAFT,
  transit: DO_TAB_IN_TRANSIT,
  delivered: DO_TAB_DELIVERED,
  rejected: DO_TAB_DELIVERED,
  failed: DO_TAB_FAILED,
  billed: DO_TAB_BILLED,
};
const STATUS_OPTS = [
  'DRAFT',
  'PLANNED',
  'DISPATCHED',
  'PICKED_UP',
  'DELIVERED',
  'POD_PENDING',
  'UNBILLED',
  'BILLED',
  'FAILED',
  'RETURNED',
  'CANCELLED',
] as const;
type DateOpt = '' | 'today' | 'week' | 'before';
const EMPTY_VIEW = {
  tab: 'all',
  kf: '',
  no: '',
  date: '',
  cust: '',
  veh: '',
  drv: '',
  prod: '',
  route: '',
  st: '',
};
const money = (v: string) =>
  Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * ปฏิบัติการ → ใบส่งของ (DO) (UAT 24 พ.ย. 2569) — ต้นแบบ TMS v4 specDo + kpisX('do') + vPanel 'do' (DoDrawer)
 * ต่างจากต้นแบบ (spec/12 §3 แถว UAT 24 พ.ย. หน้า /do): ไม่มีปุ่มหัว "นำเข้า CSV" / "สร้าง DO" (DO สร้างจาก SO เท่านั้น —
 * docs/01 §4.3, D-81) และ "พิมพ์ใบส่งของวันนี้" / เมนู "พิมพ์ใบส่งของ" (PDF ใบส่งของไม่อยู่ใน backlog เฟส 0 — plan/01
 * ผู้สมัครเพิ่ม #24) · "ยืนยันส่งแล้ว" ทีละใบ (ไม่มี bulk — event ของจุดต้องมี occurredAt ต่อจุด docs/04 E1) เปิดไทม์ไลน์เที่ยว
 * ที่จุดส่งของใบ · ตัวกรองเส้นทาง = ค้นชื่อจุดรับ/ส่ง (DO ไม่ผูกเส้นทาง master) · "น้ำหนัก / เที่ยว" = น้ำหนัก + เลขเที่ยว
 */
export function DoPage() {
  const { t } = useI18n();
  const me = useMe();
  const dateText = useDateText();
  const scopes = me.data?.scopes ?? [];
  const canTrips = can(scopes, 'trips:read');
  const canSell = can(scopes, 'prices.sell:read');
  const [tab, setTab] = useSessionState<Tab>('do.tab', 'all');
  /** การ์ด: ส่งแล้ววันนี้ / ยังไม่วางบิล (ต้นแบบ kfs) */
  const [kf, setKf] = useSessionState<'' | 'today' | 'unbilled'>('do.kf', '');
  const [col, setCol] = useSessionState('do.cols', {
    no: '',
    date: '' as DateOpt,
    cust: '',
    veh: '',
    drv: '',
    prod: '',
    route: '',
    st: '',
  });
  const [hidden, setHidden] = useSessionState<string[] | null>('do.hidden', null);
  const views = useSavedViews({
    page: 'delivery-orders',
    state: { tab, kf, ...col },
    hidden,
    empty: EMPTY_VIEW,
    apply: (v) => {
      const s = pick(v.state, EMPTY_VIEW);
      setTab(TABS.includes(s.tab as Tab) ? (s.tab as Tab) : 'all');
      setKf(s.kf === 'today' || s.kf === 'unbilled' ? s.kf : '');
      setCol({
        no: s.no,
        date: (['today', 'week', 'before'].includes(s.date) ? s.date : '') as DateOpt,
        cust: s.cust,
        veh: s.veh,
        drv: s.drv,
        prod: s.prod,
        route: s.route,
        st: s.st,
      });
      setHidden(v.hidden);
    },
  });
  const summary = useDoSummary();
  const s = summary.data;
  // "วันนี้" = วันของ server (เวลาไทย — summary.date) · ยังไม่ได้ = นาฬิกาเครื่อง (เวลาไทย)
  const today = s?.date ?? bangkokToday();
  const range: Pick<DoFilters, 'dateFrom' | 'dateTo'> =
    kf === 'today' || col.date === 'today'
      ? { dateFrom: today, dateTo: today }
      : col.date === 'week'
        ? { dateFrom: addDays(today, -7), dateTo: addDays(today, -1) } // ต้นแบบ: -7..-1 (วันนี้แยกเป็น "วันนี้")
        : col.date === 'before'
          ? { dateFrom: '', dateTo: addDays(today, -8) }
          : { dateFrom: '', dateTo: '' };
  const filters: DoFilters = {
    status:
      kf === 'today'
        ? OPS_DO_DELIVERED.join(',')
        : kf === 'unbilled'
          ? DO_TAB_DELIVERED.join(',')
          : tab === 'all'
            ? col.st
            : TAB_STATUS[tab].join(','),
    ...range,
    doNo: col.no,
    customerName: col.cust,
    vehiclePlate: col.veh,
    driverName: col.drv,
    product: col.prod,
    route: col.route ?? '',
    rejected: kf ? '' : tab === 'delivered' ? 'false' : tab === 'rejected' ? 'true' : '',
  };
  const list = useDoList(filters);
  const [openId, setOpenId] = useState<string | null>(null);
  useDeepOpen('open', 'do', setOpenId);
  const [tripId, setTripId] = useState<string | null>(null);
  /** "ยืนยันส่งแล้ว" → drawer เที่ยว แท็บไทม์ไลน์ + dialog ปิดงานที่จุดส่งของ DO นี้ */
  const [completeDo, setCompleteDo] = useState<string | null>(null);
  const [returnDo, setReturnDo] = useState<Do | null>(null);
  const bulk = useBulkAssign();
  const [bulkFail, setBulkFail] = useState<{ results: BulkResults['results']; no: string } | null>(
    null,
  );
  const perms: DoPerms = {
    canSeePrice: canSell,
    canSeeTrip: canTrips,
    canRecord: canTrips && can(scopes, 'trips:dispatch'),
    canRelease: canTrips && can(scopes, 'trips:dispatch') && can(scopes, 'trips:assign'),
    canResolve: can(scopes, 'orders:write'),
    canCancel: can(scopes, 'orders:cancel'),
  };
  const openTrip = (id: string) => {
    setCompleteDo(null);
    setTripId(id);
  };
  /** ยืนยันส่งแล้ว (ทีละใบ — event ต่อจุดต้องมี occurredAt ของจุดนั้น docs/04 E1 จึงไม่มีแบบหลายใบ) */
  const confirm = (d: Do) => {
    if (!d.tripId) return;
    setCompleteDo(d.id);
    setTripId(d.tripId);
  };
  /** ปล่อยงานให้คนขับ = ปล่อยเที่ยวของ DO (bulk-assign dispatch — กฎตอนจัดชุดเดียวกับกระดาน) */
  const release = async (d: Do) => {
    if (!d.tripId || bulk.isPending) return;
    try {
      const tr = (await unwrap(
        api.GET('/v1/trips/{id}', { params: { path: { id: d.tripId } } }),
      )) as TripDetail;
      const r = await bulk.mutateAsync({
        items: [{ tripId: tr.id, version: tr.version }],
        dispatch: true,
      });
      if (r.results.some((i) => !i.trip)) setBulkFail({ results: r.results, no: tr.tripNo });
      else {
        setOpenId(null);
        setToast(t('dos.toast.released', { no: d.doNo, trip: tr.tripNo }));
      }
    } catch (e) {
      setToast(problemText(e, t) ?? t('dos.loadError'));
    }
  };
  const [orderId, setOrderId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const goTab = (k: Tab) => {
    setKf('');
    setTab(k);
  };

  const columns: Column<Do>[] = [
    {
      key: 'no',
      label: t('dos.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => <DocNo>{r.doNo}</DocNo>,
      csv: (r) => r.doNo,
    },
    {
      key: 'date',
      label: t('dos.col.date'),
      width: '1%',
      ...(kf !== 'today'
        ? {
            filter: {
              type: 'select' as const,
              options: [
                { value: '', label: t('table.all') },
                { value: 'today', label: t('dos.date.today') },
                { value: 'week', label: t('dos.date.week') },
                { value: 'before', label: t('dos.date.before') },
              ],
            },
          }
        : {}),
      render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{dateText(r.doDate)}</span>,
      csv: (r) => r.doDate,
    },
    {
      key: 'cust',
      label: t('dos.col.cust'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span
          title={r.customerName ?? ''}
          className="tms-ellipsis"
          style={{ maxWidth: 220, display: 'inline-block', verticalAlign: 'bottom' }}
        >
          {r.customerName ?? '—'}
        </span>
      ),
      csv: (r) => r.customerName ?? '',
    },
    {
      key: 'route',
      label: t('dos.col.route'),
      width: '1%',
      // ต้นแบบมีตัวกรองเส้นทาง — DO ไม่ผูกเส้นทาง master → ค้นชื่อจุดรับ/จุดส่ง (API `route`)
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span className="tms-route-cell" title={`${r.originSiteName} → ${r.destSiteName}`}>
          <RouteChip
            from={
              <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                {r.originSiteName ?? '—'}
              </span>
            }
            to={
              <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                {r.destSiteName ?? '—'}
              </span>
            }
          />
        </span>
      ),
      csv: (r) => `${r.originSiteName ?? ''} → ${r.destSiteName ?? ''}`,
    },
    {
      key: 'veh',
      label: t('dos.col.veh'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      // ต้นแบบ cW(ทะเบียน, ประเภทรถ)
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
          <span className="tms-num" style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
            {r.vehiclePlate ?? '—'}
          </span>
          {r.vehicleTypeName && (
            <span style={{ color: '#3B424C', whiteSpace: 'nowrap' }}>{r.vehicleTypeName}</span>
          )}
        </div>
      ),
      csv: (r) => r.vehiclePlate ?? '',
    },
    {
      key: 'drv',
      label: t('dos.col.drv'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span style={{ whiteSpace: 'nowrap' }}>{r.driverName ?? r.carrierName ?? '—'}</span>
      ),
      csv: (r) => r.driverName ?? r.carrierName ?? '',
    },
    {
      key: 'w',
      label: t('dos.col.w'),
      align: 'right',
      width: '1%',
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
          <span className="tms-num" style={{ whiteSpace: 'nowrap' }}>
            {r.weightKg ? t('dos.kg', { n: Number(r.weightKg).toLocaleString('th-TH') }) : '—'}
          </span>
          <span className="tms-num" style={{ color: '#3B424C', whiteSpace: 'nowrap' }}>
            {r.tripNo ?? '—'}
          </span>
        </div>
      ),
      csv: (r) => `${r.weightKg ?? ''} / ${r.tripNo ?? ''}`,
    },
    {
      key: 'prod',
      label: t('dos.col.prod'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => {
        const p = r.lines[0]?.description ?? '—';
        const txt = r.lines.length > 1 ? t('dos.prodMore', { p, n: r.lines.length - 1 }) : p;
        return (
          <span
            title={r.lines.map((l) => l.description).join(', ')}
            className="tms-ellipsis"
            style={{ maxWidth: 200, display: 'inline-block', verticalAlign: 'bottom' }}
          >
            {txt}
          </span>
        );
      },
      csv: (r) => r.lines.map((l) => l.description).join(', '),
    },
    {
      key: 'st',
      label: t('dos.col.st'),
      width: '1%',
      ...(tab === 'all' && !kf
        ? {
            filter: {
              type: 'select' as const,
              options: [
                { value: '', label: t('table.all') },
                ...STATUS_OPTS.map((x) => ({ value: x, label: t(`do.st.${x}` as MessageKey) })),
              ],
            },
          }
        : {}),
      render: (r) => (
        <StatusDot label={t(`do.st.${r.status}` as MessageKey)} tone={DO_TONE[r.status]} />
      ),
      csv: (r) => t(`do.st.${r.status}` as MessageKey),
    },
  ];

  const tabCount: Record<Tab, number | undefined> = {
    all: s?.total,
    draft: s?.draft,
    transit: s?.inTransit,
    delivered: s?.deliveredClean,
    rejected: s?.rejected,
    failed: s?.failedTotal,
    billed: s?.billed,
  };
  const colFiltered = !!(
    col.no ||
    col.date ||
    col.cust ||
    col.veh ||
    col.drv ||
    col.prod ||
    col.route ||
    (tab === 'all' && !kf && col.st)
  );
  const shownTotal = listTotal(
    list,
    {
      tab: tab === 'all' ? '' : tab,
      kf,
      ...col,
      ...(tab !== 'all' || kf ? { st: '' } : {}),
      ...(kf === 'today' ? { date: '' } : {}),
    },
    ['tab', 'kf'],
    kf === 'today' ? s?.delivered : kf === 'unbilled' ? s?.unbilled : tabCount[tab],
  );

  return (
    <>
      <PageHeader title={t('page.do.title')} sub={t('page.do.sub')} />
      <SummaryStrip
        items={[
          {
            value: s?.draft ?? '—',
            label: t('dos.kpi.draft'),
            color: '#101418',
            onClick: () => goTab('draft'),
            pressed: tab === 'draft' && !kf,
          },
          {
            value: s?.inTransit ?? '—',
            label: t('dos.kpi.transit'),
            color: '#2257C4',
            onClick: () => goTab('transit'),
            pressed: tab === 'transit' && !kf,
          },
          {
            value: s?.delivered ?? '—',
            label: t('dos.kpi.today'),
            color: '#17733F',
            onClick: () => {
              setTab('all');
              setKf((v) => (v === 'today' ? '' : 'today'));
            },
            pressed: kf === 'today',
          },
          {
            // ต้นแบบ: label "ยังไม่วางบิล · N ใบ" + ค่า = มูลค่า ฿ (ไม่มีสิทธิ์ราคาขาย = จำนวนใบ)
            value:
              s === undefined
                ? '—'
                : canSell && s.sellUnbilledAmount !== undefined
                  ? t('ord.baht', { n: money(s.sellUnbilledAmount) })
                  : s.unbilled,
            label: t('dos.kpi.unbilled', { n: s?.unbilled ?? '—' }),
            color: '#8F5500',
            onClick: () => {
              setTab('all');
              setKf((v) => (v === 'unbilled' ? '' : 'unbilled'));
            },
            pressed: kf === 'unbilled',
          },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={(k) => goTab(k as Tab)}
          items={TABS.map((k) => ({
            key: k,
            label: k === 'all' ? t('table.all') : t(`dos.tab.${k}` as MessageKey),
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
            title={t('dos.loadError')}
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
            filters={{
              no: col.no,
              date: col.date,
              cust: col.cust,
              veh: col.veh,
              drv: col.drv,
              prod: col.prod,
              route: col.route ?? '',
              st: col.st,
            }}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(r) => setOpenId(r.id)}
            rowMenu={(r) => [
              { label: t('ord.menu.view'), icon: 'eye', run: () => setOpenId(r.id) },
              ...(canConfirm(r, perms)
                ? [{ label: t('dos.act.confirm'), icon: 'circle-check', run: () => confirm(r) }]
                : []),
              ...(canReturnDo(r, perms)
                ? [
                    {
                      label: t(modeOf(r.status) === 'failed' ? 'prt.btnFailed' : 'prt.btn'),
                      icon: 'undo-2',
                      run: () => setReturnDo(r),
                    },
                  ]
                : []),
            ]}
            empty={
              colFiltered || tab !== 'all' || kf ? (
                <EmptyState
                  icon="search-x"
                  title={t('table.emptyTitle')}
                  description={t('table.noMatch')}
                />
              ) : (
                <EmptyState
                  icon="package"
                  title={t('dos.emptyTitle')}
                  description={t('dos.emptyDesc')}
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
      {openId && (
        <DoDrawer
          key={openId}
          id={openId}
          perms={perms}
          onOpenTrip={(x) => {
            setOpenId(null);
            openTrip(x);
          }}
          onOpenOrder={(x) => {
            setOpenId(null);
            setOrderId(x);
          }}
          onConfirm={(d) => {
            setOpenId(null);
            confirm(d);
          }}
          onRelease={(d) => release(d)}
          onToast={setToast}
          onClose={() => setOpenId(null)}
        />
      )}
      {tripId && (
        <TripDrawer
          key={`${tripId}:${completeDo ?? ''}`}
          id={tripId}
          {...(completeDo ? { initialTab: 'tl' as const, completeDoId: completeDo } : {})}
          canEdit={can(scopes, 'trips:assign')}
          canDispatch={can(scopes, 'trips:dispatch')}
          canOverride={can(scopes, 'trips:override')}
          canPrint={can(scopes, 'documents:write')}
          canHire={can(scopes, 'trips:assign') && can(scopes, 'prices.buy:read')}
          canClose={can(scopes, 'trips:close')}
          canSeeBuy={can(scopes, 'prices.buy:read')}
          canSeeSell={canSell}
          onDone={(m) => {
            setTripId(null);
            setToast(m);
          }}
          onClose={() => {
            setTripId(null);
            setCompleteDo(null);
          }}
        />
      )}
      {orderId && (
        <OrderDrawer
          key={orderId}
          id={orderId}
          canWrite={false}
          canCancel={false}
          canSeePrice={canSell}
          canEditPrice={false}
          canUnlock={false}
          canSeeTrips={canTrips}
          onOpenTrip={(x) => {
            setOrderId(null);
            openTrip(x);
          }}
          onClose={() => setOrderId(null)}
          onEdit={() => undefined}
          onCopy={() => undefined}
          onSaveTemplate={() => undefined}
          onDone={(m) => setToast(m)}
        />
      )}
      {returnDo && (
        <DoReturnLauncher
          d={returnDo}
          onClose={() => setReturnDo(null)}
          onDone={(m) => {
            setReturnDo(null);
            setToast(m);
          }}
        />
      )}
      {bulkFail && (
        <BulkFailDialog
          results={bulkFail.results}
          tripNo={() => bulkFail.no}
          onOpen={(id) => {
            setBulkFail(null);
            openTrip(id);
          }}
          onClose={() => setBulkFail(null)}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}

/** "ตีกลับบางส่วน" จากเมนูแถว — โหลดหลักฐานส่งของใบแล้วเปิด dialog ชุดเดียวกับ drawer เที่ยว (ST4-T11) */
function DoReturnLauncher({
  d,
  onClose,
  onDone,
}: {
  d: Do;
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const pod = useDoPods([d.id], true)[0]?.data;
  const mode = modeOf(d.status);
  if (!pod || !mode) return null;
  return <ReturnDialog d={d} pod={pod} mode={mode} onClose={onClose} onDone={onDone} />;
}
