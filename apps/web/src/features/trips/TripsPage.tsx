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
  type Tone,
} from '@tms/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TRIP_NOT_CANCELLED,
  TRIP_TAB_DONE,
  TRIP_TAB_IN_TRANSIT,
  TRIP_TAB_PLANNING,
} from '@tms/domain/src/ops-lists';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { useDeepOpen } from '../../shell/deepLink';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { BulkFailDialog } from '../planning/BulkFailDialog';
import { bangkokToday, useDateText } from '../rate-cards/rateFormat';
import { SavedViewMenu } from '../views/SavedViewMenu';
import { pick, useSavedViews } from '../views/useSavedViews';
import { TripBoard } from './TripBoard';
import { TripDrawer } from './TripDrawer';
import { useTripList, useTripSummary, type TripFilters, type TripRow } from './useTripList';
import { useBulkAssign, usePrintTripSheet, type BulkResults } from './useTrips';

type Tab = 'all' | 'planning' | 'transit' | 'done';
const TABS: Tab[] = ['all', 'planning', 'transit', 'done'];
/** แท็บของต้นแบบ (specTrp tabs วางแผน / ระหว่างส่ง / ส่งแล้ว) → สถานะจริง (`@tms/domain` ops-lists — ชุดเดียวกับตัวนับของ API) */
const TAB_STATUS: Record<Tab, readonly string[]> = {
  all: [],
  planning: TRIP_TAB_PLANNING,
  transit: TRIP_TAB_IN_TRANSIT,
  done: TRIP_TAB_DONE,
};
const TAB_LABEL: Record<Exclude<Tab, 'all'>, MessageKey> = {
  planning: 'trips.kpi.planning',
  transit: 'trips.kpi.transit',
  done: 'trips.kpi.done',
};
const STATUS_OPTS = [
  'PLANNING',
  'OFFERED',
  'ASSIGNED',
  'DISPATCHED',
  'IN_PROGRESS',
  'COMPLETED',
  'COSTED',
  'SETTLED',
  'CANCELLED',
] as const;
const TONE: Partial<Record<string, Tone>> = {
  OFFERED: 'warn',
  ASSIGNED: 'ok',
  DISPATCHED: 'info',
  IN_PROGRESS: 'info',
  COMPLETED: 'ok',
  COSTED: 'ok',
  SETTLED: 'ok',
  CANCELLED: 'off',
};
const EMPTY_VIEW = { tab: 'all', sub: false, no: '', veh: '', drv: '', st: '' };
/** ปล่อยได้ (ก่อนปล่อยรถ) — ต้นแบบ menu `r.st === 'วางแผน'` */
const RELEASABLE = new Set(['PLANNING', 'ASSIGNED']);
const money = (v: string | null | undefined) =>
  v === undefined || v === null
    ? '—'
    : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * ปฏิบัติการ → เที่ยวรถ (UAT 24 พ.ย. 2569) — ต้นแบบ TMS v4 หน้า `trips`: PageHeader + การ์ด (kpis trips) + กระดาน (vTrpB)
 * + ตาราง specTrp (แท็บ/ตัวกรองคอลัมน์/เมนูแถว/bulk) + drawer เที่ยว (vPanel 'trp' = TripDrawer)
 * ข้อมูลจาก /v1 ชุดเดียวกับลูกค้า · ต่างจากต้นแบบ (spec/12 §3 [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้]):
 * ไม่มีปุ่ม "เปิดแอปคนขับ" (แอปคนขับนอกเฟส 0) และเมนู "แจ้งอุบัติเหตุ" (โมดูลอุบัติเหตุ P1) · คอลัมน์เส้นทางไม่มีตัวกรอง
 * (เที่ยวไม่ผูกเส้นทาง master) · รายได้/ค่าเที่ยวแสดงตามสิทธิ์ราคา
 */
