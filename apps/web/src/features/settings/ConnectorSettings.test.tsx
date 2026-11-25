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
  systemOfRecord: {
    customerOwner: 'ERP',
    taxDocumentOwner: 'ERP',
    fieldSync: {
      PRICE: 'AUTO_SYNC',
      DATES: 'AUTO_SYNC',
      ACCESSORIAL: 'AUTO_SYNC',
      CUSTOMER: 'REGENERATE',
    },
  },
  version: 3,
});
let conns: unknown[] = [];
const GET = vi.fn();
const POST = vi.fn();
const PUT = vi.fn();
const PATCH = vi.fn();
vi.mock('../../api', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    POST: (...a: unknown[]) => POST(...a),
    PATCH: (...a: unknown[]) => PATCH(...a),
    PUT: (...a: unknown[]) => PUT(...a),
  },
  unwrap: async (p: Promise<{ data: unknown }>) => (await p).data,
  ApiError: class ApiError extends Error {
    constructor(public problem: { code: string; status?: number }) {
      super(problem.code);
    }
  },
}));

const { ConnectorSettingsSection, healthText, payloadJson } = await import('./ConnectorSettings');

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
    // D-54/D-56 + spec/12 §3: TMS ไม่ออกใบกำกับภาษี/ใบเสร็จ — การ์ด "ไม่เชื่อม" ตัดคำเหล่านั้นออกจากข้อความต้นแบบ
    expect(cards[0]!.textContent).toContain(
      'ใช้ TMS ออกเอกสารเอง ทั้งใบแจ้งหนี้ และส่งออกไฟล์ให้นักบัญชี',
    );
    expect(cards[0]!.textContent).not.toMatch(/ใบกำกับภาษี|ใบเสร็จ/);
    expect(screen.queryByTestId('connector-detail')).toBeNull();
  });

  it('เชื่อมต่อ: กรอก apiKey (ช่องรหัสผ่าน) → สร้างแล้วเปิดใช้', async () => {
    wrap();
    const card = await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    fireEvent.click(within(card).getByRole('button', { name: 'เชื่อมต่อ' }));
    const key = await screen.findByLabelText(/API key/);
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

  it('ST8-T03 KRS: ช่องค่าตั้งข้อความ (baseUrl บังคับ) อยู่ในฟอร์มเชื่อมต่อ · ส่งเป็น settings', async () => {
    const krs = {
      key: 'krs',
      displayName: 'KRS',
      demo: false,
      capabilities: ['pullOrders', 'pushInvoice', 'fetchDocument', 'replaceDocument'],
      configFields: [
        {
          key: 'baseUrl',
          secret: false,
          required: true,
          kind: 'url',
          maxLength: 300,
          options: null,
        },
        {
          key: 'apiKey',
          secret: true,
          required: true,
          kind: 'string',
          maxLength: 500,
          options: null,
        },
        {
          key: 'sqlUser',
          secret: false,
          required: false,
          kind: 'string',
          maxLength: 128,
          options: null,
        },
      ],
    };
    GET.mockImplementation(async (path: string) => {
      if (path === '/v1/connectors') return { data: { data: [] } };
      if (path === '/v1/connectors/adapters') return { data: { data: [ADAPTER, krs] } };
      return { data: { data: [] } };
    });
    wrap();
    const card = await screen.findByRole('group', { name: 'KRS' });
    fireEvent.click(within(card).getByRole('button', { name: 'เชื่อมต่อ' }));
    const dlg = await screen.findByRole('dialog');
    const url = within(dlg).getByLabelText(/URL ของ API/);
    expect(url).toHaveAttribute('type', 'url');
    expect(within(dlg).getByLabelText(/ผู้ใช้ SQL/)).toHaveAttribute('type', 'text');
    fireEvent.change(within(dlg).getByLabelText(/API key/), { target: { value: 'k-krs' } });
    const ok = within(dlg).getByRole('button', { name: 'เชื่อมต่อ' });
    expect(ok).toBeDisabled(); // baseUrl ยังว่าง
    fireEvent.change(url, { target: { value: ' https://krs.example/api ' } });
    expect(ok).toBeEnabled();
    fireEvent.click(ok);
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith(
        '/v1/connectors',
        expect.objectContaining({
          body: {
            adapterKey: 'krs',
            credentials: { apiKey: 'k-krs' },
            settings: { baseUrl: 'https://krs.example/api' },
          },
        }),
      ),
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

  it('ST7-T17 ใครออกเลขเอกสาร (ต้นแบบ) = เจ้าของเอกสารภาษี: เปลี่ยนต้องใส่เหตุผล → PUT system-of-record', async () => {
    conns = [conn('ACTIVE')];
    PUT.mockReset().mockResolvedValue({
      data: {
        ...conn('ACTIVE'),
        systemOfRecord: { ...conn('ACTIVE').systemOfRecord, taxDocumentOwner: 'TMS' },
      },
    });
    wrap();
    const box = await screen.findByTestId('numbering-owner');
    const group = within(box).getByRole('radiogroup', { name: 'ใครออกเลขเอกสาร' });
    const erp = within(group).getByRole('radio', {
      name: 'ERP จำลอง (Demo) ออกเลข แล้วส่งกลับ TMS',
    });
    const tms = within(group).getByRole('radio', {
      name: 'TMS ออกเลข แล้วส่งให้ ERP จำลอง (Demo)',
    });
    expect(erp).toHaveAttribute('aria-checked', 'true');
    expect(box.textContent).toContain('แต่ไม่ออกเลขใบกำกับภาษี');
    fireEvent.click(erp); // ค่าเดิม = ไม่เปิด dialog
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(tms);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('เปลี่ยนผู้ออกเลขเอกสาร')).toBeInTheDocument();
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'ตกลงกับลูกค้าให้ TMS ออกใบกำกับภาษี' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() =>
      expect(PUT).toHaveBeenCalledWith(
        '/v1/connectors/{id}/system-of-record',
        expect.objectContaining({
          body: { taxDocumentOwner: 'TMS', reason: 'ตกลงกับลูกค้าให้ TMS ออกใบกำกับภาษี' },
        }),
      ),
    );
  });

  it('ST7-T21 สวิตช์ "ดึงสถานะรับชำระ" (opt-in): เปิดต้องใส่เหตุผลใน dialog → PATCH พร้อม reason · API ไม่รับ = แสดงข้อความใน dialog · ปิด/สวิตช์อื่นไม่ถาม', async () => {
    const base = {
      ...conn('ACTIVE'),
      capabilitiesSupported: ['pullOrders', 'pushInvoice', 'fetchPaymentStatus'],
    };
    conns = [base];
    PATCH.mockReset().mockResolvedValue({ data: base });
    wrap();
    const sw = await screen.findByRole('switch', { name: 'ดึงสถานะรับชำระ' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    // สวิตช์อื่น: ส่งทันที ไม่ถามเหตุผล
    fireEvent.click(screen.getByRole('switch', { name: /ส่งใบแจ้งหนี้/ }));
    await waitFor(() => expect(PATCH).toHaveBeenCalledTimes(1));
    expect(PATCH.mock.calls[0]![1].body).toEqual({ capabilitiesEnabled: ['pullOrders'] });
    expect(screen.queryByRole('dialog')).toBeNull();
    // เปิด opt-in: ยังไม่เรียก API จนกว่าจะใส่เหตุผล
    fireEvent.click(sw);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('เปิดใช้ ดึงสถานะรับชำระ')).toBeInTheDocument();
    expect(PATCH).toHaveBeenCalledTimes(1);
    const ok = within(dlg).getByRole('button', { name: 'เปิดใช้' });
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: 'สั้น' } });
    expect(ok).toBeDisabled();
    // API ปฏิเสธ → ข้อความอยู่ใน dialog (ไม่ปิด)
    const { ApiError } = (await import('../../api')) as unknown as {
      ApiError: new (p: { code: string; status?: number; title?: string }) => Error;
    };
    PATCH.mockRejectedValueOnce(
      new ApiError({ code: 'validation_failed', status: 422, title: 'ข้อมูลไม่ถูกต้อง' }),
    );
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'หัวหน้าบัญชีอนุมัติให้ดึงสถานะรับชำระ' },
    });
    fireEvent.click(ok);
    await waitFor(() => expect(PATCH).toHaveBeenCalledTimes(2));
    expect(PATCH.mock.calls[1]![1].body).toEqual({
      capabilitiesEnabled: ['pullOrders', 'pushInvoice', 'fetchPaymentStatus'],
      reason: 'หัวหน้าบัญชีอนุมัติให้ดึงสถานะรับชำระ',
    });
    await waitFor(() => expect(dlg.querySelector('.tms-field-error')?.textContent).toBeTruthy());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // ลองใหม่สำเร็จ → dialog ปิด
    fireEvent.click(within(dlg).getByRole('button', { name: 'เปิดใช้' }));
    await waitFor(() => expect(PATCH).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('ST7-T17 ยังไม่เลือก (null): ไม่มีตัวเลือกใดถูกเลือกไว้ก่อน + บอกว่าต้องเลือก', async () => {
    const c = conn('ACTIVE');
    conns = [{ ...c, systemOfRecord: { ...c.systemOfRecord, taxDocumentOwner: null } }];
    wrap();
    const box = await screen.findByTestId('numbering-owner');
    for (const r of within(box).getAllByRole('radio'))
      expect(r).toHaveAttribute('aria-checked', 'false');
    expect(box.textContent).toContain('ยังไม่ได้เลือก');
  });

  it('ST8-T16 ระบบบัญชีที่กำหนดเจ้าของเอกสารภาษีตายตัว (D-55): เลือกผู้ออกเลขไม่ได้ + บอกเหตุ · ฟอร์มเชื่อมต่อมีป้ายไทยของช่อง/ตัวเลือก', async () => {
    const as = {
      key: 'accountsystem',
      displayName: 'AccountSystem',
      demo: false,
      capabilities: ['pushInvoice', 'pushSettlement'],
      capabilitiesPending: [],
      masterCodeKinds: [],
      fixedTaxDocumentOwner: 'ERP',
      configFields: [
        {
          key: 'baseUrl',
          secret: false,
          required: true,
          kind: 'url',
          maxLength: 300,
          options: null,
        },
        {
          key: 'apiKey',
          secret: true,
          required: true,
          kind: 'string',
          maxLength: 200,
          options: null,
        },
        {
          key: 'webhookSecret',
          secret: true,
          required: false,
          kind: 'string',
          maxLength: 200,
          options: null,
        },
        {
          key: 'contactMatch',
          secret: false,
          required: false,
          kind: 'string',
          maxLength: 20,
          options: ['taxId', 'tmsCode'],
        },
      ],
    };
    GET.mockImplementation(async (path: string) => {
      if (path === '/v1/connectors') return { data: { data: [] } };
      if (path === '/v1/connectors/adapters') return { data: { data: [ADAPTER, as] } };
      return { data: { data: [] } };
    });
    const { unmount } = wrap();
    const card = await screen.findByRole('group', { name: 'AccountSystem' });
    fireEvent.click(within(card).getByRole('button', { name: 'เชื่อมต่อ' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByLabelText(/secret ของ webhook ขาเข้า/)).toHaveAttribute(
      'type',
      'password',
    );
    const sel = within(dlg).getByLabelText(/จับคู่ลูกค้า \/ รถร่วมในระบบบัญชีด้วย/);
    expect(within(sel).getByRole('option', { name: 'เลขผู้เสียภาษี + สาขา' })).toBeInTheDocument();
    expect(
      within(sel).getByRole('option', { name: 'รหัสลูกค้า / รถร่วมของ TMS' }),
    ).toBeInTheDocument();
    unmount();
    const c = conn('ACTIVE');
    conns = [
      {
        ...c,
        adapterKey: 'accountsystem',
        displayName: 'AccountSystem',
        capabilitiesSupported: ['pushInvoice', 'pushSettlement'],
        capabilitiesEnabled: ['pushInvoice', 'pushSettlement'],
      },
    ];
    GET.mockImplementation(async (path: string) => {
      if (path === '/v1/connectors') return { data: { data: conns } };
      if (path === '/v1/connectors/adapters') return { data: { data: [ADAPTER, as] } };
      return { data: { data: [] } };
    });
    wrap();
    const box = await screen.findByTestId('numbering-owner');
    for (const r of within(box).getAllByRole('radio')) expect(r).toBeDisabled();
    expect(box.textContent).toContain('AccountSystem กำหนดตายตัว เปลี่ยนไม่ได้');
  });

  it('ST7-T17 สิทธิ์อ่านอย่างเดียว: เลือกผู้ออกเลขเอกสารไม่ได้', async () => {
    conns = [conn('ACTIVE')];
    wrap(false);
    const box = await screen.findByTestId('numbering-owner');
    for (const r of within(box).getAllByRole('radio')) expect(r).toBeDisabled();
  });

  it('สิทธิ์อ่านอย่างเดียว: ไม่มีปุ่มเชื่อมต่อ/ทดสอบ', async () => {
    conns = [conn('ACTIVE')];
    wrap(false);
    const card = await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    expect(within(card).queryByRole('button', { name: 'ทดสอบ' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'ตัดการเชื่อมต่อ' })).toBeNull();
  });

  it('โหลด catalog ไม่สำเร็จ = แจ้ง + ลองอีกครั้ง (ไม่ตกไปเป็น "ไม่เชื่อม" ที่กดได้)', async () => {
    GET.mockImplementation(async (path: string) => {
      if (path === '/v1/connectors') return { data: { data: [] } };
      if (path === '/v1/connectors/adapters') throw new Error('boom');
      return { data: { data: [] } };
    });
    wrap();
    expect(await screen.findByText('โหลดการเชื่อมต่อไม่สำเร็จ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ลองอีกครั้ง' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ใช้โหมดนี้' })).toBeNull();
  });

  it('ST8-T03 ERROR จากปลายทางล่ม (TRANSIENT): บอกว่าติดต่อปลายทางไม่ได้ ไม่ใช่ "แก้ key" · ความสามารถที่ยังไม่ได้ทำ = "ยังไม่รองรับ"', async () => {
    conns = [
      {
        ...conn('ERROR'),
        lastHealthError: { code: 'unreachable', errorClass: 'TRANSIENT' },
        activatedAt: 'x',
        capabilitiesPending: ['fetchDocument'],
      },
    ];
    wrap();
    const detail = await screen.findByTestId('connector-detail');
    expect(
      within(detail).getByText(/ติดต่อปลายทางไม่ได้ \(ติดต่อระบบปลายทางไม่ได้\)/),
    ).toBeInTheDocument();
    expect(within(detail).queryByText(/แก้ key/)).toBeNull();
    const pending = within(detail).getByTestId('capability-pending');
    expect(pending.textContent).toContain('อ่านเอกสารจากระบบบัญชี');
    expect(pending.textContent).toContain('ยังไม่รองรับ');
  });

  it('ทดสอบไม่ผ่าน = toast แบบ error พร้อมข้อความไทยของรหัส', async () => {
    conns = [conn('ACTIVE')];
    POST.mockImplementation(async (path: string) =>
      path.endsWith('/health')
        ? { data: { ok: false, code: 'unreachable', connector: conn('ACTIVE') } }
        : { data: conn('ACTIVE') },
    );
    wrap();
    const card = await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    fireEvent.click(within(card).getByRole('button', { name: 'ทดสอบ' }));
    const st = await screen.findByRole('status');
    await waitFor(() => expect(st.textContent).toContain('ติดต่อระบบปลายทางไม่ได้'));
    expect(st.className).toContain('tms-toast--err');
  });

  it('ERROR: หัวกล่องบอกว่าเชื่อมต่อไม่ได้ (ไม่ใช่ "ยังไม่ได้เชื่อมต่อ") · แท็บประวัติแสดงทีม Innovera', async () => {
    conns = [{ ...conn('ERROR'), lastHealthError: { code: 'unauthorized' }, activatedAt: 'x' }];
    GET.mockImplementation(async (path: string) => {
      if (path === '/v1/connectors') return { data: { data: conns } };
      if (path === '/v1/connectors/adapters') return { data: { data: [ADAPTER] } };
      if (path === '/v1/connectors/{id}/history')
        return {
          data: {
            data: [
              {
                id: 'aud_1',
                at: '2026-11-19T03:00:00Z',
                action: 'connector.credentials_changed',
                actor: { id: 'platform:00000000-0000-4000-8000-000000000001', name: 'กิตติ' },
                actAs: null,
                before: null,
                after: null,
                reason: 'ลูกค้าแจ้งหมุน key',
              },
            ],
            nextCursor: null,
            hasMore: false,
          },
        };
      return { data: { data: [] } };
    });
    wrap();
    const detail = await screen.findByTestId('connector-detail');
    expect(
      within(detail).getByText(/เชื่อมต่อไม่ได้ \(key ไม่ถูกต้องหรือถูกเพิกถอน\) · แก้ key/),
    ).toBeInTheDocument();
    expect(within(detail).queryByText('ยังไม่ได้เชื่อมต่อ · ตั้งค่าล่วงหน้าได้')).toBeNull();
    fireEvent.click(within(detail).getByRole('tab', { name: 'ประวัติ' }));
    expect(await within(detail).findByText('เปลี่ยน key')).toBeInTheDocument();
    expect(within(detail).getByText(/ทีม Innovera · กิตติ/)).toBeInTheDocument();
  });

  it('ST7-T19 บันทึกการซิงก์: ปุ่ม "ดู payload" (ต้นแบบ) เปิด request/response ของคำสั่งจาก sync log · คัดลอกได้', async () => {
    conns = [{ ...conn('ACTIVE'), activatedAt: 'x' }];
    const calls: unknown[] = [];
    const scopes = ['*'];
    GET.mockImplementation(async (path: string, init?: unknown) => {
      calls.push([path, init]);
      if (path === '/v1/me') return { data: { scopes } };
      if (path === '/v1/connectors') return { data: { data: conns } };
      if (path === '/v1/connectors/adapters') return { data: { data: [ADAPTER] } };
      if (path === '/v1/connectors/{id}/commands')
        return {
          data: {
            data: [
              {
                id: 'obx_1',
                operation: 'PUSH_INVOICE',
                entityType: 'invoice',
                localId: 'ivc_00000000000000000000000000abcdef',
                status: 'FAILED_FINAL',
                attempt: 1,
                errorClass: 'PERIOD_CLOSED',
                errorCode: 'period_closed',
                createdAt: '2026-11-19T03:00:00Z',
                doneAt: '2026-11-19T03:00:01Z',
                updatedAt: '2026-11-19T03:00:01Z',
              },
            ],
          },
        };
      if (path === '/v1/connectors/{id}/sync-log') {
        // review L4: หน้าแรกมีต่อ (cursor) → หน้าที่สองเป็นการเรียกครั้งก่อนหน้า
        const cur = (init as { params: { query: { cursor?: string } } }).params.query.cursor;
        if (!cur)
          return {
            data: {
              data: [
                {
                  id: 'slg_0',
                  commandId: 'obx_1',
                  attempt: 1,
                  operation: 'PUSH_INVOICE',
                  entityType: 'invoice',
                  localId: null,
                  documentNo: 'INV-1',
                  direction: 'OUT',
                  method: 'GET',
                  url: 'https://demo.invalid/api/invoices?ref',
                  statusCode: 404,
                  errorCode: null,
                  durationMs: 10,
                  requestBody: null,
                  responseBody: null,
                  bodiesHidden: false,
                  occurredAt: '2026-11-19T03:00:05Z',
                },
              ],
              nextCursor: 'c2',
              hasMore: true,
            },
          };
        return {
          data: {
            data: [
              {
                id: 'slg_1',
                commandId: 'obx_1',
                attempt: 1,
                operation: 'PUSH_INVOICE',
                entityType: 'invoice',
                localId: null,
                documentNo: 'INV-1',
                direction: 'OUT',
                method: 'POST',
                url: 'https://demo.invalid/api/invoices',
                statusCode: 422,
                errorCode: 'period_closed',
                durationMs: 40,
                requestBody: '{"number":"INV-1","taxId":"***"}',
                responseBody: 'period closed',
                bodiesHidden: false,
                occurredAt: '2026-11-19T03:00:00Z',
              },
            ],
            nextCursor: null,
            hasMore: false,
          },
        };
      }
      return { data: { data: [] } };
    });
    const write = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    wrap();
    const detail = await screen.findByTestId('connector-detail');
    fireEvent.click(within(detail).getByRole('tab', { name: 'บันทึกการซิงก์' }));
    expect(
      await within(detail).findByRole('columnheader', { name: 'Payload' }),
    ).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'ดู payload' }));
    const dlg = await screen.findByRole('dialog', { name: /Payload ที่ส่งเข้า/ });
    expect(calls).toContainEqual([
      '/v1/connectors/{id}/sync-log',
      { params: { path: { id: 'con_1' }, query: { commandId: 'obx_1', limit: 50 } } },
    ]);
    const pre = dlg.querySelector('pre')!.textContent!;
    const list = JSON.parse(pre);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      request: { method: 'POST', url: 'https://demo.invalid/api/invoices', body: { taxId: '***' } },
      response: { status: 422, code: 'period_closed', body: 'period closed' },
    });
    expect(list[1]).toMatchObject({ request: { method: 'GET' }, response: { status: 404 } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'คัดลอก' }));
    expect(write).toHaveBeenCalledWith(pre);
    expect(await screen.findByText('คัดลอก payload แล้ว')).toBeInTheDocument();
  });

  it('ST7-T19 review H1: ไม่มีสิทธิ์ดูราคาขาย = ไม่แสดงปุ่ม "ดู payload" ของใบแจ้งหนี้', async () => {
    conns = [{ ...conn('ACTIVE'), activatedAt: 'x' }];
    GET.mockImplementation(async (path: string) => {
      if (path === '/v1/me') return { data: { scopes: ['settings:read'] } };
      if (path === '/v1/connectors') return { data: { data: conns } };
      if (path === '/v1/connectors/adapters') return { data: { data: [ADAPTER] } };
      if (path === '/v1/connectors/{id}/commands')
        return {
          data: {
            data: [
              {
                id: 'obx_1',
                operation: 'PUSH_INVOICE',
                entityType: 'invoice',
                localId: 'ivc_00000000000000000000000000abcdef',
                status: 'DONE',
                attempt: 1,
                errorClass: null,
                errorCode: null,
                createdAt: '2026-11-19T03:00:00Z',
                doneAt: '2026-11-19T03:00:01Z',
                updatedAt: '2026-11-19T03:00:01Z',
              },
            ],
          },
        };
      return { data: { data: [] } };
    });
    wrap();
    const detail = await screen.findByTestId('connector-detail');
    fireEvent.click(within(detail).getByRole('tab', { name: 'บันทึกการซิงก์' }));
    expect(await within(detail).findByText('ส่งใบแจ้งหนี้')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'ดู payload' })).toBeNull();
  });

  it('ST7-T19 payloadJson: ไม่มีการเรียก = null · หลายครั้ง = รายการเรียงตามเวลา', () => {
    expect(payloadJson([])).toBeNull();
    const l = (id: string, at: string) => ({
      id,
      commandId: 'obx_1',
      attempt: 1,
      operation: 'PUSH_INVOICE',
      entityType: 'invoice',
      localId: null,
      documentNo: null,
      direction: 'OUT' as const,
      method: 'GET',
      url: `https://x.invalid/${id}`,
      statusCode: 200,
      errorCode: null,
      durationMs: 1,
      requestBody: null,
      responseBody: null,
      bodiesHidden: false,
      occurredAt: at,
    });
    const out = JSON.parse(
      payloadJson([l('b', '2026-11-19T03:00:02Z'), l('a', '2026-11-19T03:00:01Z')])!,
    );
    expect(out.map((x: { request: { url: string } }) => x.request.url)).toEqual([
      'https://x.invalid/a',
      'https://x.invalid/b',
    ]);
  });

  it('ST8-T04 รหัสที่รอบดึง SO หยุด connector แสดงเป็นข้อความไทย (ไม่ใช่รหัสดิบ)', async () => {
    const { th } = await import('../../i18n/th');
    const t = ((k: keyof typeof th) => th[k]) as Parameters<typeof healthText>[0];
    expect(healthText(t, 'source_columns_missing')).toBe('แหล่งข้อมูล SO ขาดคอลัมน์ที่จำเป็น');
    expect(healthText(t, 'source_not_found')).toBe('ไม่พบแหล่งข้อมูล SO ที่ปลายทาง');
  });

  it('Q-RES (PO 24 พ.ย.): เปิดใช้จาก ERROR ต้องมีเหตุผล ≥ 10 ตัว → resume { reason } · PAUSED เปิดได้เลย', async () => {
    conns = [{ ...conn('ERROR'), lastHealthError: { code: 'unauthorized' }, activatedAt: 'x' }];
    wrap();
    const card = await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    fireEvent.click(within(card).getByRole('button', { name: 'เชื่อมต่อ' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('เปิดใช้ ERP จำลอง (Demo) อีกครั้ง')).toBeInTheDocument();
    expect(POST).not.toHaveBeenCalledWith('/v1/connectors/{id}/resume', expect.anything());
    const ok = within(dlg).getByRole('button', { name: 'เชื่อมต่อ' }) as HTMLButtonElement;
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: 'สั้น' } });
    expect(ok.disabled).toBe(true);
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'แก้ key ในระบบบัญชีแล้ว' },
    });
    fireEvent.click(ok);
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith(
        '/v1/connectors/{id}/resume',
        expect.objectContaining({ body: { reason: 'แก้ key ในระบบบัญชีแล้ว' } }),
      ),
    );
  });

  it('PAUSED: กดเชื่อมต่อ → resume ทันที (ไม่มีกล่องเหตุผล)', async () => {
    conns = [{ ...conn('PAUSED'), activatedAt: 'x' }];
    wrap();
    const card = await screen.findByRole('group', { name: 'ERP จำลอง (Demo)' });
    fireEvent.click(within(card).getByRole('button', { name: 'เชื่อมต่อ' }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith(
        '/v1/connectors/{id}/resume',
        expect.objectContaining({ body: {} }),
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('#89 (PO 24 พ.ย.): ช่อง "ตรวจเทียบหลังส่ง (นาที)" 0–1440 เฉพาะระบบที่อ่านเอกสารกลับได้ · บันทึกเมื่อออกจากช่อง', async () => {
    conns = [
      {
        ...conn('ACTIVE'),
        activatedAt: 'x',
        capabilitiesSupported: ['pushInvoice', 'fetchDocument'],
        afterPushReconcileDelayMinutes: 0,
      },
    ];
    PATCH.mockReset().mockResolvedValue({ data: conns[0] });
    wrap();
    const box = await screen.findByLabelText(/ตรวจเทียบหลังส่ง \(นาที\)/);
    expect(screen.getByText(/0 = อ่านเอกสารจาก .* มาเทียบทันที/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '2000' } });
    expect(screen.getByText('กรอกจำนวนเต็ม 0–1440 นาที')).toBeInTheDocument();
    fireEvent.blur(box);
    expect(PATCH).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '15' } });
    fireEvent.blur(box);
    await waitFor(() =>
      expect(PATCH).toHaveBeenCalledWith(
        '/v1/connectors/{id}',
        expect.objectContaining({ body: { afterPushReconcileDelayMinutes: 15 } }),
      ),
    );
  });

  it('#89: ระบบที่อ่านเอกสารกลับไม่ได้ = ไม่มีช่องหน่วงเวลา', async () => {
    conns = [{ ...conn('ACTIVE'), activatedAt: 'x' }];
    wrap();
    await screen.findByTestId('connector-detail');
    expect(screen.queryByLabelText(/ตรวจเทียบหลังส่ง \(นาที\)/)).toBeNull();
  });
});
