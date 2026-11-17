import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbService, type Tx } from '../src/db/db.service';
import { PrismaService } from '../src/db/prisma.service';
import { DemoSink } from '../src/modules/integration/demo-sink';
import { OutboxDispatcher } from '../src/modules/integration/outbox.dispatcher';
import { OutboxWorkerPool } from '../src/modules/integration/outbox-worker';
import { OutboxService, eventMatches } from '../src/modules/integration/outbox.service';
import { OutboxSinkRegistry } from '../src/modules/integration/outbox-sink.registry';
import { OutboxSinkError, type OutboxDelivery } from '../src/modules/integration/outbox.types';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/** ST7-T03 integration_outbox + worker (docs/01 §3.7, §6.2; docs/04 G3 Outbox) */
describe('integration outbox (ST7-T03)', () => {
  let app: NestExpressApplication;
  const plat = platform();
  let db: DbService;
  let outbox: OutboxService;
  let registry: OutboxSinkRegistry;
  let dispatcher: OutboxDispatcher;
  let sink: DemoSink;

  const emit = (tx: Tx, tenantId: string, type: string, snapshot: object = {}, localId?: string) =>
    tx.domainEvent.create({
      data: {
        tenantId,
        type,
        entityType: type.split('.')[0]!,
        localId: localId ?? randomUUID(),
        snapshot: snapshot as object,
      },
    });
  const subscribe = (tenantId: string, eventTypes: string[], sinkKey = 'demo', targetId?: string) =>
    db.withTenant(tenantId, (tx) =>
      outbox.subscribe(tx, { tenantId, kind: 'ADAPTER', sink: sinkKey, targetId, eventTypes }),
    );
  const rows = (tenantId: string) =>
    plat.integrationOutbox.findMany({ where: { tenantId }, orderBy: { seq: 'asc' } });
  /** ให้ทุกคำสั่งพร้อมส่งทันที (ข้าม backoff) */
  const due = () =>
    plat.$executeRaw`UPDATE integration_outbox SET next_run_at = now() - interval '1 second'
                      WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    outbox = app.get(OutboxService);
    registry = app.get(OutboxSinkRegistry);
    dispatcher = app.get(OutboxDispatcher);
    sink = registry.demo;
  });
  beforeEach(async () => {
    sink.reset();
    // คำสั่งค้างจาก test ก่อนหน้าไม่ให้ปนกับ test นี้
    await plat.$executeRaw`UPDATE integration_outbox SET status = 'SKIPPED', lease_id = NULL, lease_until = NULL
                            WHERE status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  describe('event → outbox ใน transaction เดียวกัน', () => {
    it('event ที่ตรง subscription ได้คำสั่ง 1 แถวต่อ subscription (ชื่อเต็ม / prefix.* / *) — ไม่ตรง/ปิดอยู่ไม่ได้', async () => {
      const t = (await createTenant(plat)).id;
      const exact = await subscribe(t, ['customer.deactivated'], 'demo', 'exact');
      const prefix = await subscribe(t, ['customer.*'], 'demo', 'prefix');
      const all = await subscribe(t, ['*'], 'demo', 'all');
      const off = await subscribe(t, ['*'], 'demo', 'off');
      await plat.integrationSubscription.update({ where: { id: off.id }, data: { active: false } });

      const custId = randomUUID();
      const e1 = await db.withTenant(t, (tx) =>
        emit(tx, t, 'customer.deactivated', { id: `cus_${custId.replace(/-/g, '')}` }, custId),
      );
      const e2 = await db.withTenant(t, (tx) => emit(tx, t, 'trip.dispatched'));
      const r = await rows(t);
      const of = (ev: string) => r.filter((x) => x.eventId === ev).map((x) => x.subscriptionId);
      expect(of(e1.id).sort()).toEqual([exact.id, prefix.id, all.id].sort());
      expect(of(e2.id)).toEqual([all.id]);
      const row = r.find((x) => x.eventId === e1.id && x.subscriptionId === exact.id)!;
      expect(row).toMatchObject({
        status: 'PENDING',
        kind: 'ADAPTER',
        sink: 'demo',
        targetId: 'exact',
        operation: 'customer.deactivated',
        eventType: 'customer.deactivated',
        entityType: 'customer',
        localId: custId,
        attempt: 0,
        maxAttempt: 7,
        // serialize ต่อ (ปลายทาง, ลูกค้า) — entity ลูกค้าเองใช้คีย์ลูกค้า
        serializeKey: `demo:exact:cus:${custId.replace(/-/g, '')}`,
        idempotencyKey: `demo:exact:customer.deactivated:${e1.id}`,
      });
      expect(eventMatches('customer.deactivated', ['customer.*'])).toBe(true);
      expect(eventMatches('trip.dispatched', ['customer.*'])).toBe(false);
    });

    it('คีย์ลูกค้าเดียวกันไม่ว่า snapshot จะเก็บ `cus_<hex>` หรือ uuid ดิบ (ใบสั่ง/DO ของลูกค้าเดียวกันเรียงคิวเดียว)', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*']);
      const c = randomUUID();
      await db.withTenant(t, async (tx) => {
        await emit(tx, t, 'order.updated', { customerId: `cus_${c.replace(/-/g, '')}` });
        await emit(tx, t, 'delivery_order.updated', { customerId: c });
        await emit(tx, t, 'trip.updated', {});
      });
      const r = await rows(t);
      expect(r[0]!.serializeKey).toBe(r[1]!.serializeKey);
      expect(r[2]!.serializeKey).toBe(`demo:-:trip:${r[2]!.localId}`);
    });

    it('rollback → ไม่มีทั้ง event และคำสั่ง (ไม่มีคำสั่งค้างของสถานะที่ไม่ได้เปลี่ยน)', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*']);
      await expect(
        db.withTenant(t, async (tx) => {
          await emit(tx, t, 'customer.updated');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await plat.domainEvent.count({ where: { tenantId: t } })).toBe(0);
      expect(await rows(t)).toHaveLength(0);
    });

    it('เปลี่ยนสถานะผ่าน API จริง → ทุก domain_event ของ tenant มีคำสั่งใน outbox (ไม่มีช่องโหว่)', async () => {
      const t = (await createTenant(plat)).id;
      const sub = await subscribe(t, ['*']);
      const tok = await tokenFor(t);
      const c = await api(app, tok)
        .post('/v1/customers')
        .send({
          legalName: 'บจก. ทดสอบ outbox',
          taxId: validTaxId(7301),
          billingAddress: { line1: '22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540' },
        })
        .expect(201);
      await api(app, tok)
        .post(`/v1/customers/${c.body.id}/deactivate`)
        .send({ reason: 'ทดสอบ outbox ปิดใช้งานลูกค้า' })
        .expect(200);
      await api(app, tok).post(`/v1/customers/${c.body.id}/activate`).send({}).expect(200);
      const gaps = await plat.$queryRaw<{ id: string; type: string }[]>`
        SELECT e.id, e.type FROM domain_event e
         WHERE e.tenant_id = ${t}::uuid
           AND NOT EXISTS (SELECT 1 FROM integration_outbox o
                            WHERE o.event_id = e.id AND o.subscription_id = ${sub.id}::uuid)`;
      expect(gaps).toEqual([]);
      const types = (await rows(t)).map((r) => r.eventType);
      expect(types).toEqual(
        expect.arrayContaining(['customer.deactivated', 'customer.reactivated']),
      );
    });

    it('สแกน event type ทุกชนิดที่โค้ดปล่อย → ทุกชนิดได้คำสั่ง + trigger เปิดอยู่ + ไม่มีโค้ดปิด trigger', async () => {
      // event type ที่เป็นข้อความตายตัวในไฟล์ที่เขียน domain_event (StateService/emit*/master-kit)
      const src = resolve(__dirname, '../src');
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
        }
      };
      walk(src);
      const types = new Set<string>();
      for (const f of files) {
        const s = readFileSync(f, 'utf8');
        // ห้ามข้าม trigger (session_replication_role = replica / DISABLE TRIGGER)
        expect(s, f).not.toMatch(/session_replication_role|DISABLE\s+TRIGGER/i);
        if (!/domainEvent\.create|emitMasterEvent|eventType|EVENT_TYPE/.test(s)) continue;
        for (const m of s.matchAll(/'([a-z][a-z_]*\.[a-z][a-z_]*)'/g)) {
          const v = m[1]!;
          // ตัดชื่อไฟล์/โมดูล (เช่น 'node:crypto' ไม่ตรงอยู่แล้ว) และชื่อตาราง.คอลัมน์
          if (/\.(ts|js|json|pdf|png|xlsx|csv|svg)$/.test(v)) continue;
          types.add(v);
        }
      }
      for (const known of [
        'order.updated',
        'order.cancelled',
        'customer.deactivated',
        'company.activated',
      ])
        expect(types.has(known), known).toBe(true);

      const [trg] = await plat.$queryRaw<{ enabled: string }[]>`
        SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = 'domain_event_to_outbox'`;
      expect(trg?.enabled).toBe('O'); // เปิดทุกโหมด (origin)

      const t = (await createTenant(plat)).id;
      const sub = await subscribe(t, ['*']);
      await db.withTenant(t, async (tx) => {
        for (const type of types) await emit(tx, t, type);
      });
      const missing = await plat.$queryRaw<{ type: string }[]>`
        SELECT e.type FROM domain_event e WHERE e.tenant_id = ${t}::uuid
           AND NOT EXISTS (SELECT 1 FROM integration_outbox o WHERE o.event_id = e.id AND o.subscription_id = ${sub.id}::uuid)`;
      expect(missing).toEqual([]);
      expect(await plat.integrationOutbox.count({ where: { tenantId: t } })).toBe(types.size);
    });

    it('enqueueCommand: payload เดิม (ลำดับ key ต่างกัน) ได้คำสั่งเดียว; payload ใหม่ได้คำสั่งใหม่', async () => {
      const t = (await createTenant(plat)).id;
      const local = randomUUID();
      const base = {
        tenantId: t,
        kind: 'ADAPTER' as const,
        sink: 'demo',
        targetId: 'conn-1',
        operation: 'PUSH_INVOICE',
        entityType: 'invoice',
        localId: local,
        customerId: randomUUID(),
      };
      const a = await db.withTenant(t, (tx) =>
        outbox.enqueueCommand(tx, { ...base, payload: { no: 'INV-1', total: '100.00' } }),
      );
      const b = await db.withTenant(t, (tx) =>
        outbox.enqueueCommand(tx, { ...base, payload: { total: '100.00', no: 'INV-1' } }),
      );
      const c = await db.withTenant(t, (tx) =>
        outbox.enqueueCommand(tx, { ...base, payload: { no: 'INV-1', total: '200.00' } }),
      );
      expect(a.created).toBe(true);
      expect(b).toEqual({ id: a.id, created: false });
      expect(c.created).toBe(true);
      const r = await rows(t);
      expect(r).toHaveLength(2);
      expect(r[0]!.idempotencyKey).toMatch(/^demo:conn-1:invoice:[0-9a-f-]{36}:[0-9a-f]{64}$/);
      expect(r[0]!.serializeKey).toBe(r[1]!.serializeKey);
    });
  });

  describe('worker', () => {
    it('ส่งสำเร็จ → DONE + sink ได้ event + idempotency key', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['customer.*']);
      const e = await db.withTenant(t, (tx) => emit(tx, t, 'customer.updated', { name: 'x' }));
      expect(await dispatcher.drain()).toBe(1);
      const [r] = await rows(t);
      expect(r).toMatchObject({ status: 'DONE', attempt: 1, leaseId: null, leaseUntil: null });
      expect(r!.doneAt).toBeInstanceOf(Date);
      const got = sink.received.get(r!.idempotencyKey)!;
      expect(got).toMatchObject({
        tenantId: t,
        eventId: e.id,
        operation: 'customer.updated',
        attempt: 1,
      });
    });

    it('ฆ่า worker กลางงาน (ส่งถึงปลายทางแล้วแต่ยังไม่บันทึก) → lease หมด → หยิบใหม่ ไม่ส่งซ้ำ (idempotency key) + worker เก่าเขียนผลทับไม่ได้', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*']);
      await db.withTenant(t, (tx) => emit(tx, t, 'customer.updated'));
      // worker A หยิบ (lease สั้น) ส่งถึงปลายทาง แล้ว "ตาย" ก่อนบันทึก DONE
      const a = (await dispatcher.claim(300))!;
      expect(a.attempt).toBe(1);
      await sink.deliver({
        ...a,
        payload: null,
        event: null,
        signal: new AbortController().signal,
        withTx: (fn) => db.withTenant(t, fn),
      } as OutboxDelivery);
      expect(await dispatcher.claim()).toBeNull(); // lease ยังไม่หมด — ไม่มีใครหยิบซ้ำ
      await new Promise((r) => setTimeout(r, 400));
      // worker B หยิบใหม่ (ครั้งที่ 2, key เดิม)
      const b = (await dispatcher.claim())!;
      expect(b).toMatchObject({ id: a.id, attempt: 2, idempotencyKey: a.idempotencyKey });
      expect(b.leaseId).not.toBe(a.leaseId);
      await dispatcher.process(b);
      expect(sink.calls).toBe(2);
      expect(sink.received.size).toBe(1); // ปลายทางรับครั้งเดียว
      const [r] = await rows(t);
      expect(r).toMatchObject({ status: 'DONE', attempt: 2, result: { duplicate: true } });
      // worker A ฟื้นมาเขียนผล → ถูกปฏิเสธ (lease_id ไม่ตรง)
      sink.fail = () => new OutboxSinkError('late', 'VALIDATION');
      await dispatcher.process(a);
      expect((await rows(t))[0]).toMatchObject({ status: 'DONE', errorClass: null });
    });

    it('ฆ่า worker ก่อนส่ง → หยิบใหม่แล้วส่งครั้งเดียว; lease หมดในครั้งสุดท้าย → FAILED_FINAL (dead-letter)', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*']);
      await db.withTenant(t, async (tx) => {
        await emit(tx, t, 'customer.updated');
        await emit(tx, t, 'trip.updated');
      });
      const [r1, r2] = await rows(t);
      await dispatcher.claim(1); // ตายทันที
      await new Promise((r) => setTimeout(r, 20));
      await dispatcher.drain();
      expect(sink.received.size).toBe(2);
      expect((await rows(t))[0]).toMatchObject({ status: 'DONE', attempt: 2 });
      // ครั้งสุดท้ายแล้ว lease หมด
      await plat.integrationOutbox.update({
        where: { id: r2!.id },
        data: {
          status: 'IN_FLIGHT',
          attempt: 7,
          leaseId: randomUUID(),
          leaseUntil: new Date(Date.now() - 1000),
        },
      });
      await dispatcher.claim();
      const dead = await plat.integrationOutbox.findUniqueOrThrow({ where: { id: r2!.id } });
      expect(dead).toMatchObject({
        status: 'FAILED_FINAL',
        errorClass: 'AMBIGUOUS',
        lastError: { code: 'lease_expired' },
      });
      expect(dead.doneAt).toBeInstanceOf(Date);
      expect(r1).toBeDefined();
    });

    it('heartbeat ต่อ lease ระหว่างส่งนาน — worker อื่นหยิบซ้ำไม่ได้', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*'], 'slow');
      const slow = new DemoSink(300, 'slow');
      slow.delayMs = 900;
      registry.replace(slow);
      await db.withTenant(t, (tx) => emit(tx, t, 'customer.updated'));
      const c = (await dispatcher.claim(300))!;
      const running = dispatcher.process(c);
      await new Promise((r) => setTimeout(r, 600)); // เกิน lease เดิมแล้ว แต่ heartbeat ต่อให้
      expect(await dispatcher.claim()).toBeNull();
      await running;
      expect(slow.calls).toBe(1);
      expect((await rows(t))[0]).toMatchObject({ status: 'DONE', attempt: 1 });
    });

    it('ล้มแบบ TRANSIENT → FAILED_RETRYABLE ตามตาราง backoff จนครบ 7 ครั้ง → FAILED_FINAL; error class อื่นตามตาราง 01§6.3', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*']);
      const ids = await db.withTenant(t, async (tx) => {
        const out: string[] = [];
        for (const ty of [
          'a.transient',
          'b.validation',
          'c.capability',
          'd.duplicate',
          'e.auth',
          'f.ambiguous',
        ])
          out.push((await emit(tx, t, ty)).id);
        return out;
      });
      const cls: Record<string, ConstructorParameters<typeof OutboxSinkError>[1]> = {
        b: 'VALIDATION',
        c: 'CAPABILITY',
        d: 'DUPLICATE',
        e: 'AUTH',
        f: 'AMBIGUOUS',
      };
      sink.fail = (d) => {
        const k = d.operation[0]!;
        return k === 'a'
          ? new Error('ECONNREFUSED')
          : new OutboxSinkError(`x ${k}`, cls[k]!, { field: 'f' });
      };
      const before = Date.now();
      await dispatcher.drain();
      const by = async () =>
        Object.fromEntries((await rows(t)).map((r) => [r.operation[0], r])) as Record<
          string,
          Awaited<ReturnType<typeof rows>>[number]
        >;
      let r = await by();
      expect(r.a).toMatchObject({
        status: 'FAILED_RETRYABLE',
        errorClass: 'TRANSIENT',
        attempt: 1,
      });
      const wait = r.a!.nextRunAt.getTime() - before;
      expect(wait).toBeGreaterThan(50_000); // 1 นาที ±10%
      expect(wait).toBeLessThan(70_000);
      expect(r.b).toMatchObject({
        status: 'FAILED_FINAL',
        errorClass: 'VALIDATION',
        lastError: { field: 'f' },
      });
      expect(r.c).toMatchObject({ status: 'SKIPPED', errorClass: 'CAPABILITY' });
      expect(r.d).toMatchObject({ status: 'DONE', errorClass: 'DUPLICATE' });
      expect(r.e).toMatchObject({ status: 'PENDING', errorClass: 'AUTH', attempt: 0 });
      expect(r.f).toMatchObject({ status: 'FAILED_RETRYABLE', errorClass: 'AMBIGUOUS' });
      for (let i = 2; i <= 7; i++) {
        await due();
        await dispatcher.drain();
      }
      r = await by();
      expect(r.a).toMatchObject({ status: 'FAILED_FINAL', errorClass: 'TRANSIENT', attempt: 7 });
      expect(r.a!.doneAt).toBeInstanceOf(Date);
      expect(ids).toHaveLength(6);
    });

    it('2 worker พร้อมกัน: คำสั่งของลูกค้าเดียวกันส่งตามลำดับ ไม่ซ้อนกัน; ลูกค้าต่างกันส่งขนานได้', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*']);
      const custs = [randomUUID(), randomUUID()];
      await db.withTenant(t, async (tx) => {
        for (let i = 0; i < 6; i++)
          for (const c of custs) await emit(tx, t, 'order.updated', { customerId: c, n: i });
      });
      const order = new Map<string, number[]>();
      const inflight = new Map<string, number>();
      let overlap = false;
      let parallel = false;
      const tracker: DemoSink = new DemoSink();
      tracker.delayMs = 15;
      const orig = tracker.deliver.bind(tracker);
      tracker.deliver = async (d: OutboxDelivery) => {
        const c = (d.payload as { customerId: string }).customerId;
        const n = (inflight.get(c) ?? 0) + 1;
        inflight.set(c, n);
        if (n > 1) overlap = true;
        if ([...inflight.values()].reduce((a, b) => a + b, 0) > 1) parallel = true;
        try {
          return await orig(d);
        } finally {
          inflight.set(c, inflight.get(c)! - 1);
          order.set(c, [...(order.get(c) ?? []), (d.payload as { n: number }).n]);
        }
      };
      registry.replace(tracker);
      const w1 = app.get(OutboxDispatcher);
      const w2 = new OutboxDispatcher(app.get(PrismaService), db, registry);
      const loop = async (w: OutboxDispatcher) => {
        let idle = 0;
        while (idle < 5) {
          if (await w.runOnce()) idle = 0;
          else {
            idle++;
            await new Promise((r) => setTimeout(r, 10));
          }
        }
      };
      try {
        await Promise.all([loop(w1), loop(w2)]);
      } finally {
        registry.replace(sink);
      }
      expect(overlap).toBe(false);
      for (const c of custs) expect(order.get(c)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(parallel).toBe(true);
      expect((await rows(t)).every((r) => r.status === 'DONE')).toBe(true);
    });

    it('คำสั่งหน้าของคีย์รอ retry → คำสั่งหลังในคีย์เดียวกันรอ (ไม่แซง) แต่คีย์อื่นไปต่อ', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*']);
      const c1 = randomUUID();
      await db.withTenant(t, async (tx) => {
        await emit(tx, t, 'invoice.finalized', { customerId: c1 });
        await emit(tx, t, 'credit_note.issued', { customerId: c1 });
        await emit(tx, t, 'invoice.finalized', { customerId: randomUUID() });
      });
      let first = true;
      sink.fail = (d) => {
        if (first && d.operation === 'invoice.finalized') {
          first = false;
          return new Error('503');
        }
        return undefined;
      };
      await dispatcher.drain();
      let r = await rows(t);
      expect(r.map((x) => x.status)).toEqual(['FAILED_RETRYABLE', 'PENDING', 'DONE']);
      await due();
      await dispatcher.drain();
      r = await rows(t);
      expect(r.map((x) => x.status)).toEqual(['DONE', 'DONE', 'DONE']);
      expect(r[0]!.doneAt!.getTime()).toBeLessThanOrEqual(r[1]!.doneAt!.getTime());
    });

    it('round-robin ต่อ tenant: tenant A มีคิว 4 รายการก่อน B ก็ไม่ทำให้ B รอจน A หมด', async () => {
      const a = (await createTenant(plat)).id;
      const b = (await createTenant(plat)).id;
      await subscribe(a, ['*']);
      await subscribe(b, ['*']);
      await db.withTenant(a, async (tx) => {
        for (let i = 0; i < 4; i++) await emit(tx, a, 'trip.updated');
      });
      await db.withTenant(b, async (tx) => {
        for (let i = 0; i < 4; i++) await emit(tx, b, 'trip.updated');
      });
      const seen: string[] = [];
      sink.fail = (d) => {
        seen.push(d.tenantId);
        return undefined;
      };
      await dispatcher.drain();
      expect(seen).toHaveLength(8);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    });

    it('sink ที่ไม่ได้ลงทะเบียน → TRANSIENT รอ retry (ไม่ทิ้งคำสั่ง)', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*'], 'not-registered');
      await db.withTenant(t, (tx) => emit(tx, t, 'trip.updated'));
      await dispatcher.drain();
      expect((await rows(t))[0]).toMatchObject({
        status: 'FAILED_RETRYABLE',
        errorClass: 'TRANSIENT',
        lastError: { message: expect.stringContaining('not registered') },
      });
    });

    it('sink กำหนด retry เอง (เช่น webhook 8 ครั้ง) → ครบตามของ sink ไม่ใช่ 7 ของแถว', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*'], 'eight');
      const s8 = Object.assign(new DemoSink(undefined, 'eight'), {
        retry: { maxAttempts: 8, scheduleMin: [1] },
      });
      s8.fail = () => new Error('500');
      registry.replace(s8);
      await db.withTenant(t, (tx) => emit(tx, t, 'trip.updated'));
      for (let i = 1; i <= 8; i++) {
        await due();
        await dispatcher.drain();
        const [r] = await rows(t);
        expect(r!.status).toBe(i < 8 ? 'FAILED_RETRYABLE' : 'FAILED_FINAL');
      }
      expect(s8.calls).toBe(8);
    });

    it('OutboxWorkerPool: sink ช้าไม่ขวางปลายทางอื่น + ส่งพร้อมกันต่อปลายทาง ≤ 3 ใน process เดียว', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*'], 'slowpool');
      await subscribe(t, ['customer.*'], 'demo');
      let now = 0;
      let peak = 0;
      const slow = new DemoSink(undefined, 'slowpool');
      const orig = slow.deliver.bind(slow);
      slow.deliver = async (d) => {
        peak = Math.max(peak, ++now);
        await new Promise((r) => setTimeout(r, 400));
        try {
          return await orig(d);
        } finally {
          now--;
        }
      };
      registry.replace(slow);
      // 6 คำสั่ง trip (คีย์ต่างกัน) ไป slowpool + 1 คำสั่ง customer ไปทั้งคู่
      await db.withTenant(t, async (tx) => {
        for (let i = 0; i < 6; i++) await emit(tx, t, 'trip.updated');
      });
      const pool = new OutboxWorkerPool(dispatcher, { concurrency: 6, idleMs: 20 });
      pool.start();
      try {
        await new Promise((r) => setTimeout(r, 150));
        await db.withTenant(t, (tx) => emit(tx, t, 'customer.updated'));
        // demo ได้ภายในเวลาที่ slowpool ยังส่งไม่หมด
        const t0 = Date.now();
        while (sink.received.size === 0 && Date.now() - t0 < 3000)
          await new Promise((r) => setTimeout(r, 20));
        expect(sink.received.size).toBe(1);
        expect(slow.received.size).toBeLessThan(7);
        while (slow.received.size < 7 && Date.now() - t0 < 10_000)
          await new Promise((r) => setTimeout(r, 50));
      } finally {
        await pool.stop(2000);
        registry.replace(sink);
      }
      expect(slow.received.size).toBe(7);
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(1);
    });

    it('SIGTERM: หยุดหยิบ รอไม่เกินเวลาผ่อนผัน แล้วคืนคำสั่งที่ค้างเป็น PENDING ให้หยิบได้ทันที (ไม่รอ lease หมด)', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*'], 'stuck');
      const stuck = new DemoSink(undefined, 'stuck');
      let aborted = false;
      stuck.deliver = (d) =>
        new Promise((_, reject) =>
          d.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          }),
        );
      registry.replace(stuck);
      await db.withTenant(t, (tx) => emit(tx, t, 'trip.updated'));
      const pool = new OutboxWorkerPool(dispatcher, { concurrency: 2, idleMs: 20 });
      pool.start();
      const t0 = Date.now();
      while (pool.active === 0 && Date.now() - t0 < 3000)
        await new Promise((r) => setTimeout(r, 20));
      expect(pool.active).toBe(1);
      const s0 = Date.now();
      const released = await pool.stop(300);
      expect(Date.now() - s0).toBeLessThan(2000);
      expect(released).toBe(1);
      expect(aborted).toBe(true);
      const [r] = await rows(t);
      expect(r).toMatchObject({
        status: 'PENDING',
        leaseId: null,
        attempt: 1,
        lastError: { code: 'worker_shutdown' },
      });
      // worker อื่นหยิบได้ทันที (key เดิม)
      const ok = new DemoSink(undefined, 'stuck');
      registry.replace(ok);
      expect(await dispatcher.drain()).toBe(1);
      expect(ok.received.size).toBe(1);
      expect((await rows(t))[0]).toMatchObject({ status: 'DONE', attempt: 2 });
    });

    it('stats(): นับตามสถานะ + อายุคิวค้าง', async () => {
      const s = await dispatcher.stats();
      expect(s.byStatus.DONE).toBeGreaterThan(0);
      expect(typeof s.oldestWaitingSec).toBe('number');
    });
  });

  describe('แยก tenant', () => {
    it('subscription ของ A ไม่รับ event ของ B; RLS กันอ่าน/แก้คำสั่งและ subscription ข้าม tenant; sink.withTx เห็นเฉพาะ tenant ของคำสั่ง', async () => {
      const a = (await createTenant(plat)).id;
      const b = (await createTenant(plat)).id;
      await subscribe(a, ['*']);
      await db.withTenant(b, (tx) => emit(tx, b, 'customer.updated'));
      expect(await plat.integrationOutbox.count({ where: { tenantId: b } })).toBe(0);
      await db.withTenant(a, (tx) => emit(tx, a, 'customer.updated'));
      expect(await plat.integrationOutbox.count({ where: { tenantId: a } })).toBe(1);

      const seenB = await db.withTenant(b, async (tx) => ({
        outbox: await tx.integrationOutbox.count(),
        subs: await tx.integrationSubscription.count(),
        upd: await tx.$executeRaw`UPDATE integration_subscription SET active = false`,
      }));
      expect(seenB).toEqual({ outbox: 0, subs: 0, upd: 0 });
      // B สร้าง subscription/คำสั่งให้ A ไม่ได้ (RLS WITH CHECK)
      await expect(
        subscribe(b, ['*']).then(() =>
          db.withTenant(b, (tx) =>
            tx.integrationSubscription.create({
              data: { tenantId: a, kind: 'WEBHOOK', sink: 'demo', eventTypes: ['*'] },
            }),
          ),
        ),
      ).rejects.toThrow(/row-level security/);

      let visible = -1;
      sink.fail = undefined;
      const spy = new DemoSink();
      spy.deliver = async (d) => {
        visible = await d.withTx((tx) => tx.integrationOutbox.count());
        return { result: {} };
      };
      registry.replace(spy);
      try {
        await dispatcher.drain();
      } finally {
        registry.replace(sink);
      }
      expect(visible).toBe(1); // เห็นคำสั่งของ A เท่านั้น
    });

    it('role แอปแก้สถานะ/ลบคำสั่ง และลบ subscription ไม่ได้ (worker role platform เท่านั้น) แต่ trigger/enqueue ยังสร้างได้', async () => {
      const t = (await createTenant(plat)).id;
      await subscribe(t, ['*']);
      await db.withTenant(t, (tx) => emit(tx, t, 'trip.updated')); // trigger ใต้ tms_app
      await db.withTenant(t, (tx) =>
        outbox.enqueueCommand(tx, {
          tenantId: t,
          kind: 'ADAPTER',
          sink: 'demo',
          operation: 'PUSH_X',
          entityType: 'invoice',
          localId: randomUUID(),
          payload: { a: 1 },
        }),
      );
      expect(await plat.integrationOutbox.count({ where: { tenantId: t } })).toBe(2);
      for (const sql of [
        `UPDATE integration_outbox SET status = 'DONE'`,
        `DELETE FROM integration_outbox`,
        `DELETE FROM integration_subscription`,
      ])
        await expect(
          db.withTenant(t, (tx) => tx.$executeRawUnsafe(sql)),
          sql,
        ).rejects.toThrow(/permission denied/);
      expect(await plat.integrationOutbox.count({ where: { tenantId: t } })).toBe(2);
    });
  });
});
