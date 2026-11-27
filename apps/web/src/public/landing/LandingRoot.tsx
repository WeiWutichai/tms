import { I18nCoreProvider } from '../../i18n/core';
import { LANDING_CATALOGS } from '../../i18n/landing.gen';
import { LandingPage } from './Landing';
import './landing-base.css';

/**
 * จุดเข้าแยกของ landing (`/home`) — main.tsx โหลดไฟล์นี้แทนแอปทั้งก้อน
 * ไม่ดึง @tms/ui / React Query / หน้าหลัง login / ข้อความทั้งแอป (ใช้ชุดย่อย landing.gen) — Lighthouse มือถือ ≥ 80
 */
export function LandingRoot() {
  return (
    <I18nCoreProvider catalogs={LANDING_CATALOGS}>
      <LandingPage />
    </I18nCoreProvider>
  );
}
