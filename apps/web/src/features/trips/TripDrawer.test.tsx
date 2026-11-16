import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { TripDetail } from './useTrips';

/** ST3-T16: drawer เที่ยวรถ — จุดรับ/ส่งตามลำดับ, เลื่อนขึ้น/ลง, กันส่งก่อนรับฝั่ง client, ระยะ/เวลารวม */
const live: { data: TripDetail | undefined; isError: boolean } = {
  data: undefined,
  isError: false,
};
const reorderMutate = vi.fn();
const detachMutate = vi.fn();
vi.mock('./useTrips', () => ({
  useTrip: () => live,
  useReorderStops: () => ({ mutate: reorderMutate, isPending: false }),
  useDetachFromTrip: () => ({ mutate: detachMutate, isPending: false }),
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' } } }),
}));
const { TripDrawer } = await import('./TripDrawer');

const stop = (
  id: string,
  sequence: number,
  type: string,
  name: string,
  dos: string[],
  leg: Partial<TripDetail['stops'][number]> = {},
) =>
  ({
    id,
    sequence,
    type,
    siteId: `loc_${id}`,
    siteName: name,
    status: 'PENDING',
    windowStart: null,
    windowEnd: null,
    plannedArrival: '2026-11-17T03:00:00.000Z',
    plannedDeparture: null,
    deliveryOrderIds: dos,
    legDistanceKm: null,
    legMinutes: null,
    legSource: null,
    ...leg,
  }) as TripDetail['stops'][number];

const TRIP = {
  id: 'trp_1',
  tripNo: 'TRP-6911-0001',
  tripDate: '2026-11-17',
  status: 'PLANNING',
  plannedStartAt: null,
  plannedEndAt: null,
  vehicle: { id: 'veh_1', plate: '70-1234', vehicleTypeId: 'vty_1', vehicleTypeName: '6 ล้อ' },
  trailer: null,
  driver: { id: 'drv_1', name: 'สมชาย ใจดี', phone: null },
  reliefDriver: null,
  carrier: null,
  stops: [
    stop('p', 1, 'PICKUP', 'คลังบางนา', ['do_1', 'do_2']),
    stop('q1', 2, 'DELIVERY', 'ร้านชลบุรี', ['do_1'], {
      legDistanceKm: '82.4',
      legMinutes: 95,
      legSource: 'ROUTE',
    }),
    stop('q2', 3, 'DELIVERY', 'ร้านระยอง', ['do_2'], {
      legDistanceKm: '60.0',
      legMinutes: 72,
      legSource: 'ESTIMATE',
    }),
  ],
  deliveryOrders: [
    {
      id: 'do_1',
      doNo: 'DO-6911-0001',
      status: 'DRAFT',
      orderId: 'ord_1',
      customerId: 'cus_1',
      pickupStopId: 'p',
      dropStopId: 'q1',
    },
    {
      id: 'do_2',
      doNo: 'DO-6911-0002',
      status: 'DRAFT',
      orderId: 'ord_2',
      customerId: 'cus_1',
      pickupStopId: 'p',
      dropStopId: 'q2',
    },
  ],
  weightKg: '2000',
  route: { distanceKm: '142.4', minutes: 167, missingLegs: 0, estimated: true },
  warnings: [],
  ruleOverrides: [],
  version: 3,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
} as unknown as TripDetail;

