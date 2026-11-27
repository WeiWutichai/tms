import { Building2, Check, Info, Rocket, RotateCcw, ShieldCheck, User } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/core';
import type { MessageKey } from '../../i18n/th';
import { signupApi, SignupError, signupToken, type SignupSession } from './signupApi';
import './signup.css';

/**
 * หน้าสมัคร ขั้น 1 "สร้างบัญชี" (P1-ST2-T03) — `design/prototype/TMS Signup.dc.html` view `signup` (su.s1 / su.otp)
 * ขั้น 2–3 = P1-ST2-T04/T05: หลังยืนยันแสดง stepper ขั้น 2 + หัวข้อ "ข้อมูลบริษัท" ของต้นแบบ และแจ้งว่ายังไม่เปิด
 *
 * ต่างจากต้นแบบ [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (spec/12 §3 แถว "สมัครขั้น 1"):
 * - ไม่มีปุ่ม "สมัครด้วย Google" + เส้น "หรือกรอกข้อมูล" (R-08 — Google sign-in หลังเฟส 1)
 * - OTP ส่งทางอีเมลจนกว่า X-04 → ข้อความ "ไปที่มือถือ"/"ยืนยันเบอร์มือถือ" ใช้ฉบับอีเมล · คำใบ้ "ใช้รับรหัส OTP" ใต้เบอร์ซ่อน
 * - รหัสผ่านตามนโยบาย ST1-T02 (≥ 12 ตัว) แทน "8 ตัว มีตัวเลข" · ผิด 5 ครั้งล็อก 15 นาที แทน 3 ครั้ง (spec/01 §2)
 * - อีเมลฟรี (gmail/hotmail) ไม่ถูกปฏิเสธ — spec ตรวจแค่รูปแบบ · คงคำใบ้ของต้นแบบไว้เป็นคำแนะนำ
 * - จอแคบ (< 760 px — จุดตัด `narrow` ของต้นแบบ) วางแผงขวาใต้ฟอร์ม และ padding 20 px (ต้นแบบไม่มีแบบมือถือของหน้านี้)
 * - ด่านกันบอท (Turnstile) ยังไม่มี widget — รอ site key X-11 (API ตั้ง `BOT_PROTECTION_PROVIDER=none`)
 */
const env = import.meta.env as Record<string, string | undefined>;
/** ช่องทาง OTP ก่อนเริ่ม (หลังเริ่มใช้ค่าจาก API) — ตรงกับ `OTP_CHANNEL` ของ API (ค่าเริ่ม email จนกว่า X-04) */
const DEFAULT_CHANNEL = env.VITE_OTP_CHANNEL === 'sms' ? 'sms' : 'email';

type FieldKey = 'name' | 'email' | 'phone' | 'pw';
type Errs = Partial<Record<FieldKey, ReactNode>>;

const secondsUntil = (iso: string | null | undefined) =>
  iso ? Math.max(0, Math.min(60, Math.ceil((Date.parse(iso) - Date.now()) / 1000))) : 0;

