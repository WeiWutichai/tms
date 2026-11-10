import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, queryClient, unwrap } from '../api';
import { logout } from '../auth/session';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { pageOf } from '../nav';
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
  const navigate = useNavigate();
  const page = pageOf(loc.pathname);
  const groupLabel = page ? t(`page.${page}.group` as MessageKey) : t('shell.main');
  const title = page ? t(`page.${page}.title` as MessageKey) : '';
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
