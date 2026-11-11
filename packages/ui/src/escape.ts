import { useEffect, useRef } from 'react';

/**
 * Esc ปิดเฉพาะชั้นบนสุด (dialog ซ้อนบน drawer ฯลฯ) — review ST2-T17: เดิมทุกชั้นฟัง window เอง
 * กด Esc ใน modal จึงปิด drawer ข้างหลังไปด้วย · ทุก drawer/dialog/เมนูใน @tms/ui และหน้าเว็บใช้ hook นี้
 */
const stack: { current: () => void }[] = [];
let bound = false;
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !stack.length) return;
  e.preventDefault();
  stack[stack.length - 1]!.current();
}

export function useEscapeLayer(open: boolean, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    if (!bound) {
      window.addEventListener('keydown', onKey);
      bound = true;
    }
    const layer = { current: () => cb.current() };
    stack.push(layer);
    return () => {
      const i = stack.lastIndexOf(layer);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}
