import { describe, expect, it } from 'vitest';
import {
  addDays,
  axisBox,
  blocksOn,
  boardStats,
  cardLine,
  custShort,
  dropWindow,
  hhmm,
  hourOf,
  isoAt,
  lanes,
  movable,
  movedWindow,
  onDay,
  orderVehicles,
  poolView,
  resizedWindow,
  rowLoad,
  scheduleBody,
  span,
  firstRule,
  ruleState,
  tripColor,
  tripMoveBlock,
  weekFields,
  weekDropWindow,
  type Board,
  type BoardTrip,
  type BoardVehicle,
  type PoolOrder,
  issuesOn,
  levelOn,
  moveTarget,
  orderDay,
  type EligItem,
} from './board';

const D = '2026-11-16';
const trip = (o: Partial<BoardTrip> = {}): BoardTrip => ({
  id: 'trp_1',
  tripNo: 'TRP-1',
  tripDate: D,
  status: 'PLANNING',
  vehicleId: 'veh_1',
  vehiclePlate: '70-1234',
  plannedStartAt: `${D}T09:00:00+07:00`,
  plannedEndAt: `${D}T12:00:00+07:00`,
  driverName: null,
  carrierName: null,
  orders: [{ id: 'ord_1', orderNo: 'SO-1', customerName: 'บจก. ทดสอบ' }],
  origin: null,
  dest: null,
  weightKg: '5400',
  doNos: ['DO-1'],
  plannedDistanceKm: '120',
  overlapsWith: [],
  warningCount: 0,
  pendingRules: [],
  confirmedRules: 0,
  version: 1,
  ...o,
});
const order = (o: Partial<PoolOrder>): PoolOrder => ({
  id: 'ord_x',
  orderNo: 'SO-X',
  customerId: 'cus_1',
  customerName: 'ก',
  requestedDate: D,
  status: 'RECEIVED',
  holdReason: null,
  sourceChangePending: false,
  vehicleTypeId: 'vty_6',
  vehicleTypeName: '6 ล้อ',
  origin: { name: 'A', province: null },
  dest: { name: 'B', province: null },
  windowStart: null,
  windowEnd: null,
  weightKg: '1000',
  deliveryOrders: [],
  ...o,
});

describe('เวลาไทยบนแกน (ST3-T12)', () => {
  it('ISO ↔ ชั่วโมงของวัน (+07:00) และข้ามวัน', () => {
    expect(hourOf(`${D}T09:30:00+07:00`, D)).toBe(9.5);
    expect(hourOf('2026-11-16T17:00:00Z', D)).toBe(24); // เที่ยงคืนของวันถัดไป
    expect(isoAt(D, 9.25)).toBe(`${D}T09:15:00+07:00`);
    expect(isoAt(D, 25)).toBe('2026-11-17T01:00:00+07:00');
    expect(hhmm(13.75)).toBe('13:45');
  });
  it('ไม่มีช่วงวิ่ง → 08:00 + 3 ชม. ของวันเที่ยว · ข้ามคืนแสดงทั้งสองวัน', () => {
    expect(span(trip({ plannedStartAt: null, plannedEndAt: null }), D)).toEqual({
      s: 8,
      e: 11,
      estimated: true,
    });
    const night = trip({
      plannedStartAt: `${D}T22:00:00+07:00`,
      plannedEndAt: '2026-11-17T03:00:00+07:00',
    });
    expect(onDay(night, D)).toBe(true);
    expect(onDay(night, '2026-11-17')).toBe(true);
    expect(onDay(night, '2026-11-18')).toBe(false);
  });
  it('แกน 06:00–20:00 ตัดที่ขอบ · ทั้งเที่ยวนอกแกน = แถบ 1 ชม. ที่ขอบ', () => {
    expect(axisBox(9, 12)).toEqual({
      left: 3 / 14,
      width: 3 / 14,
      clipped: false,
      clipS: false,
      clipE: false,
    });
    expect(axisBox(18, 23)).toMatchObject({ clipS: false, clipE: true });
    expect(axisBox(-2, 3)).toMatchObject({ clipS: true, clipE: true }); // 22:00–03:00 วันที่สอง
    expect(axisBox(19, 22)).toMatchObject({ left: 13 / 14, width: 1 / 14, clipped: true });
    expect(axisBox(21, 23)).toMatchObject({ left: 13 / 14, width: 1 / 14 });
    expect(axisBox(2, 4)).toMatchObject({ left: 0, width: 1 / 14 });
  });
});

