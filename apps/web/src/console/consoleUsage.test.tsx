import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api';
import { I18nProvider } from '../i18n';

/**
 * P1-ST1-T06 แท็บ "การใช้งาน" ของลูกค้าใน Console — แถบรถ active + ทะเบียนที่ถูกนับ
 * หลังปิดยอดปรับได้เฉพาะ SUPER_ADMIN / BILLING พร้อมเหตุผล (spec/01 PLT-074)
 */
type Call = { method: string; path: string; opts?: { params?: unknown; body?: unknown } };
const calls: Call[] = [];
let role = 'BILLING';
let status: 'open' | 'finalized' = 'finalized';
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });

const DETAIL = {
  id: 'ten_1',
  name: 'ขนส่งดี',
  status: 'active',
  planCode: 'std',
  vehicleQuota: 10,
  users: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  members: [],
};
const usage = (o: Record<string, unknown> = {}) => ({
  period: '2026-11',
  status,
  finalizedAt: status === 'open' ? null : '2026-11-30T19:00:00.000Z',
  activeVehicles: 2,
  own: 1,
  subcontract: 1,
  limit: 10,
  data: [
    {
      id: 'avu_1',
      plate: '70-1001',
      plateMissing: false,
      subcontract: false,
      vehicleType: 'หกล้อ',
      carrierName: null,
      trips: 10,
      firstTripId: 'trp_1',
      firstTripNo: 'TRP-2611-0001',
      firstCountedAt: '2026-11-01T01:00:00.000Z',
      adjusted: false,
      excluded: false,
    },
    {
      id: 'avu_2',
      plate: '80-2002',
      plateMissing: false,
      subcontract: true,
      vehicleType: 'สิบล้อ',
      carrierName: 'รถร่วมดี',
      trips: 1,
      firstTripId: 'trp_2',
      firstTripNo: 'TRP-2611-0002',
      firstCountedAt: '2026-11-03T01:00:00.000Z',
      adjusted: false,
      excluded: false,
    },
  ],
  ...o,
});

vi.mock('./session', async (orig) => {
  const real = await orig<typeof import('./session')>();
  const handle = (method: string) => (path: string, opts?: Call['opts']) => {
    calls.push({ method, path, opts });
    if (path === '/v1/platform/tenants') return ok([]);
    if (path === '/v1/platform/tenants/{id}') return ok(DETAIL);
    if (path === '/v1/platform/tenants/{id}/usage/active-vehicles' && method === 'GET')
      return ok(usage());
    return ok(usage({ activeVehicles: 1 }));
  };
  return {
    ...real,
    consoleApi: { GET: handle('GET'), POST: handle('POST'), PUT: handle('PUT') },
    useStaff: () => ({ data: { id: 'stf_1', role, name: 'ทีม', email: 's@i.th' } }),
  };
});

const { TenantsPage } = await import('./Tenants');

function mount() {
  queryClient.clear();
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider lang="th">
        <MemoryRouter initialEntries={['/console/tenants/ten_1']}>
          <Routes>
            <Route path="/console/tenants/:id" element={<TenantsPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Console: แท็บการใช้งาน — รถ active (P1-ST1-T06)', () => {
  beforeEach(() => {
    calls.length = 0;
    role = 'BILLING';
    status = 'finalized';
  });

  it('แถบ "รถ active u / q คัน" + ทะเบียนที่ถูกนับ + เที่ยวแรก · การเงินตัดออกพร้อมเหตุผล', async () => {
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'การใช้งาน' }));
    const bar = await screen.findByTestId('use-bar');
    expect(bar.textContent).toContain('รถ active');
    expect(bar.textContent).toContain('2 / 10 คัน');
    expect(bar.textContent).toContain('ปิดยอดแล้ว');
    const rows = screen.getByTestId('use-rows');
    expect(rows.textContent).toContain('70-1001 · หกล้อ');
    expect(rows.textContent).toContain('เที่ยวแรก TRP-2611-0001');
    expect(rows.textContent).toContain('10 เที่ยว');
    expect(rows.textContent).toContain('รถร่วม · รถร่วมดี');
    expect(calls.find((c) => c.path.endsWith('/usage/active-vehicles'))?.opts).toMatchObject({
      params: { path: { id: 'ten_1' } },
    });

    fireEvent.click(within(rows).getAllByRole('button', { name: /ตัดออก/ })[0]!);
    const dlg = await screen.findByRole('dialog', { name: /ตัดทะเบียน 70-1001 ออกจากการนับ/ });
    fireEvent.change(within(dlg).getByLabelText('เหตุผล'), {
      target: { value: 'ลูกค้าแจ้งว่าเป็นรถทดสอบ ไม่ได้วิ่งจริง' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'ตัดออก' }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.path === '/v1/platform/tenants/{id}/usage/active-vehicles/{rowId}/exclude',
        )?.opts,
      ).toMatchObject({
        params: { path: { id: 'ten_1', rowId: 'avu_1' } },
        body: { reason: 'ลูกค้าแจ้งว่าเป็นรถทดสอบ ไม่ได้วิ่งจริง' },
      }),
    );
    expect(await screen.findByText(/ปรับยอดรถ active ของ ขนส่งดี แล้ว/)).toBeTruthy();
    expect(screen.getByTestId('use-bar').textContent).toContain('1 / 10 คัน');
  });

  it('เดือนที่ยังไม่ปิดยอด / SUPPORT → ไม่มีปุ่มปรับ', async () => {
    status = 'open';
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'การใช้งาน' }));
    expect((await screen.findByTestId('use-bar')).textContent).toContain('ยังไม่ปิดยอด');
    expect(screen.queryByRole('button', { name: /ตัดออก|เพิ่มทะเบียน/ })).toBeNull();

    cleanup();
    status = 'finalized';
    role = 'SUPPORT';
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'การใช้งาน' }));
    await screen.findByTestId('use-rows');
    expect(screen.queryByRole('button', { name: /ตัดออก|เพิ่มทะเบียน/ })).toBeNull();
  });
});
