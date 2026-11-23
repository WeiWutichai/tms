import type { ErrorClass } from '../../modules/integration/outbox.types';
import {
  MAX_EXTERNAL_DOCUMENTS,
  type CanonicalDocument,
  type ErpContext,
  type ExternalDocumentPart,
  type Problem,
  type PushResult,
} from '../../modules/erp/erp-adapter';
import { safeHttpRequest, type SendOptions } from '../../modules/webhooks/webhook-http';
import {
  buildKrsInvoicePayload,
  type KrsInvoiceDocument,
  type KrsInvoiceRequest,
  type KrsPayloadOptions,
} from './krs-invoice-payload';

/**
 * ST8-T08 `pushInvoice` ของ KRS (docs/01 A.1–A.3, A.6; D-64, D-69) — ใช้ payload builder ของ ST8-T07 แล้ว `POST /invoice`
 *
 * - **แยกใบตาม `vat_type`** (D-69: แยกที่ตัวเชื่อม — สัญญา KRS ไม่มี VAT ต่อรายการ A.6): รายการ canonical จัดกลุ่มตาม `vatType`
 *   เรียงกลุ่มตามลำดับคงที่ `KRS_VAT_GROUP_ORDER` · กลุ่มแรก = `tmsVoucherNo` เลขใบแจ้งหนี้ (ใบที่มี VAT ชนิดเดียว = เลขใบแจ้งหนี้เสมอ) ·
 *   กลุ่มถัดไป = `{เลข}-{รหัสกลุ่ม}` (`KRS_VAT_GROUP_SUFFIX`) · ภายในกลุ่มแบ่งต่อตามเพดานขนาดด้วยกติกาเดิมของ builder (`-P{n}`)
 *   ไม่แต่งกฎภาษี — แค่แบ่งรายการ ไม่คำนวณ/ไม่ส่ง VAT (A.3: KRS คำนวณเอง)
 * - สร้าง payload **ครบทุกใบก่อน** แล้วจึงส่ง (ข้อมูลไม่ครบใบใดใบหนึ่ง = ไม่ส่งเลย — VALIDATION `krs_payload_invalid`)
 * - D-64: เที่ยวที่ไม่มีชื่อคนขับ (รถร่วม) → `carPerson` = ชื่อบริษัทรถร่วม (`carPersonFallback: 'carrierName'`) — core เตือนตั้งแต่ร่าง
 *   ผ่าน `fieldSubstitutions` ของ adapter · **[OPEN — KRS] KRS-19** ยังต้องให้ KRS ยืนยันว่ารับค่านี้ได้
 * - routing ตามนิติบุคคล: core เลือก connector จาก `invoice.issuing_company_id` (ConnectorResolver) — adapter ตรวจซ้ำว่าผู้ออกใบ
 *   ตรงกับนิติบุคคลของ connector (ไม่ตรง = VALIDATION `krs_company_mismatch` ไม่ส่ง) · SO มาจากบริษัท NSF ได้ (A.1 ข้อสมมติ) —
 *   ใบออกในบริษัทที่ connector ผูก (PP) เสมอ
 * - ส่งทีละใบตามลำดับ · 201 → `transactionNo` / `voucherNo` · ผลรวม: ใบแรก = `externalId` / `externalDocNo` + `documents` ทุกใบ
 * - ทุก HTTP call รายงาน `ctx.onHttpCall` (sync log ST7-T16) — ไม่ส่ง header (`X-API-Key`) · `carPerson` (ชื่อคนขับ = ข้อมูลส่วนบุคคล) แทนด้วย `***`
 * - ส่งไม่ครบ (review H1/M2): ผลล้มรายงาน `documents` (ใบที่สร้างแล้ว) + `documentsComplete` (ใบที่ล้มได้คำตอบชัด = รู้แน่) →
 *   core เก็บใน mapping แล้วส่งกลับใน `ctx.priorDocuments` → รอบถัดไป POST เฉพาะใบที่ยังไม่มี · ใบแรกล้มแบบรู้แน่ = ลองใหม่ตามปกติ
 * - error: แปลง HTTP เป็น ErrorClass กลางแบบพื้นฐาน (docs/01 §6.3 / A.5 คอลัมน์ ErrorClass) — การจัดการเต็มของ A.5 (409 หา `transactionNo`,
 *   backoff, หยุดคิว ฯลฯ) = ST8-T09 · ส่งได้บางใบแล้วใบถัดไปล้ม = คืนผลล้มของใบนั้น (ข้อความบอกใบที่สร้างแล้ว · response 201 อยู่ใน sync log)
 *   — core ไม่ส่งซ้ำแบบไม่รู้ผล (มี POST ใน sync log → หาเอกสารก่อนด้วย `fetchDocument` ST8-T10 เมื่อรู้ `transactionNo`;
 *   ไม่รู้ = POST ใหม่ ถ้าถึงแล้ว KRS ตอบ 409 — A.5)
 */