describe('lane + ซ้อนเวลา', () => {
  it('เวลาซ้อน = lane ใหม่ · ขอบชนพอดีใช้ lane เดิม (ต้นแบบ laneOf)', () => {
    const r = lanes([
      { id: 'a', s: 9, e: 12 },
      { id: 'b', s: 11, e: 14 },
      { id: 'c', s: 12, e: 13 },
    ]);
    expect(r.lane).toEqual({ a: 0, b: 1, c: 0 });
    expect(r.count).toBe(2);
    expect(lanes([]).count).toBe(1);
  });
  it('ซ้อนเวลา = แถบแดง (docs/04 D2) · ไม่ซ้อน = สีสถานะ', () => {
    expect(tripColor(trip({ overlapsWith: ['TRP-2'] }))).toBe('#B3322A');
    expect(tripColor(trip({ status: 'DISPATCHED' }))).toBe('#2257C4');
  });

  it('ST3-T14 กฎตอนจัด: บล็อกค้าง = แดง (ต้องย้ายรถ) · คำเตือนค้าง = ส้ม (รออนุมัติ) · ยกเว้นครบ = เทา', () => {
    const w = {
      key: 'k1',
      code: 'OVERWEIGHT',
      severity: 'warning' as const,
      message: 'น้ำหนักเกิน',
    };
    const ov = {
      key: 'k2',
      code: 'vehicle_overlap',
      severity: 'warning' as const,
      message: 'ซ้อน',
    };
    const b = {
      key: 'k3',
      code: 'DOC_CMI_EXPIRED',
      severity: 'block' as const,
      message: 'พ.ร.บ. หมด',
    };
    expect(ruleState(trip())).toBeNull();
    expect(ruleState(trip({ pendingRules: [w, b] }))).toBe('block');
    expect(tripColor(trip({ pendingRules: [b] }))).toBe('#B3322A');
    expect(ruleState(trip({ pendingRules: [w] }))).toBe('pending');
    expect(tripColor(trip({ status: 'DISPATCHED', pendingRules: [w] }))).toBe('#8F5500');
    expect(ruleState(trip({ confirmedRules: 2 }))).toBe('overridden');
    expect(tripColor(trip({ confirmedRules: 1 }))).toBe('#59606B');
    // ซ้อนเวลามีป้ายของตัวเอง — ป้ายกฎใช้ข้อแรกที่ไม่ใช่ซ้อนเวลา
    expect(firstRule(trip({ pendingRules: [ov, w] }))).toBe(w);
    expect(firstRule(trip({ pendingRules: [ov] }))).toBe(ov);
    expect(movable(trip({ status: 'ASSIGNED' }))).toBe(true);
    expect(movable(trip({ status: 'DISPATCHED' }))).toBe(false);
    expect(tripMoveBlock(trip({ status: 'DISPATCHED' }), 'veh_1')).toBe('locked');
    expect(tripMoveBlock(trip({ status: 'ASSIGNED' }), 'veh_2')).toBe('assigned');
    expect(tripMoveBlock(trip({ status: 'ASSIGNED' }), 'veh_1')).toBeNull();
    expect(tripMoveBlock(trip(), 'veh_2')).toBeNull();
  });
});

