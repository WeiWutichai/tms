import type { Schemas } from '@tms/contracts';
import { Badge, Drawer, DrawerFooterButtons, Icon } from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { HistoryTab } from '../master/HistoryTab';
import { useHookFormat } from './format';
import type { Webhook } from './useWebhooks';
import { DeliveryHistory } from './WebhookDeliveries';
import type { ApiMode } from '../api-keys/mode';

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
 * Drawer ของ webhook endpoint — ต้นแบบ TMS v4 vPanelApi hook: หัว "Webhook endpoint · Production", รหัส, ป้ายสถานะ, URL ·
 * แท็บ รายละเอียด / กิจกรรม · ข้อมูล (URL, อัตราสำเร็จ 7 วัน, ล้มเหลวติดต่อกัน, ส่งล่าสุด, นโยบายลองใหม่) · ชิป Event ที่สมัคร ·
 * กล่องโค้ด "ตรวจลายเซ็น (Node.js)" + คัดลอก · ปุ่มล่าง: ปิด/เปิดใช้งาน · หมุน signing secret · ส่ง event ทดสอบ
 * - "ประวัติการส่ง" (ST7-T05): แถวละ event · ดูข้อมูล (payload/response) · ส่งซ้ำ — อยู่ระหว่างชิป event กับกล่องโค้ดตามต้นแบบ
 * - นโยบายลองใหม่ตาม docs/04 G1 (8 ครั้ง ~3 วัน · ปิดเมื่อ 50 event ล้มติด) แทนข้อความต้นแบบ "8 ครั้งใน 24 ชม. · 8 ครั้ง"
 */
export function WebhookDrawer({
  h,
  canWrite,
  onToggle,
  onRotate,
  onTest,
  onCopied,
  onClose,
  toast,
  mode = 'live',
}: {
  h: Webhook;
  /** ST7-T09 โหมดของหน้า (ป้ายหัว drawer) */
  mode?: ApiMode;
  canWrite: boolean;
  onToggle: () => void;
  onRotate: () => void;
  onTest: () => void;
  onCopied: () => void;
  onClose: () => void;
  toast: (s: string) => void;
}) {
  const { t } = useI18n();
  const fm = useHookFormat();
  const [tab, setTab] = useState<Tab>('info');
  const code = t('whk.code.node');
  const rate = fm.rate(h);
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('whk.kind', { mode: t(mode === 'test' ? 'akey.mode.test' : 'akey.mode.live') })}
      title={fm.no(h)}
      badge={<Badge label={fm.status(h)} />}
      subtitle={h.url}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      tabs={[
        { key: 'info', label: t('akey.tab.info') },
        { key: 'act', label: t('akey.tab.act') },
      ]}
      tab={tab}
      onTab={(x) => setTab(x as Tab)}
      {...(canWrite
        ? {
            footer: (
              <DrawerFooterButtons
                secondary={[
                  { label: t(fm.off(h) ? 'whk.menu.on' : 'whk.menu.off'), onClick: onToggle },
                  { label: t('whk.rotate'), onClick: onRotate },
                ]}
                primary={{ label: t('whk.menu.test'), icon: 'send', onClick: onTest }}
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
              <Kv k="URL" v={h.url} />
              <Kv k={t('whk.f.ok')} v={rate.text} />
              <Kv k={t('whk.f.fails')} v={t('whk.nTimes', { n: h.consecutiveFailures })} />
              <Kv k={t('whk.col.last')} v={fm.last(h)} />
              <Kv k={t('whk.f.policy')} v={t('whk.policy')} />
            </div>
          </section>
          <section className="akey-chips">
            <span className="akey-chips__h">{t('whk.f.evN', { n: h.events.length })}</span>
            <div className="akey-chips__list">
              {h.events.map((e) => (
                <span key={e}>{e}</span>
              ))}
            </div>
          </section>
          <DeliveryHistory endpointId={h.id} canWrite={canWrite} toast={toast} />
          <section className="whk-code">
            <div className="whk-code__h">
              <span>{t('whk.code.title')}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(code).catch(() => undefined);
                  onCopied();
                }}
              >
                <Icon n="copy" s={14} />
                {t('whk.copy')}
              </button>
            </div>
            <pre>{code}</pre>
          </section>
        </>
      )}
      {tab === 'act' && (
        <HistoryTab
          path="/v1/webhooks/{id}/history"
          id={h.id}
          fieldLabel={(x) => fieldLabel(t, x)}
          describe={(r) => describe(t, r)}
        />
      )}
    </Drawer>
  );
}

function fieldLabel(t: T, k: string): string {
  const key = `whk.h.${k}` as MessageKey;
  return t(key) === key ? k : t(key);
}

/** หัวรายการของ action เฉพาะ webhook (ปิด/เปิด/หมุน secret/ทดสอบ/ปิดอัตโนมัติ) */
function describe(
  t: T,
  r: Schemas['AuditEntryDto'],
): { title: string; tone: 'ok' | 'info' | 'warn' | 'off' | 'err'; icon: string } | undefined {
  switch (r.action) {
    case 'webhook_endpoint.secret_rotated':
      return { title: t('whk.rotate'), tone: 'info', icon: 'refresh-cw' };
    case 'webhook_endpoint.disabled':
      return { title: t('whk.menu.off'), tone: 'off', icon: 'power' };
    case 'webhook_endpoint.enabled':
      return { title: t('whk.menu.on'), tone: 'ok', icon: 'power' };
    case 'webhook_endpoint.auto_disabled':
      return { title: t('whk.h.auto'), tone: 'err', icon: 'webhook' };
    case 'webhook_endpoint.delivery_retried':
      return {
        title: t('whk.dlog.retried', { ev: String(r.after?.eventType ?? '') }),
        tone: 'info',
        icon: 'refresh-cw',
      };
    case 'webhook_endpoint.event_redelivered':
      return {
        title: t('whk.dlog.redelivered', { ev: String(r.after?.eventType ?? '') }),
        tone: 'info',
        icon: 'refresh-cw',
      };
    case 'webhook_endpoint.test_sent':
      return { title: t('whk.menu.test'), tone: 'info', icon: 'send' };
    default:
      return undefined;
  }
}
