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
  it('checkbox "ส่งงานทั้งวันของทุกรถ" ติ๊กไว้ก่อน (ยกเว้นรอรถร่วมตอบ) → ส่งเที่ยวที่ติ๊ก · ดับเบิลคลิกส่งครั้งเดียว', () => {
    const { onSend } = setup();
    const master = screen.getByTestId('send-all-master') as HTMLInputElement;
    expect(master.checked).toBe(true);
    expect(screen.getByText('ส่งงานทั้งวันของทุกรถ (2 เที่ยว · 1 คัน)')).toBeInTheDocument();
    expect(screen.getAllByTestId('send-all-row')).toHaveLength(3);
    expect(screen.getByText('สมชาย (คนขับประจำรถ)')).toBeInTheDocument();
    // review M1: รอรถร่วมตอบ ไม่ติ๊กไว้ก่อน + เหตุผลเฉพาะ
    expect(screen.getByRole('checkbox', { name: 'TRP-6911-0003' })).not.toBeChecked();
    expect(screen.getByText('รอรถร่วมตอบรับ — ส่งได้หลังรถร่วมรับงาน')).toBeInTheDocument();
    expect(screen.getByText('ส่งแล้ว 1 / 4 เที่ยว')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'ส่งแผน 2 เที่ยว' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe(D0);
    expect(onSend.mock.calls[0]![1].map((x: BoardTrip) => x.id)).toEqual(['1', '2']);
    expect(btn).toBeDisabled();
  });

  it('ติ๊กออกบางเที่ยว = master indeterminate · master = ทุกเที่ยวที่ส่งได้ · ติ๊กรอรถร่วมตอบเองได้', () => {
    setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'TRP-6911-0002' }));
    const master = screen.getByTestId('send-all-master') as HTMLInputElement;
    expect(master.checked).toBe(false);
    expect(master.indeterminate).toBe(true);
    expect(screen.getByRole('button', { name: 'ส่งแผน 1 เที่ยว' })).toBeEnabled();
    fireEvent.click(master); // บางส่วน → ทุกเที่ยวที่ส่งได้
    expect(master.checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'TRP-6911-0003' })).not.toBeChecked();
    fireEvent.click(master); // ทั้งหมด → ไม่เลือก
    expect(screen.getByRole('button', { name: 'ส่งแผน 0 เที่ยว' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'TRP-6911-0003' }));
    expect(screen.getByRole('button', { name: 'ส่งแผน 1 เที่ยว' })).toBeEnabled();
  });

  it('ผลตรวจล่วงหน้า (dryRun) แสดงบล็อกที่จะติดตอนปล่อย · เหตุผลไม่ซ้ำกับบรรทัดทะเบียน/คนขับ', () => {
    const trips = [
      trip('1'),
      trip('2', { status: 'ASSIGNED', driverName: 'สมศักดิ์' }),
      trip('6', { vehicleId: null, vehiclePlate: null }),
    ];
    const useCheck = () => ({
      '1': null,
      '2': {
        code: 'assignment_blocked',
        title: 'ติดกฎห้ามจ่ายงาน',
        blocks: [{ message: 'ใบขับขี่หมดอายุ 1 ม.ค. 2563' }],
      },
    });
    render(
      <I18nProvider lang="th">
        <SendAllDialog
          board={board(trips, DAYS)}
          days={[D0, D1]}
          initialDay={D0}
          busy={false}
          onSend={() => {}}
          onClose={() => {}}
          useCheck={useCheck}
        />
      </I18nProvider>,
    );
    const rows = screen.getAllByTestId('send-all-row');
    expect(rows[1]).toHaveTextContent('ใบขับขี่หมดอายุ 1 ม.ค. 2563');
    expect(rows[0]).not.toHaveTextContent('ใบขับขี่');
    // QA L3: "ยังไม่ได้วางลงรถ" ครั้งเดียว
    const noVeh = rows.find((r) => r.textContent!.includes('TRP-6911-0006'))!;
    expect(noVeh.textContent!.split('ยังไม่ได้วางลงรถ')).toHaveLength(2);
  });

  it('เลือกเกิน 400 เที่ยว → ปุ่มส่งปิด + บอกให้แบ่งส่ง', () => {
    const many = Array.from({ length: 401 }, (_, i) => trip(`x${i}`, { tripNo: `TRP-X-${i}` }));
    setup(board(many, [{ date: D0, trips: 401, sent: 0, complete: false }]));
    expect(screen.getByTestId('send-all-too-many')).toHaveTextContent(
      'ส่งได้ครั้งละไม่เกิน 400 เที่ยว',
    );
    expect(screen.getByRole('button', { name: 'ส่งแผน 401 เที่ยว' })).toBeDisabled();
  });

  it('เปลี่ยนเป็นวันที่ส่งครบแล้ว → แถบเขียว "ส่งแผนครบทุกเที่ยวแล้ว" และปุ่มส่งปิด', () => {
    setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'วันที่' }), { target: { value: D1 } });
    expect(screen.getByTestId('send-all-empty')).toHaveTextContent('ส่งแผนครบทุกเที่ยวแล้ว');
    expect(screen.getByRole('button', { name: 'ส่งแผน 0 เที่ยว' })).toBeDisabled();
  });
});
