/**
 * ST8-T01 — mock ของ KRS api-pueanphet จาก contract (docs/01 Appendix A.1, A.3, A.5; packages/contracts/krs)
 *
 * - `POST /invoice` (201) · `PUT /invoice/{transactionNo}` แทนที่ทั้งใบ (200) · `GET /invoice/{transactionNo}` (200)
 * - header `X-API-Key` ผิด/ไม่มี = 401 · body ตรวจด้วย JSON schema ของ contract (ฟิลด์เกิน/ส่ง voucherNo เอง = 400)
 * - 404 ไม่พบ · 409 `tmsVoucherNo` ซ้ำ · 503 / timeout / connection reset ผ่านสวิตช์ (control endpoint หรือ header `X-Mock-Fault`)
 * - สวิตช์ "เขียนทับ" จำลองบัญชีกดบันทึกใน ERP แล้วรายการถูกเขียนใหม่ (เช่น 79 → 30 รายการ) — ST8-T11 ใช้ทดสอบ reconcile
 * - state อยู่ในหน่วยความจำ (reset ได้) · เลข `transactionNo`/`voucherNo` ออกแบบกำหนดได้ (deterministic)
 *
 * - ST8-T02 แหล่ง SO: `GET /salesorder?since=&limit=` อ่านแถวของ view ตาม watermark (ชื่อ view/คอลัมน์จาก
 *   `salesorder-source.json` — [OPEN — KRS]) + ข้อมูลตัวอย่างปลอม + control แก้/ยกเลิก SO (`salesorder.ts`)
 *
 * ไม่มีการเรียกเครือข่ายภายนอก — ใช้ใน dev/test/staging เท่านั้น (docs/04 NFR Environments)
 * พฤติกรรมที่ contract ไม่ได้ระบุ (รูป error body, ลำดับการตรวจ, ฟิลด์เพิ่มใน GET ฯลฯ) ตั้งค่าได้ผ่าน `MockKrsOptions`
 * และมีหมายเหตุ [OPEN — KRS] (คำถามใน plan/08-questions-krs.md) — อย่าถือเป็นข้อเท็จจริงของ KRS
 */
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  amountProblem,
  lineAmountExact,
  roundToSatang,
  satangToNumber,
  type Scaled,
} from './decimal';
import {
  loadSalesOrderMapping,
  MockSalesOrderStore,
  SO_PAGE_LIMIT_DEFAULT,
  SO_PAGE_LIMIT_MAX,
  SoHttpError,
  type MockSalesOrder,
  type MockSalesOrderInput,
  type MockSalesOrderPatch,
} from './salesorder';

/** ที่อยู่ JSON schema ของ contract (ใช้ได้ทั้งจาก src/ และ dist/) */
export const DEFAULT_SCHEMA_DIR = join(__dirname, '../../contracts/krs');

// ---------- ชนิดตาม contract (invoice-request.schema.json) ----------

export interface KrsInvoiceLine {
  lineId?: number;
  mainQuantity: number;
  mainUnits: string;
  unitPrice: number;
  flowNo: string;
  flowDate: string;
  carId: string;
  carPerson: string;
  frWay: string;
  toWay: string;
  itemCode?: string;
  description?: string;
  accountCode?: string;
}

export interface KrsInvoiceRequest {
  tmsVoucherNo: string;
  voucherDate: string;
  dueDate: string;
  paymentInDay: number;
  custOrSuppCode: string;
  custOrSuppName: string;
  address: string;
  deliveryAddress: string;
  salePerson: string;
  saleName: string;
  entryBy: string;
  lines: KrsInvoiceLine[];
}

/**
 * ฟิลด์ข้อความของรายการที่ล้างได้ตอนเขียนทับ (A.1: ฟิลด์รถ/เส้นทางอาจว่าง) — ฟิลด์ตัวเลข (`mainQuantity`, `unitPrice`, `lineId`)
 * ไม่อยู่ในชุดนี้ เพราะ mock ต้องคำนวณยอดจากมัน
 */
export type KrsLineField =
  | 'mainUnits'
  | 'flowNo'
  | 'flowDate'
  | 'carId'
  | 'carPerson'
  | 'frWay'
  | 'toWay'
  | 'itemCode'
  | 'description'
  | 'accountCode';

// ---------- สวิตช์ ----------

/**
 * - `status`: ตอบ status ที่กำหนด (เช่น 503 = DB KRS ล่ม) ไม่แตะ state
 * - `timeout`: ค้างไม่ตอบ `timeoutMs` แล้วตัดการเชื่อมต่อ ไม่แตะ state
 * - `timeout-after-commit` / `reset-after-commit`: ทำคำขอสำเร็จ (บันทึกแล้ว) แต่ response หาย — เคส A.5 AMBIGUOUS
 * - `reset`: ตัดการเชื่อมต่อทันที ไม่แตะ state
 */
export type FaultKind =
  'status' | 'timeout' | 'timeout-after-commit' | 'reset' | 'reset-after-commit';

