import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';

/**
 * ป้องกันการเก็บ index / ส่ง referrer (token อยู่ใน URL — EXE-063, NFR-135)
 * ST9-T13 R2 (L-01): ย้ายจากหน้าติดตามมาเป็น hook กลาง ใช้กับทุกหน้าลิงก์ (`/link/*`, `/t/*`) + หน้าที่มี token ใน URL
 * (คำเชิญ / ตั้งรหัสผ่านใหม่ / เข้าใช้งานแทน) — ไม่เปลี่ยนหน้าตา
 */
export function usePrivacyMeta() {
  useEffect(() => {
    const add = (name: string, content: string) => {
      const m = document.createElement('meta');
      m.name = name;
      m.content = content;
      document.head.appendChild(m);
      return m;
    };
    const metas = [add('robots', 'noindex, nofollow'), add('referrer', 'no-referrer')];
    return () => metas.forEach((m) => m.remove());
  }, []);
}

/** layout route ของหน้าที่มี token ใน URL — ใส่ meta noindex/no-referrer แล้วแสดงหน้าลูก */
export function PrivateLinkLayout() {
  usePrivacyMeta();
  return <Outlet />;
}
