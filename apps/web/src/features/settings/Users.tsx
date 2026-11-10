import { Icon } from '@tms/ui';
import { useState } from 'react';
import { formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { TwoFaBadge } from './Settings';
import { useRoles, useUsers } from './useSettings';

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
  return (
    <section className="set-card">
      <div className="set-tabs-hd">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2>{t('set.menu.users')}</h2>
          {canWrite && (
            <button
              type="button"
              className="set-btn2"
              disabled
              title={t('set.notReady', { stage: 'ST1-T07' })}
            >
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
                  <TwoFaBadge on={u.twoFactorEnabled} />
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
