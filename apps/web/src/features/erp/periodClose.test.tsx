import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * #95 (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ) แท็บ "ปิดงวด" ของหน้าคิวเชื่อมระบบบัญชี: การ์ดผล/ค้าง/ยังไม่ส่ง/ยังไม่ยืนยัน/ยอมรับ ·
 * 3 ส่วนในการ์ดรายงาน · เลือกงวด · ส่งออก xlsx/csv/pdf · สิทธิ์ราคา + การ์ด "สำเร็จ 24 ชม." (อัตรา)
 */
const GET = vi.fn();
const POST = vi.fn();
let scopes: string[] = ['*'];
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: {
    GET: async (p: string, o: unknown) => ({
      ...(await GET(p, o)),
      response: { ok: true, status: 200 },
    }),
    POST: async (p: string, o: unknown) => ({
      ...(await POST(p, o)),
      response: { ok: true, status: 202 },
    }),
  },
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { scopes, tenant: { yearStyle: 'BE' } } }),
}));
vi.mock('../stepup/stepUp', async (orig) => ({
  ...(await orig<typeof import('../stepup/stepUp')>()),
  withStepUp: (f: (su: null) => unknown) => f(null),
  stepUpHeaders: () => ({}),
}));

const { PeriodClosePanel, closeResult, defaultCloseMonth } = await import('./PeriodClosePanel');
const { okRate, okColor } = await import('./ErpPage');
const { bulkFailList } = await import('./queue');

const report = (over: Record<string, unknown> = {}) => ({
  connector: { id: 'con_1', adapterKey: 'krs', displayName: 'KRS' },
  month: '2026-10',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  asOf: '2026-10-31T17:00:00Z',
  monthEnded: true,
  passed: false,
  generatedAt: '2026-11-24T03:00:00Z',
  summary: {
    outstanding: 1,
    outstandingMoney: 1,
    outstandingField: 0,
    unverified: 0,
    acknowledged: 1,
    notSent: 1,
    notSentQueued: 0,
    notSentFailed: 1,
  },
  outstanding: [
    {
      id: 'rcr_1',
      invoiceId: 'ivc_1',
      localNumber: 'INV-2610-0001',
      check: 'DOCUMENT',
      code: 'content_mismatch',
      result: 'MISMATCH',
      severity: 'MONEY',
      foundAt: '2026-10-20T03:00:00Z',
      lastSeenAt: '2026-10-21T03:00:00Z',
      currentStatus: 'OPEN',
      closedAt: null,
      sellDifferenceAmount: '-120.00',
    },
  ],
  acknowledged: [
    {
      id: 'rcr_2',
      invoiceId: 'ivc_2',
      localNumber: 'INV-2610-0002',
      check: 'DOCUMENT',
      code: 'content_mismatch',
      result: 'MISMATCH',
      severity: 'FIELD',
      foundAt: '2026-10-10T03:00:00Z',
      lastSeenAt: '2026-10-10T03:00:00Z',
      currentStatus: 'ACKNOWLEDGED',
      closedAt: null,
      acknowledgedAt: '2026-10-12T03:00:00Z',
      acknowledgedBy: 'u1',
      acknowledgedByName: 'สมหญิง บัญชี',
      ackReason: 'ฝ่ายบัญชีแก้ชื่อใน KRS เอง',
    },
  ],
  notSent: [
    {
      commandId: 'obx_9',
      entityType: 'invoice',
      documentId: 'ivc_3',
      documentNo: 'INV-2610-0003',
      documentDate: '2026-10-30',
      counterpartyName: 'บริษัท ลูกค้า จำกัด',
      operation: 'PUSH_INVOICE',
      queueTab: 'failed',
      status: 'FAILED_FINAL',
      errorClass: 'PERIOD_CLOSED',
      errorCode: null,
      nextRunAt: null,
      updatedAt: '2026-11-01T03:00:00Z',
      sellTotalAmount: '1070.00',
    },
  ],
  truncated: false,
  ...over,
});

