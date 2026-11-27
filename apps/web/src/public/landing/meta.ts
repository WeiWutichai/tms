import { useEffect } from 'react';

/**
 * SEO meta + Open Graph ของ landing (P1-ST2-T01) — ตั้งตอนเปิดหน้า แล้วคืนค่าเดิมเมื่อออก
 * (หน้าอื่นของแอปไม่ถูก index เพราะอยู่หลัง login / หน้าลิงก์ใส่ noindex เอง — privacyMeta.tsx)
 * ⚠ og:url / og:image แบบ absolute และ tag แบบ static (สำหรับ bot ที่ไม่รัน JS เช่นตัวสร้าง preview ของ LINE)
 *   ต้องรอโดเมนจริง X-09 → ติดตามใน go-live checklist (P1-ST6-T08)
 */
export function useLandingMeta(title: string, description: string, path = '/home') {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;
    const added: Element[] = [];
    const set = (attr: 'name' | 'property', key: string, content: string) => {
      const m = document.createElement('meta');
      m.setAttribute(attr, key);
      m.setAttribute('content', content);
      document.head.appendChild(m);
      added.push(m);
    };
    set('name', 'description', description);
    set('property', 'og:type', 'website');
    set('property', 'og:site_name', 'TMS');
    set('property', 'og:title', title);
    set('property', 'og:description', description);
    set('name', 'twitter:card', 'summary');
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.href = `${window.location.origin}${path}`;
    document.head.appendChild(link);
    added.push(link);
    return () => {
      document.title = prevTitle;
      added.forEach((el) => el.remove());
    };
  }, [title, description, path]);
}
