import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldCipher } from '../src/common/crypto';
import { tryDecodeId } from '../src/common/ids';
import { licenceStatus, phoneNorm } from '../src/modules/drivers/drivers.service';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/** เลขบัตรประชาชน (checksum ถูก ขึ้นต้น 3) — ข้อมูลสมมติ */
const nid = (n: number) => validTaxId(3_100_600_000 + n);
const NID = nid(1);

/** ST2-T08 คนขับ — docs/04 B คนขับ, docs/01 §3.2, spec/06 FLT-P, spec/11 NFR-153/304 */
describe('คนขับ (drivers)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 0;
  let carrierA: string;
  let carrierB: string;
  let ownVeh: string;
  let subVehA: string;
  let subVehB: string;
  let trailer: string;
  let retired: string;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
    const car = async (name: string, n: number) =>
      (
        await api(app, admin)
          .post('/v1/carriers')
          .send({ legalName: name, entityType: 'JURISTIC', taxId: jur(n) })
          .expect(201)
      ).body.id as string;
    carrierA = await car('หจก. ผู้รับเหมาเอ', 1);
    carrierB = await car('หจก. ผู้รับเหมาบี', 2);
    const vtype = async (b: object) =>
      (await api(app, admin).post('/v1/vehicle-types').send(b).expect(201)).body.id as string;
    const typeId = await vtype({
      name: '6 ล้อ ทดสอบ',
      vehicleClass: '6W',
      payloadKg: 6000,
      minLicenceClass: 'T2',
    });
    const semiId = await vtype({
      name: 'หัวลาก ทดสอบ',
      vehicleClass: 'SEMI_TRAILER',
      payloadKg: 30000,
      minLicenceClass: 'T3',
    });
    const veh = async (plate: string, extra: object = {}) =>
      (
        await api(app, admin)
          .post('/v1/vehicles')
          .send({
            plate,
            plateProvince: 'TH-10',
            vehicleTypeId: typeId,
            ownership: 'OWN',
            ...extra,
          })
          .expect(201)
      ).body.id as string;
    ownVeh = await veh('70-1001');
    subVehA = await veh('70-1002', { ownership: 'SUBCONTRACT', carrierId: carrierA });
    subVehB = await veh('70-1003', { ownership: 'SUBCONTRACT', carrierId: carrierB });
    trailer = await veh('70-1004', { vehicleTypeId: semiId, unitRole: 'TRAILER' });
    retired = await veh('70-1005');
    const r = await api(app, admin).get(`/v1/vehicles/${retired}`).expect(200);
    await api(app, admin)
      .post(`/v1/vehicles/${retired}/status`)
      .set('If-Match', `"${r.body.version}"`)
      .send({ status: 'retired', reason: 'ขายรถออกไปแล้ว ทดสอบ' })
      .expect(200);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  function jur(n: number): string {
    const base = `0105${String(70_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  }
  const body = (extra: object = {}) => {
    const n = ++seed;
    return {
      name: `คนขับทดสอบ ${n}`,
      phone: `081-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2028-03-31',
      ...extra,
    };
  };
  const create = (b: object, token = admin) => api(app, token).post('/v1/drivers').send(b);
  const newDriver = async (extra: object = {}) => (await create(body(extra)).expect(201)).body;
  const patch = (d: { id: string; version: number }, b: object) =>
    api(app, admin).patch(`/v1/drivers/${d.id}`).set('If-Match', `"${d.version}"`).send(b);
  const raw = (id: string) =>
    db.$queryRaw<
      {
        national_id_enc: string | null;
        national_id_last4: string | null;
        national_id_hash: string | null;
        phone_norm: string;
      }[]
    >`SELECT national_id_enc, national_id_last4, national_id_hash, phone_norm
        FROM driver WHERE id = ${tryDecodeId('driver', id)!}::uuid`.then((r) => r[0]!);

  it('เกณฑ์ตรวจรับ: เลขบัตรประชาชนเข้ารหัสใน DB และไม่แสดงเต็มใน API (response/list/history/event/export)', async () => {
    const r = await create(
      body({ nationalId: `${NID.slice(0, 1)}-${NID.slice(1)}`, licenceNo: '58001234' }),
    ).expect(201);
    expect(r.body).toMatchObject({
      code: 'DRV-0001',
      nationalIdLast4: NID.slice(-4),
      licenceNo: '58001234',
      licenceClass: 'T2',
      licenceExpiresOn: '2028-03-31',
      licenceStatus: 'valid',
      employmentType: 'EMPLOYEE_SALARIED',
      carrier: null,
      defaultVehicle: null,
      status: 'active',
    });
    expect(r.body.id).toMatch(/^drv_[0-9a-f]{32}$/);
    expect(r.headers.etag).toBe('"1"');
    expect(JSON.stringify(r.body)).not.toContain(NID);
    // ใน DB: ciphertext ถอดด้วย key ของระบบได้เลขเดิม + blind index (ไม่ใช่เลขเต็ม)
    const row = await raw(r.body.id);
    expect(row.national_id_enc).not.toContain(NID);
    expect(new FieldCipher().decrypt(row.national_id_enc!)).toBe(NID);
    expect(row.national_id_last4).toBe(NID.slice(-4));
    expect(row.national_id_hash).toMatch(/^v1:[0-9a-f]{64}$/);
    const all = await db.$queryRaw<{ t: string }[]>`SELECT row_to_json(d)::text AS t FROM driver d`;
    expect(all.map((x) => x.t).join()).not.toContain(NID);

    const list = await api(app, admin).get('/v1/drivers').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(NID);
    await patch(r.body, { nationalId: nid(2) }).expect(200);
    const h = await api(app, admin).get(`/v1/drivers/${r.body.id}/history`).expect(200);
    expect(JSON.stringify(h.body)).not.toContain(NID);
    expect(JSON.stringify(h.body)).not.toContain(nid(2));
    expect(JSON.stringify(h.body)).toContain(`•••• ${nid(2).slice(-4)}`);
    const ev = await db.domainEvent.findMany({ where: { entityType: 'driver' } });
    expect(ev.map((e) => e.type)).toEqual(
      expect.arrayContaining(['driver.created', 'driver.updated']),
    );
    expect(JSON.stringify(ev)).not.toContain(NID);
    expect(JSON.stringify(ev)).not.toContain(nid(2));
    const x = await api(app, admin).get('/v1/drivers/export').query({ format: 'csv' }).expect(200);
    expect(x.text).toContain(`•••• ${nid(2).slice(-4)}`);
    expect(x.text).not.toContain(nid(2));
    // ค้นด้วย 4 หลักท้ายได้ · ค้นด้วยเลขเต็มไม่เจอ (ไม่มีเลขเต็มให้เทียบ)
    const q4 = await api(app, admin)
      .get('/v1/drivers')
      .query({ q: nid(2).slice(-4) })
      .expect(200);
    expect(q4.body.data.map((d: { id: string }) => d.id)).toContain(r.body.id);
  });

  it('เลขบัตร: checksum ผิด / ขึ้นต้น 0 → 422 · ซ้ำกับคนขับที่ใช้งาน → 409 (blind index) · ปิดใช้งานแล้วใช้ซ้ำได้', async () => {
    await create(body({ nationalId: '3100600000000' })).expect(422);
    const r0 = await create(body({ nationalId: jur(9) })).expect(422);
    expect(r0.body.errors[0]).toMatchObject({ field: 'nationalId' });
    const a = await newDriver({ nationalId: nid(10) });
    const dup = await create(
      body({ nationalId: `${nid(10).slice(0, 5)} ${nid(10).slice(5)}` }),
    ).expect(409);
    expect(dup.body.code).toBe('duplicate');
    expect(dup.body.errors[0]).toMatchObject({ field: 'nationalId', code: 'duplicate' });
    expect(dup.body.existing).toMatchObject({ id: a.id, code: a.code });
    expect(JSON.stringify(dup.body)).not.toContain(nid(10));
    // ปิดใช้งานคนเดิม → สร้าง record ใหม่ด้วยเลขเดิมได้ (เปลี่ยนสังกัด = ปิด record เดิม สร้างใหม่ — FLT-P)
    const off = await api(app, admin)
      .post(`/v1/drivers/${a.id}/status`)
      .set('If-Match', `"${a.version}"`)
      .send({ status: 'inactive', reason: 'ลาออกแล้ว ย้ายไปผู้รับเหมา' })
      .expect(200);
    const b = await newDriver({ nationalId: nid(10), phone: a.phone });
    // เปิดใช้คนเดิมกลับมาไม่ได้ เพราะเบอร์/เลขบัตรชนกับคนที่ใช้งาน → 409
    const back = await api(app, admin)
      .post(`/v1/drivers/${a.id}/status`)
      .set('If-Match', `"${off.body.version}"`)
      .send({ status: 'active', reason: 'กลับมาทำงานกับบริษัท' })
      .expect(409);
    expect(back.body.existing).toMatchObject({ id: b.id });
  });

  it('เบอร์: normalize (+66 = 0) และห้ามซ้ำ → 409 · รูปแบบผิด → 422', async () => {
    expect(phoneNorm('+66 81-234-5678')).toBe('0812345678');
    expect(phoneNorm('02-123-4567')).toBe('021234567');
    const a = await newDriver({ phone: '089-555-0001' });
    expect((await raw(a.id)).phone_norm).toBe('0895550001');
    const d = await create(body({ phone: '+66895550001' })).expect(409);
    expect(d.body.errors[0]).toMatchObject({ field: 'phone', code: 'duplicate' });
    await create(body({ phone: '12345' })).expect(422);
    await create(body({ phone: '0812' })).expect(422);
    const { phone: _p, ...noPhone } = body();
    await create(noPhone).expect(422);
  });

  it('เกณฑ์ตรวจรับ: คนขับรถร่วมต้องผูกผู้รับเหมา · คนขับบริษัทผูกไม่ได้', async () => {
    const r = await create(body({ employmentType: 'CARRIER_DRIVER' })).expect(422);
    expect(r.body.errors[0]).toMatchObject({ field: 'carrierId', code: 'carrier_required' });
    const r2 = await create(body({ carrierId: carrierA })).expect(422);
    expect(r2.body.errors[0]).toMatchObject({ field: 'carrierId', code: 'carrier_not_allowed' });
    await create(
      body({ employmentType: 'CARRIER_DRIVER', carrierId: 'car_' + '0'.repeat(32) }),
    ).expect(422);
    const c = await newDriver({ employmentType: 'CARRIER_DRIVER', carrierId: carrierA });
    expect(c.carrier).toMatchObject({ id: carrierA, legalName: 'หจก. ผู้รับเหมาเอ' });
    // ล้างผู้รับเหมาของคนขับรถร่วม → 422 · เปลี่ยนเป็นคนขับบริษัท → ล้างผู้รับเหมาให้
    await patch(c, { carrierId: null }).expect(422);
    const e = await patch(c, { employmentType: 'EMPLOYEE_PER_TRIP' }).expect(200);
    expect(e.body).toMatchObject({ employmentType: 'EMPLOYEE_PER_TRIP', carrier: null });
    await patch(e.body, { employmentType: 'CARRIER_DRIVER' }).expect(422);
    // DB บังคับด้วย (CHECK ทั้งสองทาง)
    await expect(
      db.driver.update({
        where: { id: tryDecodeId('driver', e.body.id)! },
        data: { carrierId: tryDecodeId('carrier', carrierA)! },
      }),
    ).rejects.toThrow(/driver_employee_no_carrier/);
    // ผู้รับเหมาที่ระงับชั่วคราว → เลือกไม่ได้
    const cb = await api(app, admin).get(`/v1/carriers/${carrierB}`).expect(200);
    await api(app, admin)
      .post(`/v1/carriers/${carrierB}/deactivate`)
      .set('If-Match', `"${cb.body.version}"`)
      .send({ reason: 'ระงับชั่วคราวเพื่อทดสอบ' })
      .expect(200);
    const s = await create(body({ employmentType: 'CARRIER_DRIVER', carrierId: carrierB })).expect(
      422,
    );
    expect(s.body.errors[0]).toMatchObject({ field: 'carrierId', code: 'inactive' });
    await api(app, admin)
      .post(`/v1/carriers/${carrierB}/activate`)
      .set('If-Match', `"${cb.body.version + 1}"`)
      .send({})
      .expect(200);
    // ผู้รับเหมาที่มีคนขับ → ลบไม่ได้ (นับใน usage ด้วย)
    await newDriver({ employmentType: 'CARRIER_DRIVER', carrierId: carrierA });
    expect(
      (await api(app, admin).get(`/v1/carriers/${carrierA}`).expect(200)).body.usage.drivers,
    ).toBe(1);
    const del = await api(app, admin)
      .post(`/v1/carriers/${carrierA}/delete`)
      .send({ reason: 'ลบเพื่อทดสอบการอ้างอิง' })
      .expect(409);
    expect(del.body.references, JSON.stringify(del.body)).toMatchObject({ drivers: 1 });
  });

  it('รถประจำ: คนขับรถร่วม = รถของผู้รับเหมาเดียวกัน · คนขับบริษัท = รถบริษัท · ไม่ใช่หาง/ปลดระวาง', async () => {
    const e = await newDriver({ defaultVehicleId: ownVeh });
    expect(e.defaultVehicle).toMatchObject({
      id: ownVeh,
      plate: '70-1001',
      plateProvince: 'TH-10',
    });
    const code = async (b: object) => (await create(body(b)).expect(422)).body.errors[0].code;
    expect(await code({ defaultVehicleId: subVehA })).toBe('vehicle_not_own');
    expect(await code({ defaultVehicleId: trailer })).toBe('vehicle_trailer');
    expect(await code({ defaultVehicleId: retired })).toBe('vehicle_retired');
    expect(await code({ defaultVehicleId: 'veh_' + '0'.repeat(32) })).toBe('not_found');
    const sub = { employmentType: 'CARRIER_DRIVER', carrierId: carrierA };
    expect(await code({ ...sub, defaultVehicleId: subVehB })).toBe('vehicle_other_carrier');
    expect(await code({ ...sub, defaultVehicleId: ownVeh })).toBe('vehicle_other_carrier');
    const c = await newDriver({ ...sub, defaultVehicleId: subVehA });
    expect(c.defaultVehicle.id).toBe(subVehA);
    // เปลี่ยนผู้รับเหมาโดยรถเดิมไม่ตรง → 422 · เปลี่ยนพร้อมรถใหม่ → ผ่าน
    expect((await patch(c, { carrierId: carrierB }).expect(422)).body.errors[0].code).toBe(
      'vehicle_other_carrier',
    );
    const m = await patch(c, { carrierId: carrierB, defaultVehicleId: subVehB }).expect(200);
    expect(m.body.defaultVehicle.id).toBe(subVehB);
    await patch(m.body, { defaultVehicleId: null }).expect(200);
    // กรองตามรถประจำ + รถที่เป็นรถประจำลบไม่ได้
    const f = await api(app, admin)
      .get('/v1/drivers')
      .query({ defaultVehicleId: ownVeh })
      .expect(200);
    expect(f.body.data.map((d: { id: string }) => d.id)).toEqual([e.id]);
    const del = await api(app, admin)
      .post(`/v1/vehicles/${ownVeh}/delete`)
      .send({ reason: 'ลบเพื่อทดสอบการอ้างอิง' })
      .expect(409);
    expect(del.body.references.drivers).toBe(1);
  });

  it('สถานะใบขับขี่: valid / expiring ≤ 60 / expired / missing + ตัวกรอง licenceAlert (30 วัน) + summary', async () => {
    expect(licenceStatus('2026-12-31', '2026-11-01')).toEqual({ status: 'expiring', days: 60 });
    expect(licenceStatus('2027-01-01', '2026-11-01')).toEqual({ status: 'valid', days: 61 });
    expect(licenceStatus('2026-11-01', '2026-11-01')).toEqual({ status: 'expiring', days: 0 });
    expect(licenceStatus('2026-10-31', '2026-11-01')).toEqual({ status: 'expired', days: -1 });
    expect(licenceStatus(null, '2026-11-01')).toEqual({ status: 'missing', days: null });
    const today = bangkokToday();
    const exp = await newDriver({ licenceExpiresOn: addDays(today, -1) });
    const soon = await newDriver({ licenceExpiresOn: addDays(today, 20) });
    const mid = await newDriver({ licenceExpiresOn: addDays(today, 45) });
    expect(exp).toMatchObject({ licenceStatus: 'expired', licenceDaysToExpiry: -1 });
    expect(soon).toMatchObject({ licenceStatus: 'expiring', licenceDaysToExpiry: 20 });
    expect(mid).toMatchObject({ licenceStatus: 'expiring', licenceDaysToExpiry: 45 });
    const al = await api(app, admin)
      .get('/v1/drivers')
      .query({ licenceAlert: 'true', limit: 200 })
      .expect(200);
    const ids = al.body.data.map((d: { id: string }) => d.id);
    expect(ids).toEqual(expect.arrayContaining([exp.id, soon.id]));
    expect(ids).not.toContain(mid.id);
    const s = await api(app, admin).get('/v1/drivers/summary').expect(200);
    expect(s.body.licenceAlert).toBe(ids.length);
    expect(s.body.total).toBe(s.body.active + s.body.onLeave + s.body.inactive);
    // วันที่ไม่มีจริง → 422 · ไม่ส่งวันหมด/ประเภทใบขับขี่ตอนสร้าง → 422
    await create(body({ licenceExpiresOn: '2027-02-30' })).expect(422);
    await create(body({ licenceClass: 'T5' })).expect(422);
    const { licenceExpiresOn: _e, ...noExp } = body();
    await create(noExp).expect(422);
  });

  it('สถานะ: พร้อมใช้ ↔ ลาพัก, ปิดใช้งาน (เหตุผล ≥ 10, history + event) · ปิดใช้งานแล้วแก้ไม่ได้', async () => {
    const d = await newDriver();
    await api(app, admin)
      .post(`/v1/drivers/${d.id}/status`)
      .send({ status: 'on_leave', reason: 'สั้น' })
      .expect(422);
    const l = await api(app, admin)
      .post(`/v1/drivers/${d.id}/status`)
      .set('If-Match', `"${d.version}"`)
      .send({ status: 'on_leave', reason: 'ลาพักร้อน 3 วัน' })
      .expect(200);
    expect(l.body).toMatchObject({ status: 'on_leave', statusReason: 'ลาพักร้อน 3 วัน' });
    await api(app, admin)
      .post(`/v1/drivers/${d.id}/status`)
      .set('If-Match', `"${d.version}"`)
      .send({ status: 'active', reason: 'กลับมาทำงานแล้ว' })
      .expect(412);
    const off = await api(app, admin)
      .post(`/v1/drivers/${d.id}/status`)
      .send({ status: 'inactive', reason: 'พ้นสภาพพนักงานแล้ว' })
      .expect(200);
    expect(off.body.status).toBe('inactive');
    // inactive → on_leave ไม่มีใน state machine → 409
    await api(app, admin)
      .post(`/v1/drivers/${d.id}/status`)
      .send({ status: 'on_leave', reason: 'ลาพักร้อน 3 วัน' })
      .expect(409);
    const ro = await patch(off.body, { name: 'แก้ชื่อ' }).expect(409);
    expect(ro.body.errors[0].code).toBe('driver_inactive');
    const h = await db.docStatusHistory.findMany({
      where: { docType: 'driver', docId: tryDecodeId('driver', d.id)! },
      orderBy: { at: 'asc' },
    });
    expect(h.map((x) => x.toStatus)).toEqual(['ON_LEAVE', 'INACTIVE']);
    const ev = await db.domainEvent.findMany({
      where: { entityType: 'driver', localId: tryDecodeId('driver', d.id)! },
    });
    expect(ev.map((e) => e.type)).toEqual(
      expect.arrayContaining(['driver.status_changed', 'driver.deactivated']),
    );
    const s = await api(app, admin).get('/v1/drivers').query({ status: 'inactive' }).expect(200);
    expect(s.body.data.map((x: { id: string }) => x.id)).toContain(d.id);
  });

  it('PATCH: If-Match ผิด → 412 · ค่าเดิม (รวมเลขบัตรเดิม) ไม่เพิ่ม version · null ในช่องบังคับ → 422', async () => {
    const d = await newDriver({ nationalId: nid(20) });
    await api(app, admin)
      .patch(`/v1/drivers/${d.id}`)
      .set('If-Match', '"99"')
      .send({ name: 'x' })
      .expect(412);
    const same = await patch(d, {
      name: d.name,
      phone: d.phone,
      nationalId: nid(20),
      licenceExpiresOn: d.licenceExpiresOn,
    }).expect(200);
    expect(same.body.version).toBe(d.version);
    await patch(d, { name: null }).expect(422);
    await patch(d, { phone: null }).expect(422);
    await patch(d, { licenceClass: null }).expect(422);
    const cleared = await patch(d, { nationalId: null }).expect(200);
    expect(cleared.body.nationalIdLast4).toBeNull();
    expect((await raw(d.id)).national_id_enc).toBeNull();
  });

  it('PUT external: ครั้งแรก 201 ส่งซ้ำ 200 ไม่เพิ่ม version · GET ext:{id}', async () => {
    const b = body({ nationalId: nid(30) });
    const a = await api(app, admin).put('/v1/drivers/external/HR-001').send(b).expect(201);
    const c = await api(app, admin).put('/v1/drivers/external/HR-001').send(b).expect(200);
    expect(c.body.id).toBe(a.body.id);
    expect(c.body.version).toBe(a.body.version);
    const g = await api(app, admin).get('/v1/drivers/ext:HR-001').expect(200);
    expect(g.body).toMatchObject({ id: a.body.id, externalId: 'HR-001' });
  });

  it('ลบ: soft delete (เหตุผล) — ไม่อยู่ในรายการ, externalId ใช้ใหม่ได้ · มีเที่ยวอ้างถึง → 409 in_use', async () => {
    const d = await newDriver({ externalId: 'HR-DEL' });
    await api(app, admin)
      .post(`/v1/drivers/${d.id}/delete`)
      .send({ reason: 'กรอกผิด สร้างซ้ำ' })
      .expect(204);
    await api(app, admin).get(`/v1/drivers/${d.id}`).expect(404);
    const t = await api(app, admin)
      .get('/v1/drivers')
      .query({ includeDeleted: 'true', limit: 200 })
      .expect(200);
    expect(t.body.data.find((x: { id: string }) => x.id === d.id).deletedAt).toBeTruthy();
    await newDriver({ externalId: 'HR-DEL' });
    const used = await newDriver();
    await db.trip.create({
      data: {
        tenantId,
        tripDate: new Date('2026-11-12'),
        driverId: tryDecodeId('driver', used.id)!,
      },
    });
    const r = await api(app, admin)
      .post(`/v1/drivers/${used.id}/delete`)
      .send({ reason: 'ลองลบคนขับที่มีเที่ยว' })
      .expect(409);
    expect(r.body).toMatchObject({
      code: 'in_use',
      references: { trips: 1 },
      instead: 'deactivate',
    });
  });

  it('reveal: เฉพาะ users:write + เหตุผล + ลง audit · ไม่รับ Idempotency-Key · จำกัดถี่', async () => {
    const d = await newDriver({ nationalId: nid(40) });
    const planner = await tokenFor(tenantId, 'master:read master:write', 'user-planner');
    await api(app, planner)
      .post(`/v1/drivers/${d.id}/reveal`)
      .send({ reason: 'ตรวจเลขบัตรคนขับ' })
      .expect(403);
    const hr = await tokenFor(tenantId, 'users:write', 'user-hr');
    await api(app, hr).post(`/v1/drivers/${d.id}/reveal`).send({}).expect(422);
    const r = await api(app, hr)
      .post(`/v1/drivers/${d.id}/reveal`)
      .send({ reason: 'ตรวจเลขบัตรคนขับ' })
      .expect(200);
    expect(r.body).toEqual({ field: 'nationalId', value: nid(40) });
    expect(r.headers['cache-control']).toBe('no-store');
    const a = await db.auditLog.findFirst({
      where: { action: 'driver.pii_revealed', entityId: tryDecodeId('driver', d.id)! },
    });
    expect(a).toMatchObject({ reason: 'ตรวจเลขบัตรคนขับ' });
    expect(JSON.stringify([a!.before, a!.after])).not.toContain(nid(40));
    await api(app, hr)
      .post(`/v1/drivers/${d.id}/reveal`)
      .set('Idempotency-Key', 'reveal-key-0002')
      .send({ reason: 'ตรวจเลขบัตรคนขับ' })
      .expect(400);
    const burst = await tokenFor(tenantId, 'users:write', 'user-burst');
    const codes: number[] = [];
    for (let i = 0; i < 21; i++)
      codes.push(
        (
          await api(app, burst)
            .post(`/v1/drivers/${d.id}/reveal`)
            .send({ reason: 'ตรวจเลขบัตรคนขับ' })
        ).status,
      );
    expect(codes.slice(0, 20).every((x) => x === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('รายการ: ค้นหา/กรอง ประเภท ใบขับขี่ ผู้รับเหมา สังกัด · สิทธิ์อ่าน/เขียน/ส่งออก', async () => {
    const c = await newDriver({
      name: 'สุรชัย สังกัดรถร่วม',
      employmentType: 'CARRIER_DRIVER',
      carrierId: carrierA,
      licenceClass: 'T3',
    });
    const by = async (q: object) =>
      (
        await api(app, admin)
          .get('/v1/drivers')
          .query({ limit: 200, ...q })
          .expect(200)
      ).body.data.map((d: { id: string }) => d.id);
    expect(await by({ q: 'สุรชัย' })).toEqual([c.id]);
    expect(await by({ q: c.phone })).toContain(c.id);
    expect(await by({ employmentType: 'CARRIER_DRIVER', licenceClass: 'T3' })).toContain(c.id);
    expect(await by({ carrierId: carrierA })).toContain(c.id);
    expect(await by({ affiliation: 'ผู้รับเหมาเอ' })).toContain(c.id);
    expect(await by({ affiliation: 'ผู้รับเหมาเอ', employmentType: 'EMPLOYEE_SALARIED' })).toEqual(
      [],
    );
    expect(await by({ name: '%' })).toEqual([]); // likeEscape
    const ro = await tokenFor(tenantId, 'master:read');
    await api(app, ro).get('/v1/drivers').expect(200);
    await create(body(), ro).expect(403);
    await api(app, ro).get('/v1/drivers/export').expect(403);
    const nc = await api(app, admin).get('/v1/drivers/next-code').expect(200);
    expect(nc.body.code).toMatch(/^DRV-\d{4}$/);
  });
});
