import { currentLogoId, loadLogo } from '../settings/org-logo';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { StoredDocument } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { JobQueue } from '../../jobs/job-queue.service';
import type { FinanceParty } from '../../pdf/finance-document';
import { resolvePayer, type PayerSnapshot } from './settlement-payer';
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { putFileLocked, store } from '../documents/documents.controller';
import { bangkokToday } from '../vehicle-documents/expiry';
import type { DeductionType, SettlementDto } from './settlement.dto';
import {
  settlementVoucherDocument,
  sumDecimal,
  type SettlementPrintModel,
  type SettlementPrintTrip,
} from './settlement-pdf.template';
import { SettlementsService } from './settlements.service';
import {
  SETTLEMENT_PDF_JOB,
  SETTLEMENT_PDF_RETRY_MS,
  type SettlementPdfVariant,
} from './settlement-pdf.job';

/** ผู้จ่ายบนใบ — ต้นแบบ #pv แสดงชื่อ + สาขา + เลขผู้เสียภาษี (ไม่แสดงที่อยู่ แม้ snapshot เก็บไว้) */
const payerParty = (p: PayerSnapshot): FinanceParty => ({
  name: p.name,
  taxId: p.taxId,
  branchCode: p.branchCode,
  address: '',
});

const sha256Of = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** ฉบับที่เก็บไฟล์: ใบที่มีเลขแล้วเท่านั้น (APPROVED / PAID) */
const storedVariant = (dto: SettlementDto): StoredVariant | null =>
  dto.settlementNo && (dto.status === 'APPROVED' || dto.status === 'PAID') ? dto.status : null;

/** ลำดับชนิดบรรทัดหักบนเส้นรวม (ตาม DEDUCTION_TYPES) */
const DEDUCTION_ORDER: DeductionType[] = ['CASH_ADVANCE', 'FUEL_PROVIDED', 'FINE', 'DAMAGE'];

/**
 * PDF ใบสำคัญจ่ายรถร่วม (ST6-T04) — ข้อมูลอ่านใน transaction สั้นแล้ว render นอก transaction (แบบใบแจ้งหนี้ ST5-T08)
 * **ตัวเลขทุกตัวมาจาก `SettlementsService.get`** (DTO เดียวกับ `GET /v1/settlements/{id}`) — ยอดบน PDF = API โดยโครงสร้าง ·
 * ใบที่อนุมัติแล้วใช้ยอด WHT ที่ตรึง (`wht_amount`) · สุทธิ = `buyNetAfterWht`
 *
 * **ST9-T15 (D-54: ใบสำคัญจ่ายเป็นเอกสารที่ออกเลขแล้วของ TMS — PDF ที่เก็บไม่ถูก render ใหม่)** [DECISION spec/12 §3 แถว ST9-T15 —
 * แก้ข้อ (7) ของแถว ST6-T04 "render ตามคำขอ ไม่เก็บไฟล์"]:
 * - ร่าง (ยังไม่มีเลข) = render ตามคำขอ ไม่เก็บ (ตามเดิม)
 * - ใบที่มีเลขแล้ว: ฉบับ `APPROVED` (อนุมัติแล้ว ยังไม่จ่าย) และฉบับ `PAID` (มีข้อมูลการจ่าย) — เก็บแบบเขียนครั้งเดียว
 *   (`stored_document` kind PDF, entity `carrier_settlement`, `metadata.variant`) ใต้ล็อกแถวใบ; ครั้งต่อไปส่งไฟล์เดิม
 *   (แม่แบบเปลี่ยน/ข้อมูลอ้างอิงเปลี่ยน → ไฟล์และ sha256 คงเดิม · ฐานข้อมูลกันแก้/ลบแถวไฟล์ — migration 0160)
 * - **D-66 (PO 22 พ.ย. 2569): เก็บ ณ วันอนุมัติ / วันจ่าย** — approve / mark-paid enqueue งาน `settlement.render_pdf` ใน transaction
 *   เดียวกัน → render หลัง commit (ไม่ถือล็อก/ไม่ทำให้ approve ช้า) + ลองใหม่แบบ `invoice.render_pdf` · audit actor `system:settlement-pdf` ·
 *   คำขอ PDF ก่อนงานทำ = render แล้วเก็บเอง (ทางสำรอง — ล็อกแถวใบ + ตรวจซ้ำ งานกับคำขอได้ไฟล์เดียว)
 */
