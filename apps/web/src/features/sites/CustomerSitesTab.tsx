import { Icon, Toast } from '@tms/ui';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { MapBox, SiteFormDrawer } from './SiteFormDrawer';
import { formatLatLng } from './siteFormat';
import { useCustomerSites } from './useSites';

/**
 * แท็บ "ที่อยู่ส่ง" ใน drawer ลูกค้า (ต้นแบบ TMS v4 P.isAddr / P.cux) — ST2-T02
 * แผนที่ (กรอบว่าง — ยังไม่เลือกผู้ให้บริการ) + รายการสถานที่ของลูกค้า (เลขลำดับ, ชื่อ, ที่อยู่, พิกัด) + ปุ่ม "เพิ่มที่อยู่ส่ง"
 */
export function CustomerSitesTab({
  customerId,
  customerName,
  canWrite,
}: {
  customerId: string;
  customerName: string;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const q = useCustomerSites(customerId, true);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const pin = rows.find((r) => r.lat !== null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <MapBox
        lat={rows.length === 1 && pin ? pin.lat : null}
        lng={rows.length === 1 && pin ? pin.lng : null}
        offLabel={t('loc.f.mapOff')}
        border="#D9DCD4"
        background="#EBEDE8"
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid #D9DCD4',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {rows.map((s, i) => (
          <div
            key={s.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '28px minmax(0,1fr)',
              gap: 10,
              padding: '10px 12px',
              borderBottom: '1px solid #E4E6E0',
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: '#2257C4',
                color: '#FFFFFF',
                fontSize: 12,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {i + 1}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{s.name}</span>
              <span style={{ color: '#3B424C', overflowWrap: 'anywhere' }}>{s.address.line1}</span>
              <span
                className="tms-num"
                style={{ fontSize: 12, color: s.lat === null ? '#8F5500' : '#3B424C' }}
              >
                {s.lat === null ? t('loc.noPin') : formatLatLng(s.lat, s.lng, 4)}
              </span>
            </div>
          </div>
        ))}
        {!q.isLoading && !rows.length && (
          <div style={{ padding: 16, color: '#3B424C' }}>{t('cust.addr.none')}</div>
        )}
      </div>
      {q.hasNextPage && (
        <button
          type="button"
          className="tms-textlink"
          style={{ alignSelf: 'flex-start' }}
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          {t('hist.more')}
        </button>
      )}
      {canWrite && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 12px',
            border: '1px solid #9DB6E3',
            borderRadius: 999,
            background: '#FFFFFF',
            color: '#2257C4',
            fontWeight: 500,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            alignSelf: 'flex-start',
          }}
        >
          <Icon n="map-pin-plus" s={16} />
          {t('cust.addr.add')}
        </button>
      )}
      <SiteFormDrawer
        open={adding}
        presetCustomer={{ id: customerId, label: customerName }}
        onClose={() => setAdding(false)}
        onSaved={(s) => {
          setAdding(false);
          setToast(t('loc.toast.created', { n: s.name }));
        }}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </div>
  );
}
