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
  type HealthResult,
  MAX_EXTERNAL_DOCUMENTS,
  NOT_IMPLEMENTED,
  type PushResult,
} from '../../src/modules/erp/erp-adapter';
import type { ErrorClass } from '../../src/modules/integration/outbox.types';
import {
  describeErpAdapterContract,
  type ErpAdapterContractOptions,
} from '../erp-adapter-contract';
import { type CapturedRequest, FaultProxy, type HttpFault, refusedUrl } from './fault-proxy';

/**
 * P1-ST5-T01 ชุด conformance ของ connector ("template connector framework" — plan/13 P1-ST5-T01) — **ทุก adapter ต้องผ่าน**
 * ก่อนลงทะเบียนใน `src/erp-adapters/index.ts` (Definition of Done ข้อ "connector ใหม่" ของ plan/13 §1.1)
 *
 * ต่อยอด contract เดิม (`test/erp-adapter-contract.ts` — รูป, capability, กันซ้ำ, credential รั่ว) ด้วย:
 * 1. **R-01 / D-55** (`profile: 'accounting'`): เจ้าของเอกสารภาษี = ERP ตายตัว · ไม่ประกาศ pushCreditNote (TMS ไม่ส่งใบลดหนี้/ใบเสร็จในเฟสนี้)
 * 2. **ErrorClass ครบตาราง docs/01 §6.3** — ฉีดความผิดพลาด HTTP ผ่าน `FaultProxy` หน้า mock ของ ERP (หรือ `simulate` สำหรับ
 *    adapter ที่ไม่ใช้ HTTP) แล้วตรวจ class + `retryable` (core ตัดสิน retry/backoff จาก class: TRANSIENT/AMBIGUOUS ลองใหม่ ·
 *    AUTH หยุด connector ตาม D68-47 · อื่น ๆ ไม่ลองใหม่) · healthCheck ไม่ throw · อ่านกลับด้วย key ผิด = `ErpAdapterError('AUTH')`
 *    · ปลายทางล่มระหว่างอ่านต้อง throw (ห้ามคืน null) · 404 ตอน fetch/replace = NOT_FOUND · capability ที่ค้าง = CAPABILITY
 * 3. **ผลที่ core เขียนลง external_mapping** — externalId/externalDocNo ไม่ว่างและ ≤ 100 (CHECK ของตาราง) · จำนวนเอกสาร ≤ MAX
 * 4. **sync log + กันซ้ำชั้น ERP** (docs/01 §6.2 ข้อ 3, §6.4) — `onHttpCall` 1 ครั้งต่อ 1 HTTP call · คำขอเขียนมีเลขอ้างอิงของเรา
 * 5. **ข้อมูลส่วนบุคคล** (D-80 · ST8-T07) — `personalDataNeeds` อยู่ในรายการกลาง · ค่าที่ประกาศไม่ถูกสะท้อนกลับในผล/ข้อความ error
 * 6. **แยก tenant** — ไม่มีสถานะ/credential ค้างข้าม context · adapter ที่เก็บข้อมูลในโปรเซส (Demo) หรือมี `isolation.config`
 *    (บัญชี ERP คนละชุด) — เอกสารของ tenant หนึ่งไม่ถูกเห็นจากอีก tenant
 *
 * **ไม่มีการผ่านแบบเงียบ:** ข้อที่ตรวจกับ adapter นี้ไม่ได้ (ไม่มี fixture / จำลองไม่ได้) ต้องมี `exceptions` พร้อมเหตุผล
 * (แสดงเป็น test ที่ข้ามพร้อมเหตุผล) — ไม่มี = test ล้ม · push ที่ประกาศต้องมีตัวอย่างใน `samples`
 *
 * ตัวตรวจ (`check*`) เป็นฟังก์ชันบริสุทธิ์ที่คืนรายการปัญหา — มี self-test กับ adapter ที่ตั้งใจทำผิด (`connector-kit-selftest.test.ts`)
 * ส่วนที่ต้องใช้ฐานข้อมูลอยู่ใน `pipeline.ts` · วิธีเพิ่ม connector: `src/erp-adapters/README.md`
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
  'resetAfterForward',
  'duplicate',
  'periodClosed',
  'notFound404',
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
  resetAfterForward: 'AMBIGUOUS',
  duplicate: 'DUPLICATE',
  periodClosed: 'PERIOD_CLOSED',
  notFound404: 'NOT_FOUND',
};

/** class ที่ core ลองใหม่ (retryable ต้องเป็น true) — อื่น ๆ ต้อง false */
const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['TRANSIENT', 'AMBIGUOUS']);