describe('ลากวาง / ย้าย / ปรับขนาด', () => {
  it('วางงานใหม่: snap 15 นาที จำกัดในแกน · 7 วัน = ต่อท้ายเที่ยวสุดท้าย หรือ 08:00', () => {
    expect(dropWindow(9.4)).toEqual({ s: 9.5, e: 12.5 });
    expect(dropWindow(19)).toEqual({ s: 17, e: 20 });
    expect(dropWindow(3)).toEqual({ s: 6, e: 9 });
    expect(weekDropWindow([], D)).toEqual({ s: 8, e: 11 });
    expect(weekDropWindow([trip()], D)).toEqual({ s: 12, e: 15 });
  });
  it('ลากเที่ยว: เริ่มใหม่ = ตำแหน่งปล่อย − จุดที่จับ คงความยาว · ปรับขอบยาวอย่างน้อย 15 นาที', () => {
    expect(movedWindow(trip(), D, 14.1, 1)).toEqual({ s: 13, e: 16 });
    expect(resizedWindow(9, 12, 'e', 14.6)).toEqual({ s: 9, e: 14.5 });
    expect(resizedWindow(9, 12, 's', 13)).toEqual({ s: 11.75, e: 12 });
    expect(resizedWindow(9, 12, 'e', 8)).toEqual({ s: 9, e: 9.25 });
    // ขอบที่ลากไม่ออกนอกแกน 06:00–20:00 ของวันที่แสดง (เปลี่ยนวันเที่ยวไม่ได้)
    expect(resizedWindow(9, 12, 'e', 26)).toEqual({ s: 9, e: 20 });
    expect(resizedWindow(9, 12, 's', 2)).toEqual({ s: 6, e: 12 });
    // ลากทั้งเที่ยวก็อยู่ในแกน
    expect(movedWindow(trip(), D, 21, 0)).toEqual({ s: 17, e: 20 });
    expect(movedWindow(trip(), D, 4, 1)).toEqual({ s: 6, e: 9 });
  });
  it('body ของ /schedule: วันเที่ยว = วันเริ่ม (เวลาไทย)', () => {
    expect(scheduleBody(D, 9, 12)).toEqual({
      tripDate: D,
      plannedStartAt: `${D}T09:00:00+07:00`,
      plannedEndAt: `${D}T12:00:00+07:00`,
    });
    expect(scheduleBody(D, 24.5, 26).tripDate).toBe('2026-11-17');
    // ปรับขนาดส่งวันเที่ยวเดิม
    expect(scheduleBody(D, 6, 8, '2026-11-15').tripDate).toBe('2026-11-15');
  });
});

describe('SO รอจัด + สรุป', () => {
  it('กรองวัน/ประเภทรถ/ลูกค้า · เรียงกำหนดส่ง → น้ำหนักมากก่อน', () => {
    const pool = [
      order({ id: '1', orderNo: 'SO-1', requestedDate: '2026-11-17' }),
      order({ id: '2', orderNo: 'SO-2', weightKg: '500' }),
      order({ id: '3', orderNo: 'SO-3', weightKg: '9000', vehicleTypeId: 'vty_10' }),
      order({ id: '4', orderNo: 'SO-4', requestedDate: '2026-11-10', customerId: 'cus_2' }),
    ];
    const all = { d: 'all' as const, vt: '', c: '' };
    expect(poolView(pool, all, D).map((o) => o.id)).toEqual(['4', '3', '2', '1']);
    expect(poolView(pool, { ...all, d: 'today' }, D).map((o) => o.id)).toEqual(['4', '3', '2']);
    expect(poolView(pool, { ...all, d: 'tomorrow' }, D).map((o) => o.id)).toEqual(['1']);
    expect(poolView(pool, { ...all, vt: 'vty_10' }, D).map((o) => o.id)).toEqual(['3']);
    expect(poolView(pool, { ...all, c: 'cus_2' }, D).map((o) => o.id)).toEqual(['4']);
  });
  it('ภาระรถ = น้ำหนักสูงสุด · รถว่างวันนี้ / ปัญหารอแก้', () => {
    expect(rowLoad([trip(), trip({ weightKg: '6800' })])).toBe(6800);
    const b = {
      from: D,
      to: D,
      today: D,
      vehicles: [{ id: 'veh_1' }, { id: 'veh_2' }],
      trips: [trip(), trip({ id: 'trp_2', overlapsWith: ['TRP-1'], plannedDistanceKm: null })],
      pool: [order({})],
    } as unknown as Board;
    expect(boardStats(b, [D])).toMatchObject({
      pend: 1,
      total: 2,
      free: 1,
      used: 1,
      w: 10800,
      km: 120,
      iss: 1,
    });
  });
  it('วันที่รถติดกฎห้ามจ่ายงาน', () => {
    const v = {
      blocks: [{ date: D, issues: [{ code: 'DOC_MISSING', message: 'ยังไม่มี ประกันภัย' }] }],
    } as unknown as Board['vehicles'][number];
    expect(blocksOn(v, D).map((i) => i.code)).toEqual(['DOC_MISSING']);
    expect(blocksOn(v, '2026-11-17')).toEqual([]);
  });
  it('ชื่อลูกค้าสั้น ตัดคำนำหน้า', () => {
    expect(custShort('บจก. สยามพลาสติก', 'บจก.|บมจ.')).toBe('สยามพลาสติก');
    expect(custShort('ร้านทดสอบ', 'บจก.')).toBe('ร้านทดสอบ');
  });
});

