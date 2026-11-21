import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { I18nProvider } from '../../i18n';
import { th } from '../../i18n/th';
import type { Settlement } from './useSettlements';

/** หน้า settle: แท็บ → สถานะ (docs/01 §4.5) · ยอด "หัก" · แถวยอดเงิน · ข้อความ error ของอนุมัติ/บันทึกจ่าย (D-60, step-up, 409, 422) */
const state: { error: unknown; settlement: Settlement | null } = { error: null, settlement: null };
const mutate = vi.fn();
vi.mock('./useSettlements', async (orig) => {
  const real = await orig<typeof import('./useSettlements')>();
  return {
    ...real,
    useSettlement: () => ({ data: state.settlement, refetch: vi.fn() }),
    useMarkPaid: () => ({ mutate, isPending: false, error: state.error }),
    useApproveSettlement: () => ({ mutate, isPending: false, error: state.error }),
  };
});
const { TAB_STATUS, deductTotal, actionErrorText, amountRows, canRelinkStatus, viewOnlyLink } =
  await import('./settle');
const { MarkPaidDialog } = await import('./MarkPaidDialog');
const { ApproveDialog } = await import('./ApproveDialog');

const t = ((k: string, p?: Record<string, unknown>) =>
  String((th as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_, n) =>
    String(p?.[n] ?? ''),
  )) as never;
const problem = (code: string, status: number, errors?: object[]) =>
  new ApiError({ type: '', title: '', status, code, ...(errors ? { errors } : {}) } as never);

const S = {
  id: 'stl_1',
  settlementNo: 'SA-6911-0001',
  status: 'APPROVED',
  version: 3,
  carrier: { id: 'car_1', legalName: 'หจก. ทดสอบขนส่ง' },
  buyGrossAmount: '8000.00',
  buyDeductionAmount: '1500.00',
  buyNetPayable: '6500.00',
  buyWhtAmount: '80.00',
  buyNetAfterWht: '6420.00',
  whtEstimate: { form: 'PND53', byRate: [{ whtRate: '1.00' }] },
  lines: [
    { id: 'l1', active: true, lineType: 'FREIGHT', buyAmount: '8000.00' },
    {
      id: 'l2',
      active: true,
      lineType: 'DEDUCTION',
      deductionType: 'CASH_ADVANCE',
      buyAmount: '-1000.00',
    },
    { id: 'l3', active: true, lineType: 'DEDUCTION', deductionType: 'FINE', buyAmount: '-500.00' },
    { id: 'l4', active: false, lineType: 'DEDUCTION', deductionType: 'FINE', buyAmount: '-99.00' },
  ],
} as unknown as Settlement;

const wrap = (n: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>{n}</I18nProvider>
    </QueryClientProvider>,
  );

