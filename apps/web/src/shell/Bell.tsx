import { useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useEffect, useState } from 'react';
import { api, queryClient } from '../api';
import { useI18n } from '../i18n';

const UNREAD = ['notifications', 'unread'] as const;

/**
 * กระดิ่งแจ้งเตือน (ST1-T23) — ต้นแบบ TMS v4: ปุ่มกลม 36 + จุดน้ำเงิน, กดแล้ว toast
 * "แจ้งเตือนใหม่ N รายการ: …" (ต้นแบบยังไม่มีรายการ/แผงแจ้งเตือน — [OPEN] spec/12 §3)
 * จุดแสดงเฉพาะเมื่อมีที่ยังไม่อ่าน (ต้นแบบเป็นข้อมูลตัวอย่างที่มีเสมอ) · กดแล้วทำเครื่องหมายว่าอ่านแล้ว
 */
export function Bell() {
  const { t } = useI18n();
  const [toast, setToast] = useState<string | null>(null);
  const unread = useQuery({
    queryKey: UNREAD,
    queryFn: async () => (await api.GET('/v1/me/notifications/unread-count')).data?.unread ?? 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(h);
  }, [toast]);

  async function open() {
    const r = await api.GET('/v1/me/notifications', {
      params: { query: { unread: true, limit: 5 } },
    });
    const items = r.data?.data ?? [];
    if (!items.length) {
      setToast(t('notify.none'));
      return;
    }
    const n = unread.data && unread.data > items.length ? unread.data : items.length;
    setToast(t('notify.new', { n, list: items.map((x) => x.body).join(', ') }));
    await api.POST('/v1/me/notifications/read-all').catch(() => undefined);
    queryClient.setQueryData(UNREAD, 0);
  }

  const has = (unread.data ?? 0) > 0;
  return (
    <>
      <button
        type="button"
        className="tms-iconbtn"
        title={t('shell.notifications')}
        aria-label={has ? t('notify.unread') : t('shell.notifications')}
        onClick={() => void open()}
      >
        <Icon n="bell" s={16} />
        {has && (
          <span
            data-testid="bell-dot"
            style={{
              position: 'absolute',
              top: 6,
              right: 7,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#2257C4',
              border: '1.5px solid #FFFFFF',
            }}
          />
        )}
      </button>
      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed',
            right: 24,
            bottom: 24,
            zIndex: 80,
            background: '#FFFFFF',
            border: '1px solid #D9DCD4',
            borderRadius: 14,
            boxShadow: '0 12px 32px rgba(16,24,40,.16)',
            padding: '12px 12px 12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            maxWidth: 440,
          }}
        >
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: '#17733F',
              color: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon n="check" s={14} />
          </span>
          <span>{toast}</span>
          <button
            type="button"
            aria-label={t('notify.close')}
            onClick={() => setToast(null)}
            style={{
              width: 28,
              height: 28,
              border: 0,
              borderRadius: 999,
              background: 'transparent',
              color: '#3B424C',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon n="x" s={16} />
          </button>
        </div>
      )}
    </>
  );
}
