import { Icon } from '@tms/ui';
import './trips.css';
import { useState, type CSSProperties, type DragEvent } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { useDateText } from '../rate-cards/rateFormat';
import {
  useAttachDo,
  useNewTripFromDo,
  usePlanTrips,
  usePoolDos,
  useVehicleTypeCaps,
  type PoolDo,
  type TripRow,
} from './useTripList';

const card: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #CDD1C8',
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflow: 'hidden',
};
/** ชิป รับ/ส่ง (ต้นแบบ kc/kbg) */
const CHIP: Record<string, { c: string; bg: string }> = {
  PICKUP: { c: '#2257C4', bg: '#E9F0FA' },
  DELIVERY: { c: '#17733F', bg: '#E6F4EC' },
  RETURN: { c: '#17733F', bg: '#E6F4EC' },
};
const NEW = '__new';
const kg = (v: string | number | null | undefined) => Number(v ?? 0);
const num = (n: number) => n.toLocaleString('th-TH');

/**
 * กระดานของหน้าเที่ยวรถ (ต้นแบบ TMS v4 `is.trips` / vTrpB): ซ้าย "DO รอเข้าเที่ยว" (ลากได้) · ขวา การ์ดเที่ยวที่ยังเพิ่ม DO ได้ +
 * ช่อง "เที่ยวใหม่" — วาง DO บนการ์ด = `/attach` · บน "เที่ยวใหม่" = `POST /trips` (PLANNING ยังไม่มีรถ)
 * ต่างจากต้นแบบ [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้ spec/12 §3]: (1) "ระบบเลือกรถว่างให้" ไม่มีใน API → เที่ยวใหม่ยังไม่มีรถ
 * ข้อความเปลี่ยนเป็น "…แล้วจัดรถในรายละเอียดเที่ยว" (2) การ์ด DO ไม่มีประเภทรถ (DO ไม่มีข้อมูลนี้) (3) วันที่บนการ์ด = วันที่เที่ยวจริง
 * (ต้นแบบ "พรุ่งนี้" คงที่) (4) แถบน้ำหนักใช้น้ำหนักบรรทุกของประเภทรถ — ไม่ทราบ = ไม่แสดงแถบ (5) "ปล่อยเที่ยว" ผ่าน bulk-assign
 * ชุดเดียวกับกระดานวางแผน (ไม่สำเร็จ → dialog รายการเหตุผล)
 */
