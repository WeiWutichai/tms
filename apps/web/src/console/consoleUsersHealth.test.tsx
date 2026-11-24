import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api';
import { I18nProvider } from '../i18n';

/**
 * PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ Console:
 * - #81 รีเซ็ต 2FA ผู้ใช้ลูกค้า (drawer ลูกค้า → แท็บผู้ใช้) — SUPER_ADMIN เท่านั้น · ActionDialog เหตุผล ≥ 10 ตัว
 * - #96 แท็บ "สุขภาพการเชื่อมต่อ" ในหน้า Connector — `GET /v1/platform/connectors/health`
 */
type Call = { method: string; path: string; opts?: { params?: unknown; body?: unknown } };
const calls: Call[] = [];
let role = 'SUPER_ADMIN';
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });

const DETAIL = {
  id: 'ten_1',
  name: 'ขนส่งดี',
  status: 'active',
  planCode: 'pro',
  vehicleQuota: null,
  users: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  members: [
    {
      id: 'usr_a',
      name: 'สมชาย',
      email: 'a@x.th',
      status: 'active',
      roles: ['owner'],
      twoFactorEnabled: true,
    },
    {
      id: 'usr_b',
      name: 'สมหญิง',
      email: 'b@x.th',
      status: 'active',
      roles: ['planner'],
      twoFactorEnabled: false,
    },
    {
      id: 'usr_c',
      name: 'รอรับ',
      email: 'c@x.th',
      status: 'invited',
      roles: ['viewer'],
      twoFactorEnabled: false,
    },
  ],
};
const metric = (o: Record<string, unknown> = {}) => ({
  id: 'con_1',
  adapterKey: 'krs',
  displayName: 'KRS',
  companyId: null,
  status: 'ACTIVE',
  health: {
    state: 'DOWN',
    lastCheckAt: null,
    failingSince: '2026-11-03T02:00:00.000Z',
    errorClass: 'TRANSIENT',
    code: 'erp_timeout',
  },
  queue: { queued: 3, failed: 2, oldestQueuedAt: null, lagSeconds: 7200 },
  lastSyncAt: null,
  openMismatches: 1,
  reconcileUnreachable: 0,
  poller: {
    lastRunAt: null,
    ordersLastRunAt: '2026-11-03T04:30:00.000Z',
    ordersLastSuccessAt: null,
    paymentStatusLastRunAt: null,
  },
  errorRate7d: { calls: 40, failed: 4, rate: 0.1 },
  ...o,
});

vi.mock('./session', async (orig) => {
  const real = await orig<typeof import('./session')>();
  const handle = (method: string) => (path: string, opts?: Call['opts']) => {
    calls.push({ method, path, opts });
    if (path === '/v1/platform/auth/me') return ok({ role, name: 'ทีม', email: 's@i.th' });
    if (path === '/v1/platform/tenants') return ok([]);
    if (path === '/v1/platform/tenants/{id}') return ok(DETAIL);
    if (path === '/v1/platform/connectors/health')
      return ok({
        data: [
          {
            tenantId: 'ten_1',
            tenantName: 'ขนส่งดี',
            totals: {},
            connectors: [
              metric(),
              metric({
                id: 'con_2',
                health: { ...metric().health, state: 'OK', failingSince: null, code: null },
                queue: { queued: 0, failed: 0, oldestQueuedAt: null, lagSeconds: 0 },
                errorRate7d: { calls: 0, failed: 0, rate: 0 },
                openMismatches: 0,
              }),
            ],
          },
        ],
      });
    if (path === '/v1/platform/connectors/adapters') return ok({ data: [] });
    if (path === '/v1/platform/connectors') return ok({ data: [] });
    return ok({ id: 'usr_a', twoFactorEnabled: false });
  };
  return {
    ...real,
    consoleApi: { GET: handle('GET'), POST: handle('POST'), PUT: handle('PUT') },
    // useStaff ของจริงเรียก consoleApi ภายในโมดูลเดิม (ไม่ผ่าน mock) — ให้คืน role ของ test
    useStaff: () => ({ data: { id: 'stf_1', role, name: 'ทีม', email: 's@i.th' } }),
  };
});

