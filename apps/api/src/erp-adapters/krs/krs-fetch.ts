import { Prisma } from '@prisma/client';
import {
  type CanonicalDocument,
  type ErpContext,
  ErpAdapterError,
  type ExternalDocumentPart,
  type ExternalRef,
  type LoggedHttpCall,
} from '../../modules/erp/erp-adapter';
import type { ErrorClass } from '../../modules/integration/outbox.types';
import { safeHttpRequest, type SendOptions } from '../../modules/webhooks/webhook-http';
import { KRS_INVOICE_HEADER_FIELDS } from './krs-invoice-payload';
import {
  KRS_MAX_RESPONSE_BYTES,
  maskKrsPersonText,
  parseKrsCreated,
  planKrsInvoice,
} from './krs-push';

/**
 * ST8-T10 `fetchDocument` ของ KRS (docs/01 A.1–A.2, A.5; §6.5) — `GET /invoice/{transactionNo}` → canonical
 *
 * - **canonical "มุมมอง KRS"**: KRS เก็บเฉพาะฟิลด์ในสัญญา (A.3) → ผลมีเฉพาะช่องของ canonical ที่ map มาจากฟิลด์ KRS
 *   (เลข/วันที่/ลูกค้า/รายการ: เลข DO, วันที่ DO, รถ, คนขับ, ต้นทาง/ปลายทาง, จำนวน, หน่วย, ราคาต่อหน่วย, รหัสสินค้า/บัญชี, คำอธิบาย)
 *   + `erpHeader` (ช่องหัวใบที่ไม่มีใน canonical: ที่อยู่ส่งของ, พนักงานขาย, ผู้บันทึก) · **ไม่มี** VAT / ยอดเงิน / ส่วนลด
 *   · `trip.driverName` = `carPerson` ตามที่ KRS เก็บ — เที่ยวรถร่วมที่ไม่มีชื่อคนขับ = **ชื่อบริษัทรถร่วม** (D-64 ค่าที่ส่งจริง) ไม่ใช่ชื่อคน
 *     (ST8-T11 reconcile ต้องเทียบกับ `comparableDocument` ไม่ใช่ `trip.driverName` ของ canonical ตรง ๆ)
 *   (สัญญาไม่มี VAT ต่อรายการ — A.6; ยอดที่ KRS คำนวณ ถ้ามีใน response ยังไม่ใช้เทียบ: การปัดของ KRS [OPEN — KRS] → ST8-T11)
 * - core เทียบกับ `krsComparable(ctx, canonical)` = canonical ที่ส่งไป → payload ชุดเดียวกับที่ POST (ST8-T08 `planKrsInvoice`)
 *   → แปลงกลับด้วยฟังก์ชันเดียวกัน — ส่งแล้วอ่านกลับต้องได้ค่าเท่ากันทุกช่อง (round-trip test)
 * - **ใบที่ถูกแยก** (D-69 แยกตาม `vat_type` / เกินเพดานขนาด): `ref.documents` → GET ทีละใบแล้วรวมรายการเป็นใบเดียว ·
 *   หัวใบมาจากใบที่ `tmsVoucherNo` = เลขใบแจ้งหนี้ (ไม่มี = ใบแรก) · ใบอื่นที่หัวต่างกันบันทึกใน `partHeaderDiffs`
 * - **จับคู่รายการด้วย `flowNo` (= เลข DO)** (docs/01 §6.5 — ไม่ใช่ลำดับ เพราะ KRS เขียนรายการใหม่ได้เมื่อบัญชีกดบันทึก A.1):
 *   มี `hint` (canonical ที่ส่ง) → `lineNo` = บรรทัดของ TMS ที่เลข DO ตรงกัน (DO เดียวหลายบรรทัด → `lineId` ที่ตรงก่อน แล้วตามลำดับ)
 *   ไม่ตรง DO ใด = `lineId` ของ KRS (ถ้ายังว่าง) ไม่งั้น null · ไม่มี hint = `lineId` · เรียงตาม `lineNo`
 * - error (A.5 / A.1): 404 → `NOT_FOUND` (`krs_not_found` — ใบใดใบหนึ่งหาย = ทั้งเอกสาร) · 401/403 AUTH · 503/429/5xx/timeout/เครือข่าย
 *   TRANSIENT (GET อ่านอย่างเดียว — ไม่มี AMBIGUOUS) · อื่น ๆ VALIDATION
 * - ทุก GET รายงาน `ctx.onHttpCall` — ไม่ส่ง header · `carPerson` (ชื่อคนขับ) ใน response แทนด้วย `***`
 * - KRS ไม่มี endpoint ค้นด้วย `tmsVoucherNo` (A.1) → adapter ประกาศ `fetchNeedsExternalId` · `krsDocumentsFromSyncLog`
 *   อ่านเลขที่ KRS ออกจาก response 201 ใน sync log (กรณีผลของคำสั่งไม่ถูกบันทึก)
 */

