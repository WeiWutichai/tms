import {
  ActivityTimeline,
  Badge,
  Button,
  Drawer,
  DrawerFooterButtons,
  EmptyState,
  ReasonDialog,
  type TimelineItem,
  type Tone,
} from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { toBangkok } from '../orders/orderForm';
import { DoPodBlock } from '../pod/TripDocsTab';
import { ReturnDialog } from '../pod/ReturnDialog';
import { canResolve, modeOf } from '../pod/returnForm';
import { useDoPods } from '../pod/usePod';
import { useDateText, useDateTimeText } from '../rate-cards/rateFormat';
import { FieldChargesTab } from '../trips/FieldChargesTab';
import { useTrip, type TripDetail } from '../trips/useTrips';
import { useCancelDo, useDo, useDoRevenue, type Do } from './useDos';

export const DO_TONE: Partial<Record<string, Tone>> = {
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
const ICON: Partial<Record<string, string>> = {
  DRAFT: 'file-pen',
  PLANNED: 'calendar',
  DISPATCHED: 'navigation',
  PICKED_UP: 'navigation',
  DELIVERED: 'circle-check',
  POD_PENDING: 'circle-check',
  UNBILLED: 'circle-check',
  BILLED: 'receipt',
  FAILED: 'circle-alert',
  RETURNED: 'undo-2',
  CANCELLED: 'ban',
};
/** ยังไม่ปล่อยรถ (ต้นแบบ "ร่าง") */
export const DO_DRAFTISH = new Set(['DRAFT', 'PLANNED']);
/** ระหว่างส่ง (ต้นแบบ "ระหว่างส่ง") */
export const DO_IN_TRANSIT = new Set(['DISPATCHED', 'PICKED_UP']);
const DELIVERED = new Set(['DELIVERED', 'POD_PENDING', 'UNBILLED', 'BILLED']);

const kgText = (v: string | null | undefined) => (v ? Number(v).toLocaleString('th-TH') : null);
const money = (v: string) =>
  Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const sec = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingBottom: 20,
  borderBottom: '1px solid #E4E6E0',
} as const;

function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>{k}</span>
      <span className="tms-num" style={{ color: '#101418', wordBreak: 'break-word' }}>
        {v}
      </span>
    </div>
  );
}

/** สิทธิ์ของ drawer DO (ผู้เรียกคำนวณจาก scope) */
export interface DoPerms {
  canSeePrice: boolean;
  canSeeTrip: boolean;
  /** `trips:dispatch` — ยืนยันส่งแล้ว (บันทึกที่จุดส่ง) / บันทึกหลักฐานส่ง */
  canRecord: boolean;
  /** `trips:assign` + `trips:dispatch` — ปล่อยงานให้คนขับ (ปล่อยเที่ยวของ DO) */
  canRelease: boolean;
  /** `orders:write` — ตีกลับบางส่วน (ส่งซ้ำ/คืนคลัง ST4-T11) */
  canResolve: boolean;
  /** `orders:cancel` — ยกเลิกเอกสาร */
  canCancel: boolean;
}

/** ปุ่ม "ยืนยันส่งแล้ว" ใช้ได้ไหม — DO ระหว่างส่งที่อยู่ในเที่ยว (บันทึกที่จุดส่งของเที่ยว) */
export const canConfirm = (d: Pick<Do, 'status' | 'tripId'>, p: Pick<DoPerms, 'canRecord'>) =>
  p.canRecord && !!d.tripId && DO_IN_TRANSIT.has(d.status);
/** ปุ่ม "ปล่อยงานให้คนขับ" — DO ร่างที่อยู่ในเที่ยวแล้ว (ปล่อยทั้งเที่ยว) */
export const canReleaseDo = (d: Pick<Do, 'status' | 'tripId'>, p: Pick<DoPerms, 'canRelease'>) =>
  p.canRelease && !!d.tripId && DO_DRAFTISH.has(d.status);
/** ปุ่ม "ตีกลับบางส่วน" — มีของปฏิเสธรับคงเหลือ หรือส่งไม่สำเร็จ (กติกาเดียวกับ ST4-T11 / DoPodBlock) */
export const canReturnDo = (d: Pick<Do, 'status' | 'lines'>, p: Pick<DoPerms, 'canResolve'>) =>
  p.canResolve && canResolve(d);

