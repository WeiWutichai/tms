import { Icon } from '@tms/ui';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { th, type MessageKey } from '../i18n/th';
import { PublicLayout } from '../public/PublicLayout';
import { ROLE_LABEL } from './ConsoleShell';
import { consoleApi, type StaffRole } from './session';

interface Info {
  email: string;
  name: string;
  role: string;
  secret: string;
  otpauthUri: string;
}

const readToken = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';

/**
 * รับคำเชิญทีมงาน Platform Console (P1-ST4-T06) — ต้นแบบไม่มีหน้านี้ [DECISION spec/12 §3]:
 * ประกอบจากการ์ด public ของหน้ารับคำเชิญลูกค้า (/invite) + ขั้นตั้ง 2FA (QR + รหัส 6 หลัก) ของหน้าเข้าสู่ระบบ
 * 2FA บังคับทีมงานทุกคน (docs/04 A6) → ตั้งรหัสผ่านและยืนยันรหัสในฟอร์มเดียว
 */
export function ConsoleInvite() {
  const { t } = useI18n();
  const [token] = useState(readToken);
  const [info, setInfo] = useState<Info | null>(null);
  const [qr, setQr] = useState('');
  const [invalid, setInvalid] = useState(!token);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const once = useRef(false);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (!token || once.current) return;
    once.current = true;
    void consoleApi
      .POST('/v1/platform/auth/invitations/inspect', { body: { token } })
      .then(async (r) => {
        if (!r.data) return setInvalid(true);
        setInfo(r.data);
        setName(r.data.name);
        setQr(await QRCode.toDataURL(r.data.otpauthUri, { margin: 1, width: 176 }));
      })
      .catch(() => setInvalid(true));
  }, [token]);

  const text = (e: unknown) => {
    const p = e as { code?: string; errors?: { code: string }[] } | undefined;
    const f = p?.errors?.[0]?.code;
    if (f && `field.${f}` in th) return t(`field.${f}` as MessageKey);
    const c = p?.code ?? 'internal_error';
    return t((`problem.${c}` in th ? `problem.${c}` : 'problem.internal_error') as MessageKey);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    if (!name.trim() || !pw || !pw2 || !/^\d{6}$/.test(code))
      return setErr(t('con.invite.required'));
    if (pw !== pw2) return setErr(t('reset.mismatch'));
    setBusy(true);
    try {
      const r = await consoleApi.POST('/v1/platform/auth/invitations/accept', {
        body: { token, password: pw, code, name: name.trim() },
      });
      if (r.response.status === 204) setDone(true);
      else if ((r.error as { code?: string } | undefined)?.code === 'invitation_invalid')
        setInvalid(true);
      else {
        setCode('');
        setErr(text(r.error));
      }
    } catch {
      setErr(t('problem.internal_error'));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    label: MessageKey,
    value: string,
    set: (v: string) => void,
    type: 'password' | 'text' = 'password',
  ) => (
    <label className="pub-field">
      <span className="pub-field__l">{t(label)}</span>
      <input
        className="pub-input"
        type={type}
        autoComplete={type === 'password' ? 'new-password' : 'name'}
        value={value}
        onChange={(e) => {
          set(e.target.value);
          setErr('');
        }}
      />
    </label>
  );

  return (
    <PublicLayout>
      <div className="pub-head">
        <h1>{t('con.invite.title')}</h1>
        {info && !done && (
          <span>
            {t('con.invite.sub', {
              r: ROLE_LABEL[info.role as StaffRole]
                ? t(ROLE_LABEL[info.role as StaffRole])
                : info.role,
            })}
          </span>
        )}
      </div>
      {invalid ? (
        <span className="pub-err" role="alert">
          {t('problem.invitation_invalid')}
        </span>
      ) : done ? (
        <div className="pub-ok" role="status">
          <Icon n="circle-check" s={18} style={{ flexShrink: 0 }} />
          <span>{t('con.invite.done')}</span>
        </div>
      ) : info ? (
        <form onSubmit={submit} style={{ display: 'contents' }} noValidate>
          <label className="pub-field">
            <span className="pub-field__l">{t('login.email')}</span>
            <input className="pub-input" type="email" value={info.email} readOnly disabled />
          </label>
          {field('invite.name', name, setName, 'text')}
          {field('invite.password', pw, setPw)}
          {field('invite.confirm', pw2, setPw2)}
          <span style={{ color: '#3B424C', fontSize: 12.5 }}>{t('invite.passwordHint')}</span>
          <span style={{ color: '#3B424C' }}>{t('con.invite.qr')}</span>
          {qr && (
            <img
              src={qr}
              alt={t('mfa.qrAlt')}
              width={176}
              height={176}
              style={{ alignSelf: 'center', border: '1px solid #E4E6E0', borderRadius: 8 }}
            />
          )}
          <span style={{ color: '#59606B', fontSize: 12.5 }}>
            {t('con.invite.secret')}{' '}
            <code style={{ wordBreak: 'break-all', color: '#101418' }}>{info.secret}</code>
          </span>
          <label className="pub-field">
            <span className="pub-field__l">{t('mfa.codeLabel')}</span>
            <input
              className="pub-input"
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
            {t('invite.submit')}
          </button>
        </form>
      ) : null}
      <a href="/console/login" className="pub-link">
        {t('con.invite.toLogin')}
      </a>
    </PublicLayout>
  );
}
