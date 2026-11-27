import { Menu, Truck, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n, type Lang } from '../../i18n/core';
import type { MessageKey } from '../../i18n/th';
import { ACCOUNTING_ORDER, landingConfig, WORKS_WITH_ORDER, type LandingConfig } from './config';
import { useLandingMeta } from './meta';
import { SignupMain } from '../signup/SignupMain';
import './landing.css';
import heroPlan1x from './img/hero-plan-1x.webp';
import heroPlan2x from './img/hero-plan-2x.webp';
import tPlan1x from './img/t-plan-1x.webp';
import tPlan2x from './img/t-plan-2x.webp';
import tSub1x from './img/t-sub-1x.webp';
import tSub2x from './img/t-sub-2x.webp';
import tBill1x from './img/t-bill-1x.webp';
import tBill2x from './img/t-bill-2x.webp';
import fSettle1x from './img/f-settle-1x.webp';
import fSettle2x from './img/f-settle-2x.webp';
import fFdockpi1x from './img/f-fdockpi-1x.webp';
import fFdockpi2x from './img/f-fdockpi-2x.webp';
import fFdoc1x from './img/f-fdoc-1x.webp';
import fFdoc2x from './img/f-fdoc-2x.webp';

/**
 * Landing page สาธารณะ (P1-ST2-T01) — `design/prototype/TMS Signup.dc.html` view `home`
 * รูปจาก `design/prototype/assets/landing/` (แปลงเป็น webp ขนาด 1x/2x — หน้าตาเดิม)
 *
 * ส่วนที่ไม่แสดง/ปรับ (R-11 ขอบเขตเฟส 1 + R-02/D-56 ข้อความภาษี) [DECISION — lead 27 พ.ย. 2569, ย้อนได้] — spec/12 §3:
 * - 06:30 "AI ร่าง SO จาก LINE" (D-48), 13:25 "คนขับถ่าย POD ในแอปออฟไลน์" (แอปคนขับ = เฟส 2) → ไม่แสดงช่วงนั้น
 * - "เอกสารภาษีออกจากระบบได้เอง" + ภาพใบกำกับ (D-56/R-02 — รอ P1-ST7) → ไม่แสดง
 * - section "Open API, Webhook และ MCP" + เมนู/คอลัมน์ "นักพัฒนา" (Open API สาธารณะ = เฟส 2, MCP = D-48) → ไม่แสดง
 * - FAQ AI / แอปคนขับออฟไลน์ / เชื่อมระบบของเราเอง (Open API + MCP) → ไม่แสดง
 * - แถบข้อเท็จจริงใน hero: เปลี่ยนเป็นของที่มีจริง (ใบวางบิล/ใบแจ้งหนี้, ลิงก์รถร่วม M10, จำนวนระบบบัญชีที่เปิด)
 * - ราคา (เมนู, "ดูราคา", แถบราคา, FAQ คิดเงิน) ซ่อนเมื่อ `pricingVisible = false` (D-40)
 * - รูป hero/ภาพคั่นจาก Unsplash (ผู้ให้บริการภายนอก) → ใช้สีพื้นของต้นแบบตอนไม่มีรูป ไม่แสดงป้าย placeholder
 */
/**
 * ไปหน้าอื่นด้วยการโหลดหน้าใหม่ — landing เป็น bundle แยก (main.tsx) ไม่อยู่ใน router ของแอป
 * (test แทนที่ `go` ได้)
 */
export const landingNav = { go: (path: string) => window.location.assign(path) };

