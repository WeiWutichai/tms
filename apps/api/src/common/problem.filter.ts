import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { InvalidTransitionError } from '@tms/domain';
import { PROBLEMS, ProblemCode, ProblemException, type FieldError } from './problem';
import { requestContext } from './request-context';

const STATUS_TO_CODE: Record<number, ProblemCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  412: 'precondition_failed',
  422: 'validation_failed',
  429: 'rate_limited',
};

/** แปลงทุก error เป็น application/problem+json ที่มี code + requestId (ST0-T06) */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const ctx = requestContext.get();
    const locale = ctx?.locale ?? 'th';

    let code: ProblemCode = 'internal_error';
    let detail: string | undefined;
    let errors: FieldError[] | undefined;
    let extra: Record<string, unknown> | undefined;

    if (exception instanceof ProblemException) {
      code = exception.code;
      detail = exception.detail;
      errors = exception.errors;
      extra = exception.extra;
    } else if (exception instanceof InvalidTransitionError) {
      code = 'invalid_state_transition';
      detail = `${exception.entity}: '${exception.event}' from '${String(exception.from).toLowerCase()}'`;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') code = 'duplicate';
      else if (exception.code === 'P2025') code = 'not_found';
      // connection pool เต็ม / transaction รอนานเกิน → ให้ client ลองใหม่ แทน 500
      else if (exception.code === 'P2024' || exception.code === 'P2028') code = 'rate_limited';
      else this.logger.error(exception);
    } else if (exception instanceof HttpException) {
      code = STATUS_TO_CODE[exception.getStatus()] ?? 'internal_error';
      if (exception.getStatus() === HttpStatus.NOT_FOUND) detail = undefined;
    } else if (
      typeof (exception as { type?: unknown })?.type === 'string' &&
      String((exception as { type: string }).type).startsWith('entity.')
    ) {
      // error จากตัวอ่าน body (body-parser): ใหญ่เกิน / JSON เสีย
      const t = (exception as { type: string }).type;
      code = t === 'entity.too.large' ? 'payload_too_large' : 'bad_request';
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    const def = PROBLEMS[code];
    const body = {
      type: `https://docs.tms.example/problems/${code}`,
      title: def[locale],
      status: def.status,
      code,
      ...(detail ? { detail } : {}),
      instance: req.originalUrl,
      requestId: ctx?.requestId,
      ...(errors?.length ? { errors } : {}),
      ...(extra ?? {}),
    };
    if (typeof extra?.retryAfter === 'number')
      res.setHeader('Retry-After', String(extra.retryAfter));
    res.status(def.status).type('application/problem+json').send(JSON.stringify(body));
  }
}
