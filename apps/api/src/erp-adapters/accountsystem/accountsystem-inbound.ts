import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ErpContext,
  InboundEffect,
  InboundEvent,
  InboundHandleResult,
  InboundRequest,
  InboundWebhookHandler,
} from '../../modules/erp/erp-adapter';
import { AS_SOURCE } from './accountsystem-payload';

/**
 * webhook ขาเข้าจาก AccountSystem (ST8-T16; packages/contracts/accountsystem/README.md §Webhook)
 * - ลายเซ็น `x-innovera-signature: sha256=hex(HMAC-SHA256(webhookSecret, "${x-innovera-timestamp}.${rawBody}"))` (hub.ts signWebhook)
 *   เทียบแบบเวลาคงที่ · timestamp ห่างเวลารับเกิน 5 นาที = ปฏิเสธ (กัน replay — AccountSystem ใส่ timestamp ใหม่ทุกครั้งที่ลองส่ง)
 * - กันซ้ำ: `eventKey` = `id` ของ event (uuid ต่อ event — ส่งซ้ำ/ลองใหม่ได้ id เดิม) → ledger ของ core (ST7-T22)
 * - `handle` แปลงเป็น `InboundEffect` ให้ core บันทึก (adapter ไม่เขียนฐาน) — เอกสารที่ไม่ได้มาจาก TMS = ไม่มีผล
 *   · `document.posted` / `document.voided` → externalDocument (เฉพาะ external_source `tms.*`)
 *   · `payment.received` → paymentReceived: ยอดตัดหนี้ = applied + wht (AccountSystem: applied ไม่รวม WHT)
 *   · `payment.paid` → paymentMade (บิลอ้างด้วย document_id — ไม่มี external_ref ในตัวจริง)
 *   · `period.closed` / ชนิดอื่น = รับไว้ ไม่มีผล
 */
export const AS_SIGNATURE_TOLERANCE_SEC = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_RE = /^-?\d{1,16}\.\d{2}$/;
const TYPE_RE = /^[a-z]+\.[a-z_]+$/;

interface AsEventBody {
  id: string;
  type: string;
  company_id?: string;
  occurred_at?: string;
  data?: Record<string, unknown>;
}

