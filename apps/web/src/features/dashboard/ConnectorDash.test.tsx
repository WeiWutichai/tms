import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * ST9-T04 การ์ด "การเชื่อมต่อ {ระบบ}" (ต้นแบบ is.dash `dash.conn`) จาก `GET /v1/connectors/metrics`
 * · ไม่มีสิทธิ์อ่านการเชื่อมต่อ / แพ็กเกจไม่มี `conn` = ไม่เรียก API · health แดงเมื่อ DEGRADED/DOWN
 * · ส่งซ้ำ = `POST /connectors/{id}/queue/retry` (ต้อง `integrations:retry`/`settings:write`) · ไม่มีรายการล้มเหลว = กดแล้วไม่เรียก
 */
let scopes: string[] = [];
let features: string[] | undefined = ['conn'];
let metrics: Record<string, unknown>[] = [];
const calls: { method: string; path: string }[] = [];
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });

vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  return {
    ...real,
    api: {
      GET: (path: string) => {
        calls.push({ method: 'GET', path });
        if (path === '/v1/me')
          return ok({
            scopes,
            ...(features ? { features } : {}),
            user: { roles: ['x'] },
            tenant: { yearStyle: 'BE', name: 'x' },
          });
        if (path === '/v1/connectors/metrics') return ok({ data: metrics });
        return ok({ data: [] });
      },
      POST: (path: string) => {
        calls.push({ method: 'POST', path });
        return ok({ retried: 2, notRetryable: 1, remaining: 0 });
      },
    },
  };
});

const { ConnectorCard, useConnectorMetrics } = await import('./ConnectorDash');

const m = (o: Record<string, unknown> = {}) => ({
  id: 'con_1',
  adapterKey: 'krs',
  displayName: 'KRS',
  companyId: null,
  status: 'ACTIVE',
  health: { state: 'OK', lastCheckAt: null, failingSince: null, errorClass: null, code: null },
  queue: { queued: 3, failed: 1, oldestQueuedAt: null, lagSeconds: 0 },
  lastSyncAt: '2026-11-03T03:12:00.000Z',
  openMismatches: 0,
  reconcileUnreachable: 0,
  poller: {
    lastRunAt: null,
    ordersLastRunAt: null,
    ordersLastSuccessAt: null,
    paymentStatusLastRunAt: null,
  },
  errorRate7d: { calls: 0, failed: 0, rate: 0 },
  ...o,
});

