import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/** ST7-T23 dialog "ส่งออกให้นักบัญชี" (ต้นแบบ TMS v4 vXp) + งวด/ชื่อไฟล์ (กติกาเดียวกับ API) */
const ok = (data: unknown) => Promise.resolve({ data, response: { ok: true, status: 200 } });
const summary = {
  dateFrom: '2026-10-01',
  dateTo: '2026-10-31',
  datasets: [
    {
      dataset: 'sales',
      resource: 'accounting-sales',
      documents: 12,
      cancelledDocuments: 1,
      rows: 40,
    },
    {
      dataset: 'receipts',
      resource: 'accounting-receipts',
      documents: 5,
      cancelledDocuments: 0,
      rows: 11,
    },
    {
      dataset: 'settlements',
      resource: 'accounting-settlements',
      documents: 3,
      cancelledDocuments: 0,
      rows: 9,
    },
    {
      dataset: 'wht',
      resource: 'accounting-wht-summary',
      documents: 4,
      cancelledDocuments: 0,
      rows: 2,
    },
  ],
  templates: [{ key: 'generic', displayName: 'ทั่วไป', isDefault: true, datasets: [] }],
};
let n = 0;
/** งานส่งออก — `/v1/auth/step-up` (D-67) คืน token เสมอ */
const job = () =>
  Promise.resolve({ data: { id: `job_${++n}` }, response: { ok: true, status: 202 } });
const POST = vi.fn((p: string, _o: unknown) =>
  p === '/v1/auth/step-up' ? ok({ stepUpToken: 'su-token', expiresIn: 300 }) : job(),
);
const GET = vi.fn((p: string, _o?: unknown) =>
  p === '/v1/accounting-exports/summary'
    ? ok(summary)
    : ok({ status: 'succeeded', downloadUrl: 'http://x/f', error: null }),
);
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

const { xpPeriods, xpPeriodTag } = await import('./accountantExport');
const { AccountantExportDialog } = await import('./AccountantExportDialog');
const { StepUpHost, clearStepUp } = await import('../stepup/stepUp');

