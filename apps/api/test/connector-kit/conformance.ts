import type { ErpCapability } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CanonicalDocument,
  type CanonicalPersonalField,
  type ErpAdapter,
  ErpAdapterError,
  type ErpContext,
  type ErpHttpCall,
  type ExternalRef,
  MAX_EXTERNAL_DOCUMENTS,
  type PushResult,
} from '../../src/modules/erp/erp-adapter';
import type { ErrorClass } from '../../src/modules/integration/outbox.types';
import {
  describeErpAdapterContract,
  type ErpAdapterContractOptions,
} from '../erp-adapter-contract';
import { FaultProxy, type HttpFault, refusedUrl } from './fault-proxy';

/**
 * P1-ST5-T01 ชุด conformance ของ connector ("template connector framework" — plan/13 P1-ST5-T01) — **ทุก adapter ต้องผ่าน**
 * ก่อนลงทะเบียนใน `src/erp-adapters/index.ts` (Definition of Done ข้อ "connector ใหม่" ของ plan/13 §1.1)
 *
 * ต่อยอด contract เดิม (`test/erp-adapter-contract.ts` — รูป, capability, กันซ้ำ, credential รั่ว) ด้วย:
 * 1. **R-01 / D-55** (`profile: 'accounting'`): เจ้าของเอกสารภาษี = ERP ตายตัว · ไม่ประกาศ pushCreditNote (TMS ไม่ส่งใบลดหนี้/ใบเสร็จในเฟสนี้)
 * 2. **ErrorClass ครบตาราง docs/01 §6.3** — ฉีดความผิดพลาด HTTP ทั่วไปผ่าน `FaultProxy` หน้า mock ของ ERP (หรือ `simulate` สำหรับ
 *    adapter ที่ไม่ใช้ HTTP) แล้วตรวจว่า push คืน class ที่ถูก + `retryable` ตรงกับ class (core ตัดสิน retry/backoff จาก class:
 *    TRANSIENT/AMBIGUOUS ลองใหม่ · AUTH หยุด connector ตาม D68-47 · อื่น ๆ ไม่ลองใหม่) · healthCheck ไม่ throw · อ่านกลับ (fetch/pull) ด้วย key ผิด
 *    = `ErpAdapterError('AUTH')` (ไม่ใช่ Error ธรรมดา ซึ่ง core ถือเป็น TRANSIENT แล้วยิงซ้ำ) · ปลายทางล่มต้องไม่ถูกรายงานเป็น "ไม่พบเอกสาร"
 * 3. **ผลที่ core เขียนลง external_mapping** — externalId/externalDocNo ไม่ว่างและ ≤ 100 (CHECK ของตาราง) · จำนวนเอกสาร ≤ MAX
 * 4. **sync log + กันซ้ำชั้น ERP** (docs/01 §6.2 ข้อ 3, §6.4) — รายงาน `onHttpCall` 1 ครั้งต่อ 1 HTTP call · คำขอเขียนมีเลขอ้างอิงของเรา
 * 5. **ข้อมูลส่วนบุคคล** (D-80 · ST8-T07) — `personalDataNeeds` อยู่ในรายการกลาง · ค่าที่ประกาศไม่ถูกสะท้อนกลับในผล/ข้อความ error ·
 *    ช่องที่ไม่ประกาศ core ไม่ใส่ (ชุดนี้ส่ง canonical แบบเดียวกับ core)
 * 6. **แยก tenant** — ไม่มีสถานะ/credential ค้างข้าม context (tenant อื่นที่ key ผิดต้องล้ม) · adapter ที่เก็บข้อมูลในโปรเซส
 *    (Demo) หรือมี `isolation.config` (บัญชี ERP คนละชุด) — เอกสารของ tenant หนึ่งไม่ถูกเห็นจากอีก tenant
 *
 * ส่วนที่ต้องใช้ฐานข้อมูล (คิว/สถานะ connector/external_mapping จริง) อยู่ใน `test/connector-conformance-pipeline.test.ts`
 * วิธีใช้และวิธีเพิ่ม connector ใหม่: `src/erp-adapters/README.md`
 */

/** ความผิดพลาดที่ชุดนี้ฉีด (docs/01 §6.3 คอลัมน์ "ตัวอย่างต้นทาง") */
export const CONFORMANCE_FAULTS = [
  'auth401',
  'auth403',
  'rateLimit429',
  'unavailable503',
  'serverError500',
  'refused',
  'badRequest400',
  'rejected422',
  'resetAfterSend',
  'duplicate',
  'periodClosed',
] as const;
export type ConformanceFault = (typeof CONFORMANCE_FAULTS)[number];

