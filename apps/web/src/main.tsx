import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * P1-ST2-T01: landing สาธารณะ (`/home`) เป็น chunk แยก — ผู้เข้าชมหน้าแรกไม่ต้องโหลด bundle ของแอปทั้งก้อน
 * (Lighthouse ประสิทธิภาพมือถือ ≥ 80) · เส้นทางอื่นทั้งหมดโหลดแอปเดิม (App.tsx) ตามปกติ
 */
const isLanding = /^\/home\/?$/.test(window.location.pathname);
const root: Promise<ComponentType> = isLanding
  ? import('./public/landing/LandingRoot').then((m) => m.LandingRoot)
  : import('./AppRoot').then((m) => m.AppRoot);

void root.then((Root) =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  ),
);