export function LandingPage({
  config = landingConfig,
  view = 'home',
}: {
  config?: LandingConfig;
  /** `signup` = หน้าสมัคร (P1-ST2-T03 — ต้นแบบ view `signup`: header/footer เดียวกัน header ทึบเสมอ) */
  view?: 'home' | 'signup';
}) {
  const home = view === 'home';
  const { t, lang, setLang } = useI18n();
  const [solid, setSolid] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [faq, setFaq] = useState(0);
  const [toast, setToast] = useState('');
  useLandingMeta(home ? t('land.meta.title') : t('su.meta.title'), t('land.lead'));

  // มาจากหน้าอื่น (หน้าสมัคร → "ฟีเจอร์") — เลื่อนไปส่วนฟีเจอร์
  useEffect(() => {
    if (!home || window.location.hash !== '#features') return;
    const el = document.getElementById('features');
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 72);
  }, [home]);
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
  }, [toast]);

  const enabled = new Set(config.integrations);
  const joinList = (names: string[], word: MessageKey) =>
    names.length < 2
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} ${t(word)} ${names[names.length - 1]}`;
  const worksWith = WORKS_WITH_ORDER.filter((n) => enabled.has(n));
  const accounting = ACCOUNTING_ORDER.filter((n) => enabled.has(n));
  const contactParts = [
    config.contact.line && `LINE ${config.contact.line}`,
    config.contact.phone,
  ].filter(Boolean) as string[];
  const contactText = [...contactParts, config.contact.email].filter(Boolean).join(' · ');
  const showPrice = config.pricingVisible;

  const dark = home && !solid && !menuOpen;
  /** หน้าสมัคร/ราคายังไม่เปิด (`signupLive` / `pricingPageLive` = false) → แสดงช่องทางติดต่อแทน (ไม่พาไปหน้า 404) */
  const contactToast = () => {
    setMenuOpen(false);
    setToast(contactText ? t('land.soonContact', { contact: contactText }) : t('land.soon'));
  };
  const goSignup = () => {
    if (!home) {
      setMenuOpen(false);
      window.scrollTo(0, 0);
      return;
    }
    if (config.signupLive) landingNav.go(config.signupPath);
    else contactToast();
  };
  const goPricing = () => (config.pricingPageLive ? landingNav.go('/pricing') : contactToast());
  /** ลิงก์ <a> ไปหน้าที่อาจยังไม่เปิด — ไม่เปิด = กดแล้วแสดงช่องทางติดต่อ */
  const linkProps = (live: boolean, href: string) =>
    live
      ? { href }
      : {
          href: '#contact',
          onClick: (e: { preventDefault(): void }) => {
            e.preventDefault();
            contactToast();
          },
        };
  const goLogin = () => landingNav.go('/login');
  const toFeatures = () => {
    setMenuOpen(false);
    if (!home) return landingNav.go('/home#features');
    const el = document.getElementById('features');
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 72);
  };
  const menu: Array<{ k: MessageKey; fn: () => void }> = [
    { k: 'land.nav.features', fn: toFeatures },
    ...(showPrice ? [{ k: 'land.nav.pricing' as MessageKey, fn: goPricing }] : []),
    ...(contactText
      ? [
          {
            k: 'land.nav.contact' as MessageKey,
            fn: () => {
              setMenuOpen(false);
              setToast(contactText);
            },
          },
        ]
      : []),
  ];

  const facts = [
    t('land.fact.bill'),
    t('land.fact.link'),
    ...(accounting.length ? [t('land.fact.acc', { n: accounting.length })] : []),
  ];
  const faqs: Array<{ q: MessageKey; a: string }> = [
    {
      q: 'land.faq.erp.q',
      a: accounting.length
        ? t('land.faq.erp.a', { list: joinList(accounting, 'land.or') })
        : t('land.faq.erp.aNone'),
    },
    { q: 'land.faq.sub.q', a: t('land.faq.sub.a') },
    { q: 'land.faq.excel.q', a: t('land.faq.excel.a') },
    ...(showPrice ? [{ q: 'land.faq.price.q' as MessageKey, a: t('land.faq.price.a') }] : []),
    { q: 'land.faq.data.q', a: t('land.faq.data.a') },
  ];
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

  return (
    <div className="land">
      <header className={`land-hd${dark ? ' land-hd--dark' : ''}${home ? '' : ' land-hd--sub'}`}>
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
            <button key={m.k} type="button" className="land-nav__i" onClick={m.fn}>
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
          <button type="button" className="land-btn land-mmenu__cta" onClick={goSignup}>
            {t('land.cta')}
          </button>
        </div>
      )}

      {!home && <SignupMain onToast={setToast} />}
      {home && (
        <main className="land-main">
          <section className="land-hero">
            <div className="land-hero__bg" />
            <div className="land-hero__ov" />
            <div className="land-wrap land-hero__grid">
              <div className="land-hero__copy">
                <h1 className="land-h1">
                  <span>{t('land.h1a')}</span> <span>{t('land.h1b')}</span>
                </h1>
                <p className="land-hero__lead">{t('land.lead')}</p>
                <div className="land-hero__acts">
                  <button type="button" className="land-btn land-btn--white" onClick={goSignup}>
                    {t('land.cta')}
                  </button>
                  {showPrice && (
                    <a
                      {...linkProps(config.pricingPageLive, '/pricing')}
                      className="land-hero__price"
                    >
                      {t('land.seePrice')}
                    </a>
                  )}
                </div>
                <span className="land-hero__note">{t('land.noCard')}</span>
              </div>
              <div className="land-hero__shotwrap">
                <div className="land-hero__shot">
                  <img
                    src={heroPlan2x}
                    srcSet={`${heroPlan1x} 1007w, ${heroPlan2x} 2014w`}
                    sizes="(max-width: 759px) 100vw, 60vw"
                    width={2014}
                    height={1680}
                    alt={t('land.heroAlt')}
                    fetchPriority="high"
                    decoding="async"
                  />
                </div>
                <div className="land-hero__card land-hero__card--pod">
                  <span className="land-hero__cardt">
                    <span className="land-dot" />
                    {t('land.card1t')}
                  </span>
                  <span className="land-hero__cards">{t('land.card1s')}</span>
                </div>
                <div className="land-hero__card land-hero__card--sub">
                  <span className="land-hero__cardt">{t('land.card2t')}</span>
                  <span className="land-hero__cards">{t('land.card2s')}</span>
                </div>
              </div>
            </div>
            <div className="land-facts">
              <div className="land-wrap land-facts__row">
                {facts.map((f) => (
                  <span key={f} className="land-facts__i">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {worksWith.length > 0 && (
            <section className="land-with">
              <p className="land-wrap land-with__p">
                {t('land.worksWith', { list: joinList(worksWith, 'land.and') })}
              </p>
            </section>
          )}

          <section id="features" className="land-wrap land-sec">
            <div className="land-intro">
              <h2 className="land-h2">{t('land.day.title')}</h2>
              <p className="land-p">{t('land.day.sub')}</p>
            </div>
            <Step time="07:10" title={t('land.plan.t')} desc={t('land.plan.d')}>
              <Shot
                src1={tPlan1x}
                src2={tPlan2x}
                w={1198}
                h={1041}
                alt={t('land.plan.t')}
                max={600}
              />
            </Step>
            <Step time="07:40" title={t('land.sub.t')} desc={t('land.sub.d')}>
              <Shot src1={tSub1x} src2={tSub2x} w={1850} h={320} alt={t('land.sub.t')} />
            </Step>
            <Step time="17:00" title={t('land.bill.t')} desc={t('land.bill.d')}>
              <Shot src1={tBill1x} src2={tBill2x} w={1914} h={292} alt={t('land.bill.t')} />
            </Step>
          </section>

          <section className="land-feat">
            <div className="land-wrap land-feat__in">
              <div className="land-c84">
                <div className="land-settle">
                  <Shot
                    src1={fSettle1x}
                    src2={fSettle2x}
                    w={1920}
                    h={560}
                    alt={t('land.settle.alt')}
                  />
                  <span className="land-pin" style={{ left: '69.5%' }}>
                    1
                  </span>
                  <span className="land-pin" style={{ left: '77%' }}>
                    2
                  </span>
                  <span className="land-pin" style={{ left: '84.5%' }}>
                    3
                  </span>
                </div>
                <div className="land-feat__copy">
                  <h3 className="land-h3">{t('land.settle.t')}</h3>
                  <p className="land-p">{t('land.settle.d')}</p>
                  {(['land.settle.p1', 'land.settle.p2', 'land.settle.p3'] as MessageKey[]).map(
                    (k, i) => (
                      <div key={k} className="land-num">
                        <span className="land-num__n">{i + 1}</span>
                        <span className="land-num__t">{t(k)}</span>
                      </div>
                    ),
                  )}
                </div>
              </div>
              <div className="land-fdoc">
                <div className="land-c66 land-c66--end">
                  <h3 className="land-h3">{t('land.fdoc.t')}</h3>
                  <p className="land-p">{t('land.fdoc.d')}</p>
                </div>
                <div className="land-c66 land-c66--imgs">
                  <Shot
                    src1={fFdockpi1x}
                    src2={fFdockpi2x}
                    w={1220}
                    h={250}
                    alt={t('land.fdoc.altKpi')}
                  />
                  <Shot src1={fFdoc1x} src2={fFdoc2x} w={1180} h={560} alt={t('land.fdoc.alt')} />
                </div>
              </div>
            </div>
          </section>

          {showPrice && config.fromPrice && (
            <section className="land-wrap land-pricebar">
              <div className="land-pricebar__in">
                <p className="land-pricebar__p">
                  <b>{t('land.priceFrom', { price: config.fromPrice })}</b>
                  <span className="land-pricebar__dot"> · </span>
                  <span>{t('land.trialNoCard')}</span>
                </p>
                <a {...linkProps(config.pricingPageLive, '/pricing')} className="land-pricebar__a">
                  {t('land.allPrices')}
                </a>
              </div>
            </section>
          )}

          <section className="land-wrap land-faq">
            <h2 className="land-h2">{t('land.faq.title')}</h2>
            <div className="land-faq__list">
              {faqs.map((f, i) => {
                const open = faq === i;
                return (
                  <div key={f.q} className="land-faq__i">
                    <button
                      type="button"
                      className="land-faq__q"
                      aria-expanded={open}
                      onClick={() => setFaq(open ? -1 : i)}
                    >
                      <span style={{ flex: 1 }}>{t(f.q)}</span>
                      <span className="land-faq__sym">{open ? '−' : '+'}</span>
                    </button>
                    {open && <p className="land-faq__a">{f.a}</p>}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="land-band">
            <div className="land-band__ov" />
            <p className="land-wrap land-band__p">{t('land.band')}</p>
          </section>

          <section className="land-final">
            <div className="land-wrap land-final__in">
              <p className="land-final__p">{t('land.final')}</p>
              <button type="button" className="land-btn" onClick={goSignup}>
                {t('land.cta')}
              </button>
            </div>
          </section>
        </main>
      )}

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
              href="#features"
              onClick={(e) => {
                e.preventDefault();
                toFeatures();
              }}
            >
              {t('land.nav.features')}
            </a>
            {showPrice && (
              <a {...linkProps(config.pricingPageLive, '/pricing')}>{t('land.nav.pricing')}</a>
            )}
            <a {...linkProps(config.signupLive, config.signupPath)}>{t('land.foot.trial')}</a>
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

/** หนึ่งช่วงเวลาบนเส้น "เช้าวันหนึ่งของฝ่ายจัดรถ" */
function Step({
  time,
  title,
  desc,
  children,
}: {
  time: string;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <div className="land-tl">
      <div className="land-tl__time">
        <span>{time}</span>
      </div>
      <div className="land-tl__body">
        <span className="land-tl__dot" />
        <div className="land-tl__copy">
          <h3 className="land-tl__t">{title}</h3>
          <p className="land-p">{desc}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/** กรอบภาพหน้าจอ (ขอบ + เงา + เลื่อนแนวนอนบนมือถือ) — ตามต้นแบบ */
function Shot({
  src1,
  src2,
  w,
  h,
  alt,
  max,
}: {
  src1: string;
  src2: string;
  w: number;
  h: number;
  alt: string;
  max?: number;
}) {
  return (
    <div className="land-shot" style={max ? { maxWidth: max } : undefined}>
      <img
        src={src2}
        srcSet={`${src1} ${Math.round(w / 2)}w, ${src2} ${w}w`}
        sizes="(max-width: 759px) 600px, 1136px"
        width={w}
        height={h}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}
