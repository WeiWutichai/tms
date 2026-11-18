import { enumLabel, formatDate, formatDateTime, useI18n } from '../../i18n';
import { useMe } from '../../shell/AppShell';
import type { ApiKey } from './useApiKeys';

/** ข้อความของคอลัมน์/ช่องของ API key ตามต้นแบบ specApi (วันที่ตามปี พ.ศ./ค.ศ. ของบริษัท) */
export function useKeyFormat() {
  const { t, lang } = useI18n();
  const me = useMe();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const date = (iso: string) => formatDate(new Date(iso), lang, ys);
  const dateTime = (iso: string) => formatDateTime(iso, lang, ys);
  return {
    date,
    dateTime,
    // ST7-T07: ค่าที่ยังไม่รู้จัก (API เพิ่ม enum ใหม่) → แสดงค่าดิบ ไม่พัง
    status: (k: ApiKey) => enumLabel(t, 'akey.st.', k.status),
    mode: (k: ApiKey) => t(k.mode === 'test' ? 'akey.mode.test' : 'akey.mode.live'),
    ip: (k: ApiKey) => (k.ipAllowlist.length ? k.ipAllowlist.join(', ') : t('akey.anyIp')),
    by: (k: ApiKey) => k.createdByName ?? '—',
    /** ใช้ล่าสุด — เพิกถอนแล้ว = "—" · ยังไม่เคยใช้ = "ยังไม่ได้ใช้" (ต้นแบบ makeKey) */
    last: (k: ApiKey) =>
      k.status === 'revoked' ? '—' : k.lastUsedAt ? dateTime(k.lastUsedAt) : t('akey.unused'),
    exp: (k: ApiKey) => (k.expiresAt ? date(k.expiresAt) : t('akey.never')),
    /** Scope 2 ตัวแรก + "+N" */
    scopes: (k: ApiKey) =>
      k.scopes.length > 2
        ? t('akey.more', { list: k.scopes.slice(0, 2).join(', '), n: k.scopes.length - 2 })
        : k.scopes.join(', '),
  };
}
