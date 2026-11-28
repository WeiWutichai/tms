import { I18nCoreProvider } from '../../i18n/core';
import { LANDING_CATALOGS } from '../../i18n/landing.gen';
import '../landing/landing-base.css';
import { SignupPage } from './SignupPage';

/** จุดเข้าแยกของหน้าสมัคร (`/signup`, P1-ST2-T03) — bundle เบาแบบ landing · ข้อความชุดย่อย landing.gen (`su.*`) */
export function SignupRoot() {
  return (
    <I18nCoreProvider catalogs={LANDING_CATALOGS}>
      <SignupPage />
    </I18nCoreProvider>
  );
}
