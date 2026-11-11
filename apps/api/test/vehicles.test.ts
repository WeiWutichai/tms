import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/** เลขผู้เสียภาษีนิติบุคคล (ขึ้นต้น 0, checksum ถูก) — ข้อมูลสมมติ */
function jurTax(n: number): string {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

/** ST2-T06 รถ — docs/04 B รถ + B2.1 ส่วน 1, docs/01 §3.2/§3.8, spec/06 FLT-A/FLT-O */
describe('รถ (vehicles)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let planner: string;
  let vt6: { id: string; payloadKg: number };
  let vtTractor: string;
  let carrier: string;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
    planner = await tokenFor(tenantId, 'master:read master:write export:run', 'user-planner');
    vt6 = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({
          name: '6 ล้อ ทดสอบ',
          vehicleClass: '6W',
          payloadKg: 6000,
          volumeCbm: 32,
          minLicenceClass: 'T2',
        })
        .expect(201)
    ).body;
    vtTractor = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({
          name: 'หัวลาก ทดสอบ',
          vehicleClass: 'SEMI_TRAILER',
          payloadKg: 30000,
          minLicenceClass: 'T3',
        })
        .expect(201)
    ).body.id;
    carrier = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: 'หจก. รถร่วมทดสอบ', entityType: 'JURISTIC', taxId: jurTax(1) })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const plate = () => `70-${String(++seed).padStart(4, '0')}`;
  const create = (extra: object = {}, token = admin) =>
    api(app, token)
      .post('/v1/vehicles')
      .send({
        plate: plate(),
        plateProvince: 'TH-10',
        vehicleTypeId: vt6.id,
        ownership: 'OWN',
        ...extra,
      });

  it('เกณฑ์ตรวจรับ: รถร่วม (SUBCONTRACT) ไม่ระบุ carrier → 422 · ระบุแล้วสร้างได้ · รถบริษัทห้ามมี carrier', async () => {
    const r = await create({ ownership: 'SUBCONTRACT' }).expect(422);
    expect(r.body.errors[0]).toMatchObject({ field: 'carrierId', code: 'required' });
    const ok = await create({ ownership: 'SUBCONTRACT', carrierId: carrier }).expect(201);
    expect(ok.body.carrier).toMatchObject({ id: carrier, name: 'หจก. รถร่วมทดสอบ' });
    expect(ok.body.status).toBe('ready');
    // ไม่ส่งน้ำหนัก/ปริมาตร = ค่าของประเภทรถ
    expect(ok.body.payloadKg).toBe(6000);
    expect(ok.body.volumeCbm).toBe(32);
    await create({ carrierId: carrier }).expect(422);
    // เปลี่ยนเป็นรถร่วมโดยไม่ระบุ carrier → 422 · เปลี่ยนกลับเป็นรถบริษัท = ล้าง carrier ให้
    const own = (await create().expect(201)).body;
    const p = await api(app, admin)
      .patch(`/v1/vehicles/${own.id}`)
      .send({ ownership: 'SUBCONTRACT' })
      .expect(422);
    expect(p.body.errors[0].field).toBe('carrierId');
    const back = await api(app, admin)
      .patch(`/v1/vehicles/${ok.body.id}`)
      .send({ ownership: 'OWN' })
      .expect(200);
    expect(back.body.carrier).toBeNull();
    // ผู้รับเหมาที่ถูกระงับเลือกใหม่ไม่ได้
    const c2 = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: 'หจก. ระงับแล้ว', entityType: 'JURISTIC', taxId: jurTax(2) })
        .expect(201)
    ).body.id;
    await api(app, admin)
      .post(`/v1/carriers/${c2}/deactivate`)
      .send({ reason: 'ทดสอบระงับผู้รับเหมา' })
      .expect(200);
    const s = await create({ ownership: 'SUBCONTRACT', carrierId: c2 }).expect(422);
    expect(s.body.errors[0]).toMatchObject({ field: 'carrierId', code: 'inactive' });
  });

  it('ทะเบียน + จังหวัดซ้ำไม่ได้ (ไม่สนช่องว่าง/ขีด) เว้นแต่คันเดิมปลดระวาง · รูปแบบผิด → 422', async () => {
    const a = (await create({ plate: '71-0457' }).expect(201)).body;
    const dup = await create({ plate: '71 0457' }).expect(409);
    expect(dup.body.existing).toMatchObject({ id: a.id, plate: '71-0457' });
    await create({ plate: '710457', plateProvince: 'TH-20' }).expect(201); // จังหวัดอื่นได้
    await create({ plate: 'ทะเบียน' }).expect(422);
    await create({ plateProvince: 'กทม.' }).expect(422);
    await api(app, admin)
      .post(`/v1/vehicles/${a.id}/status`)
      .send({ status: 'retired', reason: 'ขายรถให้บริษัทอื่นแล้ว' })
      .expect(200);
    const again = await create({ plate: '71-0457' }).expect(201);
    expect(again.body.id).not.toBe(a.id);
    // เลขตัวถังซ้ำ (ไม่สนตัวพิมพ์) → 409
    await create({ chassisNo: 'MPATFR86JMT000417' }).expect(201);
    const ch = await create({ chassisNo: 'mpatfr86jmt000417' }).expect(409);
    expect(ch.body.errors[0].field).toBe('chassisNo');
  });

  it('เกณฑ์ตรวจรับ: จับคู่หัวลาก–หางแล้วเห็นทั้งสองฝั่ง · ปลดคู่ · หางที่พ่วงหัวอื่นอยู่ → 409', async () => {
    const head = (await create({ vehicleTypeId: vtTractor, unitRole: 'TRACTOR' }).expect(201)).body;
    const trl = (await create({ vehicleTypeId: vtTractor, unitRole: 'TRAILER' }).expect(201)).body;
    const p = await api(app, admin)
      .patch(`/v1/vehicles/${head.id}`)
      .send({ pairedVehicleId: trl.id })
      .expect(200);
    expect(p.body.paired).toMatchObject({ id: trl.id, plate: trl.plate, unitRole: 'TRAILER' });
    const t1 = await api(app, admin).get(`/v1/vehicles/${trl.id}`).expect(200);
    expect(t1.body.paired).toMatchObject({ id: head.id, unitRole: 'TRACTOR' });
    expect(t1.body.version).toBe(trl.version + 1);
    const list = await api(app, admin).get('/v1/vehicles?unitRole=TRAILER').expect(200);
    expect(list.body.data.find((x: { id: string }) => x.id === trl.id).paired.id).toBe(head.id);
    // ประวัติของทั้งสองคันบันทึกการจับคู่
    const h = await api(app, admin).get(`/v1/vehicles/${trl.id}/history`).expect(200);
    expect(h.body.data[0].after).toMatchObject({ pairedVehicleId: head.id });

    // หัวที่สองจับหางเดิม → 409 พร้อมทะเบียนหัวที่พ่วงอยู่
    const head2 = (await create({ vehicleTypeId: vtTractor, unitRole: 'TRACTOR' }).expect(201))
      .body;
    const c = await api(app, admin)
      .patch(`/v1/vehicles/${head2.id}`)
      .send({ pairedVehicleId: trl.id })
      .expect(409);
    expect(c.body.errors[0].code).toBe('already_paired');
    expect(c.body.pairedWith.id).toBe(head.id);
    // บทบาทไม่ตรง (หัว + หัว, รถเดี่ยว) / ตัวเอง → 422
    await api(app, admin)
      .patch(`/v1/vehicles/${head2.id}`)
      .send({ pairedVehicleId: head.id })
      .expect(422);
    const self = await api(app, admin)
      .patch(`/v1/vehicles/${head2.id}`)
      .send({ pairedVehicleId: head2.id })
      .expect(422);
    expect(self.body.errors[0].code).toBe('pair_self');
    // เปลี่ยนบทบาทขณะจับคู่อยู่ → 422
    await api(app, admin).patch(`/v1/vehicles/${trl.id}`).send({ unitRole: 'SINGLE' }).expect(422);

    // หัวเดิมเปลี่ยนไปจับหางใหม่ → หางเดิมถูกปลดให้เอง
    const trl2 = (await create({ vehicleTypeId: vtTractor, unitRole: 'TRAILER' }).expect(201)).body;
    await api(app, admin)
      .patch(`/v1/vehicles/${head.id}`)
      .send({ pairedVehicleId: trl2.id })
      .expect(200);
    expect((await api(app, admin).get(`/v1/vehicles/${trl.id}`)).body.paired).toBeNull();
    expect((await api(app, admin).get(`/v1/vehicles/${trl2.id}`)).body.paired.id).toBe(head.id);

    // ปลดคู่จากฝั่งหาง → หัวก็ไม่มีคู่
    await api(app, admin)
      .patch(`/v1/vehicles/${trl2.id}`)
      .send({ pairedVehicleId: null })
      .expect(200);
    expect((await api(app, admin).get(`/v1/vehicles/${head.id}`)).body.paired).toBeNull();

    // สร้างพร้อมคู่ได้ · ปลดระวางหัว = ปลดคู่ทั้งสองฝั่ง
    const h3 = (
      await create({
        vehicleTypeId: vtTractor,
        unitRole: 'TRACTOR',
        pairedVehicleId: trl.id,
      }).expect(201)
    ).body;
    expect(h3.paired.id).toBe(trl.id);
    expect((await api(app, admin).get(`/v1/vehicles/${trl.id}`)).body.paired.id).toBe(h3.id);
    const r = await api(app, admin)
      .post(`/v1/vehicles/${h3.id}/status`)
      .send({ status: 'retired', reason: 'ปลดระวางหัวลากทดสอบ' })
      .expect(200);
    expect(r.body.paired).toBeNull();
    expect((await api(app, admin).get(`/v1/vehicles/${trl.id}`)).body.paired).toBeNull();
    // ฐานข้อมูลสองฝั่งตรงกันเสมอ (ไม่มีคู่ที่ชี้ข้างเดียว)
    const rows = await db.vehicle.findMany({ where: { tenantId, pairedVehicleId: { not: null } } });
    for (const x of rows) {
      const y = rows.find((z) => z.id === x.pairedVehicleId);
      expect(y?.pairedVehicleId).toBe(x.id);
    }
  });

  it('เกณฑ์ตรวจรับ: เลขไมล์ถอยหลังถูกปฏิเสธ (422) · ประวัติเลขไมล์ · แก้ค่าผิดต้องมีเหตุผล', async () => {
    const v = (await create({ odometerKm: 150000 }).expect(201)).body;
    expect(v.odometerKm).toBe(150000);
    expect(v.odometerSource).toBe('MANUAL');
    const back = await api(app, admin)
      .patch(`/v1/vehicles/${v.id}`)
      .send({ odometerKm: 149500 })
      .expect(422);
    expect(back.body.errors[0]).toMatchObject({ field: 'odometerKm', code: 'odometer_backwards' });
    const r1 = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/odometer`)
      .send({ readingKm: 149999 })
      .expect(422);
    expect(r1.body.errors[0].code).toBe('odometer_backwards');
    const up = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/odometer`)
      .send({ readingKm: 150120.5 })
      .expect(201);
    expect(up.body.reading).toMatchObject({
      readingKm: 150120.5,
      deltaKm: 120.5,
      status: 'ACCEPTED',
    });
    expect(up.body.vehicle.odometerKm).toBe(150120.5);
    // ย้อนหลัง (ออฟไลน์) เทียบกับค่าก่อน/หลังตามเวลา
    const past = new Date(Date.now() - 86400_000).toISOString();
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/odometer`)
      .send({ readingKm: 150500, readAt: past })
      .expect(422);
    // แก้ค่าผิด: ไม่มีเหตุผล → 422 · มีเหตุผล → ค่าเดิม SUPERSEDED + แถวใหม่อ้างแถวเดิม
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/odometer/correct`)
      .send({ readingKm: 150012 })
      .expect(422);
    const cor = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/odometer/correct`)
      .send({ readingKm: 150012, reasonType: 'TYPO', note: 'พิมพ์เลขผิดเกินมา 108 กม.' })
      .expect(200);
    expect(cor.body.vehicle.odometerKm).toBe(150012);
    expect(cor.body.reading.originalReadingId).toBe(up.body.reading.id);
    const list = await api(app, admin).get(`/v1/vehicles/${v.id}/odometer`).expect(200);
    expect(list.body.data.map((x: { status: string }) => x.status)).toEqual([
      'ACCEPTED',
      'SUPERSEDED',
      'ACCEPTED',
    ]);
    const h = await api(app, admin).get(`/v1/vehicles/${v.id}/history`).expect(200);
    expect(h.body.data[0]).toMatchObject({
      action: 'vehicle.odometer_corrected',
      reason: 'พิมพ์เลขผิดเกินมา 108 กม.',
    });
    // PATCH ค่ามากกว่าเดิมได้ → มีแถวประวัติเพิ่ม
    await api(app, admin).patch(`/v1/vehicles/${v.id}`).send({ odometerKm: 150300 }).expect(200);
    expect(
      (await api(app, admin).get(`/v1/vehicles/${v.id}/odometer`)).body.data[0].readingKm,
    ).toBe(150300);
  });

  it('สถานะ: state machine + เหตุผลบังคับ + doc_status_history · ปลดระวางย้อนไม่ได้ · มีเที่ยวค้างปลดระวางไม่ได้', async () => {
    const v = (await create().expect(201)).body;
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'parked' })
      .expect(422);
    const m = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'maintenance', reason: 'เข้าอู่เปลี่ยนคลัตช์ 3 วัน' })
      .expect(200);
    expect(m.body).toMatchObject({
      status: 'maintenance',
      statusReason: 'เข้าอู่เปลี่ยนคลัตช์ 3 วัน',
    });
    // ซ่อม → จอด ไม่มีใน spec → 409
    const bad = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'parked', reason: 'จอดพักไม่มีคนขับ' })
      .expect(409);
    expect(bad.body.code).toBe('invalid_state_transition');
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'ready', reason: 'ซ่อมเสร็จรับรถกลับแล้ว' })
      .expect(200);
    const hist = await db.docStatusHistory.findMany({
      where: { docType: 'vehicle', docId: tryDecodeId('vehicle', v.id)! },
      orderBy: { at: 'asc' },
    });
    expect(hist.map((x) => `${x.fromStatus}>${x.toStatus}`)).toEqual([
      'READY>MAINTENANCE',
      'MAINTENANCE>READY',
    ]);
    const ev = await db.domainEvent.findMany({
      where: { localId: tryDecodeId('vehicle', v.id)!, type: 'vehicle.status_changed' },
    });
    expect(ev).toHaveLength(2);

    // เที่ยวยังไม่จบ → ปลดระวางไม่ได้ (409 in_use_active)
    await db.trip.create({
      data: {
        tenantId,
        tripDate: new Date(),
        vehicleId: tryDecodeId('vehicle', v.id)!,
        status: 'ASSIGNED',
      },
    });
    const busy = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'retired', reason: 'ขายรถให้บริษัทอื่นแล้ว' })
      .expect(409);
    expect(busy.body.references).toEqual({ trips: 1 });
    // ถูกอ้างจากเที่ยวแล้ว → ลบไม่ได้ (ให้ปลดระวางแทน)
    const del = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/delete`)
      .send({ reason: 'ทดสอบลบรถที่มีเที่ยว' })
      .expect(409);
    expect(del.body).toMatchObject({ code: 'in_use', instead: 'retire', references: { trips: 1 } });
    await db.trip.updateMany({
      where: { vehicleId: tryDecodeId('vehicle', v.id)! },
      data: { status: 'COMPLETED' },
    });
    const ret = await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'retired', reason: 'ขายรถให้บริษัทอื่นแล้ว' })
      .expect(200);
    expect(ret.body.retiredAt).toBeTruthy();
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'ready', reason: 'ลองเอากลับมาใช้อีก' })
      .expect(409);

    // ไม่เคยถูกอ้างอิง → ลบได้ (soft) แล้วหาไม่เจอ
    const fresh = (await create({ externalId: 'ERP-V-DEL' }).expect(201)).body;
    await api(app, admin)
      .post(`/v1/vehicles/${fresh.id}/delete`)
      .send({ reason: 'กรอกซ้ำโดยไม่ตั้งใจ' })
      .expect(204);
    await api(app, admin).get(`/v1/vehicles/${fresh.id}`).expect(404);
    const row = await db.vehicle.findUnique({ where: { id: tryDecodeId('vehicle', fresh.id)! } });
    expect(row).toMatchObject({ externalId: null, deletedExternalId: 'ERP-V-DEL' });
  });

  it('ประเภทรถ (T04): ปิดใช้ไม่ได้เมื่อมีรถที่ไม่ปลดระวาง · ลบไม่ได้เมื่อมีรถ · ประเภทที่ปิดใช้เลือกใหม่ไม่ได้', async () => {
    const vt = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({
          name: '10 ล้อ ทดสอบ guard',
          vehicleClass: '10W',
          payloadKg: 15000,
          minLicenceClass: 'T2',
        })
        .expect(201)
    ).body;
    const v = (await create({ vehicleTypeId: vt.id }).expect(201)).body;
    const off = await api(app, admin)
      .post(`/v1/vehicle-types/${vt.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้ประเภทรถ' })
      .expect(409);
    expect(off.body).toMatchObject({ code: 'in_use_active', references: { vehicles: 1 } });
    expect((await api(app, admin).get(`/v1/vehicle-types/${vt.id}`)).body.usage.vehicles).toBe(1);
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'retired', reason: 'ปลดระวางเพื่อทดสอบ' })
      .expect(200);
    await api(app, admin)
      .post(`/v1/vehicle-types/${vt.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้ประเภทรถ' })
      .expect(200);
    const del = await api(app, admin)
      .post(`/v1/vehicle-types/${vt.id}/delete`)
      .send({ reason: 'ทดสอบลบประเภทรถ' })
      .expect(409);
    expect(del.body.references).toEqual({ vehicles: 1 });
    const pick = await create({ vehicleTypeId: vt.id }).expect(422);
    expect(pick.body.errors[0]).toMatchObject({ field: 'vehicleTypeId', code: 'inactive' });
  });

  it('รถร่วม (T05): ลบผู้รับเหมาที่มีรถ → 409 แยกรถใช้งาน/ปลดระวาง', async () => {
    const c = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: 'หจก. ลบไม่ได้', entityType: 'JURISTIC', taxId: jurTax(3) })
        .expect(201)
    ).body.id;
    const v = (await create({ ownership: 'SUBCONTRACT', carrierId: c }).expect(201)).body;
    expect((await api(app, admin).get(`/v1/carriers/${c}`)).body.usage.vehicles).toBe(1);
    const d1 = await api(app, admin)
      .post(`/v1/carriers/${c}/delete`)
      .send({ reason: 'ทดสอบลบผู้รับเหมา' })
      .expect(409);
    expect(d1.body.references).toEqual({ vehicles: 1 });
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'retired', reason: 'ผู้รับเหมาเลิกวิ่งงาน' })
      .expect(200);
    const d2 = await api(app, admin)
      .post(`/v1/carriers/${c}/delete`)
      .send({ reason: 'ทดสอบลบผู้รับเหมา' })
      .expect(409);
    expect(d2.body.references).toEqual({ retiredVehicles: 1 });
    const list = await api(app, admin)
      .get(`/v1/vehicles?carrierId=${c}&status=retired`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('ข้อมูลการเงินรถ: เห็น/แก้เฉพาะ reports.finance:read · ค่าเสื่อมต้องมีราคาซื้อ + ปี · numeric(14,2)', async () => {
    const v = (
      await create({
        purchaseCost: '2400000.00',
        purchasedOn: '2021-11-04',
        depreciationMethod: 'STRAIGHT_LINE',
        depreciationYears: 10,
        salvageValue: '400000',
      }).expect(201)
    ).body;
    expect(v).toMatchObject({
      purchaseCost: '2400000.00',
      salvageValue: '400000.00',
      purchasedOn: '2021-11-04',
    });
    const pv = await api(app, planner).get(`/v1/vehicles/${v.id}`).expect(200);
    expect(pv.body).not.toHaveProperty('purchaseCost');
    const ph = await api(app, planner).get(`/v1/vehicles/${v.id}/history`).expect(200);
    expect(ph.body.data[0].after).not.toHaveProperty('purchaseCost');
    await api(app, planner)
      .patch(`/v1/vehicles/${v.id}`)
      .send({ purchaseCost: '1.00' })
      .expect(403);
    await api(app, planner).patch(`/v1/vehicles/${v.id}`).send({ color: 'ขาว' }).expect(200);
    await create({ depreciationMethod: 'STRAIGHT_LINE', depreciationYears: 5 }).expect(422);
    await create({
      purchaseCost: '100.00',
      depreciationMethod: 'STRAIGHT_LINE',
      depreciationYears: 5,
      salvageValue: '200',
    }).expect(422);
    await create({ purchaseCost: '1.234' }).expect(422);
    await create({ purchaseCost: 1000 }).expect(422);
  });

  it('ตรวจข้ามช่อง: น้ำหนักบรรทุก ≤ รวม − เปล่า, GPS ต้องมีค่าย + ห้ามซ้ำ, ปี, null บนช่องบังคับ → 422', async () => {
    await create({ tareWeightKg: 3300, grossWeightKg: 9500, payloadKg: 7000 }).expect(422);
    await create({ tareWeightKg: 3300, grossWeightKg: 9500, payloadKg: 6000 }).expect(201);
    await create({ gpsDeviceId: '356938035643809' }).expect(422);
    await create({ gpsProvider: 'Cartrack', gpsDeviceId: '356938035643809' }).expect(201);
    const g = await create({ gpsProvider: 'cartrack', gpsDeviceId: '356938035643809' }).expect(409);
    expect(g.body.errors[0].field).toBe('gpsDeviceId');
    await create({ year: new Date().getFullYear() + 3 }).expect(422);
    await create({ fuelType: 'B7' }).expect(422);
    const v = (await create().expect(201)).body;
    await api(app, admin).patch(`/v1/vehicles/${v.id}`).send({ plate: null }).expect(422);
    await api(app, admin).patch(`/v1/vehicles/${v.id}`).send({ payloadKg: null }).expect(422);
  });

  it('PATCH If-Match → 412 · ส่งค่าเดิมไม่เพิ่ม version · PUT external idempotent · ext:{id}', async () => {
    const v = (await create({ brand: 'Isuzu' }).expect(201)).body;
    await api(app, admin)
      .patch(`/v1/vehicles/${v.id}`)
      .set('If-Match', `"${v.version + 5}"`)
      .send({ brand: 'Hino' })
      .expect(412);
    const same = await api(app, admin)
      .patch(`/v1/vehicles/${v.id}`)
      .send({ brand: 'Isuzu' })
      .expect(200);
    expect(same.body.version).toBe(v.version);
    const body = {
      plate: plate(),
      plateProvince: 'TH-11',
      vehicleTypeId: vt6.id,
      ownership: 'OWN',
      brand: 'Hino',
    };
    const a = await api(app, admin).put('/v1/vehicles/external/ERP-V-1').send(body).expect(201);
    const b = await api(app, admin).put('/v1/vehicles/external/ERP-V-1').send(body).expect(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.version).toBe(a.body.version);
    expect((await api(app, admin).get('/v1/vehicles/ext:ERP-V-1').expect(200)).body.id).toBe(
      a.body.id,
    );
  });

  it('รายการ: เรียงตามทะเบียน + cursor, ค้นทะเบียนไม่สนขีด, กรองเจ้าของ/สถานะ · สรุป + โควตา (soft limit) · export', async () => {
    const t2 = (await createTenant(db)).id;
    const tok = await tokenFor(t2);
    const vt = (
      await api(app, tok)
        .post('/v1/vehicle-types')
        .send({ name: '6 ล้อ', vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' })
        .expect(201)
    ).body.id;
    await db.tenant.update({ where: { id: t2 }, data: { vehicleQuota: 2 } });
    for (const p of ['82-4410', '70-7781', '71-0001'])
      await api(app, tok)
        .post('/v1/vehicles')
        .send({ plate: p, plateProvince: 'TH-10', vehicleTypeId: vt, ownership: 'OWN' })
        .expect(201); // เกินโควตาก็เพิ่มได้ (soft limit — PLT-080)
    const p1 = await api(app, tok).get('/v1/vehicles?limit=2').expect(200);
    expect(p1.body.data.map((x: { plate: string }) => x.plate)).toEqual(['70-7781', '71-0001']);
    const p2 = await api(app, tok)
      .get(`/v1/vehicles?limit=2&cursor=${p1.body.nextCursor}`)
      .expect(200);
    expect(p2.body.data.map((x: { plate: string }) => x.plate)).toEqual(['82-4410']);
    const s1 = await api(app, tok).get('/v1/vehicles?plate=7077').expect(200);
    expect(s1.body.data).toHaveLength(1);
    expect((await api(app, tok).get('/v1/vehicles?q=82 4410')).body.data).toHaveLength(1);
    expect((await api(app, tok).get('/v1/vehicles?ownership=SUBCONTRACT')).body.data).toHaveLength(
      0,
    );
    const sum = await api(app, tok).get('/v1/vehicles/summary').expect(200);
    expect(sum.body).toMatchObject({
      total: 3,
      ready: 3,
      retired: 0,
      quota: { limit: 2, used: 3 },
    });
    const csv = await api(app, tok).get('/v1/vehicles/export?format=csv').expect(200);
    expect(csv.text).toContain('70-7781');
    expect(csv.text).toContain('กทม.');
    // tenant อื่นมองไม่เห็นรถ / ใช้ประเภทรถของ tenant อื่นไม่ได้
    expect((await api(app, admin).get('/v1/vehicles?plate=7077')).body.data).toHaveLength(0);
    await create({ vehicleTypeId: vt }).expect(422);
  });

  it('review: รถที่ลบ (soft) ไม่นับเป็นรถที่ใช้งาน — ปิดใช้ประเภทรถ/ลบผู้รับเหมา/usage/setup checklist', async () => {
    const vt = (
      await api(app, admin)
        .post('/v1/vehicle-types')
        .send({ name: 'ประเภทลบแล้ว', vehicleClass: '6W', payloadKg: 5000, minLicenceClass: 'T2' })
        .expect(201)
    ).body;
    const c = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: 'หจก. รถลบแล้ว', entityType: 'JURISTIC', taxId: jurTax(9) })
        .expect(201)
    ).body.id;
    const v = (
      await create({ vehicleTypeId: vt.id, ownership: 'SUBCONTRACT', carrierId: c }).expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/delete`)
      .send({ reason: 'กรอกซ้ำโดยไม่ตั้งใจ' })
      .expect(204);
    expect((await api(app, admin).get(`/v1/vehicle-types/${vt.id}`)).body.usage.vehicles).toBe(0);
    expect((await api(app, admin).get(`/v1/carriers/${c}`)).body.usage.vehicles).toBe(0);
    await api(app, admin)
      .post(`/v1/vehicle-types/${vt.id}/deactivate`)
      .send({ reason: 'ทดสอบปิดใช้หลังลบรถ' })
      .expect(200);
    await api(app, admin)
      .post(`/v1/carriers/${c}/delete`)
      .send({ reason: 'ทดสอบลบผู้รับเหมาหลังลบรถ' })
      .expect(204);
  });

  it('review: ทะเบียน — เลขไทย, จังหวัดในช่องทะเบียน, ละติน/เลขล้วน, ค้นไม่ตรงรหัสจังหวัด', async () => {
    const a = (await create({ plate: '74-8801', plateProvince: 'TH-10' }).expect(201)).body;
    const dup = await create({ plate: '๗๔-๘๘๐๑', plateProvince: 'TH-10' }).expect(409);
    expect(dup.body.existing.id).toBe(a.id);
    const th = (await create({ plate: '๗๔-๘๘๐๒' }).expect(201)).body;
    expect(th.plate).toBe('74-8802');
    for (const bad of ['80-1234 กทม', '80-1234 กทม.', 'กทม.', 'ชลบุรี'])
      expect((await create({ plate: bad }).expect(422)).body.errors[0].code).toBe(
        'plate_has_province',
      );
    for (const bad of ['AB-1234', '0812345678', '12'])
      expect((await create({ plate: bad }).expect(422)).body.errors[0].code).toBe('plate_format');
    await create({ plate: '1กข 1234' }).expect(201);
    await create({ plate: '72-11' }).expect(201);
    // ค้นทะเบียนไม่ไปตรงกับรหัสจังหวัด TH-10
    expect((await api(app, admin).get('/v1/vehicles?plate=TH')).body.data).toHaveLength(0);
    expect((await api(app, admin).get('/v1/vehicles?q=TH-10')).body.data).toHaveLength(0);
    expect((await api(app, admin).get('/v1/vehicles?plate=๗๔๘๘๐๑')).body.data).toHaveLength(1);
    // เลขตัวถัง normalize: MNT-123ABC = MNT123ABC
    await create({ chassisNo: 'MNT-123ABC' }).expect(201);
    expect((await create({ chassisNo: 'mnt 123abc' }).expect(409)).body.errors[0].field).toBe(
      'chassisNo',
    );
  });

  it('review: น้ำหนักบรรทุกจากประเภทรถถูกตรวจกับน้ำหนักรวม − เปล่า · ปี ≥ 1980 · วันซื้อไม่เป็นอนาคต', async () => {
    // ประเภท 6 ล้อ 6,000 กก. แต่รวม − เปล่า = 5,700
    const r = await create({ tareWeightKg: 3300, grossWeightKg: 9000 }).expect(422);
    expect(r.body.errors[0]).toMatchObject({ field: 'payloadKg', code: 'payload_over_gvw' });
    await create({ year: 1979 }).expect(422);
    await create({ year: 1980 }).expect(201);
    const next = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    expect((await create({ purchasedOn: next }).expect(422)).body.errors[0].code).toBe('future');
  });

  it('review: เลขไมล์ 5 ค่าพร้อมกัน (ไม่ส่ง If-Match) รับครบและเรียงถูก · ส่ง If-Match ผิด → 412', async () => {
    const base = Date.now() - 10 * 60_000;
    const w = (await create().expect(201)).body;
    const res2 = await Promise.all(
      [5, 3, 1, 4, 2].map((i) =>
        api(app, admin)
          .post(`/v1/vehicles/${w.id}/odometer`)
          .send({ readingKm: 1000 + i * 100, readAt: new Date(base + i * 60_000).toISOString() }),
      ),
    );
    expect(res2.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const list = (await api(app, admin).get(`/v1/vehicles/${w.id}/odometer`)).body.data;
    expect(list.map((x: { readingKm: number }) => x.readingKm)).toEqual([
      1500, 1400, 1300, 1200, 1100,
    ]);
    const g = await api(app, admin).get(`/v1/vehicles/${w.id}`).expect(200);
    expect(g.body.odometerKm).toBe(1500);
    await api(app, admin)
      .post(`/v1/vehicles/${w.id}/odometer`)
      .set('If-Match', `"${g.body.version - 1}"`)
      .send({ readingKm: 1600 })
      .expect(412);
  });

  it('review: แก้เลขไมล์ — เลือกแถว, ตรวจกับค่าก่อน/หลัง เว้นแต่เปลี่ยนเรือนไมล์ · source MANUAL', async () => {
    const w = (await create().expect(201)).body;
    const t0 = Date.now() - 3 * 3600_000;
    const ids: string[] = [];
    for (const [i, km] of [
      [0, 10000],
      [1, 10500],
      [2, 11000],
    ] as const)
      ids.push(
        (
          await api(app, admin)
            .post(`/v1/vehicles/${w.id}/odometer`)
            .send({ readingKm: km, readAt: new Date(t0 + i * 3600_000).toISOString() })
            .expect(201)
        ).body.reading.id,
      );
    const note = 'กรอกเลขผิดจากใบเสร็จน้ำมัน';
    // แก้แถวกลางให้ต่ำกว่าแถวแรก → 422
    await api(app, admin)
      .post(`/v1/vehicles/${w.id}/odometer/correct`)
      .send({ readingId: ids[1], readingKm: 9000, reasonType: 'TYPO', note })
      .expect(422);
    const ok = await api(app, admin)
      .post(`/v1/vehicles/${w.id}/odometer/correct`)
      .send({ readingId: ids[1], readingKm: 10400, reasonType: 'TYPO', note })
      .expect(200);
    expect(ok.body.reading).toMatchObject({ source: 'MANUAL', originalReadingId: ids[1] });
    expect(ok.body.vehicle.odometerKm).toBe(11000);
    // แถวที่ถูกแทนแล้วแก้ซ้ำไม่ได้
    await api(app, admin)
      .post(`/v1/vehicles/${w.id}/odometer/correct`)
      .send({ readingId: ids[1], readingKm: 10450, reasonType: 'TYPO', note })
      .expect(422);
    // เปลี่ยนเรือนไมล์: ค่าล่าสุดลดได้
    const m = await api(app, admin)
      .post(`/v1/vehicles/${w.id}/odometer/correct`)
      .send({ readingKm: 5, reasonType: 'METER_REPLACED', note: 'เปลี่ยนเรือนไมล์ใหม่ที่อู่' })
      .expect(200);
    expect(m.body.vehicle.odometerKm).toBe(5);
  });

  it('review: รถปลดระวางอ่านอย่างเดียว (PATCH/เลขไมล์ → 409) · แก้เฉพาะข้อมูลการเงินไม่ออก event/ไม่เห็นในประวัติของผู้ไม่มีสิทธิ์', async () => {
    const v = (await create({ purchaseCost: '1000000.00' }).expect(201)).body;
    const ev0 = await db.domainEvent.count({
      where: { localId: tryDecodeId('vehicle', v.id)!, type: 'vehicle.updated' },
    });
    await api(app, admin)
      .patch(`/v1/vehicles/${v.id}`)
      .send({ purchaseCost: '1200000.00' })
      .expect(200);
    expect(
      await db.domainEvent.count({
        where: { localId: tryDecodeId('vehicle', v.id)!, type: 'vehicle.updated' },
      }),
    ).toBe(ev0);
    const ph = await api(app, planner).get(`/v1/vehicles/${v.id}/history`).expect(200);
    expect(ph.body.data.map((x: { action: string }) => x.action)).toEqual(['vehicle.created']);
    const ah = await api(app, admin).get(`/v1/vehicles/${v.id}/history`).expect(200);
    expect(ah.body.data[0].action).toBe('vehicle.updated');

    await api(app, admin)
      .post(`/v1/vehicles/${v.id}/status`)
      .send({ status: 'retired', reason: 'ขายรถให้บริษัทอื่นแล้ว' })
      .expect(200);
    await api(app, admin).patch(`/v1/vehicles/${v.id}`).send({ color: 'แดง' }).expect(409);
    await api(app, admin).post(`/v1/vehicles/${v.id}/odometer`).send({ readingKm: 10 }).expect(409);
  });

  it('review: สร้างรถเกินโควตา → quotaExceeded + Warning header (ยังสร้างได้)', async () => {
    const t3 = (await createTenant(db)).id;
    const tok = await tokenFor(t3);
    const vt = (
      await api(app, tok)
        .post('/v1/vehicle-types')
        .send({ name: '6 ล้อ', vehicleClass: '6W', payloadKg: 6000, minLicenceClass: 'T2' })
        .expect(201)
    ).body.id;
    await db.tenant.update({ where: { id: t3 }, data: { vehicleQuota: 1 } });
    const body = (p: string) => ({
      plate: p,
      plateProvince: 'TH-10',
      vehicleTypeId: vt,
      ownership: 'OWN',
    });
    const a = await api(app, tok).post('/v1/vehicles').send(body('70-0001')).expect(201);
    expect(a.body.quotaExceeded).toBe(false);
    expect(a.headers.warning).toBeUndefined();
    const b = await api(app, tok).post('/v1/vehicles').send(body('70-0002')).expect(201);
    expect(b.body.quotaExceeded).toBe(true);
    expect(b.headers.warning).toContain('quota');
  });

  it('Defect ST2-T08 review: แก้เฉพาะวันที่ซื้อ (purchasedOn) ต้องบันทึก — ไม่ใช่ no-op', async () => {
    const v = (await create({ purchasedOn: '2021-11-04', purchaseCost: '1500000.00' }).expect(201))
      .body;
    const r = await api(app, admin)
      .patch(`/v1/vehicles/${v.id}`)
      .set('If-Match', `"${v.version}"`)
      .send({ purchasedOn: '2021-12-01' })
      .expect(200);
    expect(r.body.purchasedOn).toBe('2021-12-01');
    expect(r.body.version).toBe(v.version + 1);
    const same = await api(app, admin)
      .patch(`/v1/vehicles/${v.id}`)
      .send({ purchasedOn: '2021-12-01' })
      .expect(200);
    expect(same.body.version).toBe(r.body.version);
  });
});