export function TripBoard({
  canAssign,
  canDispatch,
  canSeeTypes,
  today,
  releasing,
  onOpen,
  onRelease,
  onToast,
}: {
  canAssign: boolean;
  canDispatch: boolean;
  canSeeTypes: boolean;
  today: string;
  releasing: boolean;
  onOpen: (tripId: string) => void;
  onRelease: (trip: TripRow) => void;
  onToast: (m: string) => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const pool = usePoolDos(true);
  const plan = usePlanTrips();
  const caps = useVehicleTypeCaps(canSeeTypes);
  const attach = useAttachDo();
  const create = useNewTripFromDo();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dos = pool.data?.data ?? [];
  const trips = plan.data?.data ?? [];
  const busy = attach.isPending || create.isPending;
  const doOf = (id: string) => dos.find((d) => d.id === id);

  const drop = (e: DragEvent, target: string) => {
    e.preventDefault();
    const id = e.dataTransfer?.getData('text/plain') || drag;
    setDrag(null);
    setOver(null);
    if (!id || busy || !canAssign) return;
    const d = doOf(id);
    if (!d) return;
    const fail = (x: unknown) => onToast(problemText(x, t) ?? t('trips.loadError'));
    if (target === NEW) {
      create.mutate(
        { doId: id, tripDate: d.doDate < today ? today : d.doDate },
        {
          onSuccess: (x) => onToast(t('trips.toast.created', { trip: x.tripNo, do: d.doNo })),
          onError: fail,
        },
      );
      return;
    }
    const trip = trips.find((x) => x.id === target);
    if (!trip) return;
    attach.mutate(
      { trip, doId: id },
      {
        onSuccess: () => onToast(t('trips.toast.attached', { do: d.doNo, trip: trip.tripNo })),
        onError: fail,
      },
    );
  };
  const overOn = (k: string) => (e: DragEvent) => {
    if (!canAssign) return;
    e.preventDefault();
    if (over !== k) setOver(k);
  };

  return (
    <div
      data-testid="trip-board"
      style={{
        display: 'grid',
        gridTemplateColumns: '320px minmax(0,1fr)',
        gridTemplateRows: 'minmax(0,1fr)',
        gap: 20,
        alignItems: 'stretch',
        minHeight: 'max(520px, calc(100vh - 300px))',
        maxHeight: 'calc(100vh - 104px)',
      }}
    >
      <div style={card}>
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid #E4E6E0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#13213F' }}>
            {t('trips.pool.title')}
          </h2>
          <span
            data-testid="trip-pool-n"
            style={{
              height: 22,
              padding: '0 9px',
              borderRadius: 999,
              background: '#E9F0FA',
              color: '#2257C4',
              fontSize: 12,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {pool.data ? (pool.data.hasMore ? `${dos.length}+` : dos.length) : '—'}
          </span>
        </div>
        <div
          style={{
            overflowY: 'auto',
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {dos.map((d) => (
            <PoolCard
              key={d.id}
              d={d}
              draggable={canAssign && !busy}
              dragging={drag === d.id}
              onStart={(e) => {
                try {
                  e.dataTransfer.setData('text/plain', d.id);
                } catch {
                  /* บางเบราว์เซอร์ไม่ให้ตั้งค่า — ใช้ state แทน */
                }
                setDrag(d.id);
              }}
              onEnd={() => {
                setDrag(null);
                setOver(null);
              }}
            />
          ))}
          {pool.data && !dos.length && (
            <div
              style={{
                padding: '28px 12px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                textAlign: 'center',
              }}
            >
              <span style={{ color: '#C9CDC3' }}>
                <Icon n="package-check" s={40} />
              </span>
              <div style={{ fontWeight: 600 }}>{t('trips.pool.emptyTitle')}</div>
              <div style={{ color: '#3B424C' }}>{t('trips.pool.emptyDesc')}</div>
            </div>
          )}
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))',
          gap: 14,
          alignContent: 'start',
          overflowY: 'auto',
          minHeight: 0,
          padding: '2px 2px 8px',
        }}
      >
        {trips.map((x) => {
          const on = over === x.id;
          const w = kg(x.weightKg);
          const capV = x.vehicle ? caps.data?.get(x.vehicle.vehicleTypeId) : undefined;
          const cap = capV ? Number(capV) : null;
          const canRelease = canDispatch && x.deliveryOrders.length > 0;
          return (
            <div
              key={x.id}
              data-testid="trip-card"
              role="button"
              tabIndex={0}
              onDragOver={overOn(x.id)}
              onDragLeave={() => setOver((o) => (o === x.id ? null : o))}
              onDrop={(e) => drop(e, x.id)}
              onClick={() => onOpen(x.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(x.id);
              }}
              style={{
                background: on ? '#E9F0FA' : '#FFFFFF',
                border: `1px solid ${on ? '#2257C4' : '#D9DCD4'}`,
                borderRadius: 14,
                boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
                padding: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                cursor: 'pointer',
                minHeight: 220,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span
                  className="tms-num"
                  style={{ fontSize: 13, fontWeight: 600, color: '#2257C4' }}
                >
                  {x.tripNo}
                </span>
                <span style={{ fontSize: 12.5, color: '#3B424C' }}>{dateText(x.tripDate)}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 500 }}>
                  {x.vehicle
                    ? [x.vehicle.plate, x.vehicle.vehicleTypeName].filter(Boolean).join(' · ')
                    : '—'}
                </span>
                <span style={{ fontSize: 13, color: '#3B424C' }}>
                  {[x.driver?.name ?? '—', x.carrier?.name, x.trailer?.plate ?? '—']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                  <span style={{ color: '#3B424C' }}>{t('trips.card.load')}</span>
                  <span className="tms-num">
                    {cap
                      ? t('trips.card.loadOf', { w: num(w), cap: num(cap) })
                      : t('dos.kg', { n: num(w) })}
                  </span>
                </div>
                {cap ? (
                  <div
                    style={{
                      height: 5,
                      borderRadius: 3,
                      background: '#EBEDE8',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min(100, (w / cap) * 100).toFixed(0)}%`,
                        background: w > cap ? '#B3322A' : '#2257C4',
                      }}
                    />
                  </div>
                ) : null}
              </div>
              {x.stops.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {x.stops.map((s, i) => {
                    const c = CHIP[s.type] ?? CHIP.DELIVERY!;
                    return (
                      <div
                        key={s.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
                      >
                        <span
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            background: '#FFFFFF',
                            border: '1px solid #D9DCD4',
                            fontSize: 12,
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          {i + 1}
                        </span>
                        <span
                          style={{
                            height: 20,
                            padding: '0 8px',
                            borderRadius: 999,
                            background: c.bg,
                            color: c.c,
                            fontSize: 12,
                            fontWeight: 600,
                            display: 'inline-flex',
                            alignItems: 'center',
                            flexShrink: 0,
                          }}
                        >
                          {t(`trips.stop.${s.type}` as MessageKey)}
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {s.siteName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div
                  style={{
                    flex: 1,
                    border: '1.5px dashed #C9CDC3',
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 16,
                    textAlign: 'center',
                    color: '#3B424C',
                  }}
                >
                  {t('trips.card.drop')}
                </div>
              )}
              {canDispatch && (
                <button
                  type="button"
                  disabled={!canRelease || releasing}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canRelease) onRelease(x);
                  }}
                  style={{
                    marginTop: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 32,
                    padding: '0 14px',
                    border: '1px solid #9DB6E3',
                    borderRadius: 999,
                    background: '#FFFFFF',
                    color: '#2257C4',
                    fontWeight: 500,
                    cursor: canRelease ? 'pointer' : 'not-allowed',
                    whiteSpace: 'nowrap',
                    justifyContent: 'center',
                    opacity: canRelease ? 1 : 0.5,
                  }}
                >
                  <Icon n="send" s={16} />
                  {t('trip.foot.release')}
                </button>
              )}
            </div>
          );
        })}
        {canAssign && (
          <div
            data-testid="trip-new"
            onDragOver={overOn(NEW)}
            onDragLeave={() => setOver((o) => (o === NEW ? null : o))}
            onDrop={(e) => drop(e, NEW)}
            style={{
              border: `1.5px dashed ${over === NEW ? '#2257C4' : '#C9CDC3'}`,
              background: over === NEW ? '#E9F0FA' : 'transparent',
              borderRadius: 14,
              minHeight: 220,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              textAlign: 'center',
              padding: 16,
            }}
          >
            <span style={{ color: '#C9CDC3' }}>
              <Icon n="circle-plus" s={40} />
            </span>
            <div style={{ fontWeight: 600 }}>{t('trips.new.title')}</div>
            <div style={{ color: '#3B424C' }}>{t('trips.new.desc')}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function PoolCard({
  d,
  draggable,
  dragging,
  onStart,
  onEnd,
}: {
  d: PoolDo;
  draggable: boolean;
  dragging: boolean;
  onStart: (e: DragEvent) => void;
  onEnd: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-testid="trip-pool-do"
      draggable={draggable}
      onDragStart={onStart}
      onDragEnd={onEnd}
      className="tms-pool-card"
      style={{
        opacity: dragging ? 0.5 : 1,
        background: '#FFFFFF',
        border: '1px solid #D9DCD4',
        borderRadius: 12,
        padding: '10px 12px',
        cursor: draggable ? 'grab' : 'default',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span className="tms-num" style={{ fontSize: 13, fontWeight: 500, color: '#2257C4' }}>
          {d.doNo}
        </span>
        <span style={{ color: '#59606B' }}>
          <Icon n="grip-vertical" s={16} />
        </span>
      </div>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {d.customerName ?? '—'}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 26,
            padding: '0 10px',
            borderRadius: 999,
            background: '#EBEDE8',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
            overflow: 'hidden',
          }}
        >
          <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
            {d.originSiteName ?? '—'}
          </span>
          <span style={{ color: '#59606B', display: 'inline-flex' }}>
            <Icon n="arrow-right" s={14} />
          </span>
          <span className="tms-ellipsis" style={{ maxWidth: 110 }}>
            {d.destSiteName ?? '—'}
          </span>
        </span>
        <span style={{ fontSize: 13, color: '#3B424C' }}>
          {t('dos.kg', { n: num(kg(d.weightKg)) })}
        </span>
      </div>
    </div>
  );
}
