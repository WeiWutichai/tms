import { Menu, Truck, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n, type Lang } from '../../i18n/core';
import type { MessageKey } from '../../i18n/th';
import type { LandingConfig } from './config';

/**
 * ไปหน้าอื่นด้วยการโหลดหน้าใหม่ — landing / หน้าราคาเป็น bundle แยก (main.tsx) ไม่อยู่ใน router ของแอป
 * (test แทนที่ `go` ได้)
 */
export const landingNav = { go: (path: string) => window.location.assign(path) };

/** ช่องทางติดต่อ + ปลายทางปุ่มที่ใช้ร่วมกันระหว่าง landing กับหน้าราคา */
export function usePublicActions(config: LandingConfig, setToast: (s: string) => void) {
  const { t } = useI18n();
  const contactParts = [
    config.contact.line && `LINE ${config.contact.line}`,
    config.contact.phone,
  ].filter(Boolean) as string[];
  const contactText = [...contactParts, config.contact.email].filter(Boolean).join(' · ');
  /** หน้าสมัครยังไม่เปิด (`signupLive` = false) → แสดงช่องทางติดต่อแทน (ไม่พาไปหน้า 404) */
  const contactToast = () =>
    setToast(contactText ? t('land.soonContact', { contact: contactText }) : t('land.soon'));
  const goSignup = () => (config.signupLive ? landingNav.go(config.signupPath) : contactToast());
  return { contactParts, contactText, contactToast, goSignup };
}

/**
 * หัว + เมนูมือถือ + ท้าย + toast ของหน้า public (TMS Signup.dc.html) — landing (`/home`) และหน้าราคา (`/pricing`)
 * page = เมนูที่ "on" (ต้นแบบ menu: ฟีเจอร์ on เมื่อ view home, ราคา on เมื่อ view pricing)
 * หัวโปร่งบน hero เฉพาะ landing ตอนยังไม่เลื่อน (ต้นแบบ dk = view home && !hdrSolid && !menuOpen)
 */
