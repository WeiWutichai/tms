import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { SubconOffer, TripDetail } from './useTrips';

/** ST3-T23 drawer "จ่ายงานรถร่วม" หลังส่งข้อเสนอ: kv ส่งล่าสุด/หมดเวลา · คัดลอกลิงก์ · ส่งผ่าน LINE · รับงานแล้ว · กิจกรรม */
const URL1 = 'https://app.example/link/offer/ml1.abc';
const sendMutate = vi.fn();
let offers: SubconOffer[] = [];
vi.mock('./useTrips', () => ({
  useHireOptions: () => ({
    data: {
      sellAmount: '7800.00',
      origin: { name: 'บางปู' },
      destination: { name: 'แหลมฉบัง' },
      options: [
        {
          carrier: { id: 'car_a', paymentTermDays: 15, requirePodToPay: true },
          whtRate: '1.00',
          buyRecentAmounts: ['5400.00'],
        },
      ],
    },
  }),
  useOfferLink: () => ({ data: { url: URL1 } }),
  useTripOffers: () => ({ data: offers }),
  useSendOfferLink: () => ({ mutate: sendMutate, isPending: false }),
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({
    data: { tenant: { yearStyle: 'BE', name: 'ศรีไทยขนส่ง' }, user: { name: 'พรทิพย์' } },
  }),
}));
const { SubconOfferDrawer, activity } = await import('./SubconOfferDrawer');

const offer = (o: Partial<SubconOffer> = {}): SubconOffer => ({
  id: 'sco_1',
  carrierId: 'car_a',
  carrierName: 'หจก. เอ',
  status: 'OFFERED',
  buyAmount: '5600.00',
  offeredAt: '2026-11-17T03:14:00.000Z',
  offeredByName: 'พรทิพย์ ศรีวงศ์',
  expiresAt: '2026-11-19T03:14:00.000Z',
  viewedAt: null,
  respondedAt: null,
  respondedVia: null,
  rejectReason: null,
  rejectNote: null,
  acceptedPlate: null,
  acceptedDriverName: null,
  closedAt: null,
  closedReason: null,
  messages: [],
  ...o,
});
const trip = (o: Partial<TripDetail> = {}) =>
  ({
    id: 'trp_1',
    tripNo: 'TRP-6911-0004',
    tripDate: '2026-11-18',
    status: 'OFFERED',
    version: 3,
    carrier: { id: 'car_a', name: 'หจก. เอ' },
    vehicle: null,
    driver: null,
    offerExpiresAt: new Date(Date.now() + 36 * 3600_000 + 60_000).toISOString(),
    hire: {
      id: 'sco_1',
      carrierId: 'car_a',
      status: 'OFFERED',
      buyAmount: '5600.00',
      buyPriceSource: 'RATE_CARD',
      rateCardCode: 'RC-B-0001',
      selectionReason: 'ถูกสุด',
      offeredBy: 'u1',
      offeredAt: '2026-11-17T03:14:00.000Z',
    },
    route: { distanceKm: '120.0' },
    stops: [],
    ...o,
  }) as unknown as TripDetail;

const show = (t: TripDetail) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <SubconOfferDrawer trip={t} onClose={() => undefined} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('SubconOfferDrawer (ST3-T23)', () => {
  beforeEach(() => {
    sendMutate.mockReset();
    offers = [offer()];
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('รอตอบ: kv ส่งข้อเสนอล่าสุด + หมดเวลาใน · กำไร · คัดลอกลิงก์ + ส่งผ่าน LINE', () => {
    show(trip());
    expect(screen.getByText('รอตอบ')).toBeTruthy();
    expect(screen.getByText('ส่งข้อเสนอล่าสุด')).toBeTruthy();
    expect(screen.getByText('เหลือ 36 ชม.')).toBeTruthy();
    expect(screen.getByText('กำไรต่อเที่ยว')).toBeTruthy();
    expect(screen.getByText('฿2,200.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'คัดลอกลิงก์' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(URL1);
    expect(screen.getByText('คัดลอกลิงก์ใบสั่งงานแล้ว · อายุ 48 ชม.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ส่งผ่าน LINE' }));
    expect(sendMutate).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'line', url: URL1 }),
      expect.anything(),
    );
    // ใบสั่งงาน + ลิงก์
    fireEvent.click(screen.getByRole('tab', { name: 'ใบสั่งงาน' }));
    expect(screen.getByTestId('sub-link').textContent).toBe(URL1);
    expect(screen.getByText('หัก ณ ที่จ่าย 1% · จ่ายภายใน 15 วันหลังส่ง POD')).toBeTruthy();
  });

  it('รับงานแล้ว: กล่อง "… รับงานแล้ว" ทะเบียน/คนขับ · footer ราคาจ้าง + คัดลอกลิงก์ (ไม่มีส่งผ่าน LINE)', () => {
    offers = [offer({ status: 'ACCEPTED', respondedVia: 'LINK', acceptedPlate: '74-5521' })];
    show(
      trip({
        status: 'ASSIGNED',
        hire: { ...trip().hire!, status: 'ACCEPTED' },
        vehicle: { id: 'veh_1', plate: '74-5521', vehicleTypeId: 'vty', vehicleTypeName: '6 ล้อ' },
        driver: { id: 'drv_1', name: 'สมชาย ใจดี', phone: null },
      } as Partial<TripDetail>),
    );
    expect(screen.getByTestId('sub-accepted').textContent).toContain('หจก. เอ รับงานแล้ว');
    expect(screen.getByTestId('sub-accepted').textContent).toContain(
      'ทะเบียน 74-5521 · คนขับ สมชาย ใจดี',
    );
    expect(screen.getByText('ราคาจ้าง')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ส่งผ่าน LINE' })).toBeNull();
    expect(screen.queryByText('หมดเวลาใน')).toBeNull();
  });

  it('กิจกรรม: ส่งข้อเสนอ → ส่ง LINE → เปิดลิงก์ → ปฏิเสธ เรียงตามเวลา', () => {
    const t = (k: string, v?: Record<string, string | number>) =>
      `${k}${v ? JSON.stringify(v) : ''}`;
    const items = activity(
      [
        offer({ id: 'sco_2', offeredAt: '2026-11-17T05:00:00.000Z', carrierName: 'บี' }),
        offer({
          status: 'REJECTED',
          viewedAt: '2026-11-17T03:20:00.000Z',
          respondedAt: '2026-11-17T03:30:00.000Z',
          respondedVia: 'LINK',
          rejectReason: 'PRICE_TOO_LOW',
          messages: [
            {
              id: 'msg_1',
              channel: 'line',
              status: 'sent',
              recipient: 'U1•••',
              createdAt: '2026-11-17T03:15:00.000Z',
              sentAt: '2026-11-17T03:15:02.000Z',
              errorCode: null,
            },
          ],
        }),
      ],
      t as never,
      (iso) => iso.slice(11, 16),
    );
    expect(items.map((i) => (i.title as string).split('{')[0])).toEqual([
      'sub.log.offered',
      'sub.log.msg',
      'sub.log.viewed',
      'sub.log.dec',
      'sub.log.offered',
    ]);
    expect(items[1]!.sub).toBe('03:15 · LINE SENT');
    expect(items[3]!.badge.tone).toBe('err');
  });
});
