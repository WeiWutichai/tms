import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { DevImportPage } from './features/imports/DevImportPage';
import { RequireAuth } from './auth/RequireAuth';
import { queryClient } from './api';
import { I18nProvider } from './i18n';
import { canAny, featureOf, isLocked, NAV, permOf } from './nav';
import { SettingsPage } from './features/settings/Settings';
import { CustomersPage } from './features/customers/CustomersPage';
import { SitesPage } from './features/sites/SitesPage';
import { VehicleTypesPage } from './features/vehicle-types/VehicleTypesPage';
import { CarriersPage } from './features/carriers/CarriersPage';
import { VehiclesPage } from './features/vehicles/VehiclesPage';
import { VehicleProfilePage } from './features/vehicles/VehicleProfilePage';
import { Dashboard } from './pages/Dashboard';
import { DesignSystem } from './pages/DesignSystem';
import { ErrorBoundary, ErrorPage, LockedPage, NoAccess, NotFound, NotReady } from './pages/Simple';
import { LoginPage } from './public/Login';
import { ForgotPasswordPage, ResetPasswordPage } from './public/Password';
import { InvitePage } from './public/Invite';
import { ImpersonatePage } from './public/Impersonate';
import { ConsoleApp } from './console/ConsoleApp';
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

/** หน้าที่ทำแล้ว (path → หน้า) — เมนูอื่นที่ยังไม่ทำแสดง "ยังไม่เปิดใช้" */
const READY: Record<string, () => ReactNode> = {
  '/master/customers': () => <CustomersPage />,
  '/master/locations': () => <SitesPage />,
  '/master/vehicle-types': () => <VehicleTypesPage />,
  '/fleet/drivers': () => <CarriersPage />,
  '/fleet/vehicles': () => <VehiclesPage />,
};

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
          {import.meta.env.DEV && <Route path="/dev/import" element={<DevImportPage />} />}
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
          {/* โปรไฟล์รถ (ST2-T07) — หน้าย่อยของทะเบียนรถ: สิทธิ์/แพ็กเกจเดียวกัน */}
          <Route
            path="/fleet/vehicles/:id"
            element={
              <Guard perm={permOf('/fleet/vehicles')} path="/fleet/vehicles">
                <VehicleProfilePage />
              </Guard>
            }
          />
          {pending.map((p) => (
            <Route
              key={p.path}
              path={p.path}
              element={
                <Guard perm={p.perm} path={p.path}>
                  {READY[p.path]?.() ?? <NotReady page={p.page} stage={p.stage} />}
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
            <Route path="/impersonate" element={<ImpersonatePage />} />
            {/* Platform Console (ST1-T24) — layout/login/token แยกจากแอปลูกค้า ไม่ผ่าน RequireAuth */}
            <Route path="/console/*" element={<ConsoleApp />} />
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
