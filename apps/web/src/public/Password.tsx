import { Icon } from '@tms/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { PublicLayout } from './PublicLayout';

/** ข้อความ problem → ภาษาไทย (code ที่ไม่รู้จัก = ระบบขัดข้อง) */
function useProblemText() {
  const { t } = useI18n();
  return (e: unknown) => {
    const p = e as { code?: string; errors?: { code: string }[] } | undefined;
    const field = p?.errors?.[0]?.code;
    if (field) return t(`field.${field}` as MessageKey);
    return t(`problem.${p?.code ?? 'internal_error'}` as MessageKey);
  };
}

/** ลืมรหัสผ่าน (au.forgot ใน TMS Signup) — ST1-T03 · ตอบเหมือนกันไม่ว่าอีเมลมีในระบบหรือไม่ */
export function ForgotPasswordPage() {
  const { t } = useI18n();
  const text = useProblemText();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return setErr(t('forgot.required'));
    setBusy(true);
    try {
      const r = await api.POST('/v1/auth/password/forgot', { body: { email: email.trim() } });
      if (r.response.status === 202) setSent(true);
      else setErr(text(r.error));
    } catch {
      setErr(t('problem.internal_error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <div className="pub-head">
        <h1>{t('forgot.title')}</h1>
        <span>{t('forgot.sub')}</span>
      </div>
      {!sent ? (
        <form onSubmit={send} style={{ display: 'contents' }} noValidate>
          <label className="pub-field">
            <span className="pub-field__l">{t('login.email')}</span>
            <input
              className="pub-input"
              type="email"
              autoComplete="username"
              value={email}
              placeholder={t('login.emailPh')}
              onChange={(e) => {
                setEmail(e.target.value);
                setErr('');
              }}
            />
          </label>
          {err && (
            <span className="pub-err" role="alert">
              {err}
            </span>
          )}
          <button type="submit" className="pub-btn" disabled={busy}>
            {t('forgot.send')}
          </button>
        </form>
      ) : (
        <div className="pub-ok" role="status">
          <Icon n="mail-check" s={18} style={{ flexShrink: 0 }} />
          <span>{t('forgot.sent', { email: email.trim() })}</span>
        </div>
      )}
      <a href="/login" className="pub-link">
        {t('login.back')}
      </a>
    </PublicLayout>
  );
}

/** อ่าน token จาก fragment (#token=…) — fragment ไม่ถูกส่งไป server และไม่ติดไปกับ Referer */
function tokenFromHash(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
}
/** ล้าง token ออกจาก URL/ประวัติ (ไม่ค้างแม้ลิงก์ผิดหรือรหัสไม่ผ่าน) — เรียกใน effect ไม่ใช่ตอน render (StrictMode เรียก initializer 2 ครั้ง) */
function clearHash() {
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
}

/**
 * ตั้งรหัสผ่านใหม่จากลิงก์ในอีเมล — ต้นแบบยังไม่มีหน้านี้ [OPEN spec/12 §3]
 * ใช้ส่วนประกอบเดียวกับ au.forgot (การ์ด/ช่องกรอก/ปุ่ม) จนกว่า Claude Design จะออกแบบ
 */
export function ResetPasswordPage() {
  const { t } = useI18n();
  const text = useProblemText();
  const [token, setToken] = useState(tokenFromHash);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [invalid, setInvalid] = useState(!token);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // เปิดลิงก์ใหม่ในแท็บเดิม (hash เปลี่ยน ไม่ reload) → เริ่มใหม่ด้วย token นั้น
  useEffect(() => {
    const onHash = () => {
      const t = tokenFromHash();
      if (!t) return;
      clearHash();
      setToken(t);
      setInvalid(false);
      setDone(false);
      setErr('');
      setPw('');
      setPw2('');
    };
    clearHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pw || !pw2) return setErr(t('reset.required'));
    if (pw !== pw2) return setErr(t('reset.mismatch'));
    setBusy(true);
    try {
      const r = await api.POST('/v1/auth/password/reset', { body: { token, newPassword: pw } });
      if (r.response.status === 204) setDone(true);
      else if ((r.error as { code?: string } | undefined)?.code === 'reset_link_invalid')
        setInvalid(true);
      else setErr(text(r.error));
    } catch {
      setErr(t('problem.internal_error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <div className="pub-head">
        <h1>{t('reset.title')}</h1>
        {!done && !invalid && <span>{t('reset.sub')}</span>}
      </div>
      {done ? (
        <div className="pub-ok" role="status">
          <Icon n="circle-check" s={18} style={{ flexShrink: 0 }} />
          <span>{t('reset.done')}</span>
        </div>
      ) : invalid ? (
        <>
          <span className="pub-err" role="alert">
            {t('problem.reset_link_invalid')}
          </span>
          <a href="/forgot" className="pub-btn pub-btn--link">
            {t('reset.again')}
          </a>
        </>
      ) : (
        <form onSubmit={submit} style={{ display: 'contents' }} noValidate>
          <label className="pub-field">
            <span className="pub-field__l">{t('reset.new')}</span>
            <input
              className="pub-input"
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                setErr('');
              }}
            />
          </label>
          <label className="pub-field">
            <span className="pub-field__l">{t('reset.confirm')}</span>
            <input
              className="pub-input"
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => {
                setPw2(e.target.value);
                setErr('');
              }}
            />
          </label>
          {err && (
            <span className="pub-err" role="alert">
              {err}
            </span>
          )}
          <button type="submit" className="pub-btn" disabled={busy}>
            {t('reset.submit')}
          </button>
        </form>
      )}
      <a href="/login" className="pub-link">
        {t('login.back')}
      </a>
    </PublicLayout>
  );
}
