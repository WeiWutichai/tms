import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import type { PayView } from './carrierPayLinkApi';

/** ST6-T11 หน้า "ค่าเที่ยวของฉัน" ของรถร่วม (ต้นแบบ TMS Subcon แท็บ "การเงิน") */
const view = (o: Partial<PayView> = {}): PayView => ({
  company: 'ศรีไทยขนส่ง',
  carrierName: 'หจก. ศรีราชาโลจิสติกส์',
  paymentTermDays: 15,
  dueAmount: '38258.40',
  dueCount: 2,
  settlements: [
    {
      id: 'stl_a',
      settlementNo: 'SA-S2611-0010',
      status: 'APPROVED',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-15',
      tripCount: 4,
      amount: '22846.40',
      estimate: false,
      paidDate: null,
    },
    {
      id: 'stl_b',
      settlementNo: null,
      status: 'SENT_TO_CARRIER',
      periodFrom: '2026-10-16',
      periodTo: '2026-10-31',
      tripCount: 3,
      amount: '15412.00',
      estimate: true,
      paidDate: null,
    },
    {
      id: 'stl_c',
      settlementNo: 'SA-S2611-0007',
      status: 'PAID',
      periodFrom: '2026-09-16',
      periodTo: '2026-09-30',
      tripCount: 5,
      amount: '28412.00',
      estimate: false,
      paidDate: '2026-10-10',
    },
  ],
  trips: [
    {
      tripNo: 'TRP-6911-0021',
      tripDate: '2026-11-18',
      origin: 'บางปู',
      destination: 'แหลมฉบัง',
      amount: '5600.00',
    },
  ],
  expiresAt: '2026-12-22T03:00:00.000Z',
  ...o,
});
const q: { data: PayView | undefined; error: unknown; isError: boolean; isLoading: boolean } = {
  data: undefined,
  error: null,
  isError: false,
  isLoading: false,
};
vi.mock('./carrierPayLinkApi', async (orig) => ({
  ...(await orig<typeof import('./carrierPayLinkApi')>()),
  usePayView: () => ({ ...q, refetch: vi.fn() }),
}));
const { CarrierPayLinkPage, periodText } = await import('./CarrierPayLink');

const show = () =>
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/link/carrier-pay/ml1.x']}>
        <Routes>
          <Route path="/link/carrier-pay/:token" element={<CarrierPayLinkPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );

describe('CarrierPayLinkPage (ST6-T11)', () => {
  beforeEach(() => {
    Object.assign(q, { data: view(), error: null, isError: false, isLoading: false });
  });

  it('ต้นแบบ: หัวพอร์ทัล · รอรับเงิน (ยอด + n งวด · จ่ายภายใน N วันหลังอนุมัติ) · การ์ดงวด (เลข · ป้าย · งวด · n เที่ยว · ยอด)', () => {
    show();
    expect(screen.getByText('ศรีไทยขนส่ง · พอร์ทัลรถร่วม')).toBeTruthy();
    expect(
      screen.getByText('หจก. ศรีราชาโลจิสติกส์ · เปิดจากลิงก์ LINE ไม่ต้องเข้าสู่ระบบ'),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'การเงิน' })).toBeTruthy();
    const due = screen.getByTestId('cpl-due');
    expect(due.textContent).toContain('รอรับเงิน');
    expect(due.textContent).toContain('38,258.40');
    expect(due.textContent).toContain('2 งวด · จ่ายภายใน 15 วันหลังอนุมัติ');
    const a = screen.getByTestId('cpl-stl-stl_a');
    expect(a.textContent).toContain('SA-S2611-0010');
    expect(a.textContent).toContain('อนุมัติแล้ว · รอจ่าย');
    expect(a.textContent).toContain('1–15 ต.ค. 2569 · 4 เที่ยว');
    expect(a.textContent).toContain('22,846.40');
    const b = screen.getByTestId('cpl-stl-stl_b');
    expect(b.textContent).toContain('รอออกเลขเมื่ออนุมัติ');
    expect(b.textContent).toContain('รอตรวจ');
    expect(screen.getByTestId('cpl-stls').textContent).toContain(
      'ยอดหลังหัก ณ ที่จ่าย · งวดที่รอตรวจเป็นยอดประมาณการ',
    );
  });

  it('review L4: ยอดงวดคำนวณไม่ได้ (null) → "—"', () => {
    q.data = view({
      settlements: [{ ...view().settlements[1]!, amount: null }],
    });
    show();
    expect(
      screen.getByTestId('cpl-stl-stl_b').querySelector('[data-testid="cpl-amt"]')!.textContent,
    ).toBe('—');
  });

  it('สถานะจ่าย: งวดจ่ายแล้วมีปุ่ม "ใบจ่ายเงิน" (PDF ของลิงก์นี้) เท่านั้น — ไม่มี 50 ทวิ (D-54)', () => {
    show();
    const links = screen.getAllByTestId('cpl-pdf');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe(
      '/v1/public/carrier-pay/ml1.x/settlements/stl_c/pdf',
    );
    expect(screen.getByTestId('cpl-stl-stl_c').textContent).toContain('จ่ายแล้ว');
    expect(screen.queryByText(/50 ทวิ/)).toBeNull();
  });

  it('เที่ยวที่จบ · ยังไม่เข้างวด: เลขเที่ยว · ยอด · วันที่ · เส้นทาง', () => {
    show();
    expect(screen.getByText('เที่ยวที่จบ · ยังไม่เข้างวด')).toBeTruthy();
    // review M1: ยอดเที่ยวระบุว่าเป็นก่อนหัก ณ ที่จ่าย (หมายเหตุหลังหักอยู่ในกลุ่มงวด ไม่ใช่กลุ่มเที่ยว)
    const sec = screen.getByTestId('cpl-trips');
    expect(sec.textContent).toContain('ค่าจ้างก่อนหัก ณ ที่จ่าย');
    expect(sec.textContent).not.toContain('ยอดหลังหัก');
    const row = screen.getByTestId('cpl-trip');
    expect(row.textContent).toContain('TRP-6911-0021');
    expect(row.textContent).toContain('5,600.00');
    expect(row.textContent).toContain('18 พ.ย. 2569 · บางปู → แหลมฉบัง');
  });

  it('ว่าง: ไม่มีงวดและเที่ยว → สถานะว่าง · ไม่มีหมายเหตุ/หัวข้อเที่ยว', () => {
    q.data = view({ settlements: [], trips: [], dueAmount: '0.00', dueCount: 0 });
    show();
    expect(screen.getByText('ยังไม่มีค่าเที่ยว')).toBeTruthy();
    expect(screen.queryByText('เที่ยวที่จบ · ยังไม่เข้างวด')).toBeNull();
    expect(screen.queryByText(/ยอดหลังหัก ณ ที่จ่าย/)).toBeNull();
  });

  it('ลิงก์หมดอายุ/เพิกถอน (404) → ลิงก์นี้ใช้ไม่ได้ · error อื่น → ลองอีกครั้ง', () => {
    Object.assign(q, {
      data: undefined,
      isError: true,
      error: new ApiError({
        type: 'about:blank',
        title: 'nf',
        status: 404,
        code: 'not_found',
      } as never),
    });
    const v = show();
    expect(screen.getByText('ลิงก์นี้ใช้ไม่ได้')).toBeTruthy();
    v.unmount();
    Object.assign(q, { error: new Error('net') });
    show();
    expect(screen.getByRole('button', { name: 'ลองอีกครั้ง' })).toBeTruthy();
  });

  it('periodText: เดือนเดียวกันย่อแบบต้นแบบ · ข้ามเดือน · ข้ามปี', () => {
    expect(periodText('2026-10-01', '2026-10-15')).toBe('1–15 ต.ค. 2569');
    expect(periodText('2026-09-16', '2026-10-15')).toBe('16 ก.ย. – 15 ต.ค. 2569');
    expect(periodText('2026-12-16', '2027-01-15')).toBe('16 ธ.ค. 2569 – 15 ม.ค. 2570');
  });
});