export interface FaultSpec {
  kind?: FaultKind;
  /** ใช้กับ kind = status (ค่าเริ่ม 503) */
  status?: number;
  /** body ที่ตอบ (kind = status) — ไม่ระบุ = error body มาตรฐานของ mock */
  body?: unknown;
  /** จำกัดเฉพาะ method นี้ (ไม่ระบุ = ทุก method ของ /invoice) */
  method?: 'POST' | 'PUT' | 'GET';
  /** ใช้กี่ครั้ง (ค่าเริ่ม 1) · 0 = ทุกคำขอจนกว่าจะล้างสวิตช์ */
  times?: number;
  /** ST8-T08 ปล่อยคำขอที่ตรงเงื่อนไข N ครั้งแรกผ่านไปก่อน (เช่น `skip: 1` = ล้มที่ POST ครั้งที่ 2) · ค่าเริ่ม 0 */
  skip?: number;
}

/**
 * กฎ "บัญชีกดบันทึกแล้วโปรแกรมเขียนรายการใหม่ทั้งหมด" (docs/01 A.1 แถวพฤติกรรม ERP)
 * [OPEN — KRS] (plan/08 "พฤติกรรมเขียนทับ") ยังไม่รู้ว่ารายการไหนหาย/ฟิลด์ไหนว่าง — จึงกำหนดเองได้ทุกส่วน
 */
export interface OverwriteRule {
  /** เก็บไว้เฉพาะ N รายการแรก (ค่าเริ่ม 30 ตามเคส 79 → 30) · ไม่จำกัด = null */
  keepLines?: number | null;
  /** ตัดรายการที่ `flowNo` อยู่ในชุดนี้ */
  dropFlowNos?: string[];
  /** ล้างค่าฟิลด์เหล่านี้ในทุกรายการที่เหลือ (เช่น carId, carPerson, frWay, toWay) */
  blankFields?: KrsLineField[];
  /** ค่าที่ใส่แทนฟิลด์ที่ถูกล้าง (ค่าเริ่ม '') — [OPEN — KRS] อาจเป็น null */
  blankValue?: '' | null;
  /** เรียง `lineId` ใหม่ 1..n หลังเขียนทับ (ค่าเริ่ม false) */
  renumberLineIds?: boolean;
}

export interface MockKrsOptions {
  /** ค่าที่ต้องส่งใน `X-API-Key` (ค่าเริ่ม `mock-krs-key`) */
  apiKey?: string;
  /** path นำหน้า endpoint จริง (ของจริง `https://api-pueanphet.krs.co.th/api`) — ค่าเริ่ม `/api` */
  basePath?: string;
  /** transactionNo ใบแรก (ค่าเริ่ม 100001) — ออกเรียงทีละ 1 · [OPEN — KRS] รูปแบบจริงไม่ระบุใน contract */
  transactionNoStart?: number;
  /** ขนาด body สูงสุด (ค่าเริ่ม 50 MB ตาม A.1) */
  maxBodyBytes?: number;
  /** status เมื่อ body เกินขนาด — [OPEN — KRS] A.1 ไม่ระบุ ค่าเริ่ม 400 (อยู่ในตาราง error ของ A.1) */
  oversizeStatus?: number;
  /** เวลาที่ค้างก่อนตัดการเชื่อมต่อของ fault timeout (ค่าเริ่ม 30,000 ms) */
  timeoutMs?: number;
  /** ยอมให้ header `X-Mock-Fault` สั่ง fault ต่อคำขอ (ค่าเริ่ม true) */
  allowHeaderFaults?: boolean;
  /** เดือนของ voucherNo `SA-S{YYMM}-{NNNN}` มาจาก `voucherDate` ของใบ (ค่าเริ่ม) หรือจากนาฬิกา — [OPEN — KRS] */
  voucherPeriodFrom?: 'voucherDate' | 'clock';
  /** นาฬิกา (ใช้กับ voucherPeriodFrom = clock และเวลาใน state) */
  now?: () => Date;
  /**
   * ใส่ยอด `amount` ต่อรายการและ `totalAmount` ใน response (ค่าเริ่ม true) — A.3 "ให้ KRS คำนวณ" แต่ชื่อ/การมีอยู่ของฟิลด์
   * ใน GET ยังไม่ยืนยัน [OPEN — KRS] (response schema ยอมรับฟิลด์เพิ่ม)
   */
  includeAmounts?: boolean;
  /**
   * PUT ที่ `tmsVoucherNo` ไม่ตรงกับใบเดิม: `accept` (ค่าเริ่ม — ตาม contract ไม่ได้ห้าม) / `reject400`
   * ส่วนเลขที่เป็นของใบอื่น = 409 เสมอ — [OPEN — KRS]
   */
  putTmsVoucherNoChange?: 'accept' | 'reject400';
  /** ลำดับการตรวจของ PUT: `validate-first` (400 ก่อน 404 — ค่าเริ่ม) / `lookup-first` — [OPEN — KRS] */
  putCheckOrder?: 'validate-first' | 'lookup-first';
  /** status ของ method อื่นบน `/invoice` (เช่น DELETE) — [OPEN — KRS] A.1 บอกแค่ว่า "ไม่มี" ค่าเริ่ม 405 (+ `Allow`) */
  unsupportedMethodStatus?: 404 | 405;
  /** `Retry-After` (วินาที) ที่ใส่ใน 503 — [OPEN — KRS] ไม่รู้ว่า KRS ส่งหรือไม่ · ค่าเริ่ม 60 · null = ไม่ใส่ header */
  retryAfterSeconds?: number | null;
  /**
   * วิธีปัดยอดที่ "KRS คำนวณ" — [OPEN — KRS] A.3 บอกแค่ว่าให้ KRS คำนวณ:
   * `line-half-up` (ค่าเริ่ม: ปัดครึ่งขึ้นต่อรายการเป็นสตางค์แล้วรวม) · `total-half-up` (รวมค่าเต็มแล้วปัดยอดรวมครั้งเดียว;
   * `amount` ต่อรายการยังปัดครึ่งขึ้น) · `line-half-even` (ปัดแบบ banker ต่อรายการแล้วรวม)
   */
  amountRounding?: 'line-half-up' | 'total-half-up' | 'line-half-even';
  /** ที่อยู่ไฟล์ JSON schema (ค่าเริ่ม packages/contracts/krs) */
  schemaDir?: string;
  /** ST8-T02 ใส่ SO ตัวอย่าง (ปลอม) ตอนเริ่ม/reset (ค่าเริ่ม true) — false = แหล่ง SO ว่าง */
  salesOrderSample?: boolean;
}

