import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api';
import { I18nProvider } from '../i18n';

/** P1-ST4-T06 หน้า ทีมงาน (`team`) + Audit log (`aud`) ของ Platform Console */
type Call = { method: string; path: string; opts?: { params?: unknown; body?: unknown } };
const calls: Call[] = [];
let role = 'SUPER_ADMIN';
const ok = (data: unknown, status = 200) =>
  Promise.resolve({ data, response: new Response(null, { status }) });

const TEAM = [
  {
    id: 'stf_me',
    name: 'กิตติ วัฒนา',
    email: 's@i.th',
    role: 'SUPER_ADMIN',
    twoFactorEnabled: true,
    lastLoginAt: '2026-11-04T03:02:00.000Z',
    status: 'active',
    inviteExpiresAt: null,
  },
  {
    id: 'stf_sup',
    name: 'มาลี ใจดี',
    email: 'malee@i.th',
    role: 'SUPPORT',
    twoFactorEnabled: true,
    lastLoginAt: null,
    status: 'active',
    inviteExpiresAt: null,
  },
  {
    id: 'stf_new',
    name: 'สุดา พึ่งทอง',
    email: 'suda@i.th',
    role: 'BILLING',
    twoFactorEnabled: false,
    lastLoginAt: null,
    status: 'invited',
    inviteExpiresAt: '2026-11-11T03:00:00.000Z',
  },
];
const AUDIT = {
  data: [
    {
      id: 'aud_1',
      at: '2026-11-04T03:24:00.000Z',
      staff: { id: 'stf_sup', name: 'มาลี ใจดี', role: 'SUPPORT' },
      onBehalfOf: { id: 'usr_o', name: 'คุณหนึ่ง' },
      action: 'impersonation.started',
      tenant: { id: 'ten_1', name: 'บริษัท หนึ่ง จำกัด' },
      entityType: 'tenant',
      entityId: 'ten_1',
      before: null,
      after: { sessionId: 's1', ticketRef: '#77', mode: 'read_only' },
      reason: 'ลูกค้าแจ้งหน้ารายงานว่าง',
      ip: '10.0.0.1',
      impersonationSessionId: 's1',
    },
    {
      id: 'pal_1',
      at: '2026-11-04T03:00:00.000Z',
      staff: { id: 'stf_me', name: 'กิตติ วัฒนา', role: 'SUPER_ADMIN' },
      onBehalfOf: null,
      action: 'platform.staff_invited',
      tenant: null,
      entityType: 'platform_user',
      entityId: 'stf_new',
      before: null,
      after: { email: 'suda@i.th', role: 'BILLING' },
      reason: 'รับพนักงานการเงินใหม่',
      ip: null,
      impersonationSessionId: null,
    },
  ],
  nextCursor: null,
  hasMore: false,
};

vi.mock('./session', async (orig) => {
  const real = await orig<typeof import('./session')>();
  const handle = (method: string) => (path: string, opts?: Call['opts']) => {
    calls.push({ method, path, opts });
    if (path === '/v1/platform/team') return ok(TEAM);
    if (path === '/v1/platform/tenants') return ok([{ id: 'ten_1', name: 'บริษัท หนึ่ง จำกัด' }]);
    if (path === '/v1/platform/audit-logs') return ok(AUDIT);
    if (path === '/v1/platform/audit-logs/export') return ok(new Blob(['x']));
    if (path === '/v1/platform/team/invitations') return ok({ ...TEAM[2], email: 'new@i.th' }, 201);
    if (path === '/v1/platform/team/{id}/deactivate') return ok({ ...TEAM[1], status: 'disabled' });
    return ok({});
  };
  return {
    ...real,
    consoleApi: { GET: handle('GET'), POST: handle('POST') },
    useStaff: () => ({ data: { id: 'x', role, name: 'กิตติ วัฒนา', email: 's@i.th' } }),
    // มี step-up ของ Console ในหน่วยความจำแล้ว (กล่องยืนยัน 2FA ทดสอบใน consoleStepUp.test.tsx)
    consoleStepUpHeaders: () => ({ 'X-Step-Up': 'su' }),
  };
});