/** ErrorClass ที่คาด (docs/01 §6.3) — ต่างจากนี้ได้เฉพาะเมื่อมีข้อยกเว้นพร้อมเหตุผลใน `exceptions` */
export const EXPECTED_CLASS: Record<ConformanceFault, ErrorClass> = {
  auth401: 'AUTH',
  auth403: 'AUTH',
  rateLimit429: 'TRANSIENT',
  unavailable503: 'TRANSIENT',
  serverError500: 'TRANSIENT',
  refused: 'TRANSIENT',
  badRequest400: 'VALIDATION',
  rejected422: 'VALIDATION',
  resetAfterSend: 'AMBIGUOUS',
  duplicate: 'DUPLICATE',
  periodClosed: 'PERIOD_CLOSED',
};

/** class ที่ core ลองใหม่ (retryable ต้องเป็น true) — อื่น ๆ ต้อง false */
const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['TRANSIENT', 'AMBIGUOUS']);

/** fault แบบ HTTP ทั่วไป (duplicate/periodClosed ต้องมี fixture ของ ERP — ไม่มี = ข้าม) */
const HTTP_FAULT: Record<Exclude<ConformanceFault, 'refused'>, HttpFault | null> = {
  auth401: { kind: 'status', status: 401, on: 'any' },
  auth403: { kind: 'status', status: 403, on: 'any' },
  rateLimit429: { kind: 'status', status: 429, on: 'any' },
  unavailable503: { kind: 'status', status: 503, on: 'any' },
  serverError500: { kind: 'status', status: 500, on: 'write' },
  badRequest400: { kind: 'status', status: 400, on: 'write' },
  rejected422: { kind: 'status', status: 422, on: 'write' },
  resetAfterSend: { kind: 'reset', on: 'write' },
  duplicate: null,
  periodClosed: null,
};

export interface ConnectorConformanceOptions extends ErpAdapterContractOptions {
  /** R-01: connector โปรแกรมบัญชี (AccountSystem / FlowAccount / PEAK) */
  profile?: 'accounting';
  /** adapter ที่คุยกับ ERP ทาง HTTP — ชุดนี้วาง `FaultProxy` หน้า mock */
  http?: {
    /** URL ของ mock (อ่านตอนรันแต่ละข้อ — ตั้งหลัง mock เริ่มได้) */
    upstream: () => string;
    /** ช่องค่าตั้งที่เป็น base URL (ค่าเริ่ม `baseUrl`) */
    urlKey?: string;
    /** path ของคำขอที่สร้างเอกสาร — fault แบบ `write` โดนเฉพาะคำขอนี้ (ไม่ระบุ = คำขอเขียนแรก) */
    writePath?: RegExp;
    /** คำตอบของ ERP จริงสำหรับ "เลขอ้างอิงซ้ำ" / "งวดปิด" (ไม่มี = ข้ามข้อนั้น) */
    fixtures?: Partial<Record<'duplicate' | 'periodClosed', { status: number; body: unknown }>>;
  };
  /** adapter ที่ไม่ใช้ HTTP (Demo): ค่าตั้งที่ทำให้เกิด fault นี้ · null = จำลองไม่ได้ (ข้าม) */
  simulate?: (fault: ConformanceFault) => Record<string, string> | null;
  /** ผลที่ต่างจากตาราง docs/01 §6.3 ได้ — **ต้องมีเหตุผล** (แสดงในชื่อ test และคู่มือ) */
  exceptions?: Partial<
    Record<ConformanceFault, { expect: readonly ErrorClass[] | 'skip'; reason: string }>
  >;
  /** ค่าตั้งของ "บัญชี ERP ของอีก tenant" (เช่น mock ตัวที่สอง) — ไม่ส่ง = ใช้ค่าเดียวกัน (adapter ที่เก็บข้อมูลในโปรเซสต้องแยกเอง) */
  isolation?: { config: () => Record<string, string> };
}

