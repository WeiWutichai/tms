/**
 * ค่าตั้งของหน้า landing (P1-ST2-T01) — อ่านตอน build จาก env `VITE_*` (ไม่มีข้อมูลลับ)
 *
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (spec/12 §3 แถว "Landing page สาธารณะ"):
 * - ราคา: P1-ST2-T02 เลิกใช้ env `VITE_PRICING_PUBLIC` / `VITE_PRICING_FROM` / `VITE_PRICING_PAGE_LIVE` — เปิด/ปิดด้วยค่าตั้ง
 *   `pricing.publicVisible` ของแพลตฟอร์ม (Console) ผ่าน `GET /v1/public/plans` (404 = ปิด) · ตัวเลขจาก API (PLT-002)
 * - `integrations` = ระบบที่ "เปิดจริง ณ วัน go-live" (R-11) — ค่าเริ่มเฉพาะที่อยู่ในเฟส 1; Express รอยืนยันกับ ESG
 *   (docs/02 §3.1 "ก่อนโฆษณา"), SAP B1 = เฟส 2, GPS = เฟส 2–3 → ไม่อยู่ในค่าเริ่ม · เปิดเพิ่มด้วย env โดยไม่แก้โค้ด
 * - ช่องทางติดต่อ / ลิงก์หน้าบริษัท: ข้อมูลในต้นแบบเป็นของสมมติ (design/README.md) → ไม่ตั้ง = ไม่แสดงรายการนั้น
 */
const env = import.meta.env as Record<string, string | undefined>;

const list = (v: string | undefined, fallback: string[]) =>
  v === undefined
    ? fallback
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/** ลำดับชื่อตามต้นแบบ — แถบ "ใช้คู่กับ …" */
export const WORKS_WITH_ORDER = ['Express', 'FlowAccount', 'KRS', 'PEAK', 'SAP B1', 'LINE', 'GPS'];
/** ลำดับชื่อตามต้นแบบ — FAQ "ต้องมี ERP หรือโปรแกรมบัญชีก่อนไหม" (เฉพาะโปรแกรมบัญชี/ERP) */
export const ACCOUNTING_ORDER = ['Express', 'PEAK', 'FlowAccount', 'KRS', 'SAP B1'];

export interface LandingConfig {
  integrations: string[];
  contact: { line?: string; phone?: string; email?: string };
  links: { about?: string; privacy?: string; terms?: string };
  /** ปลายทางปุ่ม "ทดลองใช้ฟรี 30 วัน" — หน้าสมัคร (P1-ST2-T03) */
  signupPath: string;
  /**
   * หน้าสมัคร (P1-ST2-T03) เปิดแล้วหรือยัง — ยังไม่เปิด = ปุ่ม/ลิงก์แสดงช่องทางติดต่อแทน
   * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ค่าเริ่ม false · เปิดก่อน go-live (checklist §5)
   */
  signupLive: boolean;
}

export function readLandingConfig(e: Record<string, string | undefined> = env): LandingConfig {
  return {
    integrations: list(e.VITE_LANDING_INTEGRATIONS, ['FlowAccount', 'KRS', 'PEAK', 'LINE']),
    contact: {
      line: e.VITE_PUBLIC_CONTACT_LINE || undefined,
      phone: e.VITE_PUBLIC_CONTACT_PHONE || undefined,
      email: e.VITE_PUBLIC_CONTACT_EMAIL || undefined,
    },
    links: {
      about: e.VITE_PUBLIC_ABOUT_URL || undefined,
      privacy: e.VITE_PUBLIC_PRIVACY_URL || undefined,
      terms: e.VITE_PUBLIC_TERMS_URL || undefined,
    },
    signupPath: '/signup',
    signupLive: e.VITE_SIGNUP_LIVE === 'true',
  };
}

export const landingConfig = readLandingConfig();
