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
