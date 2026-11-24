import { Badge, Icon } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, queryClient, unwrap } from '../../api';
import { isImpersonating, logout } from '../../auth/session';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../shell/Header';
import { fieldErrors, problemText } from '../master/problems';
import { TwoFaBadge } from '../settings/Settings';
import { SaveBar } from '../settings/OrgSections';
import { clearStepUp, stepUpHeaders, withStepUp } from '../stepup/stepUp';
import '../settings/settings.css';

/**
 * หน้าโปรไฟล์ผู้ใช้ (ST1-T09; spec/01 §3) — ต้นแบบไม่มีหน้านี้ → PO 24 พ.ย. 2569 "ทำขึ้นมาเลย อิงจากโครงสร้างหลัก"
 * [DECISION spec/12 §3]: หัวหน้า `PageHeader` + การ์ด `set-card` ของหน้าตั้งค่า (ป้าย 12.5/500 · ช่อง 36px r8 ·
 * ปุ่ม `set-btn2` · ปุ่มบันทึกลอย `SaveBar`) · เข้าจากชื่อผู้ใช้ท้าย sidebar
 * API: `GET/PATCH /v1/me/profile` (If-Match) · `POST /v1/me/password` · `GET /v1/me/2fa` · `POST /v1/me/2fa/backup-codes` (step-up)
 * ภาษา = ปุ่มสลับบน header เดิม (บันทึกลงโปรไฟล์อยู่แล้ว)
 */

const lbl: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const input: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  font: 'inherit',
};
const SIG_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const SIG_MAX = 10 * 1024 * 1024;

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      className="set-card"
      style={{
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        overflow: 'visible',
      }}
    >
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Lab({
  label,
  hint,
  error,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        ...(wide ? { gridColumn: '1 / -1' } : {}),
      }}
    >
      <span style={lbl}>{label}</span>
      {children}
      {error ? (
        <span className="tms-field-error">{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 12.5, color: '#59606B' }}>{hint}</span>
      ) : null}
    </label>
  );
}

function useProfile() {
  return useQuery({
    queryKey: ['me', 'profile'],
    queryFn: async () => {
      const r = await api.GET('/v1/me/profile');
      const data = await unwrap(Promise.resolve(r));
      return { data, etag: r.response.headers.get('ETag') };
    },
  });
}

export function ProfilePage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('profile.title')} sub={t('profile.sub')} />
      <div className="set-body" style={{ maxWidth: 880 }} data-testid="profile-page">
        <InfoCard />
        <PasswordCard />
        <TwoFactorCard />
      </div>
    </>
  );
}

function InfoCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const p = useProfile();
  const [form, setForm] = useState({ name: '', phone: '' });
  const [msg, setMsg] = useState<{ ok?: string; err?: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const ro = isImpersonating();
  useEffect(() => {
    if (p.data) setForm({ name: p.data.data.name, phone: p.data.data.phone ?? '' });
  }, [p.data]);
  useEffect(() => {
    if (!msg) return;
    const h = setTimeout(() => setMsg(null), 3600);
    return () => clearTimeout(h);
  }, [msg]);
  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await api.PATCH('/v1/me/profile', {
        body: body as never,
        params: { header: p.data?.etag ? { 'If-Match': p.data.etag } : {} } as never,
      });
      return unwrap(Promise.resolve(r));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.problem.code === 'precondition_failed') void p.refetch();
    },
  });
  const sig = useMutation({
    mutationFn: async (f: File | null) => {
      if (!f) return patch.mutateAsync({ signatureDocumentId: null });
      if (!SIG_MIME.includes(f.type) || f.size > SIG_MAX || !f.size) throw new Error('bad_file');
      const doc = await unwrap(
        api.POST('/v1/documents', {
          body: { kind: 'SIGNATURE', mime: f.type, bytes: f.size, filename: f.name } as never,
        }),
      );
      const u = new URL(doc.uploadUrl!, location.origin);
      const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
      if (!up.ok) throw new ApiError((await up.json()) as never);
      return patch.mutateAsync({ signatureDocumentId: doc.id });
    },
    onSuccess: (_r, f) =>
      setMsg({ ok: t(f ? 'profile.signatureSaved' : 'profile.signatureRemoved') }),
    onError: (e) =>
      setMsg({
        err:
          e instanceof Error && e.message === 'bad_file'
            ? t('profile.signatureBad')
            : (problemText(e, t) ?? t('problem.internal_error')),
      }),
  });
  const d = p.data?.data;
  const dirty = !!d && (form.name.trim() !== d.name || (form.phone.trim() || null) !== d.phone);
  const errs = fieldErrors(patch.error, t);
  const save = () =>
    patch.mutate(
      { name: form.name.trim(), phone: form.phone.trim() || null },
      {
        onSuccess: () => setMsg({ ok: t('profile.saved') }),
        onError: (e) => setMsg({ err: problemText(e, t) ?? t('problem.internal_error') }),
      },
    );
  return (
    <Card title={t('profile.info')}>
      {p.isError && (
        <div role="alert" className="set-alert">
          {problemText(p.error, t)}
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
          gap: '14px 16px',
        }}
      >
        <Lab label={t('profile.name')} error={errs.name}>
          <input
            style={input}
            aria-label={t('profile.name')}
            value={form.name}
            disabled={!d || ro || patch.isPending}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Lab>
        <Lab label={t('profile.email')} hint={t('profile.emailHint')}>
          <input
            style={input}
            aria-label={t('profile.email')}
            value={d?.email ?? ''}
            readOnly
            disabled
          />
        </Lab>
        <Lab label={t('profile.phone')} error={errs.phone}>
          <input
            style={{ ...input, fontVariantNumeric: 'tabular-nums' }}
            aria-label={t('profile.phone')}
            inputMode="tel"
            placeholder={t('profile.phonePh')}
            value={form.phone}
            disabled={!d || ro || patch.isPending}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </Lab>
        <Lab label={t('profile.timezone')}>
          {/* API รองรับเขตเดียว (Asia/Bangkok) — แสดงแบบเดียวกับตั้งค่า → องค์กร */}
          <select style={input} aria-label={t('profile.timezone')} value="Asia/Bangkok" disabled>
            <option value="Asia/Bangkok">{t('org.tzBangkok')}</option>
          </select>
        </Lab>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={lbl}>{t('profile.signature')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div
            style={{
              width: 220,
              height: 80,
              border: '1px dashed #C9CDC3',
              borderRadius: 8,
              background: '#F7F8F5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#59606B',
              overflow: 'hidden',
            }}
          >
            {d?.signature?.downloadUrl ? (
              <img
                src={d.signature.downloadUrl}
                alt={t('profile.signature')}
                style={{ maxWidth: '100%', maxHeight: '100%' }}
              />
            ) : (
              t('profile.signatureNone')
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={file}
              type="file"
              accept={SIG_MIME.join(',')}
              hidden
              data-testid="profile-signature-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) sig.mutate(f);
              }}
            />
            <button
              type="button"
              className="set-btn2"
              disabled={!d || ro || sig.isPending}
              onClick={() => file.current?.click()}
            >
              <Icon n="upload" s={16} />
              {t('profile.signatureUpload')}
            </button>
            {d?.signature && (
              <button
                type="button"
                className="set-btn2"
                disabled={ro || sig.isPending}
                onClick={() => sig.mutate(null)}
              >
                <Icon n="trash-2" s={16} />
                {t('profile.signatureRemove')}
              </button>
            )}
          </div>
        </div>
        <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('profile.signatureHint')}</span>
      </div>
      <SaveBar
        dirty={dirty && !ro}
        busy={patch.isPending || !form.name.trim()}
        onSave={save}
        saved={msg?.ok ?? null}
        error={msg?.err ?? null}
        onDismiss={() => setMsg(null)}
      />
    </Card>
  );
}

