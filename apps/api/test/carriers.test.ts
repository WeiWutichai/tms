import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldCipher } from '../src/common/crypto';
import { tryDecodeId } from '../src/common/ids';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const ACCOUNT = '1234567891';
const NATIONAL_ID = validTaxId(3_100_500_123); // เลขบัตรประชาชน (checksum ถูก) — ข้อมูลสมมติ

/** ST2-T05 รถร่วม / ผู้รับเหมา — docs/04 B Carrier + A3, docs/01 §3.2, spec/11 NFR-153/304 */
describe('รถร่วม / ผู้รับเหมา (carriers)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 0;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db)).id;
    admin = await tokenFor(tenantId);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const create = (body: object, token = admin) => api(app, token).post('/v1/carriers').send(body);
  const juristic = (extra: object = {}) => ({
    legalName: `หจก. ขนส่งทดสอบ ${++seed}`,
    entityType: 'JURISTIC',
    taxId: validTaxId(10_000 + seed),
    ...extra,
  });
  const newCarrier = async (extra: object = {}) => (await create(juristic(extra)).expect(201)).body;
  const raw = (id: string) =>
    db.$queryRaw<
      {
        tax_id: string | null;
        tax_id_enc: string | null;
        tax_id_last4: string | null;
        bank_account_enc: string | null;
        bank_account_last4: string | null;
      }[]
    >`SELECT tax_id, tax_id_enc, tax_id_last4, bank_account_enc, bank_account_last4
        FROM carrier WHERE id = ${tryDecodeId('carrier', id)!}::uuid`.then((r) => r[0]!);

  it('เกณฑ์ตรวจรับ: เลขบัญชีเข้ารหัสใน DB และแสดงแบบปิดบางส่วน', async () => {
    const r = await create(
      juristic({
        bankAccount: { bankCode: 'KBANK', accountNo: '123-4-56789-1', accountName: 'หจก. ทดสอบ' },
        lineContact: '@sapsomboon',
        phone: '081-234-5678',
      }),
    ).expect(201);
    expect(r.body).toMatchObject({
      code: 'SUB-0001',
      entityType: 'JURISTIC',
      whtForm: 'PND53',
      branchCode: '00000',
      whtRate: '1.00',
      paymentTermDays: 30,
      requirePodToPay: true,
      bankAccount: { bankCode: 'KBANK', last4: '7891', accountName: 'หจก. ทดสอบ' },
      status: 'active',
      usage: { vehicles: 0, drivers: 0, children: 0 },
    });
    expect(r.body.id).toMatch(/^car_[0-9a-f]{32}$/);
    expect(JSON.stringify(r.body)).not.toContain(ACCOUNT);
    // ใน DB: ciphertext (ไม่มีเลขเต็ม) ถอดด้วย key ของระบบได้เลขเดิม
    const row = await raw(r.body.id);
    expect(row.bank_account_enc).toMatch(/^v1\./);
    expect(row.bank_account_enc).not.toContain(ACCOUNT);
    expect(new FieldCipher().decrypt(row.bank_account_enc!)).toBe(ACCOUNT);
    expect(row.bank_account_last4).toBe('7891');
    // GET/list ก็ไม่มีเลขเต็ม
    const g = await api(app, admin).get(`/v1/carriers/${r.body.id}`).expect(200);
    const l = await api(app, admin).get('/v1/carriers').expect(200);
    expect(JSON.stringify([g.body, l.body])).not.toContain(ACCOUNT);
  });

  it('บุคคลธรรมดา: เลขบัตรประชาชนเข้ารหัส response คืนแค่ 4 หลักท้าย', async () => {
    const r = await create({
      legalName: 'นายประยูร แสงเดือน',
      entityType: 'INDIVIDUAL',
      taxId: NATIONAL_ID,
    }).expect(201);
    expect(r.body).toMatchObject({
      entityType: 'INDIVIDUAL',
      whtForm: 'PND3',
      taxId: null,
      taxIdLast4: NATIONAL_ID.slice(-4),
      branchCode: null,
    });
    const row = await raw(r.body.id);
    expect(row.tax_id).toBeNull();
    expect(row.tax_id_enc).not.toContain(NATIONAL_ID);
    expect(new FieldCipher().decrypt(row.tax_id_enc!)).toBe(NATIONAL_ID);
    // ค้นด้วย 4 หลักท้ายได้ ค้นด้วยเลขเต็มไม่เจอ (ไม่มีเลขเต็มให้เทียบ)
    const s4 = await api(app, admin)
      .get(`/v1/carriers?q=${NATIONAL_ID.slice(-4)}`)
      .expect(200);
    expect(s4.body.data.map((x: { id: string }) => x.id)).toContain(r.body.id);
    // บุคคลธรรมดาไม่มีสาขา
    const b = await create({
      legalName: 'นายสมชาย',
      entityType: 'INDIVIDUAL',
      taxId: validTaxId(3_100_500_999),
      branchCode: '00001',
    }).expect(422);
    expect(b.body.errors[0]).toMatchObject({ field: 'branchCode', code: 'individual' });
  });

  it('เปลี่ยนประเภท นิติบุคคล ↔ บุคคล: ย้ายที่เก็บเลขให้เอง (ไม่ต้องกรอกใหม่)', async () => {
    const c = await newCarrier();
    const taxId = c.taxId as string;
    const p = await api(app, admin)
      .patch(`/v1/carriers/${c.id}`)
      .set('If-Match', `"${c.version}"`)
      .send({ entityType: 'INDIVIDUAL' })
      .expect(200);
    expect(p.body).toMatchObject({ entityType: 'INDIVIDUAL', taxId: null, branchCode: null });
    let row = await raw(c.id);
    expect(row.tax_id).toBeNull();
    expect(new FieldCipher().decrypt(row.tax_id_enc!)).toBe(taxId);
    const back = await api(app, admin)
      .patch(`/v1/carriers/${c.id}`)
      .send({ entityType: 'JURISTIC' })
      .expect(200);
    expect(back.body).toMatchObject({ taxId, branchCode: '00000' });
    row = await raw(c.id);
    expect(row.tax_id_enc).toBeNull();
  });

  it('เลขผู้เสียภาษี/บัตร checksum ผิด → 422 · ไม่ส่ง → 422 · เลขบัญชีผิดรูป → 422', async () => {
    const bad = await create(juristic({ taxId: '0105536012452' })).expect(422);
    expect(bad.body.errors.map((e: { code: string }) => e.code)).toContain('thai_tax_id');
    const indiv = await create({
      legalName: 'นายเลขผิด',
      entityType: 'INDIVIDUAL',
      taxId: '3100500123450',
    }).expect(422);
    expect(indiv.body.errors[0].field).toBe('taxId');
    await create({ legalName: 'ไม่มีเลข', entityType: 'JURISTIC' }).expect(422);
    const acc = await create(
      juristic({ bankAccount: { bankCode: 'KBANK', accountNo: '12AB', accountName: 'x' } }),
    ).expect(422);
    expect(acc.body.errors[0].field).toMatch(/^bankAccount/);
    await create(
      juristic({ bankAccount: { bankCode: 'XXX', accountNo: ACCOUNT, accountName: 'x' } }),
    ).expect(422);
    // บัญชีใหม่ต้องมีเลขบัญชี
    const noNo = await create(
      juristic({ bankAccount: { bankCode: 'SCB', accountName: 'x' } }),
    ).expect(422);
    expect(noNo.body.errors[0].field).toBe('bankAccount.accountNo');
    // WHT ได้เฉพาะ 1% / 3%
    await create(juristic({ whtRate: '5.00' })).expect(422);
    await create(juristic({ legalName: null })).expect(422);
  });

  it('นิติบุคคล (เลขภาษี, สาขา) ซ้ำ → 409 พร้อมรายการเดิม · สาขาอื่นได้', async () => {
    const c = await newCarrier();
    const d = await create(juristic({ taxId: c.taxId })).expect(409);
    expect(d.body.existing).toMatchObject({ id: c.id, code: c.code });
    await create(juristic({ taxId: c.taxId, branchCode: '00002' })).expect(201);
  });

  it('parent carrier: ต้องอยู่ tenant เดียวกัน ห้ามเป็นตัวเอง ห้ามวน', async () => {
    const a = await newCarrier();
    const b = await newCarrier({ parentCarrierId: a.id });
    expect(b.parent).toMatchObject({ id: a.id, code: a.code });
    const c = await newCarrier({ parentCarrierId: b.id });
    // a → c จะวน (c อยู่ใต้ b ใต้ a)
    const loop = await api(app, admin)
      .patch(`/v1/carriers/${a.id}`)
      .send({ parentCarrierId: c.id })
      .expect(422);
    expect(loop.body.errors[0]).toMatchObject({ field: 'parentCarrierId', code: 'parent_cycle' });
    const self = await api(app, admin)
      .patch(`/v1/carriers/${a.id}`)
      .send({ parentCarrierId: a.id })
      .expect(422);
    expect(self.body.errors[0].code).toBe('parent_cycle');
    // tenant อื่น → ไม่พบ (ไม่บอกว่ามีอยู่)
    const other = (await createTenant(db)).id;
    const tokB = await tokenFor(other);
    const foreign = (await create(juristic(), tokB).expect(201)).body;
    const x = await create(juristic({ parentCarrierId: foreign.id })).expect(422);
    expect(x.body.errors[0]).toMatchObject({ field: 'parentCarrierId', code: 'not_found' });
    // usage.children ของ a
    const ga = await api(app, admin).get(`/v1/carriers/${a.id}`).expect(200);
    expect(ga.body.usage.children).toBe(1);
    // ลบ a ไม่ได้ (มีลูก)
    const del = await api(app, admin)
      .post(`/v1/carriers/${a.id}/delete`)
      .send({ reason: 'ทดสอบลบผู้รับเหมาที่มีสังกัด' })
      .expect(409);
    expect(del.body.references).toMatchObject({ children: 1 });
  });

  it('ประวัติ/audit/event ไม่มีเลขเต็ม — เปลี่ยนเลขบัญชีเห็นเป็น ••••', async () => {
    const c = await newCarrier({
      bankAccount: { bankCode: 'KBANK', accountNo: ACCOUNT, accountName: 'บัญชีเดิม' },
    });
    const ind = await create({
      legalName: 'นางสาวทดสอบ ประวัติ',
      entityType: 'INDIVIDUAL',
      taxId: NATIONAL_ID,
    }).expect(201);
    const newNo = '9990004567891'; // 4 หลักท้ายเท่าเดิม
    await api(app, admin)
      .patch(`/v1/carriers/${c.id}`)
      .send({ bankAccount: { bankCode: 'KBANK', accountNo: newNo, accountName: 'บัญชีเดิม' } })
      .expect(200);
    const h = await api(app, admin).get(`/v1/carriers/${c.id}/history`).expect(200);
    const hs = JSON.stringify(h.body);
    expect(hs).not.toContain(ACCOUNT);
    expect(hs).not.toContain(newNo);
    expect(hs).toContain('•••• 7891');
    const audits = await db.auditLog.findMany({
      where: {
        entityId: { in: [tryDecodeId('carrier', c.id)!, tryDecodeId('carrier', ind.body.id)!] },
      },
    });
    const events = await db.domainEvent.findMany({ where: { entityType: 'carrier' } });
    const all = JSON.stringify([audits, events], (_k, v) =>
      typeof v === 'bigint' ? String(v) : v,
    );
    for (const secret of [ACCOUNT, newNo, NATIONAL_ID]) expect(all).not.toContain(secret);
  });

  it('ส่งออก: เลขบัตร/เลขบัญชีปิดบัง · ต้องมี export:run', async () => {
    await create({
      legalName: 'นายส่งออก ทดสอบ',
      entityType: 'INDIVIDUAL',
      taxId: validTaxId(3_100_500_777),
      bankAccount: { bankCode: 'BBL', accountNo: '5550001112', accountName: 'นายส่งออก' },
    }).expect(201);
    const r = await api(app, admin).get('/v1/carriers/export?format=csv').expect(200);
    expect(r.text).toContain('เลขผู้เสียภาษี');
    expect(r.text).toContain('•••• 1112');
    expect(r.text).not.toContain('5550001112');
    expect(r.text).not.toContain(validTaxId(3_100_500_777));
    const ro = await tokenFor(tenantId, 'master:read');
    await api(app, ro).get('/v1/carriers/export').expect(403);
  });

  it('reveal: เฉพาะ settlements:pay + ลง audit · ไม่รับ Idempotency-Key', async () => {
    const c = await newCarrier({
      bankAccount: { bankCode: 'KTB', accountNo: ACCOUNT, accountName: 'x' },
    });
    const ro = await tokenFor(tenantId, 'master:read master:write');
    await api(app, ro)
      .post(`/v1/carriers/${c.id}/reveal`)
      .send({ field: 'bankAccountNo' })
      .expect(403);
    const pay = await tokenFor(tenantId, 'settlements:pay');
    const r = await api(app, pay)
      .post(`/v1/carriers/${c.id}/reveal`)
      .send({ field: 'bankAccountNo', reason: 'ตรวจเลขบัญชีก่อนโอน' })
      .expect(200);
    expect(r.body).toEqual({ field: 'bankAccountNo', value: ACCOUNT });
    expect(r.headers['cache-control']).toBe('no-store');
    const a = await db.auditLog.findFirst({
      where: { action: 'carrier.pii_revealed', entityId: tryDecodeId('carrier', c.id)! },
    });
    expect(a).toMatchObject({ reason: 'ตรวจเลขบัญชีก่อนโอน' });
    expect(JSON.stringify([a!.before, a!.after])).not.toContain(ACCOUNT);
    await api(app, pay)
      .post(`/v1/carriers/${c.id}/reveal`)
      .set('Idempotency-Key', 'reveal-key-0001')
      .send({ field: 'taxId' })
      .expect(400);
  });

  it('PUT external: ครั้งแรก 201 ส่งซ้ำ 200 ไม่เพิ่ม version (รวมเลขบัญชีเดิม)', async () => {
    const body = juristic({
      bankAccount: { bankCode: 'SCB', accountNo: ACCOUNT, accountName: 'ERP' },
      maxTripsPerDay: 3,
      priority: 1,
    });
    const a = await api(app, admin).put('/v1/carriers/external/ERP-SUB-1').send(body).expect(201);
    const b = await api(app, admin).put('/v1/carriers/external/ERP-SUB-1').send(body).expect(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.version).toBe(a.body.version);
    expect(b.body).toMatchObject({ externalId: 'ERP-SUB-1', maxTripsPerDay: 3, priority: 1 });
    const g = await api(app, admin).get('/v1/carriers/ext:ERP-SUB-1').expect(200);
    expect(g.body.id).toBe(a.body.id);
  });

  it('carrier ไม่ใช่ driver และไม่ใช่ผู้ใช้ (principal แยก — ไม่นับ seat)', async () => {
    const users = await db.appUser.count({ where: { tenantId } });
    const drivers = await db.driver.count({ where: { tenantId } });
    await newCarrier();
    expect(await db.appUser.count({ where: { tenantId } })).toBe(users);
    expect(await db.driver.count({ where: { tenantId } })).toBe(drivers);
  });

  it('ระงับชั่วคราว (เหตุผล) / เปิดใช้ · ลบไม่ได้เมื่อมีรถในสังกัด · ลบได้เมื่อไม่ถูกอ้างอิง', async () => {
    const c = await newCarrier();
    await api(app, admin)
      .post(`/v1/carriers/${c.id}/deactivate`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const off = await api(app, admin)
      .post(`/v1/carriers/${c.id}/deactivate`)
      .send({ reason: 'รถไม่พร้อม ระงับชั่วคราว' })
      .expect(200);
    expect(off.body.status).toBe('inactive');
    // สังกัด carrier ที่ระงับอยู่ไม่ได้
    const x = await create(juristic({ parentCarrierId: c.id })).expect(422);
    expect(x.body.errors[0].code).toBe('inactive');
    await api(app, admin).post(`/v1/carriers/${c.id}/activate`).send({}).expect(200);
    const s = await api(app, admin).get('/v1/carriers/summary').expect(200);
    expect(s.body.total).toBe(s.body.active + s.body.inactive);

    const vt = await db.vehicleType.create({
      data: { tenantId, code: `T-${++seed}`, nameTh: `ประเภท ${seed}`, vehicleClass: '6W' },
    });
    await db.vehicle.create({
      data: {
        tenantId,
        plate: `71-${seed}`,
        plateProvince: 'ชลบุรี',
        vehicleTypeId: vt.id,
        ownership: 'SUBCONTRACT',
        carrierId: tryDecodeId('carrier', c.id)!,
      },
    });
    const g = await api(app, admin).get(`/v1/carriers/${c.id}`).expect(200);
    expect(g.body.usage.vehicles).toBe(1);
    const del = await api(app, admin)
      .post(`/v1/carriers/${c.id}/delete`)
      .send({ reason: 'ทดสอบลบผู้รับเหมาที่มีรถ' })
      .expect(409);
    expect(del.body.references).toMatchObject({ vehicles: 1 });

    const d = await newCarrier({ externalId: 'DEL-1' });
    await api(app, admin)
      .post(`/v1/carriers/${d.id}/delete`)
      .set('If-Match', `"${d.version}"`)
      .send({ reason: 'สร้างผิด ไม่เคยใช้งาน' })
      .expect(204);
    await api(app, admin).get(`/v1/carriers/${d.id}`).expect(404);
    // externalId ปล่อยให้ใช้ใหม่ได้
    await newCarrier({ externalId: 'DEL-1' });
  });

  it('If-Match ไม่ตรง → 412 · ส่งค่าเดิมไม่เพิ่ม version', async () => {
    const c = await newCarrier({ paymentTermDays: 15 });
    await api(app, admin)
      .patch(`/v1/carriers/${c.id}`)
      .set('If-Match', '"99"')
      .send({ paymentTermDays: 45 })
      .expect(412);
    const same = await api(app, admin)
      .patch(`/v1/carriers/${c.id}`)
      .send({ paymentTermDays: 15, taxId: c.taxId, whtRate: '1.00' })
      .expect(200);
    expect(same.body.version).toBe(c.version);
    await api(app, admin).patch(`/v1/carriers/${c.id}`).send({ requirePodToPay: null }).expect(422);
  });
});
