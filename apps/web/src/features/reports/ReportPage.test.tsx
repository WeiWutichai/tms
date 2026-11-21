import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { sortAging } from './useReports';

let scopes: string[] = ['*'];
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { scopes, tenant: { yearStyle: 'BE' } } }),
}));
const GET = vi.fn();
vi.mock('../../api', () => ({
  api: { GET: (...a: unknown[]) => GET(...a) },
  unwrap: async (p: Promise<{ data: unknown }>) => (await p).data,
}));
const exportList = vi.fn();
vi.mock('../exports/exportJob', () => ({
  exportList: (...a: unknown[]) => exportList(...a),
  ExportQueued: class extends Error {},
  ExportFailed: class extends Error {},
}));

const { ReportPage } = await import('./ReportPage');

const B = (amts: string[], counts = [1, 0, 1, 0, 1]) =>
  (['NOT_DUE', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'DAYS_OVER_90'] as const).map(
    (bucket, i) => ({
      bucket,
      count: counts[i]!,
      ...(amts.length ? { sellOutstanding: amts[i]! } : {}),
    }),
  );
const cust = (
  id: string,
  legalName: string,
  total: string | undefined,
  amts: string[],
  count = 3,
) => ({
  customer: { id, code: id, legalName, taxId: null, branchCode: null },
  count,
  ...(total !== undefined ? { sellOutstanding: total } : {}),
  buckets: B(amts),
});
const AGING = {
  asOf: '2026-11-22',
  basis: 'DUE_DATE',
  count: 6,
  sellOutstanding: '1350.49',
  buckets: B(['1000.00', '0.00', '250.50', '0.00', '99.99']),
  data: [
    cust('cus_a', 'ก ลูกค้าเล็ก', '100.00', ['100.00', '0.00', '0.00', '0.00', '0.00']),
    cust('cus_b', 'ข ลูกค้าใหญ่', '1250.49', ['900.00', '0.00', '250.50', '0.00', '99.99']),
  ],
  nextCursor: null,
  hasMore: false,
};
const UNBILLED = {
  asOf: '2026-11-22',
  minDays: 7,
  deliveredOnOrBefore: '2026-11-14',
  count: 1,
  sellAmount: '1750.00',
  data: [
    {
      id: 'do_1',
      doNo: 'DO-2611-0001',
      doDate: '2026-11-10',
      status: 'POD_PENDING',
      podStatus: 'NONE',
      billingStatus: 'UNBILLED',
      customer: { id: 'cus_a', code: 'C1', legalName: 'ก ลูกค้าเล็ก' },
      salesOrder: { id: 'ord_1', soNo: 'SO-1' },
      deliveredAt: '2026-11-11T03:00:00.000Z',
      deliveredOn: '2026-11-11',
      daysSinceDelivery: 11,
      releasedAt: null,
      sellAmount: '1750.00',
    },
  ],
  nextCursor: null,
  hasMore: false,
};

