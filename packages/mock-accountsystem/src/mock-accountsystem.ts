/**
 * ST8-T16 — mock ของ AccountSystem (Innovera) `ext/v1` จาก contract (packages/contracts/accountsystem/README.md)
 *
 * - `POST /ext/v1/documents` สร้างร่าง (เดี่ยว/array ≤ 500) → `{id, created}` · ซ้ำด้วย `external_source`+`external_ref` = `created:false` id เดิม
 * - `GET /ext/v1/documents?external_ref=&external_source=` · `GET /ext/v1/documents/:id` · `PUT /ext/v1/contacts` (จับคู่เลขภาษี+สาขา / external_ref)
 * - Bearer `inn_…` ผิด = 401 · ไม่มี scope = 403 · body ผิด (หัวเอกสาร strict) = 400 · คู่ค้าไม่พบ = 422 — error body `{error}` แบบตัวจริง
 * - พฤติกรรมช่องว่างของตัวจริงจำลองไว้: `vat_rate` รายบรรทัดถูกทิ้ง (null) · ไม่คำนวณ amount (ไม่ส่ง = "0.00") · ไม่เก็บ discount
 * - control (ในโปรเซส): ลงบัญชี / ยกเลิก / รับชำระ / จ่าย → สร้าง webhook ที่เซ็นแบบตัวจริง (`webhook()` คืน headers + body)
 * - ความผิดพลาดชั่วคราว: `failNext(status | 'reset')`
 * ไม่มีการเรียกเครือข่ายภายนอก — dev/test เท่านั้น · พฤติกรรมที่ไม่มีในโค้ดตัวจริงอย่าถือเป็นข้อเท็จจริงของ AccountSystem
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ACCOUNTSYSTEM_SCOPES = [
  'documents:read',
  'documents:draft',
  'contacts:read',
  'contacts:draft',
  'ledger:read',
  'reports:read',
  'tax:read',
  'schema:read',
  'webhooks:manage',
] as const;
export type AccountSystemScope = (typeof ACCOUNTSYSTEM_SCOPES)[number];

const DOC_TYPES = [
  'QO',
  'SO',
  'BL',
  'IV',
  'CN',
  'DN',
  'DP',
  'RV',
  'PR',
  'PO',
  'AP',
  'EXP',
  'CNR',
  'DNR',
  'PV',
  'JV',
] as const;
const HEADER_KEYS = new Set([
  'doc_type',
  'issue_date',
  'due_date',
  'contact_code',
  'price_incl_vat',
  'branch_code',
  'lines',
  'external_source',
  'external_ref',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE = /^-?\d{1,16}\.\d{2}$/;
const QTY_RE = /^-?\d{1,14}(\.\d{1,4})?$/;
const RATE_RE = /^\d{1,3}(\.\d{1,4})?$/;
const ACCOUNT_RE = /^\d{7}$/;
const BRANCH_RE = /^\d{5}$/;

export interface MockLine {
  line_no: number;
  line_type: 'item' | 'heading' | 'note';
  product_code: string | null;
  description: string;
  qty: string | null;
  unit_price: string | null;
  amount: string;
  /** ตัวจริงตั้ง null เสมอ (ledger-service.ts:174) */
  vat_rate: null;
  account_code: string | null;
  /** ค่าที่ TMS ส่งมา (เก็บไว้ให้ test ตรวจ — ตัวจริงไม่เก็บ) */
  sent: Record<string, unknown>;
}

export interface MockDocument {
  id: string;
  doc_type: string;
  doc_no: string | null;
  status: 'draft' | 'posted' | 'voided';
  issue_date: string;
  due_date: string | null;
  contact_code: string;
  price_incl_vat: boolean;
  branch_code: string;
  external_source: string | null;
  external_ref: string | null;
  lines: MockLine[];
  created_by_client: string;
}

export interface MockContact {
  id: string;
  code: string;
  name: string;
  kind: 'customer' | 'vendor' | 'both';
  tax_id: string | null;
  branch_code: string | null;
  external_source: string | null;
  external_ref: string | null;
}

export interface MockAccountSystemOptions {
  /** API key ที่ยอมรับ (ต้องขึ้นต้น `inn_`) */
  apiKey?: string;
  scopes?: readonly AccountSystemScope[];
  /** secret ของ webhook endpoint (`whsec_…`) */
  webhookSecret?: string;
  companyId?: string;
  contacts?: Partial<MockContact>[];
}

