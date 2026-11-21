import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DocumentEmail, Prisma, StoredDocument } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { docDateShort } from '../../common/thai-date';
import { DbService, type Tx } from '../../db/db.service';
import { mergePdfs } from '../../pdf/pdf-bundle';
import { BillingNotesService } from '../billing-notes/billing-notes.service';
import { putFileLocked } from '../../pdf/file-store';
import { EmailService } from '../email/email.service';
import type { TemplateVars } from '../email/templates';
import {
  DOCUMENT_EMAIL_MAX_RECIPIENTS,
  type DocumentEmailDto,
  type DocumentEmailPurpose,
  type DocumentEmailResultDto,
} from './document-email.dto';
import { InvoiceFinalizeService } from './invoice-finalize.service';
import { InvoiceStatusService, SENDABLE } from './invoice-status.service';

type EntityType = 'invoice' | 'billing_note';

const envInt = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isInteger(v) && v > 0 ? v : d;
};
/** ขนาดไฟล์แนบสูงสุด (ผู้ให้บริการอีเมลส่วนใหญ่รับ 10–25 MB — เผื่อ base64 +33%) */
export const EMAIL_ATTACHMENT_MAX_BYTES = () =>
  envInt('EMAIL_ATTACHMENT_MAX_BYTES', 10 * 1024 * 1024);
/** ส่งเอกสารเดิมถึงผู้รับเดิมซ้ำระหว่างที่ยังรอส่ง (QUEUED) ภายในช่วงนี้ → 409 `document_email_pending` (นาฬิกาฐานข้อมูล — review L4) */
const PENDING_WINDOW_MIN = 10;
/**
 * review L3 [DECISION spec/12 §3 แถว ST5-T21 — ย้อนได้]: อีเมลเอกสารถึงลูกค้าต่อ tenant ต่อชั่วโมง (นับผู้รับ — แถว document_email)
 * เกิน → 429 `rate_limited` (กันระบบถูกใช้ส่งอีเมลจำนวนมากไปที่อยู่ภายนอก)
 */
export const DOCUMENT_EMAILS_PER_HOUR = 200;
/** สถานะใบวางบิลที่ส่งได้ (มีเลขแล้ว ไม่ยกเลิก) */
const BN_SENDABLE = ['ISSUED', 'COLLECTED'];
/** ใบแจ้งเตือนชำระ — ใบที่ยังค้างรับ */
const REMINDABLE = ['ISSUED', 'PARTIALLY_PAID'];

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const yearStyleOf = (print: unknown): 'BE' | 'CE' =>
  (print as { yearStyle?: string } | null)?.yearStyle === 'CE' ? 'CE' : 'BE';
const nameOf = (snap: unknown, fallback: string) =>
  (snap as { name?: string } | null)?.name ?? fallback;

interface Contact {
  name?: string;
  email?: string | null;
  isPrimary?: boolean;
}

/**
 * ผู้รับตั้งต้นจากผู้ติดต่อของลูกค้า (`customer.contacts` — ST2-T01; spec/05 billingContacts ยังไม่มีช่องแยก)
 * [DECISION spec/12 §3 แถว ST5-T21] ผู้ติดต่อหลักที่มีอีเมล · ไม่มี → ผู้ติดต่อทุกคนที่มีอีเมล (สูงสุด 5) · ไม่ซ้ำ (ไม่สนตัวพิมพ์)
 */
export function defaultRecipients(contacts: unknown): string[] {
  const list = (Array.isArray(contacts) ? (contacts as Contact[]) : []).filter(
    (c) => typeof c?.email === 'string' && c.email.trim() !== '',
  );
  const primary = list.filter((c) => c.isPrimary);
  const pick = (primary.length ? primary : list).map((c) => c.email!.trim());
  return dedupe(pick).slice(0, DOCUMENT_EMAIL_MAX_RECIPIENTS);
}

const dedupe = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

interface Prepared {
  entityType: EntityType;
  entityId: string;
  documentNo: string;
  purpose: DocumentEmailPurpose;
  recipients: string[];
  vars: TemplateVars['customer_document'];
  /** ใบแจ้งหนี้ที่ตั้งธง "ส่งลูกค้าแล้ว" (EMAIL) */
  invoiceIds: string[];
  /** ไฟล์แนบ: ที่เก็บแล้ว (ใบเดียว) หรือไฟล์รวมที่ต้องเก็บ */
  file: { stored: StoredDocument; data: Buffer } | { bundle: Buffer; filename: string };
  contents: string[];
  meta: Record<string, unknown>;
  /** ผู้เรียกระบุ `to` เอง (ไม่ใช้ผู้ติดต่อของลูกค้า) — audit `toOverride` */
  toOverride: boolean;
}

