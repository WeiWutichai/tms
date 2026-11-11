import { Badge, Drawer } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { formatContact, formatLatLng } from './siteFormat';
import type { Site } from './useSites';

type Tab = 'info' | 'act';

/** ป้ายสถานะตามต้นแบบ: ปักหมุดแล้ว = "ใช้งาน", ยังไม่ปัก = "ยังไม่ปักหมุด" (เตือน) · ปิดใช้ = "ปิดใช้" */
export function SiteBadge({ s, t }: { s: Site; t: (k: MessageKey) => string }) {
  if (s.status === 'inactive') return <Badge label={t('loc.st.inactive')} tone="off" icon="ban" />;
  if (s.lat === null) return <Badge label={t('loc.noPin')} tone="warn" icon="circle-alert" />;
  return <Badge label={t('loc.st.active')} tone="ok" icon="check" />;
}

export function hoursText(s: Site, allDay: string): string {
  return s.openTime && s.closeTime ? `${s.openTime}–${s.closeTime}` : allDay;
}

function Kv({ k, v, span }: { k: string; v: ReactNode; span?: 2 }) {
  return (
    <div className="tms-kv__item" style={span ? { gridColumn: 'span 2' } : undefined}>
      <span className="tms-kv__k">{k}</span>
      <span className="tms-kv__v" style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
        {v}
      </span>
    </div>
  );
}

/**
 * Drawer สถานที่ — ต้นแบบ vPanelApi loc (gen): หัว "สถานที่ · {ประเภท}", ชื่อ, ป้าย, ลูกค้า
 * แท็บ ข้อมูล / กิจกรรม · เมนู ⋯ = แก้ไข, ปิดใช้/เปิดใช้, ลบ (spec/02 §0.2 [OPEN spec/12 §3])
 */
export function SiteDrawer({
  site: s,
  ownerName,
  canWrite,
  onEdit,
  onToggleStatus,
  onDelete,
  onClose,
}: {
  site: Site;
  /** ชื่อบริษัทของผู้ใช้ — แสดงแทนลูกค้าเมื่อเป็นจุดของบริษัทเอง (ตามต้นแบบ) */
  ownerName: string;
  canWrite: boolean;
  onEdit: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('info');
  const cust = s.customer?.name ?? ownerName;
  const vc = s.maxVehicleClass ? t(`loc.vc.${s.maxVehicleClass}` as MessageKey) : t('loc.vc.none');
  return (
    <Drawer
      open
      onClose={onClose}
      kind={`${t('loc.kind')} · ${t(`loc.k.${s.kind}` as MessageKey)}`}
      title={s.name}
      badge={<SiteBadge s={s} t={t} />}
      subtitle={cust}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite
        ? {
            menu: [
              { label: t('loc.menu.edit'), icon: 'pencil', onClick: onEdit },
              {
                label: t(s.status === 'active' ? 'loc.menu.off' : 'loc.menu.on'),
                icon: 'ban',
                onClick: onToggleStatus,
              },
              { label: t('loc.menu.delete'), icon: 'trash-2', danger: true, onClick: onDelete },
            ],
          }
        : {})}
      tabs={[
        { key: 'info', label: t('loc.tab.info') },
        { key: 'act', label: t('loc.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
    >
      {tab === 'info' && (
        <>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('loc.sec.info')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('loc.f.code')} v={s.code} />
              <Kv k={t('loc.f.addr')} v={s.address.line1} />
              <Kv k={t('loc.f.cust')} v={cust} />
              <Kv k={t('loc.f.ll')} v={formatLatLng(s.lat, s.lng) || t('loc.noPin')} />
              <Kv
                k={t('loc.col.r')}
                v={t('loc.meters', { n: s.geofenceRadiusM.toLocaleString('th-TH') })}
              />
              <Kv k={t('loc.f.hrs')} v={hoursText(s, t('loc.allDay'))} />
              <Kv k={t('loc.f.ct')} v={formatContact(s.contact) || '—'} />
              <Kv k={t('loc.f.mx')} v={vc} />
            </div>
          </section>
          {/* ข้อมูลเพิ่มเติม — ไม่มีในต้นแบบ (ตาม backlog ST2-T02) [OPEN spec/12 §3] */}
          <section className="tms-kv">
            <span className="tms-kv__title">{t('loc.sec.extra')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('loc.f.alias')} v={s.aliases.length ? s.aliases.join('\n') : '—'} />
              <Kv
                k={t('loc.f.svc')}
                v={s.serviceTimeMin === null ? '—' : String(s.serviceTimeMin)}
              />
              <Kv k={t('loc.f.ext')} v={s.externalId ?? '—'} />
              <Kv k={t('loc.f.notes')} v={s.notes ?? '—'} />
            </div>
          </section>
        </>
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/customer-sites/{id}/history"
          id={s.id}
          fieldLabel={(k) => fieldLabel(t, k)}
        />
      )}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  name: 'loc.f.name',
  kind: 'loc.f.kind',
  customerId: 'loc.f.cust',
  address: 'loc.f.addr',
  lat: 'loc.f.ll',
  lng: 'loc.f.ll',
  geocodeStatus: 'loc.f.ll',
  geofenceRadiusM: 'loc.f.r',
  maxVehicleClass: 'loc.f.mx',
  openTime: 'loc.f.open',
  closeTime: 'loc.f.close',
  contact: 'loc.f.ct',
  aliases: 'loc.f.alias',
  serviceTimeMin: 'loc.f.svc',
  notes: 'loc.f.notes',
  externalId: 'loc.f.ext',
  status: 'cust.col.status',
};
function fieldLabel(t: (k: MessageKey) => string, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