function body(req: Pick<InboundRequest, 'rawBody'>): AsEventBody | null {
  try {
    const j = JSON.parse(req.rawBody.toString('utf8')) as AsEventBody;
    if (!j || typeof j !== 'object' || typeof j.id !== 'string' || typeof j.type !== 'string')
      return null;
    return j;
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.length ? v.slice(0, max) : null;

/** satang จากสตริงเงิน (ห้าม float) */
function satang(v: unknown): bigint | null {
  if (typeof v !== 'string' || !MONEY_RE.test(v)) return null;
  const neg = v.startsWith('-');
  const [i, f] = (neg ? v.slice(1) : v).split('.');
  const n = BigInt(i!) * 100n + BigInt(f!);
  return neg ? -n : n;
}

function fromSatang(n: bigint): string {
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** วันที่ตามปฏิทินไทย (Asia/Bangkok = UTC+7 ไม่มี DST) */
function bangkokDate(iso: string | undefined, fallback: Date): string {
  const t = iso && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : fallback.getTime();
  return new Date(t + 7 * 3600_000).toISOString().slice(0, 10);
}

function entityOf(source: unknown): 'invoice' | 'settlement' | null {
  if (source === AS_SOURCE.invoice) return 'invoice';
  if (source === AS_SOURCE.settlement) return 'settlement';
  return null;
}

export const accountSystemInbound: InboundWebhookHandler = {
  verify(ctx: ErpContext, req: InboundRequest): boolean {
    const secret = ctx.config.webhookSecret ?? '';
    const ts = req.headers['x-innovera-timestamp'] ?? '';
    const sig = req.headers['x-innovera-signature'] ?? '';
    if (!secret || !/^\d{1,12}$/.test(ts) || !/^sha256=[0-9a-f]{64}$/.test(sig)) return false;
    const skew = Math.abs(req.receivedAt.getTime() / 1000 - Number(ts));
    if (skew > AS_SIGNATURE_TOLERANCE_SEC) return false;
    const expect = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${ts}.`), req.rawBody]))
      .digest();
    const got = Buffer.from(sig.slice(7), 'hex');
    return got.length === expect.length && timingSafeEqual(got, expect);
  },

  parse(_ctx: ErpContext, req: InboundRequest): InboundEvent | null {
    const b = body(req);
    if (!b || !UUID_RE.test(b.id) || !TYPE_RE.test(b.type) || b.type.length > 100) return null;
    return {
      eventKey: b.id,
      type: b.type,
      occurredAt: typeof b.occurred_at === 'string' ? b.occurred_at : null,
    };
  },

  async handle(
    _ctx: ErpContext,
    ev: InboundEvent,
    req: Pick<InboundRequest, 'rawBody'>,
  ): Promise<InboundHandleResult> {
    const b = body(req);
    if (!b)
      return { ok: false, retryable: false, problem: { code: 'bad_payload', message: 'not JSON' } };
    const d = b.data ?? {};
    const effects: InboundEffect[] = [];
    switch (ev.type) {
      case 'document.posted':
      case 'document.voided': {
        const entityType = entityOf(d.external_source);
        if (!entityType) return { ok: true, summary: { skipped: 'not_from_tms' } };
        effects.push({
          kind: 'externalDocument',
          entityType,
          externalId: str(d.id),
          localNumber: str(d.external_ref, 60),
          externalDocNo: str(d.doc_no, 100),
          status: ev.type === 'document.posted' ? 'POSTED' : 'VOIDED',
          reason: str(d.reason, 300),
        });
        break;
      }
      case 'payment.received': {
        const apps = Array.isArray(d.applications) ? d.applications : [];
        const allocations: Extract<
          InboundEffect,
          { kind: 'paymentReceived' }
        >['allocations'][number][] = [];
        for (const a of apps.slice(0, 200) as Record<string, unknown>[]) {
          const applied = satang(a?.applied);
          const wht = a?.wht === undefined || a?.wht === null ? 0n : satang(a.wht);
          if (applied === null || wht === null)
            return {
              ok: false,
              retryable: false,
              problem: { code: 'bad_payload', message: 'application amount is not money' },
            };
          allocations.push({
            externalId: str(a.document_id),
            // อ้างด้วย id ที่ได้ตอนส่งร่างเท่านั้น — external_ref ไม่บอกระบบต้นทาง (อาจชนเลขของระบบอื่น)
            localNumber: null,
            amount: fromSatang(applied + wht),
            whtAmount: fromSatang(wht),
          });
        }
        const id = str(d.id);
        if (!id)
          return {
            ok: false,
            retryable: false,
            problem: { code: 'bad_payload', message: 'no id' },
          };
        effects.push({
          kind: 'paymentReceived',
          externalId: id,
          externalDocNo: str(d.doc_no, 100),
          receivedDate: bangkokDate(b.occurred_at, new Date()),
          allocations,
        });
        break;
      }
      case 'payment.paid': {
        const bills = Array.isArray(d.bills) ? d.bills : [];
        const id = str(d.id);
        if (!id)
          return {
            ok: false,
            retryable: false,
            problem: { code: 'bad_payload', message: 'no id' },
          };
        const allocations: { externalId: string; amount: string; whtAmount: string }[] = [];
        for (const x of bills.slice(0, 200) as Record<string, unknown>[]) {
          const docId = str(x?.document_id);
          const applied = satang(x?.applied);
          const wht = x?.wht === undefined || x?.wht === null ? 0n : satang(x.wht);
          if (!docId || applied === null || wht === null) continue;
          allocations.push({
            externalId: docId,
            amount: fromSatang(applied + wht),
            whtAmount: fromSatang(wht),
          });
        }
        effects.push({
          kind: 'paymentMade',
          externalId: id,
          externalDocNo: str(d.doc_no, 100),
          allocations,
          certificates: Array.isArray(d.certificates)
            ? (d.certificates as unknown[]).flatMap((c) =>
                typeof c === 'string' ? [c.slice(0, 60)] : [],
              )
            : [],
        });
        break;
      }
      default:
        return { ok: true, summary: { skipped: 'event_not_used', type: ev.type } };
    }
    return { ok: true, effects, summary: { type: ev.type } };
  },
};
