import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import type { OfferView } from '../features/trips/useTrips';
import { isThaiPhone, timeLeft } from './offerTime';

/** ST3-T23 หน้าลิงก์ข้อเสนองาน (ต้นแบบ TMS Subcon แท็บ "งาน") */
const H = 3600_000;
/** วันเวลาหมดอายุตามเวลาไทย "19 พ.ย. 2569 10:14 น." */
const TH_M = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];
const expAt = () => {
  const d = new Date(Date.parse(q.data!.expiresAt) + 7 * H);
  const hm = d.toISOString().slice(11, 16);
  return `${d.getUTCDate()} ${TH_M[d.getUTCMonth()]} ${d.getUTCFullYear() + 543} ${hm} น.`;
};
const view = (o: Partial<OfferView> = {}): OfferView => ({
  company: 'ศรีไทยขนส่ง',
  carrierName: 'หจก. ศรีราชาโลจิสติกส์',
  status: 'OFFERED',
  tripNo: 'TRP-6911-0004',
  tripDate: '2026-11-18',
  pickupAt: '2026-11-18T00:00:00.000Z',
  origin: 'บางปู',
  destination: 'แหลมฉบัง',
  customerName: 'บจก. เอ็นเอสเอฟ อินดัสทรี',
  vehicleTypeName: '6 ล้อ',
  weightKg: '8600',
  buyAmount: '5600.00',
  terms: { whtRate: '1.00', paymentTermDays: 15, requirePodToPay: true },
  contactName: 'พรทิพย์ ศรีวงศ์',
  expiresAt: new Date(Date.now() + 36 * H + 60_000).toISOString(),
  serverTime: new Date().toISOString(),
  accepted: null,
  rejectReason: null,
  rejectReasons: [
    { code: 'VEHICLE_UNAVAILABLE', label: 'รถไม่ว่างวันที่รับงาน' },
    { code: 'PRICE_TOO_LOW', label: 'ราคาไม่คุ้มต้นทุน' },
    { code: 'NO_VEHICLE_TYPE', label: 'ไม่มีรถประเภทที่ต้องการ' },
    { code: 'ROUTE_INCONVENIENT', label: 'เส้นทางไม่สะดวก' },
  ],
  podUrl: null,
  ...o,
});
const q: { data: OfferView | undefined; error: unknown; isError: boolean; isLoading: boolean } = {
  data: undefined,
  error: null,
  isError: false,
  isLoading: false,
};
const mutate = vi.fn();
vi.mock('../features/trips/useTrips', () => ({
  useOfferView: () => ({ ...q, dataUpdatedAt: Date.now(), refetch: vi.fn() }),
  useRespondOffer: () => ({ mutate, isPending: false }),
}));
const { OfferLinkPage } = await import('./OfferLink');

const show = () =>
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/link/offer/ml1.x']}>
        <Routes>
          <Route path="/link/offer/:token" element={<OfferLinkPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );

describe('OfferLinkPage (ST3-T23)', () => {
  beforeEach(() => {
    mutate.mockReset();
    Object.assign(q, { data: view(), error: null, isError: false, isLoading: false });
  });

  it('ใบสั่งงาน: เลขเที่ยว เส้นทาง แถวข้อมูล ราคาจ้าง แถบหมดอายุ ปุ่มรับงาน/ปฏิเสธ', () => {
    show();
    expect(screen.getByText('ศรีไทยขนส่ง · พอร์ทัลรถร่วม')).toBeTruthy();
    expect(
      screen.getByText('หจก. ศรีราชาโลจิสติกส์ · เปิดจากลิงก์ LINE ไม่ต้องเข้าสู่ระบบ'),
    ).toBeTruthy();
    expect(screen.getByText('TRP-6911-0004')).toBeTruthy();
    expect(screen.getByText('บางปู → แหลมฉบัง')).toBeTruthy();
    expect(screen.getByText('รับสินค้า 18 พ.ย. 2569 เวลา 07:00')).toBeTruthy();
    expect(screen.getByText('8,600 กก.')).toBeTruthy();
    expect(
      screen.getByText('ราคาไม่รวม VAT · หัก ณ ที่จ่าย 1% · จ่ายภายใน 15 วันหลังส่ง POD'),
    ).toBeTruthy();
    expect(screen.getByTestId('ofl-price').textContent).toBe('5,600.00');
    expect(screen.getByTestId('ofl-status').textContent).toBe('รอตอบ');
    expect(screen.getByText(`ลิงก์หมดอายุใน 36 ชม. · ตอบได้ถึง ${expAt()}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'รับงาน' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ปฏิเสธ' })).toBeTruthy();
  });

  it('รับงาน: ต้องกรอกทะเบียน/ชื่อ และเบอร์ที่ถูกต้อง แล้วส่ง', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'รับงาน' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรับงาน' }));
    expect(screen.getByRole('alert').textContent).toBe('กรอกทะเบียนรถและชื่อคนขับ');
    fireEvent.change(screen.getByPlaceholderText('เช่น 74-5521 ชบ.'), {
      target: { value: '74-5521 ชบ.' },
    });
    fireEvent.change(screen.getByPlaceholderText('ชื่อ-นามสกุล'), {
      target: { value: 'สมชาย ใจดี' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรับงาน' }));
    expect(screen.getByRole('alert').textContent).toBe('กรอกเบอร์คนขับให้ถูกต้อง');
    fireEvent.change(screen.getByPlaceholderText('08x-xxx-xxxx'), {
      target: { value: '081-234-5678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรับงาน' }));
    expect(mutate).toHaveBeenCalledWith(
      {
        kind: 'accept',
        body: {
          vehiclePlate: '74-5521 ชบ.',
          driverName: 'สมชาย ใจดี',
          driverPhone: '081-234-5678',
        },
      },
      expect.anything(),
    );
    // ติดกฎ → ข้อความจาก server (PLN-152)
    const cb = mutate.mock.calls[0]![1] as { onError: (e: unknown) => void };
    act(() =>
      cb.onError(
        new ApiError({
          type: '',
          title: '',
          status: 409,
          code: 'assignment_blocked',
          reasons: ['พ.ร.บ. หมดอายุ 1 พ.ย. 2569'],
        } as never),
      ),
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'รถ/คนขับนี้รับงานไม่ได้: พ.ร.บ. หมดอายุ 1 พ.ย. 2569 กรุณาเลือกคันอื่น',
    );
  });

  it('ปฏิเสธ: เลือกเหตุผลก่อน (ปุ่มจาง) แล้วส่งรหัสเหตุผล', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'ปฏิเสธ' }));
    const ok = screen.getByRole('button', { name: 'ยืนยันปฏิเสธ' });
    expect(ok.style.opacity).toBe('0.5');
    fireEvent.click(ok);
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ราคาไม่คุ้มต้นทุน' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันปฏิเสธ' }));
    expect(mutate).toHaveBeenCalledWith(
      { kind: 'reject', body: { reason: 'PRICE_TOO_LOW' } },
      expect.anything(),
    );
  });

  it('สถานะ: รับงานแล้ว / ปฏิเสธแล้ว / หมดเวลา — ไม่มีปุ่มตอบ', () => {
    q.data = view({ status: 'ACCEPTED', accepted: { plate: '74-5521', driverName: 'สมชาย ใจดี' } });
    const r1 = show();
    expect(screen.getByTestId('ofl-accepted').textContent).toContain('รถ 74-5521 · สมชาย ใจดี');
    expect(screen.queryByRole('button', { name: 'รับงาน' })).toBeNull();
    r1.unmount();
    q.data = view({ status: 'REJECTED', rejectReason: 'VEHICLE_UNAVAILABLE' });
    const r2 = show();
    expect(screen.getByTestId('ofl-rejected').textContent).toContain(
      'เหตุผล: รถไม่ว่างวันที่รับงาน · ขอบคุณที่แจ้งกลับ',
    );
    r2.unmount();
    q.data = view({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    show();
    expect(screen.getByTestId('ofl-status').textContent).toBe('หมดเวลา');
    expect(screen.getByTestId('ofl-expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'รับงาน' })).toBeNull();
  });

  it('ลิงก์ใช้ไม่ได้ (404) → หน้าลิงก์ใช้ไม่ได้', () => {
    Object.assign(q, {
      data: undefined,
      isError: true,
      error: new ApiError({ type: '', title: '', status: 404, code: 'not_found' }),
    });
    show();
    expect(screen.getByText('ลิงก์นี้ใช้ไม่ได้')).toBeTruthy();
  });

  it('ทะเบียน/เบอร์ไม่ตรง → ข้อความเดียว · ผู้รับเหมาถูกระงับ → ข้อความไทย', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'รับงาน' }));
    fireEvent.change(screen.getByPlaceholderText('เช่น 74-5521 ชบ.'), {
      target: { value: '74-1' },
    });
    fireEvent.change(screen.getByPlaceholderText('ชื่อ-นามสกุล'), { target: { value: 'ก ข' } });
    fireEvent.change(screen.getByPlaceholderText('08x-xxx-xxxx'), {
      target: { value: '0812345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรับงาน' }));
    const cb = mutate.mock.calls[0]![1] as { onError: (e: unknown) => void };
    const fail = (code: string) =>
      act(() =>
        cb.onError(
          new ApiError({
            type: '',
            title: '',
            status: 422,
            code: 'validation_failed',
            errors: [{ field: 'vehiclePlate', code, message: '' }],
          } as never),
        ),
      );
    fail('registration_mismatch');
    expect(screen.getByRole('alert').textContent).toBe(
      'ทะเบียนหรือเบอร์คนขับไม่ตรงกับข้อมูลที่ลงทะเบียนไว้กับบริษัท',
    );
    fail('carrier_inactive');
    expect(screen.getByRole('alert').textContent).toBe(
      'บัญชีผู้รับเหมาถูกระงับชั่วคราว — ติดต่อผู้ว่าจ้าง',
    );
  });

  it('รับงานด้วยชื่อที่ต่างจากที่ลงทะเบียน → หมายเหตุ · เครื่องค้างหน้าเก่าได้ 409 → ข้อความยังแสดง', () => {
    const r = show();
    fireEvent.click(screen.getByRole('button', { name: 'รับงาน' }));
    fireEvent.change(screen.getByPlaceholderText('เช่น 74-5521 ชบ.'), {
      target: { value: '74-5521' },
    });
    fireEvent.change(screen.getByPlaceholderText('ชื่อ-นามสกุล'), { target: { value: 'สมชาย' } });
    fireEvent.change(screen.getByPlaceholderText('08x-xxx-xxxx'), {
      target: { value: '0812345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรับงาน' }));
    const cb = mutate.mock.calls[0]![1] as { onSuccess: () => void };
    q.data = view({ status: 'ACCEPTED', accepted: { plate: '74-5521', driverName: 'สมชาย ใจดี' } });
    act(() => cb.onSuccess());
    r.rerender(
      <I18nProvider>
        <MemoryRouter initialEntries={['/link/offer/ml1.x']}>
          <Routes>
            <Route path="/link/offer/:token" element={<OfferLinkPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByTestId('ofl-name-note').textContent).toBe(
      'ระบบใช้ชื่อคนขับตามที่ลงทะเบียน: สมชาย ใจดี',
    );
    r.unmount();
    mutate.mockReset();
    q.data = view();
    const r2 = show();
    fireEvent.click(screen.getByRole('button', { name: 'ปฏิเสธ' }));
    fireEvent.click(screen.getByRole('button', { name: 'ราคาไม่คุ้มต้นทุน' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันปฏิเสธ' }));
    const cb2 = mutate.mock.calls[0]![1] as { onError: (e: unknown) => void };
    q.data = view({ status: 'ACCEPTED', accepted: { plate: '74-5521', driverName: 'สมชาย ใจดี' } });
    act(() =>
      cb2.onError(new ApiError({ type: '', title: '', status: 409, code: 'offer_closed' })),
    );
    r2.rerender(
      <I18nProvider>
        <MemoryRouter initialEntries={['/link/offer/ml1.x']}>
          <Routes>
            <Route path="/link/offer/:token" element={<OfferLinkPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByTestId('ofl-accepted')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'ข้อเสนองานนี้ปิดแล้ว — ดูสถานะล่าสุดด้านบน',
    );
  });

  it('ST4-T08: รับงานแล้ว → แท็บ "ส่ง POD" ไปหน้าลิงก์งาน + ข้อความในการ์ดรับงาน', () => {
    q.data = view({
      status: 'ACCEPTED',
      accepted: { plate: '74-5521', driverName: 'สมชาย ใจดี' },
      podUrl: 'https://app.example/link/pod/ml1.pod',
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={['/link/offer/ml1.x']}>
          <Routes>
            <Route path="/link/offer/:token" element={<OfferLinkPage />} />
            <Route path="/link/pod/:token" element={<span>POD PAGE</span>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByText('หลังส่งงาน อัปโหลด POD ได้ที่แท็บ "ส่ง POD"')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'ส่ง POD' }));
    expect(screen.getByText('POD PAGE')).toBeTruthy();
  });

  it('ยังไม่รับงาน → ไม่มีแท็บ "ส่ง POD"', () => {
    show();
    expect(screen.queryByRole('tab', { name: 'ส่ง POD' })).toBeNull();
  });

  it('timeLeft / isThaiPhone', () => {
    const now = Date.parse('2026-11-17T00:00:00Z');
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(timeLeft(at(48 * H), now)).toEqual({ unit: 'h', n: 48 });
    expect(timeLeft(at(30 * 60_000), now)).toEqual({ unit: 'm', n: 30 });
    expect(timeLeft(at(0), now)).toBeNull();
    expect(isThaiPhone('+66 81 234 5678')).toBe(true);
    expect(isThaiPhone('02-118-4400')).toBe(true);
    expect(isThaiPhone('12345')).toBe(false);
  });
});
