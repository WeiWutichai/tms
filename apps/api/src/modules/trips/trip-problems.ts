import { PROBLEMS, type ProblemCode } from '../../common/problem';

/** ตัวอย่าง problem+json ของ `/v1/trips` (OpenAPI — แบบเดียวกับ orders) */
const P = (code: ProblemCode, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance: '/v1/trips/trp_3f2a…',
  requestId: 'b6a1c2d3-…',
  ...extra,
});

export const T403 = (scope: string) => ({
  status: 403,
  description: `ไม่มีสิทธิ์ (\`${scope}\`)`,
  examples: {
    permission_denied: P('permission_denied', {
      module: 'trips',
      action: scope.split(':')[1],
      required: [scope],
    }),
  },
});
export const T404 = {
  status: 404,
  description: 'ไม่พบเที่ยว (รวมของบริษัทอื่น)',
  examples: { not_found: P('not_found') },
};
export const T412 = {
  status: 412,
  description: 'If-Match ไม่ตรง version',
  examples: { precondition_failed: P('precondition_failed') },
};
export const T422 = {
  status: 422,
  description: 'ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง',
  examples: {
    validation_failed: P('validation_failed', {
      errors: [
        { field: 'deliveryOrderIds[0]', code: 'invalid_reference', message: 'not found' },
        { field: 'plannedEndAt', code: 'outside_trip_date', message: 'must be on tripDate' },
      ],
    }),
    idempotency_mismatch: P('idempotency_mismatch'),
  },
};
const TRANSITION = P('invalid_state_transition', { from: 'PLANNING', event: 'dispatch' });
const IDEM = P('idempotency_in_progress');

/** 409 ต่อ action — `codes` = รหัสเฉพาะ action นอกจาก invalid_state_transition/concurrent_update */
export const T409 = (...codes: ProblemCode[]) => ({
  status: 409,
  description: 'สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน',
  examples: {
    invalid_state_transition: TRANSITION,
    concurrent_update: P('concurrent_update'),
    idempotency_in_progress: IDEM,
    ...Object.fromEntries(codes.map((c) => [c, P(c)])),
  },
});
