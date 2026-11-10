import { Icon } from '@tms/ui';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { login, type MfaStep, type TenantChoice } from '../auth/session';
import { MfaEnroll, MfaVerify } from './TwoFactor';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { PublicLayout } from './PublicLayout';

/** ป้ายสถานะบริษัท — statuses + tone ของ design/prototype/plans.js */
const TENANT_BADGE: Record<string, { k: MessageKey; c: string; bg: string; i: string }> = {
  trial: { k: 'tenantStatus.trial', c: '#2257C4', bg: '#E9F0FA', i: 'flask-conical' },
  active: { k: 'tenantStatus.active', c: '#17733F', bg: '#E7F3EC', i: 'circle-check' },
};

/** ตัวย่อ 2 ตัวจากชื่อบริษัท (ตัดคำนำหน้านิติบุคคล + "จำกัด" และสระ/วรรณยุกต์) — แทน c.ini ที่ต้นแบบใส่มือ */
const PREFIX =
  /^(\u0E1A\u0E23\u0E34\u0E29\u0E31\u0E17|\u0E1A\u0E08\u0E01\.|\u0E2B\u0E08\u0E01\.|\u0E1A\u0E21\u0E08\.)\s*/;
const LIMITED = /\s*\u0E08\u0E33\u0E01\u0E31\u0E14.*$/;
const LETTER = /[\u0E01-\u0E2EA-Za-z0-9]/;
export function initials(name: string): string {
  const core = name.replace(PREFIX, '').replace(LIMITED, '');
  return [...core]
    .filter((ch) => LETTER.test(ch))
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** หน้าเข้าสู่ระบบ (au.login) + เลือกบริษัท (au.pick) — ST1-T01 */
export function LoginPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [tenants, setTenants] = useState<TenantChoice[] | null>(null);
  const [mfa, setMfa] = useState<{ step: MfaStep; enroll: boolean } | null>(null);

  const next = () => {
    const n = params.get('next');
    nav(n && n.startsWith('/') && !n.startsWith('//') ? n : '/', { replace: true });
  };

  async function attempt(tenantId?: string) {
    setBusy(true);
    try {
      const r = await login(email.trim(), pw, tenantId);
      if (r.ok) return next();
      if (r.mfa && (r.code === 'mfa_required' || r.code === 'mfa_enrollment_required')) {
        setTenants(null);
        setMfa({ step: r.mfa, enroll: r.code === 'mfa_enrollment_required' });
        return;
      }
      if (r.code === 'tenant_selection_required' && r.tenants?.length) {
        setTenants(r.tenants);
        return;
      }
      setTenants(null);
      setErr(t(`problem.${r.code}` as MessageKey));
    } catch {
      setErr(t('problem.internal_error'));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!email || !pw) {
      setErr(t('login.required'));
      return;
    }
    void attempt();
  }

  if (mfa) {
    const back = (message?: string) => {
      setMfa(null);
      setPw('');
      setErr(message ?? '');
    };
    const done = (r: { ok: boolean }) => (r.ok ? next() : back());
    return (
      <PublicLayout>
        {mfa.enroll ? (
          <MfaEnroll step={mfa.step} onDone={done} onBack={back} />
        ) : (
          <MfaVerify step={mfa.step} onDone={done} onBack={back} />
        )}
      </PublicLayout>
    );
  }

  if (tenants)
    return (
      <PublicLayout>
        <div className="pub-head">
          <h1>{t('login.pickTitle')}</h1>
          <span>{t('login.pickSub', { email, n: tenants.length })}</span>
        </div>
        <div className="pub-cos">
          {tenants.map((c) => {
            const b = TENANT_BADGE[c.status];
            return (
              <button
                key={c.id}
                type="button"
                className="pub-co"
                disabled={busy}
                onClick={() => void attempt(c.id)}
              >
                <span className="pub-co__ini">{initials(c.name)}</span>
                <span className="pub-co__txt">
                  <span className="pub-co__n">{c.name}</span>
                </span>
                {b && (
                  <span className="pub-co__badge" style={{ background: b.bg, color: b.c }}>
                    <Icon n={b.i} s={12} />
                    {t(b.k)}
                  </span>
                )}
                <Icon n="chevron-right" s={16} style={{ color: '#59606B' }} />
              </button>
            );
          })}
        </div>
        <a
          href="/login"
          className="pub-link"
          onClick={(e) => {
            e.preventDefault();
            setTenants(null);
          }}
        >
          {t('login.back')}
        </a>
      </PublicLayout>
    );

  return (
    <PublicLayout>
      <form onSubmit={submit} style={{ display: 'contents' }} noValidate>
        <div className="pub-head">
          <h1>{t('login.title')}</h1>
        </div>
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
        <label className="pub-field">
          <span className="pub-field__l">
            {t('login.password')}
            <a href="/forgot">{t('login.forgot')}</a>
          </span>
          <input
            className="pub-input"
            type="password"
            autoComplete="current-password"
            value={pw}
            onChange={(e) => {
              setPw(e.target.value);
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
          {t('login.submit')}
        </button>
      </form>
    </PublicLayout>
  );
}
