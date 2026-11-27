import type { components } from '@tms/contracts';
import { Drawer, Icon } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrap } from '../../api';
import { formatDate, formatMonth, useI18n } from '../../i18n';

type Usage = components['schemas']['ActiveVehicleUsageDto'];

export function useActiveVehicles(enabled = true) {
  return useQuery({
    queryKey: ['usage', 'active-vehicles'],
    queryFn: () => unwrap(api.GET('/v1/usage/active-vehicles')),
    enabled,
  });
}

/**
 * P1-ST1-T06 แถบ "รถ active เดือนนี้" บนหน้าทะเบียนรถ — ต้นแบบ TMS v4 `vx.showTier` (การ์ด gauge + แถบความคืบหน้า + แพ็กเกจ)
 * ตัวเลขจริงจาก `GET /v1/usage/active-vehicles` (แทน "รถในทะเบียน / โควตา" ของ D68-14/21)
 * คลิกข้อความ → drawer รายการทะเบียนที่ถูกนับ (แถวตามต้นแบบ billing `bl.vehs`: "ทะเบียน · ประเภท", "N เที่ยว", "วิ่ง วันที่")
 * + เที่ยวแรกที่ทำให้นับ — [DECISION — lead 28 พ.ย. 2569, ย้อนได้] spec/12 §3: ต้นแบบมีแถบนี้ในหน้ารถแต่ไม่มี drawer
 * (รายการอยู่ในหน้าแพ็กเกจ `billing` = P1-ST3-T03) → ประกอบ Drawer มาตรฐาน + แถวรายการของต้นแบบ billing
 */
export function ActiveVehiclesBar({
  plan,
  open,
  onOpen,
  onClose,
}: {
  plan: string | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const q = useActiveVehicles();
  const u = q.data;
  if (!u) return null;
  const limit = u.limit;
  const pct = limit ? Math.min(100, Math.round((u.activeVehicles / limit) * 100)) : 0;
  return (
    <>
      <div
        data-testid="veh-active-bar"
        style={{
          background: '#FFFFFF',
          border: '1px solid #CDD1C8',
          borderRadius: 12,
          boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <Icon n="gauge" s={18} style={{ color: '#2257C4' }} />
        <button
          type="button"
          onClick={onOpen}
          style={{
            border: 0,
            background: 'transparent',
            padding: 0,
            color: '#2257C4',
            fontWeight: 500,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            font: 'inherit',
          }}
        >
          {t('usage.bar.l')}{' '}
          <b style={{ fontVariantNumeric: 'tabular-nums' }}>
            {limit !== null ? `${u.activeVehicles}/${limit}` : u.activeVehicles}
          </b>{' '}
          {t(limit !== null ? 'usage.bar.unitTier' : 'usage.bar.unit')}
        </button>
        {limit !== null && (
          <div
            style={{
              flex: 1,
              minWidth: 160,
              maxWidth: 360,
              height: 8,
              borderRadius: 4,
              background: '#D9DCD4',
              overflow: 'hidden',
            }}
          >
            <div
              style={{ height: '100%', width: `${pct}%`, background: '#2257C4', borderRadius: 4 }}
            />
          </div>
        )}
        {plan && (
          <span style={{ fontSize: 13, color: '#3B424C' }}>
            {limit !== null ? t('usage.bar.r', { plan, limit }) : t('usage.bar.rNoLimit', { plan })}
          </span>
        )}
      </div>
      <ActiveVehiclesDrawer open={open} usage={u} onClose={onClose} />
    </>
  );
}

export function ActiveVehiclesDrawer({
  open,
  usage: u,
  onClose,
}: {
  open: boolean;
  usage: Usage;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  return (
    <Drawer
      open={open}
      onClose={onClose}
      kind={t('usage.dr.kind')}
      title={t('usage.dr.title', { m: formatMonth(u.period, lang) })}
      subtitle={
        u.status === 'open'
          ? t('usage.dr.subOpen', { n: u.activeVehicles, own: u.own, sub: u.subcontract })
          : t('usage.dr.subFinal', {
              n: u.activeVehicles,
              d: u.finalizedAt ? formatDate(new Date(u.finalizedAt), lang) : '—',
            })
      }
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
    >
      <section
        className="tms-kv"
        style={{ display: 'flex', flexDirection: 'column', gap: 10, borderBottom: 0 }}
      >
        <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('usage.note')}</span>
        {u.data.length === 0 ? (
          <span style={{ color: '#59606B' }} data-testid="usage-empty">
            {t('usage.dr.empty')}
          </span>
        ) : (
          <div
            data-testid="usage-list"
            style={{ border: '1px solid #E4E6E0', borderRadius: 10, background: '#F7F8F5' }}
          >
            {u.data.map((v, i) => (
              <div
                key={`${v.plate ?? ''}-${i}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) 80px 90px',
                  gap: 10,
                  padding: '8px 12px',
                  borderBottom: i < u.data.length - 1 ? '1px solid #E4E6E0' : 0,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                    {v.plate ?? t('usage.noPlate')}
                    {v.vehicleType ? ` · ${v.vehicleType}` : ''}
                  </span>
                  <span style={{ fontSize: 12.5, color: '#59606B' }}>
                    {[
                      v.subcontract ? t('usage.sub', { c: v.carrierName ?? '—' }) : t('usage.own'),
                      v.adjusted ? t('usage.adjusted') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {v.firstTripId && v.firstTripNo && (
                      <>
                        {' · '}
                        {t('usage.firstTrip')}{' '}
                        <Link to={`/plan?trip=${v.firstTripId}`} style={{ color: '#2257C4' }}>
                          {v.firstTripNo}
                        </Link>
                      </>
                    )}
                  </span>
                </div>
                <span style={{ textAlign: 'right', color: '#3B424C' }}>
                  {t('usage.trips', { n: v.trips })}
                </span>
                <span style={{ textAlign: 'right', fontSize: 12.5, color: '#59606B' }}>
                  {t('usage.ran', { d: formatDate(new Date(v.firstCountedAt), lang) })}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </Drawer>
  );
}