/**
 * Drawer ใบส่งของ (ต้นแบบ TMS v4 vPanel kind 'do'): หัว "ใบส่งของ" + ป้ายสถานะ + เมนู "…" · แท็บ รายละเอียด / ไทม์ไลน์ /
 * หลักฐานส่ง / ค่าใช้จ่ายหน้างาน · footer ราคา snapshot (+ ค่าใช้จ่ายหน้างาน) + ปุ่มตามสถานะ
 * (ร่าง → "ปล่อยงานให้คนขับ" · ระหว่างส่ง → "ยืนยันส่งแล้ว" · ส่งแล้ว/ส่งไม่สำเร็จ → "ตีกลับบางส่วน")
 * ต่างจากต้นแบบ (spec/12 §3 แถว UAT 24 พ.ย. หน้า /do): ไม่มี "พิมพ์ใบส่งของ" (ไม่มี PDF ใบส่งของใน backlog เฟส 0 —
 * plan/01 ผู้สมัครเพิ่ม #24) · เมนู "…" = เปิดใบสั่งขนส่ง / เปิดเที่ยวรถ / ยกเลิกเอกสาร (แก้ไข/คัดลอกทำที่ SO — DO สร้างจาก SO
 * docs/01 §4.3) · "ยืนยันส่งแล้ว" เปิดไทม์ไลน์ของเที่ยวที่จุดส่งของใบนี้ (บันทึก event พร้อม occurredAt — docs/04 E1)
 */
