import { Badge, Drawer } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { signedNum } from '../master/format';
import { HistoryTab } from '../master/HistoryTab';
import type { VehicleType } from './useVehicleTypes';

type Tab = 'info' | 'act';

const num = (n: number) => n.toLocaleString('th-TH');

export const licLabel = (t: T, v: VehicleType['minLicenceClass']) =>
  v ? t(`vt.lic.${v}` as MessageKey) : '—';
export const kgText = (t: T, v: VehicleType) =>
  v.payloadKg === null ? '—' : t('vt.kg', { n: num(v.payloadKg) });
export const cbmText = (t: T, v: VehicleType) =>
  v.volumeCbm === null ? '—' : t('vt.cbm', { n: num(v.volumeCbm) });
export const tagsText = (t: T, v: VehicleType) =>
  v.capabilityTags.map((x) => t(`vt.tag.${x}` as MessageKey)).join(', ');

export function VtBadge({ v, t }: { v: VehicleType; t: T }) {
  return v.status === 'active' ? (
    <Badge label={t('vt.st.active')} tone="ok" icon="check" />
  ) : (
    <Badge label={t('vt.st.inactive')} tone="off" icon="ban" />
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

/**
 * Drawer ประเภทรถ — ต้นแบบ vPanelApi vt (gen): หัว "ประเภทรถ", ชื่อ, ป้าย · แท็บ ข้อมูล / กิจกรรม
 * ส่วน "ข้อมูล" ตามต้นแบบ 6 ช่อง · "ข้อมูลเพิ่มเติม" (รหัส ชั้นรถ ความสามารถพิเศษ อุณหภูมิ) ต้นแบบไม่มี [OPEN spec/12 §3]
 * กฎจ่ายงาน: ต้นแบบเขียน "ห้ามจ่าย" แต่ docs/04 C ให้เตือน + override พร้อมเหตุผล → ใช้ข้อความตาม docs [OPEN spec/12 §3]
 */
export function VehicleTypeDrawer({
  vt: v,
  canWrite,
  onEdit,
  onToggleStatus,
  onDelete,
  onClose,
}: {
  vt: VehicleType;
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
      kind={t('vt.kind')}
      title={v.name}
      badge={<VtBadge v={v} t={t} />}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite
        ? {
            menu: [
              { label: t('vt.menu.edit'), icon: 'pencil', onClick: onEdit },
              {
                label: t(v.status === 'active' ? 'vt.menu.off' : 'vt.menu.on'),
                icon: 'ban',
                onClick: onToggleStatus,
              },
              { label: t('vt.menu.delete'), icon: 'trash-2', danger: true, onClick: onDelete },
            ],
          }
        : {})}
      tabs={[
        { key: 'info', label: t('vt.tab.info') },
        { key: 'act', label: t('vt.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
    >
      {tab === 'info' && (
        <>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('vt.sec.info')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('vt.col.cap')} v={kgText(t, v)} />
              <Kv k={t('vt.col.vol')} v={cbmText(t, v)} />
              <Kv k={t('vt.col.lic')} v={licLabel(t, v.minLicenceClass)} />
              <Kv k={t('vt.col.veh')} v={t('vt.units', { n: num(v.usage.vehicles) })} />
              <Kv k={t('vt.f.rates')} v={t('vt.items', { n: num(v.usage.rateCards) })} />
              <Kv
                k={t('vt.f.rule')}
                v={t('vt.rule', {
                  kg: v.payloadKg === null ? '—' : num(v.payloadKg),
                  lic: licLabel(t, v.minLicenceClass),
                })}
              />
            </div>
          </section>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('vt.sec.extra')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('vt.f.code')} v={v.code} />
              <Kv k={t('vt.f.class')} v={t(`vt.vc.${v.vehicleClass}` as MessageKey)} />
              <Kv k={t('vt.f.tags')} v={tagsText(t, v) || '—'} />
              {v.tempMinC !== null && v.tempMaxC !== null && (
                <Kv
                  k={t('vt.f.temp')}
                  v={t('vt.temp', { a: signedNum(v.tempMinC), b: signedNum(v.tempMaxC) })}
                />
              )}
              <Kv k={t('vt.f.ext')} v={v.externalId ?? '—'} />
            </div>
          </section>
        </>
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/vehicle-types/{id}/history"
          id={v.id}
          fieldLabel={(k) => fieldLabel(t, k)}
          fieldValue={(k, val) => fieldValue(t, k, val)}
        />
      )}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  name: 'vt.f.name',
  code: 'vt.f.code',
  vehicleClass: 'vt.f.class',
  payloadKg: 'vt.f.cap',
  volumeCbm: 'vt.f.vol',
  minLicenceClass: 'vt.f.lic',
  capabilityTags: 'vt.f.tags',
  tempMinC: 'vt.f.tmin',
  tempMaxC: 'vt.f.tmax',
  externalId: 'vt.f.ext',
  status: 'vt.col.st',
};
function fieldLabel(t: T, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
function fieldValue(t: T, k: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (k === 'vehicleClass') return t(`vt.vc.${String(v)}` as MessageKey);
  if (k === 'minLicenceClass') return t(`vt.lic.${String(v)}` as MessageKey);
  if (k === 'status') return t(v === 'active' ? 'vt.st.active' : 'vt.st.inactive');
  if (k === 'capabilityTags' && Array.isArray(v))
    return v.length ? v.map((x) => t(`vt.tag.${String(x)}` as MessageKey)).join(', ') : '—';
  return undefined;
}
