import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'tms:isPublic';
/** route ที่ไม่ต้องมี credential (health, openapi.json) */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const NO_TRANSACTION = 'tms:noTransaction';
/**
 * route ที่ไม่ต้องเปิด transaction ของ request (ไม่แตะฐานข้อมูล แต่เรียกระบบภายนอกที่อาจช้า เช่น geocode ST2-T03)
 * ห้ามใช้ `DbService.tx` ใน route นี้ — ยังผ่าน AuthGuard/ตรวจสิทธิ์ตามปกติ
 */
export const NoTransaction = () => SetMetadata(NO_TRANSACTION, true);

export const TENANT_RESOURCE = 'tms:tenantResource';
/**
 * ประกาศว่า route ที่มี `:id` นี้อ้าง resource ชนิดไหน — harness ทดสอบแยก tenant (ST0-T05)
 * ใช้ค่านี้หา fixture มาสร้างข้อมูลใน tenant A แล้วเรียกด้วย token ของ tenant B ต้องได้ 404
 * route ที่มี `:id` แต่ไม่ประกาศ → harness fail
 */
export const TenantResource = (kind: string) => SetMetadata(TENANT_RESOURCE, kind);

export const REQUIRED_SCOPE = 'tms:requiredScope';
/** scope แบบ `resource:verb` (docs/01 §5.1) — ส่งหลายตัว = มีตัวใดตัวหนึ่งก็พอ */
export const RequireScope = (...scopes: [string, ...string[]]) =>
  SetMetadata(REQUIRED_SCOPE, scopes);

export const REQUIRE_STEP_UP = 'tms:requireStepUp';
/** ต้องยืนยัน 2FA ซ้ำภายใน 5 นาที (header `X-Step-Up` จาก POST /v1/auth/step-up) — A3 "เปลี่ยน role ต้อง step-up" */
export const RequireStepUp = () => SetMetadata(REQUIRE_STEP_UP, true);

export const REQUIRED_FEATURE = 'tms:requiredFeature';
/** ต้องเปิดฟีเจอร์นี้ในแพ็กเกจ/override ของ tenant (ST1-T18) — ปิด → 403 `feature_not_in_plan` + `featureKey` (spec/01 PLT-078) */
export const RequireFeature = (feature: string) => SetMetadata(REQUIRED_FEATURE, feature);

export const LINK_ACTION = 'tms:linkAction';
/**
 * route ที่ยืนยันตัวตนด้วย magic link (ST1-T06) แทน token — path ต้องมี `:token`
 * ลิงก์หมดอายุ/ถูกเพิกถอน/ไม่มี action นี้ → 404 · principal = `link` (ไม่เห็นราคาขายเด็ดขาด)
 */
export const LinkAction = (action: string) => SetMetadata(LINK_ACTION, action);

export const PLATFORM_ROLES = 'tms:platformRoles';
/**
 * route ของ Platform Console (ST1-T24) — ต้องใช้ token ของทีม Innovera (login แยก + 2FA) ไม่ใช่ token ลูกค้า
 * ระบุ role ที่ทำได้ (docs/04 A6: SUPER_ADMIN / SUPPORT / BILLING) — ไม่ระบุ = ทุก role
 */
export const PlatformAuth = (...roles: ('SUPER_ADMIN' | 'SUPPORT' | 'BILLING')[]) =>
  SetMetadata(PLATFORM_ROLES, roles);
