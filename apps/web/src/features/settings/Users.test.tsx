import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * ตั้งค่า → ผู้ใช้และสิทธิ์: เมนูต่อแถว (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ — ST1-T07/T10/T11, #81)
 * ระงับ / เปิดใช้ / ลบ / รีเซ็ต 2FA / เปลี่ยนบทบาท / ส่งคำเชิญใหม่ / เพิกถอนคำเชิญ / ประวัติเข้าสู่ระบบ
 */
type Call = { method: string; path: string; opts?: { params?: unknown; body?: unknown } };
const calls: Call[] = [];
let scopes: string[] = [];
let resendFail = false;
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });

const ROLES = [
  { id: 'rol_o', code: 'owner', name: 'เจ้าของ', permissions: ['*'] },
  { id: 'rol_a', code: 'admin', name: 'ผู้ดูแลระบบ', permissions: ['users:write'] },
  { id: 'rol_p', code: 'planner', name: 'วางแผน', permissions: ['orders:read'] },
];
const U = (o: Record<string, unknown>) => ({
  roles: [{ id: 'rol_p', code: 'planner', name: 'วางแผน' }],
  twoFactorEnabled: false,
  lastLoginAt: null,
  updatedAt: '2026-11-01T00:00:00.000Z',
  status: 'active',
  ...o,
});
const USERS = [
  U({
    id: 'usr_me',
    name: 'ฉันเอง',
    email: 'me@x.th',
    roles: [{ id: 'rol_a', code: 'admin', name: 'ผู้ดูแลระบบ' }],
  }),
  U({ id: 'usr_a', name: 'สมชาย ใจดี', email: 'a@x.th', twoFactorEnabled: true }),
  U({
    id: 'usr_o',
    name: 'เจ้าของ บริษัท',
    email: 'o@x.th',
    twoFactorEnabled: true,
    roles: [{ id: 'rol_o', code: 'owner', name: 'เจ้าของ' }],
  }),
  U({ id: 'usr_d', name: 'สมหญิง พักงาน', email: 'd@x.th', status: 'disabled' }),
  U({ id: 'usr_i', name: 'รอรับ เชิญ', email: 'i@x.th', status: 'invited' }),
  U({ id: 'usr_e', name: 'หมด อายุ', email: 'e@x.th', status: 'invited' }),
];

vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  const handle = (method: string) => (path: string, opts?: Call['opts']) => {
    calls.push({ method, path, opts });
    if (path === '/v1/me')
      return ok({
        scopes,
        user: { name: 'ฉันเอง', email: 'me@x.th', roles: ['ผู้ดูแลระบบ'], locale: 'th' },
        tenant: { yearStyle: 'BE', name: 'x' },
      });
    if (path === '/v1/users') return ok({ data: USERS, hasMore: false, nextCursor: null });
    if (path === '/v1/roles') return ok({ data: ROLES });
    if (path === '/v1/users/invitations')
      return ok({
        data: [
          { id: 'inv_1', userId: 'usr_i', status: 'pending' },
          { id: 'inv_2', userId: 'usr_e', status: 'expired' },
        ],
      });
    if (path === '/v1/login-history')
      return ok({
        data: [
          {
            at: '2026-11-03T03:12:00.000Z',
            userId: 'usr_a',
            email: 'a@x.th',
            result: 'success',
            reason: 'mfa_ok',
            ip: '10.0.0.1',
            userAgent: 'Chrome',
          },
          {
            at: '2026-11-03T03:10:00.000Z',
            userId: 'usr_a',
            email: 'a@x.th',
            result: 'failed',
            reason: 'invalid_credentials',
            ip: '10.0.0.1',
            userAgent: null,
          },
        ],
        hasMore: true,
        nextCursor: 'c2',
      });
    // P1-ST2-T06 คำขอเข้าร่วมบริษัท
    if (path === '/v1/users/join-requests')
      return ok({
        data: [
          {
            id: 'jrq_1',
            applicantName: 'ณัฐวุฒิ แก้วดี',
            email: 'natt@x.th',
            mobile: null,
            branchCode: '00000',
            status: 'pending_owner',
            ownerDueAt: '2026-12-02T03:00:00.000Z',
            createdAt: '2026-11-27T03:00:00.000Z',
          },
        ],
      });
    if (path === '/v1/users/invitations/{id}/resend' && resendFail)
      return Promise.resolve({
        error: { code: 'rate_limited', status: 429, title: '', type: '' },
        response: new Response(null, { status: 429 }),
      });
    return ok({ id: 'x', status: 'active' });
  };
  return { ...real, api: { GET: handle('GET'), POST: handle('POST'), PUT: handle('PUT') } };
});

const { UsersSection } = await import('./Users');