export function TripsPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const me = useMe();
  const dateText = useDateText();
  const scopes = me.data?.scopes ?? [];
  const canAssign = can(scopes, 'trips:assign');
  const canDispatch = can(scopes, 'trips:dispatch');
  const canPrint = can(scopes, 'documents:write');
  const canSell = can(scopes, 'prices.sell:read');
  const canBuy = can(scopes, 'prices.buy:read');
  const [tab, setTab] = useSessionState<Tab>('trips.tab', 'all');
  const [sub, setSub] = useSessionState('trips.sub', false);
  const [col, setCol] = useSessionState('trips.cols', { no: '', veh: '', drv: '', st: '' });
  const [hidden, setHidden] = useSessionState<string[] | null>('trips.hidden', null);
  const views = useSavedViews({
    page: 'trips',
    state: { tab, sub, ...col },
    hidden,
    empty: EMPTY_VIEW,
    apply: (v) => {
      const s = pick(v.state, EMPTY_VIEW);
      setTab(TABS.includes(s.tab as Tab) ? (s.tab as Tab) : 'all');
      setSub(s.sub);
      setCol({ no: s.no, veh: s.veh, drv: s.drv, st: s.st });
      setHidden(v.hidden);
    },
  });
  const tabStatus = TAB_STATUS[tab].join(',');
  const filters: TripFilters = {
    status:
      tab === 'all' && col.st ? col.st : tabStatus || (sub ? TRIP_NOT_CANCELLED.join(',') : ''),
    ownership: sub ? 'SUBCON' : '',
    tripNo: col.no,
    vehiclePlate: col.veh,
    driverName: col.drv,
  };
  const list = useTripList(filters);
  const summary = useTripSummary();
  const s = summary.data;
  const [openId, setOpenId] = useState<string | null>(null);
  useDeepOpen('open', 'trp', setOpenId);
  const [toast, setToast] = useState<string | null>(null);
  const bulk = useBulkAssign();
  const [bulkFail, setBulkFail] = useState<BulkResults['results'] | null>(null);
  const print = usePrintTripSheet();
  const today = bangkokToday();

  const goTab = (k: Tab) => {
    setSub(false);
    setTab(k);
  };
  const release = (rows: TripRow[]) => {
    const xs = rows.filter((r) => RELEASABLE.has(r.status) && r.deliveryOrders.length > 0);
    if (!xs.length || bulk.isPending) return;
    bulk.mutate(
      { items: xs.map((x) => ({ tripId: x.id, version: x.version })), dispatch: true },
      {
        onSuccess: (r) => {
          if (r.results.some((i) => !i.trip)) setBulkFail(r.results);
          else setToast(t('trip.toast.released', { n: r.succeeded }));
        },
        onError: (e) => setToast(problemText(e, t) ?? t('trips.loadError')),
      },
    );
  };
  const printMany = async (rows: TripRow[]) => {
    const xs = rows.filter((r) => r.status !== 'CANCELLED' && r.stops.length > 0);
    let n = 0;
    for (const x of xs) {
      try {
        await print.mutateAsync(x.id);
        n++;
      } catch (e) {
        setToast(problemText(e, t) ?? t('trips.loadError'));
        return;
      }
    }
    if (n)
      setToast(
        n === 1 ? t('trip.toast.printed', { no: xs[0]!.tripNo }) : t('trips.toast.printedN', { n }),
      );
  };
  const tripNoOf = (id: string) => list.rows.find((r) => r.id === id)?.tripNo ?? id;

  const columns: Column<TripRow>[] = [
    {
      key: 'no',
      label: t('trips.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => <DocNo>{r.tripNo}</DocNo>,
      csv: (r) => r.tripNo,
    },
    {
      key: 'date',
      label: t('trips.col.date'),
      width: '1%',
      render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{dateText(r.tripDate)}</span>,
      csv: (r) => r.tripDate,
    },
    {
      key: 'veh',
      label: t('trips.col.veh'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <Two
          a={r.vehicle?.plate ?? '—'}
          b={[r.vehicle?.vehicleTypeName, r.trailer?.plate].filter(Boolean).join(' · ')}
          bold
        />
      ),
      csv: (r) => [r.vehicle?.plate, r.trailer?.plate].filter(Boolean).join(' / '),
    },
    {
      key: 'drv',
      label: t('trips.col.drv'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => <Two a={r.driver?.name ?? '—'} b={r.carrier?.name ?? t('trips.own')} />,
      csv: (r) => `${r.driver?.name ?? ''} / ${r.carrier?.name ?? t('trips.own')}`,
    },
    {
      key: 'route',
      label: t('trips.col.route'),
      width: '1%',
      render: (r) => {
        const a = r.stops[0];
        const b = r.stops[r.stops.length - 1];
        return a && b && a !== b ? (
          <span className="tms-route-cell" title={`${a.siteName} → ${b.siteName}`}>
            <RouteChip
              from={
                <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                  {a.siteName}
                </span>
              }
              to={
                <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                  {b.siteName}
                </span>
              }
            />
          </span>
        ) : (
          (a?.siteName ?? '—')
        );
      },
      csv: (r) => r.stops.map((x) => x.siteName).join(' → '),
    },
    {
      key: 'stops',
      label: t('trips.col.stops'),
      width: '1%',
      render: (r) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {t('trips.stops', { n: r.stops.length, d: r.deliveryOrders.length })}
        </span>
      ),
      csv: (r) => t('trips.stops', { n: r.stops.length, d: r.deliveryOrders.length }),
    },
    ...(canSell
      ? [
          {
            key: 'rev',
            label: t('trips.col.rev'),
            align: 'right' as const,
            width: '1%',
            render: (r: TripRow) => <span className="tms-num">{money(r.sellAmount)}</span>,
            csv: (r: TripRow) => r.sellAmount ?? '',
          },
        ]
      : []),
    ...(canBuy
      ? [
          {
            key: 'cost',
            label: t('trips.col.cost'),
            align: 'right' as const,
            width: '1%',
            render: (r: TripRow) => <span className="tms-num">{money(r.buyTotal)}</span>,
            csv: (r: TripRow) => r.buyTotal ?? '',
          },
        ]
      : []),
    {
      key: 'st',
      label: t('trips.col.st'),
      width: '1%',
      ...(tab === 'all'
        ? {
            filter: {
              type: 'select' as const,
              options: [
                { value: '', label: t('table.all') },
                ...STATUS_OPTS.map((x) => ({ value: x, label: t(`trip.st.${x}` as MessageKey) })),
              ],
            },
          }
        : {}),
      render: (r) => (
        <StatusDot label={t(`trip.st.${r.status}` as MessageKey)} tone={TONE[r.status]} />
      ),
      csv: (r) => t(`trip.st.${r.status}` as MessageKey),
    },
  ];

  const tabCount: Record<Tab, number | undefined> = {
    all: undefined,
    planning: s?.planning,
    transit: s?.inTransit,
    done: s?.done,
  };
  const colFiltered = !!(col.no || col.veh || col.drv || (tab === 'all' && col.st));
  const shownTotal = listTotal(
    list,
    {
      tab: tab === 'all' ? '' : tab,
      sub: sub ? '1' : '',
      ...col,
      ...(tab !== 'all' ? { st: '' } : {}),
    },
    ['tab', 'sub'],
    sub ? (tab === 'all' ? s?.subcon : undefined) : tabCount[tab],
  );
  const rowsOf = (ids: string[]) => list.rows.filter((r) => ids.includes(r.id));

  return (
    <>
      <PageHeader
        title={t('page.trips.title')}
        sub={t('page.trips.sub')}
        actions={
          <Button variant="secondary" icon="calendar-range" onClick={() => nav('/plan')}>
            {t('trips.act.plan')}
          </Button>
        }
      />
      <SummaryStrip
        items={[
          {
            value: s?.planning ?? '—',
            label: t('trips.kpi.planning'),
            color: '#101418',
            onClick: () => goTab('planning'),
            pressed: tab === 'planning' && !sub,
          },
          {
            value: s?.inTransit ?? '—',
            label: t('trips.kpi.transit'),
            color: '#2257C4',
            onClick: () => goTab('transit'),
            pressed: tab === 'transit' && !sub,
          },
          {
            value: s?.done ?? '—',
            label: t('trips.kpi.done'),
            color: '#17733F',
            onClick: () => goTab('done'),
            pressed: tab === 'done' && !sub,
          },
          {
            value: s?.subcon ?? '—',
            label: t('trips.kpi.subcon'),
            color: '#101418',
            onClick: () => {
              setTab('all');
              setSub((v) => !v);
            },
            pressed: sub,
          },
        ]}
      />
      <TripBoard
        canAssign={canAssign}
        canDispatch={canDispatch}
        canSeeTypes={can(scopes, 'master:read')}
        today={today}
        releasing={bulk.isPending}
        onOpen={setOpenId}
        onRelease={(x) => release([x])}
        onToast={setToast}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={(k) => goTab(k as Tab)}
          items={TABS.map((k) => ({
            key: k,
            label: k === 'all' ? t('table.all') : t(TAB_LABEL[k]),
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
            title={t('trips.loadError')}
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
            selectable={canDispatch || canPrint}
            bulkActions={[
              ...(canDispatch
                ? [
                    {
                      label: t('trip.foot.release'),
                      icon: 'send',
                      run: (ids: string[]) => release(rowsOf(ids)),
                    },
                  ]
                : []),
              ...(canPrint
                ? [
                    {
                      label: t('trip.foot.print'),
                      icon: 'printer',
                      run: (ids: string[]) => void printMany(rowsOf(ids)),
                    },
                  ]
                : []),
            ]}
            filters={{ no: col.no, veh: col.veh, drv: col.drv, st: col.st }}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(r) => setOpenId(r.id)}
            rowMenu={(r) => [
              { label: t('ord.menu.view'), icon: 'eye', run: () => setOpenId(r.id) },
              ...(canDispatch && RELEASABLE.has(r.status) && r.deliveryOrders.length > 0
                ? [{ label: t('trip.foot.release'), icon: 'send', run: () => release([r]) }]
                : []),
              ...(canPrint && r.status !== 'CANCELLED' && r.stops.length > 0
                ? [{ label: t('trip.foot.print'), icon: 'printer', run: () => void printMany([r]) }]
                : []),
            ]}
            empty={
              colFiltered || tab !== 'all' || sub ? (
                <EmptyState
                  icon="search-x"
                  title={t('table.emptyTitle')}
                  description={t('table.noMatch')}
                />
              ) : (
                <EmptyState
                  icon="route"
                  title={t('trips.emptyTitle')}
                  description={t('trips.emptyDesc')}
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
        <TripDrawer
          key={openId}
          id={openId}
          canEdit={canAssign}
          canDispatch={canDispatch}
          canOverride={can(scopes, 'trips:override')}
          canPrint={canPrint}
          canHire={canAssign && canBuy}
          canClose={can(scopes, 'trips:close')}
          canSeeBuy={canBuy}
          onDone={(m) => {
            setOpenId(null);
            setToast(m);
          }}
          onClose={() => setOpenId(null)}
        />
      )}
      {bulkFail && (
        <BulkFailDialog
          results={bulkFail}
          tripNo={tripNoOf}
          onOpen={(id) => {
            setBulkFail(null);
            setOpenId(id);
          }}
          onClose={() => setBulkFail(null)}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}

/** เซลล์สองบรรทัด (ต้นแบบ cW) */
function Two({ a, b, bold }: { a: string; b: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
      <span style={{ fontWeight: bold ? 500 : 400, whiteSpace: 'nowrap' }}>{a}</span>
      <span style={{ color: '#3B424C', whiteSpace: 'nowrap' }}>{b || '—'}</span>
    </div>
  );
}
