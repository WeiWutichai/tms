import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { margin, parseCost, plainNum, reasonRequired } from './subconHire';
import type { HireOptions, TripDetail } from './useTrips';

/** ST3-T22 drawer จ่ายงานรถร่วม: ตัวเลือก + ราคา 5 ครั้ง + ถูกสุด + เหตุผลเมื่อไม่ใช่ถูกสุด + ใบสั่งงาน */
const opts: { data: HireOptions | undefined; isError: boolean; refetch: () => void } = {
  data: undefined,
  isError: false,
  refetch: vi.fn(),
};
const hireMutate = vi.fn();
vi.mock('./useTrips', () => ({
  useHireOptions: () => opts,
  useHireTrip: () => ({ mutate: hireMutate, isPending: false }),
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({
    data: { tenant: { yearStyle: 'BE', name: 'ศรีไทยขนส่ง' }, user: { name: 'พรทิพย์ ศรีวงศ์' } },
  }),
}));
const { SubconHireDrawer } = await import('./SubconHireDrawer');

const carrier = (id: string, name: string, pod = true) => ({
  id,
  code: id.toUpperCase(),
  name,
  whtRateDefault: '1.00',
  paymentTermDays: 15,
  requirePodToPay: pod,
});
const OPTS = {
  tripId: 'trp_1',
  tripNo: 'TRP-6911-0001',
  origin: { id: 'loc_a', code: 'L1', name: 'คลังบางนา' },
  destination: { id: 'loc_b', code: 'L2', name: 'ร้านชลบุรี' },
  vehicleTypeId: 'vty_6',
  vehicleTypeName: '6 ล้อ',
  sellAmount: '6000.00',
  buyCheapestAmount: '4800.50',
  options: [
    {
      carrier: carrier('car_b', 'หจก. บี'),
      pricingStatus: 'AVAILABLE',
      buyRateAmount: '4800.50',
      rateCardCode: 'RC-B-0002',
      pricingReasons: [],
      vatType: 'EXEMPT_TRANSPORT',
      whtRate: '1.00',
      cheapest: true,
      blockedReason: null,
      buyRecentAmounts: ['4700.00', '5200.00'],
    },
    {
      carrier: carrier('car_a', 'หจก. เอ', false),
      pricingStatus: 'AVAILABLE',
      buyRateAmount: '5200.00',
      rateCardCode: 'RC-B-0001',
      pricingReasons: [],
      vatType: 'EXEMPT_TRANSPORT',
      whtRate: '1.00',
      cheapest: false,
      blockedReason: null,
      buyRecentAmounts: [],
    },
    {
      carrier: carrier('car_c', 'หจก. ซี'),
      pricingStatus: 'RATE_MISSING',
      buyRateAmount: null,
      rateCardCode: null,
      pricingReasons: ['ไม่มี rate card'],
      vatType: null,
      whtRate: null,
      cheapest: false,
      blockedReason: null,
      buyRecentAmounts: [],
    },
  ],
} as unknown as HireOptions;

const TRIP = {
  id: 'trp_1',
  tripNo: 'TRP-6911-0001',
  tripDate: '2026-11-17',
  status: 'PLANNING',
  version: 4,
  carrier: null,
  stops: [{ id: 's1', plannedArrival: '2026-11-17T00:00:00.000Z', windowStart: null }],
  deliveryOrders: [{ id: 'do_1' }],
  route: { distanceKm: '82.4', minutes: 95, missingLegs: 0, estimated: false },
} as unknown as TripDetail;

const onDone = vi.fn();
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider lang="th">
        <SubconHireDrawer trip={TRIP} onDone={onDone} onClose={() => {}} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('subconHire helpers', () => {
  it('ราคา: คอมมาได้ ≤ 2 ตำแหน่ง > 0 · ถูกสุด ≤ ต่ำสุด · ไม่มีให้เทียบ = ต้องมีเหตุผล · กำไร/%', () => {
    expect(parseCost('4,800.5')).toBe('4800.50');
    expect(parseCost('0')).toBeNull();
    expect(parseCost('1.234')).toBeNull();
    expect(reasonRequired('4800.50', '4800.50')).toBe(false);
    expect(reasonRequired('4800.51', '4800.50')).toBe(true);
    expect(reasonRequired('1', null)).toBe(true);
    expect(reasonRequired(null, '1')).toBe(false);
    expect(margin('6000.00', '4800.50')).toEqual({
      profit: '1199.50',
      pct: '20.0',
      negative: false,
    });
    expect(margin('5000.00', '5200.00')).toEqual({
      profit: '-200.00',
      pct: '-4.0',
      negative: true,
    });
    expect(margin(undefined, '1.00')).toBeNull();
    expect(plainNum('5200.00')).toBe('5,200');
    expect(plainNum('5300.50')).toBe('5,300.5');
  });
});

