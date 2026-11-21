import { Injectable } from '@nestjs/common';
import { taxOptionsFromSettings, type ServiceItemVatType } from '@tms/domain';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { decodeIdOr404 } from '../../common/ids';
import { readSettings } from '../settings/settings.service';
import type { CreateInvoiceDto } from './invoice.dto';
import { InvoicesService, type InvoicePartySnapshot } from './invoices.service';
import { invoiceDocument, invoiceTotals, type InvoicePrintModel } from './invoice.template';

function addressText(a: unknown): string {
  if (!a || typeof a !== 'object') return '';
  const o = a as Record<string, unknown>;
  return ['line1', 'line2', 'subdistrict', 'district', 'province', 'postcode']
    .map((k) => o[k])
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join(' ');
}

/** วันนี้ (เวลาไทย) YYYY-MM-DD */
const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * PDF ตัวอย่างของร่างใบแจ้งหนี้ (ST5-T07 "pro forma PDF อัปเดตตามแก้") — render ใหม่ทุกครั้ง ไม่เก็บไฟล์ (ร่างไม่ใช่เอกสาร)
 * ไม่ถือ transaction ระหว่าง render (แบบใบคุมรถ ST3-T20) · แม่แบบเต็ม ST5-T08 (`invoice.template.ts` — ร่าง = ลายน้ำ ไม่มีเลข)
 * ใบที่ออกแล้ว (เลข + ต้นฉบับ/สำเนา, render ครั้งเดียวเก็บ immutable — BIL-196) = ST5-T09 ใช้ `loadModel` + แม่แบบเดียวกัน
 */
@Injectable()
export class InvoicePdfService {
  constructor(
    private readonly db: DbService,
    private readonly renderer: PdfRenderer,
    private readonly invoices: InvoicesService,
  ) {}

