import { useEffect, useRef, type RefObject } from 'react';

/**
 * ST9-T20 (WCAG 2.1 AA 2.1.2/2.4.3): focus ของ drawer/dialog แบบ modal
 * - เปิด: ย้าย focus เข้า dialog (ถ้ายังไม่อยู่ข้างใน เช่น ช่องที่ autoFocus) — ผู้ใช้คีย์บอร์ด/screen reader เริ่มที่ dialog
 * - Tab / Shift+Tab วนอยู่ใน dialog ชั้นบนสุด (dialog ซ้อน drawer: เฉพาะชั้นบน)
 * - ปิด: คืน focus ให้ปุ่ม/แถวที่เปิด (ถ้ายังอยู่ในหน้า)
 * ไม่เปลี่ยนหน้าตา — container ได้ tabIndex=-1 และไม่แสดงกรอบ focus (ui.css `[data-modal-focus]`)
 */
const stack: RefObject<HTMLElement | null>[] = [];
let bound = false;

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0,
  );
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Tab' || !stack.length) return;
  const root = stack[stack.length - 1]!.current;
  if (!root) return;
  const els = focusables(root);
  if (!els.length) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = els[0]!;
  const last = els[els.length - 1]!;
  const cur = document.activeElement;
  if (!root.contains(cur)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (cur === first || cur === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && cur === last) {
    e.preventDefault();
    first.focus();
  }
}

export function useModalFocus(open: boolean, ref: RefObject<HTMLElement | null>): void {
  // จำปุ่มที่เปิดตั้งแต่ render แรกที่เปิด — ก่อนช่อง autoFocus ใน dialog ย้าย focus ไป (commit มาก่อน effect)
  const openerRef = useRef<HTMLElement | null>(null);
  const seen = useRef(false);
  if (open && !seen.current) {
    seen.current = true;
    openerRef.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  } else if (!open) seen.current = false;
  useEffect(() => {
    if (!open) return;
    if (!bound) {
      document.addEventListener('keydown', onKey);
      bound = true;
    }
    const opener = openerRef.current;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
    stack.push(ref);
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
      // คืน focus เฉพาะเมื่อ focus ยังอยู่ใน dialog ที่ปิด/หลุดไป body (ไม่แย่ง focus ที่ผู้ใช้ย้ายไปเอง)
      const now = document.activeElement;
      const lost =
        !now || now === document.body || (root?.contains(now) ?? false) || !now.isConnected;
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
