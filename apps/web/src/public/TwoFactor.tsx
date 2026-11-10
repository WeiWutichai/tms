import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  confirmEnroll,
  finishEnroll,
  startEnroll,
  verifyMfa,
  type LoginResult,
  type MfaStep,
} from '../auth/session';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';

/**
 * ขั้นที่ 2 ของ login (ST1-T05) — ต้นแบบไม่มีหน้านี้: ใช้การ์ด/ช่องกรอก/ปุ่มชุดเดียวกับหน้าเข้าสู่ระบบ (TMS Signup)
 * [OPEN] spec/12 §3: รอ Claude Design ออกแบบหน้า 2FA (กรอกรหัส, ตั้งค่า + QR, รหัสสำรอง)
 */
export function MfaVerify({
  step,
  onDone,
  onBack,
}: {
  step: MfaStep;
  onDone: (r: LoginResult) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [useBackup, setUseBackup] = useState(false);
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return setErr(t('mfa.required'));
    setBusy(true);
    const r = await verifyMfa(
      step,
      useBackup
        ? { backupCode: value.trim(), rememberDevice: remember }
        : { otp: value.trim(), rememberDevice: remember },
    ).catch(() => ({ ok: false as const, code: 'internal_error' }));
    setBusy(false);
    if (r.ok) return onDone(r);
    setErr(t(`problem.${r.code}` as MessageKey));
  }

  return (
    <form onSubmit={submit} style={{ display: 'contents' }} noValidate>
      <div className="pub-head">
        <h1>{t('mfa.title')}</h1>
        <span>{useBackup ? t('mfa.backupSub') : t('mfa.sub')}</span>
      </div>
      <label className="pub-field">
        <span className="pub-field__l">
          {useBackup ? t('mfa.backupLabel') : t('mfa.codeLabel')}
        </span>
        <input
          className="pub-input"
          autoFocus
          autoComplete="one-time-code"
          inputMode={useBackup ? 'text' : 'numeric'}
          maxLength={useBackup ? 12 : 6}
          value={value}
          style={{
            letterSpacing: useBackup ? undefined : '0.3em',
            fontVariantNumeric: 'tabular-nums',
          }}
          onChange={(e) => {
            setValue(useBackup ? e.target.value : e.target.value.replace(/\D/g, ''));
            setErr('');
          }}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          style={{ width: 16, height: 16, accentColor: '#2257C4', margin: 0 }}
        />
        {t('mfa.remember')}
      </label>
      {err && (
        <span className="pub-err" role="alert">
          {err}
        </span>
      )}
      <button type="submit" className="pub-btn" disabled={busy}>
        {t('mfa.submit')}
      </button>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <a
          href="#"
          className="pub-link"
          onClick={(e) => {
            e.preventDefault();
            setUseBackup((b) => !b);
            setValue('');
            setErr('');
          }}
        >
          {useBackup ? t('mfa.useApp') : t('mfa.useBackup')}
        </a>
        <a
          href="/login"
          className="pub-link"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          {t('login.back')}
        </a>
      </div>
    </form>
  );
}

export function MfaEnroll({
  step,
  onDone,
  onBack,
}: {
  step: MfaStep;
  onDone: (r: LoginResult) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [otp, setOtp] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ backupCodes: string[]; result: LoginResult } | null>(null);
  const [copied, setCopied] = useState(false);
  const started = useRef<MfaStep | null>(null);

  useEffect(() => {
    // เรียกครั้งเดียวต่อ challenge (StrictMode เรียก effect 2 รอบ → secret ไม่ตรงกับ QR — review T05 M5)
    if (started.current === step) return;
    started.current = step;
    void startEnroll(step).then(async (r) => {
      if ('error' in r) return setErr(t(`problem.${r.error}` as MessageKey));
      const qr = await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 176 });
      setSetup({ secret: r.secret, qr });
    });
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (otp.length !== 6) return setErr(t('mfa.required'));
    setBusy(true);
    const r = await confirmEnroll(step, otp).catch(() => ({ error: 'internal_error' }));
    if ('error' in r) {
      setBusy(false);
      return setErr(t(`problem.${r.error}` as MessageKey));
    }
    // แลก code ทันที (อายุ 60 วินาที) — ผู้ใช้จดรหัสสำรองนานเท่าไรก็ได้โดย session ไม่หลุด (review T05 S4)
    const result = await finishEnroll(step, r.code).catch((): LoginResult => ({
      ok: false,
      code: 'internal_error',
    }));
    setBusy(false);
    if (!result.ok) return setErr(t(`problem.${result.code}` as MessageKey));
    setDone({ backupCodes: r.backupCodes, result });
  }

  if (done)
    return (
      <>
        <div className="pub-head">
          <h1>{t('mfa.codesTitle')}</h1>
          <span>{t('mfa.codesSub')}</span>
        </div>
        <ul
          aria-label={t('mfa.codesTitle')}
          style={{
            margin: 0,
            padding: '12px 16px',
            listStyle: 'none',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '6px 16px',
            background: '#F7F8F5',
            border: '1px solid #E4E6E0',
            borderRadius: 8,
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 14,
          }}
        >
          {done.backupCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <a
          href="#"
          className="pub-link"
          onClick={(e) => {
            e.preventDefault();
            void navigator.clipboard
              ?.writeText(done.backupCodes.join('\n'))
              .then(() => setCopied(true));
          }}
        >
          {copied ? t('mfa.copied') : t('mfa.copy')}
        </a>
        <button
          type="button"
          className="pub-btn"
          disabled={busy}
          onClick={() => onDone(done.result)}
        >
          {t('mfa.continue')}
        </button>
      </>
    );

  return (
    <form onSubmit={submit} style={{ display: 'contents' }} noValidate>
      <div className="pub-head">
        <h1>{t('mfa.enrollTitle')}</h1>
        <span>{t('mfa.enrollSub')}</span>
      </div>
      {setup && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <img
            src={setup.qr}
            alt={t('mfa.qrAlt')}
            width={176}
            height={176}
            style={{ border: '1px solid #E4E6E0', borderRadius: 8, flexShrink: 0 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: '#3B424C' }}>{t('mfa.manual')}</span>
            <code
              data-testid="totp-secret"
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 13,
                overflowWrap: 'anywhere',
              }}
            >
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </code>
          </div>
        </div>
      )}
      <label className="pub-field">
        <span className="pub-field__l">{t('mfa.codeLabel')}</span>
        <input
          className="pub-input"
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          value={otp}
          style={{ letterSpacing: '0.3em', fontVariantNumeric: 'tabular-nums' }}
          onChange={(e) => {
            setOtp(e.target.value.replace(/\D/g, ''));
            setErr('');
          }}
        />
      </label>
      {err && (
        <span className="pub-err" role="alert">
          {err}
        </span>
      )}
      <button type="submit" className="pub-btn" disabled={busy || !setup}>
        {t('mfa.enrollSubmit')}
      </button>
      <a
        href="/login"
        className="pub-link"
        onClick={(e) => {
          e.preventDefault();
          onBack();
        }}
      >
        {t('login.back')}
      </a>
    </form>
  );
}