  /** อ่านร่าง + ผู้ออก/ลูกค้า ใน transaction สั้น แล้ว render นอก transaction */
  async proforma(id: string): Promise<{ doc: InvoicePrintModel; pdf: Buffer }> {
    const ctx = requestContext.require();
    const doc = await this.db.withTenant(ctx.tenantId!, async (tx: Tx) => {
      ctx.tx = tx as never;
      try {
        return await this.loadModel(tx, id);
      } finally {
        ctx.tx = undefined;
      }
    });
    if (doc.status !== 'DRAFT')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: doc.status,
      });
    return { doc: doc.model, pdf: await this.render(doc.model) };
  }

  /**
   * review M2: PDF ตัวอย่างจาก DO ที่ติ๊ก **โดยไม่บันทึกอะไร** — สร้างร่าง (รวมส่งบัญชี) ด้วยกติกาเดียวกับ `POST /invoices`
   * ใน transaction แล้วย้อนทั้งหมด (rollback) ก่อน render — ไม่มีร่าง/การส่งบัญชี/audit ค้าง
   */
  async preview(body: CreateInvoiceDto): Promise<{ doc: InvoicePrintModel; pdf: Buffer }> {
    const ctx = requestContext.require();
    let doc: InvoicePrintModel | null = null;
    try {
      await this.db.withTenant(ctx.tenantId!, async (tx: Tx) => {
        ctx.tx = tx as never;
        try {
          const inv = await this.invoices.create({ ...body, releaseDeliveryOrders: true });
          doc = (await this.loadModel(tx, decodeIdOr404('invoice', inv.id))).model;
        } finally {
          ctx.tx = undefined;
        }
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return { doc: doc!, pdf: await this.render(doc!) };
  }

  private render(doc: InvoicePrintModel) {
    return this.renderer.pdf(invoiceDocument(doc));
  }

  /**
   * ข้อมูลพิมพ์ของใบ: หัว (ผู้ออก/สาขา, ลูกค้า/สาขา), บรรทัดบนเอกสารตาม Group/Merge/Single (+ DO · ทะเบียนรถของเที่ยว),
   * ยอดจาก**บรรทัดจริงที่ยังใช้** ด้วย computeDocumentTax + ค่าตั้ง tenant ชุดเดียวกับตอนบันทึก (ตรงกับหัวใบ)
   * ร่าง: วันที่ = วันพิมพ์ (เวลาไทย) · ครบกำหนด = วันพิมพ์ + เครดิต (ถ้าออกวันนี้)
   */
  async loadModel(
    tx: Tx,
    id: string,
    /**
     * ใบที่ออกแล้ว (ไม่ใช่ DRAFT) **ต้องส่ง** วันที่ออก/ครบกำหนด/ฉบับ จาก snapshot ตอนออกเลข — hand-off ST5-T09:
     * T09 เพิ่มคอลัมน์ `issued_on`/`due_on` แล้วส่งค่าจากใบ (ห้ามใช้วันพิมพ์) · ไม่ส่ง → error (กันพิมพ์วันผิดบนใบจริง — review L2)
     */
    issued?: { issueDate: string; dueDate: string; copy: 'ORIGINAL' | 'COPY' },
  ): Promise<{ status: string; model: InvoicePrintModel }> {
    const inv = await this.invoices.get(id, tx);
    // ไม่มี snapshot ของใบที่ออกแล้ว → 409 (pro forma ของใบที่ไม่ใช่ร่าง) — ไม่พิมพ์วันพิมพ์แทนวันที่ออกจริง
    if (inv.status !== 'DRAFT' && !issued)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: inv.status,
      });
    const row = await tx.invoice.findUniqueOrThrow({
      where: { id },
      include: {
        issuingCompany: true,
        issuingBranch: true,
        customer: true,
        lines: {
          // ST5-T10 ใบที่ยกเลิก: บรรทัดของเอกสาร ณ วันยกเลิก (ไม่ใช่ที่ถอดออกจากร่าง)
          where: { OR: [{ active: true }, { releasedWithInvoice: true }] },
          orderBy: { lineNo: 'asc' },
          include: {
            deliveryOrder: {
              select: {
                doNo: true,
                trip: {
                  select: { vehiclePlateSnapshot: true, vehicle: { select: { plate: true } } },
                },
              },
            },
          },
        },
      },
    });
    // ใบที่ออกแล้ว: ผู้ออก/ลูกค้า/ค่าพิมพ์ ณ วันออก (snapshot — BIL-196 "สำเนา render จาก snapshot เดิมเท่านั้น")
    const snap = inv.status !== 'DRAFT' ? issuedSnapshot(row) : null;
    const tenant = snap
      ? { yearStyle: snap.print.yearStyle }
      : await tx.tenant.findFirst({ select: { yearStyle: true } });
    const whtMinimumAmount = snap
      ? snap.print.whtMinimumAmount
      : ((await readSettings(tx, requestContext.require().tenantId!, ['tax.whtMinimumAmount']))[
          'tax.whtMinimumAmount'
        ] as number);
    const plate = new Map<string, string | null>();
    for (const l of row.lines)
      if (l.deliveryOrder?.doNo)
        plate.set(
          l.deliveryOrder.doNo,
          l.deliveryOrder.trip?.vehiclePlateSnapshot ??
            l.deliveryOrder.trip?.vehicle?.plate ??
            null,
        );
    // ร่าง: วันที่ = วันพิมพ์ (เวลาไทย) · ครบกำหนด = วันพิมพ์ + เครดิต
    const issueDate = issued?.issueDate ?? todayBkk();
    return {
      status: inv.status,
      model: {
        yearStyle: tenant?.yearStyle === 'CE' ? 'CE' : 'BE',
        invoiceNo: inv.invoiceNo,
        copy: issued?.copy ?? null,
        issueDate,
        dueDate: issued?.dueDate ?? addDays(issueDate, inv.creditTermDays),
        issuer: snap
          ? {
              name: snap.issuer.name,
              taxId: snap.issuer.taxId,
              branchCode: snap.issuer.branchCode,
              address: snap.issuer.address,
              vatRegistered: snap.issuer.vatRegistered ?? true,
            }
          : issuerParty(row),
        customer: snap
          ? {
              name: snap.customer.name,
              taxId: snap.customer.taxId,
              branchCode: snap.customer.taxId ? snap.customer.branchCode : null,
              address: snap.customer.address,
            }
          : customerParty(row),
        periodFrom: inv.periodFrom,
        periodTo: inv.periodTo,
        creditTermDays: inv.creditTermDays,
        customerPoNo: inv.customerPoNo,
        note: inv.note,
        cancelled: inv.status === 'CANCELLED' && inv.invoiceNo !== null,
        replaces:
          inv.replacesInvoice?.invoiceNo && inv.replacesInvoice.issueDate
            ? {
                invoiceNo: inv.replacesInvoice.invoiceNo,
                issueDate: inv.replacesInvoice.issueDate,
              }
            : null,
        lines: inv.printLines.map((p) => ({
          no: p.no,
          description: p.description,
          deliveryOrders: p.deliveryOrderNos.map((doNo) => ({
            doNo,
            plate: plate.get(doNo) ?? null,
          })),
          quantity: p.quantity,
          unitLabel: p.unitLabel,
          unitPrice: p.sellUnitPrice ?? null,
          discount: p.sellDiscount ?? '0.00',
          amount: p.sellAmount ?? '0.00',
          vatType: p.vatType as ServiceItemVatType,
        })),
        totals: invoiceTotals(
          row.lines.map((l) => ({
            amount: l.amount.toFixed(2),
            vatType: l.vatType as ServiceItemVatType,
            whtRate: l.whtRate.toFixed(2),
          })),
          taxOptionsFromSettings({ whtMinimumAmount }),
        ),
      },
    };
  }
}

