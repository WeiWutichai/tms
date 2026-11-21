import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * ST9-T02 drill-down จาก Dashboard บิล / KPI / เมนูโปรด (`/bill?tab=DRAFT`, `/pay?tab=over`) — RPT-005
 * แท็บใน URL ที่รู้จัก → `apply(tab)` (หน้าตั้งแท็บ + ล้างตัวกรองคอลัมน์ ให้จำนวนแถว = ตัวเลขบนการ์ด) แล้วลบ `tab` ออกจาก URL
 * (แท็บยังจำใน session ตามเดิม) · ค่าที่ไม่รู้จัก = ลบทิ้งเฉย ๆ
 */
export function useUrlTab<T extends string>(tabs: readonly T[], apply: (tab: T) => void) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  useEffect(() => {
    if (raw === null) return;
    if ((tabs as readonly string[]).includes(raw)) apply(raw as T);
    const next = new URLSearchParams(params);
    next.delete('tab');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ทำครั้งเดียวต่อค่า `tab` ใน URL
  }, [raw]);
}
