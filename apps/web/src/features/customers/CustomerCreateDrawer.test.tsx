import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { I18nProvider } from '../../i18n';

/**
 * P1-ST6-T02 (review): 422 `validation_failed` ที่ error ลงช่องกรอก (errors[]) ต้องยังมีลิงก์ "ดูวิธีแก้" → errors.html#validation_failed
 * (เดิมแถบบนแสดงเฉพาะเมื่อไม่มี error ระดับช่อง)
 */
const err = new ApiError({
  type: 'https://docs.tms.example/problems/validation_failed',
  code: 'validation_failed',
  status: 422,
  title: 'Validation failed',
  errors: [{ field: 'taxId', code: 'invalid', message: 'invalid' }],
} as ConstructorParameters<typeof ApiError>[0]);

vi.mock('./useCustomers', () => ({
  useNextCustomerCode: () => ({ data: undefined }),
  useCreateCustomer: () => ({ error: err, isPending: false, mutate: vi.fn(), reset: vi.fn() }),
}));
const { CustomerCreateDrawer } = await import('./CustomerCreateDrawer');

describe('CustomerCreateDrawer — error 422 ที่ลงช่องกรอก', () => {
  it('แสดง error ใต้ช่อง และแถบบนพร้อมลิงก์ "ดูวิธีแก้" ไปหัวข้อ validation_failed', () => {
    render(
      <I18nProvider>
        <CustomerCreateDrawer open onClose={() => undefined} onCreated={() => undefined} />
      </I18nProvider>,
    );
    const a = screen.getByRole('link', { name: 'ดูวิธีแก้' });
    expect(a.getAttribute('href')).toBe('/help/errors.html#validation_failed');
    // error ระดับช่องยังอยู่ (ข้อความกลางภาษาไทยของช่องที่ผิด)
    expect(document.querySelector('[aria-invalid="true"]')).not.toBeNull();
  });
});
