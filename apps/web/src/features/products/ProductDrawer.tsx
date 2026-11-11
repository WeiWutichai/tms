import { Badge, Drawer } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { cbmText, kgText, num, specialText, specialsOf, tempText, unText } from './productFormat';
import type { Product } from './useProducts';

type Tab = 'info' | 'act';

/** ป้ายหัว drawer ตามต้นแบบ: ไม่มีประเภทพิเศษ = "ใช้งาน", มี = ป้ายเหลืองชื่อประเภท · ปิดใช้ = "ปิดใช้" */
export function ProductBadge({ p, t }: { p: Product; t: T }) {
  if (p.status !== 'active') return <Badge label={t('prd.st.inactive')} tone="off" icon="ban" />;
  return specialsOf(p).length ? (
    <Badge label={specialText(t, p)} tone="warn" />
  ) : (
    <Badge label={t('prd.st.active')} tone="ok" icon="check" />
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
 * Drawer สินค้า — ต้นแบบ vPanelApi prod (gen): หัว "สินค้าและหน่วย", ชื่อ, ป้าย · แท็บ ข้อมูล / กิจกรรม
 * ส่วน "ข้อมูล" ตามต้นแบบ (รหัส หน่วย น้ำหนัก ปริมาตร ประเภทพิเศษ ลูกค้า + อุณหภูมิ/เลข UN)
 * ส่วน "ข้อมูลเพิ่มเติม" (หน่วยแปลง วางซ้อนได้ บาร์โค้ด รหัสในระบบต้นทาง — spec/02 §3) ต้นแบบไม่มี [OPEN spec/12 §3]
 */
export function ProductDrawer({
  product: p,
  canWrite,
  onEdit,
  onToggleStatus,
  onDelete,
  onClose,
}: {
  product: Product;
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
      kind={t('prd.kind')}
      title={p.name}
      badge={<ProductBadge p={p} t={t} />}
      {...(p.customer ? { subtitle: p.customer.name } : {})}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite
        ? {
            menu: [
              { label: t('prd.menu.edit'), icon: 'pencil', onClick: onEdit },
              {
                label: t(p.status === 'active' ? 'prd.menu.off' : 'prd.menu.on'),
                icon: 'ban',
                onClick: onToggleStatus,
              },
              { label: t('prd.menu.delete'), icon: 'trash-2', danger: true, onClick: onDelete },
            ],
          }
        : {})}
      tabs={[
        { key: 'info', label: t('prd.tab.info') },
        { key: 'act', label: t('prd.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
    >
      {tab === 'info' && (
        <>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('prd.sec.info')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('prd.f.code')} v={p.code} />
              <Kv k={t('prd.col.u')} v={p.unit.name} />
              <Kv k={t('prd.col.w')} v={kgText(t, p)} />
              <Kv k={t('prd.col.vol')} v={cbmText(t, p)} />
              <Kv k={t('prd.col.sp')} v={specialText(t, p) || '—'} />
              <Kv k={t('prd.col.cust')} v={p.customer?.name ?? '—'} />
              {p.tempControlled && <Kv k={t('prd.f.temp')} v={tempText(t, p)} />}
              {p.hazardous && <Kv k={t('prd.f.un')} v={unText(t, p)} />}
            </div>
          </section>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('prd.sec.extra')}</span>
            <div className="tms-kv__grid">
              <Kv
                k={t('prd.f.alt')}
                v={
                  p.altUnits.length
                    ? p.altUnits
                        .map((a) =>
                          t('prd.f.altText', {
                            u: a.unit.name,
                            n: num(a.factorToBase, 6),
                            b: p.unit.name,
                          }),
                        )
                        .join(', ')
                    : '—'
                }
              />
              <Kv k={t('prd.f.stack')} v={t(p.stackable ? 'prd.yes' : 'prd.no')} />
              <Kv k={t('prd.f.barcode')} v={p.barcode ?? '—'} />
              <Kv k={t('prd.f.ext')} v={p.externalId ?? '—'} />
            </div>
          </section>
        </>
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/products/{id}/history"
          id={p.id}
          fieldLabel={(k) => fieldLabel(t, k)}
          fieldValue={(k, val) => fieldValue(t, k, val)}
        />
      )}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  name: 'prd.f.name',
  code: 'prd.f.code',
  unitId: 'prd.f.unit',
  customerId: 'prd.f.cust',
  weightPerUnitKg: 'prd.f.w',
  volumePerUnitCbm: 'prd.f.vol',
  altUnits: 'prd.f.alt',
  fragile: 'prd.sp.fragile',
  hazardous: 'prd.sp.hazardous',
  unNumber: 'prd.f.un',
  hazardClass: 'prd.f.cls',
  tempControlled: 'prd.sp.temp',
  tempMinC: 'prd.f.tmin',
  tempMaxC: 'prd.f.tmax',
  stackable: 'prd.f.stack',
  barcode: 'prd.f.barcode',
  externalId: 'prd.f.ext',
  status: 'unit.col.st',
};
function fieldLabel(t: T, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
function fieldValue(t: T, k: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (k === 'status') return t(v === 'active' ? 'prd.st.active' : 'prd.st.inactive');
  if (typeof v === 'boolean') return t(v ? 'prd.yes' : 'prd.no');
  if (k === 'altUnits' && Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return undefined;
}
