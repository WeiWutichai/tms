import { Badge, Drawer } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { kmText, routeName, timeText, tollText } from './routeFormat';
import type { Route } from './useRoutes';

type Tab = 'info' | 'act';

export function RouteBadge({ r, t }: { r: Route; t: T }) {
  return r.status === 'active' ? (
    <Badge label={t('rt.st.active')} tone="ok" icon="check" />
  ) : (
    <Badge label={t('rt.st.inactive')} tone="off" icon="ban" />
  );
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="tms-kv__item">
      <span className="tms-kv__k">{k}</span>
      <span className="tms-kv__v" style={{ overflowWrap: 'anywhere' }}>
        {v}
      </span>
    </div>
  );
}

/** ชื่อสถานที่ + รหัส · ปิดใช้แล้วมีป้าย "ปิดใช้" ต่อท้าย */
function SiteText({ s, t }: { s: Route['origin']; t: T }) {
  return (
    <>
      {s.name} <span style={{ color: '#59606B' }}>· {s.code}</span>
      {s.status === 'inactive' && (
        <span style={{ color: '#8F5500' }}> · {t('rt.st.inactive')}</span>
      )}
    </>
  );
}

/**
 * Drawer เส้นทาง — ต้นแบบไม่มีหน้าเส้นทาง [OPEN spec/12 §3] → แบบเดียวกับ drawer ประเภทรถ/สถานที่
 * (หัว ชนิด + ชื่อ + ป้าย · เมนู ⋯ แก้ไข/ปิดใช้/ลบ · แท็บ ข้อมูล / กิจกรรม)
 */
export function RouteDrawer({
  route: r,
  canWrite,
  onEdit,
  onToggleStatus,
  onDelete,
  onClose,
}: {
  route: Route;
  canWrite: boolean;
  onEdit: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('info');
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('rt.kind')}
      title={routeName(r)}
      badge={<RouteBadge r={r} t={t} />}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite
        ? {
            menu: [
              { label: t('rt.menu.edit'), icon: 'pencil', onClick: onEdit },
              {
                label: t(r.status === 'active' ? 'rt.menu.off' : 'rt.menu.on'),
                icon: 'ban',
                onClick: onToggleStatus,
              },
              { label: t('rt.menu.delete'), icon: 'trash-2', danger: true, onClick: onDelete },
            ],
          }
        : {})}
      tabs={[
        { key: 'info', label: t('rt.tab.info') },
        { key: 'act', label: t('rt.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
    >
      {tab === 'info' && (
        <>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('rt.sec.info')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('rt.f.origin')} v={<SiteText s={r.origin} t={t} />} />
              <Kv k={t('rt.f.dest')} v={<SiteText s={r.destination} t={t} />} />
              <Kv k={t('rt.col.km')} v={kmText(t, r)} />
              <Kv k={t('rt.col.time')} v={timeText(t, r.standardMinutes)} />
              <Kv k={t('rt.f.toll')} v={tollText(r)} />
            </div>
          </section>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('rt.sec.extra')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('rt.f.code')} v={r.code} />
              <Kv k={t('rt.f.ext')} v={r.externalId ?? '—'} />
              <Kv k={t('rt.f.notes')} v={r.notes ?? '—'} />
            </div>
          </section>
        </>
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/routes/{id}/history"
          id={r.id}
          fieldLabel={(k) => fieldLabel(t, k)}
          fieldValue={(k, val) => fieldValue(t, k, val)}
        />
      )}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  code: 'rt.f.code',
  originId: 'rt.f.origin',
  destinationId: 'rt.f.dest',
  distanceKm: 'rt.f.km',
  standardMinutes: 'rt.f.min',
  tollAmount: 'rt.f.toll',
  notes: 'rt.f.notes',
  externalId: 'rt.f.ext',
  status: 'rt.col.st',
};
function fieldLabel(t: T, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
function fieldValue(t: T, k: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (k === 'status') return t(v === 'active' ? 'rt.st.active' : 'rt.st.inactive');
  return undefined;
}
