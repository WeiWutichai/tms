import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { queryClient } from './api';
import { I18nProvider } from './i18n';
import { NAV } from './nav';
import { Dashboard } from './pages/Dashboard';
import { DesignSystem } from './pages/DesignSystem';
import { ErrorBoundary, ErrorPage, NotFound, NotReady } from './pages/Simple';
import { AppShell } from './shell/AppShell';

function Routed() {
  const pending = NAV.flatMap((g) =>
    (g.kids ?? [])
      .filter(() => g.key !== 'fav')
      .map((k) => ({ path: k.path.split('?')[0]!, page: k.page, stage: k.stage })),
  );
  return (
    <AppShell>
      <ErrorBoundary render={() => <ErrorPage />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/design-system" element={<DesignSystem />} />
          <Route path="/reports" element={<NotReady page="report" stage="ST9" />} />
          {pending.map((p) => (
            <Route
              key={p.path}
              path={p.path}
              element={<NotReady page={p.page} stage={p.stage} />}
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
          <Routed />
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}
