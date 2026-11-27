import { Icon, useEscapeLayer } from '@tms/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { helpConfig, type HelpConfig } from './config';
import { cleanPath, lineUrl, mailtoUrl, SUPPORT_TAG } from './contact';
import { helpUrlFor } from './routes';

/**
 * ปุ่ม "คู่มือ" บนแถบบน (P1-ST6-T02 ลิงก์คู่มือจากทุกหน้า + P1-ST6-T03 ติดต่อทีมงาน)
 * ต้นแบบ TMS v4 ไม่มีจุดเข้า help ในแอป → ประกอบจากชิ้นของต้นแบบ (D-83) [DECISION — lead 27 พ.ย. 2569, ย้อนได้ · spec/12 §3]:
 * ปุ่มกลม 36 แบบกระดิ่ง (`tms-iconbtn`) + ไอคอน `book-open` (ต้นแบบใช้กับลิงก์ "เอกสาร API") + เมนู `tms-menu` แบบปุ่ม ⋯ ของ drawer
 * รายการ: คู่มือหน้านี้ · ศูนย์ช่วยเหลือ · ติดต่อทีมงานทางอีเมล / LINE (ไม่ได้ตั้งช่องทาง = รายการปิด + ข้อความบอกเหตุ)
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
  const noteId = useId();
  useEscapeLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const text = tenantId
    ? {
        subject: `${SUPPORT_TAG} ${t('help.contact.subject', { tenant: tenantId })}`,
        body: t('help.contact.body', {
          tenant: tenantId,
          page: `${pageTitle || '—'} (${cleanPath(path)})`,
        }),
      }
    : null;
  const mail = text && mailtoUrl(cfg, text);
  const line = text && lineUrl(cfg, text);
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
        <div className="tms-menu" style={{ top: 42, right: 0, zIndex: 40, width: 280 }}>
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
            {mail && (
              <button
                type="button"
                role="menuitem"
                data-href={mail}
                onClick={() => go(mail, false)}
              >
                <Icon n="mail" s={16} />
                {t('help.contact.email')}
              </button>
            )}
            {line && (
              <button type="button" role="menuitem" data-href={line} onClick={() => go(line, true)}>
                <Icon n="message-circle" s={16} />
                {t('help.contact.line')}
              </button>
            )}
            {!mail && !line && (
              <button
                type="button"
                role="menuitem"
                disabled
                aria-disabled="true"
                aria-describedby={noteId}
                style={{ color: '#59606B', cursor: 'not-allowed' }}
              >
                <Icon n="mail" s={16} />
                {t('help.contact')}
              </button>
            )}
          </div>
          {/* ข้อความใต้รายการ — ขนาด/สีเดียวกับข้อความช่วยใต้ช่องกรอกของต้นแบบ (12.5 / #59606B) */}
          <span
            id={noteId}
            style={{
              padding: '2px 10px 8px 36px',
              fontSize: 12.5,
              color: '#59606B',
              lineHeight: 1.5,
            }}
          >
            {t(mail || line ? 'help.contact.note' : 'help.contact.unset')}
          </span>
        </div>
      )}
    </div>
  );
}