export function SignupMain({ onToast }: { onToast: (m: string) => void }) {
  const { t, lang } = useI18n();
  const [session, setSession] = useState<SignupSession | null>(null);
  const [loading, setLoading] = useState(() => !!signupToken.get());
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ name: '', email: '', phone: '', pw: '' });
  const [errs, setErrs] = useState<Errs>({});
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [sec, setSec] = useState(0);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const startTimer = (n: number) => {
    window.clearInterval(timer.current);
    setSec(n);
    if (n <= 0) return;
    timer.current = window.setInterval(
      () =>
        setSec((z) => {
          if (z <= 1) {
            window.clearInterval(timer.current);
            return 0;
          }
          return z - 1;
        }),
      1000,
    );
  };
  useEffect(() => () => window.clearInterval(timer.current), []);

  const adopt = (s: SignupSession) => {
    setSession(s);
    setF((z) => ({
      ...z,
      name: z.name || s.name,
      email: z.email || s.email,
      phone: z.phone || s.mobile.replace(/^\+66/, ''),
    }));
    startTimer(secondsUntil(s.otp?.resendAvailableAt));
  };

  // กลับมาทำต่อ (รีเฟรช / login ด้วยอีเมลของการสมัคร) — token ใน sessionStorage
  useEffect(() => {
    if (!signupToken.get()) return;
    signupApi
      .get()
      .then((s) => {
        adopt(s);
        if (s.otp?.lockedUntil)
          setCodeErr(lockedText((Date.parse(s.otp.lockedUntil) - Date.now()) / 1000));
      })
      .catch(() => signupToken.clear())
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = session?.step ?? 1;
  const otpSent = !!session && session.status === 'account_pending_otp' && !editing;
  const channel = session?.otp?.channel ?? DEFAULT_CHANNEL;
  const sms = channel === 'sms';

  const loginLink = (k: MessageKey) => (
    <a href="/login" className="su-link">
      {t(k)}
    </a>
  );
  /** ล็อกจากใส่รหัสผิด 5 ครั้ง — บอกเวลาที่เหลือจาก Retry-After (หรือ lockedUntil) */
  const lockedText = (seconds: number | undefined) =>
    seconds && seconds > 0
      ? t('su.otp.locked', { n: Math.max(1, Math.ceil(seconds / 60)) })
      : t('problem.otp_locked');
  const problemText = (e: unknown) => {
    const p = e instanceof SignupError ? e.problem : { code: 'internal_error' };
    return t(`problem.${p.code}` as MessageKey);
  };

  const validate = (): Errs => {
    const er: Errs = {};
    if (f.name.trim().length < 3) er.name = t('su.err.name');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f.email.trim())) er.email = t('su.err.email');
    if (f.phone.replace(/\D/g, '').length !== 9) er.phone = t('su.err.phone');
    if (f.pw.length < 12) er.pw = t('su.f.pwRule');
    return er;
  };

  async function requestOtp() {
    const er = validate();
    setErrs(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const r = await signupApi.start({
        name: f.name.trim(),
        email: f.email.trim(),
        mobile: `+66${f.phone.replace(/\D/g, '')}`,
        password: f.pw,
        locale: lang === 'en' ? 'en' : 'th',
      });
      signupToken.set(r.token);
      setEditing(false);
      setCode('');
      setCodeErr('');
      adopt(r.session);
      onToast(t('su.toast.sent', { to: r.session.otp?.sentTo ?? f.email.trim() }));
    } catch (e) {
      const p = e instanceof SignupError ? e.problem : null;
      if (p?.code === 'account_exists')
        setErrs({
          email: (
            <>
              {t('su.err.exists')} {loginLink('su.err.loginLink')}
            </>
          ),
        });
      else if (p?.code === 'signup_in_progress')
        setErrs({
          email: (
            <>
              {t('su.err.inProgress')} {loginLink('su.err.continueLink')}
            </>
          ),
        });
      else if (p?.code === 'validation_failed' && p.errors?.length) {
        const next: Errs = {};
        for (const x of p.errors) {
          if (x.field === 'password')
            next.pw = x.code === 'password_breached' ? t('su.err.pwBreached') : t('su.f.pwRule');
          else if (x.field === 'mobile') next.phone = t('su.err.phone');
          else if (x.field === 'email') next.email = t('su.err.email');
          else if (x.field === 'name') next.name = t('su.err.name');
        }
        setErrs(next);
      } else if (p?.code === 'otp_locked') setErrs({ email: lockedText(p.retryAfter) });
      else onToast(problemText(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!/^\d{6}$/.test(code)) {
      setCodeErr(t('su.otp.required'));
      return;
    }
    setBusy(true);
    try {
      const s = await signupApi.verify(code);
      window.clearInterval(timer.current);
      setCodeErr('');
      adopt(s);
    } catch (e) {
      const p = e instanceof SignupError ? e.problem : null;
      setCode('');
      if (p?.code === 'otp_invalid' && p.attemptsLeft !== undefined)
        setCodeErr(t('su.otp.wrong', { n: p.attemptsLeft }));
      else if (p?.code === 'otp_locked') setCodeErr(lockedText(p.retryAfter));
      else if (p?.code === 'signup_session_invalid') {
        signupToken.clear();
        setSession(null);
        onToast(problemText(e));
      } else setCodeErr(problemText(e));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    try {
      const s = await signupApi.resend();
      setCode('');
      setCodeErr('');
      adopt(s);
      onToast(t('su.toast.resent'));
    } catch (e) {
      const p = e instanceof SignupError ? e.problem : null;
      if (p?.code === 'otp_resend_too_soon' && p.retryAfter) startTimer(p.retryAfter);
      else if (p?.code === 'otp_locked') setCodeErr(lockedText(p.retryAfter));
      else setCodeErr(problemText(e));
    } finally {
      setBusy(false);
    }
  }

  const setField = (k: FieldKey, v: string) => {
    setF((z) => ({ ...z, [k]: v }));
    setErrs((z) => {
      const n = { ...z };
      delete n[k];
      return n;
    });
  };

  const fields: Array<{
    k: FieldKey;
    l: MessageKey;
    type: string;
    ph: string;
    pre?: string;
    hint?: string;
    span: 1 | 2;
    ac: string;
  }> = [
    { k: 'name', l: 'su.f.name', type: 'text', ph: t('su.f.namePh'), span: 2, ac: 'name' },
    {
      k: 'email',
      l: 'su.f.email',
      type: 'email',
      ph: 'name@company.co.th',
      hint: t('su.f.emailHint'),
      span: 1,
      ac: 'email',
    },
    {
      k: 'phone',
      l: 'su.f.phone',
      type: 'tel',
      ph: t('su.f.phonePh'),
      pre: '+66',
      hint: sms ? t('su.f.phoneHint') : undefined,
      span: 1,
      ac: 'tel-national',
    },
    {
      k: 'pw',
      l: 'su.f.pw',
      type: 'password',
      ph: t('su.f.pwPh'),
      hint: f.pw ? (f.pw.length >= 12 ? t('su.f.pwOk') : t('su.f.pwRule')) : undefined,
      span: 2,
      ac: 'new-password',
    },
  ];

  const steps: MessageKey[] = ['su.step.account', 'su.step.company', 'su.step.plan'];
  const side: Array<[ReactNode, MessageKey, MessageKey]> = [
    [
      <User key="u" size={16} strokeWidth={1.8} />,
      'su.side.account',
      sms ? 'su.side.accountDSms' : 'su.side.accountDEmail',
    ],
    [<Building2 key="b" size={16} strokeWidth={1.8} />, 'su.side.company', 'su.side.companyD'],
    [<Rocket key="r" size={16} strokeWidth={1.8} />, 'su.side.trial', 'su.side.trialD'],
  ];

  const foot =
    step === 1
      ? otpSent
        ? t(sms ? 'su.foot.s1OtpSms' : 'su.foot.s1OtpEmail')
        : t('su.foot.s1')
      : t('su.foot.s2');

  return (
    <main className="su-main">
      <div className="su-steps">
        {steps.map((l, i) => {
          const k = i + 1;
          const done = k < step;
          const cur = k === step;
          return (
            <div key={l} className="su-step">
              <span
                className={`su-step__dot${done ? ' is-done' : cur ? ' is-cur' : ''}`}
                aria-current={cur ? 'step' : undefined}
              >
                {done ? <Check size={14} strokeWidth={1.8} aria-hidden="true" /> : String(k)}
              </span>
              <span className={`su-step__l${done || cur ? ' is-on' : ''}${cur ? ' is-cur' : ''}`}>
                {t(l)}
              </span>
              {k < 3 && <span className={`su-step__line${k < step ? ' is-done' : ''}`} />}
            </div>
          );
        })}
      </div>
      <div className="su-grid">
        <section className="su-card" aria-busy={loading || undefined}>
          {step === 1 && (
            <>
              <div className="su-head">
                <h1>{t('su.s1.title')}</h1>
                <span>{t(sms ? 'su.s1.subSms' : 'su.s1.subEmail')}</span>
              </div>
              {!otpSent && (
                <div className="su-fields">
                  {fields.map((x) => (
                    <label key={x.k} className={`su-field${x.span === 2 ? ' su-field--wide' : ''}`}>
                      <span className="su-label">
                        {t(x.l)}
                        <span className="su-req"> *</span>
                      </span>
                      <div className={`su-input${errs[x.k] ? ' is-err' : ''}`}>
                        {x.pre && <span className="su-input__pre">{x.pre}</span>}
                        <input
                          type={x.type}
                          value={f[x.k]}
                          placeholder={x.ph}
                          autoComplete={x.ac}
                          inputMode={x.k === 'phone' ? 'numeric' : 'text'}
                          aria-invalid={errs[x.k] ? true : undefined}
                          onChange={(e) =>
                            setField(
                              x.k,
                              x.k === 'phone'
                                ? e.target.value.replace(/[^\d ]/g, '').slice(0, 11)
                                : e.target.value,
                            )
                          }
                        />
                      </div>
                      {errs[x.k] ? (
                        <span className="su-err" role="alert">
                          {errs[x.k]}
                        </span>
                      ) : (
                        x.hint && <span className="su-hint">{x.hint}</span>
                      )}
                    </label>
                  ))}
                </div>
              )}
              {otpSent && (
                <div className="su-otp">
                  <span className="su-otp__t">
                    {t('su.otp.title', { to: session?.otp?.sentTo ?? '' })}
                  </span>
                  <input
                    className={`su-otp__in${codeErr ? ' is-err' : ''}`}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                      setCodeErr('');
                    }}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="••••••"
                    aria-label={t('su.otp.title', { to: session?.otp?.sentTo ?? '' })}
                  />
                  {codeErr && (
                    <span className="su-otp__err" role="alert">
                      {codeErr}
                    </span>
                  )}
                  <div className="su-otp__row">
                    {sec > 0 ? (
                      <span className="su-num">{t('su.otp.wait', { sec })}</span>
                    ) : (
                      <button
                        type="button"
                        className="su-otp__resend"
                        disabled={busy}
                        onClick={() => void resend()}
                      >
                        {t('su.otp.resend')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="su-otp__edit"
                      onClick={() => {
                        window.clearInterval(timer.current);
                        setEditing(true);
                        setSec(0);
                      }}
                    >
                      {t('su.otp.edit')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {step >= 2 && (
            <>
              <div className="su-head">
                <h1>{t('su.s2.title')}</h1>
                <span>{t('su.s2.sub')}</span>
              </div>
              <div className="su-note" role="status">
                <Info size={16} strokeWidth={1.8} className="su-note__i" aria-hidden="true" />
                <span>{t('su.s2.soon')}</span>
              </div>
            </>
          )}
          <div className="su-foot">
            {step === 1 && otpSent && (
              <button
                type="button"
                className="su-back"
                onClick={() => {
                  window.clearInterval(timer.current);
                  setEditing(true);
                  setSec(0);
                }}
              >
                {t('su.back')}
              </button>
            )}
            <span className="su-foot__t">{foot}</span>
            {step === 1 && (
              <button
                type="button"
                className="su-next"
                disabled={busy || loading}
                onClick={() => void (otpSent ? verify() : requestOtp())}
              >
                {otpSent ? t('su.verify') : t('su.sendOtp')}
              </button>
            )}
          </div>
        </section>
        <aside className="su-aside">
          <div className="su-side">
            <h2>{t('su.side.title')}</h2>
            {side.map(([icon, ti, d]) => (
              <div key={ti} className="su-side__i">
                <span className="su-side__ic" aria-hidden="true">
                  {icon}
                </span>
                <div className="su-side__txt">
                  <span className="su-side__t">{t(ti)}</span>
                  <span className="su-side__d">{t(d)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="su-trust">
            <span>
              <ShieldCheck size={16} strokeWidth={1.8} aria-hidden="true" />
              {t('su.trust.data')}
            </span>
            <span>
              <RotateCcw size={16} strokeWidth={1.8} aria-hidden="true" />
              {t('su.trust.cancel')}
            </span>
          </div>
        </aside>
      </div>
    </main>
  );
}