const { TeamPage } = await import('./Team');
const { AuditPage } = await import('./Audit');

function mount(path: string) {
  queryClient.clear();
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider lang="th">
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/console/team" element={<TeamPage />} />
            <Route path="/console/audit" element={<AuditPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Console: ทีมงาน', () => {
  beforeEach(() => {
    calls.length = 0;
    role = 'SUPER_ADMIN';
  });

  it('ตาราง: ชื่อ/อีเมล, บทบาท, สิทธิ์, เข้าใช้ล่าสุด, 2FA, สถานะ', async () => {
    mount('/console/team');
    expect(await screen.findByRole('heading', { name: 'ทีมงานและสิทธิ์' })).toBeTruthy();
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[0]!.textContent).toContain('ชื่อบทบาทสิทธิ์เข้าใช้ล่าสุด2FAสถานะ');
    await screen.findByText('มาลี ใจดี');
    const r1 = screen.getByText('กิตติ วัฒนา').closest('tr')!;
    expect(r1.textContent).toContain('s@i.th');
    expect(r1.textContent).toContain('ทุกอย่าง รวมแก้แพ็กเกจและทีมงาน');
    expect(r1.textContent).toContain('เปิดแล้ว');
    expect(r1.textContent).toContain('ใช้งาน');
    // ตัวเองปิดไม่ได้ (ไม่มีปุ่ม)
    expect(within(r1).queryByRole('button')).toBeNull();
    const r3 = screen.getByText('สุดา พึ่งทอง').closest('tr')!;
    expect(r3.textContent).toContain('ยังไม่ตั้ง');
    expect(r3.textContent).toContain('รอรับคำเชิญ');
    expect(r3.textContent).toContain('คำเชิญหมดอายุ');
  });

  it('เชิญทีมงาน: ชื่อ อีเมล บทบาท + เหตุผล → POST invitations พร้อม X-Step-Up', async () => {
    mount('/console/team');
    fireEvent.click(await screen.findByRole('button', { name: 'เชิญทีมงาน' }));
    const dlg = await screen.findByRole('dialog', { name: 'เชิญทีมงาน' });
    fireEvent.change(within(dlg).getByLabelText('ชื่อ-นามสกุล'), { target: { value: 'ใหม่ ดี' } });
    fireEvent.change(within(dlg).getByLabelText('อีเมล'), { target: { value: 'new@i.th' } });
    fireEvent.change(within(dlg).getByLabelText('บทบาท'), { target: { value: 'BILLING' } });
    fireEvent.change(within(dlg).getByLabelText('เหตุผล'), {
      target: { value: 'รับพนักงานการเงินใหม่' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'เชิญทีมงาน' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/platform/team/invitations')?.opts).toMatchObject({
        params: { header: { 'X-Step-Up': 'su' } },
        body: {
          name: 'ใหม่ ดี',
          email: 'new@i.th',
          role: 'BILLING',
          reason: 'รับพนักงานการเงินใหม่',
        },
      }),
    );
    expect(await screen.findByText(/ส่งคำเชิญถึง new@i.th แล้ว/)).toBeTruthy();
  });

  it('ปิดการใช้งาน: เหตุผล ≥ 10 ตัว → POST deactivate', async () => {
    mount('/console/team');
    await screen.findByText('มาลี ใจดี');
    const row = screen.getByText('มาลี ใจดี').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'ปิดการใช้งาน' }));
    const dlg = await screen.findByRole('dialog', { name: /ปิดการใช้งาน · มาลี ใจดี/ });
    const ok = within(dlg).getByRole('button', { name: 'ปิดการใช้งาน' }) as HTMLButtonElement;
    fireEvent.change(within(dlg).getByLabelText('เหตุผล'), { target: { value: 'สั้น' } });
    expect(ok.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText('เหตุผล'), {
      target: { value: 'ลาออกจากบริษัท ปิดสิทธิ์ทันที' },
    });
    fireEvent.click(ok);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/platform/team/{id}/deactivate')?.opts).toMatchObject(
        {
          params: { path: { id: 'stf_sup' } },
          body: { reason: 'ลาออกจากบริษัท ปิดสิทธิ์ทันที' },
        },
      ),
    );
    expect(await screen.findByText(/ปิดการใช้งาน มาลี ใจดี แล้ว/)).toBeTruthy();
  });

  it('SUPPORT / BILLING ดูได้แต่ไม่เห็นปุ่มเชิญ/ปิด', async () => {
    role = 'SUPPORT';
    mount('/console/team');
    await screen.findByText('มาลี ใจดี');
    expect(screen.queryByRole('button', { name: 'เชิญทีมงาน' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ปิดการใช้งาน' })).toBeNull();
  });
});

describe('Console: Audit log', () => {
  beforeEach(() => {
    calls.length = 0;
    role = 'BILLING';
  });

  it('คอลัมน์ตามต้นแบบ · เข้าใช้งานแทนแสดงทีมงาน (act) + ในนามผู้ใช้ · แถวแพลตฟอร์ม', async () => {
    mount('/console/audit');
    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeTruthy();
    const imp = (await screen.findByText('เริ่มเข้าใช้งานแทน')).closest('tr')!;
    expect(imp.textContent).toContain('มาลี ใจดี (support)');
    expect(imp.textContent).toContain('บริษัท หนึ่ง จำกัด');
    expect(imp.textContent).toContain('ในนาม คุณหนึ่ง · ticket #77');
    expect(imp.textContent).toContain('ลูกค้าแจ้งหน้ารายงานว่าง');
    const inv = screen.getByText('เชิญทีมงาน').closest('tr')!;
    expect(inv.textContent).toContain('แพลตฟอร์ม');
    expect(inv.textContent).toContain('suda@i.th · billing');
    const head = within(screen.getByRole('table')).getAllByRole('row')[0]!;
    expect(head.textContent).toBe('เวลาใครทำอะไรลูกค้ารายละเอียดเหตุผล');
  });

  it('คลิกแถว → drawer: ใคร/ในนาม/IP/session + diff ก่อน/หลัง (spec/01 §11.5)', async () => {
    mount('/console/audit');
    fireEvent.click(await screen.findByText('เริ่มเข้าใช้งานแทน'));
    const dlg = await screen.findByRole('dialog', { name: 'เริ่มเข้าใช้งานแทน' });
    expect(dlg.textContent).toContain('Audit log · aud_1');
    expect(dlg.textContent).toContain('มาลี ใจดี (support)');
    expect(dlg.textContent).toContain('คุณหนึ่ง');
    expect(dlg.textContent).toContain('10.0.0.1');
    expect(dlg.textContent).toContain('s1');
    const diff = within(dlg).getByRole('table', { name: 'การเปลี่ยนแปลง' });
    const r = within(diff)
      .getAllByRole('row')
      .find((x) => x.textContent?.startsWith('ticketRef'))!;
    expect(r.textContent).toBe('ticketRef—#77');
    fireEvent.click(within(dlg).getByRole('button', { name: 'ปิด' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('กรอง → query ไป API · ส่งออก CSV ใช้ตัวกรองเดียวกัน', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    mount('/console/audit');
    await screen.findByText('เริ่มเข้าใช้งานแทน');
    fireEvent.change(screen.getByLabelText('ทีมงาน'), { target: { value: 'stf_sup' } });
    fireEvent.change(screen.getByLabelText('การกระทำ'), { target: { value: 'impersonation.' } });
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/v1/platform/audit-logs').at(-1)?.opts).toMatchObject({
        params: { query: { staffId: 'stf_sup', action: 'impersonation.' } },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ส่งออก CSV' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/platform/audit-logs/export')?.opts).toMatchObject({
        params: { query: { staffId: 'stf_sup', action: 'impersonation.' } },
      }),
    );
    expect(await screen.findByText('ส่งออก audit log แล้ว')).toBeTruthy();
  });
});
