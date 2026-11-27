import { CONNECTOR_KEY_RE, type ErpCapability, isErpCapability, type SorOwner } from '@tms/domain';
import type { ConnectorConfigField } from './erp-adapter';

/**
 * P1-ST5-T01b `ConnectorDefinition` — รายการใน catalog ของ connector ที่**ยังไม่มี adapter ที่ใช้งานได้**
 * (spec/07 §1 INT-010 "รายการมาจาก ConnectorDefinition ไม่ hard-code" · plan/00a: catalog อยู่ในโค้ด ไม่ใช่ตาราง)
 *
 * - adapter ที่ทำแล้ว (`ErpAdapter`) เป็น definition ในตัวอยู่แล้ว — ไฟล์นี้สำหรับระบบที่ประกาศไว้ล่วงหน้า (FlowAccount / PEAK)
 *   เพื่อให้การ์ดขึ้นในหน้าตั้งค่าการเชื่อมต่อตามต้นแบบ แต่ **เชื่อมต่อไม่ได้** (`availability: 'COMING_SOON'`):
 *   `POST /v1/connectors` ด้วย key นี้ = 422 `adapter_coming_soon` · ไม่มี method ใดถูกเรียก · ไม่มีการเดา mapping/VAT (R-01, X-07)
 * - ลงทะเบียนจาก `src/erp-adapters/index.ts` (`CONNECTOR_DEFINITIONS`) เท่านั้น — core ไม่รู้ชื่อระบบ
 * - adapter ตัวจริงมาเมื่อไร (P1-ST5-T02 / T07) = ลบ definition ออกแล้วลงทะเบียน adapter ใน `ERP_ADAPTER_FACTORIES` ด้วย key เดิม
 *   (registry ไม่ยอมให้มีทั้งสองแบบใน key เดียว)
 */
export const CONNECTOR_AVAILABILITY = ['AVAILABLE', 'COMING_SOON'] as const;
export type ConnectorAvailability = (typeof CONNECTOR_AVAILABILITY)[number];

/**
 * แพ็กเกจขั้นต่ำตาม docs/02 §3.1 (API connector โปรแกรมบัญชี = Growth) — **บังคับแล้ว (P1-ST1-T02)**:
 * adapter ตัวจริงที่ประกาศ `entitlement` ผ่าน `EntitlementService.assertConnector` ตอนสร้าง connector (หลังเช็ก coming-soon 422)
 * ได้สิทธิ์ผ่าน add-on/override (R-09) = ผ่านแม้แพ็กเกจต่ำกว่า
 */
export const CONNECTOR_TIERS = ['growth'] as const;
export type ConnectorTier = (typeof CONNECTOR_TIERS)[number];

export interface ConnectorEntitlement {
  /** feature ของแพ็กเกจที่ต้องเปิด (`conn` = connectors.accounting — spec/01 §6) */
  readonly feature: 'conn';
  /** แพ็กเกจขั้นต่ำ (แสดงในหน้าจอ/เอกสาร) — ดูหมายเหตุ `CONNECTOR_TIERS` */
  readonly minTier: ConnectorTier | null;
}

export interface ConnectorDefinition {
  /** `adapterKey` ที่จะใช้เมื่อ adapter ตัวจริงมา (ตาม `CONNECTOR_KEY_RE`) */
  readonly key: string;
  readonly displayName: string;
  /** credential schema — ค่าที่ใช้ยืนยันตัวตนต้อง `secret: true` (กติกาเดียวกับ `ErpAdapter.configFields`) */
  readonly configFields: readonly ConnectorConfigField[];
  /** capability ที่วางแผนไว้ (ยังไม่ทำทั้งหมด — catalog แสดงเป็น "ยังไม่รองรับ") */
  readonly capabilities: readonly ErpCapability[];
  /** R-01 / D-55: โปรแกรมบัญชีเป็นเจ้าของเอกสารภาษี ตายตัว */
  readonly fixedSystemOfRecord?: { readonly taxDocumentOwner: SorOwner };
  readonly entitlement: ConnectorEntitlement;
  readonly availability: 'COMING_SOON';
  /** สิ่งที่ยังขวาง (รหัสใน plan/13 §4.2 เช่น X-02) — เอกสารภายใน ไม่แสดงลูกค้า */
  readonly blockedBy: readonly string[];
}

const CONFIG_KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
/** ชื่อช่องที่เป็น credential แน่ ๆ — ห้าม `secret: false` (กันพลาดตอนเขียน definition) */
const SECRET_NAME_RE = /(secret|token|password|apikey|privatekey|connectid|clientid)/i;

/** ปัญหาของ definition (ว่าง = ใช้ได้) — registry ไม่ยอมลงทะเบียนตัวที่มีปัญหา */
export function definitionProblems(d: ConnectorDefinition): string[] {
  const out: string[] = [];
  if (!CONNECTOR_KEY_RE.test(d.key)) out.push(`key '${d.key}' must match ${CONNECTOR_KEY_RE}`);
  if (!d.displayName?.trim()) out.push('displayName required');
  if (!d.capabilities.length) out.push('capabilities required');
  for (const c of d.capabilities) if (!isErpCapability(c)) out.push(`unknown capability '${c}'`);
  if (d.availability !== 'COMING_SOON') out.push('availability must be COMING_SOON');
  if (d.entitlement?.feature !== 'conn') out.push("entitlement.feature must be 'conn'");
  const seen = new Set<string>();
  for (const f of d.configFields) {
    if (!CONFIG_KEY_RE.test(f.key)) out.push(`config field key '${f.key}' invalid`);
    if (seen.has(f.key)) out.push(`config field '${f.key}' repeated`);
    seen.add(f.key);
    if (!f.secret && SECRET_NAME_RE.test(f.key))
      out.push(`config field '${f.key}' looks like a credential — must be secret`);
    if (f.options && f.secret) out.push(`config field '${f.key}' is secret — options not allowed`);
  }
  return out;
}
