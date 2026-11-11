import { Badge, Drawer, DrawerFooterButtons, Field, Icon, TextInput } from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, unwrap } from '../../api';
import { isImpersonating } from '../../auth/session';
import { fieldErrors } from '../companies/CompanySample';
import { formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { TwoFaBadge } from './Settings';
import { useMe } from '../../shell/AppShell';
import { StepUpBox } from './OrgSections';
import { stepUp, useRoles, useUsers } from './useSettings';

/**
 * แถวของตาราง "สิทธิ์ตามบทบาท" = ตาราง A3 (docs/04) — scope ตัวแทนของแต่ละแถว
 * (คำตอบ PO 10 พ.ย. 2569: แสดงตาม A3 แบบอ่านอย่างเดียว; role กำหนดเองเป็น P1)
 */
const MATRIX: Array<[MessageKey, string]> = [
  ['perm.users', 'users:write'],
  ['perm.settings', 'settings:write'],
  ['perm.masterEdit', 'master:write'],
  ['perm.masterRead', 'master:read'],
  ['perm.sellRead', 'prices.sell:read'],
  ['perm.sellWrite', 'prices.sell:write'],
  ['perm.buyRead', 'prices.buy:read'],
  ['perm.ordersRead', 'orders:read'],
  ['perm.ordersWrite', 'orders:write'],
  ['perm.ordersCancel', 'orders:cancel'],
  ['perm.tripsAssign', 'trips:assign'],
  ['perm.tripsDispatch', 'trips:dispatch'],
  ['perm.tripsClose', 'trips:close'],
  ['perm.invRead', 'invoices:read'],
  ['perm.invDraft', 'invoices:draft'],
  ['perm.invFinalize', 'invoices:finalize'],
  ['perm.cnRequest', 'credit-notes:request'],
  ['perm.cnApprove', 'credit-notes:approve'],
  ['perm.stlCreate', 'settlements:create'],
  ['perm.stlApprove', 'settlements:approve'],
  ['perm.stlPay', 'settlements:pay'],
  ['perm.intRead', 'integrations:read'],
  ['perm.intRetry', 'integrations:retry'],
  ['perm.repFin', 'reports.finance:read'],
  ['perm.repOps', 'reports.ops:read'],
  ['perm.export', 'export:run'],
  ['perm.audit', 'audit:read'],
  ['perm.auditAcc', 'audit.accounting:read'],
];

/** ตั้งค่า → ผู้ใช้และสิทธิ์ (ST1-T12) — เชิญผู้ใช้เปิดใน ST1-T07 */
export function UsersSection({ canWrite }: { canWrite: boolean }) {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<'users' | 'matrix'>('users');
  const users = useUsers();
  const roles = useRoles();
  const [inviting, setInviting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(h);
  }, [toast]);
  return (
    <section className="set-card">
      <div className="set-tabs-hd">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2>{t('set.menu.users')}</h2>
          {canWrite && (
            <button type="button" className="set-btn2" onClick={() => setInviting(true)}>
              <Icon n="user-plus" s={16} />
              {t('users.invite')}
            </button>
          )}
        </div>
        <div className="set-tabs" role="tablist">
          {(['users', 'matrix'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
            >
              {t(`users.tab.${k}`)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'users' && (
        <table className="set-tbl">
          <thead>
            <tr>
              <th>{t('users.col.user')}</th>
              <th>{t('users.col.role')}</th>
              <th>{t('users.col.2fa')}</th>
              <th>{t('users.col.last')}</th>
            </tr>
          </thead>
          <tbody>
            {sortUsers(users.data?.data ?? [], roles.data?.data ?? []).map((u) => (
              <tr key={u.id}>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
                    <span style={{ fontWeight: 500 }}>{u.name}</span>
                    <span style={{ color: '#3B424C' }}>{u.email}</span>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {u.roles.map((r) => (
                      <span key={r.id} className="set-chip">
                        {r.name}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  {u.status === 'invited' ? (
                    <Badge label={t('users.invited')} tone="warn" icon="mail" />
                  ) : (
                    <TwoFaBadge on={u.twoFactorEnabled} />
                  )}
                </td>
                <td style={{ color: '#3B424C' }}>
                  {u.lastLoginAt ? formatDateTime(u.lastLoginAt, lang) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'matrix' && (
        <div className="set-scroll">
          <table className="set-tbl">
            <thead>
              <tr>
                <th>{t('users.col.perm')}</th>
                {(roles.data?.data ?? []).map((r) => (
                  <th key={r.id} className="c">
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map(([label, scope]) => (
                <tr key={scope}>
                  <td style={{ whiteSpace: 'nowrap' }}>{t(label)}</td>
                  {(roles.data?.data ?? []).map((r) => (
                    <td key={r.id} className="c">
                      <input
                        type="checkbox"
                        className="set-check"
                        checked={can(r.permissions, scope)}
                        readOnly
                        aria-readonly
                        tabIndex={-1}
                        style={{ pointerEvents: 'none' }}
                        aria-label={`${t(label)} — ${r.name}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {inviting && (
        <InviteDrawer
          roles={roles.data?.data ?? []}
          onClose={() => setInviting(false)}
          onSent={() => {
            setInviting(false);
            setToast(t('users.inviteSent'));
          }}
        />
      )}
      {toast && (
        <div role="status" className="set-toast">
          <span className="set-toast__ic">
            <Icon n="check" s={14} />
          </span>
          <span>{toast}</span>
        </div>
      )}
    </section>
  );
}

/** เรียงผู้ใช้ตามลำดับ role ใน A3 (เจ้าของก่อน) แล้วตามชื่อ */
function sortUsers<U extends { name: string; roles: { code: string }[] }>(
  users: U[],
  roles: { code: string }[],
): U[] {
  const rank = (u: U) =>
    Math.min(
      ...u.roles.map((r) => roles.findIndex((x) => x.code === r.code)).filter((i) => i >= 0),
      99,
    );
  return [...users].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'th'));
}

/**
 * ฟอร์มเชิญผู้ใช้ (ST1-T07) — ต้นแบบมีแค่ปุ่ม + toast "ส่งคำเชิญทางอีเมลแล้ว" [OPEN spec/12 §3]
 * ใช้ Drawer แบบเดียวกับฟอร์มอื่นในตั้งค่า · ส่งต้องยืนยัน 2FA ซ้ำ (มอบ role = มอบสิทธิ์ — A3)
 */
function InviteDrawer({
  roles,
  onClose,
  onSent,
}: {
  roles: { id: string; code: string; name: string }[];
  onClose: () => void;
  onSent: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const me = useMe();
  // มอบ owner ได้เฉพาะ owner (API ตอบ 403 อยู่แล้ว) — ไม่แสดงตัวเลือกให้คนที่มอบไม่ได้
  const ownerName = roles.find((r) => r.code === 'owner')?.name;
  const isOwner = !!ownerName && !!me.data?.user?.roles.includes(ownerName);
  const choices = roles.filter((r) => r.code !== 'owner' || isOwner);
  const [form, setForm] = useState({ email: '', name: '', roles: [] as string[] });
  const [needStepUp, setNeedStepUp] = useState(false);
  // token step-up อายุ 5 นาที — เก็บไว้ใช้ซ้ำ (เชิญไม่สำเร็จแล้วแก้ข้อมูลส่งใหม่ไม่ต้องรอรหัสรอบถัดไป — QA T07 D3)
  const [su, setSu] = useState<{ token: string; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errs = fieldErrors(error, t);
  const top =
    error instanceof ApiError && !error.problem.errors?.length
      ? t(`problem.${error.problem.code}` as MessageKey)
      : error && !(error instanceof ApiError)
        ? t('problem.internal_error')
        : null;

  const send = async (otp?: string) => {
    // เข้าใช้งานแทนแบบอ่านอย่างเดียว: ไม่ขอรหัส 2FA ของลูกค้า (ทีมงานไม่มี) — แจ้งทันที
    if (isImpersonating())
      return setError(
        new ApiError({
          code: 'impersonation_read_only',
          status: 403,
          title: '',
          type: '',
        } as never),
      );
    setBusy(true);
    setError(null);
    try {
      let token = su && Date.now() - su.at < 4 * 60_000 ? su.token : null;
      if (!token) {
        if (!otp) return setNeedStepUp(true);
        token = await stepUp(otp);
        setSu({ token, at: Date.now() });
      }
      await unwrap(
        api.POST('/v1/users/invitations', {
          body: { email: form.email.trim(), name: form.name.trim(), roles: form.roles },
          params: { header: { 'X-Step-Up': token } } as never,
        }),
      );
      void qc.invalidateQueries({ queryKey: ['users'] });
      onSent();
    } catch (e) {
      setError(e);
      setNeedStepUp(false);
      if (e instanceof ApiError && e.problem.code === 'step_up_required') setSu(null);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (su && Date.now() - su.at < 4 * 60_000) void send();
    else setNeedStepUp(true);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('set.menu.users')}
      title={t('users.invite')}
      subtitle={t('users.inviteSub')}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      footer={
        <DrawerFooterButtons
          secondary={[{ label: t('common.cancel'), onClick: onClose }]}
          primary={{
            label: t('users.inviteSend'),
            icon: 'send',
            type: 'submit',
            form: 'invite-form',
            disabled:
              busy || needStepUp || !form.email.trim() || !form.name.trim() || !form.roles.length,
          }}
        />
      }
    >
      {top && (
        <div role="alert" className="set-alert">
          {top}
        </div>
      )}
      <form
        id="invite-form"
        onSubmit={submit}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <Field label={t('login.email')} error={errs.email}>
          {(a) => (
            <TextInput
              {...a}
              type="email"
              value={form.email}
              placeholder={t('login.emailPh')}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('users.inviteName')} error={errs.name}>
          {(a) => (
            <TextInput
              {...a}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="tms-label" style={{ marginBottom: 6 }}>
            {t('users.col.role')}
          </legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {choices.map((r) => (
              <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="checkbox"
                  className="set-check"
                  checked={form.roles.includes(r.code)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      roles: e.target.checked
                        ? [...form.roles, r.code]
                        : form.roles.filter((c) => c !== r.code),
                    })
                  }
                />
                {r.name}
              </label>
            ))}
          </div>
          {errs.roles && <span className="tms-field-error">{errs.roles}</span>}
        </fieldset>
        {needStepUp && (
          <StepUpBox onConfirm={(otp) => void send(otp)} onCancel={() => setNeedStepUp(false)} />
        )}
      </form>
    </Drawer>
  );
}
