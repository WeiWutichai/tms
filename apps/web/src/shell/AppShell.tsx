import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, queryClient, unwrap } from '../api';
import { logout } from '../auth/session';
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
  const applied = useRef(false);
  useEffect(() => {
    const l = me.data?.user?.locale as 'th' | 'en' | 'zh' | undefined;
    if (!l || applied.current) return;
    applied.current = true;
    if (l !== lang) setLang(l);
  }, [me.data, lang, setLang]);
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
    </div>
  );
}