/** timeout ต่อคำขอ (docs/01 §8.1 "timeout client 120 วินาที" สำหรับใบใหญ่) */
export const KRS_PUSH_TIMEOUT_MS = 120_000;
/** response ของ POST สะท้อนรายการกลับมา (ใบ 446 รายการ) — อ่านได้ถึง 16 MB */
export const KRS_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** ลำดับกลุ่ม VAT (คงที่ — ไม่ขึ้นกับลำดับรายการ) · กลุ่มแรกที่มีในใบได้เลขใบแจ้งหนี้ */
export const KRS_VAT_GROUP_ORDER = Object.freeze([
  'EXEMPT_TRANSPORT',
  'VAT_7',
  'ZERO_RATED',
] as const);
export type KrsVatGroup = (typeof KRS_VAT_GROUP_ORDER)[number];
/** **[OPEN — KRS]** ต่อท้าย `tmsVoucherNo` ของใบที่ 2 เป็นต้นไปเมื่อแยกตาม VAT (KRS-19 ความยาว/รูปแบบของ `tmsVoucherNo`) */
export const KRS_VAT_GROUP_SUFFIX: Readonly<Record<KrsVatGroup, string>> = Object.freeze({
  EXEMPT_TRANSPORT: 'EX',
  VAT_7: 'V7',
  ZERO_RATED: 'V0',
});

/** ค่าตั้งของ builder ที่ pushInvoice ใช้ — D-64 ชื่อรถร่วมแทนชื่อคนขับ */
export const KRS_PUSH_PAYLOAD_OPTIONS: Readonly<Partial<KrsPayloadOptions>> = Object.freeze({
  carPersonFallback: 'carrierName',
});

export interface KrsVatGroupDoc {
  group: KrsVatGroup;
  tmsVoucherNo: string;
  doc: CanonicalDocument;
}

type Fail = Extract<PushResult, { ok: false }>;

export function krsFail(
  errorClass: ErrorClass,
  code: string,
  message: string,
  fields?: Problem['fields'],
): Fail {
  return {
    ok: false,
    errorClass,
    retryable: errorClass === 'TRANSIENT',
    problem: {
      code,
      message: message.trim().slice(0, 500),
      ...(fields?.length ? { fields } : {}),
    },
  };
}

/**
 * แบ่งรายการ canonical ตาม `vatType` → เอกสารต่อกลุ่ม (สำเนาตื้น — lines เฉพาะกลุ่ม) · `vatType` ไม่รู้จัก = error (ไม่เดา)
 */
export function splitByVatType(
  inv: CanonicalDocument,
): { ok: true; groups: KrsVatGroupDoc[] } | { ok: false; problem: Fail } {
  const number = typeof inv.number === 'string' ? inv.number.trim() : '';
  const lines: unknown[] = Array.isArray(inv.lines) ? inv.lines : [];
  const byGroup = new Map<KrsVatGroup, unknown[]>();
  const bad: NonNullable<Problem['fields']> = [];
  lines.forEach((l, i) => {
    const v = (l as { vatType?: unknown } | null)?.vatType;
    if (typeof v !== 'string' || !(KRS_VAT_GROUP_ORDER as readonly string[]).includes(v)) {
      if (bad.length < 50)
        bad.push({
          field: `lines[${i}].vatType`,
          code: 'krs_vat_type_unknown',
          message: 'ชนิด VAT ของรายการไม่อยู่ในกลุ่มที่แยกใบได้',
        });
      return;
    }
    const g = byGroup.get(v as KrsVatGroup) ?? [];
    g.push(l);
    byGroup.set(v as KrsVatGroup, g);
  });
  if (bad.length)
    return {
      ok: false,
      problem: krsFail(
        'VALIDATION',
        'krs_payload_invalid',
        'แยกใบตามชนิด VAT ไม่ได้ — รายการมีชนิด VAT ที่ไม่รู้จัก',
        bad,
      ),
    };
  // ไม่มีรายการ = ส่งต่อให้ builder ตอบ "เอกสารไม่มีรายการ" (กลุ่มเดียว ใช้เลขใบแจ้งหนี้)
  if (!byGroup.size)
    return { ok: true, groups: [{ group: 'EXEMPT_TRANSPORT', tmsVoucherNo: number, doc: inv }] };
  const present = KRS_VAT_GROUP_ORDER.filter((g) => byGroup.has(g));
  return {
    ok: true,
    groups: present.map((group, i) => ({
      group,
      tmsVoucherNo: i === 0 ? number : `${number}-${KRS_VAT_GROUP_SUFFIX[group]}`,
      doc: { ...inv, lines: byGroup.get(group)! },
    })),
  };
}