describe('มุมมองกระดาน (ST3-T13)', () => {
  const veh = (plate: string, o: Partial<BoardVehicle> = {}): BoardVehicle => ({
    id: `veh_${plate}`,
    plate,
    plateProvince: 'TH-10',
    vehicleTypeId: 'vty_6',
    vehicleTypeName: '6 ล้อ',
    capacityKg: '6000',
    ownership: 'OWN',
    carrierName: null,
    status: 'READY',
    driver: null,
    blocks: [],
    ...o,
  });
  const sub = (plate: string, carrierName: string) =>
    veh(plate, { ownership: 'SUBCONTRACT', carrierName });
  const drv = (name: string) => ({ id: `drv_${name}`, name, licenceClass: 'T2' });
  // ลำดับจาก server = "รถบริษัท + รถร่วม" (PLN-049)
  const rows = [
    veh('70-2222', { driver: drv('สมศักดิ์') }),
    veh('70-1111'),
    sub('10-9999', 'หจก. ข'),
    sub('10-5555', 'หจก. ก'),
    veh('70-3333', { driver: drv('กมล') }),
  ];
  const plates = (v: BoardVehicle[]) => v.map((x) => x.plate);

  it('FLEET (ค่าเริ่มต้น) = ลำดับ server ไม่เปลี่ยน', () => {
    expect(orderVehicles(rows, 'FLEET')).toBe(rows);
  });
  it('ตามรถ = เรียงทะเบียน', () => {
    expect(plates(orderVehicles(rows, 'VEHICLE'))).toEqual([
      '10-5555',
      '10-9999',
      '70-1111',
      '70-2222',
      '70-3333',
    ]);
  });
  it('ตามคนขับ = ชื่อคนขับประจำ ยังไม่กำหนดไว้ท้าย (ตามทะเบียน)', () => {
    expect(plates(orderVehicles(rows, 'DRIVER'))).toEqual([
      '70-3333',
      '70-2222',
      '10-5555',
      '10-9999',
      '70-1111',
    ]);
  });
  it('ตาม carrier = รถบริษัทก่อน แล้วตามชื่อรถร่วม', () => {
    expect(plates(orderVehicles(rows, 'CARRIER'))).toEqual([
      '70-1111',
      '70-2222',
      '70-3333',
      '10-5555',
      '10-9999',
    ]);
  });
  it('ตาม carrier ตัดสินด้วย ownership: รถร่วมไม่มีชื่อ = ท้ายกลุ่มรถร่วม · รถบริษัทที่มี carrierName ยังเป็นรถบริษัท', () => {
    const v = [
      sub('10-1111', 'หจก. ข'),
      veh('10-0000', { ownership: 'SUBCONTRACT', carrierName: null }),
      veh('70-9999', { carrierName: 'ข้อมูลเก่า' }),
      veh('70-0001'),
    ];
    expect(plates(orderVehicles(v, 'CARRIER'))).toEqual([
      '70-0001',
      '70-9999',
      '10-1111',
      '10-0000',
    ]);
  });
  it('การ์ด 7 วัน: เฉพาะ field ที่แสดงได้ · เลือกแค่ช่วงเวลา/เส้นทาง → เลข SO', () => {
    expect(weekFields(['ORDER_NO', 'CUSTOMER', 'TIME', 'ROUTE', 'WEIGHT'])).toEqual([
      'ORDER_NO',
      'CUSTOMER',
      'WEIGHT',
    ]);
    expect(weekFields(['TIME', 'WEIGHT'])).toEqual(['WEIGHT']);
    expect(weekFields(['TIME', 'ROUTE'])).toEqual(['ORDER_NO']);
  });
  it('สลับมุมมอง = ข้อมูลชุดเดียวกัน (ไม่เพิ่ม/ไม่ตัดแถว) และไม่แก้ array เดิม', () => {
    const before = plates(rows);
    for (const v of ['FLEET', 'VEHICLE', 'DRIVER', 'CARRIER'] as const)
      expect(plates(orderVehicles(rows, v)).sort()).toEqual([...before].sort());
    expect(plates(rows)).toEqual(before);
  });
  it('ข้อความการ์ดตาม field ที่เลือก', () => {
    const parts: Parameters<typeof cardLine>[1] = [
      ['TIME', '09:00–12:00'],
      ['ROUTE', 'บางนา → ชลบุรี'],
    ];
    expect(cardLine(['TIME', 'ROUTE'], parts)).toBe('09:00–12:00 · บางนา → ชลบุรี');
    expect(cardLine(['ROUTE'], parts)).toBe('บางนา → ชลบุรี');
    expect(cardLine(['ORDER_NO'], parts)).toBe('');
  });
});

