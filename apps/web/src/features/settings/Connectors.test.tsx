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
  companyId: null,
  status,
  activatedAt: null,
  capabilitiesSupported: ['pushInvoice'],
  capabilitiesEnabled: ['pushInvoice'],
  credentialKeys: ['apiKey'],
  credentialsUpdatedAt: null,
  syncFromDate: null,
  lastHealthError: null,
  inbound: { supported: false, tokenPrefix: null, tokenRotatedAt: null },
  systemOfRecord: {
    customerOwner: 'ERP',
    taxDocumentOwner: 'ERP',
    fieldSync: {
      PRICE: 'AUTO_SYNC',
      DATES: 'AUTO_SYNC',
      ACCESSORIAL: 'AUTO_SYNC',
      CUSTOMER: 'REGENERATE',
    },
    editableUntilPaid: true,
  },
  version: 1,
});
const ADAPTER = {
  key: 'demo',
  displayName: 'Demo ERP (simulated)',
  demo: true,
  capabilities: ['pushInvoice'],
  configFields: [{ key: 'apiKey', secret: true, required: true, kind: 'string', options: null }],
};
const rows = () => [
  {
    serviceItem: {
      id: 'svc_1',
      code: 'FREIGHT',
      nameTh: 'ค่าขนส่ง',
      vatType: 'EXEMPT_TRANSPORT',
      side: 'SELL',
      status: 'ACTIVE',
    },
    itemCode: 'SV-FRT-01',
    itemName: 'ค่าขนส่ง',
    status: 'MAPPED',
    updatedAt: null,
    version: 3,
  },
  {
    serviceItem: {
      id: 'svc_2',
      code: 'WAIT',
      nameTh: 'ค่ารอคิว',
      vatType: 'VAT_7',
      side: 'BOTH',
      status: 'ACTIVE',
    },
    itemCode: null,
    itemName: null,
    status: 'UNMAPPED',
    updatedAt: null,
    version: 0,
  },
  {
    serviceItem: {
      id: 'svc_3',
      code: 'OVN',
      nameTh: 'ค่าค้างคืน',
      vatType: 'VAT_7',
      side: 'BUY',
      status: 'INACTIVE',
    },
    itemCode: 'OLD-1',
    itemName: null,
    status: 'CODE_UNKNOWN',
    updatedAt: null,
    version: 1,
  },
];

let connectors: unknown[] = [connector()];
let fail: Record<string, { code: string; status: number }> = {};
const GET = vi.fn();
const PUT = vi.fn();
class MockApiError extends Error {
  constructor(public problem: { code: string; errors?: { code: string }[] }) {
    super(problem.code);
  }
}
vi.mock('../../api', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    PUT: (...a: unknown[]) => PUT(...a),
    POST: vi.fn(),
    PATCH: vi.fn(),
  },
  unwrap: async (p: Promise<{ data?: unknown; error?: { code: string } }>) => {
    const r = await p;
    if (r.error) throw new MockApiError(r.error);
    return r.data;
  },
  ApiError: MockApiError,
}));

// ST7-T20: ตาราง mapping อยู่ในกล่อง "ตั้งค่า {ระบบ}" ของหน้า การเชื่อมต่อ
const { ConnectorSettingsSection } = await import('./ConnectorSettings');

const wrap = (canWrite = true, url = '/settings?sec=conn') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <I18nProvider lang="th">
          <ConnectorSettingsSection canWrite={canWrite} />
        </I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );

