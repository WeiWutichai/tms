/**
 * ค่าตั้งของ help ในแอป (P1-ST6-T02/T03) — อ่านตอน build จาก env `VITE_*` (ไม่มีข้อมูลลับ) แบบเดียวกับ landing (`public/landing/config.ts`)
 *
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (spec/12 §3 แถว "Help ในแอป" / "ติดต่อทีมงาน"):
 * - `helpCenterUrl` = ที่อยู่ของ help center (`packages/help-center/site`) — ค่าเริ่ม `/help/` (เสิร์ฟจาก image เว็บเดียวกัน:
 *   `infra/deploy/web.Dockerfile` คัดลอก site ไปไว้ที่ `/srv/help`, ตอน dev vite เสิร์ฟจากโฟลเดอร์ site) · โดเมนแยกรอ X-09 → ตั้ง env ได้โดยไม่แก้โค้ด
 * - ช่องทางติดต่อทีมงาน Innovera (อีเมล support / LINE OA) ยังไม่ได้รับ (X-04) → **ไม่ใส่ค่าเดา** · ไม่ตั้ง = ปุ่มติดต่อปิดพร้อมข้อความบอกเหตุ
 *   (ค่าตัวอย่างในต้นแบบ — LINE @tms-th, sales@tms.co.th — เป็นข้อมูลสมมติตาม design/README.md)
 */
const env = import.meta.env as Record<string, string | undefined>;

export interface HelpConfig {
  /** ลงท้ายด้วย `/` เสมอ */
  helpCenterUrl: string;
  /** อีเมล support ของ Innovera — ไม่ตั้ง/รูปแบบผิด = undefined */
  supportEmail?: string;
  /** LINE OA (basic ID ขึ้นต้นด้วย `@`) — ไม่ตั้ง/รูปแบบผิด = undefined */
  supportLineOa?: string;
}

/** เข้มงวด — ห้าม `% ? & = # /` (กันการฉีด header ของ mailto เช่น `?cc=`) */
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const LINE_OA = /^@[A-Za-z0-9._-]{2,40}$/;

export function readHelpConfig(e: Record<string, string | undefined> = env): HelpConfig {
  const base = (e.VITE_HELP_CENTER_URL || '/help/').trim();
  const email = e.VITE_SUPPORT_EMAIL?.trim();
  const line = e.VITE_SUPPORT_LINE_OA?.trim();
  return {
    helpCenterUrl: base.endsWith('/') ? base : `${base}/`,
    ...(email && EMAIL.test(email) ? { supportEmail: email } : {}),
    ...(line && LINE_OA.test(line) ? { supportLineOa: line } : {}),
  };
}

export const helpConfig = readHelpConfig();
