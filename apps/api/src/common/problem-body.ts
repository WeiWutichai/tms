import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvalidTransitionError } from '@tms/domain';
import { isRetryableDbError } from './problem.filter';
import { PROBLEMS, ProblemException, type ProblemCode } from './problem';
import { requestContext } from './request-context';

const logger = new Logger('BulkItem');

/**
 * problem body ของรายการเดียวใน bulk (ST7-T10) — รูปเดียวกับ application/problem+json ของคำขอเดี่ยว (ProblemFilter)
 * แต่ไม่มี instance/requestId ต่อรายการ · error ที่ไม่ใช่ problem = `internal_error` (log ไว้) — ไม่เผยข้อความภายใน
 */
export function problemBody(e: unknown): {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: { field: string; code: string; message: string }[];
  [k: string]: unknown;
} {
  const locale = requestContext.get()?.locale ?? 'th';
  let code: ProblemCode = 'internal_error';
  let detail: string | undefined;
  let errors: { field: string; code: string; message: string }[] | undefined;
  let extra: Record<string, unknown> = {};
  if (e instanceof ProblemException) {
    code = e.code;
    detail = e.detail;
    errors = e.errors;
    extra = { ...(e.extra ?? {}) };
  } else if (e instanceof InvalidTransitionError) {
    code = 'invalid_state_transition';
    detail = `${e.entity}: '${e.event}' from '${String(e.from).toLowerCase()}'`;
  } else if (isRetryableDbError(e)) {
    code = 'concurrent_update';
    extra = { retryAfter: 1, retryable: true };
  } else if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    code = 'duplicate';
  } else {
    logger.error(e);
  }
  const def = PROBLEMS[code];
  const { title, ...rest } = extra as { title?: { th: string; en: string } } & Record<
    string,
    unknown
  >;
  return {
    type: `https://docs.tms.example/problems/${code}`,
    title: title?.[locale] ?? def[locale],
    status: def.status as number,
    code,
    ...(detail ? { detail } : {}),
    ...(errors?.length ? { errors } : {}),
    ...rest,
  };
}