export interface MockRequestLog {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
  status: number;
}

export interface SignedWebhook {
  headers: Record<string, string>;
  body: string;
  event: {
    id: string;
    type: string;
    company_id: string;
    occurred_at: string;
    data: Record<string, unknown>;
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** ลายเซ็นแบบตัวจริง: HMAC-SHA256(secret, `${timestamp}.${body}`) hex (hub.ts signWebhook) */
export function signAccountSystemWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export class MockAccountSystem {
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly companyId: string;
  private scopes: Set<string>;
  readonly documents = new Map<string, MockDocument>();
  readonly contacts: MockContact[] = [];
  readonly requests: MockRequestLog[] = [];
  private faults: (number | 'reset')[] = [];
  private seq = { IV: 0, AP: 0, RV: 0, PV: 0, EXT: 0 };
  private server: Server | null = null;
  url = '';

  constructor(o: MockAccountSystemOptions = {}) {
    this.apiKey = o.apiKey ?? 'inn_tms_mockkey000000000000000000';
    this.webhookSecret = o.webhookSecret ?? 'whsec_mock000000000000000000000000';
    this.companyId = o.companyId ?? randomUUID();
    this.scopes = new Set(
      o.scopes ?? ['documents:read', 'documents:draft', 'contacts:read', 'contacts:draft'],
    );
    for (const c of o.contacts ?? []) this.addContact(c);
  }

  setScopes(s: readonly AccountSystemScope[]) {
    this.scopes = new Set(s);
  }

  addContact(c: Partial<MockContact>): MockContact {
    const row: MockContact = {
      id: c.id ?? randomUUID(),
      code: c.code ?? `C-${String(this.contacts.length + 1).padStart(4, '0')}`,
      name: c.name ?? 'คู่ค้า',
      kind: c.kind ?? 'both',
      tax_id: c.tax_id ?? null,
      branch_code: c.branch_code ?? null,
      external_source: c.external_source ?? null,
      external_ref: c.external_ref ?? null,
    };
    this.contacts.push(row);
    return row;
  }

  /** คำขอถัดไปตอบ status นี้ (หรือ 'reset' = ตัดการเชื่อมต่อ) */
  failNext(...f: (number | 'reset')[]) {
    this.faults.push(...f);
  }

  reset() {
    this.documents.clear();
    this.requests.length = 0;
    this.faults = [];
  }

  byRef(ref: string, source?: string): MockDocument[] {
    return [...this.documents.values()].filter(
      (d) => d.external_ref === ref && (!source || d.external_source === source),
    );
  }

  async start(port = 0, host = '127.0.0.1'): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((ok) => this.server!.listen(port, host, ok));
    const a = this.server.address() as AddressInfo;
    this.url = `http://${host}:${a.port}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((ok) => s.close(() => ok()));
  }

  // ---------- control: สิ่งที่ผู้ใช้ทำใน AccountSystem → webhook ----------

  /** ผู้ใช้อนุมัติ/ลงบัญชีร่าง → เลขเอกสาร + `document.posted` */
  post(id: string, at = new Date()): SignedWebhook {
    const d = this.mustDoc(id);
    if (d.status !== 'draft') throw new Error(`document ${id} is ${d.status}`);
    const k = (d.doc_type === 'AP' ? 'AP' : 'IV') as 'AP' | 'IV';
    this.seq[k]++;
    d.doc_no = `${k}${at.toISOString().slice(2, 4)}${at.toISOString().slice(5, 7)}-${String(this.seq[k]).padStart(4, '0')}`;
    d.status = 'posted';
    return this.webhook(
      'document.posted',
      {
        id: d.id,
        doc_type: d.doc_type,
        doc_no: d.doc_no,
        external_source: d.external_source,
        external_ref: d.external_ref,
        grand_total: this.total(d),
        journal_no: `JV-${d.doc_no}`,
      },
      at,
    );
  }

  /** ผู้ใช้ยกเลิกเอกสารใน AccountSystem → `document.voided` */
  void(id: string, reason: string, at = new Date()): SignedWebhook {
    const d = this.mustDoc(id);
    d.status = 'voided';
    return this.webhook(
      'document.voided',
      {
        id: d.id,
        doc_type: d.doc_type,
        doc_no: d.doc_no,
        external_source: d.external_source,
        external_ref: d.external_ref,
        reason,
        reversal: d.doc_no ? `JV-R-${d.doc_no}` : null,
      },
      at,
    );
  }

  /** รับชำระ (RV) — `applied` ไม่รวม WHT (ตัวจริงตรวจ applied + wht ≤ ค้าง) → `payment.received` */
  receive(
    apps: { documentId: string; applied: string; wht?: string }[],
    at = new Date(),
  ): SignedWebhook {
    this.seq.RV++;
    const docNo = `RV-${String(this.seq.RV).padStart(4, '0')}`;
    const rows = apps.map((a) => {
      const d = this.mustDoc(a.documentId);
      if (d.status !== 'posted') throw new Error('receive: document must be posted');
      return {
        document_id: d.id,
        doc_no: d.doc_no,
        external_ref: d.external_ref,
        applied: a.applied,
        wht: a.wht ?? '0.00',
      };
    });
    const sum = (k: 'applied' | 'wht') =>
      (rows.reduce((t, r) => t + Math.round(Number(r[k]) * 100), 0) / 100).toFixed(2);
    return this.webhook(
      'payment.received',
      {
        id: randomUUID(),
        doc_no: docNo,
        contact_id: this.contacts[0]?.id ?? null,
        cash_in: sum('applied'),
        wht: sum('wht'),
        applications: rows,
      },
      at,
    );
  }

  /** จ่ายเจ้าหนี้ (PV) → `payment.paid` (ไม่มี external_ref ของบิล — ตามตัวจริง) */
  pay(
    bills: { documentId: string; applied: string; wht?: string }[],
    certificates: string[] = [],
    at = new Date(),
  ): SignedWebhook {
    this.seq.PV++;
    const rows = bills.map((b) => ({
      document_id: this.mustDoc(b.documentId).id,
      applied: b.applied,
      wht: b.wht ?? '0.00',
    }));
    const sum = (k: 'applied' | 'wht') =>
      (rows.reduce((t, r) => t + Math.round(Number(r[k]) * 100), 0) / 100).toFixed(2);
    return this.webhook(
      'payment.paid',
      {
        id: randomUUID(),
        doc_no: `PV-${String(this.seq.PV).padStart(4, '0')}`,
        contact_id: null,
        paid: sum('applied'),
        wht: sum('wht'),
        certificates,
        bills: rows,
      },
      at,
    );
  }

  /** body + headers แบบตัวจริง (deliverDue) — `secret`/`timestamp` เปลี่ยนได้เพื่อทดสอบลายเซ็นผิด/เก่า */
  webhook(
    type: string,
    data: Record<string, unknown>,
    at = new Date(),
    o: { secret?: string; timestamp?: string } = {},
  ): SignedWebhook {
    const event = {
      id: randomUUID(),
      type,
      company_id: this.companyId,
      occurred_at: at.toISOString(),
      data,
    };
    const body = JSON.stringify(event);
    const ts = o.timestamp ?? String(Math.floor(Date.now() / 1000));
    return {
      event,
      body,
      headers: {
        'content-type': 'application/json',
        'x-innovera-event': type,
        'x-innovera-delivery': randomUUID(),
        'x-innovera-timestamp': ts,
        'x-innovera-signature': `sha256=${signAccountSystemWebhook(o.secret ?? this.webhookSecret, ts, body)}`,
      },
    };
  }

  private mustDoc(id: string): MockDocument {
    const d = this.documents.get(id);
    if (!d) throw new Error(`no document ${id}`);
    return d;
  }

  private total(d: MockDocument): string {
    return (d.lines.reduce((t, l) => t + Math.round(Number(l.amount) * 100), 0) / 100).toFixed(2);
  }

  // ---------- HTTP ----------

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://x');
    const log: MockRequestLog = {
      method: req.method ?? '',
      path: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
      body: null,
      status: 0,
    };
    this.requests.push(log);
    const send = (status: number, body: unknown) => {
      log.status = status;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const fault = this.faults.shift();
      if (fault === 'reset') {
        log.status = -1;
        req.socket.destroy();
        return;
      }
      if (fault) return send(fault, { error: 'เกิดข้อผิดพลาดในระบบ' });
      if (raw) {
        try {
          log.body = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'body ไม่ใช่ JSON');
        }
      }
      this.auth(req);
      const p = url.pathname;
      if (req.method === 'POST' && p === '/ext/v1/documents')
        return send(201, this.createDocuments(log.body));
      if (req.method === 'GET' && p === '/ext/v1/documents') {
        this.need('documents:read');
        const ref = url.searchParams.get('external_ref');
        if (!ref) throw new HttpError(400, 'ระบุ external_ref');
        return send(
          200,
          this.byRef(ref, url.searchParams.get('external_source') ?? undefined).map((d) =>
            this.shape(d),
          ),
        );
      }
      const m = /^\/ext\/v1\/documents\/([0-9a-f-]{36})$/.exec(p);
      if (req.method === 'GET' && m) {
        this.need('documents:read');
        const d = this.documents.get(m[1]!);
        if (!d) throw new HttpError(404, 'ไม่พบเอกสาร');
        return send(200, this.shape(d));
      }
      if (req.method === 'PUT' && p === '/ext/v1/contacts')
        return send(200, this.syncContacts(log.body));
      throw new HttpError(404, `Cannot ${req.method} ${p}`);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      return send(500, { error: 'เกิดข้อผิดพลาดในระบบ' });
    }
  }

  private auth(req: IncomingMessage) {
    const key = /^Bearer (inn_\S+)$/u.exec(req.headers.authorization ?? '')?.[1];
    if (!key) throw new HttpError(401, 'ต้องใช้ API key (Authorization: Bearer inn_…)');
    const a = Buffer.from(key);
    const b = Buffer.from(this.apiKey);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new HttpError(401, 'API key ไม่ถูกต้อง ถูกเพิกถอน หรือถูกระงับชั่วคราว');
  }

  private need(s: AccountSystemScope) {
    if (!this.scopes.has(s)) throw new HttpError(403, `ต้องมี scope ${s}`);
  }

  private shape(d: MockDocument) {
    return {
      id: d.id,
      doc_type: d.doc_type,
      doc_no: d.doc_no,
      status: d.status,
      issue_date: d.issue_date,
      due_date: d.due_date,
      external_source: d.external_source,
      external_ref: d.external_ref,
      grand_total: this.total(d),
      lines: d.lines.map((l) => ({
        line_no: l.line_no,
        description: l.description,
        qty: l.qty,
        unit_price: l.unit_price,
        amount: l.amount,
      })),
    };
  }

  private createDocuments(body: unknown) {
    this.need('documents:draft');
    const items = Array.isArray(body) ? body : [body];
    if (items.length > 500) throw new HttpError(400, 'ส่งได้ครั้งละไม่เกิน 500 เอกสาร');
    const parsed = items.map((x, i) => this.parseDraft(x, i));
    const out = parsed.map((d) => this.createDraft(d));
    return Array.isArray(body) ? out : out[0];
  }

  /** ตรวจแบบ DocumentDraftCreate (หัว strict · บรรทัดตัดฟิลด์เกินทิ้ง) */
  private parseDraft(x: unknown, i: number) {
    const bad = (m: string) => new HttpError(400, `เอกสารที่ ${i + 1}: ${m}`);
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad('ต้องเป็น object');
    const o = x as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !HEADER_KEYS.has(k));
    if (extra.length) throw bad(`Unrecognized key(s): ${extra.join(', ')}`);
    if (!DOC_TYPES.includes(o.doc_type as never)) throw bad('doc_type ไม่ถูกต้อง');
    if (typeof o.issue_date !== 'string' || !DATE_RE.test(o.issue_date))
      throw bad('issue_date ไม่ถูกต้อง');
    if (o.due_date !== undefined && (typeof o.due_date !== 'string' || !DATE_RE.test(o.due_date)))
      throw bad('due_date ไม่ถูกต้อง');
    if (typeof o.contact_code !== 'string' || !o.contact_code) throw bad('contact_code ต้องมี');
    if (o.price_incl_vat !== undefined && typeof o.price_incl_vat !== 'boolean')
      throw bad('price_incl_vat');
    if (
      o.branch_code !== undefined &&
      (typeof o.branch_code !== 'string' || !BRANCH_RE.test(o.branch_code))
    )
      throw bad('branch_code');
    if ((o.external_source === undefined) !== (o.external_ref === undefined))
      throw bad('external_source และ external_ref ต้องมาคู่กัน');
    for (const k of ['external_source', 'external_ref'] as const)
      if (o[k] !== undefined && (typeof o[k] !== 'string' || !o[k])) throw bad(`${k} ว่าง`);
    if (!Array.isArray(o.lines) || !o.lines.length) throw bad('lines ต้องมีอย่างน้อย 1');
    const lines = o.lines.map((l, j) => {
      const r = (l ?? {}) as Record<string, unknown>;
      const lb = (m: string) => bad(`lines.${j}.${m}`);
      const lt = r.line_type ?? 'item';
      if (!['item', 'heading', 'note'].includes(lt as string)) throw lb('line_type');
      if (typeof r.description !== 'string' || !r.description) throw lb('description');
      const chk = (k: string, re: RegExp) => {
        if (r[k] !== undefined && (typeof r[k] !== 'string' || !re.test(r[k] as string)))
          throw lb(k);
      };
      chk('qty', QTY_RE);
      chk('unit_price', QTY_RE);
      chk('discount', MONEY_RE);
      chk('amount', MONEY_RE);
      chk('vat_rate', RATE_RE);
      chk('account_code', ACCOUNT_RE);
      if (r.product_code !== undefined && typeof r.product_code !== 'string')
        throw lb('product_code');
      return r;
    });
    return { ...o, lines } as Record<string, unknown> & { lines: Record<string, unknown>[] };
  }

  private createDraft(d: Record<string, unknown> & { lines: Record<string, unknown>[] }) {
    const src = d.external_source as string | undefined;
    const ref = d.external_ref as string | undefined;
    const contact = this.contacts.find((c) => c.code === d.contact_code);
    if (!contact) throw new HttpError(422, `ไม่พบคู่ค้า ${String(d.contact_code)}`);
    if (src && ref) {
      const hit = this.byRef(ref, src)[0];
      if (hit) return { id: hit.id, created: false };
    }
    const doc: MockDocument = {
      id: randomUUID(),
      doc_type: d.doc_type as string,
      doc_no: null,
      status: 'draft',
      issue_date: d.issue_date as string,
      due_date: (d.due_date as string | undefined) ?? null,
      contact_code: contact.code,
      price_incl_vat: (d.price_incl_vat as boolean | undefined) ?? false,
      branch_code: (d.branch_code as string | undefined) ?? '00000',
      external_source: src ?? null,
      external_ref: ref ?? null,
      created_by_client: 'tms',
      lines: d.lines.map((l, i) => ({
        line_no: i + 1,
        line_type: (l.line_type as MockLine['line_type'] | undefined) ?? 'item',
        product_code: (l.product_code as string | undefined) ?? null,
        description: l.description as string,
        qty: (l.qty as string | undefined) ?? null,
        unit_price: (l.unit_price as string | undefined) ?? null,
        amount: (l.amount as string | undefined) ?? '0.00',
        vat_rate: null,
        account_code: (l.account_code as string | undefined) ?? null,
        sent: { ...l },
      })),
    };
    this.documents.set(doc.id, doc);
    return { id: doc.id, created: true };
  }

  private syncContacts(body: unknown) {
    this.need('contacts:draft');
    if (!Array.isArray(body) || body.length > 500)
      throw new HttpError(400, 'ส่งเป็นรายการ ไม่เกิน 500');
    return body.map((x) => {
      const r = (x ?? {}) as Partial<MockContact> & { name?: string };
      if (!r.tax_id && !r.external_ref) throw new HttpError(422, 'ต้องมี tax_id หรือ external_ref');
      const hit = r.tax_id
        ? this.contacts.find(
            (c) => c.tax_id === r.tax_id && (c.branch_code ?? null) === (r.branch_code ?? null),
          )
        : this.contacts.find(
            (c) =>
              c.external_source === (r.external_source ?? null) &&
              c.external_ref === r.external_ref,
          );
      if (hit) {
        hit.name = r.name ?? hit.name;
        return { id: hit.id, code: hit.code, created: false };
      }
      this.seq.EXT++;
      const c = this.addContact({ ...r, code: `EXT-${String(this.seq.EXT).padStart(4, '0')}` });
      return { id: c.id, code: c.code, created: true };
    });
  }
}

export async function startMockAccountSystem(
  o: MockAccountSystemOptions = {},
): Promise<MockAccountSystem> {
  return new MockAccountSystem(o).start();
}