/** timeout ของ GET (ใบใหญ่ 446 รายการ — เท่ากับ POST) */
export const KRS_FETCH_TIMEOUT_MS = 120_000;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
/** ข้อความจาก KRS — ไม่ใช่สตริง = null (ค่าว่าง '' คงไว้: A.1 ฟิลด์รถ/เส้นทางอาจถูกล้างเป็นค่าว่าง) */
const txt = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** ตัวเลขของ KRS (JSON number หรือสตริงทศนิยม) → สตริงทศนิยมแบบไม่มีศูนย์ท้าย (ไม่ใช้ float คำนวณ) · ผิดรูป = null */
function dec(v: unknown): string | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  try {
    return new Prisma.Decimal(v).toFixed();
  } catch {
    return null;
  }
}

/** เอกสาร KRS 1 ใบ (body ของ request หรือ response GET) */
export interface KrsBody {
  body: Rec;
  transactionNo?: string | null;
  voucherNo?: string | null;
}

/** ช่องหัวใบที่ไม่มีที่ใน canonical (เทียบได้ แต่ไม่ย้อนเป็นช่องของ canonical) */
const ERP_HEADER_FIELDS = ['deliveryAddress', 'salePerson', 'saleName', 'entryBy'] as const;

/**
 * เอกสาร KRS (1 ใบหรือหลายใบของใบแจ้งหนี้เดียว) → canonical มุมมอง KRS — ฟังก์ชันบริสุทธิ์ ใช้ทั้งผลของ GET และ `krsComparable`
 */