describe('Filter รถที่รับได้สองทาง (ST3-T15)', () => {
  const item = (issues: EligItem['issues'], vehicleId = 'veh_2'): EligItem => ({
    vehicleId,
    orderId: null,
    tripId: 'trp_1',
    level: 'OK',
    issues,
  });
  const iss = (
    code: string,
    severity: 'block' | 'warning' | 'info',
    date: string | null = null,
  ) => ({ code, severity, message: code, date });
  it('ระดับต่อวัน: date null = ทุกวัน · info ไม่นับ · บล็อก > คำเตือน', () => {
    const it = item([
      iss('VEHICLE_LARGER_THAN_REQUESTED', 'info'),
      iss('OVERWEIGHT', 'warning'),
      iss('DOC_CMI_EXPIRED', 'block', '2026-11-18'),
    ]);
    expect(levelOn(it, D)).toBe('WARNING');
    expect(levelOn(it, '2026-11-18')).toBe('BLOCK');
    expect(levelOn(it, null)).toBe('BLOCK');
    expect(issuesOn(it, D).map((i) => i.code)).toEqual(['OVERWEIGHT']);
    expect(levelOn(item([iss('X', 'info')]), D)).toBe('OK');
  });
  it('วันของการ์ด SO: วันเดียว = วันนั้น · 7 วัน = กำหนดส่ง (ถ้าอยู่ในช่วง)', () => {
    const week = Array.from({ length: 7 }, (_, i) => addDays(D, i));
    expect(orderDay({ requestedDate: '2026-11-18' }, [D])).toBe(D);
    expect(orderDay({ requestedDate: '2026-11-18' }, week)).toBe('2026-11-18');
    expect(orderDay({ requestedDate: '2026-11-01' }, week)).toBe(D);
  });
  it('ย้ายไปรถอื่น: เฉพาะคันที่ผ่านทุกกฎ ไม่ใช่คันเดิม รับน้ำหนักได้ · ประเภทเดียวกันก่อน → ความจุพอดี', () => {
    const v = (id: string, vt: string, cap: string | null): BoardVehicle =>
      ({ id, plate: id, vehicleTypeId: vt, capacityKg: cap }) as BoardVehicle;
    const vs = [
      v('veh_1', 'vty_6', '6000'),
      v('veh_big', 'vty_6', '9000'),
      v('veh_fit', 'vty_6', '6000'),
      v('veh_10', 'vty_10', '5500'),
      v('veh_small', 'vty_6', '3000'),
      v('veh_bad', 'vty_6', '5400'),
    ];
    const ok = [
      ...vs.filter((x) => x.id !== 'veh_bad').map((x) => item([], x.id)),
      item([iss('DOC_MISSING', 'block')], 'veh_bad'),
    ];
    const t = trip({ weightKg: '5400' });
    expect(moveTarget(t, ok, vs)?.id).toBe('veh_fit');
    expect(
      moveTarget(
        t,
        ok,
        vs.filter((x) => x.vehicleTypeId !== 'vty_6' || x.id === 'veh_1'),
      )?.id,
    ).toBe('veh_10');
    expect(moveTarget(t, [item([], 'veh_small')], vs)).toBeNull();
    expect(moveTarget(t, [item([iss('OVERWEIGHT', 'warning')], 'veh_big')], vs)).toBeNull();
  });
});
