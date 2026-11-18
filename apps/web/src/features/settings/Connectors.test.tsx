import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const CON = 'con_0000000000000000000000000000000a';
const connector = (status = 'ACTIVE') => ({
  id: CON,
  adapterKey: 'demo',
  displayName: 'Demo ERP (simulated)',
  status,
});
const rows = () => [
  {
    serviceItem: { id: 'svc_1', code: 'FREIGHT', nameTh: 'ค่าขนส่ง', vatType: 'EXEMPT_TRANSPORT' },
    itemCode: 'SV-FRT-01',
    itemName: 'ค่าขนส่ง',
    status: 'MAPPED',
    updatedAt: null,
  },
  {
    serviceItem: { id: 'svc_2', code: 'WAIT', nameTh: 'ค่ารอคิว', vatType: 'VAT_7' },
    itemCode: null,
    itemName: null,
    status: 'UNMAPPED',
    updatedAt: null,
  },
  {
    serviceItem: { id: 'svc_3', code: 'OVN', nameTh: 'ค่าค้างคืน', vatType: 'VAT_7' },
    itemCode: 'OLD-1',
    itemName: null,
    status: 'CODE_UNKNOWN',
    updatedAt: null,
  },
];

let connectors: unknown[] = [connector()];
const GET = vi.fn();
const PUT = vi.fn();
class MockApiError extends Error {
  constructor(public problem: { code: string; errors?: { code: string }[] }) {
    super(problem.code);
  }
}
vi.mock('../../api', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), PUT: (...a: unknown[]) => PUT(...a) },
  unwrap: async (p: Promise<{ data?: unknown; error?: { code: string } }>) => {
    const r = await p;
    if (r.error) throw new MockApiError(r.error);
    return r.data;
  },
  ApiError: MockApiError,
}));

const { ConnectorsSection } = await import('./Connectors');

const wrap = (canWrite = true, url = '/settings?sec=conn') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <I18nProvider lang="th">
          <ConnectorsSection canWrite={canWrite} />
        </I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );

describe('ตั้งค่า → การเชื่อมต่อ: จับคู่ค่าบริการ ↔ รหัสสินค้า ERP (ST7-T18)', () => {
  beforeEach(() => {
    connectors = [connector()];
    GET.mockReset().mockImplementation(async (path: string) => {
      if (path === '/v1/connectors') return { data: { data: connectors } };
      if (path === '/v1/connectors/{id}/mappings')
        return {
          data: { data: rows(), summary: { total: 3, mapped: 1, missing: 2, itemCodes: 6 } },
        };
      if (path === '/v1/connectors/{id}/master-codes')
        return { data: { data: [{ kind: 'ITEM', code: 'SV-WAIT', name: 'ค่ารอคิว' }] } };
      throw new Error(path);
    });
    PUT.mockReset().mockResolvedValue({ data: {} });
  });

  it('หัวข้อ + การ์ด "ตั้งค่า {ระบบ}" + ตาราง 3 คอลัมน์ตามต้นแบบ · รหัสที่ไม่อยู่ในผังขึ้นกรอบแดง', async () => {
    wrap();
    expect(
      await screen.findByLabelText('รหัสสินค้าใน Demo ERP (simulated) ค่ารอคิว'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ระบบบัญชี (ERP)' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'ตั้งค่า Demo ERP (simulated)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'การจับคู่และเลขเอกสาร' })).toBeInTheDocument();
    expect(screen.getByText('ประเภทค่าใช้จ่ายใน TMS')).toBeInTheDocument();
    expect(screen.getByText('ยกเว้น VAT')).toBeInTheDocument();
    expect(screen.queryByText('ยังไม่ได้เชื่อมต่อ · ตั้งค่าล่วงหน้าได้')).toBeNull();
    const ovn = screen.getByLabelText('รหัสสินค้าใน Demo ERP (simulated) ค่าค้างคืน');
    expect(ovn).toHaveValue('OLD-1');
    expect(ovn).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('รหัสสินค้าใน Demo ERP (simulated) ค่ารอคิว')).toHaveValue('');
  });

  it('กรอกรหัสแล้วออกจากช่อง → PUT · ล้างค่า → itemCode null · รหัสไม่รู้จัก → ข้อความผิดพลาด', async () => {
    wrap();
    const wait = await screen.findByLabelText('รหัสสินค้าใน Demo ERP (simulated) ค่ารอคิว');
    fireEvent.change(wait, { target: { value: ' SV-WAIT ' } });
    fireEvent.blur(wait);
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    expect(PUT.mock.calls[0]![1]).toMatchObject({
      params: { path: { id: CON, serviceItemId: 'svc_2' } },
      body: { itemCode: 'SV-WAIT' },
    });

    const frt = screen.getByLabelText('รหัสสินค้าใน Demo ERP (simulated) ค่าขนส่ง');
    fireEvent.change(frt, { target: { value: '' } });
    fireEvent.blur(frt);
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(2));
    expect(PUT.mock.calls[1]![1]).toMatchObject({ body: { itemCode: null } });

    PUT.mockResolvedValueOnce({
      error: { code: 'validation_failed', errors: [{ code: 'erp_code_unknown' }] },
    });
    fireEvent.change(frt, { target: { value: 'NOPE' } });
    fireEvent.blur(frt);
    await waitFor(() =>
      expect(frt).toHaveAttribute('title', 'ไม่พบรหัสนี้ในผังรหัสสินค้าของ Demo ERP (simulated)'),
    );
  });

  it('ไม่มีสิทธิ์แก้ = ช่องปิด · connector ยังไม่เปิดใช้ = ป้าย "ยังไม่ได้เชื่อมต่อ"', async () => {
    connectors = [connector('PAUSED')];
    wrap(false);
    expect(await screen.findByText('ยังไม่ได้เชื่อมต่อ · ตั้งค่าล่วงหน้าได้')).toBeInTheDocument();
    expect(
      await screen.findByLabelText('รหัสสินค้าใน Demo ERP (simulated) ค่าขนส่ง'),
    ).toBeDisabled();
  });

  it('ไม่มี connector (Standalone) = "ยังไม่เปิดใช้" ตามเดิม', async () => {
    connectors = [];
    wrap();
    expect(await screen.findByText('หน้านี้ยังไม่เปิดใช้')).toBeInTheDocument();
  });
});