const wrap = (props: Partial<Parameters<typeof PeriodClosePanel>[0]> = {}) => {
  const onOpenResult = vi.fn();
  const onOpenQueue = vi.fn();
  const onToast = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <I18nProvider lang="th">
          <PeriodClosePanel
            connectorId="con_1"
            erp="KRS"
            onOpenResult={onOpenResult}
            onOpenQueue={onOpenQueue}
            onToast={onToast}
            {...props}
          />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onOpenResult, onOpenQueue, onToast };
};

describe('รายงานปิดงวด (#95)', () => {
  beforeEach(() => {
    scopes = ['*'];
    GET.mockReset().mockImplementation(async () => ({ data: report() }));
    POST.mockReset();
  });

  it('ผลของงวดมาจาก API (passed/monthEnded) — หน้าไม่คิดเอง · งวดเริ่ม = เดือนก่อน', () => {
    expect(closeResult({ passed: true, monthEnded: true })).toEqual({
      k: 'erpq.pc.res.pass',
      tone: 'ok',
    });
    expect(closeResult({ passed: false, monthEnded: true }).k).toBe('erpq.pc.res.fail');
    expect(closeResult({ passed: false, monthEnded: false }).k).toBe('erpq.pc.res.open');
    expect(defaultCloseMonth(new Date('2026-11-24T03:00:00Z'))).toBe('2026-10');
    expect(defaultCloseMonth(new Date('2026-01-01T03:00:00Z'))).toBe('2025-12');
  });

  it('การ์ดสรุป + ส่วนค้าง (ค่าเริ่ม) · คลิกแถวเปิดผลเทียบ · แท็บยอมรับ/ยังไม่ส่ง', async () => {
    const cb = wrap();
    const card = await screen.findByTestId('period-close');
    await within(card).findByText('ไม่ผ่าน');
    expect(GET).toHaveBeenCalledWith('/v1/reconcile-reports/period-close', {
      params: { query: { connectorId: 'con_1', month: defaultCloseMonth() } },
    });
    expect(within(card).getByText('ยอดเงิน 1 · ข้อมูล 0')).toBeInTheDocument();
    expect(within(card).getByText('รอคิว 0 · ล้มเหลว 1')).toBeInTheDocument();
    expect(within(card).getByText('-120.00')).toBeInTheDocument();
    fireEvent.click(within(card).getByText('INV-2610-0001'));
    expect(cb.onOpenResult).toHaveBeenCalledWith('rcr_1');
    fireEvent.click(within(card).getByRole('tab', { name: /ยอมรับความต่าง/ }));
    expect(within(card).getByText('ฝ่ายบัญชีแก้ชื่อใน KRS เอง')).toBeInTheDocument();
    expect(within(card).getByText('สมหญิง บัญชี')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('tab', { name: /ยังไม่ส่ง/ }));
    expect(within(card).getByText('1,070.00')).toBeInTheDocument();
    fireEvent.click(within(card).getByText('INV-2610-0003'));
    expect(cb.onOpenQueue).toHaveBeenCalledWith('failed');
  });

  it('ไม่มีสิทธิ์ดูราคาขาย = ไม่มีคอลัมน์ส่วนต่าง · ไม่มี export:run = ไม่มีปุ่มส่งออก', async () => {
    scopes = ['integrations:read'];
    wrap();
    const card = await screen.findByTestId('period-close');
    await within(card).findByText('INV-2610-0001');
    expect(within(card).queryByText('ส่วนต่าง (฿)')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'ส่งออก Excel' })).toBeNull();
  });

  it('เลือกงวด → เรียกใหม่ด้วยเดือนนั้น · ส่งออก PDF = งานส่งออก reconcile-period-close', async () => {
    POST.mockResolvedValue({ data: { id: 'exp_1', status: 'queued' } });
    GET.mockImplementation(async (p: string) =>
      p === '/v1/exports/{id}'
        ? { data: { id: 'exp_1', status: 'failed', error: { code: 'too_many_rows' } } }
        : { data: report() },
    );
    const cb = wrap();
    const card = await screen.findByTestId('period-close');
    await within(card).findByText('INV-2610-0001');
    const sel = within(card).getByLabelText('งวดของรายงาน') as HTMLSelectElement;
    const prev = sel.options[2]!.value;
    fireEvent.change(sel, { target: { value: prev } });
    await waitFor(() =>
      expect(GET).toHaveBeenCalledWith('/v1/reconcile-reports/period-close', {
        params: { query: { connectorId: 'con_1', month: prev } },
      }),
    );
    await within(card).findByText('INV-2610-0001');
    fireEvent.click(within(card).getByRole('button', { name: 'ส่งออก PDF' }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith(
        '/v1/exports',
        expect.objectContaining({
          body: {
            resource: 'reconcile-period-close',
            format: 'pdf',
            filter: { connectorId: 'con_1', month: prev },
          },
        }),
      ),
    );
    await waitFor(() => expect(cb.onToast).toHaveBeenCalled(), { timeout: 4000 });
    expect(cb.onToast).toHaveBeenLastCalledWith(
      'รายการเกิน 100,000 แถว — กรองให้แคบลงแล้วส่งออกใหม่',
    );
  });

  it('ยังไม่จบเดือน = "ยังไม่จบเดือน" · ว่าง = ข้อความของส่วน · ไม่มี connector = แจ้งให้เชื่อม', async () => {
    GET.mockImplementation(async () => ({
      data: report({
        monthEnded: false,
        outstanding: [],
        summary: { ...report().summary, outstanding: 0 },
      }),
    }));
    wrap();
    const card = await screen.findByTestId('period-close');
    await within(card).findByText('ยังไม่จบเดือน');
    expect(within(card).getByText('ไม่มีรายการไม่ตรงค้าง')).toBeInTheDocument();
  });

  it('ไม่มี connector = แจ้งให้เชื่อมระบบบัญชี (ไม่เรียก API)', () => {
    wrap({ connectorId: null });
    expect(screen.getByText('ยังไม่ได้เชื่อมระบบบัญชี')).toBeInTheDocument();
    expect(GET).not.toHaveBeenCalled();
  });

  it('การ์ด "สำเร็จ 24 ชม." = อัตราแบบต้นแบบ "96.4%" · ไม่มีคำสั่งที่จบ = "—"', () => {
    expect(okRate({ succeeded24h: 27, finished24h: 28 })).toBe('96.4%');
    expect(okRate({ succeeded24h: 0, finished24h: 0 })).toBe('—');
    expect(okRate(undefined)).toBe('—');
    // review L5: ไม่มีคำสั่งที่จบ = สีปกติ · 0% = แดง · มีสำเร็จ = เขียวตามต้นแบบ
    expect(okColor(undefined)).toBe('#101418');
    expect(okColor({ succeeded24h: 0, finished24h: 0 })).toBe('#101418');
    expect(okColor({ succeeded24h: 0, finished24h: 3 })).toBe('#B3322A');
    expect(okColor({ succeeded24h: 2, finished24h: 3 })).toBe('#17733F');
  });

  it('review L3: รายการที่ bulk ทำไม่สำเร็จ = "เลข (เหตุ)" สูงสุด 5 รายการ', () => {
    expect(
      bulkFailList([
        { no: 'INV-1', why: 'งวดปิด' },
        { no: 'INV-2', why: null },
      ]),
    ).toBe('INV-1 (งวดปิด); INV-2');
    const many = Array.from({ length: 7 }, (_, i) => ({ no: `INV-${i}`, why: null }));
    expect(bulkFailList(many)).toBe('INV-0; INV-1; INV-2; INV-3; INV-4 …');
  });
});
