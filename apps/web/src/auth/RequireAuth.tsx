import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getAccessToken, sessionStore } from './session';

/** หน้าในระบบต้องมี session — ไม่มี (หรือ refresh ไม่ผ่าน) → /login?next=<หน้าเดิม> */
export function RequireAuth({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const status = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);

  useEffect(() => {
    if (status === 'unknown') void getAccessToken();
  }, [status]);

  if (status === 'unknown') return null;
  if (status === 'out') {
    const next = loc.pathname + loc.search;
    return (
      <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
    );
  }
  return <>{children}</>;
}
