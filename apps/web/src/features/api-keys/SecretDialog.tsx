import { Icon } from '@tms/ui';
import { useI18n } from '../../i18n';

/**
 * หน้าต่างแสดง secret ครั้งเดียว — ต้นแบบ TMS v4 vSec (z 75, กว้าง 600, ช่อง monospace + คัดลอก + คำเตือน)
 * ปิดได้ทางปุ่ม "คัดลอกแล้ว · ปิดหน้าต่าง" เท่านั้น (ต้นแบบ: คลิกพื้นหลังไม่ปิด กันปิดก่อนคัดลอก)
 */
export function SecretDialog({
  title,
  sub,
  warn,
  label,
  value,
  copied,
  onCopy,
  onClose,
}: {
  title: string;
  sub: string;
  warn: string;
  /** ป้ายช่อง (ค่าเริ่ม "Secret key" — webhook = "Signing secret") */
  label?: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const name = label ?? t('akey.secret.label');
  return (
    <div className="akey-sec__scrim">
      <div className="akey-sec" role="dialog" aria-modal="true" aria-label={title}>
        <div className="akey-sec__head">
          <h2>{title}</h2>
          <span>{sub}</span>
        </div>
        <div className="akey-sec__body">
          <div className="akey-sec__warn">
            <Icon n="triangle-alert" s={16} />
            <span>{warn}</span>
          </div>
          <label className="akey-sec__label">
            <span>{name}</span>
            <div className="akey-sec__row">
              <input
                readOnly
                value={value}
                aria-label={name}
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.currentTarget.select()}
              />
              <button type="button" className="akey-sec__copy" onClick={onCopy}>
                <Icon n="copy" s={16} />
                {copied ? t('akey.secret.copied') : t('akey.secret.copy')}
              </button>
            </div>
          </label>
        </div>
        <div className="akey-sec__foot">
          <button type="button" className="akey-sec__close" onClick={onClose}>
            {t('akey.secret.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
