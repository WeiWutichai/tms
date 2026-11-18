import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import type { DeprecationInfo } from './versions';

export const VERSION_GATES = 'tms:versionGates';
/**
 * ST7-T07: route นี้ได้รับผลจากการเปลี่ยนที่มี gate (id ใน VERSION_CHANGES) — คำขอที่ pin ก่อนวันของการเปลี่ยน
 * ได้พฤติกรรมเดิม (แปลง request/response ใน ApiVersionInterceptor) · OpenAPI แสดงหมายเหตุต่อเวอร์ชัน
 */
export const VersionGate = (...ids: [string, ...string[]]) =>
  applyDecorators(SetMetadata(VERSION_GATES, ids), ApiExtension('x-api-version-gates', ids));

export const DEPRECATED_ROUTE = 'tms:deprecatedRoute';
/**
 * ST7-T07: ประกาศเลิกใช้ route (docs/04 G1: ≥ 12 เดือนก่อนหยุด) — ทุก response มี header
 * `Deprecation` (RFC 9745) + `Sunset` (RFC 8594) + `Link: <…>; rel="deprecation"` · OpenAPI `deprecated: true`
 */
export const DeprecatedRoute = (info: DeprecationInfo) =>
  applyDecorators(SetMetadata(DEPRECATED_ROUTE, info), ApiExtension('x-deprecation', info));
