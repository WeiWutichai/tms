import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api';
import { I18nProvider } from '../i18n';

/** P1-ST4-T05 หน้า "การใช้งาน API" (`use`) ของ Platform Console */
type Call = { method: string; path: string; opts?: { params?: unknown; body?: unknown } };
const calls: Call[] = [];
let role = 'SUPPORT';
const ok = (data: unknown, status = 200) =>
  Promise.resolve({ data, response: new Response(null, { status }) });

const rl = { profile: 'standard', override: false, tenantPerMinute: 3000, keyPerMinute: 1200 };
const USAGE = {
  from: '2026-10-30',
  to: '2026-11-28',
  days: 30,
  totalRequests: 12480,
  rows: [
    {
      tenantId: 'ten_1',
      name: 'บริษัท หนึ่ง จำกัด',
      planCode: 'pro',
      planName: 'มืออาชีพ',
      status: 'active',
      apiInPlan: true,
      apiDisabled: false,
      apiDisabledAt: null,
      requests: 12480,
      errors4xx: 250,
      errors5xx: 150,
      throttled: 37,
      p95Ms: 300,
      p95Over: false,
      rateLimit: rl,
    },
    {
      tenantId: 'ten_2',
      name: 'บริษัท สอง จำกัด',
      planCode: 'pro',
      planName: 'มืออาชีพ',
      status: 'active',
      apiInPlan: true,
      apiDisabled: true,
      apiDisabledAt: '2026-11-27T03:00:00.000Z',
      requests: 0,
      errors4xx: 0,
      errors5xx: 0,
      throttled: 0,
      p95Ms: null,
      p95Over: false,
      rateLimit: { profile: 'high', override: true, tenantPerMinute: 6000, keyPerMinute: 2400 },
    },
    {
      tenantId: 'ten_3',
      name: 'บริษัท เริ่มต้น จำกัด',
      planCode: 'start',
      planName: 'เริ่มต้น',
      status: 'trial',
      apiInPlan: false,
      apiDisabled: false,
      apiDisabledAt: null,
      requests: 0,
      errors4xx: 0,
      errors5xx: 0,
      throttled: 0,
      p95Ms: null,
      p95Over: false,
      rateLimit: rl,
    },
  ],
};

vi.mock('./session', async (orig) => {
  const real = await orig<typeof import('./session')>();
  const handle = (method: string) => (path: string, opts?: Call['opts']) => {
    calls.push({ method, path, opts });
    if (path === '/v1/platform/api-usage') return ok(USAGE);
    if (path.endsWith('/api/disable'))
      return ok({ tenantId: 'ten_1', apiDisabled: true, apiDisabledAt: '2026-11-28T03:00:00Z' });
    if (path.endsWith('/api/enable'))
      return ok({ tenantId: 'ten_2', apiDisabled: false, apiDisabledAt: null });
    return ok({});
  };
  return {
    ...real,
    consoleApi: { GET: handle('GET'), POST: handle('POST') },
    useStaff: () => ({ data: { id: 'x', role, name: 'มาลี ใจดี', email: 'm@i.th' } }),
  };
});

const { ApiUsagePage } = await import('./ApiUsage');

