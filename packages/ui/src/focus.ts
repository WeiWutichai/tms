import { useEffect, useRef, type RefObject } from 'react';

/**
 * ST9-T20 (WCAG 2.1 AA 2.1.2/2.4.3): focus ของ drawer/dialog แบบ modal
 * - เปิด: ย้าย focus เข้า dialog (ถ้ายังไม่อยู่ข้างใน เช่น ช่องที่ autoFocus) — ผู้ใช้คีย์บอร์ด/screen reader เริ่มที่ dialog
 * - Tab / Shift+Tab วนอยู่ใน dialog ชั้นบนสุด (dialog ซ้อน drawer: เฉพาะชั้นบน) · มี `[aria-modal]` อื่นที่เปิดทีหลัง
 *   (dialog เฉพาะหน้าที่ยังไม่ใช้ hook นี้ — render นอก drawer) → ปล่อยให้ชั้นนั้นจัดการเอง ไม่ดึง focus กลับ drawer ข้างหลัง
 * - ปิด: คืน focus ให้ปุ่ม/แถวที่เปิด (ถ้ายังอยู่ในหน้า) ไม่งั้นคืนให้ dialog ชั้นล่าง · เปิดด้วยเมาส์ = คืน focus แบบไม่แสดงกรอบ
 * ไม่เปลี่ยนหน้าตา — container ได้ tabIndex=-1 และไม่แสดงกรอบ focus (ui.css `[data-modal-focus]`)
 */
const stack: RefObject<HTMLElement | null>[] = [];
let bound = false;
/** การกระทำล่าสุดของผู้ใช้ — เปิดด้วยเมาส์/สัมผัสแล้วปิด ไม่ควรมีกรอบ focus ขึ้นที่แถวเดิม */
let modality: 'key' | 'pointer' = 'key';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  // ไม่มี layout (jsdom) = ไม่กรองตามการมองเห็น
  const layout = root.getClientRects().length > 0;
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[inert]') && (!layout || el.getClientRects().length > 0),
  );
}

/** มี modal อื่นที่ไม่อยู่ใน root และเปิดทีหลัง (อยู่หลัง root ในเอกสาร) หรือ focus อยู่ใน modal อื่น */
function yieldsTo(root: HTMLElement, cur: Element | null): boolean {
  const own = cur?.closest('[aria-modal="true"]');
  if (own && own !== root && !root.contains(own)) return true;
  return [...document.querySelectorAll('[aria-modal="true"]')].some(
    (m) =>
      m !== root &&
      !root.contains(m) &&
      !m.contains(root) &&
      (root.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
}

function onTab(e: KeyboardEvent) {
  if (e.key !== 'Tab' || !stack.length) return;
  const root = stack[stack.length - 1]!.current;
  if (!root) return;
  const cur = document.activeElement;
  if (yieldsTo(root, cur)) return;
  const els = focusables(root);
  if (!els.length) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = els[0]!;
  const last = els[els.length - 1]!;
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

// ติดตามวิธีใช้งานตั้งแต่โหลดโมดูล (ไม่รอ dialog แรก — ไม่งั้นการเปิดด้วยเมาส์ครั้งแรกถูกนับเป็นคีย์บอร์ด: QA L-1)
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => (modality = 'key'), true);
  document.addEventListener('pointerdown', () => (modality = 'pointer'), true);
}

function bind() {
  if (bound) return;
  bound = true;
  document.addEventListener('keydown', onTab);
}

/** ไม่มีปุ่มที่เปิด/ชั้นล่างให้คืน focus → หัวข้อหน้า (h1 ใน main) แทนการปล่อยหลุดไป body (QA L-2) */
function pageFallback(): HTMLElement | null {
  const h =
    document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1');
  if (!h) return null;
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
  return h;
}

/** คืน focus — เปิดด้วยเมาส์: ไม่แสดงกรอบ focus-visible ที่ element เดิม (ui.css `[data-pointer-focus]`) */
function restore(el: HTMLElement, pointer: boolean) {
  if (pointer) {
    el.setAttribute('data-pointer-focus', '');
    el.addEventListener('blur', () => el.removeAttribute('data-pointer-focus'), { once: true });
  }
  el.focus({ preventScroll: true, ...(pointer ? { focusVisible: false } : {}) } as FocusOptions);
}

export function useModalFocus(open: boolean, ref: RefObject<HTMLElement | null>): void {
  // จำปุ่มที่เปิดตั้งแต่ render แรกที่เปิด — ก่อนช่อง autoFocus ใน dialog ย้าย focus ไป (commit มาก่อน effect)
  const openerRef = useRef<HTMLElement | null>(null);
  const pointerRef = useRef(false);
  const seen = useRef(false);
  if (open && !seen.current) {
    seen.current = true;
    pointerRef.current = modality === 'pointer';
    openerRef.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  } else if (!open) seen.current = false;
  useEffect(() => {
    if (!open) return;
    bind();
    const opener = openerRef.current;
    const pointer = pointerRef.current;
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
      if (!lost) return;
      if (opener?.isConnected && opener !== document.body) return restore(opener, pointer);
      // ปุ่มที่เปิดหายไปแล้ว (เช่น เมนู ⋯ ปิดไปก่อน) → dialog ชั้นล่างที่ยังเปิดอยู่
      const below = stack[stack.length - 1]?.current;
      if (below?.isConnected) return below.focus({ preventScroll: true });
      const page = pageFallback();
      if (page) restore(page, pointer);
    };
  }, [open, ref]);
}