/** รุ่นแม่แบบ — บันทึกใน `stored_document.metadata.templateVersion` ของไฟล์ที่เก็บ (เพิ่มเลขเมื่อแก้แม่แบบ) */
export const SETTLEMENT_PDF_TEMPLATE_VERSION = 2; // 2: เส้นทาง "→" → "–" (Sarabun ไม่มี "→" — spec/12 §3)
/** entity_type ของไฟล์ PDF ใบสำคัญจ่ายที่เก็บ (ตรงกับ `FINANCE_PDF_ENTITY_TYPES` + trigger `stored_document_guard`) */
const PDF_ENTITY = 'carrier_settlement';
type StoredVariant = SettlementPdfVariant;
/** สถานะใบที่เก็บฉบับนั้นได้ — ฉบับอนุมัติยังเก็บได้หลังจ่ายแล้ว (ยอด/ผู้จ่าย/WHT ตรึงตั้งแต่อนุมัติ — trigger 0124/0139) */
const VARIANT_STATUSES: Record<StoredVariant, readonly string[]> = {
  APPROVED: ['APPROVED', 'PAID'],
  PAID: ['PAID'],
};
/** แบบพิมพ์ของฉบับ `variant` — ฉบับอนุมัติของใบที่จ่ายแล้ว = ไม่มีข้อมูลการจ่าย + วันที่เอกสาร = วันอนุมัติ (เท่ากับที่ render ตอนอนุมัติ) */
export const asVariant = (
  m: SettlementPrintModel,
  dto: SettlementDto,
  variant: StoredVariant,
): SettlementPrintModel =>
  variant === 'APPROVED' && dto.status === 'PAID'
    ? {
        ...m,
        paymentMethod: null,
        paymentReference: null,
        docDate: dto.approvedAt ? bangkokToday(new Date(dto.approvedAt)) : m.docDate,
      }
    : m;

