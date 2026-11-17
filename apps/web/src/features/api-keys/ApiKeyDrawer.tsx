import type { Schemas } from '@tms/contracts';
import { Badge, Drawer, DrawerFooterButtons } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { useKeyFormat } from './format';
import type { ApiKey } from './useApiKeys';

type Tab = 'info' | 'act';

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
 * Drawer ของ API key — ต้นแบบ TMS v4 vPanelApi apikey: หัว "API key · Production", ชื่อ, ป้ายสถานะ,
 * บรรทัดรอง "prefix… · สร้างโดย …" · แท็บ รายละเอียด / กิจกรรม · ส่วนข้อมูล + ชิป Scope
 * ปุ่มล่าง: แก้ scope · เพิกถอน · หมุนเวียน key (key ที่เพิกถอนแล้วไม่มีปุ่ม)
 * ช่อง Rate limit / เรียกเดือนนี้ / ชุดจับคู่ที่ผูก ของต้นแบบยังไม่มีข้อมูลในเฟสนี้ (ST7-T08, log การเรียก, field mapping)
 * → ไม่แสดง · key ที่กำลังหมุนแสดง "ใช้ได้ถึง" และไม่มีปุ่มหมุนซ้ำ [DECISION spec/12 §3]
 */
export function ApiKeyDrawer({
  k,
  canWrite,
  onScope,
  onRotate,
  onRevoke,
  onClose,
}: {
  k: ApiKey;
  canWrite: boolean;
  onScope: () => void;
  onRotate: () => void;
  onRevoke: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fm = useKeyFormat();
  const [tab, setTab] = useState<Tab>('info');
  const live = k.status !== 'revoked';
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('akey.kind', { mode: fm.mode(k) })}
      title={k.name}
      badge={<Badge label={fm.status(k)} />}
      subtitle={t('akey.sub', { prefix: k.prefix, by: fm.by(k) })}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      tabs={[
        { key: 'info', label: t('akey.tab.info') },
        { key: 'act', label: t('akey.tab.act') },
      ]}
      tab={tab}
      onTab={(x) => setTab(x as Tab)}
      {...(canWrite && live
        ? {
            footer: (
              <DrawerFooterButtons
                secondary={[
                  { label: t('akey.menu.scope'), onClick: onScope },
                  { label: t('akey.menu.revoke'), onClick: onRevoke },
                ]}
                {...(k.status !== 'rotating'
                  ? {
                      primary: {
                        label: t('akey.menu.rotate'),
                        icon: 'refresh-cw',
                        onClick: onRotate,
                      },
                    }
                  : {})}
              />
            ),
          }
        : {})}
    >
      {tab === 'info' && (
        <>
          <section className="tms-kv">
            <span className="tms-kv__title">{t('akey.sec.info')}</span>
            <div className="tms-kv__grid">
              <Kv k={t('akey.col.prefix')} v={`${k.prefix}…`} />
              <Kv k={t('akey.col.mode')} v={fm.mode(k)} />
              <Kv k={t('akey.col.ip')} v={fm.ip(k)} />
              <Kv k={t('akey.col.created')} v={fm.date(k.createdAt)} />
              <Kv k={t('akey.col.last')} v={fm.last(k)} />
              <Kv k={t('akey.col.exp')} v={fm.exp(k)} />
              {k.status === 'rotating' && k.revokeAt && (
                <Kv k={t('akey.f.until')} v={fm.dateTime(k.revokeAt)} />
              )}
            </div>
          </section>
          <section className="akey-chips">
            <span className="akey-chips__h">{t('akey.f.scopes', { n: k.scopes.length })}</span>
            <div className="akey-chips__list">
              {k.scopes.map((s) => (
                <span key={s} title={t(`akey.sc.${s}` as MessageKey)}>
                  {s}
                </span>
              ))}
            </div>
          </section>
        </>
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/api-keys/{id}/history"
          id={k.id}
          fieldLabel={(x) => fieldLabel(t, x)}
          describe={(r) => describe(t, r)}
        />
      )}
    </Drawer>
  );
}

function fieldLabel(t: T, k: string): string {
  const key = `akey.h.${k}` as MessageKey;
  return t(key) === key ? k : t(key);
}

/** หัวรายการของการหมุน/เพิกถอน (action เฉพาะของ API key) */
function describe(
  t: T,
  r: Schemas['AuditEntryDto'],
): { title: string; tone: 'ok' | 'info' | 'warn' | 'off' | 'err'; icon: string } | undefined {
  if (r.action === 'api_key.rotated')
    return { title: t('akey.menu.rotate'), tone: 'info', icon: 'refresh-cw' };
  if (r.action === 'api_key.revoked')
    return { title: t('akey.st.revoked'), tone: 'err', icon: 'ban' };
  return undefined;
}
