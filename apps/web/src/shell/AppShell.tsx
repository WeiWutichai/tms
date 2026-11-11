import { useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, queryClient, unwrap } from '../api';
import { dropAccessToken, endImpersonation, logout } from '../auth/session';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { featureOf, isLocked, pageOf } from '../nav';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import './shell.css';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/v1/me')) });
}

/** โครงหน้า — <div display:flex; background:#EEF0EC; min-width:1280px> ของต้นแบบ */
export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [mini, setMini] = useState(false);
  const loc = useLocation();
  const me = useMe();
  // ST1-T09: ใช้ภาษาจากโปรไฟล์ของผู้ใช้หลัง login (ครั้งเดียวต่อการโหลดหน้า)
  const { setLang, lang } = useI18n();
  // ใช้ค่าที่ดึงจาก server แล้วเท่านั้น (ไม่ใช่ cache เก่า) และครั้งเดียวต่อผู้ใช้ (เปลี่ยนคน = ใช้ภาษาของคนใหม่)
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    const l = me.data?.user?.locale as 'th' | 'en' | 'zh' | undefined;
    if (!l || me.isFetching || appliedFor.current === me.data!.actorId) return;
    appliedFor.current = me.data!.actorId;
    if (l !== lang) setLang(l);
  }, [me.data, me.isFetching, lang, setLang]);
  const navigate = useNavigate();
  const page = pageOf(loc.pathname);
  // หน้าโมดูลนอกแพ็กเกจ: หัวหน้าเป็น "แพ็กเกจ > ชื่อโมดูล" ตาม META locked ของต้นแบบ (ST1-T18)
  const feature = featureOf(loc.pathname);
  const locked = isLocked(feature, me.data?.features);
  const groupLabel = locked
    ? t('lock.group')
    : page
      ? t(`page.${page}.group` as MessageKey)
      : t('shell.main');
  const title = locked
    ? t(`lock.${feature}.t` as MessageKey)
    : page
      ? t(`page.${page}.title` as MessageKey)
      : '';
  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: '#EEF0EC',
        minWidth: 1280,
        width: '100%',
      }}
    >
      <Sidebar
        mini={mini}
        onToggle={() => setMini((m) => !m)}
        tenantName={me.data?.tenant.name ?? '…'}
        actor={me.data?.user?.name ?? me.data?.actorId ?? '…'}
        role={me.data?.user?.roles[0]}
        scopes={me.data?.scopes ?? []}
        features={me.data?.features}
        onLogout={() => {
          void logout().then(() => {
            queryClient.clear();
            navigate('/login', { replace: true });
          });
        }}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Header
          group={groupLabel}
          title={title}
          yearStyle={(me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE'}
        />
        <main
          style={{
            flex: 1,
            width: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          {children}
        </main>
      </div>
      {me.data?.impersonation && (
        <ImpersonationBanner
          tenant={me.data.tenant.name}
          user={me.data.user?.name ?? me.data.actorId}
          expiresAt={me.data.impersonation.expiresAt}
          onExit={() => {
            void endImpersonation().then(() => {
              queryClient.clear();
              window.close(); // แท็บที่ Console เปิดให้ — ปิดได้; ปิดไม่ได้ก็ไปหน้าเข้าสู่ระบบ
              navigate('/login', { replace: true });
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * แถบส้มระหว่างเข้าใช้งานแทน (ST1-T24) — หน้าตาตาม bn.imp ของ TMS v4 (ปุ่มลอยกลางล่าง #8F5500)
 * ข้อความเพิ่ม "ในนาม {ผู้ใช้} · เหลือ {mm} นาที" ตาม spec/01 §11 — [OPEN spec/12 §3] ต้นแบบลอยล่าง / spec ว่า "ติดบนสุด"
 */
function ImpersonationBanner({
  tenant,
  user,
  expiresAt,
  onExit,
}: {
  tenant: string;
  user: string;
  expiresAt: string;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const left = () => Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 60_000));
  const [mins, setMins] = useState(left);
  useEffect(() => {
    const id = setInterval(() => {
      setMins(left());
      // หมดเวลา → token ใช้ไม่ได้แล้ว: ออกจาก session (guard พาไปหน้าเข้าสู่ระบบ)
      if (Date.parse(expiresAt) <= Date.now()) dropAccessToken();
    }, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);
  return (
    <div
      role="status"
      aria-label={t('imp.label')}
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 16,
        transform: 'translateX(-50%)',
        zIndex: 95,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 40,
        padding: '0 8px 0 16px',
        borderRadius: 999,
        background: '#8F5500',
        color: '#FFFFFF',
        boxShadow: '0 8px 24px rgba(16,20,24,.24)',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon n="user-cog" s={16} />
      <span style={{ fontWeight: 600 }}>{t('imp.banner', { tenant, user })}</span>
      <span style={{ opacity: 0.85 }}>{t('imp.bannerSub', { m: mins })}</span>
      <button
        type="button"
        onClick={onExit}
        style={{
          height: 28,
          padding: '0 12px',
          border: 0,
          borderRadius: 999,
          background: '#FFFFFF',
          color: '#8F5500',
          cursor: 'pointer',
          font: 'inherit',
          fontWeight: 600,
        }}
      >
        {t('imp.exit')}
      </button>
    </div>
  );
}