const TENANT_A = '00000000-0000-4000-8000-00000000c0a1';
const TENANT_B = '00000000-0000-4000-8000-00000000c0b1';
const CON_A = '00000000-0000-4000-8000-00000000c0a2';
const CON_B = '00000000-0000-4000-8000-00000000c0b2';
const SENTINEL = 'SENTINEL-secret-c0nf0rm4nce';
/** เลขบัตรประชาชนตัวอย่าง (checksum ถูก — ไม่ใช่ของคนจริง) */
const NATIONAL_ID_SENTINEL = '3100600445512';
const DRIVER_SENTINEL = 'คนขับ-ทดสอบ-ส่วนบุคคล';

type PushOp = 'pushInvoice' | 'pushSettlement' | 'pushCreditNote';
const PUSHES: ReadonlyArray<[PushOp, 'invoice' | 'settlement' | 'creditNote']> = [
  ['pushInvoice', 'invoice'],
  ['pushSettlement', 'settlement'],
  ['pushCreditNote', 'creditNote'],
];
const READS = ['fetchDocument', 'fetchPaymentStatus', 'listDocuments', 'pullOrders'] as const;

let seq = 0;
/** เอกสารใหม่ (id + เลขไม่ซ้ำ) จากตัวอย่าง — mock ที่กันซ้ำด้วยเลขอ้างอิงจะไม่ตอบ "ซ้ำ" ข้ามข้อ */
function fresh(doc: CanonicalDocument): CanonicalDocument {
  const n = ++seq;
  return { ...doc, id: randomUUID(), number: `${doc.number}-${n}` };
}

/** ใส่ข้อมูลส่วนบุคคลเฉพาะช่องที่ประกาศ (แบบเดียวกับ core: canonical.ts / personal-data.ts) — ไม่ประกาศ = ล้างเป็น null */
function withPersonalData(
  doc: CanonicalDocument,
  needs: readonly CanonicalPersonalField[],
): CanonicalDocument {
  const d = structuredClone(doc) as CanonicalDocument & {
    lines?: { trip?: { driverName?: unknown } | null }[];
    carrier?: { entityType?: unknown; taxId?: unknown } | null;
  };
  for (const l of d.lines ?? [])
    if (l.trip && 'driverName' in l.trip)
      l.trip.driverName = needs.includes('trip.driverName') ? DRIVER_SENTINEL : null;
  if (d.carrier?.entityType === 'INDIVIDUAL')
    d.carrier.taxId = needs.includes('carrier.taxId') ? NATIONAL_ID_SENTINEL : null;
  return d;
}

const show = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

