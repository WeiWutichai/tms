import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'tms:isPublic';
/** route ที่ไม่ต้องมี credential (health, openapi.json) */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const TENANT_RESOURCE = 'tms:tenantResource';
/**
 * ประกาศว่า route ที่มี `:id` นี้อ้าง resource ชนิดไหน — harness ทดสอบแยก tenant (ST0-T05)
 * ใช้ค่านี้หา fixture มาสร้างข้อมูลใน tenant A แล้วเรียกด้วย token ของ tenant B ต้องได้ 404
 * route ที่มี `:id` แต่ไม่ประกาศ → harness fail
 */
export const TenantResource = (kind: string) => SetMetadata(TENANT_RESOURCE, kind);

export const REQUIRED_SCOPE = 'tms:requiredScope';
/** scope แบบ `resource:verb` (docs/01 §5.1) */
export const RequireScope = (scope: string) => SetMetadata(REQUIRED_SCOPE, scope);
