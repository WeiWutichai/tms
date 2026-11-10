import { Badge, EmptyState, Icon } from '@tms/ui';
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can, canAny } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { PageHeader } from '../../shell/Header';
import { EntitiesSection } from './Entities';
import { NumbersSection } from './Numbers';
import { UsersSection } from './Users';
import './settings.css';

/**
 * เมนูหน้า "ตั้งค่า" — ลำดับ/ไอคอนตาม vSet() ของต้นแบบ
 * เฉพาะหัวข้อในเฟส 0 (นักพัฒนา/Open API, ฟิลด์เพิ่มเติม, AI, วงเงินอนุมัติซ่อม, แพ็กเกจ อยู่นอกเฟส — PLAN.md §3)
 * `stage` = งานที่ทำหัวข้อนั้น (หัวข้อที่ยังไม่ทำแสดง "ยังไม่เปิดใช้")
 */
const SECTIONS: Array<{ k: string; icon: string; perm: string[]; stage?: string }> = [
  { k: 'org', icon: 'building-2', perm: ['settings:read'], stage: 'ST1-T17' },
  { k: 'ent', icon: 'landmark', perm: ['settings:read'] },
  { k: 'num', icon: 'hash', perm: ['settings:read'] },
  { k: 'users', icon: 'users', perm: ['users:read'] },
  { k: 'tax', icon: 'percent', perm: ['settings:read'], stage: 'ST1-T17' },
  { k: 'conn', icon: 'plug', perm: ['settings:read'], stage: 'ST7' },
  { k: 'noti', icon: 'bell', perm: ['settings:read'], stage: 'ST1-T23' },
  { k: 'reason', icon: 'list-checks', perm: ['settings:read'], stage: 'ST2' },
  { k: 'sec', icon: 'shield', perm: ['settings:read'], stage: 'ST1-T05' },
  { k: 'docalert', icon: 'bell-ring', perm: ['settings:read'], stage: 'ST2' },
];

export function SettingsPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const [params, setParams] = useSearchParams();
  const menu = SECTIONS.filter((s) => canAny(scopes, s.perm));
  const sec = menu.find((s) => s.k === params.get('sec')) ?? menu[0];
  const canWrite = can(scopes, 'settings:write');

  return (
    <>
      <PageHeader title={t('page.settings.title')} sub={t('page.settings.sub')} />
      <div className="set-grid">
        <nav className="set-menu" aria-label={t('page.settings.title')}>
          {menu.map((s) => (
            <button
              key={s.k}
              type="button"
              aria-current={s.k === sec?.k ? 'page' : undefined}
              onClick={() => setParams({ sec: s.k }, { replace: true })}
            >
              <Icon n={s.icon} s={16} />
              {t(`set.menu.${s.k}` as MessageKey)}
            </button>
          ))}
        </nav>
        <div className="set-body">
          {sec?.k === 'ent' && <EntitiesSection canWrite={canWrite} />}
          {sec?.k === 'num' && <NumbersSection canWrite={canWrite} />}
          {sec?.k === 'users' && <UsersSection canWrite={can(scopes, 'users:write')} />}
          {sec?.stage && (
            <section className="set-card">
              <div className="set-card__hd">
                <h2>{t(`set.menu.${sec.k}` as MessageKey)}</h2>
              </div>
              <EmptyState
                icon="construction"
                title={t('empty.notReady.title')}
                description={t('set.notReady', { stage: sec.stage })}
              />
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/** สวิตช์แบบต้นแบบ (38×22) */
export function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="set-toggle"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
    >
      <span />
    </button>
  );
}

/** ป้าย 2FA ของต้นแบบ ("เปิด 2FA" / "ยังไม่เปิด 2FA") */
export function TwoFaBadge({ on }: { on: boolean }) {
  const { t } = useI18n();
  return <Badge label={on ? t('users.2faOn') : t('users.2faOff')} />;
}