export function describeConnectorConformance(name: string, opts: ConnectorConformanceOptions) {
  describeErpAdapterContract(name, opts);

  describe(`Connector conformance (P1-ST5-T01) — ${name}`, () => {
    const proxy = opts.http ? new FaultProxy(opts.http.writePath) : null;
    const urlKey = opts.http?.urlKey ?? 'baseUrl';
    let refused = '';
    beforeAll(async () => {
      if (proxy) await proxy.start();
      refused = await refusedUrl();
    });
    afterAll(async () => {
      await proxy?.stop();
    });

    const needs = () => opts.make().personalDataNeeds ?? [];
    /** push ทุกตัวที่ adapter ทำได้จริงและมีตัวอย่าง (ข้อมูลส่วนบุคคลใส่แบบเดียวกับ core) */
    const pushTargets = (a: ErpAdapter): { op: PushOp; doc: CanonicalDocument }[] =>
      PUSHES.flatMap(([op, k]) => {
        const doc = opts.samples?.[k];
        return a.capabilities().has(op) && doc && !opts.notImplemented?.includes(op)
          ? [{ op, doc: withPersonalData(doc, needs()) }]
          : [];
      });
    /** push แรก (ใช้ตรวจ ErrorClass / sync log / แยก tenant) */
    const pushTarget = (a: ErpAdapter) => pushTargets(a)[0] ?? null;
    const config = (over: Record<string, string> = {}) => {
      const base = { ...opts.config, ...over };
      if (proxy && !over[urlKey]) base[urlKey] = proxy.via(opts.http!.upstream());
      return base;
    };
    const ctx = (
      cfg: Record<string, string>,
      calls: ErpHttpCall[] = [],
      tenant: 'A' | 'B' = 'A',
    ): ErpContext => ({
      tenantId: tenant === 'A' ? TENANT_A : TENANT_B,
      connectorId: tenant === 'A' ? CON_A : CON_B,
      companyId: null,
      erpCompanyCode: null,
      config: Object.freeze({ ...cfg }),
      idempotencyKey: `conformance:${randomUUID()}`,
      onHttpCall: (c) => calls.push(c),
      ...opts.context,
    });
    const push = (a: ErpAdapter, op: PushOp, c: ErpContext, doc: CanonicalDocument) =>
      (a[op] as (c: ErpContext, d: CanonicalDocument) => Promise<PushResult>).call(a, c, doc);
    /** config สำหรับ fault (null = ฉีดไม่ได้กับ adapter นี้) + ช่อง secret เป็น sentinel เมื่อ fault ไม่ต้องผ่าน mock */
    const faultConfig = (fault: ConformanceFault): Record<string, string> | null => {
      if (opts.simulate) {
        const over = opts.simulate(fault);
        return over ? config(over) : null;
      }
      if (!proxy) return null;
      if (fault === 'refused') return config({ [urlKey]: `${refused}/x` });
      const f =
        fault === 'duplicate' || fault === 'periodClosed'
          ? opts.http!.fixtures?.[fault]
            ? ({
                kind: 'status',
                ...opts.http!.fixtures[fault]!,
                on: 'write',
              } satisfies HttpFault)
            : null
          : HTTP_FAULT[fault];
      if (!f) return null;
      proxy.arm(f);
      const cfg = config();
      // fault ที่โดนทุกคำขอ = ไม่มีคำขอใดถึง mock → ใช้ credential sentinel ได้ (ตรวจการรั่วในผล/sync log ไปด้วย)
      if (f.on === 'any')
        for (const k of opts
          .make()
          .configFields.filter((x) => x.secret)
          .map((x) => x.key))
          cfg[k] = `${SENTINEL}-${k}`;
      return cfg;
    };
    const disarm = () => proxy?.clear();

    if (opts.profile === 'accounting')
      it('R-01 / D-55: เจ้าของเอกสารภาษี = ERP ตายตัว · ไม่ส่งใบลดหนี้/ใบเสร็จ (ไม่มี pushCreditNote)', () => {
        const a = opts.make();
        expect(a.fixedSystemOfRecord?.taxDocumentOwner).toBe('ERP');
        expect(a.capabilities().has('pushCreditNote')).toBe(false);
        expect(a.capabilities().has('pushInvoice') || a.capabilities().has('pushSettlement')).toBe(
          true,
        );
      });

    it('ข้อมูลส่วนบุคคล (D-80): personalDataNeeds อยู่ในรายการกลาง · ค่าที่ประกาศไม่สะท้อนกลับในผล/ข้อความ error', async () => {
      const a = opts.make();
      for (const f of a.personalDataNeeds ?? [])
        expect(['trip.driverName', 'carrier.taxId']).toContain(f);
      for (const t of pushTargets(a))
        for (const fault of [null, 'rejected422'] as const) {
          const cfg = fault ? faultConfig(fault) : config();
          if (!cfg) continue;
          let out: unknown;
          try {
            out = await push(a, t.op, ctx(cfg), fresh(t.doc));
          } catch (e) {
            out = { thrown: String((e as Error)?.message ?? e) };
          } finally {
            disarm();
          }
          const text = show(out);
          expect(text).not.toContain(NATIONAL_ID_SENTINEL);
          expect(text).not.toContain(DRIVER_SENTINEL);
        }
    });

    it('push สำเร็จ: ผลเขียนลง external_mapping ได้ (externalId/เลขเอกสาร ≤ 100) · sync log 1 ครั้งต่อ 1 HTTP call · คำขอเขียนมีเลขอ้างอิงของเรา (กันซ้ำชั้น ERP)', async () => {
      const a = opts.make();
      const t = pushTarget(a);
      if (!t) return;
      const calls: ErpHttpCall[] = [];
      disarm();
      const doc = fresh(t.doc);
      const r = await push(a, t.op, ctx(config(), calls), doc);
      expect(r.ok, show(r)).toBe(true);
      if (!r.ok) return;
      const ids = [r.externalId, ...(r.documents ?? []).map((d) => d.externalId)];
      for (const id of ids) {
        expect(id.trim()).not.toBe('');
        expect(id.length).toBeLessThanOrEqual(100);
      }
      for (const no of [r.externalDocNo, ...(r.documents ?? []).map((d) => d.externalDocNo)])
        if (no != null) expect(no.length).toBeLessThanOrEqual(100);
      expect((r.documents ?? []).length).toBeLessThanOrEqual(MAX_EXTERNAL_DOCUMENTS);
      // docs/01 §6.4 ทุก HTTP call ถูกรายงาน (adapter ที่ไม่ใช้ HTTP จริงรายงาน call จำลองก็ได้)
      expect(calls.length, 'onHttpCall ไม่ถูกเรียก').toBeGreaterThan(0);
      if (proxy) expect(calls.length).toBe(proxy.captured.length);
      // docs/01 §6.2 ข้อ 3 เลขอ้างอิงของเราไปในคำขอเขียน (ERP ใช้กันซ้ำ)
      const writes = proxy
        ? proxy.captured.filter((c) => c.method !== 'GET').map((c) => c.body)
        : calls.filter((c) => c.method !== 'GET').map((c) => show(c.requestBody));
      expect(writes.some((b) => b.includes(doc.number))).toBe(true);
      for (const c of calls) expect(c.method).toMatch(/^[A-Z]+$/);
    });

    for (const fault of CONFORMANCE_FAULTS) {
      const ex = opts.exceptions?.[fault];
      const expected: readonly ErrorClass[] =
        ex && ex.expect !== 'skip' ? ex.expect : [EXPECTED_CLASS[fault]];
      const title = ex
        ? `${fault} → ${ex.expect === 'skip' ? 'ข้าม' : ex.expect.join('|')} (ข้อยกเว้น: ${ex.reason})`
        : `${fault} → ${EXPECTED_CLASS[fault]} (docs/01 §6.3)`;
      it(`ErrorClass: ${title}`, async () => {
        if (ex?.expect === 'skip') return;
        const a = opts.make();
        const t = pushTarget(a);
        const cfg = faultConfig(fault);
        if (!cfg) return; // ฉีด fault นี้กับ adapter นี้ไม่ได้ (ไม่มี fixture / ไม่ใช่ HTTP)
        try {
          if (t) {
            const calls: ErpHttpCall[] = [];
            let r: PushResult | null = null;
            let thrown: unknown = null;
            try {
              r = await push(a, t.op, ctx(cfg, calls), fresh(t.doc));
            } catch (e) {
              thrown = e;
            }
            if (thrown) {
              // throw = core ถือเป็น TRANSIENT — ยอมเฉพาะเมื่อคาด TRANSIENT · ErpAdapterError ต้องมี class ที่คาด
              if (thrown instanceof ErpAdapterError) expect(expected).toContain(thrown.errorClass);
              else expect(expected, `throw ${String(thrown)}`).toContain('TRANSIENT');
            } else if (r!.ok) {
              // DUPLICATE ที่ adapter ตามหาเอกสารเดิมได้เอง = ok แต่ต้องไม่อ้างว่าเนื้อหาตรง (applied ไม่ใช่ true)
              expect(fault, show(r)).toBe('duplicate');
              expect(r!.applied).not.toBe(true);
            } else {
              expect(expected, show(r)).toContain(r!.errorClass);
              expect(r!.retryable, show(r)).toBe(RETRYABLE.has(r!.errorClass));
              expect(typeof r!.problem.code).toBe('string');
            }
            const text = show({ r, thrown: thrown ? String(thrown) : null, calls });
            expect(text).not.toContain(SENTINEL);
          }
          // healthCheck: ไม่ throw · fault ที่โดนทุกคำขอ = ไม่ผ่าน พร้อม class ที่คาด
          const h = await a.healthCheck(ctx(cfg));
          if (fault === 'refused' || HTTP_FAULT[fault as keyof typeof HTTP_FAULT]?.on === 'any') {
            expect(h.ok, show(h)).toBe(false);
            if (!h.ok) expect(expected).toContain(h.errorClass);
          }
          expect(show(h)).not.toContain(SENTINEL);
          // อ่านกลับ: key ผิด = ErpAdapterError AUTH (D68-47 หยุด connector — ไม่ใช่ TRANSIENT) ·
          // ปลายทางล่ม = throw (ห้ามคืน null — core จะถือว่า "ไม่พบเอกสาร" → REMOTE_MISSING)
          if (fault === 'auth401' || fault === 'unavailable503' || fault === 'refused')
            await readsUnder(a, cfg, fault, expected);
        } finally {
          disarm();
        }
      });
    }

    /** method อ่านกลับที่ประกาศ ภายใต้ fault ที่โดนทุกคำขอ */
    async function readsUnder(
      a: ErpAdapter,
      cfg: Record<string, string>,
      fault: ConformanceFault,
      expected: readonly ErrorClass[],
    ) {
      const ref: ExternalRef = opts.samples?.ref ?? {
        entityType: 'invoice',
        localId: randomUUID(),
        number: 'CONFORMANCE-READ-1',
        externalId: 'conformance-ext-1',
      };
      for (const m of READS) {
        if (!a.capabilities().has(m as ErpCapability) || opts.notImplemented?.includes(m)) continue;
        const call = (): Promise<unknown> => {
          const c = ctx(cfg);
          switch (m) {
            case 'fetchDocument':
              return a.fetchDocument!(c, ref);
            case 'fetchPaymentStatus':
              return a.fetchPaymentStatus!(c, ref);
            case 'listDocuments':
              return a.listDocuments!(c, { limit: 5, ref: ref.number });
            case 'pullOrders':
              return a.pullOrders!(c, null, 5);
          }
        };
        let thrown: unknown = null;
        let out: unknown;
        try {
          out = await call();
        } catch (e) {
          thrown = e;
        }
        // adapter ที่จำลอง fault ด้วยค่าตั้ง (ไม่ใช่ HTTP) อาจไม่จำลองฝั่งอ่าน — ตรวจเฉพาะ AUTH
        if (!thrown && opts.simulate && fault !== 'auth401') continue;
        expect(thrown, `${m} ภายใต้ ${fault} ต้อง throw แต่คืน ${show(out)}`).not.toBeNull();
        if (fault === 'auth401') {
          expect(thrown, `${m}: ${String(thrown)}`).toBeInstanceOf(ErpAdapterError);
          expect((thrown as ErpAdapterError).errorClass).toBe('AUTH');
        } else if (thrown instanceof ErpAdapterError)
          expect([...expected, 'AMBIGUOUS']).toContain(thrown.errorClass);
        expect(String((thrown as Error)?.message ?? thrown)).not.toContain(SENTINEL);
      }
    }

    it('แยก tenant: ไม่มี credential/สถานะค้างข้าม context · เอกสารของ tenant หนึ่งไม่ถูกเห็นจากอีก tenant', async () => {
      const a = opts.make();
      const t = pushTarget(a);
      disarm();
      let ref: ExternalRef | null = null;
      if (t) {
        const doc = fresh(t.doc);
        const r = await push(a, t.op, ctx(config()), doc);
        expect(r.ok, show(r)).toBe(true);
        if (r.ok)
          ref = {
            entityType: t.op === 'pushSettlement' ? 'settlement' : 'invoice',
            localId: doc.id,
            number: doc.number,
            externalId: r.externalId,
          };
      }
      // instance เดียวกัน (registry ถือ adapter ตัวเดียวทั้ง process) — tenant อื่นที่ key ผิดต้องล้ม ไม่ใช้ของ tenant แรก
      if (opts.badConfig) {
        const h = await a.healthCheck(ctx(config(opts.badConfig), [], 'B'));
        expect(h.ok).toBe(false);
        if (t) {
          const r = await push(a, t.op, ctx(config(opts.badConfig), [], 'B'), fresh(t.doc));
          expect(r.ok, show(r)).toBe(false);
        }
      }
      if (!ref) return;
      const cfgB = opts.isolation ? opts.isolation.config() : config();
      // ERP เดียวกันจริง (HTTP + ค่าตั้งเดียวกัน) = เห็นได้ถูกต้อง → ตรวจเฉพาะ adapter ในโปรเซส หรือมีบัญชีแยก
      if (proxy && !opts.isolation) return;
      if (
        a.capabilities().has('fetchDocument') &&
        !opts.notImplemented?.includes('fetchDocument')
      ) {
        let got: unknown = null;
        try {
          got = await a.fetchDocument!(ctx(cfgB, [], 'B'), ref);
        } catch (e) {
          // NOT_FOUND ก็คือไม่เห็น
          expect((e as ErpAdapterError).errorClass).toBe('NOT_FOUND');
        }
        expect(got).toBeNull();
      }
      if (
        a.capabilities().has('listDocuments') &&
        !opts.notImplemented?.includes('listDocuments')
      ) {
        const l = await a.listDocuments!(ctx(cfgB, [], 'B'), { limit: 50, ref: ref.number });
        expect(l.items.map((i) => i.number)).not.toContain(ref.number);
      }
    });
  });
}
