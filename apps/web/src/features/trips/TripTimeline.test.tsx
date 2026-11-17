import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { TripDetail } from './useTrips';
import type { StopEventStep, TimelineEvent } from './useTripTimeline';

/** ST4-T04 แท็บไทม์ไลน์: ขั้นต่อจุด + ผู้บันทึก, ปุ่มบันทึกแทนคนขับ, ถึงจุดก่อนปิดงาน, ส่งไม่สำเร็จจุดที่เหลือ */
const events: { data: TimelineEvent[] } = { data: [] };
const mutate = vi.fn();
vi.mock('./useTripTimeline', () => ({
  useTripEvents: () => ({ data: events.data, isError: false }),
  useRecordStopEvents: () => ({ mutate, isPending: false }),
}));
vi.mock('../settings/useReasonCodes', () => ({
  useReasonCodes: () => ({
    data: [
      {
        id: 'rsn_closed',
        category: 'DELIVERY_FAILED',
        label: 'ลูกค้าปิดทำการ',
        status: 'active',
        requiresNote: true,
      },
      {
        id: 'rsn_late',
        category: 'DELAY',
        label: 'รถติด',
        status: 'active',
        requiresNote: false,
      },
    ],
    isError: false,
  }),
}));
const { TripTimeline } = await import('./TripTimeline');

const stop = (id: string, sequence: number, type: string, name: string, x: object = {}) => ({
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
  deliveryOrderIds: type === 'PICKUP' ? [] : ['do_1'],
  legDistanceKm: null,
  legMinutes: null,
  legSource: null,
  arrivedAt: null,
  departedAt: null,
  outcome: null,
  lastEventId: null,
  ...x,
});

const trip = (stops: object[]) =>
  ({
    id: 'trp_1',
    tripNo: 'TRP-6911-0001',
    tripDate: '2026-11-17',
    status: 'IN_PROGRESS',
    stops,
    deliveryOrders: [{ id: 'do_1', doNo: 'DO-6911-0001' }],
  }) as unknown as TripDetail;

const ev = (x: Partial<TimelineEvent>) =>
  ({
    id: 'evt_1',
    stopId: 'p',
    type: 'ARRIVE',
    outcome: null,
    occurredAt: '2026-11-17T02:10:00.000Z',
    source: 'WEB',
    recordedByName: 'สมพร หน้าคลัง',
    reason: null,
    note: null,
    counted: true,
    seqStatus: 'APPLIED',
    flags: [],
    resolution: null,
    ...x,
  }) as TimelineEvent;

const onOpenFlags = vi.fn();
const onToast = vi.fn();
const onFailRestClose = vi.fn();
const show = (tr: TripDetail, canRecord = true, failRest = false) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider lang="th">
        <TripTimeline
          trip={tr}
          canRecord={canRecord}
          failRest={failRest}
          onFailRestClose={onFailRestClose}
          onToast={onToast}
          onOpenFlags={onOpenFlags}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  mutate.mockReset();
  events.data = [];
});

