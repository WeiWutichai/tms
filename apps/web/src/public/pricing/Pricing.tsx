import {
  decimalFromSatang,
  estimatePlanCharge,
  perVehicleMonthly,
  planForVehicles,
  satangFromDecimal,
  type BillingCycle,
} from '@tms/domain';
import { BadgeCheck, Check, Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/core';
import type { MessageKey } from '../../i18n/th';
import { ACCOUNTING_ORDER, landingConfig, type LandingConfig } from '../landing/config';
import { useLandingMeta } from '../landing/meta';
import {
  fmtInt,
  fmtMoney,
  fmtPct,
  fmtPrice,
  usePublicPlans,
  type PublicFeature,
  type PublicPlan,
  type PublicPlans,
} from '../landing/plans';
import { landingNav, PublicShell, usePublicActions } from '../landing/PublicShell';
import '../landing/landing.css';
import './pricing.css';

/**
 * หน้าราคาสาธารณะ (P1-ST2-T02) — `design/prototype/TMS Signup.dc.html` view `pricing`
 * ข้อมูลทั้งหมดจาก `GET /v1/public/plans` (PLT-002) · ตัวคำนวณใช้ `estimatePlanCharge` ของ @tms/domain
 * (ตัวเดียวกับประมาณการบิล P1-ST3-T01) · ปิดหน้าราคา (`pricing.publicVisible = false` → 404) = กลับ /home
 *
 * ส่วนที่ต่างจากต้นแบบ [DECISION — lead 27 พ.ย. 2569, ย้อนได้] — spec/12 §3 แถว "หน้าราคาสาธารณะ":
 * - โมเดลราคาตาม docs/02 §2 (tier ตามจำนวนรถ + ขั้นต่ำ + รายปี −%) แทน plans.js (โควตารถ + รถเกินโควตา ฿450, รายปีลด 2 เดือน)
 *   → การ์ด: ช่วงจำนวนรถ / ขั้นต่ำ แทน "รถ active 20 คัน" · ป้ายรายปี "ลด {%}" แทน "ลด 2 เดือน"
 *   → ตัวคำนวณ: เลือกแพ็กเกจตามช่วงรถอัตโนมัติ (กดแพ็กเกจ = ย้ายจำนวนรถเข้าช่วง) · บรรทัดขั้นต่ำ/ส่วนลดแทนรถเกินโควตา
 * - ตัวคำนวณไม่แสดง "VAT 7%" / "รวม VAT" (spec/01 §2 ข้อ 3: ระบุ "ราคายังไม่รวม VAT" · TMS ไม่คำนวณภาษีค่าบริการ — R-03)
 * - แถบ "Add-on" ราคาซื้อเพิ่ม ไม่แสดง (ยังไม่มีข้อมูลราคา add-on ใน PlanVersion — ห้ามพิมพ์ตัวเลข PLT-002)
 * - การ์ด: รายการจุดเด่นสร้างจาก matrix (ไม่มี AI credit / พื้นที่ POD — นอกแคตตาล็อก) · ป้าย "ราคาตั้งต้น — ยังไม่ประกาศ" เมื่อ provisional
 * - FAQ: ข้อความภาษี/แอปคนขับ/Open API ตาม R-02, R-11 (เหมือน landing) · ช่องทางติดต่อจาก config · วันเก็บข้อมูล/น้ำหนักรถร่วมจากค่าตั้ง
 * - มือถือ (< 760 px): การ์ด/ตัวคำนวณ/FAQ คอลัมน์เดียว ตารางเลื่อนแนวนอน (ต้นแบบไม่มี layout มือถือของหน้านี้)
 */
export function PricingPage({
  config = landingConfig,
  plans,
}: {
  config?: LandingConfig;
  /** ส่งมาเอง (test) — ไม่ส่ง = โหลดจาก API */
  plans?: PublicPlans | null;
}) {
  const { t } = useI18n();
  const [toast, setToast] = useState('');
  const fetched = usePublicPlans(plans === undefined);
  const data = plans !== undefined ? plans : fetched.state;
  useLandingMeta(t('land.price.metaTitle'), t('land.price.lead'), '/pricing');

  // ปิดหน้าราคา (404) → กลับหน้าแรก — ไม่แสดงราคา/ลิงก์ใด ๆ (D-40)
  useEffect(() => {
    if (data === null) landingNav.go('/home');
  }, [data]);

  return (
    <PublicShell
      page="pricing"
      config={config}
      showPrice={!!data && data !== 'error'}
      toast={toast}
      setToast={setToast}
    >
      {data && data !== 'error' ? (
        <PricingBody data={data} config={config} setToast={setToast} />
      ) : (
        <main className="prc">
          {data === 'error' ? (
            <div className="prc-state" role="alert">
              <span>{t('land.price.error')}</span>
              <button type="button" className="prc-cta prc-cta--sec" onClick={fetched.reload}>
                {t('land.price.retry')}
              </button>
            </div>
          ) : (
            <div className="prc-state" aria-busy="true">
              {t('land.price.loading')}
            </div>
          )}
        </main>
      )}
    </PublicShell>
  );
}

const name = (p: { nameTh: string; nameEn: string | null }, lang: string) =>
  lang === 'th' ? p.nameTh : (p.nameEn ?? p.nameTh);

function PricingBody({
  data,
  config,
  setToast,
}: {
  data: PublicPlans;
  config: LandingConfig;
  setToast: (s: string) => void;
}) {
  const { t, lang } = useI18n();
  const { contactText, goSignup } = usePublicActions(config, setToast);
  const plans = data.plans;
  const [yearly, setYearly] = useState(false);
  const [n, setN] = useState('24');
  const [faq, setFaq] = useState(0);
  const [sel, setSel] = useState<string>(
    () => (planForVehicles(plans, 24) ?? plans.find((p) => p.badge) ?? plans[0])?.code ?? '',
  );
  const cycle: BillingCycle = yearly ? 'annual' : 'monthly';
  const baht = (d: string) => t('land.price.baht', { amount: fmtMoney(d) });
  const bahtNeg = (d: string) => t('land.price.bahtNeg', { amount: fmtMoney(d) });
  const priced = plans.filter((p) => p.pricePerVehicleMonthly !== null);
  const pct = (d: string) => satangFromDecimal(d);
  const maxAnnual = priced.reduce(
    (m, p) => (pct(p.annualDiscountPct) > pct(m) ? p.annualDiscountPct : m),
    '0',
  );
  const annualTag = pct(maxAnnual) > 0n ? fmtPct(maxAnnual) : '';
  const usersCol = data.features.find((f) => f.key === 'users');

  // ───── การ์ดแพ็กเกจ ─────
  const plusList = (i: number) => {
    const has = (f: PublicFeature, j: number) => f.cells[j]?.kind === 'yes';
    return data.features
      .filter((f) => !f.isBasic && f.type === 'boolean' && has(f, i) && (i === 0 || !has(f, i - 1)))
      .map((f) => name(f, lang));
  };
  const limitRows = data.features.filter((f) => !f.isBasic && f.type === 'limit');
  const cellText = (c: PublicFeature['cells'][number]) =>
    c.kind === 'limit'
      ? fmtInt(c.limit ?? 0)
      : c.kind === 'unlimited'
        ? t('land.price.unlimited')
        : c.kind === 'addon'
          ? t('land.price.cmp.addon')
          : '';
  const cards = plans.map((p, i) => {
    const price = perVehicleMonthly(p, cycle);
    const plus = plusList(i);
    const pts = [
      ...(i === 0
        ? [{ t: t('land.price.ptBasic'), no: false }]
        : plus.length
          ? [{ t: t('land.price.ptPlus', { list: plus.join(', ') }), no: false }]
          : []),
      ...limitRows.map((f) => {
        const c = f.cells[i]!;
        return c.kind === 'no'
          ? { t: name(f, lang), no: true }
          : { t: `${name(f, lang)}: ${cellText(c)}`, no: false };
      }),
    ];
    const unlimitedUsers = usersCol?.cells[i]?.kind === 'unlimited';
    const yearPerVehicle = price && decimalFromSatang(satangFromDecimal(price) * 12n);
    const note = !price
      ? t('land.price.noteSales')
      : yearly && pct(p.annualDiscountPct) > 0n
        ? t('land.price.noteAnnual', {
            year: fmtPrice(yearPerVehicle!),
            pct: fmtPct(p.annualDiscountPct),
          })
        : [
            p.minimumMonthly && t('land.price.noteMin', { min: fmtPrice(p.minimumMonthly) }),
            unlimitedUsers && t('land.price.users'),
          ]
            .filter(Boolean)
            .join(' · ');
    return {
      p,
      price,
      note,
      pts,
      blurb:
        p.vehicleMax === null
          ? t('land.price.rangeOpen', { min: fmtInt(p.vehicleMin) })
          : t('land.price.range', { min: fmtInt(p.vehicleMin), max: fmtInt(p.vehicleMax) }),
      cta: () => {
        if (!price || p.isContactSales) {
          setToast(contactText || t('land.price.salesSoon'));
          return;
        }
        if (config.signupLive)
          landingNav.go(`${config.signupPath}?plan=${encodeURIComponent(p.code)}`);
        else goSignup();
      },
    };
  });

  // ───── ตัวคำนวณ (domain estimatePlanCharge — ตัวเดียวกับประมาณการบิล) ─────
  const count = Math.max(1, parseInt(n, 10) || 1);
  const cp = plans.find((p) => p.code === sel) ?? plans[0]!;
  const est = estimatePlanCharge(cp, count, cycle);
  const onN = (v: string) => {
    const s = v.replace(/\D/g, '').slice(0, 4);
    setN(s);
    const k = Math.max(1, parseInt(s, 10) || 1);
    const fit = planForVehicles(plans, k);
    if (fit) setSel(fit.code);
  };
  const onPlan = (p: PublicPlan) => {
    setSel(p.code);
    // ช่วงจำนวนรถของ tier (docs/02 §2) — ย้ายจำนวนรถเข้าช่วงของแพ็กเกจที่เลือก
    if (count < p.vehicleMin) setN(String(p.vehicleMin));
    else if (p.vehicleMax !== null && count > p.vehicleMax) setN(String(p.vehicleMax));
  };
  const lines: Array<{ k: string; v: string }> = est
    ? [
        {
          k: t('land.price.calc.base', { n: fmtInt(count), price: fmtPrice(est.pricePerVehicle) }),
          v: baht(est.baseMonthly),
        },
        ...(est.volumeDiscountMonthly !== '0.00'
          ? [{ k: t('land.price.calc.volume'), v: bahtNeg(est.volumeDiscountMonthly) }]
          : []),
        ...(est.minimumApplied && est.minimumMonthly
          ? [{ k: t('land.price.calc.minimum'), v: baht(est.minimumMonthly) }]
          : []),
        ...(est.annualDiscountMonthly !== '0.00'
          ? [
              {
                k: t('land.price.calc.annualDisc', { pct: fmtPct(est.annualDiscountPct) }),
                v: bahtNeg(est.annualDiscountMonthly),
              },
            ]
          : []),
        {
          k: t(yearly ? 'land.price.calc.yearAnnual' : 'land.price.calc.yearMonthly'),
          v: baht(est.yearly),
        },
      ]
    : [{ k: t('land.price.calc.sales'), v: '' }];

  // ───── ตารางเปรียบเทียบ (เซลล์จาก matrix) ─────
  const cats = [...new Set(data.features.map((f) => f.category))].map((c) => ({
    t: c,
    rows: data.features.filter((f) => f.category === c),
  }));

  // ───── FAQ ─────
  const accounting = ACCOUNTING_ORDER.filter((x) => config.integrations.includes(x));
  const joinList = (names: string[]) =>
    names.length < 2
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} ${t('land.and')} ${names[names.length - 1]}`;
  const weight = satangFromDecimal(data.subconWeight); // 1.00 → 100n
  const faqs: Array<{ q: MessageKey; a: string }> = [
    { q: 'land.price.faq.bill.q', a: t('land.price.faq.bill.a') },
    {
      q: 'land.price.faq.sub.q',
      a:
        weight >= 100n
          ? t('land.price.faq.sub.a')
          : weight <= 0n
            ? t('land.price.faq.sub.aNone')
            : t('land.price.faq.sub.aWeight', {
                pct: fmtPct(decimalFromSatang(satangFromDecimal(data.subconWeight) * 100n)),
              }),
    },
    { q: 'land.price.faq.cancel.q', a: t('land.price.faq.cancel.a', { days: data.retentionDays }) },
    { q: 'land.price.faq.data.q', a: t('land.price.faq.data.a') },
    {
      q: 'land.price.faq.acc.q',
      a: accounting.length
        ? t('land.price.faq.acc.a', { list: joinList(accounting) })
        : t('land.price.faq.acc.aNone'),
    },
  ];
  const rules = [
    t('land.price.rule.contract'),
    t('land.price.rule.basic'),
    t('land.price.rule.active'),
    ...(annualTag ? [t('land.price.rule.annual', { pct: annualTag })] : []),
  ];

  return (
    <main className="prc">
      <section className="prc-hero">
        <div className="prc-badges">
          <span className="prc-badge">
            <BadgeCheck size={14} strokeWidth={2} aria-hidden="true" />
            {t('land.price.trial', { days: data.trialDays })}
          </span>
          {data.provisional && (
            <span className="prc-badge prc-badge--warn">{t('land.price.provisional')}</span>
          )}
        </div>
        <h1 className="prc-h1">{t('land.price.h1')}</h1>
        <p className="prc-lead">{t('land.price.lead')}</p>
        <div className="prc-cycle" role="group">
          {(
            [
              [false, 'land.price.monthly'],
              [true, 'land.price.annual'],
            ] as const
          ).map(([y, k]) => (
            <button
              key={k}
              type="button"
              className={`prc-cycle__i${yearly === y ? ' is-on' : ''}`}
              aria-pressed={yearly === y}
              onClick={() => setYearly(y)}
            >
              {t(k)}
              {y && annualTag && (
                <span className="prc-tag">{t('land.price.annualTag', { pct: annualTag })}</span>
              )}
            </button>
          ))}
        </div>
      </section>

      <section className="prc-cards" style={{ ['--n' as string]: plans.length }}>
        {cards.map((c) => {
          const pop = !!c.p.badge;
          return (
            <div
              key={c.p.code}
              className={`prc-card${pop ? ' prc-card--pop' : ''}`}
              data-testid={`plan-${c.p.code}`}
            >
              {pop && <span className="prc-card__badge">{c.p.badge}</span>}
              <div className="prc-card__head">
                <span className="prc-card__name">{name(c.p, lang)}</span>
                <span className="prc-card__blurb">{c.blurb}</span>
              </div>
              <div className="prc-card__price">
                <span className="prc-card__amt">
                  {c.price
                    ? t('land.price.baht', { amount: fmtPrice(c.price) })
                    : t('land.price.contactSales')}
                </span>
                {c.price && <span className="prc-card__unit">{t('land.price.unit')}</span>}
              </div>
              <span className="prc-card__note">{c.note}</span>
              <button
                type="button"
                className={`prc-cta${pop ? '' : ' prc-cta--sec'}`}
                onClick={c.cta}
              >
                {c.price
                  ? t('land.price.startTrial', { days: data.trialDays })
                  : t('land.price.contactSales')}
              </button>
              <div className="prc-card__hr" />
              <div className="prc-card__pts">
                {c.pts.map((x) => (
                  <span key={x.t} className="prc-pt">
                    {x.no ? (
                      <Minus size={16} className="prc-pt__ic prc-pt__ic--no" aria-hidden="true" />
                    ) : (
                      <Check size={16} className="prc-pt__ic" aria-hidden="true" />
                    )}
                    <span className={x.no ? 'prc-pt__t prc-pt__t--no' : 'prc-pt__t'}>
                      {x.t}
                      {x.no && <span className="prc-pt__nl">{t('land.price.ptNo')}</span>}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section className="prc-box prc-calc" aria-labelledby="prc-calc-h">
        <div className="prc-calc__in">
          <h2 id="prc-calc-h" className="prc-h2">
            {t('land.price.calc.title')}
          </h2>
          <label className="prc-calc__lbl">
            <span className="prc-lbl">{t('land.price.calc.n')}</span>
            <div className="prc-calc__row">
              <input
                type="range"
                min={1}
                max={150}
                value={count}
                onChange={(e) => onN(e.target.value)}
                className="prc-range"
                aria-label={t('land.price.calc.n')}
              />
              <input
                value={n}
                onChange={(e) => onN(e.target.value)}
                inputMode="numeric"
                className="prc-num"
                aria-label={t('land.price.calc.n')}
              />
            </div>
          </label>
          <div className="prc-chips">
            {plans.map((p) => (
              <button
                key={p.code}
                type="button"
                className={`prc-chip${p.code === cp.code ? ' is-on' : ''}`}
                aria-pressed={p.code === cp.code}
                onClick={() => onPlan(p)}
              >
                {name(p, lang)}
              </button>
            ))}
          </div>
        </div>
        <div className="prc-calc__out" aria-live="polite" data-testid="calc-result">
          <span className="prc-lbl">
            {t(yearly ? 'land.price.calc.lblAnnual' : 'land.price.calc.lbl', {
              name: name(cp, lang),
              n: fmtInt(count),
            })}
          </span>
          <span className="prc-calc__month" data-testid="calc-month">
            {est
              ? t('land.price.calc.month', { amount: fmtMoney(est.monthly) })
              : t('land.price.contactSales')}
          </span>
          {est && <span className="prc-calc__sub">{t('land.price.calc.noVat')}</span>}
          {lines.map((l) => (
            <div key={l.k} className="prc-calc__line">
              <span>{l.k}</span>
              <span className="prc-tab">{l.v}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="prc-box prc-cmp" aria-labelledby="prc-cmp-h">
        <div className="prc-cmp__hd">
          <h2 id="prc-cmp-h" className="prc-h2">
            {t('land.price.cmp.title')}
          </h2>
        </div>
        <div className="prc-cmp__wrap">
          <table className="prc-tbl">
            <thead>
              <tr>
                <th className="prc-tbl__f">{t('land.price.cmp.feature')}</th>
                {plans.map((p) => (
                  <th key={p.code} className="prc-tbl__p">
                    {name(p, lang)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => [
                <tr key={`c-${c.t}`}>
                  <td colSpan={plans.length + 1} className="prc-tbl__cat">
                    {c.t}
                  </td>
                </tr>,
                ...c.rows.map((f) => (
                  <tr key={f.key} data-testid={`row-${f.key}`}>
                    <td className="prc-tbl__l">{name(f, lang)}</td>
                    {f.cells.map((x, i) => (
                      <td key={plans[i]?.code ?? i} className="prc-tbl__c">
                        {x.kind === 'yes' ? (
                          <Check size={18} className="prc-yes" aria-label="✓" role="img" />
                        ) : x.kind === 'no' ? (
                          <span className="prc-no">—</span>
                        ) : x.kind === 'addon' ? (
                          <span className="prc-add">{t('land.price.cmp.addon')}</span>
                        ) : (
                          <span>{cellText(x)}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      </section>

      <section className="prc-faq">
        <div className="prc-faq__side">
          <h2 className="prc-h2">{t('land.faq.title')}</h2>
          {contactText && (
            <span className="prc-faq__help">
              {t('land.price.faq.help', { contact: contactText })}
            </span>
          )}
          {rules.map((r) => (
            <span key={r} className="prc-rule">
              <Check size={16} className="prc-pt__ic" aria-hidden="true" />
              {r}
            </span>
          ))}
        </div>
        <div className="prc-faq__list">
          {faqs.map((f, i) => {
            const open = faq === i;
            return (
              <div key={f.q}>
                <button
                  type="button"
                  className="prc-faq__q"
                  aria-expanded={open}
                  onClick={() => setFaq(open ? -1 : i)}
                >
                  <span style={{ flex: 1 }}>{t(f.q)}</span>
                  {open ? (
                    <Minus size={18} className="prc-faq__ic" aria-hidden="true" />
                  ) : (
                    <Plus size={18} className="prc-faq__ic" aria-hidden="true" />
                  )}
                </button>
                {open && <div className="prc-faq__a">{f.a}</div>}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
