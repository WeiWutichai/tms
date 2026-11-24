import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { DevImportPage } from './features/imports/DevImportPage';
import { RequireAuth } from './auth/RequireAuth';
import { queryClient } from './api';
import { I18nProvider } from './i18n';
import { canAny, featureOf, isLocked, NAV, permOf } from './nav';
import { SettingsPage } from './features/settings/Settings';
import { ProfilePage } from './features/profile/ProfilePage';
import { ApiKeysPage } from './features/api-keys/ApiKeysPage';
import { CustomersPage } from './features/customers/CustomersPage';
import { ExceptionsPage } from './features/exceptions/ExceptionsPage';
import { HoldPage } from './features/orders/HoldPage';
import { OrdersPage } from './features/orders/OrdersPage';
import { PlanningPage } from './features/planning/PlanningPage';
import { TripsPage } from './features/trips/TripsPage';
import { DoPage } from './features/delivery-orders/DoPage';
import { SitesPage } from './features/sites/SitesPage';
import { ProductsPage } from './features/products/ProductsPage';
import { RoutesPage } from './features/routes/RoutesPage';
import { BillPage } from './features/billing/BillPage';
import { PayPage } from './features/billing/PayPage';
import { ExportPage } from './features/exports/ExportPage';
import { RateCardsPage } from './features/rate-cards/RateCardsPage';
import { ServiceItemsPage } from './features/service-items/ServiceItemsPage';
import { VehicleTypesPage } from './features/vehicle-types/VehicleTypesPage';
import { CarriersPage } from './features/carriers/CarriersPage';
import { VehiclesPage } from './features/vehicles/VehiclesPage';
import { FleetDocsPage } from './features/vehicles/FleetDocsPage';
import { VehicleProfilePage } from './features/vehicles/VehicleProfilePage';
import { Dashboard } from './pages/Dashboard';
import { DesignSystem } from './pages/DesignSystem';
import { ErrorBoundary, ErrorPage, LockedPage, NoAccess, NotFound, NotReady } from './pages/Simple';
import { PrivateLinkLayout } from './public/privacyMeta';
import { LoginPage } from './public/Login';
import { ForgotPasswordPage, ResetPasswordPage } from './public/Password';
import { InvitePage } from './public/Invite';
import { ImpersonatePage } from './public/Impersonate';
import { CarrierDocsLinkPage } from './public/CarrierDocsLink';
import { OfferLinkPage } from './public/OfferLink';
import { PodLinkPage } from './public/PodLink';
import { SettlementLinkPage } from './public/SettlementLink';
import { CarrierPayLinkPage } from './public/CarrierPayLink';
import { TrackingPage } from './public/Tracking';
import { SettlePage } from './features/settlements/SettlePage';
import { ErpPage } from './features/erp/ErpPage';
import { ConsoleApp } from './console/ConsoleApp';
import { ReportPage } from './features/reports/ReportPage';
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
  '/plan': () => <PlanningPage />,
  '/trips': () => <TripsPage />,
  '/so': () => <OrdersPage />,
  '/so/hold': () => <HoldPage />,
  '/do': () => <DoPage />,
  '/bill': () => <BillPage />,
  '/pay': () => <PayPage />,
  '/settle': () => <SettlePage />,
  '/erp': () => <ErpPage />,
  '/exceptions': () => <ExceptionsPage />,
  '/master/customers': () => <CustomersPage />,
  '/master/locations': () => <SitesPage />,
  '/master/routes': () => <RoutesPage />,
  '/master/products': () => <ProductsPage />,
  '/master/vehicle-types': () => <VehicleTypesPage />,
  '/master/accessorials': () => <ServiceItemsPage />,
  '/master/rate-cards': () => <RateCardsPage />,
  '/fleet/drivers': () => <CarriersPage />,
  '/fleet/vehicles': () => <VehiclesPage />,
  '/fleet/documents': () => <FleetDocsPage />,
  '/settings/api': () => <ApiKeysPage />,
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
          {/* ST1-T09 โปรไฟล์ของผู้ใช้เอง — ทุก role (API /v1/me/* ไม่ต้องมี scope) · PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ */}
          <Route path="/profile" element={<ProfilePage />} />
          {import.meta.env.DEV && <Route path="/dev/import" element={<DevImportPage />} />}
          <Route
            path="/reports"
            element={
              <Guard perm={NAV.find((g) => g.key === 'report')?.perm} path="/reports">
                <ReportPage />
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
          {/* ST9-T10 ลิงก์ดาวน์โหลดไฟล์ส่งออกจากแจ้งเตือน — API ตรวจผู้สั่ง (export:run) เอง */}
          <Route path="/exports/:id" element={<ExportPage />} />
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
            {/* ST9-T13 R2 (L-01): หน้าที่มี token ใน URL — noindex + no-referrer */}
            <Route element={<PrivateLinkLayout />}>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/invite" element={<InvitePage />} />
              <Route path="/impersonate" element={<ImpersonatePage />} />
              {/* ลิงก์รถร่วมส่งเอกสาร (ST2-T21) — magic link ไม่ต้อง login */}
              <Route path="/link/carrier-docs/:token" element={<CarrierDocsLinkPage />} />
              {/* ลิงก์ข้อเสนองานของรถร่วม (ST3-T23) — รับ/ปฏิเสธโดยไม่ต้อง login */}
              <Route path="/link/offer/:token" element={<OfferLinkPage />} />
              <Route path="/link/pod/:token" element={<PodLinkPage />} />
              {/* รถร่วมตรวจใบสำคัญจ่าย (ST6-T05) — ยอมรับ/โต้แย้งรายการโดยไม่ต้อง login */}
              <Route path="/link/settlement/:token" element={<SettlementLinkPage />} />
              {/* ค่าเที่ยวของฉัน (ST6-T11) — รถร่วมดูเที่ยวที่จบ ยอด สถานะจ่าย โดยไม่ต้อง login */}
              <Route path="/link/carrier-pay/:token" element={<CarrierPayLinkPage />} />
            </Route>
            {/* หน้าติดตามของผู้รับ (ST4-T14) — ลิงก์ต่อ DO / ของลูกค้า ไม่ต้อง login (ใส่ meta เองใน TrackingPage) */}
            <Route path="/t/:token" element={<TrackingPage />} />
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