function mount(canWrite = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider lang="th">
        <MemoryRouter>
          <UsersSection canWrite={canWrite} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const row = async (name: string) => (await screen.findByText(name)).closest('tr')!;
const openMenu = async (name: string) => {
  fireEvent.click(within(await row(name)).getByRole('button', { name: 'การกระทำ' }));
  return screen.getAllByRole('menuitem').map((m) => m.textContent);
};

describe('UsersSection — เมนูต่อแถว', () => {
  beforeEach(() => {
    calls.length = 0;
    scopes = ['users:read', 'users:write'];
  });

  it('รายการเมนูตามสถานะ · ตัวเองมีแค่ประวัติ · สถานะระงับ/คำเชิญหมดอายุแสดงป้าย', async () => {
    mount();
    expect(await openMenu('สมชาย ใจดี')).toEqual([
      'เปลี่ยนบทบาท',
      'รีเซ็ต 2FA',
      'ระงับการใช้งาน',
      'ประวัติเข้าสู่ระบบ',
      'ลบผู้ใช้',
    ]);
    fireEvent.click(document.body);
    expect(await openMenu('สมหญิง พักงาน')).toEqual([
      'เปิดใช้งานอีกครั้ง',
      'ประวัติเข้าสู่ระบบ',
      'ลบผู้ใช้',
    ]);
    fireEvent.click(document.body);
    expect(await openMenu('ฉันเอง')).toEqual(['ประวัติเข้าสู่ระบบ']);
    fireEvent.click(document.body);
    // ผู้ทำไม่ใช่เจ้าของ → จัดการเจ้าของไม่ได้ (API 403 manage_owner)
    expect(await openMenu('เจ้าของ บริษัท')).toEqual(['ประวัติเข้าสู่ระบบ']);
    fireEvent.click(document.body);
    await waitFor(async () =>
      expect(await openMenu('รอรับ เชิญ')).toEqual(['ส่งคำเชิญใหม่', 'เพิกถอนคำเชิญ']),
    );
    expect(within(await row('สมหญิง พักงาน')).getAllByText('ระงับการใช้งาน').length).toBe(1);
    expect(within(await row('หมด อายุ')).getByText('คำเชิญหมดอายุ')).toBeTruthy();
  });

  it('ไม่มี users:write = เมนูมีแค่ประวัติ · คำเชิญไม่มีเมนู', async () => {
    mount(false);
    expect(await openMenu('สมชาย ใจดี')).toEqual(['ประวัติเข้าสู่ระบบ']);
    expect(within(await row('รอรับ เชิญ')).queryByRole('button', { name: 'การกระทำ' })).toBeNull();
  });

  it('ระงับ → dialog เหตุผล ≥ 10 ตัว → POST suspend + toast', async () => {
    mount();
    await openMenu('สมชาย ใจดี');
    fireEvent.click(screen.getByRole('menuitem', { name: 'ระงับการใช้งาน' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('ระงับการใช้งาน สมชาย ใจดี')).toBeTruthy();
    const ok = within(dlg).getByRole('button', { name: 'ระงับการใช้งาน' }) as HTMLButtonElement;
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: 'สั้น' } });
    expect(ok.disabled).toBe(true);
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'พนักงานลาออกสิ้นเดือน' },
    });
    fireEvent.click(ok);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/users/{id}/suspend')?.opts).toMatchObject({
        params: { path: { id: 'usr_a' } },
        body: { reason: 'พนักงานลาออกสิ้นเดือน' },
      }),
    );
    expect(await screen.findByText('ระงับการใช้งาน สมชาย ใจดี แล้ว')).toBeTruthy();
  });

  it('รีเซ็ต 2FA → POST reset-2fa พร้อมเหตุผล (step-up ผ่าน withStepUp)', async () => {
    mount();
    await openMenu('สมชาย ใจดี');
    fireEvent.click(screen.getByRole('menuitem', { name: 'รีเซ็ต 2FA' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'ทำโทรศัพท์หายแจ้งทางโทร' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'รีเซ็ต 2FA' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/users/{id}/reset-2fa')?.opts).toMatchObject({
        body: { reason: 'ทำโทรศัพท์หายแจ้งทางโทร' },
      }),
    );
    expect(await screen.findByText('รีเซ็ต 2FA ของ สมชาย ใจดี แล้ว')).toBeTruthy();
  });

  it('เปลี่ยนบทบาท → Drawer checkbox (ไม่ใช่ owner = ไม่มีตัวเลือกเจ้าของ) + เหตุผล → PUT roles', async () => {
    mount();
    await openMenu('สมชาย ใจดี');
    fireEvent.click(screen.getByRole('menuitem', { name: 'เปลี่ยนบทบาท' }));
    expect(await screen.findByText('เปลี่ยนบทบาทต้องยืนยัน 2FA และระบุเหตุผล')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'เจ้าของ' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'ผู้ดูแลระบบ' }));
    const save = screen.getByRole('button', { name: /บันทึกบทบาท/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // ยังไม่มีเหตุผล
    expect(screen.getByText('กรอกอย่างน้อย 10 ตัวอักษร (0/10)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^เหตุผล/), {
      target: { value: 'ย้ายมาดูแลระบบแทนคนเดิม' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/users/{id}/roles')?.opts).toMatchObject({
        params: { path: { id: 'usr_a' } },
        body: { roles: ['planner', 'admin'], reason: 'ย้ายมาดูแลระบบแทนคนเดิม' },
      }),
    );
  });

  it('ส่งคำเชิญใหม่ล้มเหลว = toast แดง (ไม่ใช่สำเร็จ) · เปิดเมนูแถวใหม่ = เมนูเดิมปิด', async () => {
    resendFail = true;
    mount();
    await openMenu('สมชาย ใจดี');
    fireEvent.click(within(await row('สมหญิง พักงาน')).getByRole('button', { name: 'การกระทำ' }));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toContain(
      'เปิดใช้งานอีกครั้ง',
    );
    fireEvent.click(document.body);
    await waitFor(async () => expect(await openMenu('รอรับ เชิญ')).toContain('ส่งคำเชิญใหม่'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'ส่งคำเชิญใหม่' }));
    const st = await screen.findByRole('status');
    await waitFor(() => expect(st.textContent).toContain('เรียกถี่เกินไป'));
    expect(st.textContent).not.toContain('ส่งคำเชิญใหม่ถึง');
    resendFail = false;
  });

  it('คำเชิญ: ส่งใหม่ = POST resend · เพิกถอน = dialog เหตุผล → POST revoke', async () => {
    mount();
    await waitFor(async () => expect(await openMenu('รอรับ เชิญ')).toContain('ส่งคำเชิญใหม่'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'ส่งคำเชิญใหม่' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/users/invitations/{id}/resend')?.opts).toMatchObject(
        { params: { path: { id: 'inv_1' } } },
      ),
    );
    await openMenu('รอรับ เชิญ');
    fireEvent.click(screen.getByRole('menuitem', { name: 'เพิกถอนคำเชิญ' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'เชิญผิดอีเมลขอส่งใหม่' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'เพิกถอนคำเชิญ' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/users/invitations/{id}/revoke')?.opts).toMatchObject(
        { params: { path: { id: 'inv_1' } }, body: { reason: 'เชิญผิดอีเมลขอส่งใหม่' } },
      ),
    );
  });

  it('ประวัติเข้าสู่ระบบ: จากเมนูแถว = กรองผู้ใช้นั้น · ผล/รายละเอียดเป็นไทย · โหลดเพิ่มด้วย cursor', async () => {
    mount();
    await openMenu('สมชาย ใจดี');
    fireEvent.click(screen.getByRole('menuitem', { name: 'ประวัติเข้าสู่ระบบ' }));
    const tbl = await screen.findByRole('table', { name: 'ประวัติเข้าสู่ระบบ' });
    await within(tbl).findByText('เข้าสู่ระบบ (2FA)');
    expect(within(tbl).getByText('อีเมลหรือรหัสผ่านไม่ถูกต้อง')).toBeTruthy();
    expect(within(tbl).getByText('สำเร็จ')).toBeTruthy();
    expect(within(tbl).getByText('ไม่สำเร็จ')).toBeTruthy();
    const first = calls.find((c) => c.path === '/v1/login-history');
    expect(first?.opts).toMatchObject({ params: { query: { userId: 'usr_a', limit: 50 } } });
    expect((screen.getByLabelText('ผู้ใช้') as HTMLSelectElement).value).toBe('usr_a');
    fireEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === '/v1/login-history').map((c) => c.opts?.params),
      ).toContainEqual({ query: { limit: 50, userId: 'usr_a', cursor: 'c2' } }),
    );
  });

  it('คำขอเข้าร่วม (P1-ST2-T06): แถว "ขอเข้าร่วม" · เชิญ = ฟอร์มเชิญกรอกชื่อ/อีเมลให้ · ปฏิเสธ = เหตุผล → POST decline', async () => {
    mount();
    const r = await row('ณัฐวุฒิ แก้วดี');
    expect(within(r).getByText('ขอเข้าร่วม')).toBeTruthy();
    expect(await openMenu('ณัฐวุฒิ แก้วดี')).toEqual(['เชิญเข้าบริษัท', 'ปฏิเสธ']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'เชิญเข้าบริษัท' }));
    const form = await screen.findByRole('dialog');
    expect(within(form).getByDisplayValue('natt@x.th')).toBeTruthy();
    expect(within(form).getByDisplayValue('ณัฐวุฒิ แก้วดี')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'ยกเลิก' }));
    await openMenu('ณัฐวุฒิ แก้วดี');
    fireEvent.click(screen.getByRole('menuitem', { name: 'ปฏิเสธ' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'ไม่ใช่พนักงานของบริษัทเรา' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'ปฏิเสธ' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === '/v1/users/join-requests/{id}/decline')?.opts,
      ).toMatchObject({
        params: { path: { id: 'jrq_1' } },
        body: { reason: 'ไม่ใช่พนักงานของบริษัทเรา' },
      }),
    );
  });
});
