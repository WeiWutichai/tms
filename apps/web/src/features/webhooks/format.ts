import { formatDateTime, useI18n } from '../../i18n';
import { useMe } from '../../shell/AppShell';
import type { Webhook } from './useWebhooks';

/** ข้อความคอลัมน์/ช่องของ webhook ตามต้นแบบ specApi hooks + vPanelApi hook */
export function useHookFormat() {
  const { t, lang } = useI18n();
  const me = useMe();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const off = (h: Webhook) => h.status === 'disabled' || h.status === 'auto_disabled';
  return {
    off,
    /** รหัสสั้นของ endpoint (ต้นแบบแสดงรหัสเอกสาร WH01) */
    no: (h: Webhook) => `${h.id.slice(0, 12)}…`,
    /** ใช้งาน / ล้มเหลวต่อเนื่อง / ปิด (ระบบปิดอัตโนมัติก็แสดง "ปิด" — เหตุผลอยู่ในกิจกรรม) */
    status: (h: Webhook) =>
      t(off(h) ? 'whk.st.disabled' : h.status === 'failing' ? 'whk.st.failing' : 'whk.st.active'),
    /** "Event ที่สมัคร" 2 ตัวแรก + "+N" */
    events: (h: Webhook) =>
      h.events.length > 2
        ? t('akey.more', { list: h.events.slice(0, 2).join(', '), n: h.events.length - 2 })
        : h.events.join(', '),
    /** สำเร็จ 7 วัน — ปิด/ยังไม่มีการส่ง = "—" · สีตามต้นแบบ (≥ 95 เขียว, ≥ 80 ส้ม, ต่ำกว่าแดง) */
    rate: (h: Webhook) =>
      off(h) || h.successRate7d === null
        ? { text: '—', color: '#59606B' }
        : {
            text: `${h.successRate7d.toFixed(1)}%`,
            color:
              h.successRate7d >= 95 ? '#17733F' : h.successRate7d >= 80 ? '#8F5500' : '#B3322A',
          },
    last: (h: Webhook) => (h.lastDeliveryAt ? formatDateTime(h.lastDeliveryAt, lang, ys) : '—'),
  };
}
