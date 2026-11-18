import { Badge, EmptyState, Icon } from '@tms/ui';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can, canAny } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { PageHeader } from '../../shell/Header';
import { ConnectorSettingsSection } from './ConnectorSettings';
import { EntitiesSection } from './Entities';
import { NotificationsSection } from './Notifications';
import { NumbersSection } from './Numbers';
import { OrgSection, SecuritySection, TaxSection } from './OrgSections';
import { ReasonsSection } from './Reasons';
import { PodSection } from '../pod/PodSection';
import { UsersSection } from './Users';
import './settings.css';

/**
 * เมนูหน้า "ตั้งค่า" — ลำดับ/ไอคอนตาม vSet() ของต้นแบบ
 * เฉพาะหัวข้อในเฟส 0 (ฟิลด์เพิ่มเติม, AI, วงเงินอนุมัติซ่อม, แพ็กเกจ อยู่นอกเฟส — PLAN.md §3)
 * `stage` = งานที่ทำหัวข้อนั้น (หัวข้อที่ยังไม่ทำแสดง "ยังไม่เปิดใช้")
 */
export const SECTIONS: Array<{
  k: string;
  icon: string;
  perm?: string[];
  stage?: string;
  go?: string;
}> = [
  { k: 'org', icon: 'building-2', perm: ['settings:read'] },
  { k: 'ent', icon: 'landmark', perm: ['settings:read'] },
  { k: 'num', icon: 'hash', perm: ['settings:read'] },
  { k: 'users', icon: 'users', perm: ['users:read'] },
  { k: 'tax', icon: 'percent', perm: ['settings:read'] },
  // ST7-T20: การ์ดระบบบัญชี + ตั้งค่า connector (ต้นแบบ st.is.conn)
  { k: 'conn', icon: 'plug', perm: ['settings:read'] },
  // ST7-T01: ต้นแบบ vSet — กดแล้วไปหน้า "นักพัฒนา / Open API" (this.go('api')) · เห็นเฉพาะผู้ดูแล (canDev)
  { k: 'api', icon: 'code-xml', perm: ['settings:write'], go: '/settings/api' },
  // ST9-T08: ค่ารับแจ้งเตือนของผู้ใช้เอง (docs/04 I) — ทุก role ที่เข้าหน้าตั้งค่าได้ (ไม่ต้องมี settings:read) [DECISION spec/12 §3]
  { k: 'noti', icon: 'bell' },
  // ST2-T12: เหตุผลเป็นข้อมูลหลัก (docs/04 A3 แถว Master data) — อ่าน master:read แก้ master:write
  { k: 'reason', icon: 'list-checks', perm: ['master:read'] },
  // ST4-T05: POD checklist ค่าเริ่มต้น (docs/04 I) — ต้นแบบไม่มีหัวข้อนี้ [DECISION spec/12 §3] วางต่อจาก เหตุผล (งานหน้างาน)
  { k: 'pod', icon: 'clipboard-check', perm: ['settings:read'] },
  { k: 'sec', icon: 'shield', perm: ['settings:read'] },
  { k: 'docalert', icon: 'bell-ring', perm: ['settings:read'], stage: 'ST2' },
];

export function SettingsPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const [params, setParams] = useSearchParams();
  const go = useNavigate();
  const menu = SECTIONS.filter((s) => canAny(scopes, s.perm));
  const sec = menu.find((s) => s.k === params.get('sec') && !s.go) ?? menu[0];
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
              onClick={() => (s.go ? go(s.go) : setParams({ sec: s.k }, { replace: true }))}
            >
              <Icon n={s.icon} s={16} />
              {t(`set.menu.${s.k}` as MessageKey)}
            </button>
          ))}
        </nav>
        <div className="set-body">
          {sec?.k === 'org' && <OrgSection canWrite={canWrite} />}
          {sec?.k === 'tax' && <TaxSection canWrite={canWrite} />}
          {sec?.k === 'sec' && <SecuritySection canWrite={canWrite} />}
          {sec?.k === 'ent' && <EntitiesSection canWrite={canWrite} />}
          {sec?.k === 'num' && <NumbersSection canWrite={canWrite} />}
          {sec?.k === 'users' && <UsersSection canWrite={can(scopes, 'users:write')} />}
          {sec?.k === 'reason' && <ReasonsSection canWrite={can(scopes, 'master:write')} />}
          {sec?.k === 'pod' && <PodSection canWrite={canWrite} />}
          {sec?.k === 'noti' && <NotificationsSection />}
          {sec?.k === 'conn' && <ConnectorSettingsSection canWrite={canWrite} />}
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