/** body ที่ส่งเข้า sync log — ชื่อคนขับ (`carPerson`) เป็นข้อมูลส่วนบุคคล → `***` (core ตัด credential/เลขบัตรซ้ำอีกชั้น) */
export function redactKrsBody(body: KrsInvoiceRequest): unknown {
  return {
    ...body,
    lines: body.lines.map((l) => (l.carPerson ? { ...l, carPerson: '***' } : l)),
  };
}

/** ชื่อคนขับในข้อความ JSON (รวม response ที่ถูกตัดกลาง) → `***` — ใช้กับ body ที่ส่งเข้า sync log */
export function maskKrsPersonText(text: string): string {
  return (
    text
      .replace(/("carPerson"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1"***"')
      // response ที่ถูกตัดกลางค่า (ไม่มีเครื่องหมายปิด)
      .replace(/("carPerson"\s*:\s*)"(?:[^"\\]|\\.)*$/, '$1"***')
  );
}

/** response 201 → เลขที่ KRS ออก · JSON ถูกตัด/เสีย = หาเลขจากข้อความ (ใบถูกสร้างแล้ว — ห้ามทิ้งเลข) */
export function parseKrsCreated(
  text: string,
): { transactionNo: string; voucherNo: string | null } | null {
  try {
    const j = JSON.parse(text) as { transactionNo?: unknown; voucherNo?: unknown };
    const tx =
      typeof j?.transactionNo === 'string'
        ? j.transactionNo
        : typeof j?.transactionNo === 'number'
          ? String(j.transactionNo)
          : '';
    if (tx.trim())
      return {
        transactionNo: tx.trim().slice(0, 100),
        voucherNo: typeof j.voucherNo === 'string' ? j.voucherNo.slice(0, 100) : null,
      };
    return null;
  } catch {
    const tx = /"transactionNo"\s*:\s*"?([^",}\s]+)"?/.exec(text)?.[1];
    if (!tx) return null;
    const vn = /"voucherNo"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    return { transactionNo: tx.slice(0, 100), voucherNo: vn?.slice(0, 100) ?? null };
  }
}

/** ข้อความ error ของ KRS (`{status, error, message, errors?}`) — ตัดยาว · KRS ไม่สะท้อน header กลับ */
function krsErrorText(text: string): { message: string; fields?: Problem['fields'] } {
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown; errors?: unknown };
    const message =
      typeof j?.message === 'string' ? j.message : typeof j?.error === 'string' ? j.error : '';
    const fields = Array.isArray(j?.errors)
      ? j.errors.slice(0, 50).map((e) => {
          const x = (e ?? {}) as Record<string, unknown>;
          return {
            field: String(x.path ?? x.instancePath ?? '').slice(0, 120),
            code: String(x.keyword ?? 'invalid').slice(0, 60),
            message: String(x.message ?? '').slice(0, 300),
          };
        })
      : undefined;
    return { message: message.slice(0, 300), fields };
  } catch {
    return { message: '' };
  }
}

/**
 * HTTP status ของ POST → ErrorClass กลาง (docs/01 §6.3; A.5 คอลัมน์ ErrorClass) — **การจัดการ**ตาม A.5 เต็มรูป = ST8-T09
 * 400 VALIDATION · 401/403 AUTH · 409 DUPLICATE · 429/5xx TRANSIENT · อื่น ๆ (รวม 404 — POST ไม่มีใบให้ "ไม่พบ" = path ผิด) VALIDATION
 * (NOT_FOUND ของ A.5 ใช้กับ PUT/GET เท่านั้น — ST8-T09/T10)
 */
