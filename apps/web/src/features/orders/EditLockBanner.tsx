import { Icon, ReasonDialog } from '@tms/ui';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import type { EditLock } from './editLock';
import { toBangkok } from './orderForm';
import { useForceUnlock } from './useOrders';

/**
 * ป้าย "กำลังแก้ไขโดย …" (ST3-T08; docs/04 C Edit lock) — ต้นแบบไม่มีป้ายนี้ จึงใช้แถบล็อกของต้นแบบ
 * (ใบแจ้งหนี้ "ออกแล้ว · แก้ไขไม่ได้": พื้น #EEF0EC มุม 8 ไอคอน lock #2257C4) [OPEN spec/12 §3]
 * ผู้มีสิทธิ์ `orders:unlock` เห็นปุ่ม "ปลดล็อก" → ReasonDialog (เหตุผล ≥ 10 ตัวอักษร ลง audit)
 */
export function EditLockBanner({
  orderId,
  soNo,
  lock,
  canUnlock,
  onUnlocked,
}: {
  orderId: string;
  soNo: string;
  lock: EditLock;
  canUnlock: boolean;
  onUnlocked: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const unlock = useForceUnlock();
  return (
    <>
      <div
        role="note"
        data-testid="edit-lock-banner"
        style={{
          background: '#EEF0EC',
          border: '1px solid #E9F0FA',
          borderRadius: 8,
          padding: '10px 14px',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
        }}
      >
        <Icon n="lock" s={16} style={{ color: '#2257C4', marginTop: 4, flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          <span style={{ fontWeight: 600 }}>{t('ord.lock.by', { name: lock.userName })}</span>
          <br />
          <span style={{ color: '#59606B', fontSize: 12.5 }}>
            {t('ord.lock.until', { time: toBangkok(lock.expiresAt).time })}
          </span>
        </span>
        {canUnlock && (
          <button
            type="button"
            className="tms-linkbtn"
            style={{ flexShrink: 0 }}
            onClick={() => {
              unlock.reset();
              setOpen(true);
            }}
          >
            {t('ord.lock.unlock')}
          </button>
        )}
      </div>
      <ReasonDialog
        open={open}
        title={t('ord.lock.dlgTitle', { name: lock.userName })}
        description={t('ord.lock.dlgDesc', { name: lock.userName })}
        label={t('ord.lock.reason')}
        placeholder={t('ord.lock.reasonPh')}
        okLabel={t('ord.lock.ok')}
        okIcon="lock-open"
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={unlock.isPending}
        error={problemText(unlock.error, t)}
        onClose={() => setOpen(false)}
        onOk={(reason) =>
          unlock.mutate(
            { id: orderId, reason },
            {
              onSuccess: () => {
                setOpen(false);
                onUnlocked(t('ord.lock.done', { no: soNo }));
              },
            },
          )
        }
      />
    </>
  );
}