/** fault แบบ HTTP ทั่วไป · null = ต้องมี fixture ของ ERP (duplicate/periodClosed) */
const HTTP_FAULT: Record<Exclude<ConformanceFault, 'refused'>, HttpFault | null> = {
  auth401: { kind: 'status', status: 401, on: 'any' },
  auth403: { kind: 'status', status: 403, on: 'any' },
  rateLimit429: { kind: 'status', status: 429, on: 'any' },
  unavailable503: { kind: 'status', status: 503, on: 'any' },
  serverError500: { kind: 'status', status: 500, on: 'write' },
  badRequest400: { kind: 'status', status: 400, on: 'write' },
  rejected422: { kind: 'status', status: 422, on: 'write' },
  resetAfterSend: { kind: 'reset', on: 'write' },
  resetAfterForward: { kind: 'resetAfterForward', on: 'write' },
  duplicate: null,
  periodClosed: null,
  notFound404: { kind: 'status', status: 404, on: 'any' },
};

/** fault ที่โดนทุกคำขอ (ไม่มีคำขอใดถึง mock — healthCheck ต้องไม่ผ่าน) */
const ALL_REQUESTS: ReadonlySet<ConformanceFault> = new Set([
  'auth401',
  'auth403',
  'rateLimit429',
  'unavailable503',
  'refused',
]);
/** fault ที่ตรวจฝั่งอ่านกลับด้วย */
const READ_FAULTS: ReadonlySet<ConformanceFault> = new Set([
  'auth401',
  'auth403',
  'unavailable503',
  'refused',
]);

export interface ConformanceException {
  /** class ที่ยอมรับแทน · 'skip' = ตรวจข้อนี้กับ adapter นี้ไม่ได้ */
  expect: readonly ErrorClass[] | 'skip';
  reason: string;
}

export interface ConnectorConformanceOptions extends ErpAdapterContractOptions {
  /** R-01: connector โปรแกรมบัญชี (AccountSystem / FlowAccount / PEAK) */
  profile?: 'accounting';
  /** adapter ที่คุยกับ ERP ทาง HTTP — ชุดนี้วาง `FaultProxy` หน้า mock */
  http?: {
    /** URL ของ mock (อ่านตอนรันแต่ละข้อ — ตั้งหลัง mock เริ่มได้) */
    upstream: () => string;
    /** ช่องค่าตั้งที่เป็น base URL (ค่าเริ่ม `baseUrl`) */
    urlKey?: string;
    /** path ของคำขอที่สร้างเอกสาร — fault แบบ `write` โดนเฉพาะคำขอนี้ (ไม่ระบุ = คำขอเขียนทุกตัว) */
    writePath?: RegExp;
    /** คำตอบของ ERP จริงสำหรับ "เลขอ้างอิงซ้ำ" / "งวดปิด" (ไม่มี = ต้องมี exceptions พร้อมเหตุผล) */
    fixtures?: Partial<Record<'duplicate' | 'periodClosed', { status: number; body: unknown }>>;
    /** จำนวนเอกสารใน mock ที่มีเลขอ้างอิงของเรานี้ — ใช้ยืนยันว่าส่งซ้ำหลัง resetAfterForward ไม่เกิดเอกสารซ้ำ */
    documentsWithRef?: (ref: string) => number;
  };
  /** adapter ที่ไม่ใช้ HTTP (Demo): ค่าตั้งที่ทำให้เกิด fault นี้ · null = จำลองไม่ได้ (ต้องมี exceptions พร้อมเหตุผล) */
  simulate?: (fault: ConformanceFault) => Record<string, string> | null;
  /** ผลที่ต่างจากตาราง docs/01 §6.3 / ข้อที่ตรวจไม่ได้ — **ต้องมีเหตุผล** (แสดงในชื่อ test และคู่มือ README §3) */
  exceptions?: Partial<Record<ConformanceFault, ConformanceException>>;
  /** ค่าตั้งของ "บัญชี ERP ของอีก tenant" (เช่น mock ตัวที่สอง) — ไม่ส่ง = ใช้ค่าเดียวกัน (adapter ที่เก็บข้อมูลในโปรเซสต้องแยกเอง) */
  isolation?: { config: () => Record<string, string>; label?: string };
}