function classifyStatus(status: number, text: string, ref: string): Fail {
  const e = krsErrorText(text);
  if (status === 400)
    return krsFail(
      'VALIDATION',
      'krs_rejected',
      e.message || `KRS rejected ${ref} (HTTP 400)`,
      e.fields,
    );
  if (status === 401 || status === 403)
    return krsFail('AUTH', 'unauthorized', `KRS rejected the API key (HTTP ${status})`);
  if (status === 409)
    return krsFail('DUPLICATE', 'krs_duplicate', `KRS already has tmsVoucherNo ${ref} (HTTP 409)`);
  if (status === 503)
    return krsFail('TRANSIENT', 'service_unavailable', 'KRS database unavailable (HTTP 503)');
  if (status === 429 || status >= 500)
    return krsFail('TRANSIENT', `http_${status}`, `KRS answered HTTP ${status}`);
  return krsFail('VALIDATION', `http_${status}`, `unexpected HTTP ${status} — check baseUrl`);
}

/**
 * review M1: HTTP status ของ POST ที่ **รู้แน่ว่าใบไม่ถูกสร้าง** (ส่งซ้ำได้โดยไม่ต้องค้นก่อน)
 * - 400 payload ผิด · 401/403 key ผิด · 404 path ผิด · 429 ถูกจำกัดอัตรา — KRS ปฏิเสธก่อนบันทึก
 * - 503 — docs/01 A.1 (แถว Error code: "503 DB KRS ล่ม (retry)") = ฐานข้อมูล KRS ล่มก่อนประมวลผล จึงยังไม่มีใบ
 * - **ไม่รวม** 409 (มีใบเลขนี้อยู่แล้ว — อาจเป็นของเราจากรอบที่ผลหาย), 500 / 502 / 504 / 5xx อื่น (อาจบันทึกแล้วก่อนพัง/ตัดสาย)
 */
const KRS_DEFINITE_NOT_CREATED: ReadonlySet<number> = new Set([400, 401, 403, 404, 429, 503]);

/** `POST {baseUrl}/invoice` 1 ใบ */
async function postOne(
  ctx: ErpContext,
  base: string,
  key: string,
  d: KrsInvoiceDocument,
  http: Pick<SendOptions, 'allowPrivate' | 'resolver'>,
): Promise<
  { ok: true; transactionNo: string; voucherNo: string | null } | (Fail & { definite: boolean })