type PrintRow = {
  issuingCompany: { legalName: string; taxId: string | null; vatRegistered: boolean };
  issuingBranch: { branchCode: string; address: unknown };
  customer: {
    code: string;
    legalName: string;
    taxId: string | null;
    branchCode: string | null;
    billingAddress: unknown;
  };
};

/** ผู้ออก (นิติบุคคล + สาขาผู้ออก) จากข้อมูลปัจจุบัน — ร่าง / snapshot ตอนออกเลข */
export function issuerParty(row: Pick<PrintRow, 'issuingCompany' | 'issuingBranch'>) {
  return {
    name: row.issuingCompany.legalName,
    taxId: row.issuingCompany.taxId,
    branchCode: row.issuingBranch.branchCode,
    address: addressText(row.issuingBranch.address),
    vatRegistered: row.issuingCompany.vatRegistered,
  };
}

/** ลูกค้า (ผู้ซื้อ) จากข้อมูลปัจจุบัน — สาขาพิมพ์เมื่อมีเลขผู้เสียภาษี */
export function customerParty(row: Pick<PrintRow, 'customer'>) {
  return {
    name: row.customer.legalName,
    taxId: row.customer.taxId,
    branchCode: row.customer.taxId ? row.customer.branchCode : null,
    address: addressText(row.customer.billingAddress),
  };
}

/** ค่าพิมพ์ ณ วันออก (`invoice.print_options`) */
export interface InvoicePrintOptions {
  yearStyle: 'BE' | 'CE';
  whtMinimumAmount: number;
  /** รุ่นแม่แบบ ณ วันออก (`INVOICE_TEMPLATE_VERSION`) */
  templateVersion?: number;
}

function issuedSnapshot(row: {
  customerSnapshot: unknown;
  issuerSnapshot: unknown;
  printOptions: unknown;
}): {
  customer: InvoicePartySnapshot;
  issuer: InvoicePartySnapshot;
  print: InvoicePrintOptions;
} {
  if (!row.customerSnapshot || !row.issuerSnapshot || !row.printOptions)
    throw new ProblemException('invalid_state_transition', undefined, undefined, {
      reason: 'issued_snapshot_missing',
    });
  return {
    customer: row.customerSnapshot as InvoicePartySnapshot,
    issuer: row.issuerSnapshot as InvoicePartySnapshot,
    print: row.printOptions as InvoicePrintOptions,
  };
}

/** ใช้ย้อน transaction ของตัวอย่าง (ไม่ใช่ข้อผิดพลาด) */
const ROLLBACK = Symbol('preview-rollback');
