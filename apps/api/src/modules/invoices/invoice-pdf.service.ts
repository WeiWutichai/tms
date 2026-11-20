import { Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/problem';
import { docDate, docDateShort } from '../../common/thai-date';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { escapeHtml, PdfRenderer, type RenderOptions } from '../../pdf/pdf-renderer';
import { decodeIdOr404 } from '../../common/ids';
import type { CreateInvoiceDto, InvoiceDto } from './invoice.dto';
import { InvoicesService } from './invoices.service';

/** "1234.5" → "1,234.50" */
function baht(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  const [w, f = '00'] = v.split('.') as [string, string?];
  const neg = w.startsWith('-');
  const digits = (neg ? w.slice(1) : w).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}${digits}.${(f + '00').slice(0, 2)}`;
}

const VAT_TH: Record<string, string> = {
  EXEMPT_TRANSPORT: 'ยกเว้น',
  VAT_7: '7%',
  ZERO_RATED: '0%',
};

export interface ProformaParty {
  name: string;
  taxId: string | null;
  branch: string;
  address: string;
}

export interface ProformaDoc {
  yearStyle: 'BE' | 'CE';
  issuedOn: Date;
  issuer: ProformaParty;
  customer: ProformaParty;
  inv: InvoiceDto;
}

const branchLabel = (code: string | null) =>
  !code ? '' : code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`;

function addressText(a: unknown): string {
  if (!a || typeof a !== 'object') return '';
  const o = a as Record<string, unknown>;
  return ['line1', 'line2', 'subdistrict', 'district', 'province', 'postcode']
    .map((k) => o[k])
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join(' ');
}

const CSS = `
@page{size:A4;margin:0}
body{margin:0;font-family:'Sarabun',sans-serif;color:#101418;font-size:12px;line-height:1.5}
.page{position:relative;padding:14mm 14mm 16mm;min-height:269mm;box-sizing:border-box}
.wm{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:96px;font-weight:700;color:rgba(179,50,42,.10);transform:rotate(-24deg);letter-spacing:8px}
.hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #13213F;padding-bottom:10px}
.hd h1{margin:0;font-size:22px;font-weight:700;color:#13213F}
.hd .sub{color:#8F5500;font-weight:600}
.muted{color:#59606B}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.box{border:1px solid #D9DCD4;border-radius:6px;padding:8px 10px}
.box b{display:block;font-size:12.5px}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{background:#EEF0EC;font-weight:600;text-align:left;padding:5px 6px;border-bottom:1px solid #CDD1C8;font-size:11.5px}
td{padding:5px 6px;border-bottom:1px solid #E4E6E0;vertical-align:top}
.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tot{margin-left:auto;width:62%;margin-top:10px}
.tot td{border:0;padding:3px 6px}
.tot .g td{border-top:1px solid #13213F;font-weight:700;font-size:13px}
.note{margin-top:14px;padding:8px 10px;background:#FCF0DC;border-radius:6px;color:#3B424C;font-size:11px}
`;

/** HTML ของ PDF ตัวอย่าง (pro forma) — **ไม่มีคำว่า "ใบกำกับภาษี"** ไม่มีเลข มีลายน้ำ "ร่าง" · แบบเต็มตามต้นแบบ TMS Print = ST5-T08 */
export function proformaHtml(d: ProformaDoc): string {
  const { inv } = d;
  const e = escapeHtml;
  const party = (title: string, p: ProformaParty) =>
    `<div class="box"><span class="muted">${title}</span><b>${e(p.name)}</b>` +
    (p.taxId ? `<div>เลขประจำตัวผู้เสียภาษี ${e(p.taxId)} ${e(p.branch)}</div>` : '') +
    (p.address ? `<div>${e(p.address)}</div>` : '') +
    `</div>`;
  const period =
    inv.periodFrom && inv.periodTo
      ? `${docDateShort(inv.periodFrom, d.yearStyle)} – ${docDateShort(inv.periodTo, d.yearStyle)}`
      : '—';
  const rows = inv.printLines
    .map(
      (p) =>
        `<tr><td>${p.no}</td><td>${e(p.description)}` +
        (p.deliveryOrderNos.length
          ? `<div class="muted">${e(p.deliveryOrderNos.join(', '))}</div>`
          : '') +
        `</td><td class="r">${p.quantity ?? ''} ${e(p.unitLabel ?? '')}</td>` +
        `<td class="r">${baht(p.sellUnitPrice)}</td>` +
        `<td class="r">${p.sellDiscount && p.sellDiscount !== '0.00' ? baht(p.sellDiscount) : ''}</td>` +
        `<td>${VAT_TH[p.vatType] ?? e(p.vatType)}</td>` +
        `<td class="r">${baht(p.sellAmount)}</td></tr>`,
    )
    .join('');
  const tot = (label: string, v: string | undefined, cls = '') =>
    `<tr class="${cls}"><td>${label}</td><td class="r">${baht(v)}</td></tr>`;
  return (
    `<div class="page"><div class="wm">ร่าง</div>` +
    `<div class="hd"><div><b style="font-size:14px">${e(d.issuer.name)}</b>` +
    (d.issuer.taxId
      ? `<div class="muted">เลขประจำตัวผู้เสียภาษี ${e(d.issuer.taxId)} ${e(d.issuer.branch)}</div>`
      : '') +
    (d.issuer.address ? `<div class="muted">${e(d.issuer.address)}</div>` : '') +
    `</div><div style="text-align:right"><h1>ใบแจ้งหนี้</h1><div class="sub">ร่าง · ตัวอย่างก่อนออกเอกสาร (ยังไม่มีเลขที่)</div>` +
    `<div>วันที่พิมพ์ ${docDate(d.issuedOn, d.yearStyle)}</div></div></div>` +
    `<div class="parties">${party('ลูกค้า', d.customer)}` +
    `<div class="box"><span class="muted">งวด</span><b>${period}</b>` +
    `<div>เครดิต ${inv.creditTermDays} วัน</div>` +
    (inv.customerPoNo ? `<div>เลขที่ PO ลูกค้า ${e(inv.customerPoNo)}</div>` : '') +
    `<div>จำนวน DO ${inv.deliveryOrderCount} รายการ</div></div></div>` +
    `<table><thead><tr><th>#</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคาต่อหน่วย</th>` +
    `<th class="r">ส่วนลด</th><th>VAT</th><th class="r">จำนวนเงิน (บาท)</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<table class="tot"><tbody>` +
    tot('ยอดยกเว้น VAT', inv.sellSubtotalExempt) +
    (inv.sellSubtotalVatable !== '0.00' ? tot('ฐาน VAT 7%', inv.sellSubtotalVatable) : '') +
    (inv.sellSubtotalZeroRated !== '0.00' ? tot('ฐาน VAT 0%', inv.sellSubtotalZeroRated) : '') +
    (inv.sellVatAmount !== '0.00' ? tot('VAT 7% (ประมาณการ)', inv.sellVatAmount) : '') +
    tot('รวมทั้งสิ้น', inv.sellTotal, 'g') +
    (inv.sellWhtExpected !== '0.00'
      ? tot('หัก ณ ที่จ่ายที่คาดว่าจะถูกหัก (ประมาณการ)', inv.sellWhtExpected) +
        tot('ยอดชำระสุทธิโดยประมาณ', inv.sellNetExpected)
      : '') +
    `</tbody></table>` +
    (inv.note ? `<div class="box" style="margin-top:12px">${e(inv.note)}</div>` : '') +
    `<div class="note">เอกสารร่างสำหรับตรวจทาน — ยังไม่ใช่เอกสารที่ออกจริง ยอดภาษีเป็นประมาณการ</div>` +
    `</div>`
  );
}

/** RenderOptions ของ PDF ตัวอย่าง (pro forma) — ใช้ทั้ง service และ test ฟอนต์ไทย (test/pdf-thai.test.ts KINDS) */
export function proformaDocument(d: ProformaDoc): RenderOptions {
  return { body: proformaHtml(d), css: CSS, title: 'ใบแจ้งหนี้ (ร่าง)' };
}

/**
 * PDF ตัวอย่างของร่างใบแจ้งหนี้ (ST5-T07 "pro forma PDF อัปเดตตามแก้") — render ใหม่ทุกครั้ง ไม่เก็บไฟล์ (ร่างไม่ใช่เอกสาร)
 * ไม่ถือ transaction ระหว่าง render (แบบใบคุมรถ ST3-T20) · แบบเต็ม/golden ของใบที่ออกแล้ว = ST5-T08
 */
@Injectable()
export class InvoicePdfService {
  constructor(
    private readonly db: DbService,
    private readonly renderer: PdfRenderer,
    private readonly invoices: InvoicesService,
  ) {}

  /** อ่านร่าง + ผู้ออก/ลูกค้า ใน transaction สั้น แล้ว render นอก transaction */
  async proforma(id: string): Promise<{ doc: ProformaDoc; pdf: Buffer }> {
    const ctx = requestContext.require();
    const doc = await this.db.withTenant(ctx.tenantId!, async (tx: Tx) => {
      ctx.tx = tx as never;
      try {
        return await this.loadDoc(tx, id);
      } finally {
        ctx.tx = undefined;
      }
    });
    if (doc.inv.status !== 'DRAFT')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: doc.inv.status,
      });
    return { doc, pdf: await this.render(doc) };
  }

  /**
   * review M2: PDF ตัวอย่างจาก DO ที่ติ๊ก **โดยไม่บันทึกอะไร** — สร้างร่าง (รวมส่งบัญชี) ด้วยกติกาเดียวกับ `POST /invoices`
   * ใน transaction แล้วย้อนทั้งหมด (rollback) ก่อน render — ไม่มีร่าง/การส่งบัญชี/audit ค้าง
   */
  async preview(body: CreateInvoiceDto): Promise<{ doc: ProformaDoc; pdf: Buffer }> {
    const ctx = requestContext.require();
    let doc: ProformaDoc | null = null;
    try {
      await this.db.withTenant(ctx.tenantId!, async (tx: Tx) => {
        ctx.tx = tx as never;
        try {
          const inv = await this.invoices.create({ ...body, releaseDeliveryOrders: true });
          doc = await this.loadDoc(tx, decodeIdOr404('invoice', inv.id));
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

  private render(doc: ProformaDoc) {
    return this.renderer.pdf(proformaDocument(doc));
  }

  private async loadDoc(tx: Tx, id: string): Promise<ProformaDoc> {
    const inv = await this.invoices.get(id, tx);
    const row = await tx.invoice.findUniqueOrThrow({
      where: { id },
      include: { issuingCompany: true, issuingBranch: true, customer: true },
    });
    const tenant = await tx.tenant.findFirst({ select: { yearStyle: true } });
    return {
      yearStyle: (tenant?.yearStyle === 'CE' ? 'CE' : 'BE') as 'BE' | 'CE',
      issuedOn: new Date(),
      issuer: {
        name: row.issuingCompany.legalName,
        taxId: row.issuingCompany.taxId,
        branch: branchLabel(row.issuingBranch.branchCode),
        address: addressText(row.issuingBranch.address),
      },
      customer: {
        name: row.customer.legalName,
        taxId: row.customer.taxId,
        branch: branchLabel(row.customer.branchCode),
        address: addressText(row.customer.billingAddress),
      },
      inv,
    };
  }
}

/** ใช้ย้อน transaction ของตัวอย่าง (ไม่ใช่ข้อผิดพลาด) */
const ROLLBACK = Symbol('preview-rollback');
