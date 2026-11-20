import type { MockKrsOptions } from './mock-krs';

/**
 * ค่าตั้งของ mock จาก env (ใช้ใน CLI) — ทุก option ที่ startMockKrs({...}) รับ ตั้งผ่าน env ได้ด้วย
 * ค่าผิดรูป = throw (CLI ไม่ยอมเริ่ม) · ไม่ตั้ง = ค่าเริ่มของ MockKrs
 */
export interface MockKrsEnvConfig {
  port: number;
  host: string;
  options: MockKrsOptions;
}

export const MOCK_KRS_ENV_VARS = [
  'MOCK_KRS_PORT',
  'MOCK_KRS_HOST',
  'MOCK_KRS_API_KEY',
  'MOCK_KRS_BASE_PATH',
  'MOCK_KRS_SCHEMA_DIR',
  'MOCK_KRS_TRANSACTION_NO_START',
  'MOCK_KRS_MAX_BODY_BYTES',
  'MOCK_KRS_OVERSIZE_STATUS',
  'MOCK_KRS_TIMEOUT_MS',
  'MOCK_KRS_HEADER_FAULTS',
  'MOCK_KRS_VOUCHER_PERIOD_FROM',
  'MOCK_KRS_INCLUDE_AMOUNTS',
  'MOCK_KRS_AMOUNT_ROUNDING',
  'MOCK_KRS_PUT_TMS_VOUCHER_NO_CHANGE',
  'MOCK_KRS_PUT_CHECK_ORDER',
  'MOCK_KRS_UNSUPPORTED_METHOD_STATUS',
  'MOCK_KRS_RETRY_AFTER',
  'MOCK_KRS_SO_SAMPLE',
] as const;

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, min: number, max: number): number | undefined {
  const v = env[name];
  if (v === undefined || v === '') return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max)
    throw new Error(`${name} must be an integer ${min}-${max}`);
  return Number(v);
}

function oneOf<T extends string>(env: Env, name: string, values: readonly T[]): T | undefined {
  const v = env[name];
  if (v === undefined || v === '') return undefined;
  if (!(values as readonly string[]).includes(v))
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  return v as T;
}

function bool(env: Env, name: string): boolean | undefined {
  const v = oneOf(env, name, ['true', 'false', '1', '0'] as const);
  return v === undefined ? undefined : v === 'true' || v === '1';
}

export function optionsFromEnv(env: Env): MockKrsEnvConfig {
  const o: MockKrsOptions = {};
  const set = <K extends keyof MockKrsOptions>(k: K, v: MockKrsOptions[K] | undefined) => {
    if (v !== undefined) o[k] = v;
  };
  if (env.MOCK_KRS_API_KEY) o.apiKey = env.MOCK_KRS_API_KEY;
  if (env.MOCK_KRS_BASE_PATH !== undefined && env.MOCK_KRS_BASE_PATH !== '') {
    if (!env.MOCK_KRS_BASE_PATH.startsWith('/'))
      throw new Error('MOCK_KRS_BASE_PATH must start with /');
    o.basePath = env.MOCK_KRS_BASE_PATH;
  }
  if (env.MOCK_KRS_SCHEMA_DIR) o.schemaDir = env.MOCK_KRS_SCHEMA_DIR;
  set('transactionNoStart', int(env, 'MOCK_KRS_TRANSACTION_NO_START', 1, Number.MAX_SAFE_INTEGER));
  set('maxBodyBytes', int(env, 'MOCK_KRS_MAX_BODY_BYTES', 1, 1024 * 1024 * 1024));
  set('oversizeStatus', int(env, 'MOCK_KRS_OVERSIZE_STATUS', 400, 599));
  set('timeoutMs', int(env, 'MOCK_KRS_TIMEOUT_MS', 1, 3_600_000));
  set('allowHeaderFaults', bool(env, 'MOCK_KRS_HEADER_FAULTS'));
  set('voucherPeriodFrom', oneOf(env, 'MOCK_KRS_VOUCHER_PERIOD_FROM', ['voucherDate', 'clock']));
  set('includeAmounts', bool(env, 'MOCK_KRS_INCLUDE_AMOUNTS'));
  set(
    'amountRounding',
    oneOf(env, 'MOCK_KRS_AMOUNT_ROUNDING', ['line-half-up', 'total-half-up', 'line-half-even']),
  );
  set(
    'putTmsVoucherNoChange',
    oneOf(env, 'MOCK_KRS_PUT_TMS_VOUCHER_NO_CHANGE', ['accept', 'reject400']),
  );
  set('putCheckOrder', oneOf(env, 'MOCK_KRS_PUT_CHECK_ORDER', ['validate-first', 'lookup-first']));
  const ums = oneOf(env, 'MOCK_KRS_UNSUPPORTED_METHOD_STATUS', ['404', '405']);
  if (ums) o.unsupportedMethodStatus = Number(ums) as 404 | 405;
  const ra = env.MOCK_KRS_RETRY_AFTER;
  if (ra !== undefined && ra !== '')
    o.retryAfterSeconds =
      ra === 'none' ? null : (int(env, 'MOCK_KRS_RETRY_AFTER', 0, 86_400) ?? 60);
  set('salesOrderSample', bool(env, 'MOCK_KRS_SO_SAMPLE'));
  const port = int(env, 'MOCK_KRS_PORT', 0, 65_535) ?? 4784;
  return { port, host: env.MOCK_KRS_HOST || '127.0.0.1', options: o };
}
