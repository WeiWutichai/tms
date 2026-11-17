import { ValidationError, ValidationPipe } from '@nestjs/common';
import { ValidateBy, buildMessage, type ValidationOptions } from 'class-validator';
import { ProblemException, type FieldError } from './problem';

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.entries(e.constraints ?? {}).map(([code, message]) => ({
      field,
      code,
      message,
    }));
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/** ทุก DTO ผ่าน class-validator; field แปลกปลอม → 422 (ไม่ทิ้งเงียบ) */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) =>
      new ProblemException('validation_failed', undefined, flatten(errors)),
  });
}

/**
 * จำนวนตำแหน่งทศนิยมของตัวเลข JS — รองรับรูปแบบ exponent (`1e-7` → 7, `1.5e3` → 0)
 * (class-validator `IsNumber({ maxDecimalPlaces })` ล้มด้วย TypeError กับ `1e-7` → 500 — review ST2-T09)
 */
export function decimalPlaces(v: number): number {
  const m = /^-?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(v));
  if (!m) return Infinity;
  const frac = m[2]?.length ?? 0;
  const exp = m[3] ? Number(m[3]) : 0;
  return Math.max(0, frac - exp);
}

/**
 * ตัวเลขจำกัด (ไม่ใช่ NaN/Infinity) และทศนิยมไม่เกิน `places` ตำแหน่ง — ใช้แทน `IsNumber({ maxDecimalPlaces })` ทุกที่
 * error code `isNumber` เหมือนเดิม (ข้อความ/การแปลฝั่งเว็บไม่เปลี่ยน)
 */
export const IsDecimal = (places: number, options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isNumber',
      constraints: [places],
      validator: {
        validate: (v: unknown) =>
          typeof v === 'number' && Number.isFinite(v) && decimalPlaces(v) <= places,
        defaultMessage: buildMessage(
          (each) => `${each}$property must be a number with at most $constraint1 decimal places`,
          options,
        ),
      },
    },
    options,
  );

/** RFC 3339 แบบขยาย: วันที่ + เวลาถึงวินาที (+ เศษวินาที) + offset `Z` / `±HH:MM` (รับ `±HHMM` ที่ `Date` อ่านถูก) */
const DATE_TIME_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

/** ตรวจรูปแบบ (ไม่ใช้ IsISO8601 อย่างเดียว — รูปย่อเช่น `2026-11-17T09Z` ผ่าน แต่ `new Date()` = NaN → 500) */
export function isDateTimeWithOffset(v: unknown): boolean {
  return typeof v === 'string' && DATE_TIME_OFFSET.test(v) && !Number.isNaN(new Date(v).getTime());
}

/** เวลา (timestamptz) ที่ต้องมี offset — ST4-T01 `occurredAt` (review) */
export function IsDateTimeWithOffset(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDateTimeWithOffset',
      validator: {
        validate: (v) => isDateTimeWithOffset(v),
        defaultMessage: buildMessage(
          (each) =>
            `${each}$property must be an RFC 3339 date-time with offset (YYYY-MM-DDTHH:MM:SS±HH:MM)`,
          options,
        ),
      },
    },
    options,
  );
}