/**
 * ส่งเอกสารถึงลูกค้าทางอีเมล (ST5-T21; docs/04 F3 "พิมพ์/ส่งเอกสาร"; spec/05 BIL-041) [DECISION spec/12 §3 แถว ST5-T21]
 * - ใบวางบิล: แนบ**ไฟล์รวม 1 ไฟล์** = ใบวางบิล (ต้นฉบับ) ตามด้วยใบแจ้งหนี้ (ต้นฉบับ) ตามลำดับในใบวางบิล — คัดลอกหน้าจาก PDF ที่เก็บ ณ วันออก
 *   (ไม่ render ใหม่; ยังไม่มีไฟล์ = สร้างตามกติกาเดิมของแต่ละเอกสาร รวมกฎรุ่นแม่แบบ) · ไฟล์รวมเก็บเป็น stored_document (key ตาม sha256 — ซ้ำ = ไฟล์เดิม)
 * - ใบแจ้งหนี้ / ใบแจ้งเตือนชำระ: แนบ PDF ต้นฉบับที่เก็บ ณ วันออก
 * - outbox อีเมลเดิม (ST1-T03) 1 ฉบับต่อผู้รับ + แถว `document_email` (สถานะการส่งแยกจากสถานะเอกสาร) · sandbox → dispatcher ไม่ส่ง (`sandbox_suppressed`)
 * - ใบแจ้งหนี้ที่ยังไม่มีธง "ส่งลูกค้าแล้ว" → ตั้งช่องทาง EMAIL (ST5-T18) · audit `billing_note.emailed` / `invoice.emailed`
 * - route เป็น `@NoTransaction` — สร้าง/อ่าน PDF นอก transaction แล้วเขียนทุกอย่างใน transaction เดียว (ล็อกเอกสาร + ตรวจสถานะซ้ำ)
 */