/** ใบใน state ของ mock */
export interface StoredInvoice {
  transactionNo: string;
  voucherNo: string;
  /** ข้อมูลปัจจุบันของใบ (หลัง PUT/เขียนทับ) */
  data: KrsInvoiceRequest;
  createdAt: string;
  updatedAt: string;
  /** นับทุกการเปลี่ยน (POST = 1, PUT/เขียนทับ +1) */
  revision: number;
  /** จำนวนครั้งที่ถูก "เขียนทับฝั่ง ERP" */
  overwriteCount: number;
}

export interface MockKrsRequestLog {
  method: string;
  path: string;
  status: number | 'timeout' | 'reset';
  at: string;
}

export interface MockKrsError {
  status: number;
  error: string;
  message: string;
  errors?: Array<{ path: string; message: string; keyword: string; params: unknown }>;
}

const ERROR_NAMES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  500: 'INTERNAL_SERVER_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

const FAULT_KINDS: readonly FaultKind[] = [
  'status',
  'timeout',
  'timeout-after-commit',
  'reset',
  'reset-after-commit',
];

const LINE_FIELDS: readonly KrsLineField[] = [
  'mainUnits',
  'flowNo',
  'flowDate',
  'carId',
  'carPerson',
  'frWay',
  'toWay',
  'itemCode',
  'description',
  'accountCode',
];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors?: MockKrsError['errors'],
  ) {
    super(message);
  }
}