describe('SubconHireDrawer (ST3-T22)', () => {
  beforeEach(() => {
    opts.data = OPTS;
    opts.isError = false;
    hireMutate.mockReset();
    onDone.mockReset();
  });

  it('ค่าเริ่มต้น = รายถูกสุด ราคาตาม rate card · ราคา 5 ครั้งล่าสุด · กำไร · ส่งข้อเสนอโดยไม่ต้องมีเหตุผล', () => {
    show();
    expect(screen.getByText('จ่ายงานรถร่วม')).toBeTruthy();
    const sel = screen.getByRole('combobox', { name: 'ผู้รับเหมา' }) as HTMLSelectElement;
    expect(sel.value).toBe('car_b');
    expect(screen.getByRole('option', { name: 'หจก. บี · ฿4,800.50 · ถูกสุด' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'หจก. ซี · ไม่มี rate card' })).toBeTruthy();
    expect(screen.getByTestId('sub-last').textContent).toBe('4,700.00 · 5,200.00');
    expect((screen.getByDisplayValue('4,800.50') as HTMLInputElement).value).toBe('4,800.50');
    expect(screen.getByText('ราคาตั้งต้นจาก rate card ขาซื้อของ หจก. บี')).toBeTruthy();
    expect(screen.getAllByText('1,199.50').length).toBeGreaterThan(0);
    expect(screen.queryByText('เหตุผลที่เลือกรายนี้')).toBeNull();
    hireMutate.mockImplementationOnce((_v, o: { onSuccess: () => void }) => o.onSuccess());
    fireEvent.click(screen.getByRole('button', { name: 'ส่งข้อเสนอ' }));
    expect(hireMutate).toHaveBeenCalledWith(
      {
        id: 'trp_1',
        version: 4,
        body: { carrierId: 'car_b', cost: '4800.50', vehicleTypeId: 'vty_6' },
      },
      expect.anything(),
    );
    expect(onDone).toHaveBeenCalledWith('เสนองานให้ หจก. บี แล้ว · รอรถร่วมตอบรับ');
  });

  it('เกณฑ์ตรวจรับ: เลือกรายที่ไม่ใช่ถูกสุด → ช่องเหตุผล + กันส่งเมื่อเหตุผลสั้น · ใส่แล้วส่งพร้อม selectionReason', () => {
    show();
    fireEvent.change(screen.getByRole('combobox', { name: 'ผู้รับเหมา' }), {
      target: { value: 'car_a' },
    });
    expect(screen.getByTestId('sub-reason-hint').textContent).toBe(
      'ไม่ใช่ราคาถูกสุด (ถูกสุด ฿4,800.50 · หจก. บี) — ระบุเหตุผลอย่างน้อย 10 ตัวอักษร',
    );
    fireEvent.click(screen.getByRole('button', { name: 'ส่งข้อเสนอ' }));
    expect(hireMutate).not.toHaveBeenCalled();
    expect(screen.getByText('ระบุเหตุผลอย่างน้อย 10 ตัวอักษร')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('เช่น รายที่ถูกกว่ารถไม่ว่างช่วงเช้า'), {
      target: { value: 'รายที่ถูกกว่ารถไม่ว่างช่วงเช้า' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ส่งข้อเสนอ' }));
    expect(hireMutate.mock.calls[0]![0].body).toEqual({
      carrierId: 'car_a',
      cost: '5200.00',
      selectionReason: 'รายที่ถูกกว่ารถไม่ว่างช่วงเช้า',
      vehicleTypeId: 'vty_6',
    });
  });

  it('รายไม่มี rate card → กรอกราคาเอง · ราคาไม่ถูกต้องกันส่ง · ราคาเองต่ำกว่าถูกสุดไม่ต้องมีเหตุผล', () => {
    show();
    fireEvent.change(screen.getByRole('combobox', { name: 'ผู้รับเหมา' }), {
      target: { value: 'car_c' },
    });
    expect(
      screen.getByText('ไม่มี rate card ขาซื้อของ หจก. ซี สำหรับงานนี้ — กรอกราคาที่ตกลงเอง'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ส่งข้อเสนอ' }));
    expect(screen.getByText('กรอกราคาซื้อมากกว่า 0 (ทศนิยมไม่เกิน 2 ตำแหน่ง)')).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'ราคาซื้อ (฿ ต่อเที่ยว)' });
    fireEvent.change(input, { target: { value: '4500' } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('4,500.00');
    expect(screen.queryByText('เหตุผลที่เลือกรายนี้')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ส่งข้อเสนอ' }));
    expect(hireMutate.mock.calls[0]![0].body).toMatchObject({
      carrierId: 'car_c',
      cost: '4500.00',
    });
  });

  it('แท็บใบสั่งงาน: เลขงาน เส้นทาง วันรับ ราคาจ้าง (ไม่รวม VAT) เงื่อนไขหัก ณ ที่จ่าย/จ่าย ผู้ติดต่อ — ไม่มีราคาขาย', () => {
    show();
    fireEvent.click(screen.getByRole('tab', { name: 'ใบสั่งงาน' }));
    const wo = screen.getByTestId('sub-wo');
    expect(wo.textContent).toContain('ใบสั่งงานรถร่วม · ศรีไทยขนส่ง');
    expect(wo.textContent).toContain('TRP-6911-0001');
    expect(wo.textContent).toContain('คลังบางนา → ร้านชลบุรี (82.4 กม.)');
    expect(wo.textContent).toContain('07:00');
    expect(wo.textContent).toContain('฿4,800.50 (ไม่รวม VAT)');
    expect(wo.textContent).toContain('หัก ณ ที่จ่าย 1% · จ่ายภายใน 15 วันหลังส่ง POD');
    expect(wo.textContent).toContain('พรทิพย์ ศรีวงศ์');
    expect(wo.textContent).not.toContain('6,000');
  });

  it('QA: แก้ราคา → คำใบ้ "ราคาที่กรอกเอง" + ใบสั่งงานไม่แสดงหัก ณ ที่จ่าย (ธงว่าง #58) · รายติดกฎ → เตือน + ต้องมีเหตุผล', () => {
    opts.data = {
      ...OPTS,
      options: [
        ...OPTS.options,
        {
          ...OPTS.options[0]!,
          carrier: carrier('car_e', 'หจก. อี'),
          buyRateAmount: '4000.00',
          cheapest: false,
          blockedReason: 'ยังไม่มีรถ6 ล้อที่ลงทะเบียน',
        },
      ],
    } as HireOptions;
    show();
    const input = screen.getByRole('textbox', { name: 'ราคาซื้อ (฿ ต่อเที่ยว)' });
    fireEvent.change(input, { target: { value: '4700' } });
    expect(screen.getByText('ราคาที่กรอกเอง (rate card ฿4,800.50)')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'ใบสั่งงาน' }));
    const wo = screen.getByTestId('sub-wo');
    expect(wo.textContent).not.toContain('หัก ณ ที่จ่าย');
    expect(wo.textContent).toContain('จ่ายภายใน 15 วันหลังส่ง POD');
    fireEvent.click(screen.getByRole('tab', { name: 'ส่งข้อเสนอ' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'ผู้รับเหมา' }), {
      target: { value: 'car_e' },
    });
    expect(screen.getByRole('option', { name: 'หจก. อี · ฿4,000.00 · ติดกฎ' })).toBeTruthy();
    expect(screen.getByTestId('sub-blocked').textContent).toContain('ยังไม่มีรถ');
    expect(screen.getByTestId('sub-reason-hint').textContent).toContain('ติดกฎ');
  });

  it('ไม่มีผู้รับเหมา → empty state · โหลดไม่สำเร็จ → error', () => {
    opts.data = { ...OPTS, options: [] } as HireOptions;
    const r = show();
    expect(screen.getByText('ยังไม่มีผู้รับเหมาที่ใช้งานอยู่')).toBeTruthy();
    r.unmount();
    opts.data = undefined;
    opts.isError = true;
    show();
    expect(screen.getByText('โหลดข้อมูลจ้างรถร่วมไม่สำเร็จ')).toBeTruthy();
  });
});

describe('SubconHireDrawer — ส่งรายถัดไป (ST3-T24)', () => {
  beforeEach(() => {
    hireMutate.mockReset();
    opts.isError = false;
    // บี (ถูกสุดเดิม) ไม่ตอบรับ → API เรียงไว้หลังรายที่ยังไม่เคยไม่รับ · ถูกสุด = เอ
    const [b, a, c] = OPTS.options;
    opts.data = {
      ...OPTS,
      buyCheapestAmount: '5200.00',
      options: [
        { ...a!, cheapest: true, priorOutcome: null },
        { ...c!, priorOutcome: null },
        { ...b!, cheapest: false, priorOutcome: 'NO_RESPONSE' },
      ],
    } as unknown as HireOptions;
  });

  it('replace: ค่าเริ่มต้น = รายถัดไปที่ถูกสุด · ป้าย "ไม่ตอบรับ" · คำเตือนยกเลิกข้อเสนอเดิม · ส่ง replaceOffer', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider lang="th">
          <SubconHireDrawer
            trip={
              {
                ...TRIP,
                status: 'OFFERED',
                carrier: { id: 'car_b', name: 'หจก. บี' },
              } as unknown as TripDetail
            }
            onDone={onDone}
            onClose={() => {}}
            replace
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    const sel = screen.getByRole('combobox', { name: 'ผู้รับเหมา' }) as HTMLSelectElement;
    expect(sel.value).toBe('car_a');
    expect(screen.getByRole('option', { name: 'หจก. บี · ฿4,800.50 · ไม่ตอบรับ' })).toBeTruthy();
    expect(screen.getByTestId('sub-replace').textContent).toBe(
      'เมื่อส่งข้อเสนอ ข้อเสนอที่ส่งให้ หจก. บี จะถูกยกเลิก (ลิงก์เดิมใช้ไม่ได้)',
    );
    expect(screen.getByText('รอตอบ')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ส่งข้อเสนอ' }));
    expect(hireMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ carrierId: 'car_a', replaceOffer: true }),
      }),
      expect.anything(),
    );
  });

  it('เลือกรายที่ไม่ตอบรับมาแล้ว → ต้องมีเหตุผล (คำใบ้เฉพาะ)', () => {
    show();
    fireEvent.change(screen.getByRole('combobox', { name: 'ผู้รับเหมา' }), {
      target: { value: 'car_b' },
    });
    expect(screen.getByTestId('sub-reason-hint').textContent).toBe(
      'รายนี้ไม่รับงานเที่ยวนี้มาแล้ว — ระบุเหตุผลอย่างน้อย 10 ตัวอักษร',
    );
    fireEvent.click(screen.getByRole('button', { name: 'ส่งข้อเสนอ' }));
    expect(hireMutate).not.toHaveBeenCalled();
    expect(
      (hireMutate.mock.calls[0]?.[0] as { body?: { replaceOffer?: boolean } })?.body?.replaceOffer,
    ).toBeUndefined();
  });
});

