import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { PublicLayout } from '../public/PublicLayout';
import { ConsoleShell } from './ConsoleShell';
import { consoleLogin, consoleMfa, consoleSession } from './session';
import { TenantsPage } from './Tenants';

/** Platform Console (ST1-T24) — route group /console/* แยกจากแอปลูกค้า (layout, login, token ของตัวเอง) */
export function ConsoleApp() {
  return (
    <Routes>
      <Route path="login" element={<ConsoleLogin />} />
      <Route
        path="*"
        element={
          <RequireConsole>
            <ConsoleShell>
              <Routes>
                <Route index element={<Navigate to="tenants" replace />} />
                <Route path="tenants" element={<TenantsPage />} />
                <Route path="tenants/:id" element={<TenantsPage />} />
                <Route path="*" element={<Navigate to="/console/tenants" replace />} />
              </Routes>
            </ConsoleShell>
          </RequireConsole>
        }
      />
    </Routes>
  );
}

function RequireConsole({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const inSession = useSyncExternalStore(consoleSession.subscribe, consoleSession.get);
  if (!inSession) {
    const next = loc.pathname + loc.search;
    return <Navigate to={`/console/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/**
 * เข้าสู่ระบบ Console 2 ขั้น (อีเมล + รหัสผ่าน → รหัส 6 หลัก) — ต้นแบบ Platform Console ไม่มีหน้านี้:
 * ใช้การ์ด/ช่องกรอก/ปุ่มของหน้าเข้าสู่ระบบลูกค้า (TMS Signup au.login) [OPEN spec/12 §3]
 */
function ConsoleLogin() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = (c: string) => t(`problem.${c}` as MessageKey);

  async function step1(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !pw) return setErr(t('login.required'));
    setBusy(true);
    const r = await consoleLogin(email.trim(), pw).catch(() => ({ error: 'internal_error' }));
    setBusy(false);
    if ('error' in r) return setErr(problem(r.error));
    setChallenge(r.challenge);
    setErr('');
  }

  async function step2(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) return setErr(t('mfa.required'));
    setBusy(true);
    const r = await consoleMfa(challenge, code).catch(() => ({ error: 'internal_error' }));
    setBusy(false);
    if ('error' in r) {
      setCode('');
      // หมดเวลา/ถูกล็อก → กลับขั้นแรก
      if (r.error === 'mfa_expired' || r.error === 'account_locked') {
        setChallenge(null);
        setPw('');
      }
      return setErr(problem(r.error));
    }
    const n = params.get('next');
    nav(n && n.startsWith('/console/') ? n : '/console/tenants', { replace: true });
  }

  return (
    <PublicLayout>
      {challenge ? (
        <form onSubmit={step2} style={{ display: 'contents' }} noValidate>
          <div className="pub-head">
            <h1>{t('mfa.title')}</h1>
            <span>{t('mfa.sub')}</span>
          </div>
          <label className="pub-field">
            <span className="pub-field__l">{t('mfa.codeLabel')}</span>
            <input
              className="pub-input"
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              value={code}
              style={{ letterSpacing: '0.3em', fontVariantNumeric: 'tabular-nums' }}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, ''));
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
            {t('mfa.submit')}
          </button>
          <a
            href="/console/login"
            className="pub-link"
            onClick={(e) => {
              e.preventDefault();
              setChallenge(null);
              setPw('');
              setCode('');
              setErr('');
            }}
          >
            {t('login.back')}
          </a>
        </form>
      ) : (
        <form onSubmit={step1} style={{ display: 'contents' }} noValidate>
          <div className="pub-head">
            <h1>{t('con.login.title')}</h1>
            <span>{t('con.login.sub')}</span>
          </div>
          <label className="pub-field">
            <span className="pub-field__l">{t('login.email')}</span>
            <input
              className="pub-input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setErr('');
              }}
            />
          </label>
          <label className="pub-field">
            <span className="pub-field__l">{t('login.password')}</span>
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
      )}
    </PublicLayout>
  );
}
