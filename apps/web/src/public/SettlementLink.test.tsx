import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import type { ReviewLine, ReviewView } from './settlementLinkApi';

/** ST6-T05 หน้ารถร่วมตรวจใบสำคัญจ่าย (ต้นแบบ TMS Subcon แท็บ "การเงิน" + ส่วนที่ต้นแบบไม่มี — spec/12 §3) */
const line = (o: Partial<ReviewLine>): ReviewLine => ({
  id: 'stln_1',
  lineNo: 1,
  lineType: 'FREIGHT',
  tripNo: 'TRP-6911-0004',
  tripDate: '2026-11-18',
  origin: 'บางปู',
  destination: 'แหลมฉบัง',
  description: 'ค่าจ้างรถร่วม',
  deductionType: null,
  reference: null,
  amount: '4500.00',
  review: null,
  resolution: null,
  canRespond: true,
  ...o,
});
const view = (o: Partial<ReviewView> = {}): ReviewView => ({
  company: 'ศรีไทยขนส่ง',
  carrierName: 'หจก. ศรีราชาโลจิสติกส์',
  status: 'SENT_TO_CARRIER',
  settlementNo: null,
  periodFrom: '2026-11-01',
  periodTo: '2026-11-15',
  carrierInvoiceNo: 'INV-SUB-0042',
  tripCount: 2,
  grossAmount: '9000.00',
  deductionAmount: '2000.00',
  netAmount: '7000.00',
  canRespond: true,
  expiresAt: '2026-11-27T03:00:00.000Z',
  lines: [
    line({}),
    line({
      id: 'stln_2',
      lineNo: 2,
      tripNo: 'TRP-6911-0005',
      review: {
        response: 'DISPUTED',
        reason: 'ค่ารอไม่ตรง',
        photoCount: 1,
        claimedAmount: null,
        respondedAt: '2026-11-20T03:00:00.000Z',
      },
    }),
    line({
      id: 'stln_3',
      lineNo: 3,
      lineType: 'DEDUCTION',
      tripNo: null,
      tripDate: null,
      origin: null,
      destination: null,
      deductionType: 'CASH_ADVANCE',
      description: 'เบิกค่าน้ำมัน',
      reference: 'ADV-0007',
      amount: '-2000.00',
    }),
  ],
  ...o,
});
const q: { data: ReviewView | undefined; error: unknown; isError: boolean; isLoading: boolean } = {
  data: undefined,
  error: null,
  isError: false,
  isLoading: false,
};
const mutate = vi.fn();
vi.mock('./settlementLinkApi', async (orig) => ({
  ...(await orig<typeof import('./settlementLinkApi')>()),
  useReviewView: () => ({ ...q, refetch: vi.fn() }),
  useRespond: () => ({ mutate, isPending: false }),
}));
const { SettlementLinkPage } = await import('./SettlementLink');

const show = () =>
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/link/settlement/ml1.x']}>
        <Routes>
          <Route path="/link/settlement/:token" element={<SettlementLinkPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );

describe('SettlementLinkPage (ST6-T05)', () => {
  beforeEach(() => {
    mutate.mockReset();
    Object.assign(q, { data: view(), error: null, isError: false, isLoading: false });
  });

  it('สรุปใบ (งวด ยอดรวม หัก สุทธิ) + รายการเที่ยว/หัก พร้อมป้ายสถานะ และเหตุผลที่โต้แย้ง', () => {
    show();
    expect(screen.getByText('ศรีไทยขนส่ง · พอร์ทัลรถร่วม')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'การเงิน' })).toBeTruthy();
    expect(screen.getByTestId('stl-status').textContent).toBe('รอตรวจ');
    expect(screen.getByText('รอออกเลขเมื่ออนุมัติ')).toBeTruthy();
    expect(screen.getByTestId('stl-net').textContent).toBe('7,000.00');
    expect(screen.getByText('INV-SUB-0042')).toBeTruthy();
    const l1 = screen.getByTestId('stl-line-1');
    expect(l1.textContent).toContain('TRP-6911-0004');
    expect(l1.textContent).toContain('บางปู → แหลมฉบัง');
    expect(l1.textContent).toContain('4,500.00');
    expect(l1.textContent).toContain('รอตรวจ');
    const l2 = screen.getByTestId('stl-line-2');
    expect(l2.textContent).toContain('โต้แย้ง');
    expect(l2.textContent).toContain('ค่ารอไม่ตรง · แนบรูป 1 รูป');
    const l3 = screen.getByTestId('stl-line-3');
    expect(l3.textContent).toContain('เงินเบิกล่วงหน้า');
    expect(l3.textContent).toContain('อ้างอิง ADV-0007');
    expect(l3.textContent).toContain('-2,000.00');
    expect(screen.getByText('รายการหัก')).toBeTruthy();
  });

  it('ยอมรับ → ส่ง ACCEPTED · โต้แย้งไม่มีเหตุผล/รูป → แจ้งเตือนไม่ส่ง · มีเหตุผล → ส่ง DISPUTED', () => {
    show();
    fireEvent.click(screen.getByTestId('stl-accept-1'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toEqual({
      lineId: 'stln_1',
      body: { response: 'ACCEPTED' },
    });
    mutate.mock.calls[0]![1].onSettled();
    fireEvent.click(screen.getByTestId('stl-dispute-1'));
    fireEvent.click(screen.getByTestId('stl-dispute-ok'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe('กรอกเหตุผลหรือแนบรูปอย่างน้อย 1 รูป');
    fireEvent.change(screen.getByTestId('stl-why'), { target: { value: 'ค่ารอไม่ตรง รอ 3 ชม.' } });
    fireEvent.click(screen.getByTestId('stl-dispute-ok'));
    expect(mutate.mock.calls[1]![0]).toEqual({
      lineId: 'stln_1',
      body: { response: 'DISPUTED', reason: 'ค่ารอไม่ตรง รอ 3 ชม.', photoDocumentIds: [] },
    });
  });

  it('อนุมัติแล้ว: ป้าย "อนุมัติแล้ว · รอจ่าย" + เลขใบ · ไม่มีปุ่มตอบ', () => {
    q.data = view({ status: 'APPROVED', settlementNo: 'SA-2611-0010', canRespond: false });
    show();
    expect(screen.getByTestId('stl-status').textContent).toBe('อนุมัติแล้ว · รอจ่าย');
    expect(screen.getByText('SA-2611-0010')).toBeTruthy();
    expect(screen.queryByTestId('stl-accept-1')).toBeNull();
    expect(screen.getByText('อนุมัติแล้ว · ตอบรายการไม่ได้แล้ว')).toBeTruthy();
  });

  it('ST6-T06: ใบมีรายการโต้แย้ง → ป้ายหัว "มีรายการโต้แย้ง" ยังตอบได้ · บรรทัดที่บริษัทยืนยันยอดเดิม → ป้าย + เหตุผล ไม่มีปุ่มตอบ', () => {
    const base = view();
    q.data = view({
      status: 'DISPUTED',
      lines: [
        base.lines[0]!,
        {
          ...base.lines[1]!,
          resolution: {
            reason: 'ตรวจใบชั่งแล้ว ค่ารอตามสัญญา',
            resolvedAt: '2026-11-20T05:00:00.000Z',
          },
          canRespond: false,
        },
      ],
    });
    show();
    expect(screen.getByTestId('stl-status').textContent).toBe('มีรายการโต้แย้ง');
    expect(screen.getByTestId('stl-accept-1')).toBeTruthy();
    const l2 = screen.getByTestId('stl-line-2');
    expect(l2.textContent).toContain('ยืนยันยอดเดิม');
    expect(screen.getByTestId('stl-resolved-2').textContent).toBe(
      'บริษัทยืนยันยอดเดิม: ตรวจใบชั่งแล้ว ค่ารอตามสัญญา',
    );
    expect(screen.queryByTestId('stl-accept-2')).toBeNull();
    expect(screen.queryByTestId('stl-dispute-2')).toBeNull();
  });

  it('ลิงก์ใช้ไม่ได้ (404) → ข้อความเดียวกับหน้าลิงก์อื่น', () => {
    Object.assign(q, {
      data: undefined,
      isError: true,
      error: new ApiError({ status: 404, code: 'not_found', title: 'x', type: 'x' } as never),
    });
    show();
    expect(screen.getByText('ลิงก์นี้ใช้ไม่ได้')).toBeTruthy();
    expect(screen.getByText('ลิงก์หมดอายุหรือถูกยกเลิกแล้ว ขอลิงก์ใหม่จากผู้ว่าจ้าง')).toBeTruthy();
  });
});
