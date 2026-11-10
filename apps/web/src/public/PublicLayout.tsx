import { Icon } from '@tms/ui';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import './public.css';

/**
 * โครงหน้า public — header/footer ของ TMS Signup.dc.html
 * เฟส 0: header เหลือโลโก้, footer เหลือแถวล่าง (คำตอบ PO 10 พ.ย. 2569 — spec/12 §3)
 */
export function PublicLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="pub">
      <header className="pub-hd">
        <span className="pub-logo">
          <span className="pub-logo__mark">
            <Icon n="truck" s={18} />
          </span>
          <span className="pub-logo__txt">
            <span className="pub-logo__name">{t('pub.brand')}</span>
            <span className="pub-logo__sub">{t('pub.brandSub')}</span>
          </span>
        </span>
      </header>
      <main className="pub-main">
        <section className="pub-card">{children}</section>
      </main>
      <footer className="pub-ft">
        <div className="pub-ft__row">
          <span>{t('pub.footCopy')}</span>
          <span style={{ flex: 1 }} />
          <span>{t('pub.footData')}</span>
        </div>
      </footer>
    </div>
  );
}