const TENANT_A = '00000000-0000-4000-8000-00000000c0a1';
const TENANT_B = '00000000-0000-4000-8000-00000000c0b1';
const CON_A = '00000000-0000-4000-8000-00000000c0a2';
const CON_B = '00000000-0000-4000-8000-00000000c0b2';
export const SENTINEL = 'SENTINEL-secret-c0nf0rm4nce';
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

export const show = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

// ---------- ตัวตรวจ (ฟังก์ชันบริสุทธิ์ — คืนรายการปัญหา · ว่าง = ผ่าน) ----------

/** ผลของ push ภายใต้ fault: PushResult หรือสิ่งที่ throw */
export type PushOutcome = { result: PushResult } | { thrown: unknown };

/** push ภายใต้ fault ต้องคืน class ที่คาด + retryable ตรงกับ class (throw ธรรมดา = TRANSIENT ของ core) */
export function checkPushOutcome(
  o: PushOutcome,
  fault: ConformanceFault,
  expected: readonly ErrorClass[],
): string[] {
  if ('thrown' in o) {
    if (o.thrown instanceof ErpAdapterError)
      return expected.includes(o.thrown.errorClass)
        ? []
        : [`${fault}: throw ErpAdapterError(${o.thrown.errorClass}) — คาด ${expected.join('|')}`];
    return expected.includes('TRANSIENT')
      ? []
      : [`${fault}: throw ${String(o.thrown)} (core ถือ TRANSIENT) — คาด ${expected.join('|')}`];
  }
  const r = o.result;
  if (r.ok) {
    // DUPLICATE ที่ adapter ตามหาเอกสารเดิมได้เอง = ok แต่ต้องไม่อ้างว่าเนื้อหาตรง
    if (fault === 'duplicate' && r.applied !== true) return [];
    return [`${fault}: push สำเร็จ (${show(r)}) — คาด ${expected.join('|')}`];
  }
  const out: string[] = [];
  if (!expected.includes(r.errorClass))
    out.push(`${fault}: errorClass ${r.errorClass} — คาด ${expected.join('|')}`);
  if (r.retryable !== RETRYABLE.has(r.errorClass))
    out.push(`${fault}: retryable ${r.retryable} ไม่ตรงกับ class ${r.errorClass}`);
  if (typeof r.problem?.code !== 'string') out.push(`${fault}: problem.code ต้องเป็นสตริง`);
  return out;
}

/** healthCheck ภายใต้ fault ที่โดนทุกคำขอ ต้องไม่ผ่านด้วย class ที่คาด */
export function checkHealthOutcome(
  h: HealthResult,
  fault: ConformanceFault,
  expected: readonly ErrorClass[],
): string[] {
  if (!ALL_REQUESTS.has(fault)) return [];
  if (h.ok) return [`${fault}: healthCheck ผ่านทั้งที่ทุกคำขอล้ม`];
  return expected.includes(h.errorClass)
    ? []
    : [`${fault}: healthCheck errorClass ${h.errorClass} — คาด ${expected.join('|')}`];
}

/**
 * อ่านกลับภายใต้ fault: key ผิด = `ErpAdapterError('AUTH')` (Error ธรรมดา = core ยิงซ้ำ ไม่หยุด connector — D68-47) ·
 * ปลายทางล่ม = throw (คืนค่า/null = core ถือว่า "ไม่พบ" → REMOTE_MISSING)
 */