@Injectable()
export class SettlementPdfService implements OnModuleInit {
  private readonly inflight = new Map<string, Promise<Buffer>>();
  constructor(
    private readonly db: DbService,
    private readonly renderer: PdfRenderer,
    private readonly settlements: SettlementsService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
  ) {}

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = requestContext.require();
    return this.db.withTenant(ctx.tenantId!, async (tx: Tx) => {
      ctx.tx = tx as never;
      try {
        return await fn(tx);
      } finally {
        ctx.tx = undefined;
      }
    });
  }

  private async storedPdf(
    tx: Tx,
    id: string,
    variant: StoredVariant,
  ): Promise<StoredDocument | null> {
    const doc = await tx.storedDocument.findFirst({
      where: {
        entityType: PDF_ENTITY,
        entityId: id,
        kind: 'PDF',
        metadata: { path: ['variant'], equals: variant },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (doc && (doc.status !== 'READY' || !doc.fileKey)) throw new ProblemException('not_found');
    return doc;
  }

  /** D-66: งาน `settlement.render_pdf` — render นอก transaction แล้วเก็บ (idempotent — มีไฟล์แล้ว = ข้าม) · ลองใหม่จนเก็บได้ */
  onModuleInit() {
    this.queue.register(
      SETTLEMENT_PDF_JOB,
      async ({ job, tenantId }) => {
        const p = job.payload as { settlementId?: unknown; variant?: unknown } | null;
        const id = p?.settlementId;
        const variant = p?.variant;
        if (typeof id !== 'string' || (variant !== 'APPROVED' && variant !== 'PAID'))
          return { skipped: 'bad_payload' };
        const doc = await requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'system:settlement-pdf', locale: 'th' },
          () => this.ensureStored(id, variant),
        );
        return doc
          ? { documentId: encodeId('document', doc.id), variant, sha256: doc.sha256 }
          : { skipped: 'status_changed', variant };
      },
      { outsideTransaction: true, retryDelaysMs: SETTLEMENT_PDF_RETRY_MS },
    );
  }

  /**
   * @param id uuid ของใบ
   * @param onlyPaid ลิงก์รถร่วม: ต้นแบบ TMS Subcon มีปุ่ม "ใบจ่ายเงิน" เฉพาะงวดที่จ่ายแล้ว → ใบที่ยังไม่จ่าย 409
   * @returns `stored` = ไฟล์ที่เก็บ (ใบที่มีเลขแล้ว) · ร่าง = null
   */
  async render(
    id: string,
    onlyPaid = false,
  ): Promise<{
    model: SettlementPrintModel;
    dto: SettlementDto;
    pdf: Buffer;
    stored: StoredDocument | null;
  }> {
    const { model, dto, existing } = await this.inTx(async (tx) => {
      const m = await this.loadModel(tx, id, onlyPaid);
      const variant = storedVariant(m.dto);
      return { ...m, existing: variant ? await this.storedPdf(tx, id, variant) : null };
    });
    const variant = storedVariant(dto);
    // ร่าง / รอรถร่วมตรวจ (ยังไม่มีเลข) — ไม่ใช่เอกสารที่ออกแล้ว: render ตามคำขอ
    if (!variant)
      return {
        model,
        dto,
        pdf: await this.renderer.pdf(settlementVoucherDocument(model)),
        stored: null,
      };
    if (existing)
      return { model, dto, pdf: await store().get(existing.fileKey!), stored: existing };
    // ทางสำรอง (D-66): งานเบื้องหลังยังไม่ได้เก็บ → render แล้วเก็บเองแบบเดียวกับงาน (ล็อกแถวใบ + ตรวจซ้ำ = ได้ไฟล์เดียว)
    const { doc, data } = await this.storeRendered(id, variant, model, dto.settlementNo!);
    // สถานะเปลี่ยนระหว่าง render → ส่งไฟล์ที่ render ไว้ (ตรงกับสถานะตอนอ่าน) โดยไม่เก็บ; ครั้งต่อไปเก็บฉบับของสถานะใหม่
    if (!doc) return { model, dto, pdf: data, stored: null };
    return {
      model,
      dto,
      pdf: doc.sha256 === sha256Of(data) ? data : await store().get(doc.fileKey!),
      stored: doc,
    };
  }

  /**
   * D-66: เก็บ PDF ฉบับ `variant` ของใบ (งานเบื้องหลังหลังอนุมัติ/บันทึกจ่าย) — มีไฟล์แล้ว = คืนไฟล์เดิม (ไม่ render) ·
   * ฉบับอนุมัติของใบที่จ่ายไปแล้ว (งานช้ากว่าการจ่าย) = render จากข้อมูลที่ตรึงโดยไม่ใส่ข้อมูลการจ่าย · สถานะไม่ตรง (ยกเลิก/ไม่มีใบ) = null
   */
  async ensureStored(id: string, variant: StoredVariant): Promise<StoredDocument | null> {
    const found = await this.inTx(async (tx) => {
      const existing = await this.storedPdf(tx, id, variant);
      if (existing) return { existing };
      const row = await tx.carrierSettlement.findUnique({
        where: { id },
        select: { status: true, settlementNo: true },
      });
      if (!row?.settlementNo || !VARIANT_STATUSES[variant].includes(row.status)) return {};
      const { model, dto } = await this.loadModel(tx, id);
      return { model: asVariant(model, dto, variant), settlementNo: row.settlementNo };
    });
    if (found.existing) return found.existing;
    if (!found.model) return null;
    return (await this.storeRendered(id, variant, found.model, found.settlementNo!)).doc;
  }

  /**
   * render (คำขอพร้อมกันรอผลเดียวกัน) แล้วเก็บแบบเขียนครั้งเดียวใต้ล็อกแถวใบ — ใช้ร่วมกันระหว่างงานเบื้องหลังกับคำขอแรก
   * @returns `doc` = ไฟล์ที่เก็บ (ของคำขอนี้หรือที่มีอยู่แล้ว) · null = สถานะใบไม่ตรงกับฉบับนี้แล้ว (ไม่เก็บ)
   */
  private async storeRendered(
    id: string,
    variant: StoredVariant,
    model: SettlementPrintModel,
    settlementNo: string,
  ): Promise<{ doc: StoredDocument | null; data: Buffer }> {
    const ctx = requestContext.require();
    // คำขอพร้อมกันรอผล render เดียวกัน — ไม่ให้ลิงก์เดียวกินคิว Chromium ที่ใช้ร่วมทุก tenant (review M1 ของ ST6-T04)
    const key = `${id}:${variant}`;
    let job = this.inflight.get(key);
    if (!job) {
      job = this.renderer
        .pdf(settlementVoucherDocument(model))
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    const data = await job;
    const doc = await this.inTx(async (tx) => {
      // ล็อกแถวใบ: งาน + คำขอพร้อมกัน = เก็บไฟล์เดียว · สถานะไม่ตรงกับฉบับนี้แล้ว (เช่น ยกเลิก) = ไม่เก็บ
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM carrier_settlement WHERE id = ${id}::uuid FOR UPDATE`;
      const found = await this.storedPdf(tx, id, variant);
      if (found || !VARIANT_STATUSES[variant].includes(rows[0]?.status ?? '')) return found;
      // ฉบับอนุมัติที่เก็บเมื่อใบจ่ายแล้ว (งานช้ากว่าการจ่าย) — ติดธงให้ตรวจย้อนได้ว่า render หลังวันจ่าย (review D-66)
      const late = variant === 'APPROVED' && rows[0]?.status === 'PAID';
      const f = await putFileLocked(tx, ctx.tenantId!, data, 'pdf');
      const created = await tx.storedDocument.create({
        data: {
          tenantId: ctx.tenantId!,
          status: 'READY',
          kind: 'PDF',
          mimeType: 'application/pdf',
          fileKey: f.key,
          sha256: f.sha256,
          sizeBytes: f.size,
          filename: `${settlementNo}${variant === 'PAID' ? '-paid' : ''}.pdf`,
          entityType: PDF_ENTITY,
          entityId: id,
          createdBy: ctx.actorId ?? null,
          metadata: {
            document: 'SETTLEMENT_VOUCHER',
            variant,
            settlementNo,
            templateVersion: SETTLEMENT_PDF_TEMPLATE_VERSION,
            ...(late ? { renderedAfterPaid: true } : {}),
          },
        },
      });
      await this.audit.record({
        action: 'settlement.pdf_stored',
        entityType: PDF_ENTITY,
        entityId: id,
        after: {
          documentId: encodeId('document', created.id),
          variant,
          settlementNo,
          sha256: f.sha256,
          templateVersion: SETTLEMENT_PDF_TEMPLATE_VERSION,
          ...(late ? { renderedAfterPaid: true } : {}),
        },
      });
      return created;
    });
    return { doc, data };
  }

  async loadModel(
    tx: Tx,
    id: string,
    onlyPaid = false,
  ): Promise<{ model: SettlementPrintModel; dto: SettlementDto }> {
    const dto = await this.settlements.get(id);
    // ไม่รู้ประเภทรถร่วม (ยังไม่ตรึง WHT) → ไม่มียอดหัก ณ ที่จ่ายให้พิมพ์ → 409 แทน 500
    if (!dto.whtEstimate || dto.buyWhtAmount === undefined)
      throw new ProblemException('settlement_carrier_type_missing');
    if (dto.status === 'CANCELLED' || (onlyPaid && dto.status !== 'PAID'))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: dto.status,
      });
    const active = dto.lines.filter((l) => l.active);
    const tripLines = active.filter((l) => l.lineType !== 'DEDUCTION' && l.tripId);
    const tripIds = [...new Set(tripLines.map((l) => tryDecodeId('trip', l.tripId!)!))];
    const trips = await tx.trip.findMany({
      where: { id: { in: tripIds } },
      select: {
        id: true,
        tripNo: true,
        tripDate: true,
        completedAt: true,
        driverNameSnapshot: true,
        stops: {
          where: { removedAt: null },
          orderBy: { sequence: 'asc' },
          select: { site: { select: { name: true } } },
        },
      },
    });
    const byId = new Map(trips.map((t) => [t.id, t]));
    const row = await tx.carrierSettlement.findUniqueOrThrow({
      where: { id },
      select: { payingCompanyId: true, payerSnapshot: true },
    });
    // ตามแนว D-61: ลายน้ำ sandbox จาก `tenant.mode` ในฐาน (ไม่เชื่อผู้เรียก) — mode แก้ไม่ได้ (trigger 0107 "tenant mode is immutable")
    // จึงเท่ากับค่า ณ วันอนุมัติเสมอ ไม่ต้องตรึงลงใบ (ไม่มี print_options บนใบสำคัญจ่าย) · ใช้ mode ไม่ใช่ `TEST-` ในเลข: ชุดเลข
    // live ตั้ง prefix เองได้ และใบที่อนุมัติใน sandbox ก่อนเลข `TEST-` ก็ได้ลายน้ำด้วย
    const tenant = await tx.tenant.findFirst({ select: { yearStyle: true, mode: true } });
    const yearStyle = tenant?.yearStyle === 'CE' ? 'CE' : 'BE';
    // P1-ST6-T04 โลโก้ปัจจุบัน — ฉบับที่เก็บแล้ว (D-66) ไม่ render ใหม่ จึงตรึงอยู่ในไฟล์ (เหมือน yearStyle ด้านบน)
    const logo = await loadLogo(tx, await currentLogoId(tx, requestContext.require().tenantId!));

    // แถวต่อเที่ยว (ลำดับตามบรรทัดแรกของเที่ยว): ค่าเที่ยว = Σ FREIGHT · ค่าใช้จ่ายหน้างาน = Σ SURCHARGE
    const rows: (SettlementPrintTrip & { driver: string | null })[] = tripIds.map((tid) => {
      const t = byId.get(tid)!;
      const mine = tripLines.filter((l) => tryDecodeId('trip', l.tripId!) === tid);
      const sum = (type: string) =>
        sumDecimal(mine.filter((l) => l.lineType === type).map((l) => l.buyAmount ?? '0.00'));
      const stops = t.stops;
      const first = stops[0]?.site.name;
      const last = stops.length > 1 ? stops[stops.length - 1]!.site.name : undefined;
      return {
        tripNo: t.tripNo ?? '—',
        date: t.completedAt ? bangkokToday(t.completedAt) : t.tripDate.toISOString().slice(0, 10),
        route: first ? (last ? `${first} – ${last}` : first) : null,
        tripFee: sum('FREIGHT'),
        siteExpenses: sum('SURCHARGE'),
        driver: t.driverNameSnapshot,
      };
    });
    // review L3: บรรทัดเที่ยว/ค่าใช้จ่ายที่ไม่ผูกเที่ยว (ไม่ควรมี — trip_cost ผูกเที่ยวเสมอ) → แถว "—" เพื่อให้ผลรวมตาราง = ยอดซื้อรวม
    const orphan = active.filter((l) => l.lineType !== 'DEDUCTION' && !l.tripId);
    if (orphan.length) {
      const sum = (type: string) =>
        sumDecimal(orphan.filter((l) => l.lineType === type).map((l) => l.buyAmount ?? '0.00'));
      rows.push({
        tripNo: '—',
        date: null,
        route: orphan.map((l) => l.description).join(', '),
        tripFee: sum('FREIGHT'),
        siteExpenses: sum('SURCHARGE'),
        driver: null,
      });
    }
    // ผลรวมตารางต้องเท่ากับยอดซื้อรวมของ API เสมอ — ไม่ตรง = ไม่พิมพ์ (ดีกว่าออกใบที่ยอดขัดกัน)
    const tableSum = sumDecimal(rows.flatMap((r) => [r.tripFee, r.siteExpenses]));
    if (tableSum !== dto.buyGrossAmount)
      throw new Error(
        `settlement ${id}: trip table total ${tableSum} ≠ buyGrossAmount ${dto.buyGrossAmount}`,
      );
    const drivers = new Set(rows.filter((r) => r.tripNo !== '—').map((r) => r.driver));
    const driver = drivers.size === 1 ? ([...drivers][0] ?? null) : null;

    const deductions = DEDUCTION_ORDER.map((type) => {
      const ls = active.filter((l) => l.lineType === 'DEDUCTION' && l.deductionType === type);
      return { type, amount: sumDecimal(ls.map((l) => l.buyAmount ?? '0.00')).replace(/^-/, '') };
    }).filter((d) => d.amount !== '0.00');

    const docDate =
      dto.status === 'PAID' && dto.paidDate
        ? dto.paidDate
        : dto.approvedAt
          ? bangkokToday(new Date(dto.approvedAt))
          : bangkokToday();
    const c = dto.carrier;
    return {
      dto,
      model: {
        yearStyle,
        logo: logo?.dataUri ?? null,
        settlementNo: dto.settlementNo,
        docDate,
        payer: payerParty(
          (row.payerSnapshot as unknown as PayerSnapshot | null) ??
            (await resolvePayer(tx, row.payingCompanyId)),
        ),
        payee: {
          name: c.legalName,
          // บุคคลธรรมดา: snapshot เก็บเฉพาะ 4 หลักท้าย (PDPA) → พิมพ์แบบปิดบัง
          taxId: c.taxId ?? (c.taxIdLast4 ? `XXXXXXXXX${c.taxIdLast4}` : null),
        },
        driver,
        periodFrom: dto.periodFrom,
        periodTo: dto.periodTo,
        paymentMethod: dto.paymentMethod,
        paymentReference: dto.paymentReference,
        trips: rows.map(({ driver: _d, ...r }) => r),
        gross: dto.buyGrossAmount!,
        whtByRate: dto.whtEstimate.byRate
          .filter((g) => g.buyWhtAmount !== undefined && g.buyWhtAmount !== '0.00')
          .map((g) => ({ rate: g.whtRate, amount: g.buyWhtAmount! })),
        whtTotal: dto.buyWhtAmount!,
        deductions,
        net: dto.buyNetAfterWht!,
        ...(tenant?.mode === 'test' ? { sandbox: true } : {}),
      },
    };
  }
}