describe('TripTimeline (ST4-T04)', () => {
  it('ขั้นต่อจุดตามต้นแบบ + บรรทัด event พร้อมชื่อผู้บันทึก · ธงลิงก์ไปศูนย์ข้อยกเว้น', () => {
    events.data = [
      ev({}),
      ev({
        id: 'evt_2',
        type: 'COMPLETE',
        outcome: 'DELIVERED',
        occurredAt: '2026-11-17T02:40:00.000Z',
      }),
      ev({
        id: 'evt_3',
        stopId: 'q',
        type: 'COMPLETE',
        outcome: 'DELIVERED',
        counted: false,
        seqStatus: 'CONFLICT',
        flags: ['SEQUENCE_CONFLICT'],
      }),
    ];
    show(
      trip([
        stop('p', 1, 'PICKUP', 'คลังบางนา', {
          status: 'COMPLETED',
          outcome: 'DELIVERED',
          arrivedAt: '2026-11-17T02:10:00.000Z',
          departedAt: '2026-11-17T02:40:00.000Z',
        }),
        stop('q', 2, 'DELIVERY', 'ร้านชลบุรี'),
      ]),
    );
    expect(screen.getByText('ความคืบหน้าเที่ยว')).toBeInTheDocument();
    const steps = screen.getAllByTestId('trip-step');
    expect(within(steps[0]!).getByText('รับสินค้า · คลังบางนา')).toBeInTheDocument();
    expect(
      within(steps[0]!).getByText(/ถึง 09:10 · ออก 09:40 · ผล: ส่งสำเร็จ/),
    ).toBeInTheDocument();
    expect(within(steps[0]!).getAllByTestId('trip-event')[0]).toHaveTextContent(
      'ถึงจุด 09:10 · บันทึกโดย สมพร หน้าคลัง · บันทึกผ่านเว็บ',
    );
    expect(within(steps[1]!).getByText('ส่งสินค้า · ร้านชลบุรี')).toBeInTheDocument();
    expect(within(steps[1]!).getByText('รอดำเนินการ')).toBeInTheDocument();
    expect(within(steps[1]!).getByText('DO-6911-0001')).toBeInTheDocument();
    expect(within(steps[1]!).getByTestId('trip-event')).toHaveTextContent('ยังไม่นับ');
    fireEvent.click(within(steps[1]!).getByRole('button', { name: 'ศูนย์ข้อยกเว้น' }));
    expect(onOpenFlags).toHaveBeenCalled();
    // จุดรับปิดแล้ว + จุดส่งยังรอ → "ออกจากจุด"
    expect(within(steps[0]!).getByRole('button', { name: 'ออกจากจุด' })).toBeInTheDocument();
  });

  it('ไม่มีสิทธิ์/เที่ยวยังไม่ปล่อย → ไม่มีปุ่มบันทึก', () => {
    show(trip([stop('p', 1, 'PICKUP', 'คลังบางนา')]), false);
    expect(screen.queryByRole('button', { name: 'ถึงจุด' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ปิดงาน' })).toBeNull();
  });

  it('ปิดงานจุดที่ยังไม่ถึง: ถามเวลาถึง + เวลาปิดงาน (ย้อนได้) → ส่ง ARRIVE ก่อน COMPLETE เวลาไทย', () => {
    show(trip([stop('p', 1, 'PICKUP', 'คลังบางนา'), stop('q', 2, 'DELIVERY', 'ร้านชลบุรี')]));
    fireEvent.click(screen.getAllByRole('button', { name: 'ปิดงาน' })[0]!);
    const d = screen.getByRole('dialog', { name: 'บันทึกปิดงาน' });
    const dates = within(d).getAllByLabelText(/วันที่/);
    fireEvent.change(dates[0]!, { target: { value: '2026-11-16' } });
    fireEvent.change(within(d).getByLabelText(/เวลาถึงจุด/), { target: { value: '08:05' } });
    fireEvent.change(dates[1]!, { target: { value: '2026-11-16' } });
    fireEvent.change(within(d).getByLabelText(/เวลาปิดงาน/), { target: { value: '08:30' } });
    fireEvent.click(within(d).getByRole('button', { name: 'บันทึก' }));
    const steps = mutate.mock.calls[0]![0] as StopEventStep[];
    expect(steps.map((s) => [s.stopId, s.action, s.body.occurredAt, s.body.outcome])).toEqual([
      ['p', 'arrive', '2026-11-16T08:05:00+07:00', undefined],
      ['p', 'complete', '2026-11-16T08:30:00+07:00', 'DELIVERED'],
    ]);
    expect(steps[0]!.body.clientEventId).not.toBe(steps[1]!.body.clientEventId);
  });

  it('เวลาปิดงานก่อนเวลาถึง → ข้อความ ไม่ส่ง · ผลไม่สำเร็จต้องเลือกเหตุผล + หมายเหตุตามเหตุผล', () => {
    show(trip([stop('p', 1, 'PICKUP', 'คลังบางนา', { status: 'ARRIVED' })]));
    fireEvent.click(screen.getByRole('button', { name: 'ปิดงาน' }));
    const d = screen.getByRole('dialog', { name: 'บันทึกปิดงาน' });
    expect(within(d).queryByLabelText(/เวลาถึงจุด/)).toBeNull();
    fireEvent.click(within(d).getByRole('radio', { name: 'ส่งไม่สำเร็จ' }));
    fireEvent.click(within(d).getByRole('button', { name: 'บันทึก' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('เลือกเหตุผล');
    // เหตุผลเฉพาะหมวดส่งไม่สำเร็จ/ปฏิเสธรับ (ไม่มี "รถติด")
    const sel = within(d).getByRole('combobox');
    expect(within(sel).queryByText('รถติด')).toBeNull();
    fireEvent.change(sel, { target: { value: 'rsn_closed' } });
    fireEvent.click(within(d).getByRole('button', { name: 'บันทึก' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('เหตุผลนี้ต้องกรอกหมายเหตุ');
    fireEvent.change(within(d).getByLabelText(/หมายเหตุ/), { target: { value: 'ร้านปิด' } });
    fireEvent.click(within(d).getByRole('button', { name: 'บันทึก' }));
    const steps = mutate.mock.calls[0]![0] as StopEventStep[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.body).toMatchObject({
      outcome: 'FAILED',
      reasonCodeId: 'rsn_closed',
      note: 'ร้านปิด',
    });
  });

  it('ออกจากจุด = DEPART ของจุดถัดไป · สำเร็จ → toast', () => {
    show(
      trip([
        stop('p', 1, 'PICKUP', 'คลังบางนา', { status: 'COMPLETED' }),
        stop('q', 2, 'DELIVERY', 'ร้านชลบุรี'),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ออกจากจุด' }));
    const d = screen.getByRole('dialog', { name: 'บันทึกออกจากจุด' });
    expect(d).toHaveTextContent('ออกจาก คลังบางนา มุ่งหน้าไป ร้านชลบุรี');
    fireEvent.click(within(d).getByRole('button', { name: 'บันทึก' }));
    const [steps, opts] = mutate.mock.calls[0]! as [
      StopEventStep[],
      { onSuccess: (x: unknown[]) => void },
    ];
    expect(steps.map((s) => [s.stopId, s.action])).toEqual([['q', 'depart']]);
    opts.onSuccess([{ flags: [] }]);
    expect(onToast).toHaveBeenCalledWith('บันทึกออกจากจุด คลังบางนา แล้ว');
  });

  it('ส่งไม่สำเร็จจุดที่เหลือ: FAIL ทุกจุดที่ยังไม่จบ ด้วยเหตุผลเดียวกัน (บังคับ)', () => {
    show(
      trip([
        stop('p', 1, 'PICKUP', 'คลังบางนา', { status: 'FAILED' }),
        stop('q', 2, 'DELIVERY', 'ร้านชลบุรี', { status: 'ARRIVED' }),
        stop('r', 3, 'DELIVERY', 'ร้านระยอง'),
      ]),
      true,
      true,
    );
    const d = screen.getByRole('dialog', { name: 'ส่งไม่สำเร็จจุดที่เหลือ 2 จุด' });
    fireEvent.click(within(d).getByRole('button', { name: 'บันทึก' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('เลือกเหตุผล');
    fireEvent.change(within(d).getByRole('combobox'), { target: { value: 'rsn_closed' } });
    fireEvent.change(within(d).getByLabelText(/หมายเหตุ/), { target: { value: 'รถเสีย' } });
    fireEvent.click(within(d).getByRole('button', { name: 'บันทึก' }));
    const steps = mutate.mock.calls[0]![0] as StopEventStep[];
    expect(steps.map((s) => [s.stopId, s.action, s.body.reasonCodeId])).toEqual([
      ['q', 'fail', 'rsn_closed'],
      ['r', 'fail', 'rsn_closed'],
    ]);
  });
});