const { TenantsPage } = await import('./Tenants');
const { ConnectorsPage } = await import('./Connectors');

function mount(path: string) {
  queryClient.clear();
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider lang="th">
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/console/tenants/:id" element={<TenantsPage />} />
            <Route path="/console/connectors" element={<ConnectorsPage />} />
            <Route path="/console/connectors/:id" element={<div>drawer</div>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Console: รีเซ็ต 2FA ผู้ใช้ลูกค้า (#81)', () => {
  beforeEach(() => {
    calls.length = 0;
    role = 'SUPER_ADMIN';
  });

  it('SUPER_ADMIN: ปุ่มเฉพาะผู้ใช้ที่เปิด 2FA → เหตุผล → POST reset-2fa (tenant + user)', async () => {
    mount('/console/tenants/ten_1');
    fireEvent.click(await screen.findByRole('tab', { name: 'ผู้ใช้' }));
    const btns = await screen.findAllByRole('button', { name: /รีเซ็ต 2FA/ });
    expect(btns).toHaveLength(1);
    expect(screen.getByText('ยังไม่เปิด 2FA')).toBeTruthy();
    fireEvent.click(btns[0]!);
    const dlg = await screen.findByRole('dialog', { name: /รีเซ็ต 2FA · สมชาย/ });
    fireEvent.change(within(dlg).getByLabelText('เหตุผล'), {
      target: { value: 'ลูกค้าโทรแจ้งทำโทรศัพท์หาย ticket 123' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'รีเซ็ต 2FA' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === '/v1/platform/tenants/{id}/users/{userId}/reset-2fa')?.opts,
      ).toMatchObject({
        params: { path: { id: 'ten_1', userId: 'usr_a' } },
        body: { reason: 'ลูกค้าโทรแจ้งทำโทรศัพท์หาย ticket 123' },
      }),
    );
    expect(await screen.findByText(/รีเซ็ต 2FA ของ สมชาย แล้ว/)).toBeTruthy();
  });

  it('SUPPORT / BILLING ไม่เห็นปุ่ม (docs/04 A6)', async () => {
    role = 'SUPPORT';
    mount('/console/tenants/ten_1');
    fireEvent.click(await screen.findByRole('tab', { name: 'ผู้ใช้' }));
    await screen.findByText('สมหญิง');
    expect(screen.queryByRole('button', { name: /รีเซ็ต 2FA/ })).toBeNull();
  });
});

describe('Console: แท็บสุขภาพการเชื่อมต่อ (#96)', () => {
  beforeEach(() => {
    calls.length = 0;
    role = 'SUPPORT';
  });

  it('ตารางต่อ connector: สถานะ/คิว/lag/ดึงล่าสุด/error rate/MISMATCH · ตัวนับแท็บ = ตัวที่ผิดพลาด', async () => {
    mount('/console/connectors');
    const tab = await screen.findByRole('tab', { name: /สุขภาพการเชื่อมต่อ/ });
    await waitFor(() => expect(tab.textContent).toContain('1'));
    fireEvent.click(tab);
    const tbl = await screen.findByRole('table', { name: 'สุขภาพการเชื่อมต่อ' });
    const rows = within(tbl).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const r1 = rows[1]!;
    expect(within(r1).getByText('ผิดพลาด')).toBeTruthy();
    expect(r1.textContent).toContain('erp_timeout');
    expect(r1.textContent).toContain('2 ชม.');
    expect(r1.textContent).toContain('10% (4/40 ครั้ง)');
    expect(within(rows[2]!).getByText('เชื่อมต่อ')).toBeTruthy();
    expect(rows[2]!.textContent).toContain('—');
  });
});
