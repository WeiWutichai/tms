import { useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { queryClient } from '../api';
import { useI18n, type Lang } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { consoleApi, consoleLogout, cunwrap, useStaff, type StaffRole } from './session';
import './console.css';

/** เมนูตามต้นแบบ (NAV ใน TMS Platform Console) — เฟสนี้ใช้ได้เฉพาะ "ลูกค้า" (ST1-T24) */
const NAV: ({ k: string; i: string; path?: string } | 'sep')[] = [
  { k: 'ov', i: 'layout-dashboard' },
  { k: 'ten', i: 'building-2', path: '/console/tenants' },
  { k: 'q', i: 'user-check' },
  'sep',
  { k: 'pkg', i: 'package' },
  { k: 'add', i: 'ticket-percent' },
  { k: 'fin', i: 'wallet' },
  { k: 'use', i: 'activity' },
  'sep',
  { k: 'team', i: 'users' },
  { k: 'aud', i: 'scroll-text' },
];

export const ROLE_LABEL: Record<StaffRole, MessageKey> = {
  SUPER_ADMIN: 'con.role.SUPER_ADMIN',
  SUPPORT: 'con.role.SUPPORT',
  BILLING: 'con.role.BILLING',
};

/** ตัวย่อ 2 ตัวจากชื่อ-นามสกุล (ต้นแบบ: "กิตติ วัฒนา" → "กว") */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
}

export function useTenantList(q: string) {
  return useQuery({
    queryKey: ['console', 'tenants', q],
    queryFn: () =>
      cunwrap(
        consoleApi.GET('/v1/platform/tenants', {
          params: { query: { limit: 200, q: q || undefined } },
        }),
      ),
  });
}

/** โครงหน้า Console: แถบบน navy #13213F + sidebar 248px (ต้นแบบ TMS Platform Console) */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const staff = useStaff();
  const all = useTenantList('');
  const [q, setQ] = useState(params.get('q') ?? '');

  // ช่องค้นหาบนแถบบน → กรองตารางลูกค้า (?q=) หน่วง 250 ms
  useEffect(() => {
    const cur = new URLSearchParams(loc.search).get('q') ?? '';
    if (q.trim() === cur) return;
    const id = setTimeout(() => {
      nav(`/console/tenants${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`, {
        replace: loc.pathname === '/console/tenants',
      });
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const langs: [Lang, string][] = [
    ['th', 'TH'],
    ['en', 'EN'],
    ['zh', '中文'],
  ];
  const name = staff.data?.name ?? '…';
  const onTenants = loc.pathname.startsWith('/console/tenants');

  return (
    <div className="con">
      <header className="con-hd">
        <span className="con-hd__mark">
          <Icon n="truck" s={18} strokeWidth={1.8} />
        </span>
        <span className="con-hd__brand">TMS</span>
        <span className="con-hd__pill">PLATFORM CONSOLE</span>
        <span className="con-hd__crumb">{onTenants ? t('con.nav.ten') : ''}</span>
        <div style={{ flex: 1 }} />
        <label className="con-hd__search">
          <Icon n="search" s={16} strokeWidth={1.8} style={{ flexShrink: 0 }} />
          <input
            type="search"
            value={q}
            placeholder={t('con.search')}
            aria-label={t('con.search')}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <div className="con-hd__langs">
          {langs.map(([k, l]) => (
            <button
              key={k}
              type="button"
              aria-pressed={lang === k}
              className="con-hd__lang"
              onClick={() => setLang(k)}
            >
              {l}
            </button>
          ))}
        </div>
        <span className="con-hd__ava" title={name}>
          {initials(name)}
        </span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside className="con-side">
          <nav className="con-nav" aria-label={t('con.navLabel')}>
            {NAV.map((n, i) => {
              if (n === 'sep') return <div key={`s${i}`} className="con-nav__sep" />;
              const on = !!n.path && loc.pathname.startsWith(n.path);
              const count = n.k === 'ten' ? all.data?.length : undefined;
              return (
                <button
                  key={n.k}
                  type="button"
                  className="con-nav__item"
                  aria-current={on ? 'page' : undefined}
                  disabled={!n.path}
                  title={n.path ? undefined : t('con.nav.soon')}
                  onClick={() => n.path && nav(n.path)}
                >
                  <span className="con-nav__ico">
                    <Icon n={n.i} s={16} strokeWidth={1.8} />
                  </span>
                  <span className="con-nav__l">{t(`con.nav.${n.k}` as MessageKey)}</span>
                  {count ? <span className="con-nav__badge">{count}</span> : null}
                </button>
              );
            })}
            <div className="con-me">
              <span className="con-me__ava">{initials(name)}</span>
              <div className="con-me__txt">
                <span style={{ fontWeight: 600 }}>{name}</span>
                <span style={{ fontSize: 12.5, color: '#3B424C' }}>
                  {staff.data ? t(ROLE_LABEL[staff.data.role]) : ''}
                </span>
              </div>
              <button
                type="button"
                className="con-me__out"
                title={t('con.logout')}
                aria-label={t('con.logout')}
                onClick={() => {
                  void consoleLogout().then(() => {
                    queryClient.removeQueries({ queryKey: ['console'] });
                    nav('/console/login', { replace: true });
                  });
                }}
              >
                <Icon n="log-out" s={16} strokeWidth={1.8} />
              </button>
            </div>
          </nav>
        </aside>
        <main className="con-main">{children}</main>
      </div>
    </div>
  );
}
