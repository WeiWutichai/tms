import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/core';
import type { MessageKey } from '../../i18n/th';
import { ACCOUNTING_ORDER, landingConfig, WORKS_WITH_ORDER, type LandingConfig } from './config';
import { useLandingMeta } from './meta';
import { entryPlan, fmtPrice, usePublicPlans, type PublicPlans } from './plans';
import { landingNav, PublicShell, usePublicActions } from './PublicShell';
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
 * - ราคา (เมนู, "ดูราคา", แถบราคา, FAQ คิดเงิน) ซ่อนเมื่อ `pricing.publicVisible = false` (D-40) — P1-ST2-T02: อ่านจาก
 *   `GET /v1/public/plans` (404 = ปิด) · "เริ่ม ฿…" = ราคาต่อรถของแพ็กเกจแรกที่มีราคา (PLT-002 — ไม่พิมพ์ตัวเลขในโค้ด)
 * - รูป hero/ภาพคั่นจาก Unsplash (ผู้ให้บริการภายนอก) → ใช้สีพื้นของต้นแบบตอนไม่มีรูป ไม่แสดงป้าย placeholder
 */
export { landingNav };

export function LandingPage({
  config = landingConfig,
  plans,
}: {
  config?: LandingConfig;
  /** ส่งมาเอง (test) — ไม่ส่ง = โหลดจาก `GET /v1/public/plans` · null = ปิดหน้าราคา */
  plans?: PublicPlans | null;
}) {
  const { t } = useI18n();
  const [faq, setFaq] = useState(0);
  const [toast, setToast] = useState('');
  const fetched = usePublicPlans(plans === undefined);
  const data = plans !== undefined ? plans : fetched.state;
  useLandingMeta(t('land.meta.title'), t('land.lead'));
  const { goSignup } = usePublicActions(config, setToast);
  const toFeatures = () => {
    const el = document.getElementById('features');
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 72);
  };

  // มาจากหน้าอื่นด้วย /home#features (เมนู "ฟีเจอร์" ของหน้าราคา)
  useEffect(() => {
    if (window.location.hash === '#features') toFeatures();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ครั้งเดียวตอนเปิดหน้า
  }, []);

  const enabled = new Set(config.integrations);
  const joinList = (names: string[], word: MessageKey) =>
    names.length < 2
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} ${t(word)} ${names[names.length - 1]}`;
  const worksWith = WORKS_WITH_ORDER.filter((n) => enabled.has(n));
  const accounting = ACCOUNTING_ORDER.filter((n) => enabled.has(n));
  /** `pricing.publicVisible` (ไม่ใช่ 404) — กำลังโหลด/โหลดไม่สำเร็จ = ซ่อน */
  const pub = data && data !== 'error' ? data : null;
  const showPrice = !!pub;
  const entry = pub ? entryPlan(pub) : undefined;
  const fromPrice = entry?.pricePerVehicleMonthly ? fmtPrice(entry.pricePerVehicleMonthly) : '';

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

  return (
    <PublicShell
      page="home"
      config={config}
      showPrice={showPrice}
      toast={toast}
      setToast={setToast}
      onFeatures={toFeatures}
    >
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
                  <a href="/pricing" className="land-hero__price">
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

        {showPrice && fromPrice && (
          <section className="land-wrap land-pricebar">
            <div className="land-pricebar__in">
              <p className="land-pricebar__p">
                <b>{t('land.priceFrom', { price: fromPrice })}</b>
                <span className="land-pricebar__dot"> · </span>
                <span>{t('land.trialNoCard')}</span>
              </p>
              <a href="/pricing" className="land-pricebar__a">
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
    </PublicShell>
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
