import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const state = { data: undefined as unknown };
const mutateAsync = vi.fn();
vi.mock('./useSettings', () => ({
  useTenantSettings: () => ({ data: state.data }),
  useSaveTenantSettings: () => ({ isPending: false, mutateAsync }),
}));
const GET = vi.fn();
const POST = vi.fn();
vi.mock('../../api', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    POST: (...a: unknown[]) => POST(...a),
  },
  unwrap: async (p: Promise<{ data: unknown }>) => (await p).data,
  ApiError: class ApiError extends Error {
    constructor(public problem: { code: string }) {
      super(problem.code);
    }
  },
}));

const { OrgLogo } = await import('./OrgLogo');

const show = (canWrite = true) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider lang="th">
        <OrgLogo canWrite={canWrite} />
      </I18nProvider>
    </QueryClientProvider>,
  );
const file = (type: string, size: number) => {
  const f = new File([new Uint8Array(Math.min(size, 16))], 'logo', { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

/** P1-ST6-T04 ตั้งค่า → องค์กร: ปุ่ม "เปลี่ยนโลโก้" (ต้นแบบ) อัปโหลด PNG/SVG ≤ 2 MB แล้วบันทึก org.logoDocumentId */
describe('โลโก้องค์กร (P1-ST6-T04)', () => {
  beforeEach(() => {
    state.data = { data: [{ key: 'org.logoDocumentId', value: null, version: 0 }] };
    GET.mockReset();
    POST.mockReset().mockResolvedValue({
      data: { id: 'doc_new', uploadUrl: 'http://api.test/v1/documents/doc_new/content?sig=1' },
    });
    mutateAsync.mockReset().mockResolvedValue({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  it('ยังไม่มีโลโก้: กล่องไอคอนรถ + ป้ายตามต้นแบบ · เลือก PNG → POST documents (LOGO) → PUT → บันทึกค่าตั้ง', async () => {
    show();
    expect(screen.getByText('โลโก้ (ใช้บนเอกสารและหน้าติดตามของผู้รับ)')).toBeTruthy();
    expect(screen.queryByTestId('org-logo')).toBeNull();
    const btn = screen.getByRole('button', { name: 'เปลี่ยนโลโก้' });
    expect(btn).toBeEnabled();
    fireEvent.change(screen.getByTestId('org-logo-input'), {
      target: { files: [file('image/png', 1200)] },
    });
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        values: { 'org.logoDocumentId': 'doc_new' },
        versions: { 'org.logoDocumentId': 0 },
      }),
    );
    expect(POST).toHaveBeenCalledWith('/v1/documents', {
      body: { kind: 'LOGO', mime: 'image/png', bytes: 1200, filename: 'logo' },
    });
    expect(fetch).toHaveBeenCalledWith('/v1/documents/doc_new/content?sig=1', expect.anything());
    expect(await screen.findByRole('status')).toHaveTextContent('บันทึกโลโก้แล้ว');
  });

  it('ชนิด/ขนาดไม่ผ่าน (JPEG, SVG > 2 MB) → ข้อความไทย ไม่อัปโหลด', async () => {
    show();
    const input = screen.getByTestId('org-logo-input');
    fireEvent.change(input, { target: { files: [file('image/jpeg', 100)] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ไฟล์โลโก้ต้องเป็น PNG ไม่เกิน 2 MB หรือ SVG ไม่เกิน 512 KB',
    );
    fireEvent.change(input, { target: { files: [file('image/svg+xml', 512 * 1024 + 1)] } });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(POST).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('มีโลโก้แล้ว: แสดงรูปในกล่อง 64 px · ไม่มีสิทธิ์แก้ = ปุ่มปิด', async () => {
    state.data = { data: [{ key: 'org.logoDocumentId', value: 'doc_cur', version: 2 }] };
    GET.mockResolvedValue({
      data: { id: 'doc_cur', downloadUrl: 'http://api.test/v1/documents/doc_cur/content?sig=2' },
    });
    show(false);
    const box = await screen.findByTestId('org-logo');
    expect(box.querySelector('img')?.getAttribute('src')).toBe(
      '/v1/documents/doc_cur/content?sig=2',
    );
    expect(box.getAttribute('style')).toContain('width: 64px');
    expect(screen.getByRole('button', { name: 'เปลี่ยนโลโก้' })).toBeDisabled();
  });
});
