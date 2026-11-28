import { I18nCoreProvider } from '../../i18n/core';
import { LANDING_CATALOGS } from '../../i18n/landing.gen';
import '../landing/landing-base.css';
import { PricingPage } from './Pricing';

/**
 * จุดเข้าแยกของหน้าราคา (`/pricing`, P1-ST2-T02) — bundle เบาแบบเดียวกับ landing (ไม่โหลดแอปทั้งก้อน)
 * ใช้ชุดข้อความย่อย landing.gen (`land.*` รวม `land.price.*`)
 */
export function PricingRoot() {
  return (
    <I18nCoreProvider catalogs={LANDING_CATALOGS}>
      <PricingPage />
    </I18nCoreProvider>
  );
}
