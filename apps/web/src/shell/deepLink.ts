import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/** id ของ API ตาม prefix (`ord_…`, `ivc_…`) — กันค่าแปลก ๆ จาก URL ก่อนส่งให้ drawer */
export const isApiId = (prefix: string, v: string | null): v is string =>
  !!v && new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(v);

/**
 * ลิงก์เปิดเอกสารในหน้า (`/so?open=ord_…`, `/bill?invoice=ivc_…`) — ใช้จากค้นหา ⌘K (ST9-T09) และแจ้งเตือน
 * อ่านพารามิเตอร์ → เรียก onOpen → ลบพารามิเตอร์ออก (replace) · ทำงานทั้งตอนเข้าหน้าและตอนอยู่หน้าเดิมแล้วกดผลค้นหาใหม่
 */
export function useDeepOpen(
  key: string,
  prefix: string,
  onOpen: (id: string) => void,
  ready = true,
): void {
  const [params, setParams] = useSearchParams();
  const v = params.get(key);
  const cb = useRef(onOpen);
  cb.current = onOpen;
  useEffect(() => {
    if (!v || !ready) return;
    // แบบฟังก์ชัน — หลาย hook ในหน้าเดียวลบพารามิเตอร์ของตัวเองโดยไม่ทับกัน
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(key);
        return next;
      },
      { replace: true },
    );
    if (isApiId(prefix, v)) cb.current(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, ready]);
}
