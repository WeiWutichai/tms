import { Icon, useEscapeLayer } from '@tms/ui';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { helpConfig, type HelpConfig } from './config';
import { helpUrlFor } from './routes';

/**
 * ปุ่ม "คู่มือ" บนแถบบน (P1-ST6-T02 ลิงก์คู่มือจากทุกหน้า + P1-ST6-T03 ติดต่อทีมงาน)
 * ต้นแบบ TMS v4 ไม่มีจุดเข้า help ในแอป → ประกอบจากชิ้นของต้นแบบ (D-83) [DECISION — lead 27 พ.ย. 2569, ย้อนได้ · spec/12 §3]:
 * ปุ่มกลม 36 แบบกระดิ่ง (`tms-iconbtn`) + ไอคอน `book-open` (ต้นแบบใช้กับลิงก์ "เอกสาร API") + เมนู `tms-menu` แบบปุ่ม ⋯ ของ drawer
 * รายการ: คู่มือหน้านี้ · ศูนย์ช่วยเหลือ
 */
export function HelpMenu({
  page,
  pageTitle,
  path,
  tenantId,
  cfg = helpConfig,
}: {
  /** key ของหน้า (nav.ts `pageOf`) */
  page: string | undefined;
  pageTitle: string;
  path: string;
  tenantId: string | undefined;
  cfg?: HelpConfig;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEscapeLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const go = (url: string, newTab: boolean) => {
    setOpen(false);
    if (newTab) window.open(url, '_blank', 'noopener');
    else window.location.assign(url);
  };

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button
        type="button"
        className="tms-iconbtn"
        title={t('help.menu')}
        aria-label={t('help.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon n="book-open" s={16} />
      </button>
      {open && (
        <div className="tms-menu" style={{ top: 42, right: 0, zIndex: 40 }}>
          <div
            role="menu"
            aria-label={t('help.menu')}
            style={{ display: 'flex', flexDirection: 'column' }}
          >
            <button
              type="button"
              role="menuitem"
              data-href={helpUrlFor(page, cfg.helpCenterUrl)}
              onClick={() => go(helpUrlFor(page, cfg.helpCenterUrl), true)}
            >
              <Icon n="book-open" s={16} />
              {t('help.page')}
            </button>
            <button
              type="button"
              role="menuitem"
              data-href={cfg.helpCenterUrl}
              onClick={() => go(cfg.helpCenterUrl, true)}
            >
              <Icon n="life-buoy" s={16} />
              {t('help.center')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
