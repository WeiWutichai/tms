import type { Schemas } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  DataTable,
  DocNo,
  EmptyState,
  FilterChip,
  KpiCard,
  RouteChip,
  StatusDot,
  Toast,
  type Column,
  type Tone,
} from '@tms/ui';
import { useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, unwrap } from '../api';
import { formatDate, useI18n, type T } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { can } from '../nav';
import { PageHeader } from '../shell/Header';
import { useMe } from '../shell/AppShell';
import { tableLabels } from '../features/companies/CompanySample';
import {
  CARDS,
  FLEET_LINKS,
  cardQuery,
  holdLink,
  isCardKey,
  kindOf,
  type CardDef,
  type CardKey,
  type ListKind,
} from '../features/dashboard/opsCards';
import { ImportExcelButton } from '../features/imports/ImportExcelButton';
import { problemText } from '../features/master/problems';
import { listTotal, useCursorList } from '../features/master/useCursorList';
import {
  OrderDrawer,
  dueOf,
  orderStatusLabel,
  overdueDays,
  statusTone,
} from '../features/orders/OrderDrawer';
import type { Order } from '../features/orders/orderForm';
import { useDateText } from '../features/rate-cards/rateFormat';
import { SetupChecklist } from '../features/setup/SetupChecklist';
import { SettleDash } from '../features/dashboard/SettleDash';
import { TripDrawer } from '../features/trips/TripDrawer';

type Trip = Schemas['TripDto'];
type Do = Schemas['DeliveryOrderDto'];

/** แถวของตาราง "ต้องทำวันนี้" — คอลัมน์ตามต้นแบบ (specSo dash) ใช้ร่วมกันทั้ง SO / DO / เที่ยว */
interface Row {
  id: string;
  kind: ListKind;
  no: string;
  cust: string;
  from: string;
  to: string;
  plate: string | null;
  driver: string | null;
  status: string;
  tone: Tone | undefined;
  due: string;
  late: boolean;
  /** เปิด drawer: SO = ใบสั่ง, เที่ยว = เที่ยว, DO = เที่ยวของ DO (ไม่มีเที่ยว = ใบสั่งต้นทาง) */
  open: { order?: string; trip?: string };
}

const TRIP_TONE: Partial<Record<string, Tone>> = {
  OFFERED: 'warn',
  DISPATCHED: 'info',
  IN_PROGRESS: 'info',
  COMPLETED: 'ok',
  CANCELLED: 'off',
};
const DO_TONE: Partial<Record<string, Tone>> = {
  DRAFT: 'warn',
  PLANNED: 'info',
  DISPATCHED: 'info',
  PICKED_UP: 'info',
  DELIVERED: 'ok',
  POD_PENDING: 'ok',
  UNBILLED: 'ok',
  BILLED: 'ok',
  FAILED: 'err',
  RETURNED: 'err',
  CANCELLED: 'off',
};

function soRow(t: T, o: Order, today: string): Row {
  const a = o.stops.find((x) => x.type === 'PICKUP') ?? o.stops[0];
  const b =
    [...o.stops].reverse().find((x) => x.type === 'DELIVERY') ?? o.stops[o.stops.length - 1];
  return {
    id: o.id,
    kind: 'so',
    no: o.soNo ?? t('ord.draftNo'),
    cust: o.customer.legalName ?? o.customer.name ?? o.customer.externalId ?? '—',
    from: a?.siteText ?? '—',
    to: b && b !== a ? b.siteText : '',
    plate: null,
    driver: null,
    status: orderStatusLabel(t, o),
    tone: statusTone(o),
    due: dueOf(o).date,
    late: overdueDays(o, today) > 0,
    open: { order: o.id },
  };
}
function doRow(t: T, d: Do, canTrips: boolean): Row {
  return {
    id: d.id,
    kind: 'do',
    no: d.doNo,
    cust: d.customerName,
    from: d.originSiteName,
    to: d.destSiteName,
    plate: d.vehiclePlate,
    driver: d.driverName ?? d.carrierName,
    status: t(`do.st.${d.status}` as MessageKey),
    tone: DO_TONE[d.status],
    due: d.doDate,
    late: false,
    open: d.tripId && canTrips ? { trip: d.tripId } : { order: d.orderId },
  };
}
function tripRow(t: T, x: Trip): Row {
  const a = x.stops[0];
  const b = x.stops[x.stops.length - 1];
  return {
    id: x.id,
    kind: 'trip',
    no: x.tripNo,
    cust: x.carrier?.name ?? '—',
    from: a?.siteName ?? '—',
    to: b && b !== a ? b.siteName : '',
    plate: x.vehicle?.plate ?? null,
    driver: x.driver?.name ?? null,
    status: t(`trip.st.${x.status}` as MessageKey),
    tone: TRIP_TONE[x.status],
    due: x.tripDate,
    late: false,
    open: { trip: x.id },
  };
}