@Injectable()
export class DocumentEmailService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly email: EmailService,
    private readonly finalizer: InvoiceFinalizeService,
    private readonly billingNotes: BillingNotesService,
    private readonly status: InvoiceStatusService,
  ) {}

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = requestContext.require();
    return this.db.withTenant(ctx.tenantId!, async (tx) => {
      ctx.tx = tx as never;
      try {
        return await fn(tx);
      } finally {
        ctx.tx = undefined;
      }
    });
  }

  // ---------- ไฟล์รวมชุดใบวางบิล ----------

  /** โหลดใบวางบิลที่ส่งได้ + ใบแจ้งหนี้ในใบตามลำดับ */
  private async loadBillingNote(tx: Tx, id: string) {
    const bn = await tx.billingNote.findUnique({
      where: { id },
      include: {
        invoices: { where: { active: true }, orderBy: { lineNo: 'asc' } },
        customer: { select: { contacts: true, legalName: true } },
      },
    });
    if (!bn) throw new ProblemException('not_found');
    if (!bn.billingNoteNo || !BN_SENDABLE.includes(bn.status))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: bn.status,
      });
    return { ...bn, billingNoteNo: bn.billingNoteNo };
  }

  /**
   * ไฟล์รวม "ใบวางบิล + ใบแจ้งหนี้" (ต้นฉบับทั้งหมด) — ใบวางบิลหน้าแรก ตามด้วยใบแจ้งหนี้ตาม `line_no` ของใบวางบิล
   * ใช้ทั้งดาวน์โหลด (ส่งเอง — ทางเลือกเมื่อส่งอีเมลไม่ได้) และไฟล์แนบอีเมล
   */
  async billingNoteBundle(id: string): Promise<{
    filename: string;
    data: Buffer;
    contents: string[];
    invoiceIds: string[];
    parts: string[];
  }> {
    const bn = await this.inTx((tx) => this.loadBillingNote(tx, id));
    const head = await this.billingNotes.ensurePdf(id, 'ORIGINAL');
    const parts = [head.data];
    const shas = [head.doc.sha256 ?? ''];
    for (const l of bn.invoices) {
      const inv = await this.finalizer.ensurePdf(l.invoiceId, 'ORIGINAL');
      parts.push(inv.data);
      shas.push(inv.doc.sha256 ?? '');
    }
    const contents = [bn.billingNoteNo, ...bn.invoices.map((l) => l.invoiceNo)];
    return {
      filename: `${bn.billingNoteNo}-ชุดเอกสาร.pdf`,
      data: await mergePdfs(parts, `ใบวางบิล ${bn.billingNoteNo} + ใบแจ้งหนี้`),
      contents,
      invoiceIds: bn.invoices.map((l) => l.invoiceId),
      parts: shas,
    };
  }

  // ---------- ส่ง ----------

  async sendBillingNote(id: string, to: string[] | undefined): Promise<DocumentEmailResultDto> {
    const bn = await this.inTx(async (tx) => {
      const row = await this.loadBillingNote(tx, id);
      await this.precheckBundleSize(
        tx,
        row.pdfDocumentId,
        row.invoices.map((l) => l.invoiceId),
      );
      return row;
    });
    const recipients = this.recipients(to, bn.customer.contacts);
    const bundle = await this.billingNoteBundle(id);
    const print = bn.printOptions;
    return this.commit({
      entityType: 'billing_note',
      entityId: id,
      documentNo: bn.billingNoteNo,
      purpose: 'DOCUMENT',
      recipients,
      invoiceIds: bundle.invoiceIds,
      file: { bundle: bundle.data, filename: bundle.filename },
      contents: bundle.contents,
      meta: { parts: bundle.parts },
      toOverride: !!to?.length,
      vars: {
        kind: 'BILLING_NOTE',
        issuerName: nameOf(bn.issuerSnapshot, ''),
        customerName: nameOf(bn.customerSnapshot, bn.customer.legalName),
        documentNo: bn.billingNoteNo,
        invoiceNos: bundle.contents.slice(1),
        dueDate: null,
        collectionDate: bn.collectionDate
          ? docDateShort(ymd(bn.collectionDate), yearStyleOf(print))
          : null,
        filename: bundle.filename,
      },
    });
  }

  async sendInvoice(
    id: string,
    to: string[] | undefined,
    purpose: DocumentEmailPurpose,
  ): Promise<DocumentEmailResultDto> {
    const inv = await this.inTx((tx) => this.loadInvoice(tx, id, purpose));
    const recipients = this.recipients(to, inv.customer.contacts);
    const got = await this.finalizer.ensurePdf(id, 'ORIGINAL');
    const filename = got.doc.filename ?? `${inv.invoiceNo}.pdf`;
    return this.commit({
      entityType: 'invoice',
      entityId: id,
      documentNo: inv.invoiceNo,
      purpose,
      recipients,
      invoiceIds: [id],
      file: { stored: got.doc, data: got.data },
      contents: [inv.invoiceNo],
      meta: {},
      toOverride: !!to?.length,
      vars: {
        kind: purpose === 'PAYMENT_REMINDER' ? 'PAYMENT_REMINDER' : 'INVOICE',
        issuerName: nameOf(inv.issuerSnapshot, ''),
        customerName: nameOf(inv.customerSnapshot, inv.customer.legalName),
        documentNo: inv.invoiceNo,
        invoiceNos: [inv.invoiceNo],
        dueDate: inv.dueDate ? docDateShort(ymd(inv.dueDate), yearStyleOf(inv.printOptions)) : null,
        collectionDate: null,
        filename,
      },
    });
  }

  private async loadInvoice(tx: Tx, id: string, purpose: DocumentEmailPurpose) {
    const inv = await tx.invoice.findUnique({
      where: { id },
      include: { customer: { select: { contacts: true, legalName: true } } },
    });
    if (!inv) throw new ProblemException('not_found');
    const ok =
      purpose === 'PAYMENT_REMINDER'
        ? REMINDABLE.includes(inv.status) && inv.totalAmount.sub(inv.paidAmount).gt(0)
        : (SENDABLE as readonly string[]).includes(inv.status);
    if (!inv.invoiceNo || !ok)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: inv.status,
        ...(purpose === 'PAYMENT_REMINDER' ? { reason: 'not_outstanding' } : {}),
      });
    return { ...inv, invoiceNo: inv.invoiceNo };
  }

  /**
   * review L1: ต้นฉบับทุกใบเก็บไว้แล้ว → ผลรวมขนาดไฟล์เกินเพดานตั้งแต่ก่อนรวมไฟล์ → 422 ทันที (ไม่อ่าน/รวมไฟล์ใหญ่ในหน่วยความจำ)
   * ยังไม่มีบางไฟล์ → ตรวจหลังรวมตามเดิม · ใบวางบิลที่ใหญ่มาก = ดาวน์โหลดไฟล์รวม/รายใบแล้วส่งเอง
   */
  private async precheckBundleSize(tx: Tx, bnPdfId: string | null, invoiceIds: string[]) {
    if (!bnPdfId) return;
    const invs = await tx.invoice.findMany({
      where: { id: { in: invoiceIds } },
      select: { pdfDocumentId: true },
    });
    const ids = invs.map((x) => x.pdfDocumentId);
    if (ids.some((x) => !x)) return;
    const docs = await tx.storedDocument.findMany({
      where: { id: { in: [bnPdfId, ...(ids as string[])] } },
      select: { sizeBytes: true },
    });
    if (docs.length !== ids.length + 1) return;
    const sum = docs.reduce((a, d) => a + d.sizeBytes, 0);
    const max = EMAIL_ATTACHMENT_MAX_BYTES();
    if (sum > max)
      throw new ProblemException('email_attachment_too_large', undefined, undefined, {
        sizeBytes: sum,
        maxBytes: max,
      });
  }

  private recipients(to: string[] | undefined, contacts: unknown): string[] {
    const list = to?.length ? dedupe(to.map((x) => x.trim())) : defaultRecipients(contacts);
    if (!list.length) throw new ProblemException('document_email_no_recipient');
    return list;
  }

  /** เขียนทุกอย่างใน transaction เดียว: ล็อกเอกสาร → ตรวจสถานะซ้ำ + กันส่งซ้ำ → เก็บไฟล์ → outbox + document_email → ธงส่งแล้ว → audit */
  private async commit(p: Prepared): Promise<DocumentEmailResultDto> {
    const data = 'stored' in p.file ? p.file.data : p.file.bundle;
    const max = EMAIL_ATTACHMENT_MAX_BYTES();
    if (data.length > max)
      throw new ProblemException('email_attachment_too_large', undefined, undefined, {
        sizeBytes: data.length,
        maxBytes: max,
      });
    const ctx = requestContext.require();
    const tenantId = ctx.tenantId!;
    return this.inTx(async (tx) => {
      // ล็อกเอกสาร + ตรวจสถานะอีกครั้ง (ยกเลิกระหว่างสร้าง PDF → 409)
      if (p.entityType === 'billing_note') {
        await tx.$queryRaw`SELECT id FROM billing_note WHERE id = ${p.entityId}::uuid FOR UPDATE`;
        await this.loadBillingNote(tx, p.entityId);
      } else {
        await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${p.entityId}::uuid FOR UPDATE`;
        await this.loadInvoice(tx, p.entityId, p.purpose);
      }
      const now = this.clock.now();
      // เวลาตามนาฬิกาฐานข้อมูล (created_at ใช้ now() ของฐาน — review L4)
      const pending = await tx.$queryRaw<{ toAddress: string; createdAt: Date }[]>`
        SELECT to_address AS "toAddress", created_at AS "createdAt" FROM document_email
         WHERE entity_type = ${p.entityType} AND entity_id = ${p.entityId}::uuid AND purpose = ${p.purpose}
           AND status = 'QUEUED' AND created_at > now() - (${PENDING_WINDOW_MIN}::int * interval '1 minute')`;
      const want = new Set(p.recipients.map((r) => r.toLowerCase()));
      const dup = pending.filter((x) => want.has(x.toAddress.toLowerCase()));
      if (dup.length)
        throw new ProblemException('document_email_pending', undefined, undefined, {
          pending: dup.map((x) => ({ to: x.toAddress, queuedAt: x.createdAt.toISOString() })),
        });
      const [hour] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM document_email WHERE created_at > now() - interval '1 hour'`;
      const lastHour = hour?.n ?? 0;
      if (lastHour + p.recipients.length > DOCUMENT_EMAILS_PER_HOUR)
        throw new ProblemException('rate_limited', undefined, undefined, {
          limit: DOCUMENT_EMAILS_PER_HOUR,
          window: '1h',
          sentLastHour: lastHour,
        });

      const doc =
        'stored' in p.file
          ? p.file.stored
          : await this.storeBundle(tx, p, p.file.bundle, p.file.filename);
      const rows: DocumentEmail[] = [];
      const outbox = p.recipients.map((to) => ({ to, id: randomUUID(), rowId: randomUUID() }));
      await this.email.enqueueMany(
        tx,
        outbox.map((o) => ({
          id: o.id,
          tenantId,
          to: o.to,
          template: 'customer_document' as const,
          locale: 'th',
          vars: p.vars,
          attachments: [
            {
              fileKey: doc.fileKey!,
              filename: p.vars.filename,
              contentType: 'application/pdf',
            },
          ],
        })),
      );
      const flagged = await this.status.markSentByEmail(
        tx,
        p.invoiceIds,
        { entityType: p.entityType, documentNo: p.documentNo },
        now,
      );
      for (const o of outbox)
        rows.push(
          await tx.documentEmail.create({
            data: {
              id: o.rowId,
              tenantId,
              entityType: p.entityType,
              entityId: p.entityId,
              purpose: p.purpose,
              documentNo: p.documentNo,
              toAddress: o.to,
              attachmentDocumentId: doc.id,
              emailOutboxId: o.id,
              invoiceIds: p.invoiceIds,
              flaggedInvoiceIds: flagged,
              flaggedAt: flagged.length ? now : null,
              createdBy: ctx.actorId ?? null,
            },
          }),
        );
      await this.audit.record({
        action: p.entityType === 'billing_note' ? 'billing_note.emailed' : 'invoice.emailed',
        entityType: p.entityType,
        entityId: p.entityId,
        after: {
          documentNo: p.documentNo,
          purpose: p.purpose,
          to: p.recipients,
          ...(p.toOverride ? { toOverride: true } : {}),
          attachment: {
            documentId: encodeId('document', doc.id),
            filename: p.vars.filename,
            sha256: doc.sha256,
            contents: p.contents,
          },
          emailIds: rows.map((r) => encodeId('documentEmail', r.id)),
        },
      });
      return {
        attachment: {
          documentId: encodeId('document', doc.id),
          filename: p.vars.filename,
          sizeBytes: doc.sizeBytes,
          sha256: doc.sha256 ?? '',
          contents: p.contents,
        },
        emails: rows.map(toDto),
      };
    });
  }

  /** ไฟล์รวม → FileStore + stored_document (ไฟล์เดิม = แถวเดิม) */
  private async storeBundle(
    tx: Tx,
    p: Prepared,
    data: Buffer,
    filename: string,
  ): Promise<StoredDocument> {
    const ctx = requestContext.require();
    const f = await putFileLocked(tx, ctx.tenantId!, data, 'pdf');
    const existing = await tx.storedDocument.findFirst({
      where: {
        entityType: p.entityType,
        entityId: p.entityId,
        kind: 'PDF',
        sha256: f.sha256,
        status: 'READY',
      },
    });
    if (existing) return existing;
    return tx.storedDocument.create({
      data: {
        tenantId: ctx.tenantId!,
        status: 'READY',
        kind: 'PDF',
        mimeType: 'application/pdf',
        fileKey: f.key,
        sha256: f.sha256,
        sizeBytes: f.size,
        filename,
        entityType: p.entityType,
        entityId: p.entityId,
        createdBy: ctx.actorId ?? null,
        metadata: {
          document: 'BILLING_NOTE_BUNDLE',
          billingNoteNo: p.documentNo,
          contents: p.contents,
          ...p.meta,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ---------- อ่านประวัติการส่ง ----------

  async list(entityType: EntityType, id: string): Promise<{ data: DocumentEmailDto[] }> {
    return this.inTx(async (tx) => {
      const exists =
        entityType === 'invoice'
          ? await tx.invoice.findUnique({ where: { id }, select: { id: true } })
          : await tx.billingNote.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new ProblemException('not_found');
      const rows = await tx.documentEmail.findMany({
        where: { entityType, entityId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return { data: rows.map(toDto) };
    });
  }
}

function toDto(r: DocumentEmail): DocumentEmailDto {
  return {
    id: encodeId('documentEmail', r.id),
    entityType: r.entityType as EntityType,
    entityId: encodeId(r.entityType === 'invoice' ? 'invoice' : 'billingNote', r.entityId),
    purpose: r.purpose as DocumentEmailPurpose,
    documentNo: r.documentNo,
    to: r.toAddress,
    status: r.status as DocumentEmailDto['status'],
    failedReason: r.failedReason,
    sentAt: r.sentAt?.toISOString() ?? null,
    attachmentDocumentId: encodeId('document', r.attachmentDocumentId),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}
