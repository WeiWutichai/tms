import { Injectable } from '@nestjs/common';
import { taxOptionsFromSettings, type ServiceItemVatType } from '@tms/domain';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { decodeIdOr404 } from '../../common/ids';
import { readSettings } from '../settings/settings.service';
import type { CreateInvoiceDto } from './invoice.dto';
import { InvoicesService } from './invoices.service';
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
  async loadModel(tx: Tx, id: string): Promise<{ status: string; model: InvoicePrintModel }> {
    const inv = await this.invoices.get(id, tx);
    const row = await tx.invoice.findUniqueOrThrow({
      where: { id },
      include: {
        issuingCompany: true,
        issuingBranch: true,
        customer: true,
        lines: {
          where: { active: true },
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
    const tenant = await tx.tenant.findFirst({ select: { yearStyle: true } });
    const settings = await readSettings(tx, requestContext.require().tenantId!, [
      'tax.whtMinimumAmount',
    ]);
    const plate = new Map<string, string | null>();
    for (const l of row.lines)
      if (l.deliveryOrder?.doNo)
        plate.set(
          l.deliveryOrder.doNo,
          l.deliveryOrder.trip?.vehiclePlateSnapshot ??
            l.deliveryOrder.trip?.vehicle?.plate ??
            null,
        );
    const issueDate = todayBkk();
    return {
      status: inv.status,
      model: {
        yearStyle: tenant?.yearStyle === 'CE' ? 'CE' : 'BE',
        invoiceNo: inv.invoiceNo,
        copy: inv.invoiceNo ? 'ORIGINAL' : null,
        issueDate,
        dueDate: addDays(issueDate, inv.creditTermDays),
        issuer: {
          name: row.issuingCompany.legalName,
          taxId: row.issuingCompany.taxId,
          branchCode: row.issuingBranch.branchCode,
          address: addressText(row.issuingBranch.address),
          vatRegistered: row.issuingCompany.vatRegistered,
        },
        customer: {
          name: row.customer.legalName,
          taxId: row.customer.taxId,
          branchCode: row.customer.taxId ? row.customer.branchCode : null,
          address: addressText(row.customer.billingAddress),
        },
        periodFrom: inv.periodFrom,
        periodTo: inv.periodTo,
        creditTermDays: inv.creditTermDays,
        customerPoNo: inv.customerPoNo,
        note: inv.note,
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
          taxOptionsFromSettings({
            whtMinimumAmount: settings['tax.whtMinimumAmount'] as number,
          }),
        ),
      },
    };
  }
}

/** ใช้ย้อน transaction ของตัวอย่าง (ไม่ใช่ข้อผิดพลาด) */
const ROLLBACK = Symbol('preview-rollback');
