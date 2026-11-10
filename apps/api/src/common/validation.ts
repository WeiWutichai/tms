import { ValidationError, ValidationPipe } from '@nestjs/common';
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