const card: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #CDD1C8',
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};
const h2: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };
const box: CSSProperties = {
  border: '1px solid #D9DCD4',
  borderRadius: 8,
  padding: '12px 14px',
  background: '#FFFFFF',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
};
const boxN = (c: string): CSSProperties => ({
  fontSize: 24,
  fontWeight: 600,
  color: c,
  fontVariantNumeric: 'tabular-nums',
});
const boxL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const num = (n: number) => n.toLocaleString('th-TH');

/**
 * ภาพรวม = Dashboard ปฏิบัติการ (ST9-T01; docs/04 H, spec/09 §1) — ต้นแบบ TMS v4 `is.dash`:
 * หัว → KPI (kpis('dash'), คลิก = กรองตาราง) → เริ่มต้นใช้งาน → ทางลัด → ตาราง "ต้องทำวันนี้" → การ์ดล่าง
 * ตัวเลขทุกใบมาจาก summary ของรายการต้นทาง (นับด้วยตัวกรองเดียวกับรายการ) และตารางใช้ `/v1` รายการเดียวกันกับตัวกรองนั้น
 * การ์ดที่ไม่มีสิทธิ์ไม่ render · ไม่มีตัวเลขเงิน (RPT-011) · การ์ดที่โหลดไม่สำเร็จแสดง "โหลดไม่สำเร็จ · ลองใหม่" การ์ดอื่นยังแสดง
 */
