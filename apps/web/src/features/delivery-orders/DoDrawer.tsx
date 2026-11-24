import { Badge, Button, Drawer, DrawerFooterButtons, EmptyState, type Tone } from '@tms/ui';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { useDateText } from '../rate-cards/rateFormat';
import { useDo, useDoRevenue, type Do } from './useDos';

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

/**
 * Drawer ใบส่งของ (ต้นแบบ TMS v4 vPanel kind 'do' — "ใบส่งของ" + ป้ายสถานะ + ส่วน "ข้อมูล" + "จุดรับ–ส่ง" + footer "ราคา snapshot")
 * ต่างจากต้นแบบ [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้ spec/12 §3]: แท็บ ไทม์ไลน์/หลักฐานส่ง/ค่าใช้จ่ายหน้างาน และปุ่ม
 * "ยืนยันส่งแล้ว"/"ตีกลับบางส่วน"/"ปล่อยงานให้คนขับ" ทำในเที่ยวรถ (การส่ง/หลักฐาน/ค่าใช้จ่ายผูกกับจุดแวะของเที่ยว — ST4-T04/T07/T11/T13)
 * → footer "เปิดเที่ยวรถ" เปิด drawer เที่ยวที่มีส่วนเหล่านั้น · "พิมพ์ใบส่งของ" ไม่มี (ยังไม่มี PDF ใบส่งของ — spec/12 §3 ST4-T07)
 * · kv "จำนวน … เที่ยว"/"ที่มาของราคา" ไม่มีข้อมูลใน DO — ไม่แสดง · ราคา snapshot = รายได้ของใบ (ก่อน VAT) เห็นเมื่อมี `prices.sell:read`
 */
export function DoDrawer({
  id,
  canSeePrice,
  canSeeTrip,
  onOpenTrip,
  onOpenOrder,
  onClose,
}: {
  id: string;
  canSeePrice: boolean;
  canSeeTrip: boolean;
  onOpenTrip: (tripId: string) => void;
  onOpenOrder: (orderId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const q = useDo(id);
  const rev = useDoRevenue(id, canSeePrice);
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const d: Do | undefined = q.data;
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
  const products = d.lines.map((l) => `${l.description} ${l.qtyPlanned} ${l.unit}`);
  const total = rev.data?.sellRevenueTotal;
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('dos.kind')}
      title={d.doNo}
      subtitle={[d.customerName, d.customerRef].filter(Boolean).join(' · ')}
      badge={
        <Badge
          label={t(`do.st.${d.status}` as MessageKey)}
          tone={DO_TONE[d.status] ?? 'off'}
          icon={ICON[d.status] ?? 'circle'}
        />
      }
      tabs={[{ key: 'sum', label: t('drawer.tab.sum') }]}
      tab="sum"
      onTab={() => undefined}
      labels={labels}
      footer={
        <>
          {canSeePrice && (
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>
                {t('dos.foot.price')}
              </span>
              <span className="tms-num" style={{ fontSize: 20, fontWeight: 600, color: '#101418' }}>
                {total !== undefined ? t('ord.baht', { n: money(total) }) : '—'}
              </span>
            </div>
          )}
          <span style={{ flex: 1 }} />
          <DrawerFooterButtons
            secondary={[
              { label: t('dos.foot.so'), onClick: () => onOpenOrder(d.orderId) },
              ...(d.tripId && canSeeTrip
                ? [{ label: t('dos.foot.trip'), onClick: () => onOpenTrip(d.tripId!) }]
                : []),
            ]}
          />
        </>
      }
    >
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
              d.vehiclePlate ? [d.vehiclePlate, d.vehicleTypeName].filter(Boolean).join(' · ') : '—'
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
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3B424C' }}>{t('dos.items')}</span>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {[
            { a: t('dos.item.pick'), b: d.originSiteName ?? '—' },
            { a: t('dos.item.drop'), b: d.destSiteName ?? '—' },
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
                {dateText(d.doDate)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Drawer>
  );
}
