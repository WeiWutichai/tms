import { useState } from 'react';
import { useI18n } from '../../i18n/core';
import { landingConfig, type LandingConfig } from '../landing/config';
import { useLandingMeta } from '../landing/meta';
import { usePublicPlans, type PublicPlans } from '../landing/plans';
import { PublicShell } from '../landing/PublicShell';
import '../landing/landing.css';
import { SignupMain } from './SignupMain';

/**
 * หน้าสมัคร `/signup` (P1-ST2-T03/T04) — ต้นแบบ view `signup`: header/footer เดียวกับ landing แต่ header ทึบเสมอ
 * โครงหน้า (หัว/ท้าย/ช่องทางติดต่อ) ใช้ `PublicShell` ร่วมกับ landing และหน้าราคา (P1-ST2-T02)
 * เมนู/ลิงก์ราคาแสดงเมื่อ `GET /v1/public/plans` ไม่ใช่ 404 (pricing.publicVisible)
 */
export function SignupPage({
  config = landingConfig,
  plans,
}: {
  config?: LandingConfig;
  /** ส่งมาเอง (test) — ไม่ส่ง = โหลดจาก API · null = ปิดหน้าราคา */
  plans?: PublicPlans | null;
}) {
  const { t } = useI18n();
  const [toast, setToast] = useState('');
  const fetched = usePublicPlans(plans === undefined);
  const data = plans !== undefined ? plans : fetched.state;
  useLandingMeta(t('su.meta.title'), t('land.lead'), '/signup');
  return (
    <PublicShell
      page="signup"
      config={config}
      showPrice={!!data && data !== 'error'}
      toast={toast}
      setToast={setToast}
    >
      <SignupMain onToast={setToast} />
    </PublicShell>
  );
}
