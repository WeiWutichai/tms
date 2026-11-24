import {
  Badge,
  Drawer,
  DrawerFooterButtons,
  Field,
  Icon,
  ReasonDialog,
  TextInput,
  useEscapeLayer,
} from '@tms/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, unwrap } from '../../api';
import { formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { stepUpHeaders, withStepUp } from '../stepup/stepUp';
import type { Role, User } from './useSettings';

/**
 * PO 24 พ.ย. 2569 "ตัวที่รอ claude design ไม่ต้องรอ ทำขึ้นมาเลย อิงจากโครงสร้างหลัก" — ต้นแบบ TMS v4 (ตั้งค่า → ผู้ใช้และสิทธิ์)
 * ไม่มีเมนูต่อแถว จึงประกอบจากชิ้นเดิม [DECISION spec/12 §3]:
 * - ปุ่ม ⋮ + เมนู `tms-rowmenu` ของ DataTable (ตารางมาตรฐานทุกหน้า)
 * - ระงับ / เปิดใช้ / ลบ / รีเซ็ต 2FA / เพิกถอนคำเชิญ = `ReasonDialog` (เหตุผลบังคับ — ลง audit)
 * - รีเซ็ต 2FA / เปลี่ยนบทบาท ต้อง step-up (D-67 / A3) → กล่องยืนยัน 2FA กลาง (`withStepUp` + StepUpHost)
 * - เปลี่ยนบทบาท = Drawer แบบเดียวกับ "เชิญผู้ใช้" (checkbox role ตาม A3) + ช่องเหตุผล
 * - ประวัติเข้าสู่ระบบ = แท็บที่ 3 ของการ์ด ใช้ตาราง `set-tbl` เดิม
 */

export type Invitation = {
  id: string;
  userId: string;
  status: 'pending' | 'expired';
};

export function useInvitations(enabled: boolean) {
  return useQuery({
    queryKey: ['users', 'invitations'],
    queryFn: () => unwrap(api.GET('/v1/users/invitations')),
    enabled,
  });
}

type Act = 'suspend' | 'activate' | 'delete' | 'reset2fa' | 'revoke';

export type MenuItem = { label: string; icon: string; run: () => void };

/** รายการเมนูของแถว — ตามสถานะผู้ใช้ (API ตรวจซ้ำ: ทำกับตัวเองไม่ได้, owner จัดการได้เฉพาะ owner) */
export function userMenu(
  u: User,
  o: {
    t: (k: MessageKey) => string;
    canWrite: boolean;
    self: boolean;
    /** เป้าหมายเป็นเจ้าของ แต่ผู้ทำไม่ใช่เจ้าของ */
    ownerLocked?: boolean;
    invitation?: Invitation;
    open: (a: Act | 'roles' | 'resend' | 'history') => void;
  },
): MenuItem[] {
  const { t, self, invitation, open } = o;
  const canWrite = o.canWrite && !o.ownerLocked;
  const m: MenuItem[] = [];
  if (u.status === 'invited') {
    if (canWrite && invitation) {
      m.push({ label: t('users.menu.resend'), icon: 'send', run: () => open('resend') });
      m.push({ label: t('users.menu.revoke'), icon: 'circle-x', run: () => open('revoke') });
    }
    return m;
  }
  if (canWrite && !self) {
    if (u.status === 'active')
      m.push({ label: t('users.menu.roles'), icon: 'shield', run: () => open('roles') });
    if (u.twoFactorEnabled)
      m.push({ label: t('users.menu.reset2fa'), icon: 'key-round', run: () => open('reset2fa') });
    if (u.status === 'active')
      m.push({ label: t('users.menu.suspend'), icon: 'ban', run: () => open('suspend') });
    if (u.status === 'disabled')
      m.push({
        label: t('users.menu.activate'),
        icon: 'circle-check',
        run: () => open('activate'),
      });
  }
  m.push({ label: t('users.menu.history'), icon: 'history', run: () => open('history') });
  if (canWrite && !self)
    m.push({ label: t('users.menu.delete'), icon: 'trash-2', run: () => open('delete') });
  return m;
}

/** ปุ่ม ⋮ + เมนูลอย — คลาสเดียวกับ DataTable (`tms-rowmenu-btn` / `tms-rowmenu`) */
export function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  useEscapeLayer(open, () => setOpen(false));
  if (!items.length) return null;
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="tms-rowmenu-btn"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <Icon n="ellipsis-vertical" s={18} />
      </button>
      {open && (
        <div className="tms-rowmenu" style={{ top: 36, right: 0 }} role="menu">
          {items.map((m) => (
            <button
              key={m.label}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                m.run();
              }}
            >
              <Icon n={m.icon} s={16} style={{ color: '#59606B' }} />
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ACT: Record<
  Act,
  { title: MessageKey; desc: MessageKey; ok: MessageKey; icon: string; done: MessageKey }
> = {
  suspend: {
    title: 'users.dlg.suspendT',
    desc: 'users.dlg.suspendD',
    ok: 'users.menu.suspend',
    icon: 'ban',
    done: 'users.done.suspend',
  },
  activate: {
    title: 'users.dlg.activateT',
    desc: 'users.dlg.activateD',
    ok: 'users.menu.activate',
    icon: 'circle-check',
    done: 'users.done.activate',
  },
  delete: {
    title: 'users.dlg.deleteT',
    desc: 'users.dlg.deleteD',
    ok: 'users.menu.delete',
    icon: 'trash-2',
    done: 'users.done.delete',
  },
  reset2fa: {
    title: 'users.dlg.reset2faT',
    desc: 'users.dlg.reset2faD',
    ok: 'users.menu.reset2fa',
    icon: 'key-round',
    done: 'users.done.reset2fa',
  },
  revoke: {
    title: 'users.dlg.revokeT',
    desc: 'users.dlg.revokeD',
    ok: 'users.menu.revoke',
    icon: 'circle-x',
    done: 'users.done.revoke',
  },
};

/** dialog เหตุผลของการกระทำต่อผู้ใช้ — สำเร็จ → โหลดรายการใหม่ + toast */
export function UserActionDialog({
  act,
  user,
  invitation,
  onClose,
  onDone,
}: {
  act: Act | null;
  user: User | null;
  invitation?: Invitation;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: async ({ a, u, reason }: { a: Act; u: User; reason: string }) => {
      const p = { params: { path: { id: u.id } }, body: { reason } };
      if (a === 'suspend') return unwrap(api.POST('/v1/users/{id}/suspend', p));
      if (a === 'activate') return unwrap(api.POST('/v1/users/{id}/activate', p));
      if (a === 'delete') return unwrap(api.POST('/v1/users/{id}/delete', p));
      if (a === 'revoke')
        return unwrap(
          api.POST('/v1/users/invitations/{id}/revoke', {
            params: { path: { id: invitation!.id } },
            body: { reason },
          }),
        );
      // D-67: รีเซ็ต 2FA ของผู้อื่นต้อง step-up เสมอ → กล่องยืนยัน 2FA กลาง แล้วส่งซ้ำพร้อม token
      return withStepUp((tok) =>
        unwrap(
          api.POST('/v1/users/{id}/reset-2fa', {
            params: { path: { id: u.id }, header: stepUpHeaders(tok) } as never,
            body: { reason },
          }),
        ),
      );
    },
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onDone(t(ACT[v.a].done, { n: v.u.name }));
    },
  });
  const c = act ? ACT[act] : null;
  return (
    <ReasonDialog
      open={!!act && !!user}
      title={c && user ? t(c.title, { n: user.name }) : ''}
      description={c ? t(c.desc) : undefined}
      label={t('users.reason')}
      placeholder={t('users.reasonPh')}
      okLabel={c ? t(c.ok) : ''}
      okIcon={c?.icon}
      cancelLabel={t('common.cancel')}
      closeLabel={t('drawer.close')}
      busy={run.isPending}
      error={problemText(run.error, t)}
      onClose={() => {
        run.reset();
        onClose();
      }}
      onOk={(reason) => act && user && run.mutate({ a: act, u: user, reason })}
    />
  );
}

/** ส่งคำเชิญใหม่ (ไม่ต้องมีเหตุผล — API ไม่รับ) */
export function useResendInvitation(onDone: (msg: string) => void) {
  const { t } = useI18n();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { inv: Invitation; name: string }) =>
      unwrap(api.POST('/v1/users/invitations/{id}/resend', { params: { path: { id: v.inv.id } } })),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onDone(t('users.done.resend', { n: v.name }));
    },
    onError: (e) => onDone(problemText(e, t) ?? t('problem.internal_error')),
  });
}