function errorBody(status: number, message: string, errors?: MockKrsError['errors']): MockKrsError {
  return {
    status,
    error: ERROR_NAMES[status] ?? 'ERROR',
    message,
    ...(errors ? { errors } : {}),
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(404, 'route not found');
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** ผลของการจัดการคำขอ (status + body + header เพิ่ม) */
interface Outcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class MockKrs {
  private readonly opts: Required<Omit<MockKrsOptions, 'now'>> & { now: () => Date };
  private readonly validateRequest: ValidateFunction;
  private readonly validateResponse: ValidateFunction;
  private server: Server | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();

  private invoices = new Map<string, StoredInvoice>();
  private byTmsVoucherNo = new Map<string, string>();
  private nextTransaction: number;
  private voucherSeq = new Map<string, number>();
  private faults: Array<FaultSpec & { remaining: number }> = [];
  private overwriteSwitch: { enabled: boolean; rule: OverwriteRule } = {
    enabled: false,
    rule: {},
  };
  private log: MockKrsRequestLog[] = [];
  /** ST8-T02 แหล่ง SO (view จำลอง) */
  readonly salesOrders: MockSalesOrderStore;

  constructor(options: MockKrsOptions = {}) {
    this.opts = {
      apiKey: options.apiKey ?? 'mock-krs-key',
      basePath: (options.basePath ?? '/api').replace(/\/+$/, ''),
      transactionNoStart: options.transactionNoStart ?? 100001,
      maxBodyBytes: options.maxBodyBytes ?? 50 * 1024 * 1024,
      oversizeStatus: options.oversizeStatus ?? 400,
      timeoutMs: options.timeoutMs ?? 30_000,
      allowHeaderFaults: options.allowHeaderFaults ?? true,
      voucherPeriodFrom: options.voucherPeriodFrom ?? 'voucherDate',
      now: options.now ?? (() => new Date()),
      includeAmounts: options.includeAmounts ?? true,
      unsupportedMethodStatus: options.unsupportedMethodStatus ?? 405,
      retryAfterSeconds: options.retryAfterSeconds === undefined ? 60 : options.retryAfterSeconds,
      amountRounding: options.amountRounding ?? 'line-half-up',
      putTmsVoucherNoChange: options.putTmsVoucherNoChange ?? 'accept',
      putCheckOrder: options.putCheckOrder ?? 'validate-first',
      schemaDir: options.schemaDir ?? DEFAULT_SCHEMA_DIR,
      salesOrderSample: options.salesOrderSample ?? true,
    };
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const load = (f: string) =>
      JSON.parse(readFileSync(join(this.opts.schemaDir, f), 'utf8')) as object;
    this.validateRequest = ajv.compile(load('invoice-request.schema.json'));
    this.validateResponse = ajv.compile(load('invoice-response.schema.json'));
    this.nextTransaction = this.opts.transactionNoStart;
    this.salesOrders = new MockSalesOrderStore(
      loadSalesOrderMapping(this.opts.schemaDir),
      this.opts.salesOrderSample,
      this.opts.now,
    );
  }

  // ---------- วงจรชีวิต ----------

  /** เริ่ม server (port 0 = สุ่มพอร์ตว่าง — ใช้ใน test) แล้วคืน URL ฐาน เช่น http://127.0.0.1:4784 */
  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    if (this.server) throw new Error('mock KRS already started');
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** URL ฐานของ server (ไม่รวม basePath) */
  get url(): string {
    const addr = this.server?.address() as AddressInfo | null | undefined;
    if (!addr) throw new Error('mock KRS not started');
    return `http://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`;
  }

  /** URL ที่ adapter ใช้แทน `https://api-pueanphet.krs.co.th/api` */
  get apiBaseUrl(): string {
    return this.url + this.opts.basePath;
  }

  get apiKey(): string {
    return this.opts.apiKey;
  }

  // ---------- control (ใช้ใน test ตรง ๆ หรือผ่าน /__mock/*) ----------

  /** ล้างใบทั้งหมด เลขเริ่มใหม่ สวิตช์ทุกตัวปิด · แหล่ง SO กลับเป็นข้อมูลตัวอย่าง (หรือว่าง) */
  reset(): void {
    this.invoices = new Map();
    this.byTmsVoucherNo = new Map();
    this.nextTransaction = this.opts.transactionNoStart;
    this.voucherSeq = new Map();
    this.faults = [];
    this.overwriteSwitch = { enabled: false, rule: {} };
    this.log = [];
    this.salesOrders.reset();
  }

  injectFault(spec: FaultSpec): void {
    const kind = spec.kind ?? 'status';
    if (!FAULT_KINDS.includes(kind)) throw new HttpError(400, `unknown fault kind: ${kind}`);
    const status = spec.status ?? 503;
    if (kind === 'status' && (!Number.isInteger(status) || status < 400 || status > 599))
      throw new HttpError(400, 'fault status must be 400-599');
    if (spec.method !== undefined && !['POST', 'PUT', 'GET'].includes(spec.method))
      throw new HttpError(400, 'method must be POST, PUT or GET');
    const times = spec.times ?? 1;
    if (!Number.isInteger(times) || times < 0) throw new HttpError(400, 'times must be int >= 0');
    const skip = spec.skip ?? 0;
    if (!Number.isInteger(skip) || skip < 0) throw new HttpError(400, 'skip must be int >= 0');
    this.faults = [...this.faults, { ...spec, kind, status, times, skip, remaining: times }];
  }

  clearFaults(): void {
    this.faults = [];
  }

  /**
   * เปิด/ปิดสวิตช์เขียนทับ — เปิดแล้ว (1) ใบที่มีอยู่ถูกเขียนทับทันที (2) ใบที่ POST/PUT เข้ามาหลังจากนี้ถูกเขียนทับหลังตอบ
   * (response ของ POST/PUT เป็นข้อมูลที่ API บันทึก ส่วน GET ครั้งถัดไปได้รายการที่เปลี่ยน — เหมือนบัญชีกดบันทึกภายหลัง)
   */
  setOverwrite(enabled: boolean, rule: OverwriteRule = {}): void {
    this.assertRule(rule);
    this.overwriteSwitch = { enabled, rule: clone(rule) };
    if (enabled) for (const inv of this.invoices.values()) this.applyOverwrite(inv, rule);
  }

  /** "บัญชีกดบันทึก" ใบเดียว — คืนใบหลังเขียนทับ; ไม่พบ = undefined */
  overwriteInvoice(transactionNo: string, rule: OverwriteRule = {}): StoredInvoice | undefined {
    this.assertRule(rule);
    const inv = this.invoices.get(transactionNo);
    if (!inv) return undefined;
    this.applyOverwrite(inv, rule);
    return clone(inv);
  }

  listInvoices(): StoredInvoice[] {
    return [...this.invoices.values()].map(clone);
  }

  getInvoice(transactionNo: string): StoredInvoice | undefined {
    const inv = this.invoices.get(transactionNo);
    return inv ? clone(inv) : undefined;
  }

  /**
   * ST8-T08 หาใบด้วย `tmsVoucherNo` (ใช้ใน test เท่านั้น — KRS จริงไม่มี endpoint ค้นด้วยเลขนี้: A.6 / plan/08)
   */
  getInvoiceByTmsVoucherNo(tmsVoucherNo: string): StoredInvoice | undefined {
    const txNo = this.byTmsVoucherNo.get(tmsVoucherNo);
    return txNo === undefined ? undefined : this.getInvoice(txNo);
  }

  requests(): MockKrsRequestLog[] {
    return this.log.map((l) => ({ ...l }));
  }

  /** ตรวจ body ตาม contract (ใช้ใน unit test ของ payload builder ได้) */
  validate(body: unknown): MockKrsError['errors'] | null {
    if (this.validateRequest(body)) return null;
    return this.ajvErrors(this.validateRequest.errors);
  }

  /** response ทุกตัวของ mock ผ่าน invoice-response.schema.json (ใช้ใน contract test) */
  isValidResponse(body: unknown): boolean {
    return this.validateResponse(body) === true;
  }

  // ---------- HTTP ----------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.handleUnsafe(req, res);
    } catch {
      // mock ห้ามล้มทั้งโปรเซส — ตอบ 500 ถ้ายังตอบได้
      if (!res.headersSent && !res.destroyed)
        this.send(res, { status: 500, body: errorBody(500, 'mock internal error') });
      else res.destroy();
    }
  }

  private async handleUnsafe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    let raw: Buffer | 'too-large';
    try {
      raw = await this.readBody(req);
    } catch {
      res.destroy();
      return;
    }
    if (path === '/__mock' || path.startsWith('/__mock/')) {
      this.send(res, this.control(method, path.slice('/__mock'.length), raw));
      return;
    }

    let fault: FaultSpec | null;
    try {
      fault = this.takeFault(req, method);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      this.record(method, path, e.status);
      this.send(res, { status: e.status, body: errorBody(e.status, e.message) });
      return;
    }
    if (fault && fault.kind !== 'timeout-after-commit' && fault.kind !== 'reset-after-commit') {
      this.applyFault(req, res, method, path, fault);
      return;
    }

    const outcome = this.route(method, path, req, raw);
    if (fault) {
      this.applyFault(req, res, method, path, fault);
      return;
    }
    this.record(method, path, outcome.status);
    this.send(res, outcome);
  }

  private route(
    method: string,
    path: string,
    req: IncomingMessage,
    raw: Buffer | 'too-large',
  ): Outcome {
    try {
      const base = this.opts.basePath;
      const soPath = `${base}${this.salesOrders.mapping.httpPath}`;
      const isSo = path === soPath;
      if (!isSo && path !== `${base}/invoice` && !path.startsWith(`${base}/invoice/`))
        throw new HttpError(404, 'route not found');
      const key = req.headers['x-api-key'];
      if (typeof key !== 'string' || !sameSecret(key, this.opts.apiKey))
        throw new HttpError(401, 'invalid or missing X-API-Key');
      if (isSo) {
        if (method !== 'GET') return this.methodNotAllowed('GET');
        return this.readSalesOrders(req.url ?? '');
      }

      const rest = path.slice(`${base}/invoice`.length);
      if (rest === '' || rest === '/') {
        if (method !== 'POST') return this.methodNotAllowed('POST');
        return this.create(this.parse(raw));
      }
      const segs = rest.slice(1).split('/');
      if (segs.length !== 1 || !segs[0]) throw new HttpError(404, 'route not found');
      const txNo = safeDecode(segs[0]);
      if (method === 'GET') return this.read(txNo);
      if (method === 'PUT') return this.replace(txNo, raw);
      return this.methodNotAllowed('GET, PUT');
    } catch (e) {
      if (e instanceof HttpError)
        return { status: e.status, body: errorBody(e.status, e.message, e.errors) };
      return { status: 500, body: errorBody(500, 'mock internal error') };
    }
  }

  /**
   * ST8-T02 `GET /salesorder?since={watermark}&limit={จำนวนใบ}` — แถวที่ watermark > since (ไม่รวม since)
   * since ว่าง/ไม่ส่ง = ตั้งแต่ต้น · limit 1–500 (ค่าเริ่ม 100) · ผิดรูป = 400
   * response `{ view, rows[], next, hasMore }` — [OPEN — KRS] รูป response/ชื่อพารามิเตอร์ยังไม่ยืนยัน (plan/08 KRS-11)
   */
  private readSalesOrders(url: string): Outcome {
    const q = new URL(url, 'http://mock.local').searchParams;
    const sinceRaw = q.get('since') ?? '';
    if (sinceRaw !== '' && !/^\d{1,19}$/.test(sinceRaw))
      throw new HttpError(400, 'since must be a watermark (digits) or empty');
    const limitRaw = q.get('limit');
    let limit = SO_PAGE_LIMIT_DEFAULT;
    if (limitRaw !== null) {
      if (
        !/^\d{1,4}$/.test(limitRaw) ||
        Number(limitRaw) < 1 ||
        Number(limitRaw) > SO_PAGE_LIMIT_MAX
      )
        throw new HttpError(400, `limit must be 1-${SO_PAGE_LIMIT_MAX}`);
      limit = Number(limitRaw);
    }
    const page = this.salesOrders.page(sinceRaw === '' ? null : sinceRaw, limit);
    return { status: 200, body: { view: this.salesOrders.mapping.view, ...page } };
  }

  private methodNotAllowed(allow: string): Outcome {
    if (this.opts.unsupportedMethodStatus === 404)
      return { status: 404, body: errorBody(404, 'route not found') };
    return {
      status: 405,
      body: errorBody(405, 'method not allowed'),
      headers: { Allow: allow },
    };
  }

  private parse(raw: Buffer | 'too-large'): KrsInvoiceRequest {
    if (raw === 'too-large')
      throw new HttpError(
        this.opts.oversizeStatus,
        `payload exceeds ${this.opts.maxBodyBytes} bytes`,
      );
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'body is not valid JSON');
    }
    const errors = this.validate(body);
    if (errors) throw new HttpError(400, 'payload does not match contract', errors);
    // ตรวจก่อนบันทึก: ค่าที่คำนวณยอดตรงตัวไม่ได้ = 400 (ไม่เก็บใบ)
    const inv = body as KrsInvoiceRequest;
    const amountErrors = inv.lines.flatMap((l, i) => {
      const problem = amountProblem(l.mainQuantity, l.unitPrice);
      return problem
        ? [{ path: `/lines/${i}`, message: problem, keyword: 'range', params: {} }]
        : [];
    });
    if (amountErrors.length)
      throw new HttpError(400, 'amount cannot be computed exactly', amountErrors);
    return inv;
  }

  private create(body: KrsInvoiceRequest): Outcome {
    if (this.byTmsVoucherNo.has(body.tmsVoucherNo))
      throw new HttpError(409, `duplicate tmsVoucherNo: ${body.tmsVoucherNo}`);
    const now = this.opts.now().toISOString();
    const inv: StoredInvoice = {
      transactionNo: String(this.nextTransaction++),
      voucherNo: this.issueVoucherNo(body.voucherDate),
      data: clone(body),
      createdAt: now,
      updatedAt: now,
      revision: 1,
      overwriteCount: 0,
    };
    this.invoices.set(inv.transactionNo, inv);
    this.byTmsVoucherNo.set(body.tmsVoucherNo, inv.transactionNo);
    const out: Outcome = { status: 201, body: this.view(inv) };
    if (this.overwriteSwitch.enabled) this.applyOverwrite(inv, this.overwriteSwitch.rule);
    return out;
  }

  private read(txNo: string): Outcome {
    const inv = this.invoices.get(txNo);
    if (!inv) throw new HttpError(404, `invoice not found: ${txNo}`);
    return { status: 200, body: this.view(inv) };
  }

  private replace(txNo: string, raw: Buffer | 'too-large'): Outcome {
    let inv = this.invoices.get(txNo);
    if (this.opts.putCheckOrder === 'lookup-first' && !inv)
      throw new HttpError(404, `invoice not found: ${txNo}`);
    const body = this.parse(raw);
    inv = this.invoices.get(txNo);
    if (!inv) throw new HttpError(404, `invoice not found: ${txNo}`);
    const owner = this.byTmsVoucherNo.get(body.tmsVoucherNo);
    if (owner !== undefined && owner !== txNo)
      throw new HttpError(409, `duplicate tmsVoucherNo: ${body.tmsVoucherNo}`);
    if (body.tmsVoucherNo !== inv.data.tmsVoucherNo) {
      if (this.opts.putTmsVoucherNoChange === 'reject400')
        throw new HttpError(400, 'tmsVoucherNo must match the original invoice');
      this.byTmsVoucherNo.delete(inv.data.tmsVoucherNo);
      this.byTmsVoucherNo.set(body.tmsVoucherNo, txNo);
    }
    inv.data = clone(body);
    inv.revision += 1;
    inv.updatedAt = this.opts.now().toISOString();
    const out: Outcome = { status: 200, body: this.view(inv) };
    if (this.overwriteSwitch.enabled) this.applyOverwrite(inv, this.overwriteSwitch.rule);
    return out;
  }

  /** รูป response: เลขที่ KRS ออก + ข้อมูลใบ (+ ยอดที่ KRS คำนวณ ถ้าเปิด) */
  private view(inv: StoredInvoice): Record<string, unknown> {
    const { lines, ...header } = inv.data;
    const mode = this.opts.amountRounding;
    let total = 0n;
    const exacts: Scaled[] = [];
    const outLines = lines.map((l) => {
      if (!this.opts.includeAmounts) return { ...l };
      const exact = lineAmountExact(l.mainQuantity, l.unitPrice);
      exacts.push(exact);
      const sat = roundToSatang(exact, mode === 'line-half-even' ? 'half-even' : 'half-up');
      total += sat;
      return { ...l, amount: satangToNumber(sat) };
    });
    if (this.opts.includeAmounts && mode === 'total-half-up') {
      const scale = Math.max(2, ...exacts.map((e) => e.scale));
      const sum = exacts.reduce((acc, e) => acc + e.int * 10n ** BigInt(scale - e.scale), 0n);
      total = roundToSatang({ int: sum, scale }, 'half-up');
    }
    return {
      transactionNo: inv.transactionNo,
      voucherNo: inv.voucherNo,
      ...header,
      lines: outLines,
      ...(this.opts.includeAmounts ? { totalAmount: satangToNumber(total) } : {}),
    };
  }

  private issueVoucherNo(voucherDate: string): string {
    let yymm: string;
    if (this.opts.voucherPeriodFrom === 'clock') {
      const d = this.opts.now();
      yymm = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    } else {
      yymm = voucherDate.slice(2, 4) + voucherDate.slice(5, 7);
    }
    const seq = (this.voucherSeq.get(yymm) ?? 0) + 1;
    this.voucherSeq.set(yymm, seq);
    return `SA-S${yymm}-${String(seq).padStart(4, '0')}`;
  }

  private assertRule(rule: OverwriteRule): void {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule))
      throw new HttpError(400, 'overwrite rule must be an object');
    const k = rule.keepLines;
    if (k !== undefined && k !== null && (!Number.isInteger(k) || k < 0))
      throw new HttpError(400, 'keepLines must be int >= 0 or null');
    if (rule.dropFlowNos !== undefined && !Array.isArray(rule.dropFlowNos))
      throw new HttpError(400, 'dropFlowNos must be an array');
    if (rule.blankFields !== undefined && !Array.isArray(rule.blankFields))
      throw new HttpError(400, 'blankFields must be an array');
    for (const f of rule.blankFields ?? [])
      if (!LINE_FIELDS.includes(f)) throw new HttpError(400, `unknown line field: ${String(f)}`);
    if (rule.blankValue !== undefined && rule.blankValue !== '' && rule.blankValue !== null)
      throw new HttpError(400, "blankValue must be '' or null");
  }

  private applyOverwrite(inv: StoredInvoice, rule: OverwriteRule): void {
    const keep = rule.keepLines === undefined ? 30 : rule.keepLines;
    const drop = new Set(rule.dropFlowNos ?? []);
    const blankValue = rule.blankValue === undefined ? '' : rule.blankValue;
    let lines = inv.data.lines.filter((l) => !drop.has(l.flowNo));
    if (keep !== null) lines = lines.slice(0, keep);
    lines = lines.map((l, i) => {
      const next: Record<string, unknown> = { ...l };
      for (const f of rule.blankFields ?? []) next[f] = blankValue;
      if (rule.renumberLineIds) next.lineId = i + 1;
      return next as unknown as KrsInvoiceLine;
    });
    inv.data = { ...inv.data, lines };
    inv.revision += 1;
    inv.overwriteCount += 1;
    inv.updatedAt = this.opts.now().toISOString();
  }

  private takeFault(req: IncomingMessage, method: string): FaultSpec | null {
    if (this.opts.allowHeaderFaults) {
      const h = req.headers['x-mock-fault'];
      if (typeof h === 'string' && h) {
        if (/^\d{3}$/.test(h)) {
          const status = Number(h);
          if (status < 400 || status > 599)
            throw new HttpError(400, 'X-Mock-Fault status must be 400-599');
          return { kind: 'status', status };
        }
        if ((FAULT_KINDS as readonly string[]).includes(h)) return { kind: h as FaultKind };
        throw new HttpError(400, `invalid X-Mock-Fault: ${h.slice(0, 40)}`);
      }
    }
    const i = this.faults.findIndex((f) => !f.method || f.method === method);
    if (i < 0) return null;
    const f = this.faults[i]!;
    if (f.skip) {
      f.skip -= 1;
      return null;
    }
    if (f.times !== 0) {
      f.remaining -= 1;
      if (f.remaining <= 0) this.faults.splice(i, 1);
    }
    return f;
  }

  private applyFault(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    fault: FaultSpec,
  ): void {
    const kind = fault.kind ?? 'status';
    if (kind === 'reset' || kind === 'reset-after-commit') {
      this.record(method, path, 'reset');
      req.socket.destroy();
      return;
    }
    if (kind === 'timeout' || kind === 'timeout-after-commit') {
      this.record(method, path, 'timeout');
      const t = setTimeout(() => {
        this.timers.delete(t);
        req.socket.destroy();
      }, this.opts.timeoutMs);
      this.timers.add(t);
      return;
    }
    const status = fault.status ?? 503;
    this.record(method, path, status);
    this.send(res, {
      status,
      body: fault.body ?? errorBody(status, `mock fault ${status}`),
      ...(status === 503 && this.opts.retryAfterSeconds !== null
        ? { headers: { 'Retry-After': String(this.opts.retryAfterSeconds) } }
        : {}),
    });
  }

  /** /__mock/* — ไม่ต้องใช้ X-API-Key (bind 127.0.0.1 เท่านั้นโดยค่าเริ่ม) */
  private control(method: string, path: string, raw: Buffer | 'too-large'): Outcome {
    try {
      const json = (): Record<string, unknown> => {
        if (raw === 'too-large') throw new HttpError(400, 'body too large');
        const s = raw.toString('utf8').trim();
        if (!s) return {};
        try {
          const v = JSON.parse(s) as unknown;
          if (v === null || typeof v !== 'object') throw new Error();
          return v as Record<string, unknown>;
        } catch {
          throw new HttpError(400, 'body is not a JSON object');
        }
      };
      const ok = (body: unknown = { ok: true }): Outcome => ({ status: 200, body });
      if (method === 'GET' && (path === '' || path === '/' || path === '/state'))
        return ok({
          invoices: this.listInvoices(),
          faults: this.faults.map(({ remaining, ...f }) => ({ ...f, remaining })),
          overwrite: clone(this.overwriteSwitch),
          requests: this.requests(),
          salesOrders: this.salesOrders.list(),
        });
      if (method === 'POST' && path === '/reset') {
        this.reset();
        return ok();
      }
      if (path === '/faults') {
        if (method === 'DELETE') {
          this.clearFaults();
          return ok();
        }
        if (method === 'POST') {
          const body = json();
          const list: unknown[] = Array.isArray(body) ? body : [body];
          const specs = list.map((f) => {
            if (f === null || typeof f !== 'object' || Array.isArray(f))
              throw new HttpError(400, 'each fault must be an object');
            return f as FaultSpec;
          });
          // ตรวจทั้งชุดก่อน แล้วค่อยใส่คิว (ผิดตัวเดียว = ไม่ใส่สักตัว)
          const before = this.faults;
          try {
            for (const f of specs) this.injectFault(f);
          } catch (e) {
            this.faults = before;
            throw e;
          }
          return ok({ ok: true, queued: this.faults.length });
        }
      }
      if (method === 'PUT' && path === '/overwrite') {
        const body = json();
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
        this.setOverwrite(body.enabled, (body.rule ?? {}) as OverwriteRule);
        return ok({ ok: true, overwrite: clone(this.overwriteSwitch) });
      }
      const so = this.salesOrderControl(method, path, json);
      if (so) return so;
      const m = /^\/invoices\/([^/]+)\/overwrite$/.exec(path);
      if (method === 'POST' && m) {
        const inv = this.overwriteInvoice(safeDecode(m[1]!), json() as OverwriteRule);
        if (!inv) throw new HttpError(404, 'invoice not found');
        return ok(inv);
      }
      throw new HttpError(404, 'control route not found');
    } catch (e) {
      if (e instanceof HttpError)
        return { status: e.status, body: errorBody(e.status, e.message, e.errors) };
      if (e instanceof SoHttpError)
        return { status: e.status, body: errorBody(e.status, e.message) };
      return { status: 500, body: errorBody(500, 'mock control error') };
    }
  }

  /**
   * ST8-T02 control ของแหล่ง SO (ไม่ต้องใช้ key):
   * `GET /__mock/salesorders` ทุกใบ · `POST /__mock/salesorders` เพิ่ม/แทนที่ทั้งใบ ·
   * `PATCH /__mock/salesorders/{company}/{soNo}` แก้บางช่อง · `POST /__mock/salesorders/{company}/{soNo}/cancel` ยกเลิก
   * ทุกการเขียนได้ rowVersion + updated_at ใหม่ (poller เห็นในรอบถัดไป)
   */
  private salesOrderControl(
    method: string,
    path: string,
    json: () => Record<string, unknown>,
  ): Outcome | null {
    if (path === '/salesorders') {
      if (method === 'GET') return { status: 200, body: { salesOrders: this.salesOrders.list() } };
      if (method === 'POST')
        return {
          status: 200,
          body: this.salesOrders.upsert(json() as unknown as MockSalesOrderInput),
        };
      return null;
    }
    const m = /^\/salesorders\/([^/]+)\/([^/]+)(\/cancel)?$/.exec(path);
    if (!m) return null;
    const company = safeDecode(m[1]!);
    const soNo = safeDecode(m[2]!);
    if (m[3] && method === 'POST')
      return { status: 200, body: this.salesOrders.cancel(company, soNo) };
    if (!m[3] && method === 'PATCH')
      return {
        status: 200,
        body: this.salesOrders.edit(company, soNo, json() as MockSalesOrderPatch),
      };
    if (!m[3] && method === 'GET') {
      const so: MockSalesOrder | undefined = this.salesOrders.get(company, soNo);
      if (!so) throw new HttpError(404, 'sales order not found');
      return { status: 200, body: so };
    }
    return null;
  }

  private readBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > this.opts.maxBodyBytes) {
          tooLarge = true;
          chunks.length = 0;
        } else if (!tooLarge) chunks.push(c);
      });
      req.on('end', () => resolve(tooLarge ? 'too-large' : Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private send(res: ServerResponse, o: Outcome): void {
    const body = JSON.stringify(o.body);
    res.writeHead(o.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...o.headers,
    });
    res.end(body);
  }

  private record(method: string, path: string, status: MockKrsRequestLog['status']): void {
    this.log.push({ method, path, status, at: this.opts.now().toISOString() });
    if (this.log.length > 1000) this.log.shift();
  }

  private ajvErrors(errs: ErrorObject[] | null | undefined): NonNullable<MockKrsError['errors']> {
    return (errs ?? []).map((e) => ({
      path: e.instancePath || '/',
      message: e.message ?? e.keyword,
      keyword: e.keyword,
      params: e.params,
    }));
  }
}

/** สร้างและเริ่ม mock ในโปรเซสเดียวกับ test — อย่าลืม `await mock.stop()` */
export async function startMockKrs(
  options: MockKrsOptions & { port?: number; host?: string } = {},
): Promise<MockKrs> {
  const { port, host, ...rest } = options;
  const mock = new MockKrs(rest);
  await mock.start(port ?? 0, host ?? '127.0.0.1');
  return mock;
}