export function checkReadOutcome(
  method: string,
  o: { thrown: unknown } | { value: unknown },
  fault: ConformanceFault,
  expected: readonly ErrorClass[],
): string[] {
  if (!('thrown' in o)) return [`${method} ภายใต้ ${fault} ต้อง throw แต่คืน ${show(o.value)}`];
  const auth = fault === 'auth401' || fault === 'auth403';
  if (auth) {
    if (!(o.thrown instanceof ErpAdapterError))
      return [
        `${method} ภายใต้ ${fault}: throw ${String(o.thrown)} — ต้องเป็น ErpAdapterError('AUTH')`,
      ];
    return o.thrown.errorClass === 'AUTH'
      ? []
      : [`${method} ภายใต้ ${fault}: ErpAdapterError(${o.thrown.errorClass}) — ต้องเป็น AUTH`];
  }
  if (
    o.thrown instanceof ErpAdapterError &&
    ![...expected, 'AMBIGUOUS'].includes(o.thrown.errorClass)
  )
    return [
      `${method} ภายใต้ ${fault}: ErpAdapterError(${o.thrown.errorClass}) — คาด ${expected.join('|')}`,
    ];
  return [];
}

/** 404 ตอน fetchDocument = null หรือ ErpAdapterError NOT_FOUND (docs/01 §6.3) */
export function checkNotFoundFetch(o: { thrown: unknown } | { value: unknown }): string[] {
  if ('thrown' in o)
    return o.thrown instanceof ErpAdapterError && o.thrown.errorClass === 'NOT_FOUND'
      ? []
      : [
          `fetchDocument 404: throw ${String(o.thrown)} — ต้องเป็น null หรือ ErpAdapterError('NOT_FOUND')`,
        ];
  return o.value === null ? [] : [`fetchDocument 404: คืน ${show(o.value)} — ต้องเป็น null`];
}

/** sync log (docs/01 §6.4): รายงานอย่างน้อย 1 ครั้ง และ (HTTP จริง) เท่ากับจำนวนคำขอที่ออกไป */
export function checkSyncLog(
  calls: readonly ErpHttpCall[],
  captured: CapturedRequest[] | null,
): string[] {
  const out: string[] = [];
  if (!calls.length) out.push('onHttpCall ไม่ถูกเรียก');
  if (captured && calls.length !== captured.length)
    out.push(`onHttpCall ${calls.length} ครั้ง แต่มี HTTP call จริง ${captured.length} ครั้ง`);
  for (const c of calls) if (!/^[A-Z]+$/.test(c.method)) out.push(`method '${c.method}' ไม่ถูกรูป`);
  return out;
}

/** capability ที่ค้าง (`pendingCapabilities`) ต้องตอบ CAPABILITY `not_implemented` */
export function checkPendingOutcome(cap: string, o: PushOutcome | { value: unknown }): string[] {
  let r: unknown;
  if ('thrown' in o)
    r =
      o.thrown instanceof ErpAdapterError
        ? { ok: false, errorClass: o.thrown.errorClass, problem: o.thrown.problem }
        : { thrown: String(o.thrown) };
  else r = 'result' in o ? o.result : o.value;
  const x = r as { ok?: unknown; errorClass?: unknown; problem?: { code?: unknown } } | null;
  return x?.ok === false && x.errorClass === 'CAPABILITY' && x.problem?.code === NOT_IMPLEMENTED
    ? []
    : [`pending capability ${cap}: ${show(r)} — ต้องตอบ CAPABILITY ${NOT_IMPLEMENTED}`];
}

/** ตรวจว่าทุก fault ที่ adapter นี้ฉีดไม่ได้มี exceptions พร้อมเหตุผล — คืนรายการ fault ที่ขาด */
export function missingExceptions(opts: ConnectorConformanceOptions): string[] {
  const caps = opts.make().capabilities();
  return CONFORMANCE_FAULTS.filter(
    (f) =>
      !(f === 'notFound404' && !caps.has('fetchDocument') && !caps.has('replaceDocument')) &&
      !injectable(opts, f) &&
      !opts.exceptions?.[f]?.reason,
  );
}

/** ฉีด fault นี้กับ adapter นี้ได้ไหม (ไม่ขึ้นกับเวลา — ใช้ตอนประกาศ test) */
function injectable(opts: ConnectorConformanceOptions, f: ConformanceFault): boolean {
  if (opts.simulate) return opts.simulate(f) !== null;
  if (!opts.http) return false;
  if (f === 'duplicate' || f === 'periodClosed') return !!opts.http.fixtures?.[f];
  return true;
}