function mount() {
  queryClient.clear();
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider lang="th">
        <MemoryRouter initialEntries={['/console/api-usage']}>
          <Routes>
            <Route path="/console/api-usage" element={<ApiUsagePage />} />
            <Route path="/console/tenants/:id" element={<div>drawer ลูกค้า</div>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Console: การใช้งาน API', () => {
  beforeEach(() => {
    calls.length = 0;
    role = 'SUPPORT';
  });

  it('ตาราง: คอลัมน์ตาม spec/01 §10.7 ไม่มี AI/MCP · ตัวเลข · ไม่มีในแพ็กเกจ', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'การใช้งาน API' })).toBeTruthy();
    expect(await screen.findByText(/ทุก tenant 30 วันล่าสุด · REST 12,480 ครั้ง/)).toBeTruthy();
    const head = within(screen.getByRole('table')).getAllByRole('row')[0]!;
    expect(head.textContent).toBe(
      'บริษัทแพ็กเกจRESTError 5xxError 4xxp95 latency429 ถูกตัดRate limitAPI',
    );
    expect(head.textContent).not.toMatch(/AI|MCP/);
    const r1 = (await screen.findByText('บริษัท หนึ่ง จำกัด')).closest('tr')!;
    expect(r1.textContent).toContain('12,480');
    expect(r1.textContent).toContain('1.2%'); // 150 / 12480
    expect(r1.textContent).toContain('150 ครั้ง');
    expect(r1.textContent).toContain('2%'); // 250 / 12480
    expect(r1.textContent).toContain('300 ms');
    expect(r1.textContent).toContain('37');
    expect(r1.textContent).toContain('3,000 / นาที');
    expect(r1.textContent).toContain('ต่อ key 1,200 / นาที');
    expect(within(r1).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    const r2 = screen.getByText('บริษัท สอง จำกัด').closest('tr')!;
    expect(r2.textContent).toContain('6,000 / นาที');
    expect(r2.textContent).toContain('ปรับเฉพาะลูกค้า');
    expect(within(r2).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    const r3 = screen.getByText('บริษัท เริ่มต้น จำกัด').closest('tr')!;
    expect(r3.textContent).toContain('ไม่มีในแพ็กเกจ');
    expect(within(r3).queryByRole('switch')).toBeNull();
  });

  it('ปิด API: dialog + เหตุผล ≥ 10 ตัว → POST disable · toast', async () => {
    mount();
    const r1 = (await screen.findByText('บริษัท หนึ่ง จำกัด')).closest('tr')!;
    fireEvent.click(within(r1).getByRole('switch'));
    const dlg = await screen.findByRole('dialog', {
      name: 'ปิด Open API (REST) · บริษัท หนึ่ง จำกัด',
    });
    expect(dlg.textContent).toContain('ปิดแล้ว API key ทุกตัวได้รับ 403');
    const okBtn = within(dlg).getByRole('button', {
      name: 'ปิด Open API (REST)',
    }) as HTMLButtonElement;
    fireEvent.change(within(dlg).getByLabelText('เหตุผล'), { target: { value: 'สั้น' } });
    expect(okBtn.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText('เหตุผล'), {
      target: { value: 'ลูกค้ายิง API ผิดปกติจนกระทบระบบ' },
    });
    fireEvent.click(okBtn);
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/api/disable'))?.opts).toMatchObject({
        params: { path: { id: 'ten_1' } },
        body: { reason: 'ลูกค้ายิง API ผิดปกติจนกระทบระบบ' },
      }),
    );
    expect(
      await screen.findByText(/ปิด Open API \(REST\) ของ บริษัท หนึ่ง จำกัด แล้ว/),
    ).toBeTruthy();
  });

  it('เปิดกลับ: สวิตช์ที่ปิดอยู่ → POST enable', async () => {
    mount();
    const r2 = (await screen.findByText('บริษัท สอง จำกัด')).closest('tr')!;
    fireEvent.click(within(r2).getByRole('switch'));
    const dlg = await screen.findByRole('dialog', {
      name: 'เปิด Open API (REST) · บริษัท สอง จำกัด',
    });
    fireEvent.change(within(dlg).getByLabelText('เหตุผล'), {
      target: { value: 'ลูกค้าแก้ระบบที่เชื่อมแล้ว' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'เปิด Open API (REST)' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/api/enable'))?.opts).toMatchObject({
        params: { path: { id: 'ten_2' } },
      }),
    );
  });

  it('BILLING: สวิตช์จาง กดแล้วแจ้ง "เฉพาะ owner / support" ไม่เปิด dialog · คลิกแถว → ลูกค้า', async () => {
    role = 'BILLING';
    mount();
    const r1 = (await screen.findByText('บริษัท หนึ่ง จำกัด')).closest('tr')!;
    const sw = within(r1).getByRole('switch') as HTMLButtonElement;
    expect(sw.style.opacity).toBe('0.5');
    fireEvent.click(sw);
    expect(await screen.findByText('เฉพาะ owner / support')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(r1);
    expect(await screen.findByText('drawer ลูกค้า')).toBeTruthy();
  });
});
