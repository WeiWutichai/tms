import { HttpException } from '@nestjs/common';

/**
 * Catalog ของ error `code` (คงที่ ห้ามเปลี่ยนชื่อ — ลูกค้าและ UI ผูกกับค่าเหล่านี้)
 * RFC 9457 application/problem+json (docs/01 §5.1)
 */
export const PROBLEMS = {
  validation_failed: { status: 422, th: 'ข้อมูลไม่ถูกต้อง', en: 'Validation failed' },
  bad_request: { status: 400, th: 'คำขอไม่ถูกต้อง', en: 'Bad request' },
  unauthorized: { status: 401, th: 'ต้องเข้าสู่ระบบ', en: 'Authentication required' },
  forbidden: { status: 403, th: 'ไม่มีสิทธิ์ทำรายการนี้', en: 'Forbidden' },
  not_found: { status: 404, th: 'ไม่พบข้อมูล', en: 'Not found' },
  method_not_allowed: { status: 405, th: 'ไม่รองรับวิธีเรียกนี้', en: 'Method not allowed' },
  conflict: { status: 409, th: 'ข้อมูลขัดแย้งกับที่มีอยู่', en: 'Conflict' },
  duplicate: { status: 409, th: 'ข้อมูลซ้ำกับที่มีอยู่', en: 'Duplicate' },
  invalid_state_transition: {
    status: 409,
    th: 'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
    en: 'Invalid state transition',
  },
  idempotency_in_progress: {
    status: 409,
    th: 'คำขอเดียวกันกำลังประมวลผลอยู่',
    en: 'Request with this Idempotency-Key is in progress',
  },
  precondition_failed: {
    status: 412,
    th: 'ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่',
    en: 'Precondition failed (version mismatch)',
  },
  idempotency_mismatch: {
    status: 422,
    th: 'Idempotency-Key นี้เคยใช้กับข้อมูลอื่น',
    en: 'Idempotency-Key reused with a different request body',
  },
  rate_limited: { status: 429, th: 'เรียกถี่เกินไป', en: 'Too many requests' },
  internal_error: { status: 500, th: 'ระบบขัดข้อง', en: 'Internal error' },
} as const;

export type ProblemCode = keyof typeof PROBLEMS;

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export class ProblemException extends HttpException {
  constructor(
    readonly code: ProblemCode,
    readonly detail?: string,
    readonly errors?: FieldError[],
    readonly extra?: Record<string, unknown>,
  ) {
    super(code, PROBLEMS[code].status);
  }
}

export const notFound = (detail?: string) => new ProblemException('not_found', detail);
