import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { queryClient } from './api';
import { I18nProvider } from './i18n';
import { canAny, featureOf, isLocked, NAV } from './nav';
import { SettingsPage } from './features/settings/Settings';
import { Dashboard } from './pages/Dashboard';
import { DesignSystem } from './pages/DesignSystem';
import { ErrorBoundary, ErrorPage, LockedPage, NoAccess, NotFound, NotReady } from './pages/Simple';
import { LoginPage } from './public/Login';
import { ForgotPasswordPage, ResetPasswordPage } from './public/Password';
import { InvitePage } from './public/Invite';
import { AppShell, useMe } from './shell/AppShell';
import type { ReactNode } from 'react';

/** กันเข้าทาง URL ตรง — ไม่มีสิทธิ์ตามเมนู → หน้า "ไม่มีสิทธิ์" (API ยังตอบ 403 เองอีกชั้น) */
function Guard({ perm, path, children }: { perm?: string[]; path?: string; children: ReactNode }) {
  const me = useMe();
  if (!me.data) return null;
  if (!canAny(me.data.scopes, perm)) return <NoAccess role={me.data.user?.roles[0] ?? '—'} />;
  // ฟีเจอร์ไม่อยู่ในแพ็กเกจ → หน้า "ไม่รวมในแพ็กเกจ" (ST1-T18; PLT-076)
  const feature = path ? featureOf(path) : undefined;
  if (feature && isLocked(feature, me.data.features))
    return (
      <LockedPage feature={feature} plan={me.data.plan.name} need={me.data.lockedIn[feature]} />
    );
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
              <Guard perm={NAV.find((g) => g.key === 'report')?.perm} path="/reports">
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
                <Guard perm={p.perm} path={p.path}>
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
            <Route path="/forgot" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/invite" element={<InvitePage />} />
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
