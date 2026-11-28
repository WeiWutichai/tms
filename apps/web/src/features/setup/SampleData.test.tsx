import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const POST = vi.fn();
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
class ApiError extends Error {
  constructor(public problem: { code: string; title?: string }) {
    super(problem.code);
  }
}
vi.mock('../../api', () => ({
  api: { GET: vi.fn(), POST: (...a: unknown[]) => POST(...a) },
  queryClient: qc,
  unwrap: async (p: Promise<{ data?: unknown; error?: { code: string } }>) => {
    const r = await p;
    if (r.error) throw new ApiError(r.error);
    return r.data;
  },
  ApiError,
}));

const { SampleDataStrip } = await import('./SampleData');

const ZERO = {
  customer: 0,
  customer_site: 0,
  carrier: 0,
  vehicle: 0,
  driver: 0,
  rate_card: 0,
  sales_order: 0,
};
const LOADED = {
  customer: 3,
  customer_site: 7,
  carrier: 2,
  vehicle: 5,
  driver: 2,
  rate_card: 6,
  sales_order: 4,
};

const show = (s: { allowed: boolean; loaded: boolean; counts: typeof ZERO }, onToast = vi.fn()) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider lang="th">
        <SampleDataStrip s={s} onToast={onToast} />
      </I18nProvider>
    </QueryClientProvider>,
  );

/** P1-ST2-T09 แถบข้อมูลตัวอย่างในการ์ดเริ่มต้นใช้งาน */
describe('ข้อมูลตัวอย่าง (P1-ST2-T09)', () => {
  beforeEach(() => POST.mockReset());

  it('ช่วงทดลองใช้ ยังไม่มี: ปุ่ม "ใส่ข้อมูลตัวอย่าง" → POST /v1/sample-data → toast', async () => {
    POST.mockResolvedValue({ data: { allowed: true, loaded: true, counts: LOADED } });
    const onToast = vi.fn();
    show({ allowed: true, loaded: false, counts: ZERO }, onToast);
    expect(screen.getByText('ลองใช้ด้วยข้อมูลตัวอย่าง')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ใส่ข้อมูลตัวอย่าง' }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('ใส่ข้อมูลตัวอย่างแล้ว'));
    expect(POST).toHaveBeenCalledWith('/v1/sample-data');
  });

  it('ใส่ไม่ได้ (409) → ข้อความไทยจาก catalog', async () => {
    POST.mockResolvedValue({ error: { code: 'sample_data_not_allowed' } });
    show({ allowed: true, loaded: false, counts: ZERO });
    fireEvent.click(screen.getByRole('button', { name: 'ใส่ข้อมูลตัวอย่าง' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ใส่ข้อมูลตัวอย่างได้เฉพาะช่วงทดลองใช้หรือใน sandbox',
    );
  });

  it('มีข้อมูลตัวอย่าง: จำนวนต่อชนิด + "ล้างข้อมูลตัวอย่าง" → ยืนยัน → POST clear → toast', async () => {
    POST.mockResolvedValue({
      data: { allowed: true, loaded: false, counts: ZERO, removed: LOADED, kept: [] },
    });
    const onToast = vi.fn();
    show({ allowed: true, loaded: true, counts: LOADED }, onToast);
    expect(
      screen.getByText(
        /ลูกค้า 3 · สถานที่ 7 · รถ 5 · คนขับ 2 · รถร่วม 2 · rate card 6 · ใบสั่งขนส่ง 4/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ล้างข้อมูลตัวอย่าง' }));
    const dlg = screen.getByRole('alertdialog', { name: 'ล้างข้อมูลตัวอย่าง?' });
    expect(dlg).toHaveTextContent('ข้อมูลที่คุณสร้างเองไม่ถูกแตะ');
    expect(POST).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ล้างข้อมูล' }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('ล้างข้อมูลตัวอย่างแล้ว'));
    expect(POST).toHaveBeenCalledWith('/v1/sample-data/clear');
  });

  it('ล้างแล้วมีรายการที่ถูกใช้ต่อ → dialog รายการที่เก็บไว้พร้อมชนิด', async () => {
    POST.mockResolvedValue({
      data: {
        allowed: true,
        loaded: true,
        counts: { ...ZERO, customer: 1 },
        removed: { ...LOADED, customer: 2 },
        kept: [
          {
            entityType: 'customer',
            id: 'cus_1',
            label: 'CUS-0002 บริษัท ตัวอย่างค้าวัสดุ จำกัด',
            reason: 'in_use',
          },
        ],
      },
    });
    show({ allowed: true, loaded: true, counts: LOADED });
    fireEvent.click(screen.getByRole('button', { name: 'ล้างข้อมูลตัวอย่าง' }));
    fireEvent.click(screen.getByRole('button', { name: 'ล้างข้อมูล' }));
    const dlg = await screen.findByRole('dialog', { name: 'ล้างแล้ว — เก็บไว้ 1 รายการ' });
    expect(dlg).toHaveTextContent('CUS-0002 บริษัท ตัวอย่างค้าวัสดุ จำกัด');
    expect(screen.getByTestId('sample-kept')).toHaveTextContent('ลูกค้า');
    // เหลือแต่แถวที่ถูกใช้งานจริง → บอกชัด ไม่มีปุ่มล้างซ้ำ
    fireEvent.click(screen.getAllByRole('button', { name: 'ปิด' })[0]!);
    expect(screen.getByTestId('sample-data')).toHaveTextContent(
      'ที่เหลือถูกใช้งานจริงแล้ว จึงไม่ลบ',
    );
    expect(screen.queryByRole('button', { name: 'ล้างข้อมูลตัวอย่าง' })).toBeNull();
  });

  it('บริษัทที่ใช้งานจริงแล้ว และไม่มีข้อมูลตัวอย่าง → ไม่แสดง', () => {
    const { container } = show({ allowed: false, loaded: false, counts: ZERO });
    expect(container.textContent).toBe('');
  });
});