export function krsBodiesToCanonical(
  head: { id: string; number: string },
  parts: readonly KrsBody[],
  hint?: CanonicalDocument,
): CanonicalDocument {
  const main = parts.find((p) => txt(p.body.tmsVoucherNo) === head.number) ?? parts[0];
  const h = rec(main?.body);

  // ---------- รายการ: จับคู่กับบรรทัดของ TMS ด้วยเลข DO ----------
  type Raw = { l: Rec; lineId: number | null; flowNo: string | null };
  const raws: Raw[] = parts.flatMap((p) =>
    (Array.isArray(p.body.lines) ? p.body.lines : []).map((x) => {
      const l = rec(x);
      return {
        l,
        lineId: Number.isInteger(l.lineId) ? (l.lineId as number) : null,
        flowNo: txt(l.flowNo),
      };
    }),
  );
  const lineNoOf = new Map<Raw, number | null>();
  const used = new Set<number>();
  if (hint) {
    const expected = (Array.isArray(hint.lines) ? hint.lines : []).flatMap((x) => {
      const l = rec(x);
      const n = l.lineNo;
      const flowNo = txt(rec(l.deliveryOrder).number)?.trim() ?? null;
      return Number.isInteger(n) && flowNo ? [{ lineNo: n as number, flowNo }] : [];
    });
    for (const r of raws) {
      if (r.flowNo === null) continue;
      const cands = expected.filter((e) => !used.has(e.lineNo) && e.flowNo === r.flowNo);
      const pick = cands.find((e) => e.lineNo === r.lineId) ?? cands[0];
      if (pick) {
        used.add(pick.lineNo);
        lineNoOf.set(r, pick.lineNo);
      }
    }
  }
  for (const r of raws) {
    if (lineNoOf.has(r)) continue;
    const n = r.lineId !== null && !used.has(r.lineId) ? r.lineId : null;
    if (n !== null && hint) used.add(n);
    lineNoOf.set(r, n);
  }
  const lines = raws
    .map((r, i) => {
      const l = r.l;
      return {
        i,
        line: {
          lineNo: lineNoOf.get(r) ?? null,
          deliveryOrder: { number: r.flowNo, date: txt(l.flowDate) },
          trip: { vehiclePlate: txt(l.carId), driverName: txt(l.carPerson) },
          route: { originName: txt(l.frWay), destinationName: txt(l.toWay) },
          serviceItem: { externalId: txt(l.itemCode) },
          description: txt(l.description),
          quantity: dec(l.mainQuantity),
          unitLabel: txt(l.mainUnits),
          unitPrice: dec(l.unitPrice),
          accountCode: txt(l.accountCode),
        },
      };
    })
    .sort((a, b) => {
      const x = a.line.lineNo;
      const y = b.line.lineNo;
      if (x === y) return a.i - b.i;
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y;
    })
    .map((x) => x.line);

  // ---------- หัวใบ ----------
  const diffs: Rec[] = [];
  for (const p of parts) {
    if (p === main) continue;
    const b = rec(p.body);
    const diff: Rec = {};
    for (const f of KRS_INVOICE_HEADER_FIELDS)
      if (f !== 'tmsVoucherNo' && f !== 'lines' && JSON.stringify(b[f]) !== JSON.stringify(h[f]))
        diff[f] = b[f] ?? null;
    if (Object.keys(diff).length) diffs.push({ ref: txt(b.tmsVoucherNo), ...diff });
  }
  const term = h.paymentInDay;
  return {
    id: head.id,
    kind: 'invoice',
    number: txt(h.tmsVoucherNo) ?? head.number,
    issueDate: txt(h.voucherDate),
    dueDate: txt(h.dueDate),
    customer: {
      externalId: txt(h.custOrSuppCode),
      legalName: txt(h.custOrSuppName),
      billingAddress: txt(h.address),
      paymentTermDays: typeof term === 'number' && Number.isInteger(term) ? term : null,
    },
    erpHeader: Object.fromEntries(ERP_HEADER_FIELDS.map((f) => [f, txt(h[f])])),
    lines,
    ...(diffs.length ? { partHeaderDiffs: diffs } : {}),
    ...(main?.transactionNo ? { externalId: main.transactionNo } : {}),
    ...(main?.voucherNo ? { externalDocNo: main.voucherNo } : {}),
  };
}

/**
 * ส่วนของ canonical ที่ KRS เก็บได้ (`ErpAdapter.comparableDocument`) = payload ชุดเดียวกับที่ POST แปลงกลับเป็น canonical
 * สร้าง payload ไม่ได้ (ข้อมูลไม่ครบตามสัญญา) = null (เทียบไม่ได้)
 */
export function krsComparable(
  ctx: Pick<ErpContext, 'config' | 'masterCodes'>,
  doc: CanonicalDocument,
): CanonicalDocument | null {
  const pl = planKrsInvoice(ctx, doc);
  if (!pl.ok) return null;
  return krsBodiesToCanonical(
    { id: String(doc.id), number: String(doc.number ?? '') },
    pl.plan.map((p) => ({ body: p.doc.body as unknown as Rec })),
    doc,
  );
}

