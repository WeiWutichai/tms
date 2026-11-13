import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import type { T } from '../../i18n';
import { th } from '../../i18n/th';
import { fieldErrors } from './problems';

const t = ((k: string) => (th as Record<string, string>)[k] ?? k) as T;
const err = (errors: { field: string; code: string; message: string }[]) =>
  new ApiError({
    type: '',
    title: '',
    status: 409,
    code: 'order_locked_for_update',
    errors,
  } as never);

describe('fieldErrors (QA ST3-T02)', () => {
  it('รหัสที่มีในแคตตาล็อก → ไทย · ไม่มี + ข้อความอังกฤษ → ข้อความกลางไทย · ข้อความไทยจาก server คงไว้', () => {
    const out = fieldErrors(
      err([
        {
          field: 'stops[0].siteId',
          code: 'locked',
          message: 'cannot change stops when order is PLANNED',
        },
        { field: 'x', code: 'weird_code', message: 'some english text' },
        { field: 'y', code: 'weird_code', message: 'รหัสซ้ำกับแถว 3' },
      ]),
      t,
    );
    expect(out['stops[0].siteId']).toBe(th['field.locked']);
    expect(out.x).toBe(th['field.invalid']);
    expect(out.y).toBe('รหัสซ้ำกับแถว 3');
  });
});
