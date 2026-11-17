import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import type { OfferView } from '../features/trips/useTrips';
import { isThaiPhone, timeLeft } from './offerTime';

/** ST3-T23 หน้าลิงก์ข้อเสนองาน (ต้นแบบ TMS Subcon แท็บ "งาน") */
const H = 3600_000;
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
    expect(
      screen.getByText('ลิงก์หมดอายุใน 36 ชม. · หากไม่ตอบ งานจะส่งต่อให้ผู้รับเหมาลำดับถัดไป'),
    ).toBeTruthy();
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