/** D-67 กล่องยืนยัน 2FA (StepUpHost) — กรอกรหัสแล้วกดยืนยัน */
async function confirm2fa() {
  const box = await screen.findByRole('group', { name: 'ยืนยันตัวตน 2 ชั้นอีกครั้ง' });
  fireEvent.change(box.querySelector('input')!, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยัน' }));
}
const exportPosts = () => POST.mock.calls.filter((c) => c[0] === '/v1/exports');

beforeEach(() => {
  clearStepUp();
  POST.mockClear();
  GET.mockClear();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

describe('งวดและชื่อไฟล์', () => {
  it('เดือนที่แล้ว (ค่าเริ่ม) · เดือนนี้ถึงวันนี้ · ไตรมาสนี้ — ข้ามปี', () => {
    expect(xpPeriods('2026-11-22')).toEqual([
      { key: 'last', from: '2026-10-01', to: '2026-10-31', month: 10, year: 2026 },
      { key: 'this', from: '2026-11-01', to: '2026-11-22', month: 11, year: 2026 },
      { key: 'quarter', from: '2026-10-01', to: '2026-12-31', month: 10, year: 2026, q: 4 },
    ]);
    expect(xpPeriods('2027-01-05')[0]).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
  });
  it('ป้ายงวดตรงกับ API (accountingPeriodTag)', () => {
    const m = (x: number) => ['ต.ค.', 'ก.พ.'][x === 10 ? 0 : 1]!;
    const q = (x: number, y: number) => `Q${x}-${y}`;
    expect(xpPeriodTag('2026-10-01', '2026-10-31', m, q)).toBe('ต.ค.2569');
    expect(xpPeriodTag('2026-10-01', '2026-12-31', m, q)).toBe('Q4-2569');
    expect(xpPeriodTag('2026-11-01', '2026-11-22', m, q)).toBe('2026-11-01_2026-11-22');
    expect(xpPeriodTag('2024-02-01', '2024-02-29', m, q)).toBe('ก.พ.2567');
  });
});

describe('AccountantExportDialog', () => {
  const mount = (onToast = vi.fn(), onClose = vi.fn()) => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <AccountantExportDialog onClose={onClose} onToast={onToast} />
          <StepUpHost />
        </I18nProvider>
      </QueryClientProvider>,
    );
    return { onToast, onClose };
  };

  it('ชุดข้อมูลจาก summary (จำนวนรายการ) · ไฟล์ที่จะได้ = ชื่อไทยตามงวด + จำนวนแถว · รูปแบบอื่นปิด', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T03:00:00Z'));
    mount();
    expect(screen.getByRole('heading', { name: 'ส่งออกให้นักบัญชี' })).toBeInTheDocument();
    expect(await screen.findByText('12 รายการ')).toBeInTheDocument();
    expect(GET).toHaveBeenCalledWith('/v1/accounting-exports/summary', {
      params: { query: { dateFrom: '2026-10-01', dateTo: '2026-10-31' } },
    });
    expect(screen.getByText('รายการขาย_ต.ค.2569.xlsx')).toBeInTheDocument();
    expect(screen.getByText('40 แถว')).toBeInTheDocument();
    expect(screen.getByText('จ่ายรถร่วม_ต.ค.2569.xlsx')).toBeInTheDocument();
    // D-73 ชุด "หัก ณ ที่จ่าย" (ต้นแบบ) = สรุปประมาณการ — ชื่อไฟล์ติด "ประมาณการ" ตรงกับ API
    expect(screen.getByText('หัก ณ ที่จ่าย')).toBeInTheDocument();
    expect(screen.getByText(/ประมาณการ ไม่ใช่แบบยื่น/)).toBeInTheDocument();
    expect(screen.getByText('หัก ณ ที่จ่าย-ประมาณการ_ต.ค.2569.xlsx')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PEAK/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /ทั่วไป/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: 'CSV' }));
    expect(screen.getByText('รายการขาย_ต.ค.2569.csv')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /รับชำระ/ }));
    expect(screen.queryByText('รับชำระ_ต.ค.2569.csv')).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'quarter' } });
    expect(await screen.findByText('รายการขาย_ไตรมาส4-2569.csv')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('ส่งออก = 1 งานต่อชุดที่เลือก (resource + ช่วงวันที่ + ชนิดไฟล์) → ดาวน์โหลด → toast', async () => {
    const { onToast, onClose } = mount();
    await screen.findByText('12 รายการ');
    fireEvent.click(screen.getByRole('checkbox', { name: /จ่ายรถร่วม/ }));
    fireEvent.click(screen.getByRole('button', { name: 'ส่งออก' }));
    // D-67 ส่งออกให้นักบัญชี = ข้อมูลการเงินทั้งบริษัท → ยืนยัน 2FA ครั้งเดียวก่อนสั่งทุกไฟล์
    expect(exportPosts()).toHaveLength(0);
    await confirm2fa();
    await waitFor(() => expect(onToast).toHaveBeenCalled(), { timeout: 4000 });
    expect(POST).toHaveBeenCalledWith('/v1/auth/step-up', { body: { otp: '123456' } });
    const bodies = exportPosts().map((c) => (c[1] as { body: Record<string, unknown> }).body);
    expect(bodies.map((b) => b.resource)).toEqual([
      'accounting-sales',
      'accounting-receipts',
      'accounting-wht-summary',
    ]);
    for (const c of exportPosts())
      expect((c[1] as { headers: Record<string, string> }).headers).toEqual({
        'X-Step-Up': 'su-token',
      });
    expect(bodies[0]).toMatchObject({ format: 'xlsx', filter: { dateFrom: expect.any(String) } });
    expect(onToast).toHaveBeenCalledWith(
      'ส่งออก 3 ไฟล์ รูปแบบ ทั่วไป แล้ว · ถ้าเบราว์เซอร์ถาม ให้อนุญาตดาวน์โหลดหลายไฟล์',
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('ระหว่างโหลดจำนวน ไม่ขึ้น "เลือกชุดข้อมูลอย่างน้อย 1 ชุด" · ยกเลิกทุกชุดแล้วจึงขึ้น', async () => {
    mount();
    expect(screen.queryByText('เลือกชุดข้อมูลอย่างน้อย 1 ชุด')).toBeNull();
    await screen.findByText('12 รายการ');
    for (const n of [/รายการขาย/, /รับชำระ/, /จ่ายรถร่วม/, /ลูกค้าหักเรา/])
      fireEvent.click(screen.getByRole('checkbox', { name: n }));
    expect(screen.getByText('เลือกชุดข้อมูลอย่างน้อย 1 ชุด')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ส่งออก' })).toBeDisabled();
  });

  it('ยกเลิกกล่องยืนยัน 2FA = ไม่สั่งงาน ไม่ขึ้น toast error · dialog ยังเปิดอยู่ (D-67)', async () => {
    const { onToast, onClose } = mount();
    await screen.findByText('12 รายการ');
    fireEvent.click(screen.getByRole('button', { name: 'ส่งออก' }));
    await screen.findByRole('group', { name: 'ยืนยันตัวตน 2 ชั้นอีกครั้ง' });
    fireEvent.click(screen.getAllByRole('button', { name: 'ยกเลิก' }).at(-1)!);
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'ยืนยันตัวตน 2 ชั้นอีกครั้ง' })).toBeNull(),
    );
    expect(exportPosts()).toHaveLength(0);
    expect(onToast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'ส่งออก' })).toBeEnabled();
  });

  it('บางไฟล์สั่งไม่สำเร็จ = งานที่สร้างแล้วเดินต่อ + toast "กำลังส่งออก"', async () => {
    let first = true;
    POST.mockImplementation((p: string) => {
      if (p === '/v1/auth/step-up') return ok({ stepUpToken: 'su-token', expiresIn: 300 });
      if (first) {
        first = false;
        return Promise.reject(new Error('x'));
      }
      return job();
    });
    const { onToast } = mount();
    await screen.findByText('12 รายการ');
    fireEvent.click(screen.getByRole('button', { name: 'ส่งออก' }));
    await confirm2fa();
    await waitFor(() => expect(onToast).toHaveBeenCalled(), { timeout: 4000 });
    expect(exportPosts()).toHaveLength(4);
    expect(onToast).toHaveBeenCalledWith(
      'กำลังส่งออก — ระบบจะแจ้งเตือนพร้อมลิงก์ดาวน์โหลดเมื่อไฟล์พร้อม',
    );
  });
});