// ---------- ชุด test ----------

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
    const declaredPushes = (a: ErpAdapter) =>
      PUSHES.filter(([op]) => a.capabilities().has(op) && !opts.notImplemented?.includes(op));
    /** push ทุกตัวที่ adapter ทำได้จริง (ข้อมูลส่วนบุคคลใส่แบบเดียวกับ core) */
    const pushTargets = (a: ErpAdapter): { op: PushOp; doc: CanonicalDocument }[] =>
      declaredPushes(a).flatMap(([op, k]) => {
        const doc = opts.samples?.[k];
        return doc ? [{ op, doc: withPersonalData(doc, needs()) }] : [];
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
      key = `conformance:${randomUUID()}`,
    ): ErpContext => ({
      tenantId: tenant === 'A' ? TENANT_A : TENANT_B,
      connectorId: tenant === 'A' ? CON_A : CON_B,
      companyId: null,
      erpCompanyCode: null,
      config: Object.freeze({ ...cfg }),
      idempotencyKey: key,
      onHttpCall: (c) => calls.push(c),
      ...opts.context,
    });
    const push = (a: ErpAdapter, op: PushOp, c: ErpContext, doc: CanonicalDocument) =>
      (a[op] as (c: ErpContext, d: CanonicalDocument) => Promise<PushResult>).call(a, c, doc);
    const outcome = async (p: () => Promise<PushResult>): Promise<PushOutcome> => {
      try {
        return { result: await p() };
      } catch (e) {
        return { thrown: e };
      }
    };
    const valueOf = async (p: () => Promise<unknown>) => {
      try {
        return { value: await p() };
      } catch (e) {
        return { thrown: e };
      }
    };
    /** config สำหรับ fault (ติดตั้ง fault ที่ proxy แล้ว) · ช่อง secret เป็น sentinel เมื่อไม่มีคำขอใดถึง mock */
    const faultConfig = (fault: ConformanceFault): Record<string, string> => {
      if (opts.simulate) return config(opts.simulate(fault)!);
      if (fault === 'refused') return config({ [urlKey]: `${refused}/x` });
      const f =
        fault === 'duplicate' || fault === 'periodClosed'
          ? ({ kind: 'status', ...opts.http!.fixtures![fault]!, on: 'write' } satisfies HttpFault)
          : HTTP_FAULT[fault]!;
      proxy!.arm(f);
      const cfg = config();
      if (f.on === 'any' && fault !== 'notFound404')
        for (const k of opts
          .make()
          .configFields.filter((x) => x.secret)
          .map((x) => x.key))
          cfg[k] = `${SENTINEL}-${k}`;
      return cfg;
    };
    const disarm = () => proxy?.clear();
    const fail = (problems: string[]) => expect(problems, problems.join('\n')).toEqual([]);

    it('ข้อที่ตรวจกับ adapter นี้ไม่ได้ทุกข้อมีข้อยกเว้นพร้อมเหตุผล · push ที่ประกาศทุกตัวมีตัวอย่าง', () => {
      const a = opts.make();
      fail(
        missingExceptions(opts).map((f) => `ฉีด ${f} ไม่ได้ และไม่มี exceptions.${f} พร้อมเหตุผล`),
      );
      fail(
        declaredPushes(a)
          .filter(([, k]) => !opts.samples?.[k])
          .map(([op, k]) => `${op} ประกาศแล้วแต่ไม่มี samples.${k}`),
      );
    });

    it.skipIf(opts.profile !== 'accounting')(
      'R-01 / D-55: เจ้าของเอกสารภาษี = ERP ตายตัว · ไม่ส่งใบลดหนี้/ใบเสร็จ (ไม่มี pushCreditNote)',
      () => {
        const a = opts.make();
        expect(a.fixedSystemOfRecord?.taxDocumentOwner).toBe('ERP');
        expect(a.capabilities().has('pushCreditNote')).toBe(false);
        expect(a.capabilities().has('pushInvoice') || a.capabilities().has('pushSettlement')).toBe(
          true,
        );
      },
    );

    it('ข้อมูลส่วนบุคคล (D-80): personalDataNeeds อยู่ในรายการกลาง · ค่าที่ประกาศไม่สะท้อนกลับในผล/ข้อความ error', async (t) => {
      const a = opts.make();
      for (const f of a.personalDataNeeds ?? [])
        expect(['trip.driverName', 'carrier.taxId']).toContain(f);
      const targets = pushTargets(a);
      if (!targets.length) return t.skip();
      for (const tg of targets)
        for (const fault of [null, 'rejected422'] as const) {
          if (fault && !injectable(opts, fault)) continue;
          const cfg = fault ? faultConfig(fault) : config();
          let out: PushOutcome;
          try {
            out = await outcome(() => push(a, tg.op, ctx(cfg), fresh(tg.doc)));
          } finally {
            disarm();
          }
          const text = show('thrown' in out ? String(out.thrown) : out.result);
          expect(text).not.toContain(NATIONAL_ID_SENTINEL);
          expect(text).not.toContain(DRIVER_SENTINEL);
        }
    });

    it('push สำเร็จ: ผลเขียนลง external_mapping ได้ (externalId/เลขเอกสาร ≤ 100) · sync log 1 ครั้งต่อ 1 HTTP call · คำขอเขียนมีเลขอ้างอิงของเรา (กันซ้ำชั้น ERP)', async (t) => {
      const a = opts.make();
      const tg = pushTarget(a);
      if (!tg) return t.skip();
      const calls: ErpHttpCall[] = [];
      disarm();
      const doc = fresh(tg.doc);
      const r = await push(a, tg.op, ctx(config(), calls), doc);
      expect(r.ok, show(r)).toBe(true);
      if (!r.ok) return;
      for (const id of [r.externalId, ...(r.documents ?? []).map((d) => d.externalId)]) {
        expect(id.trim()).not.toBe('');
        expect(id.length).toBeLessThanOrEqual(100);
      }
      for (const no of [r.externalDocNo, ...(r.documents ?? []).map((d) => d.externalDocNo)])
        if (no != null) expect(no.length).toBeLessThanOrEqual(100);
      expect((r.documents ?? []).length).toBeLessThanOrEqual(MAX_EXTERNAL_DOCUMENTS);
      fail(checkSyncLog(calls, proxy ? proxy.captured : null));
      const writes = proxy
        ? proxy.captured.filter((c) => c.method !== 'GET').map((c) => c.body)
        : calls.filter((c) => c.method !== 'GET').map((c) => show(c.requestBody));
      expect(writes.some((b) => b.includes(doc.number))).toBe(true);
    });

    for (const fault of CONFORMANCE_FAULTS) {
      const ex = opts.exceptions?.[fault];
      const caps = opts.make().capabilities();
      // 404 ใช้กับ fetch/replace เท่านั้น (docs/01 §6.3) — adapter ที่ไม่ประกาศทั้งคู่ไม่มีข้อให้ตรวจ
      const noNotFound =
        fault === 'notFound404' && !caps.has('fetchDocument') && !caps.has('replaceDocument');
      const skip =
        noNotFound || ex?.expect === 'skip' || (!injectable(opts, fault) && !!ex?.reason);
      const expected: readonly ErrorClass[] =
        ex && ex.expect !== 'skip' ? ex.expect : [EXPECTED_CLASS[fault]];
      const title = noNotFound
        ? `${fault} → ข้าม (ไม่ประกาศ fetchDocument/replaceDocument)`
        : ex
          ? `${fault} → ${skip ? 'ข้าม' : expected.join('|')} (ข้อยกเว้น: ${ex.reason})`
          : `${fault} → ${EXPECTED_CLASS[fault]} (docs/01 §6.3)`;
      // ฉีดไม่ได้ + ไม่มีข้อยกเว้น = ข้อ "ทุกข้อมีข้อยกเว้น" ด้านบนล้มแล้ว — ข้อนี้ข้ามเพื่อไม่ให้ล้มซ้ำ
      it.skipIf(skip || !injectable(opts, fault))(`ErrorClass: ${title}`, async () => {
        const a = opts.make();
        try {
          if (fault === 'notFound404') return await notFoundChecks(a);
          const tg = pushTarget(a);
          const cfg = faultConfig(fault);
          if (tg) {
            const calls: ErpHttpCall[] = [];
            const doc = fresh(tg.doc);
            const key = `conformance:${randomUUID()}`;
            const o = await outcome(() => push(a, tg.op, ctx(cfg, calls, 'A', key), doc));
            fail(checkPushOutcome(o, fault, expected));
            expect(show({ o: 'thrown' in o ? String(o.thrown) : o.result, calls })).not.toContain(
              SENTINEL,
            );
            // ส่งซ้ำหลัง "ERP บันทึกแล้วแต่ผู้ส่งไม่ได้คำตอบ" (ข้อยกเว้นที่ยอม TRANSIENT = adapter อ้างว่าส่งซ้ำปลอดภัย) →
            // ต้องได้เอกสารเดิม (applied ไม่ใช่ true) และ ERP มีเอกสารเลขนี้ใบเดียว
            if (
              fault === 'resetAfterForward' &&
              'result' in o &&
              !o.result.ok &&
              o.result.errorClass === 'TRANSIENT'
            ) {
              disarm();
              const again = await push(a, tg.op, ctx(config(), [], 'A', key), doc);
              expect(again.ok, show(again)).toBe(true);
              if (again.ok) expect(again.applied, show(again)).not.toBe(true);
              if (opts.http?.documentsWithRef)
                expect(opts.http.documentsWithRef(doc.number)).toBe(1);
            }
          }
          const h = await a.healthCheck(ctx(faultConfig(fault)));
          fail(checkHealthOutcome(h, fault, expected));
          expect(show(h)).not.toContain(SENTINEL);
          if (READ_FAULTS.has(fault)) await readsUnder(a, faultConfig(fault), fault, expected);
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
        const o = await valueOf(() => {
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
        });
        // adapter ที่จำลอง fault ด้วยค่าตั้ง (ไม่ใช่ HTTP) ไม่จำลองปลายทางล่มฝั่งอ่าน — ตรวจเฉพาะ AUTH
        if (opts.simulate && !('thrown' in o) && fault !== 'auth401' && fault !== 'auth403')
          continue;
        fail(checkReadOutcome(m, o, fault, expected));
        if ('thrown' in o)
          expect(String((o.thrown as Error)?.message ?? o.thrown)).not.toContain(SENTINEL);
      }
    }

    /** docs/01 §6.3 NOT_FOUND = 404 ตอน fetch/replace → fetch: null หรือ NOT_FOUND · replace: PushResult NOT_FOUND */
    async function notFoundChecks(a: ErpAdapter) {
      const ref: ExternalRef = {
        entityType: 'invoice',
        localId: randomUUID(),
        number: `CONFORMANCE-NF-${randomUUID().slice(0, 8)}`,
        externalId: `nf-${randomUUID().slice(0, 8)}`,
      };
      const caps = a.capabilities();
      let checked = false;
      if (caps.has('fetchDocument') && !opts.notImplemented?.includes('fetchDocument')) {
        fail(
          checkNotFoundFetch(
            await valueOf(() => a.fetchDocument!(ctx(faultConfig('notFound404')), ref)),
          ),
        );
        checked = true;
      }
      const inv = opts.samples?.invoice;
      if (caps.has('replaceDocument') && inv && !opts.notImplemented?.includes('replaceDocument')) {
        const o = await outcome(() =>
          a.replaceDocument!(ctx(faultConfig('notFound404')), ref, withPersonalData(inv, needs())),
        );
        fail(checkPushOutcome(o, 'notFound404', ['NOT_FOUND']));
        checked = true;
      }
      // ประกาศแต่ตรวจไม่ได้ (notImplemented / ไม่มีตัวอย่างใบแจ้งหนี้สำหรับ replace) = ล้ม ไม่ผ่านแบบเงียบ
      expect(checked, 'ประกาศ fetch/replace แต่ไม่มีข้อให้ตรวจ 404').toBe(true);
    }

    it.skipIf(!(opts.make().pendingCapabilities ?? []).length)(
      'CAPABILITY: capability ที่ค้าง (pendingCapabilities) ตอบ CAPABILITY not_implemented (core พักคำสั่ง — docs/01 §6.3)',
      async () => {
        const a = opts.make();
        const c = ctx(config());
        const doc = fresh(
          opts.samples?.invoice ?? ({ id: randomUUID(), number: 'PENDING-1' } as CanonicalDocument),
        );
        const ref: ExternalRef = {
          entityType: 'invoice',
          localId: doc.id,
          number: doc.number,
          externalId: '1',
        };
        for (const cap of a.pendingCapabilities ?? []) {
          const o = await valueOf((): Promise<unknown> => {
            switch (cap) {
              case 'pushInvoice':
              case 'pushSettlement':
              case 'pushCreditNote':
                return push(a, cap, c, doc);
              case 'replaceDocument':
                return a.replaceDocument!(c, ref, doc);
              case 'fetchDocument':
                return a.fetchDocument!(c, ref);
              case 'fetchPaymentStatus':
                return a.fetchPaymentStatus!(c, ref);
              case 'listDocuments':
                return a.listDocuments!(c, { limit: 5 });
              case 'pullOrders':
                return a.pullOrders!(c, null, 5);
              default:
                return Promise.resolve({ flag: cap });
            }
          });
          if ('value' in o && (o.value as { flag?: string })?.flag) continue; // ธง (ไม่มี method)
          fail(checkPendingOutcome(cap, o));
        }
      },
    );

    it(`แยก tenant: ไม่มี credential/สถานะค้างข้าม context · เอกสารของ tenant หนึ่งไม่ถูกเห็นจากอีก tenant${
      opts.isolation
        ? ` (${opts.isolation.label ?? 'tenant B ใช้บัญชี ERP คนละชุด'})`
        : opts.http
          ? ' (ERP เดียวกัน — ตรวจเฉพาะ credential ไม่ค้าง)'
          : ' (ข้อมูลในโปรเซสแยกตาม tenant/connector)'
    }`, async () => {
      const a = opts.make();
      const tg = pushTarget(a);
      disarm();
      let ref: ExternalRef | null = null;
      if (tg) {
        const doc = fresh(tg.doc);
        const r = await push(a, tg.op, ctx(config()), doc);
        expect(r.ok, show(r)).toBe(true);
        if (r.ok)
          ref = {
            entityType: tg.op === 'pushSettlement' ? 'settlement' : 'invoice',
            localId: doc.id,
            number: doc.number,
            externalId: r.externalId,
          };
      }
      // instance เดียวกัน (registry ถือ adapter ตัวเดียวทั้ง process) — tenant อื่นที่ key ผิดต้องล้ม ไม่ใช้ของ tenant แรก
      if (opts.badConfig) {
        const h = await a.healthCheck(ctx(config(opts.badConfig), [], 'B'));
        expect(h.ok).toBe(false);
        if (tg) {
          const r = await push(a, tg.op, ctx(config(opts.badConfig), [], 'B'), fresh(tg.doc));
          expect(r.ok, show(r)).toBe(false);
        }
      }
      if (!ref) return;
      // ERP เดียวกันจริง (HTTP + ค่าตั้งเดียวกัน) = เห็นได้ถูกต้อง → ตรวจเฉพาะ adapter ในโปรเซส หรือมีบัญชีแยก
      if (proxy && !opts.isolation) return;
      const cfgB = opts.isolation ? opts.isolation.config() : config();
      if (
        a.capabilities().has('fetchDocument') &&
        !opts.notImplemented?.includes('fetchDocument')
      ) {
        const o = await valueOf(() => a.fetchDocument!(ctx(cfgB, [], 'B'), ref!));
        fail(checkNotFoundFetch(o));
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

/** ข้อยกเว้นทุกข้อด้วยเหตุผลเดียว (เช่น Standalone ที่ไม่ติดต่อภายนอกเลย) */
export function allFaultsSkipped(
  reason: string,
): Partial<Record<ConformanceFault, ConformanceException>> {
  return Object.fromEntries(
    CONFORMANCE_FAULTS.map((f) => [f, { expect: 'skip' as const, reason }]),
  );
}