describe('settle helpers', () => {
  it('แท็บต้นแบบ → สถานะ docs/01 §4.5 (รอตรวจ = ร่าง + โต้แย้ง · รออนุมัติ = ส่งรถร่วมตรวจแล้ว)', () => {
    expect(TAB_STATUS).toEqual({
      all: '',
      chk: 'DRAFT,DISPUTED',
      appr: 'SENT_TO_CARRIER',
      ok: 'APPROVED',
      paid: 'PAID',
    });
  });
  it('คอลัมน์ "หัก" = หัก ณ ที่จ่าย + รายการหัก (สตางค์ ไม่มีเศษลอย) · ไม่มีสิทธิ์ราคา = ไม่มียอด', () => {
    expect(deductTotal({ buyWhtAmount: '80.10', buyDeductionAmount: '1000.20' })).toBe('1080.30');
    expect(deductTotal({})).toBeUndefined();
  });
  it('D-59/D-63: ออกลิงก์ใหม่ได้เมื่อส่งถึงรถร่วมแล้ว · อนุมัติ/จ่ายแล้ว = ลิงก์ดูอย่างเดียว', () => {
    expect(['DRAFT', 'CANCELLED'].map(canRelinkStatus)).toEqual([false, false]);
    expect(['SENT_TO_CARRIER', 'DISPUTED', 'APPROVED', 'PAID'].every(canRelinkStatus)).toBe(true);
    expect(viewOnlyLink('APPROVED') && viewOnlyLink('PAID') && !viewOnlyLink('DISPUTED')).toBe(
      true,
    );
  });
  it('แถวยอดเงิน: อัตรา WHT ของใบ + รายการหักแยกชนิด (ไม่นับบรรทัดที่นำออก)', () => {
    expect(amountRows(t, S).map((r) => [r.k, r.v, r.strong])).toEqual([
      ['ยอดซื้อรวม', '8,000.00', true],
      ['หัก ณ ที่จ่าย 1%', '−80.00', true],
      ['หักเงินเบิกล่วงหน้า', '−1,000.00', false],
      ['หักค่าปรับ', '−500.00', false],
    ]);
  });
  it('error เป็นข้อความไทย: D-60 · สถานะเปลี่ยน · ข้อมูลช่อง (วันที่ก่อนอนุมัติ / เลขอ้างอิง)', () => {
    expect(actionErrorText(problem('settlement_self_payment', 403), t)).toBe(
      th['problem.settlement_self_payment'],
    );
    expect(actionErrorText(problem('invalid_state_transition', 409), t)).toBe(
      th['problem.invalid_state_transition'],
    );
    expect(
      actionErrorText(
        problem('validation_failed', 422, [
          { field: 'paidDate', code: 'before_approval', message: 'x' },
          { field: 'reference', code: 'required', message: 'x' },
        ]),
        t,
      ),
    ).toBe(`${th['field.before_approval']} · ${th['field.required']}`);
  });
});

describe('dialog บันทึกจ่าย / อนุมัติ', () => {
  it('บันทึกจ่าย: ยอดตามต้นแบบ (จ่ายสุทธิ) · ส่งวิธี/วันที่/เลขอ้างอิง + If-Match version · D-60 แสดงข้อความไทย', () => {
    state.settlement = S;
    state.error = problem('settlement_self_payment', 403);
    mutate.mockReset();
    wrap(<MarkPaidDialog id="stl_1" onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText('จ่ายสุทธิ')).toBeTruthy();
    expect(screen.getByText('฿6,420.00')).toBeTruthy();
    expect(screen.queryByText(/50 ทวิ/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(th['problem.settlement_self_payment']);
    fireEvent.change(screen.getByPlaceholderText('เช่น KBANK-2611-0091'), {
      target: { value: ' KBANK-1 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกจ่าย' }));
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      id: 'stl_1',
      version: 3,
      body: { method: 'TRANSFER', reference: 'KBANK-1' },
    });
  });

  it('อนุมัติ: เกินวงเงิน (step_up_required) → กล่องยืนยัน 2FA แทนข้อความ error · error อื่นเป็นข้อความไทย', () => {
    state.error = problem('step_up_required', 403);
    mutate.mockReset();
    mutate.mockImplementation((_v, o: { onError: (e: unknown) => void }) => o.onError(state.error));
    wrap(<ApproveDialog s={S} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText('อนุมัติ SA-6911-0001')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'ตรวจยอดตรงใบแจ้งหนี้แล้ว' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'อนุมัติ' }));
    expect(mutate.mock.calls[0]![0]).toMatchObject({ id: 'stl_1', version: 3 });
    expect(screen.getByRole('group', { name: th['stepUp.title'] })).toBeTruthy();
    expect(screen.queryByText(th['problem.step_up_required'])).toBeNull();
  });

  it('อนุมัติ: ผู้เตรียมใบอนุมัติเอง → ข้อความไทยของ settlement_self_approval', () => {
    state.error = problem('settlement_self_approval', 403);
    wrap(<ApproveDialog s={S} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText(th['problem.settlement_self_approval'])).toBeTruthy();
  });
});