describe('ตั้งค่า → การเชื่อมต่อ: จับคู่ค่าบริการ ↔ รหัสสินค้า ERP (ST7-T18)', () => {
  beforeEach(() => {
    connectors = [connector()];
    fail = {};
    GET.mockReset().mockImplementation(async (path: string) => {
      if (fail[path]) return { error: fail[path] };
      if (path === '/v1/connectors') return { data: { data: connectors } };
      if (path === '/v1/connectors/adapters') return { data: { data: [ADAPTER] } };
      if (path === '/v1/connectors/{id}/commands') return { data: { data: [] } };
      if (path === '/v1/api-keys' || path === '/v1/webhooks') return { data: { data: [] } };
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
      await screen.findByLabelText('รหัสสินค้าใน ERP จำลอง (Demo) ค่ารอคิว'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ระบบบัญชี (ERP)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ตั้งค่า ERP จำลอง (Demo)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'การจับคู่และเลขเอกสาร' })).toBeInTheDocument();
    expect(screen.getByText('ประเภทค่าใช้จ่ายใน TMS')).toBeInTheDocument();
    expect(screen.getByText('ยกเว้น VAT')).toBeInTheDocument();
    expect(screen.queryByText('ยังไม่ได้เชื่อมต่อ · ตั้งค่าล่วงหน้าได้')).toBeNull();
    const ovn = screen.getByLabelText('รหัสสินค้าใน ERP จำลอง (Demo) ค่าค้างคืน (ปิดใช้)');
    expect(ovn).toHaveValue('OLD-1');
    expect(ovn).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('รหัสสินค้าใน ERP จำลอง (Demo) ค่ารอคิว')).toHaveValue('');
  });

  it('กรอกรหัสแล้วออกจากช่อง → PUT · ล้างค่า → itemCode null · รหัสไม่รู้จัก → ข้อความผิดพลาด', async () => {
    wrap();
    const wait = await screen.findByLabelText('รหัสสินค้าใน ERP จำลอง (Demo) ค่ารอคิว');
    fireEvent.change(wait, { target: { value: ' SV-WAIT ' } });
    fireEvent.blur(wait);
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    expect(PUT.mock.calls[0]![1]).toMatchObject({
      params: { path: { id: CON, serviceItemId: 'svc_2' }, header: { 'If-Match': '"0"' } },
      body: { itemCode: 'SV-WAIT' },
    });

    const frt = screen.getByLabelText('รหัสสินค้าใน ERP จำลอง (Demo) ค่าขนส่ง');
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
      expect(frt).toHaveAttribute('title', 'ไม่พบรหัสนี้ในผังรหัสสินค้าของ ERP จำลอง (Demo)'),
    );
  });

  it('ไม่มีสิทธิ์แก้ = ช่องปิด · connector ยังไม่เปิดใช้ = ป้าย "ยังไม่ได้เชื่อมต่อ"', async () => {
    connectors = [connector('PAUSED')];
    wrap(false);
    expect(await screen.findByText('ยังไม่ได้เชื่อมต่อ · ตั้งค่าล่วงหน้าได้')).toBeInTheDocument();
    expect(await screen.findByLabelText('รหัสสินค้าใน ERP จำลอง (Demo) ค่าขนส่ง')).toBeDisabled();
  });

  it('ไม่มี connector (Standalone) = การ์ด "ไม่เชื่อม" ใช้งานอยู่ · ไม่มีตาราง mapping (ST7-T20)', async () => {
    connectors = [];
    wrap();
    expect(await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' })).toBeInTheDocument();
    expect(screen.queryByText('ประเภทค่าใช้จ่ายใน TMS')).toBeNull();
  });

  it('โหลด connector ล้ม (500) = แจ้ง + ลองอีกครั้ง ไม่ใช่ "ยังไม่เปิดใช้" · แพ็กเกจไม่มี (403) = ยังไม่เปิดใช้', async () => {
    fail['/v1/connectors'] = { code: 'internal_error', status: 500 };
    const v = wrap();
    expect(await screen.findByText('โหลดการเชื่อมต่อไม่สำเร็จ')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'ไม่เชื่อม' })).toBeNull();
    delete fail['/v1/connectors'];
    fireEvent.click(screen.getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(
      await screen.findByLabelText('รหัสสินค้าใน ERP จำลอง (Demo) ค่ารอคิว'),
    ).toBeInTheDocument();
    v.unmount();
    fail['/v1/connectors'] = { code: 'feature_not_in_plan', status: 403 };
    wrap();
    expect(
      await screen.findByText(
        'แพ็กเกจปัจจุบันยังไม่มีการเชื่อมต่อระบบบัญชี · ส่งออกไฟล์ให้นักบัญชีได้',
      ),
    ).toBeInTheDocument();
  });

  it('โหลดรายการจับคู่ล้ม = แจ้ง + ลองอีกครั้ง · ลิงก์ไป connector ที่ยกเลิกแล้ว = ข้อความเฉพาะ', async () => {
    fail['/v1/connectors/{id}/mappings'] = { code: 'internal_error', status: 500 };
    const v = wrap();
    expect(await screen.findByText('โหลดรายการจับคู่ไม่สำเร็จ')).toBeInTheDocument();
    v.unmount();
    wrap(true, '/settings?sec=conn&connector=con_gone');
    expect(await screen.findByText('ไม่พบระบบบัญชีที่เชื่อมไว้')).toBeInTheDocument();
  });

  it('มีผู้อื่นแก้ก่อน (412) → โหลดรายการใหม่ + แจ้ง', async () => {
    wrap();
    const wait = await screen.findByLabelText('รหัสสินค้าใน ERP จำลอง (Demo) ค่ารอคิว');
    PUT.mockResolvedValueOnce({ error: { code: 'precondition_failed', status: 412 } });
    const before = GET.mock.calls.filter((c) => c[0] === '/v1/connectors/{id}/mappings').length;
    fireEvent.change(wait, { target: { value: 'SV-WAIT' } });
    fireEvent.blur(wait);
    await waitFor(() =>
      expect(
        GET.mock.calls.filter((c) => c[0] === '/v1/connectors/{id}/mappings').length,
      ).toBeGreaterThan(before),
    );
  });
});