function fetchError(errorClass: ErrorClass, code: string, message: string): ErpAdapterError {
  return new ErpAdapterError(errorClass, { code, message: message.trim().slice(0, 500) });
}

/** `GET {baseUrl}/invoice/{transactionNo}` 1 ใบ */
async function getOne(
  ctx: ErpContext,
  base: string,
  key: string,
  transactionNo: string,
  http: Pick<SendOptions, 'allowPrivate' | 'resolver'>,
): Promise<KrsBody> {
  const url = `${base}/invoice/${encodeURIComponent(transactionNo)}`;
  const started = Date.now();
  const at = new Date();
  const r = await safeHttpRequest(
    'GET',
    url,
    { 'X-API-Key': key, Accept: 'application/json' },
    '',
    {
      timeoutMs: KRS_FETCH_TIMEOUT_MS,
      maxResponseBytes: KRS_MAX_RESPONSE_BYTES,
      signal: ctx.signal,
      ...http,
    },
  );
  // ST7-T16 sync log 1 แถวต่อ 1 HTTP call — ไม่ส่ง header · ชื่อคนขับใน response (carPerson) แทนด้วย ***
  try {
    ctx.onHttpCall?.({
      method: 'GET',
      url,
      status: r.status,
      responseBody: r.status === null ? null : maskKrsPersonText(r.body),
      errorCode:
        r.status === null
          ? (r.errorCode ?? 'network')
          : r.status === 200
            ? null
            : `http_${r.status}`,
      durationMs: Date.now() - started,
      at,
    });
  } catch {
    /* ตัวบันทึกล้ม = ไม่กระทบผล */
  }
  if (r.status === null) {
    switch (r.errorCode) {
      case 'timeout':
        throw fetchError(
          'TRANSIENT',
          'timeout',
          `KRS did not answer within ${KRS_FETCH_TIMEOUT_MS} ms`,
        );
      case 'network':
      case 'aborted':
        throw fetchError('TRANSIENT', 'unreachable', `KRS unreachable: ${r.errorMessage ?? ''}`);
      case 'ssrf_blocked':
        throw fetchError(
          'VALIDATION',
          'url_not_allowed',
          r.errorMessage ?? 'destination not allowed',
        );
      default:
        throw fetchError('VALIDATION', 'invalid_request', r.errorMessage ?? 'cannot build request');
    }
  }
  if (r.status === 200) {
    let body: Rec;
    try {
      body = rec(JSON.parse(r.body));
    } catch {
      throw fetchError(
        'TRANSIENT',
        'invalid_response',
        `KRS answered HTTP 200 with invalid JSON for ${transactionNo}`,
      );
    }
    const got = parseKrsCreated(r.body);
    return {
      body,
      transactionNo: got?.transactionNo ?? transactionNo,
      voucherNo: got?.voucherNo ?? null,
    };
  }
  // A.5: 404 (PUT/GET) = ใบอาจถูกลบฝั่ง ERP → NOT_FOUND (core: REMOTE_MISSING ให้คนตัดสิน)
  if (r.status === 404)
    throw fetchError(
      'NOT_FOUND',
      'krs_not_found',
      `KRS has no invoice ${transactionNo} (HTTP 404)`,
    );
  if (r.status === 401 || r.status === 403)
    throw fetchError('AUTH', 'unauthorized', `KRS rejected the API key (HTTP ${r.status})`);
  if (r.status === 503)
    throw fetchError('TRANSIENT', 'service_unavailable', 'KRS database unavailable (HTTP 503)');
  if (r.status === 429 || r.status >= 500)
    throw fetchError('TRANSIENT', `http_${r.status}`, `KRS answered HTTP ${r.status}`);
  throw fetchError('VALIDATION', `http_${r.status}`, `unexpected HTTP ${r.status} — check baseUrl`);
}