export function Dashboard() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const dateText = useDateText();
  const canOrders = can(scopes, 'orders:read');
  const canTrips = can(scopes, 'trips:read');
  const canFleet = can(scopes, 'master:read');
  const canWrite = can(scopes, 'orders:write');
  const [params, setParams] = useSearchParams();
  const [toast, setToast] = useState<string | null>(null);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [openTrip, setOpenTrip] = useState<string | null>(null);

  const so = useQuery({
    queryKey: ['orders', 'summary'],
    enabled: canOrders,
    queryFn: () => unwrap(api.GET('/v1/orders/summary')),
  });
  const dos = useQuery({
    queryKey: ['delivery-orders', 'summary'],
    enabled: canOrders,
    queryFn: () => unwrap(api.GET('/v1/delivery-orders/summary')),
  });
  const trips = useQuery({
    queryKey: ['trips', 'summary'],
    enabled: canTrips,
    queryFn: () => unwrap(api.GET('/v1/trips/summary')),
  });
  const veh = useQuery({
    queryKey: ['vehicles', 'summary'],
    enabled: canFleet,
    queryFn: () => unwrap(api.GET('/v1/vehicles/summary')),
  });

  const cards = CARDS.filter((c) => can(scopes, c.perm));
  const raw = params.get('card');
  // งานวันนี้ = มุมมองเริ่มต้นของตาราง (ต้นแบบ: การ์ดแรกล้างตัวกรอง) · การ์ดอื่น = `?card=` (ตัวกรองอยู่ใน URL)
  const sel: CardDef | undefined =
    cards.find((c) => c.key === (isCardKey(raw) ? raw : 'today')) ?? cards[0];
  const pick = (k: CardKey) => {
    const next = new URLSearchParams(params);
    if (k === 'today' || sel?.key === k) next.delete('card');
    else next.set('card', k);
    setParams(next, { replace: true });
  };

  const value = (
    k: CardKey,
  ): { v: number | undefined; q: { isError: boolean; refetch: () => unknown } } => {
    switch (k) {
      case 'today':
        return { v: dos.data?.today, q: dos };
      case 'delivered':
        return { v: dos.data?.delivered, q: dos };
      case 'failed':
        return { v: dos.data?.failed, q: dos };
      case 'waiting':
        return { v: so.data?.waiting, q: so };
      case 'running':
        return { v: trips.data?.running, q: trips };
      case 'offered':
        return { v: trips.data?.offered, q: trips };
    }
  };

  // ---------- ตาราง "ต้องทำวันนี้" ----------
  const date = dos.data?.date;
  const soToday = so.data?.today;
  const kind = sel?.kind;
  // วันนี้จาก server (เวลาไทย): DO ใช้ `delivery-orders/summary.date` · รอจัดรถใช้ `orders/summary.today`
  const dayOf = kind === 'do' ? date : kind === 'so' ? soToday : '';
  const ready = !!sel && dayOf !== undefined;
  const query = sel && ready ? cardQuery(sel.key, dayOf ?? '') : {};
  // ชนิดรายการอ่านจาก `card` ในตัวกรองที่หน่วงแล้ว (ไม่ใช่ค่าปัจจุบัน) — การ์ด + ตัวกรองเปลี่ยนพร้อมกันเสมอ
  // (เดิมชนิดเปลี่ยนทันทีแต่ตัวกรองหน่วง 300 ms → ยิงตัวกรองของการ์ดเก่าไป endpoint ใหม่ = 422 — review ST9-T01)
  const list = useCursorList<Row>(
    'dash',
    { card: sel?.key ?? '', ...query },
    async (q) => {
      const { card, ...rest } = q;
      const k = kindOf(String(card));
      const today = soToday ?? '';
      if (k === 'so') {
        const p = await unwrap(api.GET('/v1/orders', { params: { query: rest as never } }));
        return { ...p, data: (p.data as Order[]).map((o) => soRow(t, o, today)) };
      }
      if (k === 'trip') {
        const p = await unwrap(api.GET('/v1/trips', { params: { query: rest as never } }));
        return { ...p, data: (p.data as Trip[]).map((x) => tripRow(t, x)) };
      }
      const p = await unwrap(api.GET('/v1/delivery-orders', { params: { query: rest as never } }));
      return { ...p, data: (p.data as Do[]).map((d) => doRow(t, d, canTrips)) };
    },
    { sort: '-updatedAt', size: 10, enabled: ready },
  );
  const selValue = sel ? value(sel.key).v : undefined;
  const shownTotal = listTotal(list, { card: sel?.key ?? '' }, ['card'], selValue);

  const columns: Column<Row>[] = [
    {
      key: 'no',
      label: t('dash.col.no'),
      width: '1%',
      render: (r) => <DocNo>{r.no}</DocNo>,
      csv: (r) => r.no,
    },
    {
      key: 'cust',
      label: t('dash.col.cust'),
      render: (r) => (
        <span title={r.cust} className="tms-ellipsis" style={{ color: '#101418', maxWidth: 240 }}>
          {r.cust}
        </span>
      ),
      csv: (r) => r.cust,
    },
    {
      key: 'route',
      label: t('dash.col.route'),
      width: '1%',
      render: (r) =>
        r.to ? (
          <span className="tms-route-cell" title={`${r.from} → ${r.to}`}>
            <RouteChip
              from={
                <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                  {r.from}
                </span>
              }
              to={
                <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
                  {r.to}
                </span>
              }
            />
          </span>
        ) : (
          r.from
        ),
      csv: (r) => [r.from, r.to].filter(Boolean).join(' → '),
    },
    {
      key: 'veh',
      label: t('dash.col.veh'),
      width: '1%',
      render: (r) =>
        r.plate ? (
          <span style={{ display: 'flex', flexDirection: 'column', whiteSpace: 'nowrap' }}>
            <span style={{ color: '#101418' }}>{r.driver ?? t('dash.noDrv')}</span>
            <span className="tms-num" style={{ color: '#3B424C', fontSize: 13 }}>
              {r.plate}
            </span>
          </span>
        ) : (
          <span style={{ color: '#3B424C', whiteSpace: 'nowrap' }}>
            {r.driver ?? t('dash.noVeh')}
          </span>
        ),
      csv: (r) => [r.plate, r.driver].filter(Boolean).join(' '),
    },
    {
      key: 'st',
      label: t('dash.col.st'),
      width: '1%',
      render: (r) => <StatusDot label={r.status} {...(r.tone ? { tone: r.tone } : {})} />,
      csv: (r) => r.status,
    },
    {
      key: 'due',
      label: t('dash.col.due'),
      width: '1%',
      render: (r) => (
        <span
          className="tms-num"
          style={{ color: r.late ? '#B3322A' : '#101418', whiteSpace: 'nowrap' }}
        >
          {dateText(r.due)}
          {r.late && <span style={{ marginLeft: 6, fontWeight: 500 }}>{t('ord.over')}</span>}
        </span>
      ),
      csv: (r) => r.due,
    },
  ];

  const holds = (so.data?.holdReasons ?? []).filter((h) => h.count > 0);
  const fleet = veh.data?.fleet;
  const anyOps = cards.length > 0;

  return (
    <>
      <PageHeader
        title={t('page.dash.title')}
        sub={t('page.dash.sub', {
          // วันที่ของ server (เวลาไทย) — ยังไม่โหลด = วันที่เครื่อง
          date: formatDate(date ? new Date(`${date}T00:00:00`) : new Date(), lang),
        })}
      />
      {anyOps && (
        <div className="tms-kpis" data-testid="dash-kpis">
          {cards.map((c) => {
            const { v, q } = value(c.key);
            const active = sel?.key === c.key && c.key !== 'today';
            if (q.isError)
              return (
                <KpiCard
                  key={c.key}
                  label={t(c.label)}
                  tone={c.tone}
                  value="—"
                  sub={t('dash.kpi.err')}
                  onClick={() => void q.refetch()}
                />
              );
            return (
              <KpiCard
                key={c.key}
                label={<span data-testid={`kpi-${c.key}-label`}>{t(c.label)}</span>}
                tone={c.tone}
                value={<span data-testid={`kpi-${c.key}`}>{v === undefined ? '—' : num(v)}</span>}
                sub={
                  c.key === 'today' && dos.data ? (
                    t('dash.kpi.todaySub', { x: num(dos.data.delivered), y: num(dos.data.today) })
                  ) : c.key === 'waiting' && so.data && so.data.waitingOverdue > 0 ? (
                    // spec/09 §1: บรรทัดรอง "เลยกำหนดรับ n" สีแดง
                    <span style={{ color: '#B3322A' }} data-testid="kpi-waiting-over">
                      {t('dash.kpi.waitingOver', { n: num(so.data.waitingOverdue) })}
                    </span>
                  ) : active ? (
                    t('dash.kpi.clear')
                  ) : (
                    t('dash.kpi.click')
                  )
                }
                active={active}
                activeLabel={t('dash.kpi.on')}
                onClick={() => pick(c.key)}
              />
            );
          })}
        </div>
      )}
      <SetupChecklist />
      {(canWrite || canTrips) && (
        <div
          className="tms-card"
          style={{
            padding: '14px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 500, color: '#3B424C', marginRight: 4 }}>
            {t('dash.quick')}
          </span>
          {canWrite && (
            <Button variant="primary" icon="plus" onClick={() => nav('/so?new=1')}>
              {t('dash.q.create')}
            </Button>
          )}
          {canWrite && (
            <ImportExcelButton
              kind="order"
              icon="upload"
              label={t('dash.q.csv')}
              onDone={(m) => setToast(m)}
            />
          )}
          {canTrips && (
            <Button variant="secondary" icon="calendar-range" onClick={() => nav('/plan')}>
              {t('dash.q.plan')}
            </Button>
          )}
        </div>
      )}
      {sel && (
        <div className="tms-listbody">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
            <h2 style={{ ...h2, margin: '4px 0 0' }}>{t('dash.todo')}</h2>
            {/* ต้นแบบ: การ์ดที่กรองอยู่แสดงเป็นชิปลบได้เหนือตาราง */}
            {sel.key !== 'today' && (
              <FilterChip
                label={t(sel.label)}
                removeLabel={t('dash.kpi.clear')}
                onRemove={() => pick(sel.key)}
              />
            )}
            <span
              style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}
              data-testid="dash-total"
            >
              {shownTotal !== undefined && t('table.total', { n: shownTotal })}
            </span>
          </div>
          {list.q.isError ? (
            <EmptyState
              icon="circle-alert"
              title={t('dash.loadError')}
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
              // เปลี่ยนการ์ด = เปลี่ยนชนิดรายการ (SO/DO/เที่ยว) — ไม่แสดงแถวชุดเดิมระหว่างโหลด (นับผิด/กดผิดใบ)
              rows={list.loading ? [] : list.rows}
              rowId={(r) => r.id}
              loading={list.loading || !ready}
              labels={tableLabels(t)}
              selectable={false}
              onRowClick={(r) =>
                r.open.trip ? setOpenTrip(r.open.trip) : setOpenOrder(r.open.order ?? null)
              }
              empty={
                sel.key === 'today' ? (
                  <EmptyState
                    icon="clipboard-check"
                    title={t('dash.empty.title')}
                    description={t('dash.empty.desc')}
                  />
                ) : (
                  <EmptyState
                    icon="search-x"
                    title={t('table.emptyTitle')}
                    description={t('table.noMatch')}
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
      )}
      {(canOrders || canFleet) && (
        <div className="tms-dash-bottom">
          {canOrders && (
            <section style={card} data-testid="dash-holds">
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <h2 style={h2}>{t('dash.hold.title')}</h2>
              </div>
              {so.isError ? (
                <Button variant="secondary" icon="refresh-cw" onClick={() => void so.refetch()}>
                  {t('dash.kpi.err')}
                </Button>
              ) : (
                <>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      border: '1px solid #D9DCD4',
                      borderRadius: 8,
                      overflow: 'hidden',
                    }}
                  >
                    {holds.length === 0 ? (
                      <span style={{ padding: '8px 12px', color: '#3B424C' }}>
                        {so.data ? t('dash.hold.none') : '—'}
                      </span>
                    ) : (
                      holds.map((h) => (
                        <button
                          key={h.code}
                          type="button"
                          className="tms-dash-row"
                          data-testid={`hold-${h.code}`}
                          onClick={() => nav(holdLink(h.code))}
                        >
                          <span>{t(`ord.hold.${h.code}` as MessageKey)}</span>
                          <span className="tms-num" data-testid={`hold-${h.code}-n`}>
                            {num(h.count)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                    <Button variant="secondary" onClick={() => nav('/so/hold')}>
                      {t('dash.hold.go')}
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}
          {canFleet && (
            <section style={card} data-testid="dash-fleet">
              <h2 style={h2}>{t('dash.fleet.title')}</h2>
              {veh.isError ? (
                <Button variant="secondary" icon="refresh-cw" onClick={() => void veh.refetch()}>
                  {t('dash.kpi.err')}
                </Button>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                    {(
                      [
                        ['available', '#17733F'],
                        ['inUse', '#2257C4'],
                        ['maintenance', '#B3322A'],
                      ] as const
                    ).map(([k, c]) => (
                      <button
                        key={k}
                        type="button"
                        style={box}
                        data-testid={`fleet-${k}`}
                        onClick={() => nav(FLEET_LINKS[k])}
                      >
                        <span style={boxN(c)} data-testid={`fleet-${k}-n`}>
                          {fleet ? num(fleet[k]) : '—'}
                        </span>
                        <span style={boxL}>{t(`dash.fleet.${k}`)}</span>
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                    <Button variant="secondary" onClick={() => nav('/fleet/vehicles')}>
                      {t('dash.fleet.go')}
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      )}
      {/* ST9-T03 Dashboard AP รถร่วม — ตรวจสิทธิ์/แพ็กเกจในตัว (ไม่มีสิทธิ์ = ไม่ render ไม่เรียก API) */}
      <SettleDash />
      {openOrder && (
        <OrderDrawer
          key={openOrder}
          id={openOrder}
          canWrite={false}
          canCancel={false}
          canSeePrice={can(scopes, 'prices.sell:read')}
          canEditPrice={false}
          canUnlock={false}
          canSeeTrips={canTrips}
          onOpenTrip={(x) => {
            setOpenOrder(null);
            setOpenTrip(x);
          }}
          onClose={() => setOpenOrder(null)}
          onEdit={() => nav('/so')}
          onCopy={() => nav('/so')}
          onSaveTemplate={() => nav('/so')}
          onDone={(m) => setToast(m)}
        />
      )}
      {openTrip && (
        <TripDrawer
          key={openTrip}
          id={openTrip}
          canEdit={can(scopes, 'trips:assign')}
          canDispatch={can(scopes, 'trips:dispatch')}
          canOverride={can(scopes, 'trips:override')}
          canPrint={can(scopes, 'documents:write')}
          canHire={can(scopes, 'trips:assign') && can(scopes, 'prices.buy:read')}
          onDone={setToast}
          onClose={() => setOpenTrip(null)}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