const wrap = (url = '/reports') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider lang="th">
        <MemoryRouter initialEntries={[url]}>
          <ReportPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('หน้า รายงาน (ST9-T06)', () => {
  beforeEach(() => {
    scopes = ['*'];
    exportList.mockReset().mockResolvedValue(3);
    GET.mockReset().mockImplementation(async (path: string) => ({
      data: path === '/v1/payments/aging' ? AGING : UNBILLED,
    }));
  });

  it('ลูกหนี้คงค้าง: ลูกค้า × 5 ช่วง + รวม เรียงยอดมากไปน้อย · ยอดตรงกับ /payments/aging · 31–60 ขึ้นไปสีแดง · ไม่มียอด = —', async () => {
    wrap();
    expect(await screen.findByText('ข ลูกค้าใหญ่')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'ลูกหนี้คงค้าง' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual([
      'ลูกค้า',
      'ยังไม่ครบกำหนด',
      '1–30 วัน',
      '31–60 วัน',
      '61–90 วัน',
      'เกิน 90 วัน',
      'รวม',
    ]);
    const rows = screen.getAllByRole('row').slice(1);
    expect(
      within(rows[0]!)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['ข ลูกค้าใหญ่', '900.00', '—', '250.50', '—', '99.99', '1,250.49']);
    expect(within(rows[0]!).getByText('250.50')).toHaveStyle({ color: '#B3322A' });
    expect(within(rows[0]!).getByText('900.00')).toHaveStyle({ color: '#101418' });
    expect(screen.getByText('ข้อมูล ณ 22 พ.ย. 2569')).toBeInTheDocument();
    // review L8: ชื่อแท็บมี N จากค่าตั้งแม้ยังไม่เปิดแท็บ (ขอรายงาน 1 แถว)
    expect(
      await screen.findByRole('tab', { name: 'DO ยังไม่วางบิลเกิน 7 วัน' }),
    ).toBeInTheDocument();
    expect(GET).toHaveBeenCalledWith('/v1/reports/unbilled-delivery-orders', {
      params: { query: { limit: 1 } },
    });
    expect(GET).toHaveBeenCalledWith('/v1/payments/aging', { params: { query: { limit: 200 } } });
  });

  it('DO ยังไม่วางบิลเกิน N วัน: แท็บตามค่าตั้ง + คอลัมน์ + สถานะไทย · ส่งออก Excel ของแท็บที่เปิด', async () => {
    wrap('/reports?tab=unbilled');
    expect(await screen.findByText('DO-2611-0001')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'DO ยังไม่วางบิลเกิน 7 วัน' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const cells = within(screen.getAllByRole('row')[1]!)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual([
      'DO-2611-0001',
      'ก ลูกค้าเล็ก',
      '10 พ.ย. 2569',
      '11 พ.ย. 2569',
      '11 วัน',
      'รอ POD',
      '1,750.00',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'ส่งออก Excel' }));
    await waitFor(() =>
      expect(exportList).toHaveBeenCalledWith('unbilled-delivery-orders', {}, 'xlsx'),
    );
    expect(await screen.findByText('ส่งออกรายงานเป็น Excel แล้ว')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ตั้งเวลาส่งรายงาน' })).toBeDisabled();
  });

  it('สิทธิ์: ไม่มีราคาขาย = ไม่มีคอลัมน์มูลค่า/ยอดเป็นจำนวนใบ · ไม่มีสิทธิ์รายงานการเงิน = ไม่มีแท็บ DO · ไม่มีทั้งคู่ = หน้ายังไม่เปิดใช้', async () => {
    scopes = ['invoices:read', 'reports.finance:read'];
    GET.mockImplementation(async (path: string) => ({
      data:
        path === '/v1/payments/aging'
          ? { ...AGING, data: [cust('cus_a', 'ก ลูกค้าเล็ก', undefined, [])] }
          : { ...UNBILLED, data: [{ ...UNBILLED.data[0], sellAmount: undefined }] },
    }));
    const { unmount } = wrap();
    expect(await screen.findByText('ก ลูกค้าเล็ก')).toBeInTheDocument();
    expect(screen.getAllByText('1 ใบ').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: /DO ยังไม่วางบิล/ }));
    expect(await screen.findByText('DO-2611-0001')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'มูลค่า' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ส่งออก Excel' })).toBeDisabled();
    unmount();

    scopes = ['invoices:read'];
    const r2 = wrap('/reports?tab=unbilled');
    expect(await screen.findByText('ก ลูกค้าเล็ก')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    r2.unmount();

    scopes = ['reports.ops:read'];
    wrap();
    expect(screen.getByText('หน้านี้ยังไม่เปิดใช้')).toBeInTheDocument();
  });

  it('ไม่มีข้อมูล = สถานะว่างของต้นแบบ', async () => {
    GET.mockImplementation(async () => ({ data: { ...AGING, data: [] } }));
    wrap();
    expect(await screen.findByText('ยังไม่มีข้อมูลในงวดนี้')).toBeInTheDocument();
    expect(
      screen.getByText('รายงานจะแสดงเมื่อมีเที่ยวที่ส่งแล้วหรือใบแจ้งหนี้ในงวด'),
    ).toBeInTheDocument();
  });

  it('sortAging: ยอดมากก่อน → จำนวนใบ → ชื่อ', () => {
    const r = sortAging([
      cust('a', 'ข', '10.00', []),
      cust('b', 'ก', '10.00', []),
      cust('c', 'ค', '99.00', []),
    ]);
    expect(r.map((x) => x.customer.id)).toEqual(['c', 'b', 'a']);
  });
});