function Harness() {
  const c = useConnectorMetrics();
  const [msg, setMsg] = useState('');
  return (
    <>
      <div data-testid="toast">{msg}</div>
      {c.data ? <ConnectorCard m={c.data} onDone={setMsg} /> : <div data-testid="ar">AR</div>}
    </>
  );
}
function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname}</div>;
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider lang="th">
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Harness />} />
            <Route path="/erp" element={<div>erp</div>} />
          </Routes>
          <Loc />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('ConnectorCard (ST9-T04)', () => {
  beforeEach(() => {
    calls.length = 0;
    scopes = ['integrations:read', 'integrations:retry'];
    features = ['conn'];
    metrics = [m()];
  });

  it('ไม่มีสิทธิ์อ่านการเชื่อมต่อ / แพ็กเกจไม่มี conn = ไม่เรียก API และคงการ์ดลูกหนี้', async () => {
    scopes = ['invoices:read'];
    const a = mount();
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/me')).toBe(true));
    expect(screen.getByTestId('ar')).toBeTruthy();
    a.unmount();
    scopes = ['integrations:read'];
    features = ['ops'];
    mount();
    await waitFor(() => expect(screen.getByTestId('ar')).toBeTruthy());
    expect(calls.some((c) => c.path === '/v1/connectors/metrics')).toBe(false);
  });

  it('ไม่มี connector = การ์ดลูกหนี้ · มี = หัว "การเชื่อมต่อ {ระบบ}" + คิวรอส่ง + ส่งไม่สำเร็จ + ซิงก์ล่าสุด ตามต้นแบบ', async () => {
    metrics = [];
    const a = mount();
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/connectors/metrics')).toBe(true));
    expect(screen.getByTestId('ar')).toBeTruthy();
    a.unmount();
    metrics = [
      m({ status: 'PAUSED', health: { ...m().health, state: 'PAUSED' } }),
      m({ id: 'con_2' }),
    ];
    mount();
    await screen.findByTestId('dash-conn');
    expect(screen.getByText('การเชื่อมต่อ KRS')).toBeTruthy();
    expect(screen.getByTestId('dash-conn-state').textContent).toBe('เชื่อมต่อ'); // ACTIVE ก่อน PAUSED
    expect(screen.getByTestId('dash-conn-queued').textContent).toBe('3');
    expect(screen.getByText('คิวรอส่ง (outbox)')).toBeTruthy();
    expect(screen.getByTestId('dash-conn-failed').textContent).toBe('1');
    expect(screen.getByTestId('dash-conn-failed').style.color).toBe('rgb(179, 50, 42)');
    expect(screen.getByText('ซิงก์ล่าสุด')).toBeTruthy();
    expect(screen.getByTestId('dash-conn-last').textContent).toMatch(/^3 พ\.ย\. 2569 \d\d:12$/);
  });

  it('health แดงเมื่อปลายทางล่ม (DEGRADED) / ERROR · หยุดชั่วคราว = เทา', async () => {
    metrics = [m({ health: { ...m().health, state: 'DEGRADED', errorClass: 'TRANSIENT' } })];
    const a = mount();
    const s = await screen.findByTestId('dash-conn-state');
    expect(s.textContent).toBe('ผิดพลาด');
    expect(s.style.color).toBe('rgb(179, 50, 42)');
    a.unmount();
    metrics = [m({ status: 'PAUSED', health: { ...m().health, state: 'PAUSED' } })];
    mount();
    expect((await screen.findByTestId('dash-conn-state')).textContent).toBe('หยุดชั่วคราว');
  });

  it('ส่งซ้ำ → POST queue/retry + แจ้งผล · ไม่มีรายการล้มเหลว = ไม่เรียก · ไม่มีสิทธิ์ = ไม่มีปุ่ม · ลิงก์ไปคิวเชื่อมระบบบัญชี', async () => {
    const a = mount();
    fireEvent.click(await screen.findByRole('button', { name: /ส่งซ้ำ/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'POST', path: '/v1/connectors/{id}/queue/retry' }),
    );
    await waitFor(() => expect(screen.getByTestId('toast').textContent).toContain('2 รายการ'));
    expect(screen.getByTestId('toast').textContent).toContain('1 รายการต้องทำในระบบบัญชีเอง');
    fireEvent.click(screen.getByRole('button', { name: /ดูคิวเชื่อมระบบบัญชี/ }));
    expect(screen.getByTestId('loc').textContent).toBe('/erp');
    a.unmount();

    calls.length = 0;
    metrics = [m({ queue: { queued: 0, failed: 0, oldestQueuedAt: null, lagSeconds: 0 } })];
    const b = mount();
    const btn = await screen.findByRole('button', { name: /ส่งซ้ำ/ });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(btn);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    b.unmount();

    scopes = ['settings:read'];
    mount();
    await screen.findByTestId('dash-conn');
    expect(screen.queryByRole('button', { name: /ส่งซ้ำ/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /ดูคิวเชื่อมระบบบัญชี/ })).toBeNull();
  });

  it('#96 ช่องเพิ่ม: คิวค้างนานสุด / ดึงข้อมูลล่าสุด / error rate 7 วัน / MISMATCH เปิดอยู่ / ผิดพลาดตั้งแต่', async () => {
    metrics = [
      m({
        health: {
          ...m().health,
          state: 'DOWN',
          failingSince: '2026-11-03T02:00:00.000Z',
          code: 'erp_timeout',
        },
        queue: { queued: 4, failed: 0, oldestQueuedAt: null, lagSeconds: 5400 },
        poller: {
          lastRunAt: null,
          ordersLastRunAt: '2026-11-03T01:00:00.000Z',
          ordersLastSuccessAt: null,
          paymentStatusLastRunAt: '2026-11-03T04:30:00.000Z',
        },
        errorRate7d: { calls: 200, failed: 5, rate: 0.025 },
        openMismatches: 2,
      }),
    ];
    const a = mount();
    expect((await screen.findByTestId('dash-conn-lag')).textContent).toBe('1 ชม.');
    expect(screen.getByTestId('dash-conn-poll').textContent).toMatch(/^3 พ\.ย\. 2569 \d\d:30$/);
    expect(screen.getByTestId('dash-conn-err').textContent).toBe('2.5% (5/200 ครั้ง)');
    expect(screen.getByTestId('dash-conn-err').style.color).toBe('rgb(179, 50, 42)');
    expect(screen.getByTestId('dash-conn-mm').textContent).toBe('2');
    expect(screen.getByTestId('dash-conn-failing').textContent).toContain('erp_timeout');
    a.unmount();
    metrics = [m({ queue: { queued: 0, failed: 0, oldestQueuedAt: null, lagSeconds: 0 } })];
    mount();
    expect((await screen.findByTestId('dash-conn-lag')).textContent).toBe('ไม่มีคิวค้าง');
    expect(screen.getByTestId('dash-conn-poll').textContent).toBe('—');
    expect(screen.getByTestId('dash-conn-err').textContent).toBe('—');
    expect(screen.queryByTestId('dash-conn-failing')).toBeNull();
  });
});
