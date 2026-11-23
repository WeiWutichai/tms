import {
  type CanonicalDocument,
  ErpAdapterError,
  type ErpContext,
  type ExternalDocumentPart,
  type ExternalRef,
  type PushResult,
} from '../../modules/erp/erp-adapter';
import { safeHttpRequest } from '../../modules/webhooks/webhook-http';
import { getKrsInvoice } from './krs-fetch';
import {
  type KrsHttpOptions,
  KRS_MAX_RESPONSE_BYTES,
  KRS_PUSH_TIMEOUT_MS,
  krsFail,
  maskKrsPersonText,
  parseKrsCreated,
  planKrsInvoice,
  redactKrsBody,
} from './krs-push';
import type { KrsInvoiceDocument } from './krs-invoice-payload';

/**
 * ST8-T13 `replaceDocument` ของ KRS (docs/01 A.2 แถว `pushCreditNote`/`replaceDocument`, A.5, A.6; §6.1; D-54) —
 * `PUT /invoice/{transactionNo}` แทนที่ทั้งใบด้วยภาพ "หลังปรับ"
 *
 * - **`tmsVoucherNo` เดิม** (A.2 "ส่ง `tmsVoucherNo` เดิม + lines ชุดใหม่ทั้งหมด"; A.3 "ออกครั้งเดียว ส่งเลขเดิมทั้ง POST และ PUT"):
 *   แผนการแยกใบ (ST8-T08 `planKrsInvoice` — แยกตาม `vat_type` + เพดานขนาด) สร้างจากภาพหลังปรับโดยใช้ `ref.number`
 *   (เลขอ้างอิงที่ KRS เห็น — ใบที่ออกใหม่แทนใบเดิม (D-54 ยกเลิกแล้วออกใหม่) = เลขของใบเดิม) เป็นเลขฐาน
 * - **ทีละใบตาม `ref.documents`** (review L4 ของ ST8-T08): ใบ TMS ที่ KRS เก็บเป็นหลายเอกสาร → PUT ต่อใบด้วย `tmsVoucherNo` ของใบนั้น ·
 *   แผนหลังปรับต้องได้ชุด `tmsVoucherNo` **เท่ากับ**ใบที่มีอยู่ทุกใบ — ไม่ตรง (กลุ่ม VAT หาย/เพิ่ม, จำนวนใบตามขนาดเปลี่ยน) =
 *   VALIDATION `krs_replace_plan_mismatch` ไม่ส่งเลย (**PUT ไม่สร้างใบใหม่** และไม่ทิ้งใบเดิมไว้ค้าง — ให้คนตัดสิน)
 * - **กันเขียนผิดใบ**: ก่อน PUT อ่าน (`GET`) ทุกใบ — `tmsVoucherNo` ของใบใน KRS ต้องเท่ากับใบที่จะเขียน ไม่ตรง = VALIDATION
 *   `krs_ref_mismatch` ไม่ PUT ใบใดเลย (mock/สัญญายอมให้ PUT เปลี่ยน `tmsVoucherNo` ได้ — A.6 [OPEN — KRS])
 * - routing ตามนิติบุคคล: ผู้ออกใบต้องตรงกับนิติบุคคลของ connector (เหมือน POST)
 * - ผล (A.5): 200 → สำเร็จ (`applied: true` — core: mapping SYNCED; GET AFTER_PUSH = reconcile engine ST8-T11) ·
 *   404 → `NOT_FOUND` (core: REMOTE_MISSING ให้คนตัดสิน — **ไม่ POST**) · 400 → VALIDATION · 401/403 → AUTH · 409 (เลขอ้างอิงเป็นของใบอื่น)
 *   → VALIDATION · 503/429/5xx → TRANSIENT · timeout/สายหลุด → AMBIGUOUS (PUT ทั้งใบซ้ำได้ผลเดิม — core ส่งซ้ำตามตาราง)
 * - ส่งได้บางใบแล้วใบถัดไปล้ม: ไม่รายงาน `documents` (ทุกใบมีอยู่แล้ว — ไม่ใช่ "ส่งไม่ครบ") · ข้อความบอกใบที่แทนที่แล้ว ·
 *   รอบถัดไป PUT ทุกใบอีกครั้ง (idempotent — ไม่มีทางสร้างใบซ้ำ)
 * - sync log: ทุก GET/PUT รายงาน `ctx.onHttpCall` ไม่มี header (`X-API-Key`) · `carPerson` (ชื่อคนขับ) → `***` ทั้ง request และ response
 * - [OPEN — KRS] KRS-8 PUT ใบที่ลง GL แล้ว KRS ทำอะไร — core บังคับ approval ก่อนถึงที่นี่ (ปุ่ม "ลงบัญชีแล้ว" + อายุใบ > N วัน)
 */

