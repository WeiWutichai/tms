import { Icon } from '@tms/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { PublicLayout } from './PublicLayout';

interface Info {
  email: string;
  name: string;
  tenantName: string;
  roles: string[];
  existingAccount: boolean;
}

const readToken = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';

/**
 * รับคำเชิญ (ST1-T07; spec/01 §3 "หน้ารับคำเชิญ") — ต้นแบบยังไม่มีหน้านี้ [OPEN spec/12 §3]
 * ใช้การ์ดเดียวกับ au.forgot · ผู้ใช้ใหม่ตั้งรหัสผ่าน / มีบัญชีแล้วใส่รหัสเดิม (PLT-035)
 */
export function InvitePage() {
  const { t } = useI18n();
  const [token] = useState(readToken);
  const [info, setInfo] = useState<Info | null>(null);
  const [invalid, setInvalid] = useState(!token);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // ล้าง token ออกจาก URL (อ่านเก็บใน state แล้ว)
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (!token) return;
    void api
      .POST('/v1/auth/invitations/inspect', { body: { token } })
      .then((r) => {
        if (r.data) {
          setInfo(r.data);
          setName(r.data.name);
        } else setInvalid(true);
      })
      .catch(() => setInvalid(true));
  }, [token]);

  const text = (e: unknown) => {
    const p = e as { code?: string; errors?: { code: string }[] } | undefined;
    const f = p?.errors?.[0]?.code;
    if (f) return t(`field.${f}` as MessageKey);
    return t(`problem.${p?.code ?? 'internal_error'}` as MessageKey);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    if (!pw || (!info.existingAccount && (!pw2 || !name.trim())))
      return setErr(t('invite.required'));
    if (!info.existingAccount && pw !== pw2) return setErr(t('reset.mismatch'));
    setBusy(true);
    try {
      const r = await api.POST('/v1/auth/invitations/accept', {
        body: info.existingAccount
          ? { token, currentPassword: pw }
          : { token, password: pw, name: name.trim() },
      });
      if (r.response.status === 204) setDone(true);
      else if ((r.error as { code?: string } | undefined)?.code === 'invitation_invalid')
        setInvalid(true);
      else setErr(text(r.error));
    } catch {
      setErr(t('problem.internal_error'));
    } finally {
      setBusy(false);
    }
  }

  const field = (label: MessageKey, value: string, set: (v: string) => void, type = 'password') => (
    <label className="pub-field">
      <span className="pub-field__l">{t(label)}</span>
      <input
        className="pub-input"
        type={type}
        autoComplete={
          type === 'password'
            ? info?.existingAccount
              ? 'current-password'
              : 'new-password'
            : 'name'
        }
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
        <h1>{t('invite.title')}</h1>
        {info && !done && (
          <span>
            {t('invite.subPlain', { tenant: info.tenantName, roles: info.roles.join(', ') })}
          </span>
        )}
      </div>
      {invalid ? (
        <span className="pub-err" role="alert">
          {t('problem.invitation_invalid')}
        </span>
      ) : done && info ? (
        <div className="pub-ok" role="status">
          <Icon n="circle-check" s={18} style={{ flexShrink: 0 }} />
          <span>{t('invite.done', { tenant: info.tenantName })}</span>
        </div>
      ) : info ? (
        <form onSubmit={submit} style={{ display: 'contents' }} noValidate>
          <label className="pub-field">
            <span className="pub-field__l">{t('login.email')}</span>
            <input className="pub-input" type="email" value={info.email} readOnly disabled />
          </label>
          {info.existingAccount ? (
            <>
              <span style={{ color: '#3B424C' }}>{t('invite.existing')}</span>
              {field('invite.current', pw, setPw)}
            </>
          ) : (
            <>
              {field('invite.name', name, setName, 'text')}
              {field('invite.password', pw, setPw)}
              {field('invite.confirm', pw2, setPw2)}
              <span style={{ color: '#3B424C', fontSize: 12.5 }}>{t('invite.passwordHint')}</span>
            </>
          )}
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
      <a href="/login" className="pub-link">
        {t('login.back')}
      </a>
    </PublicLayout>
  );
}
