/**
 * ค่าตั้งของหน้า landing (P1-ST2-T01) — อ่านตอน build จาก env `VITE_*` (ไม่มีข้อมูลลับ)
 *
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (spec/12 §3 แถว "Landing page สาธารณะ"):
 * - `pricingVisible` แทน `pricing.publicVisible` ของ P1-ST1-T04 ชั่วคราว — ค่าเริ่ม **ซ่อน** (D-40: ราคายังไม่ประกาศ)
 *   เมื่อ P1-ST1-T04 / P1-ST2-T02 merge ให้เปลี่ยนเป็นค่าจาก API (`GET /v1/public/plans` — PLT-002 ห้ามพิมพ์ตัวเลขในโค้ด)
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
  pricingVisible: boolean;
  /** ราคาเริ่มต้นต่อรถ (ข้อความตัวเลข) — มาจาก `GET /v1/public/plans` ใน P1-ST2-T02 · ไม่มี = ไม่แสดงแถบราคา */
  fromPrice?: string;
  integrations: string[];
  contact: { line?: string; phone?: string; email?: string };
  links: { about?: string; privacy?: string; terms?: string };
  /** ปลายทางปุ่ม "ทดลองใช้ฟรี 30 วัน" — หน้าสมัคร (P1-ST2-T03) */
  signupPath: string;
  /**
   * หน้าสมัคร (P1-ST2-T03) / หน้าราคา (P1-ST2-T02) เปิดแล้วหรือยัง — ยังไม่เปิด = ปุ่ม/ลิงก์แสดงช่องทางติดต่อแทน
   * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ค่าเริ่ม false · เปิดก่อน go-live (checklist §5)
   */
  signupLive: boolean;
  pricingPageLive: boolean;
}

export function readLandingConfig(e: Record<string, string | undefined> = env): LandingConfig {
  return {
    pricingVisible: e.VITE_PRICING_PUBLIC === 'true',
    fromPrice: e.VITE_PRICING_FROM || undefined,
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
    pricingPageLive: e.VITE_PRICING_PAGE_LIVE === 'true',
  };
}

export const landingConfig = readLandingConfig();