const show = (canEdit = true) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider lang="th">
        <TripDrawer id="trp_1" canEdit={canEdit} onClose={() => {}} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('TripDrawer (ST3-T16)', () => {
  beforeEach(() => {
    live.data = TRIP;
    reorderMutate.mockReset();
    detachMutate.mockReset();
  });

  it('หัว/ข้อมูล/จุดตามลำดับ + ระยะช่วงวิ่ง + ยอดรวม', () => {
    show();
    expect(screen.getByText('เที่ยวรถ / ใบคุมรถ')).toBeTruthy();
    expect(screen.getByText('TRP-6911-0001')).toBeTruthy();
    expect(screen.getByText('กำลังวางแผน')).toBeTruthy();
    expect(screen.getByText('70-1234 · 6 ล้อ')).toBeTruthy();
    expect(screen.getByText('142.4 กม. (ประมาณจากพิกัด)')).toBeTruthy();
    expect(screen.getByText('2 ชม. 47 นาที')).toBeTruthy();
    expect(screen.getByText('จุดรับ / ส่ง ตามลำดับ')).toBeTruthy();
    const rows = screen.getAllByTestId('trip-stop');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('คลังบางนา'),
      expect.stringContaining('+82.4 กม. · 10:00'),
      expect.stringContaining('≈ +60.0 กม.'),
    ]);
    expect(rows[0]!.textContent).not.toContain('DO-6911');
    expect(rows[1]!.textContent).toContain('DO-6911-0001');
    expect(screen.getByText('2 ใบ')).toBeTruthy();
  });

  it('เลื่อนจุดส่งขึ้นเหนือจุดรับของ DO เดียวกัน → ข้อความ ไม่เรียก API · สลับจุดส่งสองจุด → เรียก API พร้อม version', () => {
    show();
    const up = screen.getAllByTitle('เลื่อนขึ้น');
    fireEvent.click(up[1]!);
    expect(screen.getByRole('alert').textContent).toBe(
      'ย้ายไม่ได้ — ใบส่งของ DO-6911-0001: จุดส่งต้องอยู่หลังจุดรับ (ต้องรับของก่อนส่ง)',
    );
    expect(reorderMutate).not.toHaveBeenCalled();
    fireEvent.click(up[2]!);
    expect(reorderMutate).toHaveBeenCalledWith(
      { id: 'trp_1', version: 3, stopIds: ['p', 'q2', 'q1'] },
      expect.anything(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('นำออกจากเที่ยว (จุดส่ง) → ถอด DO ของจุดนั้น · ไม่มีสิทธิ์/ปล่อยรถแล้ว → ไม่มีปุ่ม', () => {
    const { unmount } = show();
    expect(screen.getAllByTitle('นำออกจากเที่ยว')).toHaveLength(2);
    fireEvent.click(screen.getAllByTitle('นำออกจากเที่ยว')[0]!);
    expect(detachMutate).toHaveBeenCalledWith(
      { id: 'trp_1', version: 3, doIds: ['do_1'] },
      expect.anything(),
    );
    unmount();
    show(false);
    expect(screen.queryByTitle('เลื่อนขึ้น')).toBeNull();
    live.data = { ...TRIP, status: 'DISPATCHED' } as TripDetail;
    show(true);
    expect(screen.queryByTitle('เลื่อนขึ้น')).toBeNull();
  });

  it('× ที่จุดที่มีหลายใบส่งของ → dialog ยืนยัน เลือกบางใบได้ (QA ST3-T16)', () => {
    live.data = {
      ...TRIP,
      stops: [TRIP.stops[0]!, { ...TRIP.stops[1]!, deliveryOrderIds: ['do_1', 'do_2'] }],
      deliveryOrders: TRIP.deliveryOrders.map((d) => ({ ...d, dropStopId: 'q1' })),
    } as TripDetail;
    show();
    fireEvent.click(screen.getByTitle('นำออกจากเที่ยว'));
    expect(detachMutate).not.toHaveBeenCalled();
    const dlg = screen.getByRole('dialog', { name: 'นำใบส่งของออกจากเที่ยว' });
    fireEvent.click(within(dlg).getByLabelText('DO-6911-0002'));
    fireEvent.click(within(dlg).getByRole('button', { name: 'นำออก 1 ใบ' }));
    expect(detachMutate).toHaveBeenCalledWith(
      { id: 'trp_1', version: 3, doIds: ['do_1'] },
      expect.anything(),
    );
  });

  it('เรียงสำเร็จ → toast + คำเตือนใหม่ · จุดเดียวกันไม่แสดง +0.0 กม.', () => {
    reorderMutate.mockImplementation((_v, o: { onSuccess: (x: TripDetail) => void }) =>
      o.onSuccess({
        ...TRIP,
        warnings: [
          { code: 'stop_sequence_window_order', message: 'จุดที่ 3: เวลาตามแผนก่อนจุดก่อนหน้า' },
        ],
      } as unknown as TripDetail),
    );
    live.data = {
      ...TRIP,
      stops: [
        TRIP.stops[0]!,
        { ...TRIP.stops[1]!, legDistanceKm: '0.0', legSource: 'SAME_SITE' },
        TRIP.stops[2]!,
      ],
    } as TripDetail;
    show();
    expect(screen.getAllByTestId('trip-stop')[1]!.textContent).not.toContain('กม.');
    fireEvent.click(screen.getAllByTitle('เลื่อนขึ้น')[2]!);
    expect(screen.getByRole('status').textContent).toContain(
      'เรียงลำดับจุดของ TRP-6911-0001 แล้ว · พบปัญหา: จุดที่ 3: เวลาตามแผนก่อนจุดก่อนหน้า',
    );
  });
});
