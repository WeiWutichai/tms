import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST4-T07 ePOD ผ่านเว็บ (docs/04 E2, docs/01 §4.3) — เกณฑ์ตรวจรับ:
 * อัปโหลด POD ครบตาม checklist → DO เป็น UNBILLED; ไม่ครบ → POD_PENDING
 * + pod_status NONE/PARTIAL/COMPLETE, ฉบับ/เหตุผล/If-Match, ไฟล์, PIN ปิดบัง, ชุดไม่สำเร็จ, สิทธิ์, append-only
 */
describe('ePOD web (ST4-T07)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenant: string;
  let admin: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท หลักฐานส่ง' })).id;
    otherTenant = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(931) },
    });
    await db.branch.create({
      data: {
        tenantId,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    admin = await tokenFor(tenantId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async () =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async (podRequirements?: object) => {
    const id = uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9800 + seed) })
          .expect(201)
      ).body.id,
    );
    if (podRequirements) await db.customer.update({ where: { id }, data: { podRequirements } });
    return id;
  };
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `8${++seed % 10}-${String(2000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
    const n = ++seed;
    await api(app, admin)
      .post('/v1/drivers')
      .send({
        name: `คนขับ ${n}`,
        phone: `088-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v;
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });

  /** SO → DO → เที่ยวปล่อยรถ → (ไม่บังคับ) ปิดจุดรับ + จุดส่ง · คืน DO (public id) */
  const delivered = async (
    opts: {
      podRequirements?: object;
      outcome?: 'DELIVERED' | 'FAIL' | 'NONE';
      /** เหตุผลส่งไม่สำเร็จ — ค่าเริ่มต้นไม่ติ๊กนัดส่งใหม่ (SHOP_CLOSED = นัดส่งใหม่อัตโนมัติ ST4-T12) */
      failReason?: string;
    } = {},
  ) => {
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: await newCustomer(opts.podRequirements) },
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteId: await newSite() },
        { type: 'DELIVERY', siteId: await newSite() },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '2', unitId: unitTon, weightKg: '15000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    const doId = encodeId('deliveryOrder', d!.id);
    const vid = (await newVehicle()).id;
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: vid })
        .expect(201)
    ).body;
    const r = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (r.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบหลักฐานส่ง',
        })
        .expect(200);
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence,
    );
    if (opts.outcome !== 'NONE') {
      await post(pickup.id, 'arrive', 60).expect(201);
      await post(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
      await post(drop.id, 'arrive', 20).expect(201);
      if (opts.outcome === 'FAIL') {
        const rsn = await db.reasonCode.findFirstOrThrow({
          where: {
            tenantId,
            category: 'DELIVERY_FAILED',
            code: opts.failReason ?? 'WRONG_ADDRESS',
          },
        });
        await post(drop.id, 'fail', 10, {
          outcome: 'FAILED',
          reasonCodeId: encodeId('reasonCode', rsn.id),
          note: 'ร้านปิด',
        }).expect(201);
      } else await post(drop.id, 'complete', 10, { outcome: 'DELIVERED' }).expect(201);
    }
    return { doId, uuid: d!.id, dropStopId: drop.id as string };
  };
  const doRow = (id: string) => db.deliveryOrder.findUniqueOrThrow({ where: { id } });

  /** เอกสารที่อัปโหลดเสร็จแล้ว (ตรงที่ฐาน — flow อัปโหลดทดสอบใน documents.test.ts) */
  const doc = async (kind: string, mime = 'image/jpeg', status = 'READY', tid = tenantId) =>
    encodeId(
      'document',
      (
        await db.storedDocument.create({
          data: {
            tenantId: tid,
            status,
            kind,
            mimeType: mime,
            sizeBytes: 1234,
            filename: `${kind.toLowerCase()}-${++seed}.${mime.split('/')[1]}`,
            createdBy: 'user-test',
            ...(status === 'READY' ? { fileKey: `k/${seed}`, sha256: 'x'.repeat(64) } : {}),
          },
        })
      ).id,
    );
  const putPod = (doId: string, body: object, token = admin) =>
    api(app, token).put(`/v1/delivery-orders/${doId}/pod`).send(body);

  it('เกณฑ์ตรวจรับ: ส่งถึงโดยยังไม่มี POD → POD_PENDING (NONE) · บันทึกไม่ครบ → คง POD_PENDING (PARTIAL) · ครบ → UNBILLED (COMPLETE)', async () => {
    const d = await delivered();
    expect(await doRow(d.uuid)).toMatchObject({ status: 'POD_PENDING', podStatus: 'NONE' });
    const g0 = await api(app, admin).get(`/v1/delivery-orders/${d.doId}/pod`).expect(200);
    expect(g0.headers.etag).toBe('"0"');
    expect(g0.body).toMatchObject({ podStatus: 'NONE', current: null, editable: true });
    expect(g0.body.missing.map((m: { key: string }) => m.key)).toEqual(['photo', 'signature']);
    expect(g0.body.plannedWeightKg).toBe('15000');

    // ไม่ครบ (รูปอย่างเดียว) → ไม่ปฏิเสธ
    const photo = await doc('POD_PHOTO');
    const p1 = await putPod(d.doId, {
      photoDocumentIds: [photo],
      receiverName: 'สมศรี ใจงาม',
      receiverRelation: 'SELF',
      weighedKg: '14940',
      customerRef: 'GR-2611-0042',
    })
      .set('If-Match', '"0"')
      .expect(200);
    expect(p1.headers.etag).toBe('"1"');
    expect(p1.body).toMatchObject({ podStatus: 'PARTIAL', doStatus: 'POD_PENDING' });
    expect(p1.body.current).toMatchObject({
      version: 1,
      podStatus: 'PARTIAL',
      source: 'WEB',
      receiverName: 'สมศรี ใจงาม',
      receiverRelation: 'SELF',
      weighedKg: '14940',
      customerRef: 'GR-2611-0042',
      reason: null,
    });
    expect(p1.body.current.photos).toHaveLength(1);
    expect(p1.body.missing).toEqual([{ key: 'signature', type: 'SIGNATURE', code: 'required' }]);
    expect(await doRow(d.uuid)).toMatchObject({ status: 'POD_PENDING', podStatus: 'PARTIAL' });
    // เลข PO ของ DO ไม่ถูกแก้
    expect((await doRow(d.uuid)).customerRef).toBeNull();

    // ครบ (แก้ = ฉบับใหม่ + เหตุผล) → UNBILLED
    const sig = await doc('POD_SIGNATURE', 'image/png');
    const p2 = await putPod(d.doId, {
      photoDocumentIds: [photo],
      signatureDocumentId: sig,
      receiverName: 'สมศรี ใจงาม',
      reason: 'เพิ่มลายเซ็นผู้รับที่ได้ภายหลัง',
    })
      .set('If-Match', '"1"')
      .expect(200);
    expect(p2.body).toMatchObject({ podStatus: 'COMPLETE', doStatus: 'UNBILLED', missing: [] });
    expect(p2.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(p2.body.current.signature.id).toBe(sig);
    expect(await doRow(d.uuid)).toMatchObject({ status: 'UNBILLED', podStatus: 'COMPLETE' });

    // ประวัติสถานะ DO + domain_event + audit
    const hist = await db.docStatusHistory.findMany({
      where: { docId: d.uuid },
      orderBy: { at: 'asc' },
    });
    expect(hist.map((h) => h.toStatus).slice(-2)).toEqual(['POD_PENDING', 'UNBILLED']);
    const evs = await db.domainEvent.findMany({ where: { localId: d.uuid, type: 'pod.captured' } });
    expect(evs).toHaveLength(2);
    const audits = await db.auditLog.findMany({
      where: { entityId: d.uuid, action: { startsWith: 'pod.' } },
      orderBy: { seq: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['pod.recorded', 'pod.amended']);
    expect(audits[1]!.reason).toBe('เพิ่มลายเซ็นผู้รับที่ได้ภายหลัง');
  });

  it('ลูกค้าไม่บังคับอะไร → ส่งถึงแล้ว UNBILLED ทันที (pod_status NONE)', async () => {
    const none = { fields: [] };
    const d = await delivered({ podRequirements: { success: none } });
    expect(await doRow(d.uuid)).toMatchObject({ status: 'UNBILLED', podStatus: 'NONE' });
  });

  it('If-Match ไม่ตรง → 412 · แก้โดยไม่มีเหตุผล → 422 · ด่านวางบิล: UNBILLED แก้จนไม่ครบ → 422 pod_incomplete', async () => {
    const d = await delivered();
    const photo = await doc('POD_PHOTO');
    const sig = await doc('POD_SIGNATURE', 'image/png');
    await putPod(d.doId, { photoDocumentIds: [photo], signatureDocumentId: sig }).expect(200);
    expect((await doRow(d.uuid)).status).toBe('UNBILLED');
    const stale = await putPod(d.doId, { reason: 'แก้ไขข้อมูลที่ผิดพลาด' }).set('If-Match', '"0"');
    expect(stale.status).toBe(412);
    expect(stale.body.currentVersion).toBe(1);
    const noReason = await putPod(d.doId, { photoDocumentIds: [photo] });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors[0]).toMatchObject({ field: 'reason', code: 'required' });
    const shortReason = await putPod(d.doId, { photoDocumentIds: [photo], reason: 'สั้น' });
    expect(shortReason.status).toBe(422);
    const amend = await putPod(d.doId, {
      photoDocumentIds: [photo],
      reason: 'ลายเซ็นเดิมผิดคน ขอเก็บใหม่',
    });
    expect(amend.status).toBe(422);
    expect(amend.body).toMatchObject({ code: 'pod_incomplete', doStatus: 'UNBILLED' });
    expect(amend.body.missing).toEqual([{ key: 'signature', type: 'SIGNATURE', code: 'required' }]);
    expect(amend.body.errors[0]).toMatchObject({ field: 'signatureDocumentId', code: 'required' });
    expect(await doRow(d.uuid)).toMatchObject({ status: 'UNBILLED', podStatus: 'COMPLETE' });
    // แก้แบบยังครบ (ใส่น้ำหนัก) ได้ → ฉบับ 2
    const ok = await putPod(d.doId, {
      photoDocumentIds: [photo],
      signatureDocumentId: sig,
      weighedKg: '1490.5',
      reason: 'เพิ่มน้ำหนักจากใบชั่งปลายทาง',
    }).expect(200);
    expect(ok.body.current).toMatchObject({ version: 2, weighedKg: '1490.5' });
  });

  it('DO ยังไม่ส่ง → 409 pod_not_allowed · วางบิลแล้ว → 409', async () => {
    const d = await delivered({ outcome: 'NONE' });
    const r = await putPod(d.doId, {});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'pod_not_allowed', doStatus: 'DISPATCHED' });
    const g = await api(app, admin).get(`/v1/delivery-orders/${d.doId}/pod`).expect(200);
    expect(g.body.editable).toBe(false);
  });

  it('ไฟล์: ชนิดผิด / ยังไม่อัปโหลด / ของบริษัทอื่น / ซ้ำ → 422 รายช่อง', async () => {
    const d = await delivered();
    const pdfAsPhoto = await doc('POD_PHOTO', 'application/pdf');
    const pending = await doc('POD_PHOTO', 'image/jpeg', 'PENDING');
    const foreign = await doc('POD_PHOTO', 'image/jpeg', 'READY', otherTenant);
    const vehDoc = await doc('VEHICLE_DOC', 'application/pdf');
    const ok = await doc('POD_PHOTO');
    const r = await putPod(d.doId, {
      photoDocumentIds: [pdfAsPhoto, pending, foreign],
      fileDocumentIds: [vehDoc],
    });
    expect(r.status).toBe(422);
    const codes = Object.fromEntries(
      r.body.errors.map((e: { field: string; code: string }) => [e.field, e.code]),
    );
    expect(codes).toMatchObject({
      'photoDocumentIds.0': 'invalid_kind',
      'photoDocumentIds.1': 'not_ready',
      'photoDocumentIds.2': 'not_found',
      'fileDocumentIds.0': 'invalid_kind',
    });
    const dup = await putPod(d.doId, { photoDocumentIds: [ok, ok] });
    expect(dup.status).toBe(422);
    // ไฟล์ PDF ของหลักฐาน (POD_FILE) ใช้ได้ ไม่นับเป็นรูป
    const file = await doc('POD_FILE', 'application/pdf');
    const f = await putPod(d.doId, { fileDocumentIds: [file] }).expect(200);
    expect(f.body.current.files).toHaveLength(1);
    expect(f.body.missing.map((m: { key: string }) => m.key)).toContain('photo');
  });

  it('PIN เข้ารหัส + แสดงแบบปิดบัง ไม่อยู่ใน audit/domain_event · PIN ผิดรูปแบบ → 422 · barcodes/scanCodes', async () => {
    const success = {
      fields: [
        { type: 'PIN', level: 'REQUIRED', length: 4 },
        { type: 'BARCODE', level: 'ENABLED' },
        { type: 'RATING', level: 'ENABLED', max: 5 },
        { type: 'BOOLEAN', key: 'goods_ok', label: 'สินค้าครบ', level: 'REQUIRED' },
        {
          type: 'SINGLE_CHOICE',
          key: 'box',
          label: 'สภาพกล่อง',
          level: 'ENABLED',
          options: ['ดี', 'บุบ'],
        },
      ],
    };
    const d = await delivered({ podRequirements: { success } });
    expect((await doRow(d.uuid)).status).toBe('POD_PENDING');
    const bad = await putPod(d.doId, { pin: '12' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'pin', code: 'invalid' });
    const unknown = await putPod(d.doId, { checks: { nope: true } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({ field: 'checks.nope', code: 'unknown_key' });
    const badChoice = await putPod(d.doId, { choices: { box: 'แตก' } });
    expect(badChoice.status).toBe(422);
    const conflict = await putPod(d.doId, { barcodes: ['A'], scanCodes: ['B'] });
    expect(conflict.status).toBe(422);
    expect(conflict.body.errors[0]).toMatchObject({ field: 'scanCodes', code: 'conflict' });

    const ok = await putPod(d.doId, {
      pin: '4821',
      scanCodes: [' SKU-1 ', 'SKU-2'],
      rating: 4,
      checks: { goods_ok: true },
      choices: { box: 'ดี' },
    }).expect(200);
    expect(ok.body).toMatchObject({ podStatus: 'COMPLETE', doStatus: 'UNBILLED' });
    expect(ok.body.current).toMatchObject({
      pinMasked: '••••',
      barcodes: ['SKU-1', 'SKU-2'],
      rating: 4,
      checks: { goods_ok: true },
      choices: { box: 'ดี' },
    });
    // PIN ต้องไม่หลุดเป็นค่าใด ๆ (ตรวจค่าตรงตัว ไม่ใช่ substring — id สุ่มอาจมี "4821" ปน)
    expect(pinLeaks(ok.body)).toEqual([]);
    const row = await db.deliveryOrderPod.findFirstOrThrow({ where: { deliveryOrderId: d.uuid } });
    expect(row.pinEnc).toBeTruthy();
    expect(row.pinEnc).not.toBe('4821'); // ciphertext สุ่ม — ไม่ตรวจ substring
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: d.uuid, action: 'pod.recorded' },
    });
    expect(pinLeaks([audit.before, audit.after, audit.reason])).toEqual([]);
    const ev = await db.domainEvent.findFirstOrThrow({
      where: { localId: d.uuid, type: 'pod.captured' },
    });
    expect(pinLeaks(ev.snapshot)).toEqual([]);
    // GET คำนวณ missing จาก PIN ที่เก็บ (ถอดในหน่วยความจำ) — ยังครบ
    const g = await api(app, admin).get(`/v1/delivery-orders/${d.doId}/pod`).expect(200);
    expect(g.body.missing).toEqual([]);
    // แก้ฉบับโดยไม่ส่ง pin = คง PIN เดิม (อ่านค่าจริงคืนไม่ได้) · ส่ง null = ล้าง
    const keep = await putPod(d.doId, {
      checks: { goods_ok: true },
      rating: 5,
      reason: 'แก้คะแนนตามที่ผู้รับแจ้ง',
    }).expect(200);
    expect(keep.body).toMatchObject({ podStatus: 'COMPLETE' });
    expect(keep.body.current).toMatchObject({ version: 2, pinMasked: '••••', rating: 5 });
    // ล้าง PIN ที่บังคับของ DO ที่รอวางบิลแล้ว = ไม่ครบ → ด่านวางบิลปฏิเสธ
    const clear = await putPod(d.doId, {
      checks: { goods_ok: true },
      pin: null,
      reason: 'ผู้รับขอยกเลิกรหัสที่กรอกผิด',
    });
    expect(clear.status).toBe(422);
    expect(clear.body.errors[0]).toMatchObject({ field: 'pin', code: 'required' });
  });

  it('DO ส่งไม่สำเร็จ ใช้ชุด "ไม่สำเร็จ" (รูป + หมายเหตุ) และคง FAILED', async () => {
    const d = await delivered({ outcome: 'FAIL' });
    expect((await doRow(d.uuid)).status).toBe('FAILED');
    const g = await api(app, admin).get(`/v1/delivery-orders/${d.doId}/pod`).expect(200);
    expect(g.body.checklist.outcome).toBe('FAILURE');
    expect(g.body.missing.map((m: { key: string }) => m.key)).toEqual(['photo', 'note']);
    const photo = await doc('POD_PHOTO');
    const r = await putPod(d.doId, {
      photoDocumentIds: [photo],
      note: 'ร้านปิด ไม่มีผู้รับ',
    }).expect(200);
    expect(r.body).toMatchObject({ podStatus: 'COMPLETE', doStatus: 'FAILED' });
    expect(r.body.current.outcome).toBe('FAILURE');
  });

  it('ST4-T12 (review H2): ร้านปิด (นัดส่งใหม่อัตโนมัติ) → ใบเดิมยกเลิกด้วย redeliver แต่ยังบันทึกหลักฐานชุด "ไม่สำเร็จ" ได้', async () => {
    const d = await delivered({ outcome: 'FAIL', failReason: 'SHOP_CLOSED' });
    expect((await doRow(d.uuid)).status).toBe('CANCELLED');
    expect(await db.deliveryOrder.count({ where: { redeliveryOfId: d.uuid } })).toBe(1);
    const g = await api(app, admin).get(`/v1/delivery-orders/${d.doId}/pod`).expect(200);
    expect(g.body).toMatchObject({ editable: true, doStatus: 'CANCELLED' });
    expect(g.body.checklist.outcome).toBe('FAILURE');
    const photo = await doc('POD_PHOTO');
    const r = await putPod(d.doId, {
      photoDocumentIds: [photo],
      note: 'ร้านปิด ไม่มีผู้รับ',
    }).expect(200);
    expect(r.body).toMatchObject({ podStatus: 'COMPLETE', doStatus: 'CANCELLED' });
    expect(r.body.current.outcome).toBe('FAILURE');
    expect((await doRow(d.uuid)).status).toBe('CANCELLED');
  });

  it('สิทธิ์: viewer อ่านได้ บันทึกไม่ได้ (403) · บริษัทอื่น 404', async () => {
    const d = await delivered();
    const viewer = await tokenFor(tenantId, 'trips:read orders:read');
    await api(app, viewer).get(`/v1/delivery-orders/${d.doId}/pod`).expect(200);
    expect((await putPod(d.doId, {}, viewer)).status).toBe(403);
    const other = await tokenFor(otherTenant);
    expect((await api(app, other).get(`/v1/delivery-orders/${d.doId}/pod`)).status).toBe(404);
    expect((await putPod(d.doId, {}, other)).status).toBe(404);
  });

  it('เจ้าของไฟล์: ใช้แล้วผูกกับ DO · ไฟล์ของ DO อื่น/เอกสารอื่น → 422 document_in_use', async () => {
    const a = await delivered();
    const b = await delivered();
    const photo = await doc('POD_PHOTO');
    await putPod(a.doId, { photoDocumentIds: [photo] }).expect(200);
    const row = await db.storedDocument.findUniqueOrThrow({
      where: { id: uuid('document', photo) },
    });
    expect(row).toMatchObject({ entityType: 'delivery_order', entityId: a.uuid });
    const r = await putPod(b.doId, { photoDocumentIds: [photo] });
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({
      field: 'photoDocumentIds.0',
      code: 'document_in_use',
    });
    // ไฟล์ที่ผูกกับเอกสารอื่นอยู่แล้ว
    const other = await doc('POD_PHOTO');
    await db.storedDocument.update({
      where: { id: uuid('document', other) },
      data: { entityType: 'trip_stop', entityId: randomUUID() },
    });
    const r2 = await putPod(b.doId, { photoDocumentIds: [other] });
    expect(r2.status).toBe(422);
    expect(r2.body.errors[0].code).toBe('document_in_use');
    // ใช้ซ้ำใน DO เดิม (ฉบับใหม่) ได้
    await putPod(a.doId, { photoDocumentIds: [photo], reason: 'เพิ่มชื่อผู้รับภายหลัง' }).expect(
      200,
    );
  });

  it('PIN ถอดรหัสไม่ได้ → ไม่ลดสถานะเงียบ ๆ (นับว่ากรอกแล้ว) + ธง pinUnreadable', async () => {
    const success = { fields: [{ type: 'PIN', level: 'REQUIRED', length: 4 }] };
    const d = await delivered({ podRequirements: { success } });
    await db.deliveryOrderPod.create({
      data: {
        tenantId,
        deliveryOrderId: d.uuid,
        version: 1,
        outcome: 'SUCCESS',
        source: 'WEB',
        pinEnc: 'v1.lost.AAAA.BBBB.CCCC',
        pinLength: 4,
        podStatus: 'COMPLETE',
      },
    });
    const g = await api(app, admin).get(`/v1/delivery-orders/${d.doId}/pod`).expect(200);
    expect(g.body.missing).toEqual([]);
    expect(g.body.current).toMatchObject({ pinMasked: '••••', pinUnreadable: true });
  });

  it('append-only: แก้/ลบแถวหลักฐานที่ฐานไม่ได้', async () => {
    const d = await delivered();
    await putPod(d.doId, { receiverName: 'ก' }).expect(200);
    const row = await db.deliveryOrderPod.findFirstOrThrow({ where: { deliveryOrderId: d.uuid } });
    await expect(
      db.deliveryOrderPod.update({ where: { id: row.id }, data: { receiverName: 'ข' } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.deliveryOrderPod.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});

/**
 * ค่า PIN ทดสอบ ('4821') ที่หลุดใน payload: ค่า string ที่ตรงตัว/มี PIN เป็นคำแยก (เช่น "pin 4821") หรือ field ชื่อ pin ที่ไม่ใช่ค่าปิดบัง
 * — ไม่นับ substring ใน id/ciphertext สุ่ม (เดิมตรวจ substring ทั้ง JSON → สุ่มชนแล้ว test ล้มเป็นครั้งคราว)
 */
function pinLeaks(v: unknown, path = '$'): string[] {
  if (typeof v === 'string')
    return v === '4821' || /(^|[^0-9a-zA-Z_+/-])4821([^0-9a-zA-Z_+/-]|$)/.test(v) ? [path] : [];
  if (typeof v === 'number') return v === 4821 ? [path] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => pinLeaks(x, `${path}[${i}]`));
  if (v && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) =>
      /^pin$/i.test(k) && x !== null && x !== '••••'
        ? [`${path}.${k}`]
        : pinLeaks(x, `${path}.${k}`),
    );
  return [];
}
