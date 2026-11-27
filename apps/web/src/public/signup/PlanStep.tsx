import { estimatePlanCharge, planForVehicles } from '@tms/domain';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/core';
import type { MessageKey } from '../../i18n/th';
import { fmtMoney, fmtPrice } from '../landing/plans';
import {
  signupApi,
  SignupError,
  signupHandoff,
  signupPkce,
  type SignupCompleteResult,
  type SignupPlan,
  type SignupPlans,
  type SignupSession,
} from './signupApi';

/**
 * สมัครขั้น 3 "เลือกแพ็กเกจ" (P1-ST2-T05) — `design/prototype/TMS Signup.dc.html` view `signup` (su.s3)
 * การ์ดแพ็กเกจ (วงกลมเลือก + ชื่อ + คำอธิบาย + ราคาหลังทดลอง) + บรรทัดประมาณการ · ปุ่ม "เริ่มใช้งาน" / "นัด demo"
 *
 * ต่างจากต้นแบบ [DECISION — lead 28 พ.ย. 2569, ย้อนได้] (spec/12 §3 แถว "สมัครขั้น 3"):
 * - รายการแพ็กเกจ/ชื่อ/ราคา/จำนวนวันทดลองจาก API (`GET …/session/plans`, `trial.days`) แทนค่าในต้นแบบ — ชื่อแพ็กเกจตาม
 *   แคตตาล็อก (R-06) จึงเว้นวรรคหลัง "ทดลองใช้" · คำอธิบายใต้ชื่อใช้ข้อความต้นแบบเฉพาะรหัส start/std/ent (แพ็กเกจอื่นไม่มีคำอธิบาย)
 * - ยังไม่เปิดราคาสาธารณะ (`pricing.publicVisible = false` — D-40) → ไม่แสดงราคา/บรรทัดประมาณการ
 * - ค่าเริ่มต้นที่เลือก = แพ็กเกจที่ช่วงจำนวนรถครอบจำนวนรถที่กรอก (planForVehicles — แทน "เกิน 80 คัน → องค์กร" ของต้นแบบ)
 */
const DESC: Record<string, MessageKey> = {
  std: 'su.s3.d.std',
  start: 'su.s3.d.start',
  ent: 'su.s3.d.ent',
};

export function usePlanStep({
  session,
  active,
  onDone,
  onToast,
  problemText,
}: {
  session: SignupSession | null;
  active: boolean;
  onDone: (r: SignupCompleteResult) => void;
  onToast: (m: string) => void;
  problemText: (e: unknown) => string;
}): { body: ReactNode; next: () => Promise<void>; nextLabel: string; busy: boolean; days: number } {
  const { t } = useI18n();
  const [data, setData] = useState<SignupPlans | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const own = session?.company?.fleetSizeOwn ?? 0;
  const sub = session?.company?.fleetSizeSubcon ?? 0;
  const total = Math.max(1, own + sub);

  useEffect(() => {
    if (!active || data) return;
    signupApi
      .plans()
      .then((d) => {
        setData(d);
        const pick =
          d.plans.find((p) => p.code === session?.planCode) ??
          planForVehicles(d.plans, total) ??
          d.plans.find((p) => p.code === 'std') ??
          d.plans[0];
        setSel(pick?.code ?? null);
      })
      .catch((e) => onToast(problemText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const plans = data?.plans ?? [];
  const cur = plans.find((p) => p.code === sel) ?? null;
  const days = data?.trialDays ?? 30;

  const title = (p: SignupPlan) =>
    p.isContactSales
      ? t('su.s3.demoT', { name: p.nameTh })
      : t('su.s3.trialT', { name: p.nameTh, days });
  const price = (p: SignupPlan) =>
    p.isContactSales
      ? t('su.s3.contact')
      : p.pricePerVehicleMonthly
        ? t('su.s3.price', { price: fmtPrice(p.pricePerVehicleMonthly) })
        : '';
  const est = (() => {
    if (!cur) return '';
    if (cur.isContactSales) return t('su.s3.estDemo', { n: total });
    const e = data?.pricesVisible ? estimatePlanCharge(cur, total, 'monthly') : null;
    return e ? t('su.s3.est', { n: total, amount: fmtMoney(e.monthly) }) : '';
  })();

  async function next() {
    if (!cur || busy) return;
    setBusy(true);
    try {
      const { verifier, challenge } = await signupPkce();
      const r = await signupApi.complete(cur.code, challenge);
      if (r.signIn) signupHandoff.set({ signIn: r.signIn, verifier, at: Date.now() });
      onDone(r);
    } catch (e) {
      const p = e instanceof SignupError ? e.problem : null;
      onToast(p?.code === 'account_exists' ? t('su.err.exists') : problemText(e));
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <>
      <div className="su-head">
        <h1>{t('su.s3.title')}</h1>
        <span>{t('su.s3.sub', { days })}</span>
      </div>
      <div className="su-plans" role="radiogroup" aria-label={t('su.s3.title')}>
        {plans.map((p) => {
          const on = p.code === sel;
          const d = DESC[p.code];
          return (
            <button
              key={p.code}
              type="button"
              role="radio"
              aria-checked={on}
              className={`su-plan${on ? ' is-on' : ''}`}
              onClick={() => setSel(p.code)}
            >
              <span className="su-plan__ring" aria-hidden="true">
                <span className="su-plan__dot" />
              </span>
              <div className="su-plan__txt">
                <span className="su-plan__t">{title(p)}</span>
                {d && <span className="su-plan__d">{t(d)}</span>}
              </div>
              <span className="su-plan__price">{price(p)}</span>
            </button>
          );
        })}
      </div>
      {est && <span className="su-plan__est">{est}</span>}
    </>
  );
  return {
    body,
    next,
    nextLabel: cur?.isContactSales ? t('su.s3.demo') : t('su.s3.start'),
    busy: busy || !cur,
    days,
  };
}
