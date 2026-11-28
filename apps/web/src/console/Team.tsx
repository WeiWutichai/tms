import type { components } from '@tms/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useEffect, useState } from 'react';
import { queryClient } from '../api';
import { formatDate, formatDateTime, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { ROLE_LABEL } from './ConsoleShell';
import { ActionDialog } from './Tenants';
import {
  can,
  consoleApi,
  consoleStepUpHeaders,
  cunwrap,
  useStaff,
  type StaffRole,
} from './session';

type Staff = components['schemas']['PlatformStaffDto'];
const ROLES: StaffRole[] = ['SUPER_ADMIN', 'SUPPORT', 'BILLING'];

/** tone ของป้ายบทบาท — soft() ของต้นแบบ { owner: info, support: warn, finance: off } → บทบาท docs/04 A6 */
const ROLE_TONE: Record<StaffRole, { c: string; bg: string; i: string }> = {
  SUPER_ADMIN: { c: '#2257C4', bg: '#E9F0FA', i: 'info' },
  SUPPORT: { c: '#8F5500', bg: '#FCF0DC', i: 'circle-alert' },
  BILLING: { c: '#59606B', bg: '#EEF0EC', i: 'circle' },
};
const STATUS_TONE: Record<string, { c: string; bg: string; i: string }> = {
  active: { c: '#17733F', bg: '#E7F3EC', i: 'circle-check' },
  invited: { c: '#8F5500', bg: '#FCF0DC', i: 'circle-alert' },
  disabled: { c: '#59606B', bg: '#EEF0EC', i: 'circle' },
};

function Soft({ tone, label }: { tone: { c: string; bg: string; i: string }; label: string }) {
  return (
    <span className="con-badge" style={{ background: tone.bg, color: tone.c }}>
      <Icon n={tone.i} s={12} strokeWidth={1.8} />
      {label}
    </span>
  );
}

export function useTeam() {
  return useQuery({
    queryKey: ['console', 'team'],
    queryFn: () => cunwrap(consoleApi.GET('/v1/platform/team')),
  });
}

/** หน้า "ทีมงาน" (pg === 'team' ในต้นแบบ Platform Console) — ตาราง + เชิญ/ปิด (SUPER_ADMIN) */
export function TeamPage() {
  const { t, lang } = useI18n();
  const role = useStaff().data?.role;
  const me = useStaff().data?.email;
  const team = useTeam();
  const [inviting, setInviting] = useState<Staff | true | null>(null);
  const [closing, setClosing] = useState<Staff | null>(null);
  const [toast, setToast] = useState('');
  const manage = can.team(role);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 3400);
    return () => clearTimeout(h);
  }, [toast]);

  const rows = team.data ?? [];
  const cols: MessageKey[] = [
    'con.team.col.name',
    'con.team.col.role',
    'con.team.col.perm',
    'con.team.col.last',
    'con.team.col.tfa',
    'con.team.col.status',
  ];

  return (
    <>
      <div className="con-title">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{t('con.team.title')}</h1>
          <p>{t('con.team.sub')}</p>
        </div>
        {manage && (
          <button type="button" className="con-act con-act--pri" onClick={() => setInviting(true)}>
            <Icon n="user-plus" s={16} strokeWidth={1.8} />
            {t('con.team.invite')}
          </button>
        )}
      </div>
      <section className="con-card">
        <table className="con-tbl con-tbl--static">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{t(c)}</th>
              ))}
              {manage && <th aria-hidden="true" />}
            </tr>
          </thead>
          <tbody>
            {team.isLoading
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={i} aria-hidden="true">
                    {[160, 70, 220, 110, 60, 70].map((w, j) => (
                      <td key={j}>
                        <span className="con-skel" style={{ width: w }} />
                      </td>
                    ))}
                    {manage && <td />}
                  </tr>
                ))
              : rows.map((m) => {
                  const r = m.role as StaffRole;
                  return (
                    <tr key={m.id}>
                      <td>
                        <div className="con-cell">
                          <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{m.name}</span>
                          <span className="con-cell__sub">{m.email}</span>
                        </div>
                      </td>
                      <td>
                        <Soft tone={ROLE_TONE[r] ?? ROLE_TONE.BILLING} label={t(ROLE_LABEL[r])} />
                      </td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {t(`con.team.perm.${r}` as MessageKey)}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {m.lastLoginAt ? formatDateTime(m.lastLoginAt, lang) : '—'}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {m.twoFactorEnabled ? t('con.team.tfa.on') : t('con.team.tfa.off')}
                      </td>
                      <td>
                        <div className="con-cell">
                          <span>
                            <Soft
                              tone={STATUS_TONE[m.status] ?? STATUS_TONE.disabled!}
                              label={t(`con.team.st.${m.status}` as MessageKey)}
                            />
                          </span>
                          {m.status === 'invited' && m.inviteExpiresAt && (
                            <span className="con-cell__sub">
                              {t('con.team.expires', {
                                d: formatDate(new Date(m.inviteExpiresAt), lang),
                              })}
                            </span>
                          )}
                        </div>
                      </td>
                      {manage && (
                        <td style={{ textAlign: 'right' }}>
                          {m.status === 'disabled' ? (
                            <button
                              type="button"
                              className="con-rowbtn"
                              onClick={() => setInviting(m)}
                            >
                              {t('con.team.reinvite')}
                            </button>
                          ) : m.email !== me ? (
                            <button
                              type="button"
                              className="con-rowbtn con-rowbtn--danger"
                              onClick={() => setClosing(m)}
                            >
                              {t('con.team.deactivate')}
                            </button>
                          ) : null}
                        </td>
                      )}
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {team.isError && <div className="con-empty">{t('con.loadFailed')}</div>}
        {!team.isLoading && !team.isError && !rows.length && (
          <div className="con-empty">{t('con.team.empty')}</div>
        )}
      </section>
      {inviting && (
        <InviteDialog
          staff={inviting === true ? null : inviting}
          onClose={() => setInviting(null)}
          onDone={(s) => {
            setInviting(null);
            setToast(t('con.team.toast.invited', { e: s.email }));
          }}
        />
      )}
      {closing && (
        <DeactivateDialog
          staff={closing}
          onClose={() => setClosing(null)}
          onDone={(s) => {
            setClosing(null);
            setToast(t('con.team.toast.deactivated', { n: s.name }));
          }}
        />
      )}
      {toast && (
        <div className="con-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

/** เชิญทีมงาน (ต้นแบบ: ปุ่ม "เชิญทีมงาน" — dialog ประกอบจาก vAct: ช่อง + เหตุผล + ยืนยัน 2FA ของ Console D-77) */
function InviteDialog({
  staff,
  onClose,
  onDone,
}: {
  staff: Staff | null;
  onClose: () => void;
  onDone: (s: Staff) => void;
}) {
  const { t } = useI18n();
  const invite = useMutation({
    mutationFn: (body: components['schemas']['InviteStaffDto']) =>
      cunwrap(
        consoleApi.POST('/v1/platform/team/invitations', {
          params: { header: consoleStepUpHeaders() } as never,
          body,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['console', 'team'] }),
  });
  return (
    <ActionDialog
      title={staff ? `${t('con.team.reinvite')} · ${staff.name}` : t('con.team.invite')}
      desc={t('con.team.inviteD')}
      stepUpFirst
      fields={[
        { k: 'name', l: 'con.team.f.name', type: 'in' },
        { k: 'email', l: 'con.team.f.email', type: 'in', im: 'email' },
        {
          k: 'role',
          l: 'con.team.f.role',
          type: 'sel',
          opts: ROLES.map((r) => ({
            v: r,
            l: `${t(ROLE_LABEL[r])} · ${t(`con.team.perm.${r}` as MessageKey)}`,
          })),
        },
      ]}
      init={{
        name: staff?.name ?? '',
        email: staff?.email ?? '',
        role: staff?.role ?? 'SUPPORT',
      }}
      okL={t('con.team.invite')}
      check={(v) => (v.name?.trim() && v.email?.trim() ? '' : t('con.team.f.required'))}
      onClose={onClose}
      onOk={async (v, reason) => {
        const s = await invite.mutateAsync({
          name: v.name!.trim(),
          email: v.email!.trim(),
          role: v.role as StaffRole,
          reason,
        });
        onDone(s);
      }}
    />
  );
}

/** ปิดทีมงาน — session หลุดทันที (API bump tokenVersion) · เหตุผล + ยืนยัน 2FA */
function DeactivateDialog({
  staff,
  onClose,
  onDone,
}: {
  staff: Staff;
  onClose: () => void;
  onDone: (s: Staff) => void;
}) {
  const { t } = useI18n();
  const close = useMutation({
    mutationFn: (reason: string) =>
      cunwrap(
        consoleApi.POST('/v1/platform/team/{id}/deactivate', {
          params: { path: { id: staff.id }, header: consoleStepUpHeaders() } as never,
          body: { reason },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['console', 'team'] }),
  });
  return (
    <ActionDialog
      title={t('con.team.deactivateT', { n: staff.name })}
      desc={t('con.team.deactivateD')}
      warn={t('con.team.deactivateW')}
      danger
      stepUpFirst
      okL={t('con.team.deactivate')}
      onClose={onClose}
      onOk={async (_v, reason) => {
        onDone(await close.mutateAsync(reason));
      }}
    />
  );
}