export function DoDrawer({
  id,
  perms,
  onOpenTrip,
  onOpenOrder,
  onConfirm,
  onRelease,
  onToast,
  onClose,
}: {
  id: string;
  perms: DoPerms;
  onOpenTrip: (tripId: string) => void;
  onOpenOrder: (orderId: string) => void;
  /** "ยืนยันส่งแล้ว" → drawer เที่ยว แท็บไทม์ไลน์ + dialog ปิดงานที่จุดส่งของ DO */
  onConfirm: (d: Do) => void;
  /** "ปล่อยงานให้คนขับ" → ปล่อยเที่ยวของ DO */
  onRelease: (d: Do) => void;
  onToast: (m: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const q = useDo(id);
  const d: Do | undefined = q.data;
  const rev = useDoRevenue(id, perms.canSeePrice);
  const trip = useTrip(d?.tripId && perms.canSeeTrip ? d.tripId : null);
  const [tab, setTab] = useState<'sum' | 'tl' | 'pod' | 'exp'>('sum');
  const [returning, setReturning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pods = useDoPods([id], tab === 'pod' || returning);
  const pod = pods[0]?.data;
  const cancel = useCancelDo();
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  if (!d)
    return (
      <Drawer open onClose={onClose} kind={t('dos.kind')} title="…" labels={labels}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('dos.loadOneError')}
            description={problemText(q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => q.refetch()}>
                {t('cust.retry')}
              </Button>
            }
          />
        ) : null}
      </Drawer>
    );
  const tr = trip.data;
  const drop = tr?.stops.find(
    (s) => s.id === tr.deliveryOrders.find((x) => x.id === d.id)?.dropStopId,
  );
  const pick = tr?.stops.find(
    (s) => s.id === tr.deliveryOrders.find((x) => x.id === d.id)?.pickupStopId,
  );
  /** วันที่ + เวลาตามแผนของจุด (ต้นแบบ "2 พ.ย. 2569 07:00") — ไม่มีจุด = วันที่ DO */
  const when = (s: TripDetail['stops'][number] | undefined) => {
    const iso = s?.plannedArrival ?? s?.windowStart;
    if (!iso) return dateText(d.doDate);
    const b = toBangkok(iso);
    return `${dateText(b.date)} ${b.time}`;
  };
  const products = d.lines.map((l) => `${l.description} ${l.qtyPlanned} ${l.unit}`);
  const total = rev.data?.sellRevenueTotal;
  const mode = modeOf(d.status);
  const showConfirm = canConfirm(d, perms);
  const showRelease = canReleaseDo(d, perms);
  const showReturn = canReturnDo(d, perms);
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('dos.kind')}
      title={d.doNo}
      subtitle={d.customerName}
      badge={
        <Badge
          label={t(`do.st.${d.status}` as MessageKey)}
          tone={DO_TONE[d.status] ?? 'off'}
          icon={ICON[d.status] ?? 'circle'}
        />
      }
      menu={[
        { label: t('dos.foot.so'), icon: 'clipboard-list', onClick: () => onOpenOrder(d.orderId) },
        ...(d.tripId && perms.canSeeTrip
          ? [{ label: t('dos.foot.trip'), icon: 'route', onClick: () => onOpenTrip(d.tripId!) }]
          : []),
        ...(perms.canCancel && d.status !== 'CANCELLED'
          ? [
              {
                label: t('ord.menu.cancel'),
                icon: 'ban',
                danger: true,
                onClick: () => {
                  cancel.reset();
                  setCancelling(true);
                },
              },
            ]
          : []),
      ]}
      tabs={[
        { key: 'sum', label: t('drawer.tab.sum') },
        { key: 'tl', label: t('dos.tab.tl') },
        { key: 'pod', label: t('dos.tab.pod') },
        { key: 'exp', label: t('dos.tab.exp') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k === 'tl' || k === 'pod' || k === 'exp' ? k : 'sum')}
      labels={labels}
      footer={
        <>
          {perms.canSeePrice && (
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>
                {t(DO_DRAFTISH.has(d.status) ? 'dos.foot.price' : 'dos.foot.priceEx')}
              </span>
              <span className="tms-num" style={{ fontSize: 20, fontWeight: 600, color: '#101418' }}>
                {total !== undefined ? t('ord.baht', { n: money(total) }) : '—'}
              </span>
            </div>
          )}
          <span style={{ flex: 1 }} />
          <DrawerFooterButtons
            secondary={
              showReturn
                ? [
                    {
                      label: t(mode === 'failed' ? 'prt.btnFailed' : 'prt.btn'),
                      onClick: () => setReturning(true),
                    },
                  ]
                : []
            }
            {...(showConfirm
              ? {
                  primary: {
                    label: t('dos.act.confirm'),
                    icon: 'circle-check',
                    onClick: () => onConfirm(d),
                  },
                }
              : showRelease
                ? {
                    primary: {
                      label: t('dos.act.release'),
                      icon: 'send',
                      onClick: () => onRelease(d),
                    },
                  }
                : {})}
          />
        </>
      }
    >
      {tab === 'tl' ? (
        <DoTimeline d={d} trip={tr} drop={drop} />
      ) : tab === 'pod' ? (
        d.tripId ? (
          <DoPodBlock
            doId={d.id}
            doNo={d.doNo}
            siteName={d.destSiteName ?? ''}
            pod={pod}
            loading={!!pods[0]?.isLoading}
            error={
              pods[0]?.isError ? (problemText(pods[0].error, t) ?? t('pod.e.loadError')) : null
            }
            open
            onToggle={() => undefined}
            canEdit={perms.canRecord}
            canResolve={perms.canResolve}
            onToast={onToast}
          />
        ) : (
          <EmptyState icon="package" title={t('dos.noTrip')} description={t('dos.noTripDesc')} />
        )
      ) : tab === 'exp' ? (
        tr ? (
          <FieldChargesTab trip={tr} doId={d.id} onToast={onToast} />
        ) : (
          <EmptyState icon="receipt" title={t('dos.noTrip')} description={t('dos.noTripDesc')} />
        )
      ) : (
        <>
          <section style={sec}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3B424C' }}>
              {t('drawer.info')}
            </span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                gap: '14px 20px',
              }}
            >
              <Kv k={t('dos.kv.cust')} v={d.customerName ?? '—'} />
              <Kv k={t('dos.kv.from')} v={d.originSiteName ?? '—'} />
              <Kv k={t('dos.kv.to')} v={d.destSiteName ?? '—'} />
              <Kv k={t('dos.kv.date')} v={dateText(d.doDate)} />
              <Kv
                k={t('dos.kv.veh')}
                v={
                  d.vehiclePlate
                    ? [d.vehiclePlate, d.vehicleTypeName].filter(Boolean).join(' · ')
                    : '—'
                }
              />
              <Kv k={t('dos.kv.drv')} v={d.driverName ?? d.carrierName ?? '—'} />
              <Kv k={t('dos.kv.prod')} v={products.length ? products.join(', ') : '—'} />
              <Kv
                k={t('dos.kv.w')}
                v={kgText(d.weightKg) ? t('dos.kg', { n: kgText(d.weightKg)! }) : '—'}
              />
              <Kv k={t('dos.kv.trip')} v={d.tripNo ?? '—'} />
              {d.customerRef && <Kv k={t('dos.kv.ref')} v={d.customerRef} />}
            </div>
          </section>
          <section style={sec}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3B424C' }}>
              {t('dos.items')}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {[
                { a: t('dos.item.pick'), b: d.originSiteName ?? '—', c: when(pick) },
                { a: t('dos.item.drop'), b: d.destSiteName ?? '—', c: when(drop) },
              ].map((x) => (
                <div
                  key={x.a}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0,1fr) auto',
                    gap: 12,
                    alignItems: 'baseline',
                    padding: '8px 0',
                    borderBottom: '1px solid #EBEDE8',
                  }}
                >
                  <span
                    className="tms-num"
                    style={{ color: '#2257C4', fontWeight: 500, whiteSpace: 'nowrap' }}
                  >
                    {x.a}
                  </span>
                  <span style={{ minWidth: 0 }}>{x.b}</span>
                  <span
                    className="tms-num"
                    style={{ color: '#3B424C', whiteSpace: 'nowrap', textAlign: 'right' }}
                  >
                    {x.c}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      {returning && pod && mode && (
        <ReturnDialog
          d={d}
          pod={pod}
          mode={mode}
          onClose={() => setReturning(false)}
          onDone={(m) => {
            setReturning(false);
            onToast(m);
          }}
        />
      )}
      <ReasonDialog
        open={cancelling}
        title={t('ord.cancel.title', { no: d.doNo })}
        description={t('dos.cancel.desc')}
        label={t('ord.dlg.reason')}
        okLabel={t('ord.cancel.ok')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={cancel.isPending}
        error={cancel.error ? problemText(cancel.error, t) : null}
        hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
        onClose={() => setCancelling(false)}
        onOk={(reason) =>
          cancel.mutate(
            { id: d.id, version: d.version, reason },
            {
              onSuccess: () => {
                setCancelling(false);
                onToast(t('dos.cancel.done', { no: d.doNo }));
              },
            },
          )
        }
      />
    </Drawer>
  );
}

