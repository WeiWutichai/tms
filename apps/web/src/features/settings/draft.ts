export type Values = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * รวมค่าจาก server ชุดใหม่เข้ากับ draft ของฟอร์มโดยไม่ทิ้งค่าที่ผู้ใช้แก้ค้างไว้
 *
 * เดิม `setDraft(server)` ทุกครั้งที่ GET /v1/settings เสร็จ → ถ้าผู้ใช้เปลี่ยนค่าก่อนข้อมูลโหลดเสร็จ
 * (เครื่องช้า) ค่าที่แก้ถูกเขียนทับ, dirty ว่าง แล้วปุ่ม "บันทึก" แสดง toast โดยไม่ได้ส่ง PATCH
 * (ต้นเหตุ E2E settings.spec "ค่าคงอยู่หลังโหลดใหม่" flaky)
 *
 * - `base` = ค่าจาก server ที่ draft ตั้งต้นจาก (null = ยังไม่เคยโหลด → ทุก key ใน draft คือค่าที่ผู้ใช้แก้)
 * - key ที่ผู้ใช้แก้ (draft ≠ base) และ server ไม่ได้เปลี่ยน key นั้น → คงค่าที่ผู้ใช้แก้
 * - key ที่ server เปลี่ยน (บันทึกสำเร็จ / มีคนอื่นแก้แล้ว refetch หลัง 412) → ใช้ค่าจาก server
 */
export function rebaseDraft(base: Values | null, draft: Values, next: Values): Values {
  if (base === null) return { ...next, ...draft };
  const out: Values = { ...next };
  for (const [k, v] of Object.entries(draft)) {
    if (!same(v, base[k]) && same(next[k], base[k])) out[k] = v;
  }
  return out;
}
