import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const ADAPTER = {
  key: 'demo',
  displayName: 'Demo ERP (simulated)',
  demo: true,
  capabilities: ['pullOrders', 'pushInvoice'],
  configFields: [
    { key: 'apiKey', secret: true, required: true, kind: 'string', maxLength: 200, options: null },
    {
      key: 'failMode',
      secret: false,
      required: false,
      kind: 'string',
      maxLength: null,
      options: ['none', 'AUTH'],
    },
  ],
};
const conn = (status: string) => ({
  id: 'con_1',
  adapterKey: 'demo',
  displayName: 'Demo ERP (simulated)',
  companyId: null,
  status,
  statusReason: null,
  capabilitiesSupported: ['pullOrders', 'pushInvoice'],
  capabilitiesEnabled: ['pullOrders', 'pushInvoice'],
  credentialKeys: ['apiKey'],
  credentialsUpdatedAt: '2026-11-19T03:00:00Z',
  syncFromDate: null,
  lastHealthError: null,
  inbound: { supported: true, tokenPrefix: null, tokenRotatedAt: null },
  version: 3,
});
let conns: unknown[] = [];
const GET = vi.fn();
const POST = vi.fn();
vi.mock('../../api', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    POST: (...a: unknown[]) => POST(...a),
    PATCH: vi.fn(),
    PUT: vi.fn(),
  },
  unwrap: async (p: Promise<{ data: unknown }>) => (await p).data,
  ApiError: class ApiError extends Error {
    constructor(public problem: { code: string; status?: number }) {
      super(problem.code);
    }
  },
}));

const { ConnectorSettingsSection } = await import('./ConnectorSettings');

const wrap = (canWrite = true) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <I18nProvider lang="th">
          <ConnectorSettingsSection canWrite={canWrite} />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('ตั้งค่า → การเชื่อมต่อ (ST7-T20)', () => {
  beforeEach(() => {
    conns = [];
    GET.mockReset().mockImplementation(async (path: string) => {
      if (path === '/v1/connectors') return { data: { data: conns } };
      if (path === '/v1/connectors/adapters') return { data: { data: [ADAPTER] } };
      return { data: { data: [] } };
    });
    POST.mockReset().mockImplementation(async (path: string) => {
      if (path === '/v1/connectors') return { data: conn('PAUSED') };
      if (path.endsWith('/health'))
        return { data: { ok: true, code: null, connector: conn('ACTIVE') } };
      return { data: conn('ACTIVE') };
    });
  });

  it('ไม่มี connector: การ์ด "ไม่เชื่อม" ใช้งานอยู่ · การ์ดเรียงตามตัวอักษร · ไม่มีกล่องตั้งค่า', async () => {
    wrap();
    await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    const cards = screen.getAllByTestId('connector-card');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'ไม่เชื่อม',
      'API ทั่วไป',
      'ERP จำลอง (Demo)',
    ]);
    expect(within(cards[0]!).getAllByText('ใช้งานอยู่').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('connector-detail')).toBeNull();
  });

  it('เชื่อมต่อ: กรอก apiKey (ช่องรหัสผ่าน) → สร้างแล้วเปิดใช้', async () => {
    wrap();
    const card = await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    fireEvent.click(within(card).getByRole('button', { name: 'เชื่อมต่อ' }));
    const key = await screen.findByLabelText(/apiKey/);
    expect(key).toHaveAttribute('type', 'password');
    fireEvent.change(key, { target: { value: 'k-0001' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'เชื่อมต่อ' }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith(
        '/v1/connectors',
        expect.objectContaining({
          body: { adapterKey: 'demo', credentials: { apiKey: 'k-0001' }, settings: {} },
        }),
      ),
    );
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith('/v1/connectors/{id}/resume', expect.anything()),
    );
  });

  it('เชื่อมแล้ว: ป้าย "เชื่อมต่อ" · credential แสดงแค่จุด · กดทดสอบได้', async () => {
    conns = [conn('ACTIVE')];
    wrap();
    const card = await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    expect(within(card).getByText('เชื่อมต่อ')).toBeInTheDocument();
    const detail = await screen.findByTestId('connector-detail');
    expect(within(detail).getByText('ตั้งค่า ERP จำลอง (Demo)')).toBeInTheDocument();
    const row = within(detail).getAllByTestId('credential-row')[0]!;
    expect(row.textContent).toContain('••••••••');
    fireEvent.click(within(card).getByRole('button', { name: 'ทดสอบ' }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith('/v1/connectors/{id}/health', expect.anything()),
    );
    expect(
      await screen.findByText(/ทดสอบการเชื่อมต่อ ERP จำลอง \(Demo\) สำเร็จ/),
    ).toBeInTheDocument();
  });

  it('สิทธิ์อ่านอย่างเดียว: ไม่มีปุ่มเชื่อมต่อ/ทดสอบ', async () => {
    conns = [conn('ACTIVE')];
    wrap(false);
    const card = await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    expect(within(card).queryByRole('button', { name: 'ทดสอบ' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'ตัดการเชื่อมต่อ' })).toBeNull();
  });
});
