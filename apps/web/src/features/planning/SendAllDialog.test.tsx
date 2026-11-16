import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { dayComplete, sendHint, unsentOn, type Board, type BoardTrip } from './board';
import { SendAllDialog } from './SendAllDialog';

const D0 = '2026-11-17';
const D1 = '2026-11-18';
const trip = (id: string, extra: Partial<BoardTrip> = {}): BoardTrip =>
  ({
    id,
    tripNo: `TRP-6911-000${id}`,
    tripDate: D0,
    status: 'PLANNING',
    vehicleId: 'veh_1',
    vehiclePlate: '70-1234',
    plannedStartAt: null,
    plannedEndAt: null,
    driverName: null,
    carrierName: null,
    orders: [],
    origin: null,
    dest: null,
    weightKg: '0',
    doNos: [],
    plannedDistanceKm: null,
    missingLegs: 0,
    overlapsWith: [],
    pendingRules: [],
    confirmedRules: 0,
    warningCount: 0,
    version: 1,
    ...extra,
  }) as BoardTrip;

const board = (trips: BoardTrip[], days: Board['days']): Board =>
  ({
    from: D0,
    to: D1,
    today: D0,
    vehicles: [
      { id: 'veh_1', plate: '70-1234', driver: { id: 'drv_1', name: 'สมชาย', licenceClass: 'T2' } },
    ],
    trips,
    pool: [],
    days,
  }) as unknown as Board;

const TRIPS = [
  trip('1'),
  trip('2', { status: 'ASSIGNED', driverName: 'สมศักดิ์' }),
  trip('3', { status: 'OFFERED', vehicleId: null, vehiclePlate: null, carrierName: 'หจก. ร่วม' }),
  trip('4', { status: 'DISPATCHED' }),
  trip('5', { tripDate: D1, status: 'DISPATCHED' }),
];
const DAYS = [
  { date: D0, trips: 4, sent: 1, complete: false },
  { date: D1, trips: 1, sent: 1, complete: true },
];

const setup = (b = board(TRIPS, DAYS)) => {
  const onSend = vi.fn();
  render(
    <I18nProvider lang="th">
      <SendAllDialog
        board={b}
        days={[D0, D1]}
        initialDay={D0}
        busy={false}
        onSend={onSend}
        onClose={() => {}}
      />
    </I18nProvider>,
  );
  return { onSend };
};

describe('board send-all helpers (ST3-T18)', () => {
  it('unsentOn: เฉพาะเที่ยวของวันที่ยังไม่ส่ง (PLANNING/OFFERED/ASSIGNED) · dayComplete จาก days[] · sendHint', () => {
    expect(unsentOn(TRIPS, D0).map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(dayComplete(board(TRIPS, DAYS), D0)).toBe(false);
    expect(dayComplete(board(TRIPS, DAYS), D1)).toBe(true);
    expect(dayComplete(undefined, D1)).toBe(false);
    expect(sendHint(TRIPS[2]!)).toBe('offered');
    expect(sendHint(trip('9', { vehicleId: null }))).toBe('noVehicle');
    expect(
      sendHint(
        trip('9', {
          pendingRules: [{ key: 'k', code: 'OVERWEIGHT', severity: 'warning', message: 'เกิน' }],
        }),
      ),
    ).toBe('rule');
    expect(sendHint(TRIPS[0]!)).toBeNull();
  });
});

describe('SendAllDialog (ST3-T18 Send all)', () => {
  it('checkbox "ส่งงานทั้งวันของทุกรถ" ติ๊กไว้ก่อน → ส่งทุกเที่ยวที่ยังไม่ส่งของวัน พร้อมเหตุผลที่คาดว่าส่งไม่ได้', () => {
    const { onSend } = setup();
    const master = screen.getByTestId('send-all-master') as HTMLInputElement;
    expect(master.checked).toBe(true);
    expect(screen.getByText('ส่งงานทั้งวันของทุกรถ (3 เที่ยว · 1 คัน)')).toBeInTheDocument();
    expect(screen.getAllByTestId('send-all-row')).toHaveLength(3);
    expect(screen.getByText('สมชาย (คนขับประจำรถ)')).toBeInTheDocument();
    expect(screen.getByText('รอรถร่วมตอบรับ — ส่งได้หลังรถร่วมรับงาน')).toBeInTheDocument();
    expect(screen.getByText('ส่งแล้ว 1 / 4 เที่ยว')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ส่งแผน 3 เที่ยว' }));
    expect(onSend).toHaveBeenCalledWith(
      D0,
      expect.arrayContaining([
        expect.objectContaining({ id: '1' }),
        expect.objectContaining({ id: '2' }),
        expect.objectContaining({ id: '3' }),
      ]),
    );
  });

  it('ติ๊กออกบางเที่ยว = ส่งเฉพาะที่เลือก (master indeterminate) · ติ๊ก master ออก = ส่งไม่ได้', () => {
    const { onSend } = setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'TRP-6911-0003' }));
    const master = screen.getByTestId('send-all-master') as HTMLInputElement;
    expect(master.checked).toBe(false);
    expect(master.indeterminate).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'ส่งแผน 2 เที่ยว' }));
    expect(onSend.mock.calls[0]![1].map((x: BoardTrip) => x.id)).toEqual(['1', '2']);
    fireEvent.click(master); // บางส่วน → ติ๊กทั้งหมด
    expect(master.checked).toBe(true);
    fireEvent.click(master); // ทั้งหมด → ไม่เลือก
    expect(screen.getByRole('button', { name: 'ส่งแผน 0 เที่ยว' })).toBeDisabled();
  });

  it('เปลี่ยนเป็นวันที่ส่งครบแล้ว → แถบเขียว "ส่งแผนครบทุกเที่ยวแล้ว" และปุ่มส่งปิด', () => {
    setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'วันที่' }), { target: { value: D1 } });
    expect(screen.getByTestId('send-all-empty')).toHaveTextContent('ส่งแผนครบทุกเที่ยวแล้ว');
    expect(screen.getByRole('button', { name: 'ส่งแผน 0 เที่ยว' })).toBeDisabled();
  });
});
