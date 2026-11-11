import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { queryClient } from '../api';
import { startImpersonation } from '../auth/session';
import { useI18n } from '../i18n';
import { PublicLayout } from './PublicLayout';

/** token จาก fragment (#token=…) — fragment ไม่ถูกส่งไป server และไม่ติดไปกับ Referer */
function tokenFromHash(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
}

/**
 * ปลายทางของปุ่ม "เข้าใช้งานแทน" ใน Platform Console (ST1-T24; spec/01 §11)
 * รับ token อ่านอย่างเดียวจาก URL fragment → เก็บในหน่วยความจำของแท็บนี้ → ไปหน้าแรก (แถบส้มแสดงจาก /v1/me)
 * ต้นแบบไม่มีหน้านี้ (เปิด TMS v4 ตรง ๆ) — ลิงก์ผิด/หมดอายุใช้การ์ดของหน้า public [OPEN spec/12 §3]
 */
export function ImpersonatePage() {
  const { t } = useI18n();
  const nav = useNavigate();
  // อ่านใน initializer, ล้าง hash ใน effect (StrictMode เรียก initializer 2 ครั้ง — แบบเดียวกับ ResetPasswordPage)
  const [token] = useState(tokenFromHash);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (!token || !startImpersonation(token)) {
      setInvalid(true);
      return;
    }
    queryClient.clear();
    nav('/', { replace: true });
  }, [token, nav]);

  if (!invalid) return null;
  return (
    <PublicLayout>
      <div className="pub-head">
        <h1>{t('imp.invalidTitle')}</h1>
        <span>{t('imp.invalidSub')}</span>
      </div>
    </PublicLayout>
  );
}