export function PublicShell({
  page,
  config,
  showPrice,
  toast,
  setToast,
  onFeatures,
  children,
}: {
  page: 'home' | 'pricing';
  config: LandingConfig;
  /** `pricing.publicVisible` (GET /v1/public/plans ≠ 404) — ซ่อนเมนู/ลิงก์ราคาเมื่อปิด (D-40) */
  showPrice: boolean;
  toast: string;
  setToast: (s: string) => void;
  /** กด "ฟีเจอร์" — landing เลื่อนไป #features · หน้าอื่นไป /home#features */
  onFeatures?: () => void;
  children: ReactNode;
}) {
  const { t, lang, setLang } = useI18n();
  const [solid, setSolid] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { contactParts, contactText, goSignup } = usePublicActions(config, setToast);

  useEffect(() => {
    const on = () => setSolid(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(id);
  }, [toast, setToast]);

  const dark = page === 'home' && !solid && !menuOpen;
  const close = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };
  const toFeatures = onFeatures ?? (() => landingNav.go('/home#features'));
  const toPricing = () => (page === 'pricing' ? window.scrollTo(0, 0) : landingNav.go('/pricing'));
  const menu: Array<{ k: MessageKey; fn: () => void; on: boolean }> = [
    { k: 'land.nav.features', fn: close(toFeatures), on: page === 'home' },
    ...(showPrice
      ? [{ k: 'land.nav.pricing' as MessageKey, fn: close(toPricing), on: page === 'pricing' }]
      : []),
    ...(contactText
      ? [
          {
            k: 'land.nav.contact' as MessageKey,
            fn: close(() => setToast(contactText)),
            on: false,
          },
        ]
      : []),
  ];
  const goLogin = () => landingNav.go('/login');
  const signup = close(goSignup);
  const langs: Array<[Lang, string]> = [
    ['th', 'TH'],
    ['en', 'EN'],
    ['zh', '中文'],
  ];
  const companyLinks = (
    [
      ['land.foot.about', config.links.about],
      ['land.nav.contact', contactText ? '#contact' : undefined],
      ['land.foot.privacy', config.links.privacy],
      ['land.foot.terms', config.links.terms],
    ] as Array<[MessageKey, string | undefined]>
  ).filter(([, href]) => href);
  const signupLink = config.signupLive
    ? { href: config.signupPath }
    : {
        href: '#contact',
        onClick: (e: { preventDefault(): void }) => {
          e.preventDefault();
          goSignup();
        },
      };

  return (
    <div className="land">
      <header className={`land-hd${dark ? ' land-hd--dark' : ''}`}>
        <a href="/home" className="land-logo">
          <span className="land-logo__mark">
            <Truck size={18} strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="land-logo__txt">
            <span className="land-logo__name">{t('pub.brand')}</span>
            <span className="land-logo__sub">{t('pub.brandSub')}</span>
          </span>
        </a>
        <nav className="land-nav">
          {menu.map((m) => (
            <button
              key={m.k}
              type="button"
              className={`land-nav__i${m.on ? ' is-on' : ''}`}
              aria-current={m.on ? 'page' : undefined}
              onClick={m.fn}
            >
              {t(m.k)}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <div className="land-lang">
          {langs.map(([k, l]) => (
            <button
              key={k}
              type="button"
              className={`land-lang__i${lang === k ? ' is-on' : ''}`}
              aria-pressed={lang === k}
              onClick={() => setLang(k)}
            >
              {l}
            </button>
          ))}
        </div>
        <button type="button" className="land-hd__login" onClick={goLogin}>
          {t('land.login')}
        </button>
        <button type="button" className="land-hd__cta" onClick={goSignup}>
          {t('land.cta')}
        </button>
        <button
          type="button"
          className="land-hd__menu"
          title={t('land.menu')}
          aria-label={t('land.menu')}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? (
            <X size={20} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Menu size={20} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      </header>
      {menuOpen && (
        <div className="land-mmenu">
          {menu.map((m) => (
            <button key={m.k} type="button" className="land-mmenu__i" onClick={m.fn}>
              {t(m.k)}
            </button>
          ))}
          <button type="button" className="land-mmenu__i land-mmenu__i--last" onClick={goLogin}>
            {t('land.login')}
          </button>
          <button type="button" className="land-btn land-mmenu__cta" onClick={signup}>
            {t('land.cta')}
          </button>
        </div>
      )}

      {children}

      <footer className="land-ft">
        <div className="land-ft__cols">
          <div className="land-ft__brand">
            <span className="land-ft__name">{t('pub.brand')}</span>
            <span className="land-ft__desc">{t('land.foot.desc')}</span>
            {contactParts.length > 0 && <span>{contactParts.join(' · ')}</span>}
          </div>
          <div className="land-ft__col">
            <span className="land-ft__h">{t('land.foot.product')}</span>
            <a
              href="/home#features"
              onClick={(e) => {
                e.preventDefault();
                toFeatures();
              }}
            >
              {t('land.nav.features')}
            </a>
            {showPrice && <a href="/pricing">{t('land.nav.pricing')}</a>}
            <a {...signupLink}>{t('land.foot.trial')}</a>
            <a href="/login">{t('land.login')}</a>
          </div>
          {companyLinks.length > 0 && (
            <div className="land-ft__col">
              <span className="land-ft__h">{t('land.foot.company')}</span>
              {companyLinks.map(([k, href]) =>
                href === '#contact' ? (
                  <a
                    key={k}
                    href="#contact"
                    onClick={(e) => {
                      e.preventDefault();
                      setToast(contactText);
                    }}
                  >
                    {t(k)}
                  </a>
                ) : (
                  <a key={k} href={href}>
                    {t(k)}
                  </a>
                ),
              )}
            </div>
          )}
        </div>
        <div className="land-ft__row">
          <span>{t('pub.footCopy')}</span>
          <span style={{ flex: 1 }} />
          <span>{t('pub.footData')}</span>
        </div>
      </footer>
      {toast && (
        <div className="land-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