type Fail = Extract<PushResult, { ok: false }>;

/** เอกสาร KRS ที่มีอยู่ของใบนี้ (ref → transactionNo) — ใบเดียว = `ref.number` + `ref.externalId` */
function existingParts(ref: ExternalRef): ExternalDocumentPart[] {
  if (ref.documents?.length) return [...ref.documents];
  if (!ref.externalId) return [];
  return [
    {
      ref: ref.number,
      externalId: ref.externalId,
      externalDocNo: null,
      group: null,
      lineNos: [],
    },
  ];
}

/** `PUT {baseUrl}/invoice/{transactionNo}` 1 ใบ */
async function putOne(
  ctx: ErpContext,
  base: string,
  key: string,
  transactionNo: string,
  d: KrsInvoiceDocument,
  http: KrsHttpOptions,
): Promise<{ ok: true; voucherNo: string | null } | Fail> {
  const url = `${base}/invoice/${encodeURIComponent(transactionNo)}`;
  const started = Date.now();
  const at = new Date();
  const r = await safeHttpRequest(
    'PUT',
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
  try {
    ctx.onHttpCall?.({
      method: 'PUT',
      url,
      requestBody: redactKrsBody(d.body),
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
        return krsFail(
          'AMBIGUOUS',
          'timeout',
          `KRS did not answer within ${KRS_PUSH_TIMEOUT_MS} ms`,
        );
      case 'network':
        if (r.notSent)
          return krsFail('TRANSIENT', 'unreachable', `KRS unreachable: ${r.errorMessage ?? ''}`);
        return krsFail(
          'AMBIGUOUS',
          'connection_reset',
          `KRS connection dropped before a response: ${r.errorMessage ?? ''}`,
        );
      case 'aborted':
        return krsFail('TRANSIENT', 'unreachable', `KRS unreachable: ${r.errorMessage ?? ''}`);
      case 'ssrf_blocked':
        return krsFail(
          'VALIDATION',
          'url_not_allowed',
          r.errorMessage ?? 'destination not allowed',
        );
      default:
        return krsFail('VALIDATION', 'invalid_request', r.errorMessage ?? 'cannot build request');
    }
  }
  if (r.status === 200) return { ok: true, voucherNo: parseKrsCreated(r.body)?.voucherNo ?? null };
  if (r.status >= 200 && r.status < 300)
    return krsFail(
      'AMBIGUOUS',
      'unexpected_status',
      `KRS answered HTTP ${r.status} (contract: 200) for ${d.tmsVoucherNo}`,
    );
  if (r.status === 404)
    return krsFail(
      'NOT_FOUND',
      'krs_not_found',
      `KRS has no invoice ${transactionNo} (HTTP 404) — not re-created`,
    );
  if (r.status === 400) {
    let message = '';
    try {
      const j = JSON.parse(r.body) as { message?: unknown; error?: unknown };
      message =
        typeof j?.message === 'string' ? j.message : typeof j?.error === 'string' ? j.error : '';
    } catch {
      /* ไม่ใช่ JSON */
    }
    return krsFail(
      'VALIDATION',
      'krs_rejected',
      message || `KRS rejected ${d.tmsVoucherNo} (HTTP 400)`,
    );
  }
  if (r.status === 401 || r.status === 403)
    return krsFail('AUTH', 'unauthorized', `KRS rejected the API key (HTTP ${r.status})`);
  if (r.status === 409)
    return krsFail(
      'VALIDATION',
      'krs_ref_conflict',
      `KRS: tmsVoucherNo ${d.tmsVoucherNo} belongs to another document (HTTP 409) — not replaced`,
    );
  if (r.status === 503)
    return krsFail('TRANSIENT', 'service_unavailable', 'KRS database unavailable (HTTP 503)');
  if (r.status === 429 || r.status >= 500)
    return krsFail('TRANSIENT', `http_${r.status}`, `KRS answered HTTP ${r.status}`);
  return krsFail('VALIDATION', `http_${r.status}`, `unexpected HTTP ${r.status} — check baseUrl`);
}

/** ST8-T13 แทนที่ใบแจ้งหนี้ 1 ใบใน KRS (อาจเป็นหลายเอกสาร KRS) ด้วยภาพหลังปรับ */
export async function replaceKrsInvoice(
  ctx: ErpContext,
  ref: ExternalRef,
  inv: CanonicalDocument,
  http: KrsHttpOptions,
): Promise<PushResult> {
  const base = (ctx.config.baseUrl ?? '').trim().replace(/\/+$/, '');
  const key = ctx.config.apiKey ?? '';
  if (!base) return krsFail('VALIDATION', 'config_missing', 'baseUrl is not set');
  if (!key) return krsFail('AUTH', 'credentials_missing', 'apiKey is not set');

  const issuer = (inv.issuer ?? {}) as { companyId?: unknown };
  if (ctx.companyId && typeof issuer.companyId === 'string' && issuer.companyId !== ctx.companyId)
    return krsFail(
      'VALIDATION',
      'krs_company_mismatch',
      'ใบนี้ออกในนามนิติบุคคลอื่น — connector KRS นี้ผูกกับอีกนิติบุคคล (ไม่ส่ง)',
    );

  const existing = existingParts(ref);
  const baseNo = (ref.number ?? '').trim();
  if (!existing.length || !baseNo)
    return krsFail(
      'VALIDATION',
      'krs_transaction_no_required',
      'KRS cannot replace an invoice without its transactionNo',
    );

  // แผนของภาพหลังปรับด้วยเลขอ้างอิงเดิม (KRS เห็นเลขนี้ — ไม่ใช่เลขของใบที่ออกใหม่)
  const pl = planKrsInvoice(ctx, { ...inv, number: baseNo });
  if (!pl.ok) return pl.problem;
  const byRef = new Map(existing.map((p) => [p.ref, p]));
  const planned = new Set(pl.plan.map((p) => p.doc.tmsVoucherNo));
  const added = [...planned].filter((r) => !byRef.has(r));
  const gone = [...byRef.keys()].filter((r) => !planned.has(r));
  if (added.length || gone.length || byRef.size !== existing.length)
    return krsFail(
      'VALIDATION',
      'krs_replace_plan_mismatch',
      `ภาพหลังปรับแยกเอกสาร KRS ไม่ตรงกับใบที่มีอยู่ (เพิ่ม: ${added.join(', ') || '-'} · หาย: ${gone.join(', ') || '-'}) — ` +
        'PUT สร้าง/ลบใบไม่ได้ ต้องแก้ในระบบบัญชีเอง',
    );

  // กันเขียนผิดใบ: อ่านทุกใบก่อน — tmsVoucherNo ในระบบบัญชีต้องเป็นใบที่จะเขียน
  const wrong: string[] = [];
  for (const p of existing) {
    try {
      const got = await getKrsInvoice(ctx, base, key, p.externalId, http);
      const actual = typeof got.body.tmsVoucherNo === 'string' ? got.body.tmsVoucherNo : null;
      if (actual !== p.ref)
        wrong.push(`${p.externalId} (tmsVoucherNo ${actual ?? '-'} ≠ ${p.ref})`);
    } catch (e) {
      if (e instanceof ErpAdapterError)
        return krsFail(e.errorClass, e.problem.code, e.problem.message);
      throw e;
    }
  }
  if (wrong.length)
    return krsFail(
      'VALIDATION',
      'krs_ref_mismatch',
      `KRS document(s) ${wrong.join(', ')} do not belong to this invoice — not replaced`,
    );

  const out: ExternalDocumentPart[] = [];
  for (const p of pl.plan) {
    const target = byRef.get(p.doc.tmsVoucherNo)!;
    const r = await putOne(ctx, base, key, target.externalId, p.doc, http);
    if (!r.ok) {
      if (!out.length) return r;
      return {
        ...r,
        // review L1: ใบที่แทนที่แล้ว — core บันทึกให้เห็นว่าเอกสารฝั่ง KRS ปนกัน (ส่งซ้ำ = PUT ทุกใบใหม่)
        replacedDocuments: [...out],
        problem: {
          ...r.problem,
          message:
            `${r.problem.message} — part ${p.doc.tmsVoucherNo} failed after ${out.length} of ${pl.plan.length} KRS document(s) were replaced (${out
              .map((o) => `${o.ref}→${o.externalId}`)
              .join(', ')}); the next attempt replaces every part again`.slice(0, 500),
        },
      };
    }
    out.push({
      ref: target.ref,
      externalId: target.externalId,
      externalDocNo: r.voucherNo ?? target.externalDocNo ?? null,
      group: p.group,
      lineNos: p.doc.lineNos,
    });
  }
  const head = out[0]!;
  return {
    ok: true,
    externalId: head.externalId,
    ...(head.externalDocNo ? { externalDocNo: head.externalDocNo } : {}),
    applied: true,
    documents: out,
  };
}
