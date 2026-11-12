import { Badge, Drawer } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { condText, priceText, unitText, vatText, whtText } from './serviceItemFormat';
import type { ServiceItem } from './useServiceItems';

type Tab = 'info' | 'act';

export function ServiceItemBadge({ r, t }: { r: ServiceItem; t: T }) {
  return r.status === 'active' ? (
    <Badge label={t('svc.st.active')} tone="ok" icon="check" />
  ) : (
    <Badge label={t('svc.st.inactive')} tone="off" icon="ban" />
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
 * Drawer ค่าบริการเสริม — ต้นแบบ vPanelApi acx (gen): หัว "ค่าบริการเสริม", ชื่อ, ป้าย "ใช้งาน" · แท็บ ข้อมูล / กิจกรรม
 * ส่วน "ข้อมูล" ตามต้นแบบ 6 ช่อง (หน่วยคิด ราคา เงื่อนไข VAT หัก ณ ที่จ่าย ใช้กับ) — "ใช้กับ" แสดงตามฝั่งของรายการ
 * ส่วน "ข้อมูลเพิ่มเติม" (รหัส หน่วยบนเอกสาร รายการของระบบ การใช้งาน รหัสในระบบต้นทาง) ต้นแบบไม่มี [OPEN spec/12 §3]
 * รหัสสงวน (FREIGHT/EXTRA_STOP/FSC — MD-158) ไม่มีเมนูปิดใช้/ลบ
 */
export function ServiceItemDrawer({
  item: r,
  canWrite,
  onEdit,
  onToggleStatus,
  onDelete,
  onClose,
}: {
  item: ServiceItem;
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
      kind={t('svc.kind')}
      title={r.name}
      badge={<ServiceItemBadge r={r} t={t} />}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite
        ? {
            menu: [
              { label: t('svc.menu.edit'), icon: 'pencil', onClick: onEdit },
              ...(r.reserved
                ? []
                : [
                    {
                      label: t(r.status === 'active' ? 'svc.menu.off' : 'svc.menu.on'),
                      icon: 'ban',
                      onClick: onToggleStatus,
                    },
                    {
                      label: t('svc.menu.delete'),
                      icon: 'trash-2',
                      danger: true,
                      onClick: onDelete,
                    },
                  ]),
            ],
          }
        : {})}
      tabs={[
        { key: 'info', label: t('svc.tab.info') },
        { key: 'act', label: t('svc.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
    >
      {tab === 'info' && (
        <>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('svc.sec.info')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('svc.col.u')} v={unitText(t, r.calcUnit)} />
              <Kv k={t('svc.f.p')} v={priceText(t, r, true)} />
              <Kv k={t('svc.f.cond')} v={condText(t, r) || '—'} />
              <Kv k={t('svc.col.vat')} v={vatText(t, r.vatType)} />
              <Kv k={t('svc.col.wht')} v={whtText(t, r.whtRate)} />
              <Kv k={t('svc.f.side')} v={t(`svc.applies.${r.side}` as MessageKey)} />
            </div>
          </section>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('svc.sec.extra')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('svc.f.code')} v={r.code} />
              <Kv k={t('svc.f.unitLabel')} v={r.unitLabel} />
              {r.system && (
                <Kv
                  k={t('svc.f.system')}
                  v={t(r.reserved ? 'svc.f.reservedYes' : 'svc.f.systemYes')}
                />
              )}
              <Kv
                k={t('svc.f.usage')}
                v={t('svc.usage', { r: r.usage.rateCards, d: r.usage.doSurcharges })}
              />
              <Kv k={t('svc.f.ext')} v={r.externalId ?? '—'} />
            </div>
          </section>
        </>
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/service-items/{id}/history"
          id={r.id}
          fieldLabel={(k) => fieldLabel(t, k)}
          fieldValue={(k, val) => fieldValue(t, k, val)}
        />
      )}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  name: 'svc.f.name',
  code: 'svc.f.code',
  calcUnit: 'svc.f.u',
  defaultPrice: 'svc.f.p',
  fuelRefPrice: 'svc.f.fuel',
  condition: 'svc.f.cond',
  vatType: 'svc.f.vat',
  whtRate: 'svc.f.wht',
  side: 'svc.f.side',
  externalId: 'svc.f.ext',
  status: 'svc.f.st',
};
function fieldLabel(t: T, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
function fieldValue(t: T, k: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (k === 'calcUnit') return t(`svc.u.${String(v)}` as MessageKey);
  if (k === 'vatType') return t(`svc.vat.${String(v)}` as MessageKey);
  if (k === 'whtRate') return t(`svc.wht.${String(v)}` as MessageKey);
  if (k === 'side') return t(`svc.side.${String(v)}` as MessageKey);
  if (k === 'status') return t(v === 'active' ? 'svc.st.active' : 'svc.st.inactive');
  return undefined;
}