/** ST8-T10 อ่านใบแจ้งหนี้ 1 ใบของ TMS จาก KRS (หลายเอกสาร KRS = อ่านทุกใบแล้วรวม) */
export async function fetchKrsDocument(
  ctx: ErpContext,
  ref: ExternalRef,
  hint: CanonicalDocument | undefined,
  http: Pick<SendOptions, 'allowPrivate' | 'resolver'>,
): Promise<CanonicalDocument> {
  const base = (ctx.config.baseUrl ?? '').trim().replace(/\/+$/, '');
  const key = ctx.config.apiKey ?? '';
  if (!base) throw fetchError('VALIDATION', 'config_missing', 'baseUrl is not set');
  if (!key) throw fetchError('AUTH', 'credentials_missing', 'apiKey is not set');
  const ids = ref.documents?.length
    ? ref.documents.map((p) => p.externalId)
    : ref.externalId
      ? [ref.externalId]
      : [];
  // KRS ค้นด้วย tmsVoucherNo ไม่ได้ (A.1 "ไม่มี endpoint ค้นด้วย tmsVoucherNo") — core ไม่เรียกโดยไม่มีเลข (fetchNeedsExternalId)
  if (!ids.length)
    throw fetchError(
      'VALIDATION',
      'krs_transaction_no_required',
      'KRS cannot look up an invoice without its transactionNo',
    );
  const parts: KrsBody[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    try {
      parts.push(await getOne(ctx, base, key, id, http));
    } catch (e) {
      // อ่านทุกใบก่อน แล้วรายงานใบที่หายทั้งหมดในครั้งเดียว
      if (e instanceof ErpAdapterError && e.errorClass === 'NOT_FOUND') missing.push(id);
      else throw e;
    }
  }
  if (missing.length)
    throw fetchError(
      'NOT_FOUND',
      'krs_not_found',
      `KRS has no invoice ${missing.join(', ').slice(0, 300)} (HTTP 404)` +
        (parts.length ? ` — ${parts.length} of ${ids.length} KRS document(s) still exist` : ''),
    );
  return krsBodiesToCanonical({ id: ref.localId, number: ref.number }, parts, hint);
}

const TMS_VOUCHER_RE = /"tmsVoucherNo"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * ST8-T10 เอกสาร KRS ที่ถูกสร้างแล้วตาม sync log (`ErpAdapter.documentsFromSyncLog`) — `POST /invoice` ที่ได้ 201 พร้อม `transactionNo`
 * `ref` = `tmsVoucherNo` ของ request · `lineNos` = `lineId` ของ request (body ถูกตัดท้าย = ไม่รู้ → [] — core ถือว่ายังไม่ครอบคลุม)
 */
export function krsDocumentsFromSyncLog(calls: readonly LoggedHttpCall[]): ExternalDocumentPart[] {
  const out: ExternalDocumentPart[] = [];
  for (const c of calls) {
    if (c.method !== 'POST' || c.status !== 201 || !/\/invoice$/.test(c.url)) continue;
    const created = c.responseBody ? parseKrsCreated(c.responseBody) : null;
    if (!created) continue;
    let ref: string | null = null;
    let lineNos: number[] = [];
    try {
      const b = rec(JSON.parse(c.requestBody ?? ''));
      ref = txt(b.tmsVoucherNo);
      lineNos = (Array.isArray(b.lines) ? b.lines : [])
        .map((l) => rec(l).lineId)
        .filter((n): n is number => Number.isInteger(n));
    } catch {
      // body ถูกตัดท้าย (sync log เก็บไม่เกิน 16,000 ตัวอักษร) — `tmsVoucherNo` อยู่ต้น body
      const m = TMS_VOUCHER_RE.exec(c.requestBody ?? '');
      try {
        ref = m ? (JSON.parse(`"${m[1]}"`) as string) : null;
      } catch {
        ref = null;
      }
    }
    if (!ref) continue;
    out.push({
      ref,
      externalId: created.transactionNo,
      externalDocNo: created.voucherNo,
      group: null,
      lineNos,
    });
  }
  return out;
}