/**
 * แท็บ "ไทม์ไลน์" ของ DO (ต้นแบบ vPanel do steps: สร้าง DO จาก SO / มอบหมายรถและคนขับ / ออกรถ / ถึงปลายทาง / ยืนยันส่ง /
 * วางบิล) — สถานะจากสถานะ DO + เวลาจริงจากเที่ยว (assigned/dispatched) และจุดส่ง (ถึง/ออก — มาจาก event ของจุด ST4-T04)
 * ขั้นแรกที่ยังไม่ถึง = "รอดำเนินการ" ขั้นถัดไป = "ข้าม" (ตามต้นแบบ)
 */
function DoTimeline({
  d,
  trip,
  drop,
}: {
  d: Do;
  trip: TripDetail | undefined;
  drop: TripDetail['stops'][number] | undefined;
}) {
  const { t } = useI18n();
  const dt = useDateTimeText();
  const delivered = DELIVERED.has(d.status);
  const failed = d.status === 'FAILED' || d.status === 'RETURNED';
  const rejected = d.lines.some((l) => Number(l.rejectQty ?? 0) > 0);
  const steps: {
    key: string;
    title: MessageKey;
    done: boolean;
    fail?: boolean;
    at?: string | null;
    note?: string;
  }[] = [
    { key: 'c', title: 'dos.tl.created', done: true, at: d.createdAt },
    {
      key: 'a',
      title: 'dos.tl.assigned',
      done: !!trip?.assignedAt || !!trip?.dispatchedAt,
      at: trip?.assignedAt ?? trip?.dispatchedAt,
    },
    { key: 'd', title: 'dos.tl.dispatched', done: !!trip?.dispatchedAt, at: trip?.dispatchedAt },
    {
      key: 'r',
      title: 'dos.tl.arrived',
      done: !!drop?.arrivedAt || delivered || failed,
      at: drop?.arrivedAt,
    },
    {
      key: 'v',
      title: 'dos.tl.delivered',
      done: delivered,
      fail: failed,
      at: drop?.departedAt,
      ...(rejected && delivered ? { note: t('prt.badge') } : {}),
    },
    {
      key: 'b',
      title: 'dos.tl.billed',
      done: d.status === 'BILLED' || !!d.invoicedAt,
      at: d.invoicedAt,
    },
  ];
  let pendingShown = false;
  const items: TimelineItem[] = steps.map((s) => {
    let badge: TimelineItem['badge'];
    if (s.fail) badge = { label: t('trip.tl.st.FAILED'), tone: 'err', icon: 'circle-x' };
    else if (s.done) badge = { label: t('trip.tl.st.COMPLETED'), tone: 'ok', icon: 'circle-check' };
    else if (!pendingShown && d.status !== 'CANCELLED') {
      pendingShown = true;
      badge = { label: t('trip.tl.st.PENDING'), tone: 'info', icon: 'clock' };
    } else badge = { label: t('trip.tl.st.SKIPPED'), tone: 'off', icon: 'minus' };
    return {
      key: s.key,
      title: t(s.title),
      sub: [s.done && s.at ? dt(s.at) : '', s.note ?? ''].filter(Boolean).join(' · '),
      badge,
    };
  });
  return <ActivityTimeline items={items} />;
}
