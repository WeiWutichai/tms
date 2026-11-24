import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * หน้าโปรไฟล์ (ST1-T09) — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ (การ์ดหน้าตั้งค่า)
 * แก้ชื่อ/เบอร์ (If-Match) · ลายเซ็น (อัปโหลดเอกสาร SIGNATURE → PATCH signatureDocumentId) · เปลี่ยนรหัสผ่าน · ออกรหัสสำรองใหม่
 */
type Call = { method: string; path: string; opts?: Record<string, unknown> };
const calls: Call[] = [];
let twoFa = { enabled: true, required: true, backupCodesRemaining: 2 };
const logout = vi.fn(() => Promise.resolve());
const res = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Promise.resolve({
    data: status < 300 ? data : undefined,
    error: status < 300 ? undefined : data,
    response: new Response(null, { status, headers }),
  });
const PROFILE = {
  name: 'สมชาย ใจดี',
  email: 'a@x.th',
  phone: null,
  locale: 'th',
  timezone: 'Asia/Bangkok',
  signature: null,
};

vi.mock('../../auth/session', async (orig) => ({
  ...(await orig<typeof import('../../auth/session')>()),
  logout: () => logout(),
}));
vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  const handle = (method: string) => (path: string, opts?: Record<string, unknown>) => {
    calls.push({ method, path, opts });
    if (path === '/v1/me/profile' && method === 'GET') return res(PROFILE, 200, { ETag: '"3"' });
    if (path === '/v1/me/profile') return res({ ...PROFILE, ...(opts?.body as object) });
    if (path === '/v1/me/2fa') return res(twoFa);
    if (path === '/v1/me/password') {
      const b = opts?.body as { currentPassword: string };
      return b.currentPassword === 'wrong'
        ? res(
            {
              code: 'validation_failed',
              status: 422,
              title: '',
              type: '',
              errors: [{ field: 'currentPassword', code: 'password_incorrect', message: '' }],
            },
            422,
          )
        : res(undefined, 204);
    }
    if (path === '/v1/me/2fa/backup-codes') return res({ backupCodes: ['AAAA-1111', 'BBBB-2222'] });
    if (path === '/v1/documents') return res({ id: 'doc_1', uploadUrl: '/v1/uploads/x?sig=1' });
    return res({});
  };
  return {
    ...real,
    api: { GET: handle('GET'), POST: handle('POST'), PATCH: handle('PATCH') },
  };
});

const { ProfilePage } = await import('./ProfilePage');

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider lang="th">
        <MemoryRouter>
          <ProfilePage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('ProfilePage (ST1-T09)', () => {
  beforeEach(() => {
    calls.length = 0;
    logout.mockClear();
    twoFa = { enabled: true, required: true, backupCodesRemaining: 2 };
  });

  it('แก้ชื่อ/เบอร์ → ปุ่มบันทึกลอย → PATCH พร้อม If-Match · อีเมลแก้ไม่ได้', async () => {
    mount();
    const name = (await screen.findByDisplayValue('สมชาย ใจดี')) as HTMLInputElement;
    expect((screen.getByLabelText('อีเมล') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'สมชาย ใจงาม' } });
    fireEvent.change(screen.getByLabelText('เบอร์โทร'), { target: { value: '0812345678' } });
    fireEvent.click(await screen.findByRole('button', { name: /บันทึก/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.opts).toMatchObject({
        body: { name: 'สมชาย ใจงาม', phone: '0812345678' },
        params: { header: { 'If-Match': '"3"' } },
      }),
    );
    expect(await screen.findByText('บันทึกข้อมูลส่วนตัวแล้ว')).toBeTruthy();
  });

  it('ลายเซ็น: ไฟล์ผิดชนิด = แจ้ง ไม่อัปโหลด · PNG → POST /documents (SIGNATURE) → PUT → PATCH signatureDocumentId', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    mount();
    const input = (await screen.findByTestId('profile-signature-file')) as HTMLInputElement;
    await screen.findByDisplayValue('สมชาย ใจดี');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByText(/ไฟล์ต้องเป็น PNG/)).toBeTruthy();
    expect(calls.some((c) => c.path === '/v1/documents')).toBe(false);
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'sig.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.opts).toMatchObject({
        body: { signatureDocumentId: 'doc_1' },
      }),
    );
    expect(calls.find((c) => c.path === '/v1/documents')?.opts).toMatchObject({
      body: { kind: 'SIGNATURE', mime: 'image/png' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/uploads/x?sig=1',
      expect.objectContaining({ method: 'PUT' }),
    );
    vi.unstubAllGlobals();
  });

  it('เปลี่ยนรหัสผ่าน: ตรวจสั้น/ไม่ตรง ก่อนส่ง · รหัสเดิมผิด = แจ้ง · สำเร็จ = ออกจากระบบ', async () => {
    mount();
    const cur = await screen.findByLabelText('รหัสผ่านปัจจุบัน');
    const submit = screen.getByRole('button', { name: /เปลี่ยนรหัสผ่าน/ });
    fireEvent.change(cur, { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('รหัสผ่านใหม่'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), { target: { value: 'short' } });
    fireEvent.click(submit);
    expect(await screen.findByText('รหัสผ่านใหม่อย่างน้อย 12 ตัวอักษร')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('รหัสผ่านใหม่'), {
      target: { value: 'NewPassword#2569' },
    });
    fireEvent.click(submit);
    expect(await screen.findByText('รหัสผ่านทั้งสองช่องไม่ตรงกัน')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), {
      target: { value: 'NewPassword#2569' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/me/password')).toBe(true));
    expect(await screen.findByText('รหัสผ่านปัจจุบันไม่ถูกต้อง')).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();
    fireEvent.change(cur, { target: { value: 'OldPassword#2569' } });
    fireEvent.click(submit);
    expect(await screen.findByText(/เปลี่ยนรหัสผ่านแล้ว/)).toBeTruthy();
    await waitFor(() => expect(logout).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('2FA: สถานะ + รหัสสำรองที่เหลือ · ออกรหัสสำรองใหม่ → แสดงรหัส · ยังไม่เปิด = ไม่มีปุ่ม', async () => {
    const a = mount();
    expect(await screen.findByText('รหัสสำรองเหลือ 2 รหัส')).toBeTruthy();
    expect(screen.getByText('บทบาทของคุณบังคับใช้ 2FA')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /ออกรหัสสำรองใหม่/ }));
    expect(await screen.findByText('AAAA-1111')).toBeTruthy();
    a.unmount();
    twoFa = { enabled: false, required: false, backupCodesRemaining: 0 };
    mount();
    expect(await screen.findByText('บทบาทของคุณไม่บังคับ 2FA')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ออกรหัสสำรองใหม่/ })).toBeNull();
  });
});
