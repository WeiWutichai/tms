import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { queryClient } from './api';
import { I18nProvider } from './i18n';
import { canAny, NAV } from './nav';
import { SettingsPage } from './features/settings/Settings';
import { Dashboard } from './pages/Dashboard';
import { DesignSystem } from './pages/DesignSystem';
import { ErrorBoundary, ErrorPage, NoAccess, NotFound, NotReady } from './pages/Simple';
import { LoginPage } from './public/Login';
import { AppShell, useMe } from './shell/AppShell';
import type { ReactNode } from 'react';

/** กันเข้าทาง URL ตรง — ไม่มีสิทธิ์ตามเมนู → หน้า "ไม่มีสิทธิ์" (API ยังตอบ 403 เองอีกชั้น) */
function Guard({ perm, children }: { perm?: string[]; children: ReactNode }) {
  const me = useMe();
  if (!me.data) return null;
  if (!canAny(me.data.scopes, perm)) return <NoAccess role={me.data.user?.roles[0] ?? '—'} />;
  return <>{children}</>;
}

function Inside() {
  const pending = NAV.flatMap((g) =>
    (g.kids ?? [])
      .filter(() => g.key !== 'fav')
      .filter((k) => k.key !== 'settings')
      .map((k) => ({ path: k.path.split('?')[0]!, page: k.page, stage: k.stage, perm: k.perm })),
  );
  const settingsPerm = NAV.find((g) => g.key === 'setg')?.kids?.[0]?.perm;
  return (
    <AppShell>
      <ErrorBoundary render={() => <ErrorPage />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/design-system" element={<DesignSystem />} />
          <Route
            path="/reports"
            element={
              <Guard perm={NAV.find((g) => g.key === 'report')?.perm}>
                <NotReady page="report" stage="ST9" />
              </Guard>
            }
          />
          <Route
            path="/settings"
            element={
              <Guard perm={settingsPerm}>
                <SettingsPage />
              </Guard>
            }
          />
          {pending.map((p) => (
            <Route
              key={p.path}
              path={p.path}
              element={
                <Guard perm={p.perm}>
                  <NotReady page={p.page} stage={p.stage} />
                </Guard>
              }
            />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
    </AppShell>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="*"
              element={
                <RequireAuth>
                  <Inside />
                </RequireAuth>
              }
            />
          </Routes>
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}