> {
  /** definite = รู้แน่ว่าใบนี้ไม่ถูกสร้าง (ได้คำตอบ HTTP ที่ไม่ใช่ 2xx / ไม่ได้ส่งออกไป) · timeout / สายหลุด / 2xx แปลก = ไม่รู้ */
  const no = (f: Fail, definite: boolean) => ({ ...f, definite });
  const url = `${base}/invoice`;
  const started = Date.now();
  const at = new Date();
  const r = await safeHttpRequest(
    'POST',
    url,
    { 'X-API-Key': key, Accept: 'application/json', 'Content-Type': 'application/json' },
    JSON.stringify(d.body),
    {
      timeoutMs: KRS_PUSH_TIMEOUT_MS,
      maxResponseBytes: KRS_MAX_RESPONSE_BYTES,
      signal: ctx.signal,
      ...http,
    },
  );
  // ST7-T16 sync log 1 แถวต่อ 1 HTTP call — ไม่ส่ง header (X-API-Key) · ชื่อคนขับแทนด้วย *** (core ตัด credential ซ้ำ)
  try {
    ctx.onHttpCall?.({
      method: 'POST',
      url,
      requestBody: redactKrsBody(d.body),
      status: r.status,
      // review M1: KRS สะท้อนรายการกลับ (มี carPerson) → ปิดชื่อคนขับก่อนเข้า sync log
      responseBody: r.status === null ? null : maskKrsPersonText(r.body),
      errorCode:
        r.status === null
          ? (r.errorCode ?? 'network')
          : r.status === 201
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
        // ส่งออกไปแล้วแต่ไม่รู้ผล (docs/01 §6.3 / A.5) — core ไม่ POST ซ้ำทันที
        return no(
          krsFail('AMBIGUOUS', 'timeout', `KRS did not answer within ${KRS_PUSH_TIMEOUT_MS} ms`),
          false,
        );
      case 'network':
      case 'aborted':
        // สายหลุดอาจเกิดหลังส่งถึงแล้ว — ไม่ถือว่ารู้แน่
        return no(
          krsFail('TRANSIENT', 'unreachable', `KRS unreachable: ${r.errorMessage ?? ''}`),
          false,
        );
      case 'ssrf_blocked':
        return no(
          krsFail('VALIDATION', 'url_not_allowed', r.errorMessage ?? 'destination not allowed'),
          true,
        );
      default:
        return no(
          krsFail('VALIDATION', 'invalid_request', r.errorMessage ?? 'cannot build request'),
          true,
        );
    }
  }
  if (r.status === 201) {
    const got = parseKrsCreated(r.body);
    // สร้างแล้วแต่อ่านเลขไม่ได้ = ไม่รู้ผล (ห้ามส่งซ้ำแบบไม่รู้ — ได้ 409)
    if (!got)
      return no(
        krsFail(
          'AMBIGUOUS',
          'invalid_response',
          `KRS answered HTTP 201 without a transactionNo for ${d.tmsVoucherNo}`,
        ),
        false,
      );
    return { ok: true, ...got };
  }
  // review L3: สัญญา POST = 201 เท่านั้น (A.1) — 2xx อื่นอาจสร้างแล้วหรือไม่ก็ได้ → AMBIGUOUS (ไม่ POST ซ้ำแบบไม่รู้ผล)
  if (r.status >= 200 && r.status < 300)
    return no(
      krsFail(
        'AMBIGUOUS',
        'unexpected_status',
        `KRS answered HTTP ${r.status} (contract: 201) for ${d.tmsVoucherNo}`,
      ),
      false,
    );
  return no(
    classifyStatus(r.status, r.body, d.tmsVoucherNo),
    KRS_DEFINITE_NOT_CREATED.has(r.status),
  );
}

/** เอกสาร KRS 1 ใบในแผนการส่ง (กลุ่ม VAT + payload) */
export interface KrsPlannedDocument {
  group: KrsVatGroup | null;
  doc: KrsInvoiceDocument;
}

/**
 * แผนการส่งใบแจ้งหนี้ 1 ใบ = เอกสาร KRS ทุกใบตามลำดับ (แยกตาม `vat_type` แล้วแบ่งตามเพดานขนาด) — ฟังก์ชันบริสุทธิ์
 * ใช้ทั้งตอน POST (ST8-T08) และตอนสร้างส่วนที่เทียบได้ของ canonical (`krsComparable` — ST8-T10) ให้ได้ใบชุดเดียวกันเสมอ
 * สร้าง payload ครบทุกใบก่อน — ใบใดไม่ผ่าน = ทั้งแผนไม่ผ่าน
 */
export function planKrsInvoice(
  ctx: Pick<ErpContext, 'config' | 'masterCodes'>,
  inv: CanonicalDocument,
): { ok: true; plan: KrsPlannedDocument[] } | { ok: false; problem: Fail } {
  const split = splitByVatType(inv);
  if (!split.ok) return split;
  const plan: KrsPlannedDocument[] = [];
  const fields: NonNullable<Problem['fields']> = [];
  let first: Extract<ReturnType<typeof buildKrsInvoicePayload>, { ok: false }> | null = null;
  const multi = split.groups.length > 1;
  for (const g of split.groups) {
    const built = buildKrsInvoicePayload(ctx, g.doc, {
      ...KRS_PUSH_PAYLOAD_OPTIONS,
      tmsVoucherNo: g.tmsVoucherNo,
    });
    if (!built.ok) {
      first ??= built;
      for (const f of built.problem.fields ?? [])
        if (fields.length < 50) fields.push(multi ? { ...f, field: `${g.group}:${f.field}` } : f);
      continue;
    }
    for (const doc of built.documents) plan.push({ group: g.group, doc });
  }
  if (first)
    return {
      ok: false,
      problem: krsFail('VALIDATION', first.problem.code, first.problem.message, fields),
    };
  if (new Set(plan.map((p) => p.doc.tmsVoucherNo)).size !== plan.length)
    return {
      ok: false,
      problem: krsFail(
        'VALIDATION',
        'krs_payload_invalid',
        'เลขเอกสาร (tmsVoucherNo) ของใบที่แยกซ้ำกัน',
      ),
    };
  // review L2: เกินจำนวนเอกสารที่ core เก็บได้ต่อใบ = ไม่ส่ง (ไม่ตัดทิ้งเงียบ)
  if (plan.length > MAX_EXTERNAL_DOCUMENTS)
    return {
      ok: false,
      problem: krsFail(
        'VALIDATION',
        'krs_too_many_documents',
        `ใบนี้ต้องแยกเป็น ${plan.length} เอกสารใน KRS — เกินเพดาน ${MAX_EXTERNAL_DOCUMENTS} (แบ่งรอบวางบิลให้เล็กลง)`,
      ),
    };
  return { ok: true, plan };
}

/** ST8-T08 ส่งใบแจ้งหนี้ 1 ใบ (อาจเป็นหลายเอกสาร KRS) */
export async function pushKrsInvoice(
  ctx: ErpContext,
  inv: CanonicalDocument,
  http: Pick<SendOptions, 'allowPrivate' | 'resolver'>,
): Promise<PushResult> {
  const base = (ctx.config.baseUrl ?? '').trim().replace(/\/+$/, '');
  const key = ctx.config.apiKey ?? '';
  if (!base) return krsFail('VALIDATION', 'config_missing', 'baseUrl is not set');
  if (!key) return krsFail('AUTH', 'credentials_missing', 'apiKey is not set');

  // routing ตามนิติบุคคล (docs/04 G3; A.1 "Invoice ออกในบริษัท PP") — core เลือก connector แล้ว ตรวจซ้ำกันส่งผิดบริษัท
  const issuer = (inv.issuer ?? {}) as { companyId?: unknown };
  if (ctx.companyId && typeof issuer.companyId === 'string' && issuer.companyId !== ctx.companyId)
    return krsFail(
      'VALIDATION',
      'krs_company_mismatch',
      'ใบนี้ออกในนามนิติบุคคลอื่น — connector KRS นี้ผูกกับอีกนิติบุคคล (ไม่ส่ง)',
    );

  const pl = planKrsInvoice(ctx, inv);
  if (!pl.ok) return pl.problem;
  const plan = pl.plan;

  // review H1: ใบที่สร้างไปแล้วในครั้งก่อน (core ส่งมาใน ctx.priorDocuments) ไม่ POST ซ้ำ
  const prior = new Map((ctx.priorDocuments ?? []).map((p) => [p.ref, p]));
  const planned = new Set(plan.map((p) => p.doc.tmsVoucherNo));
  const stray = [...prior.keys()].filter((ref) => !planned.has(ref));
  if (stray.length)
    return krsFail(
      'VALIDATION',
      'krs_partial_plan_changed',
      `เอกสารที่สร้างใน KRS แล้ว (${stray.join(', ').slice(0, 200)}) ไม่ตรงกับการแยกใบครั้งนี้ — ต้องให้คนตรวจ`,
    );
  const created: ExternalDocumentPart[] = [];
  for (const p of plan) {
    const known = prior.get(p.doc.tmsVoucherNo);
    if (known) {
      created.push({ ...known, group: p.group, lineNos: p.doc.lineNos });
      continue;
    }
    const r = await postOne(ctx, base, key, p.doc, http);
    if (!r.ok) {
      const { definite, ...fail } = r;
      // review H1/M2: รายงานใบที่สร้างแล้ว (core เก็บใน mapping) + รู้แน่ไหมว่ามีแค่นี้ (ใบที่ล้มได้คำตอบชัด = ไม่ถูกสร้าง)
      const out: Fail = { ...fail, documents: created, documentsComplete: definite };
      if (!created.length) return out;
      const done = created.map((c) => `${c.ref}→${c.externalId}`).join(', ');
      return {
        ...out,
        problem: {
          ...fail.problem,
          message:
            `${fail.problem.message} — part ${p.doc.tmsVoucherNo} failed after ${created.length} of ${plan.length} KRS document(s) were created (${done})`.slice(
              0,
              500,
            ),
        },
      };
    }
    created.push({
      ref: p.doc.tmsVoucherNo,
      externalId: r.transactionNo,
      externalDocNo: r.voucherNo,
      group: p.group,
      lineNos: p.doc.lineNos,
    });
  }
  const head = created[0]!;
  return {
    ok: true,
    externalId: head.externalId,
    ...(head.externalDocNo ? { externalDocNo: head.externalDocNo } : {}),
    // POST 201 = KRS สร้างใบใหม่จาก payload ครั้งนี้ทั้งหมด
    applied: true,
    documents: created,
  };
}
