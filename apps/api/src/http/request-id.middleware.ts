import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../common/request-context';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** ตั้ง requestId (รับจาก X-Request-Id ถ้ารูปแบบปลอดภัย) และเปิด AsyncLocalStorage ต่อ request */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    const requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    const locale = (req.header('accept-language') ?? '').toLowerCase().startsWith('en')
      ? 'en'
      : 'th';
    res.setHeader('X-Request-Id', requestId);
    requestContext.run({ requestId, locale, ip: req.ip }, () => next());
  }
}