function PasswordCard() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [f, setF] = useState({ cur: '', next: '', confirm: '' });
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ro = isImpersonating();
  const run = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/me/password', {
          body: { currentPassword: f.cur, newPassword: f.next },
        }),
      ),
    onSuccess: () => {
      // API bump tokenVersion → ทุก session (รวมเครื่องนี้) หลุด → ออกจากระบบแล้วไปหน้าเข้าสู่ระบบ
      setDone(true);
      setTimeout(() => {
        void logout().finally(() => {
          clearStepUp();
          queryClient.clear();
          nav('/login', { replace: true });
        });
      }, 1500);
    },
    // ช่องผิด (รหัสเดิมไม่ถูก / นโยบายรหัสผ่าน) → ข้อความไทยของช่องนั้น (`field.password_*`)
    onError: (e) => {
      const f = fieldErrors(e, t);
      setErr(f.currentPassword ?? f.newPassword ?? problemText(e, t));
    },
  });
  const submit = () => {
    setErr(null);
    if (!f.cur || !f.next || !f.confirm) return setErr(t('reset.required'));
    if (f.next.length < 12) return setErr(t('profile.pwdShort'));
    if (f.next !== f.confirm) return setErr(t('reset.mismatch'));
    run.mutate();
  };
  return (
    <Card title={t('profile.pwd')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0,1fr))',
            gap: '14px 16px',
          }}
        >
          <Lab label={t('profile.pwdCurrent')}>
            <input
              style={input}
              type="password"
              autoComplete="current-password"
              aria-label={t('profile.pwdCurrent')}
              value={f.cur}
              disabled={ro || done}
              onChange={(e) => setF({ ...f, cur: e.target.value })}
            />
          </Lab>
          <Lab label={t('reset.new')}>
            <input
              style={input}
              type="password"
              autoComplete="new-password"
              aria-label={t('reset.new')}
              value={f.next}
              disabled={ro || done}
              onChange={(e) => setF({ ...f, next: e.target.value })}
            />
          </Lab>
          <Lab label={t('reset.confirm')}>
            <input
              style={input}
              type="password"
              autoComplete="new-password"
              aria-label={t('reset.confirm')}
              value={f.confirm}
              disabled={ro || done}
              onChange={(e) => setF({ ...f, confirm: e.target.value })}
            />
          </Lab>
        </div>
        <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('profile.pwdHint')}</span>
        {err && (
          <div role="alert" className="set-alert">
            {err}
          </div>
        )}
        {done && (
          <div
            role="status"
            className="set-alert"
            style={{ background: '#E6F4EC', color: '#17733F', borderColor: '#BFE0CC' }}
          >
            {t('profile.pwdDone')}
          </div>
        )}
        <button
          type="submit"
          className="set-btn2"
          style={{ alignSelf: 'flex-start' }}
          disabled={ro || run.isPending || done}
        >
          <Icon n="key-round" s={16} />
          {t('profile.pwdSubmit')}
        </button>
      </form>
    </Card>
  );
}

function TwoFactorCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const ro = isImpersonating();
  const s = useQuery({
    queryKey: ['me', '2fa'],
    queryFn: () => unwrap(api.GET('/v1/me/2fa')),
  });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const regen = useMutation({
    mutationFn: () =>
      withStepUp((tok) =>
        unwrap(
          api.POST('/v1/me/2fa/backup-codes', {
            params: { header: stepUpHeaders(tok) } as never,
          }),
        ),
      ),
    onSuccess: (r) => {
      setCodes(r.backupCodes);
      void qc.invalidateQueries({ queryKey: ['me', '2fa'] });
    },
  });
  const d = s.data;
  return (
    <Card title={t('profile.2fa')}>
      {d && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <TwoFaBadge on={d.enabled} />
          <span style={{ color: '#3B424C' }}>
            {t(d.required ? 'profile.2faRequired' : 'profile.2faOptional')}
          </span>
          {d.enabled && (
            <Badge
              label={t('profile.backupLeft', { n: d.backupCodesRemaining })}
              tone={d.backupCodesRemaining > 2 ? 'info' : 'warn'}
              icon="key-round"
            />
          )}
        </div>
      )}
      {d && !d.enabled && (
        <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('profile.2faOffHint')}</span>
      )}
      {d?.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            className="set-btn2"
            style={{ alignSelf: 'flex-start' }}
            disabled={ro || regen.isPending}
            onClick={() => {
              setCodes(null);
              regen.mutate();
            }}
          >
            <Icon n="refresh-cw" s={16} />
            {t('profile.backupNew')}
          </button>
          <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('profile.backupNewHint')}</span>
        </div>
      )}
      {regen.error && problemText(regen.error, t) && (
        <div role="alert" className="set-alert">
          {problemText(regen.error, t)}
        </div>
      )}
      {codes && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
          <span style={{ fontWeight: 600 }}>{t('mfa.codesTitle')}</span>
          <span style={{ color: '#3B424C' }}>{t('mfa.codesSub')}</span>
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
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button
            type="button"
            className="set-btn2"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true));
            }}
          >
            <Icon n={copied ? 'check' : 'copy'} s={16} />
            {t(copied ? 'mfa.copied' : 'mfa.copy')}
          </button>
        </div>
      )}
    </Card>
  );
}