/** เปลี่ยนบทบาท — Drawer แบบ "เชิญผู้ใช้" (checkbox role ตาม A3) + เหตุผล · step-up ทุกครั้ง (มอบสิทธิ์ — A3) */
export function RolesDrawer({
  user,
  roles,
  isOwner,
  onClose,
  onDone,
}: {
  user: User;
  roles: Role[];
  isOwner: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [sel, setSel] = useState<string[]>(user.roles.map((r) => r.code));
  const [reason, setReason] = useState('');
  // มอบ/ถอน owner ได้เฉพาะ owner (API ตอบ 403) — ไม่แสดงตัวเลือกให้คนที่ทำไม่ได้
  const choices = roles.filter((r) => r.code !== 'owner' || isOwner);
  const save = useMutation({
    mutationFn: () =>
      withStepUp((tok) =>
        unwrap(
          api.PUT('/v1/users/{id}/roles', {
            params: { path: { id: user.id }, header: stepUpHeaders(tok) } as never,
            body: { roles: sel, reason: reason.trim() },
          }),
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onDone(t('users.done.roles', { n: user.name }));
    },
  });
  const same = sel.length === user.roles.length && user.roles.every((r) => sel.includes(r.code));
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('set.menu.users')}
      title={user.name}
      subtitle={t('users.rolesSub')}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      footer={
        <DrawerFooterButtons
          secondary={[{ label: t('common.cancel'), onClick: onClose }]}
          primary={{
            label: t('users.rolesSave'),
            icon: 'check',
            onClick: () => save.mutate(),
            disabled: save.isPending || same || !sel.length || reason.trim().length < 10,
          }}
        />
      }
    >
      {save.error && problemText(save.error, t) && (
        <div role="alert" className="set-alert">
          {problemText(save.error, t)}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span style={{ color: '#3B424C' }}>{user.email}</span>
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
                  checked={sel.includes(r.code)}
                  onChange={(e) =>
                    setSel(e.target.checked ? [...sel, r.code] : sel.filter((c) => c !== r.code))
                  }
                />
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('users.reason')}>
          {(a) => (
            <TextInput
              {...a}
              value={reason}
              placeholder={t('users.reasonPh')}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Drawer>
  );
}

/** ผลของแถวประวัติ — ป้ายแบบเดียวกับคอลัมน์ 2FA */
function ResultBadge({ r }: { r: 'success' | 'failed' | 'locked' }) {
  const { t } = useI18n();
  if (r === 'success') return <Badge label={t('users.hist.success')} tone="ok" icon="check" />;
  if (r === 'locked') return <Badge label={t('users.hist.locked')} tone="err" icon="lock" />;
  return <Badge label={t('users.hist.failed')} tone="warn" icon="x" />;
}

/** แท็บ "ประวัติเข้าสู่ระบบ" (ST1-T11) — `GET /v1/login-history` (users:read) แบ่งหน้าแบบ cursor → ปุ่ม "โหลดเพิ่ม" */
export function LoginHistory({
  users,
  userId,
  onUser,
}: {
  users: User[];
  userId: string;
  onUser: (id: string) => void;
}) {
  const { t, lang } = useI18n();
  const q = useInfiniteQuery({
    queryKey: ['login-history', userId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/login-history', {
          params: {
            query: {
              limit: 50,
              ...(userId ? { userId } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (p) => (p.hasMore ? (p.nextCursor ?? undefined) : undefined),
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const reason = (r: string) => {
    const k = `users.hist.r.${r}` as MessageKey;
    return t(k) === k ? r : t(k);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, alignSelf: 'flex-start' }}>
        <span className="tms-label">{t('users.hist.user')}</span>
        <select
          className="set-select"
          value={userId}
          aria-label={t('users.hist.user')}
          onChange={(e) => onUser(e.target.value)}
        >
          <option value="">{t('users.hist.all')}</option>
          {users
            .filter((u) => u.status !== 'invited')
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.email}
              </option>
            ))}
        </select>
      </label>
      {q.error ? (
        <div role="alert" className="set-alert">
          {problemText(q.error, t)}
        </div>
      ) : null}
      <div className="set-scroll">
        <table className="set-tbl" aria-label={t('users.tab.hist')}>
          <thead>
            <tr>
              <th>{t('users.hist.col.at')}</th>
              <th>{t('users.hist.col.user')}</th>
              <th>{t('users.hist.col.result')}</th>
              <th>{t('users.hist.col.reason')}</th>
              <th>{t('users.hist.col.ip')}</th>
              <th>{t('users.hist.col.ua')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.at}-${i}`}>
                <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {formatDateTime(r.at, lang)}
                </td>
                <td>{r.email}</td>
                <td>
                  <ResultBadge r={r.result} />
                </td>
                <td style={{ color: '#3B424C' }}>{reason(r.reason)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.ip}</td>
                <td
                  style={{
                    color: '#3B424C',
                    maxWidth: 260,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={r.userAgent ?? undefined}
                >
                  {r.userAgent ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.isLoading && <span style={{ color: '#3B424C' }}>{t('table.loading')}</span>}
      {!q.isLoading && !q.error && !rows.length && (
        <span style={{ color: '#3B424C' }}>{t('users.hist.empty')}</span>
      )}
      {q.hasNextPage && (
        <button
          type="button"
          className="set-btn2"
          style={{ alignSelf: 'center' }}
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          {t('users.hist.more')}
        </button>
      )}
    </div>
  );
}
