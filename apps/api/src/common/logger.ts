import pino from 'pino';
import { requestContext } from './request-context';

/** path ที่ห้ามออก log (ST0-T12) — เพิ่มที่นี่เมื่อมี field ลับใหม่ */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'nationalId',
  '*.nationalId',
  'bankAccount',
  '*.bankAccount',
];

/** structured log มี requestId + tenantId ทุกบรรทัด (ST0-T03) */
export function createLogger(destination?: pino.DestinationStream) {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin() {
        const ctx = requestContext.get();
        return ctx ? { requestId: ctx.requestId, tenantId: ctx.tenantId } : {};
      },
    },
    destination,
  );
}
