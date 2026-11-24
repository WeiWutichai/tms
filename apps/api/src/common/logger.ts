import type { LoggerService, LogLevel } from '@nestjs/common';
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
  'lineChannelAccessToken',
  '*.lineChannelAccessToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'otp',
  '*.otp',
  'mfaToken',
  '*.mfaToken',
  'backupCode',
  '*.backupCode',
  'backupCodes',
  '*.backupCodes',
  'stepUpToken',
  '*.stepUpToken',
  'headers["x-step-up"]',
  'req.headers["x-step-up"]',
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
  'accountNo',
  '*.accountNo',
  'taxId',
  '*.taxId',
  // ST7-T13 credential ของ connector (body ของ POST /connectors, PUT /connectors/:id/credentials) + ค่าตั้งเต็มของ ErpContext
  'credentials',
  '*.credentials',
  'config',
  '*.config',
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

/**
 * ST9-T13 R2 (L-02): ให้ `Logger` ของ Nest (ทุกโมดูล) ออกทาง pino ตัวเดียวกัน — ได้ requestId/tenantId + redact ของ object
 * (ข้อความ string ไม่ถูก redact — โมดูลต้องไม่ใส่ค่าลับในข้อความอยู่ดี) · ใช้ใน main.ts / worker.ts (test ใช้ ConsoleLogger เดิม)
 */
export class PinoNestLogger implements LoggerService {
  /** `levels` = ระดับของ Nest ที่ให้ออก (เช่น worker เดิม `['error', 'warn']`) · ไม่ระบุ = ทุกระดับ (ตาม LOG_LEVEL ของ pino) */
  constructor(
    private readonly out: pino.Logger,
    private readonly levels?: readonly LogLevel[],
  ) {}
  private write(
    nest: LogLevel,
    level: 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'fatal',
    msg: unknown,
    rest: unknown[],
  ) {
    if (this.levels && !this.levels.includes(nest)) return;
    let context: string | undefined;
    let stack: string | undefined;
    const strs = rest.filter((x): x is string => typeof x === 'string');
    if (level === 'error' || level === 'fatal') {
      // Nest: error(message, stack?, context?) — 2 ค่า = stack + context · ค่าเดียว = stack ถ้าหน้าตาเป็น stack trace ไม่งั้น context
      if (strs.length >= 2) [stack, context] = [strs[0], strs[strs.length - 1]];
      else if (strs.length === 1) {
        if (/\n\s+at /.test(strs[0]!)) stack = strs[0];
        else context = strs[0];
      }
    } else context = strs[strs.length - 1];
    if (msg instanceof Error) this.out[level]({ err: msg, context }, msg.message);
    else if (msg !== null && typeof msg === 'object') this.out[level]({ ...msg, context });
    else this.out[level]({ context, ...(stack ? { stack } : {}) }, String(msg));
  }
  log(msg: unknown, ...rest: unknown[]) {
    this.write('log', 'info', msg, rest);
  }
  error(msg: unknown, ...rest: unknown[]) {
    this.write('error', 'error', msg, rest);
  }
  warn(msg: unknown, ...rest: unknown[]) {
    this.write('warn', 'warn', msg, rest);
  }
  debug(msg: unknown, ...rest: unknown[]) {
    this.write('debug', 'debug', msg, rest);
  }
  verbose(msg: unknown, ...rest: unknown[]) {
    this.write('verbose', 'trace', msg, rest);
  }
  fatal(msg: unknown, ...rest: unknown[]) {
    this.write('fatal', 'fatal', msg, rest);
  }
}
