import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/** ST9-T10 ส่งออกตามตัวกรอง: helper รอผลสั้น ๆ + หน้าลิงก์จากแจ้งเตือน /exports/{id} */
const status: { current: Record<string, unknown> } = { current: {} };
const ok = (data: unknown) => Promise.resolve({ data, response: { ok: true, status: 200 } });
const POST = vi.fn((_p: string, _o: unknown) =>
  Promise.resolve({ data: { id: 'job_1' }, response: { ok: true, status: 202 } }),
);
const GET = vi.fn((_p: string, _o?: unknown) => ok(status.current));
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: {
    GET: (p: string, o: unknown) => GET(p, o),
    POST: (p: string, o: unknown) => POST(p, o),
  },
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' } } }),
}));

const { exportList, ExportQueued, ExportFailed } = await import('./exportJob');
const { ExportPage } = await import('./ExportPage');
const { exportFailText } = await import('../master/download');

const ready = {
  id: 'job_1',
  status: 'succeeded',
  rows: 50000,
  fileName: 'orders-20261118-0930.csv',
  expiresAt: '2026-11-25T02:30:00.000Z',
  downloadUrl: 'http://x/v1/documents/doc_1/content?sig=a',
  error: null,
};
let clicks: string[] = [];
beforeEach(() => {
  clicks = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this.href);
  });
  POST.mockClear();
  GET.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('exportList', () => {
  it('ส่งตัวกรอง (ตัดค่าว่าง) → เสร็จเร็ว = ดาวน์โหลดทันที คืนจำนวนแถว', async () => {
    vi.useFakeTimers();
    status.current = ready;
    const p = exportList('orders', { held: 'true', q: '', status: 'on_hold' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(50000);
    expect(POST).toHaveBeenCalledWith('/v1/exports', {
      body: { resource: 'orders', format: 'csv', filter: { held: 'true', status: 'on_hold' } },
    });
    expect(clicks).toEqual([ready.downloadUrl]);
  });

  it('ยังไม่เสร็จใน 8 วินาที → ExportQueued (รอแจ้งเตือน) · ล้มเกินเพดาน → ExportFailed', async () => {
    vi.useFakeTimers();
    status.current = { id: 'job_1', status: 'running', error: null };
    const p = exportList('customers', {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(9000);
    const e = await p;
    expect(e).toBeInstanceOf(ExportQueued);
    const t = (k: string) => k;
    expect(exportFailText(t as never, e, 'fail')).toBe('export.queued');

    status.current = { id: 'job_1', status: 'failed', error: { code: 'too_many_rows' } };
    const p2 = exportList('customers', {}).catch((x) => x);
    await vi.advanceTimersByTimeAsync(1000);
    const e2 = await p2;
    expect(e2).toBeInstanceOf(ExportFailed);
    expect(exportFailText(t as never, e2, 'fail')).toBe('export.tooMany');
    expect(exportFailText(t as never, new Error('x'), 'fail')).toBe('fail');
    expect(clicks).toEqual([]);
  });
});

function page() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider>
        <MemoryRouter initialEntries={['/exports/job_1']}>
          <Routes>
            <Route path="/exports/:id" element={<ExportPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('ExportPage (/exports/:id)', () => {
  it('ไฟล์พร้อม: แสดงชื่อไฟล์/จำนวน/วันหมดอายุ และดาวน์โหลดอัตโนมัติครั้งเดียว', async () => {
    status.current = ready;
    page();
    expect(await screen.findByText('ไฟล์ส่งออกพร้อมแล้ว')).toBeTruthy();
    expect(
      screen.getByText(/orders-20261118-0930\.csv · 50,000 รายการ · ดาวน์โหลดได้ถึง/),
    ).toBeTruthy();
    await waitFor(() => expect(clicks).toEqual([ready.downloadUrl]));
    expect(screen.getByRole('button', { name: /ดาวน์โหลด/ })).toBeTruthy();
  });

  it('หมดอายุ / ล้มเกินเพดาน → ข้อความตามเหตุ ไม่ดาวน์โหลด', async () => {
    status.current = { ...ready, status: 'expired', downloadUrl: undefined };
    page();
    expect(await screen.findByText('ไฟล์ส่งออกหมดอายุแล้ว')).toBeTruthy();
    expect(clicks).toEqual([]);
  });

  it('ล้มเพราะเกินเพดาน → บอกให้กรองให้แคบลง', async () => {
    status.current = { id: 'job_1', status: 'failed', error: { code: 'too_many_rows' } };
    page();
    expect(await screen.findByText('ส่งออกไม่สำเร็จ')).toBeTruthy();
    expect(screen.getByText(/กรองให้แคบลง/)).toBeTruthy();
  });
});