describe('SubconHireDrawer — เปลี่ยนผู้รับเหมา (ST3-T25)', () => {
  beforeEach(() => {
    hireMutate.mockReset();
    onDone.mockReset();
    opts.isError = false;
    // ตัวเลือกแบบ change=true: API ตัดรายเดิม (บี) ออกแล้ว · ถูกสุด = เอ
    const [, a, c] = OPTS.options;
    opts.data = {
      ...OPTS,
      buyCheapestAmount: '5200.00',
      options: [{ ...a!, cheapest: true }, { ...c! }],
    } as unknown as HireOptions;
  });

  it('รับงานแล้ว: ป้าย "รับงาน" · คำเตือนยกเลิกการจ้างเดิม · ส่ง changeReason (ไม่ส่ง replaceOffer) · toast เปลี่ยนผู้รับเหมา', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider lang="th">
          <SubconHireDrawer
            trip={
              {
                ...TRIP,
                status: 'ASSIGNED',
                carrier: { id: 'car_b', name: 'หจก. บี' },
                hire: { id: 'sco_1', carrierId: 'car_b', status: 'ACCEPTED' },
              } as unknown as TripDetail
            }
            onDone={onDone}
            onClose={() => {}}
            change="รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า"
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('รับงาน')).toBeTruthy();
    expect(screen.queryByRole('option', { name: /หจก\. บี/ })).toBeNull();
    expect(screen.getByTestId('sub-replace').textContent).toBe(
      'เมื่อส่งข้อเสนอ การจ้าง หจก. บี จะถูกยกเลิก (ลิงก์เดิมใช้ไม่ได้ · ค่าจ้างเดิมกลับรายการ)',
    );
    fireEvent.click(screen.getByRole('button', { name: 'ส่งข้อเสนอ' }));
    const call = hireMutate.mock.calls[0]!;
    expect(call[0]).toMatchObject({
      id: 'trp_1',
      version: 4,
      body: {
        carrierId: 'car_a',
        cost: '5200.00',
        changeReason: 'รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า',
      },
    });
    expect((call[0] as { body: { replaceOffer?: boolean } }).body.replaceOffer).toBeUndefined();
    (call[1] as { onSuccess: () => void }).onSuccess();
    expect(onDone).toHaveBeenCalledWith('เปลี่ยนผู้รับเหมาเป็น หจก. เอ แล้ว · รอรถร่วมตอบรับ');
  });
});
