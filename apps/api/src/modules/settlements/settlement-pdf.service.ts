import { Injectable } from '@nestjs/common';
import { tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import type { FinanceParty } from '../../pdf/finance-document';
import { resolvePayer, type PayerSnapshot } from './settlement-payer';
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { bangkokToday } from '../vehicle-documents/expiry';
import type { DeductionType, SettlementDto } from './settlement.dto';
import {
  settlementVoucherDocument,
  sumDecimal,
  type SettlementPrintModel,
  type SettlementPrintTrip,
} from './settlement-pdf.template';
import { SettlementsService } from './settlements.service';

/** ผู้จ่ายบนใบ — ต้นแบบ #pv แสดงชื่อ + สาขา + เลขผู้เสียภาษี (ไม่แสดงที่อยู่ แม้ snapshot เก็บไว้) */
const payerParty = (p: PayerSnapshot): FinanceParty => ({
  name: p.name,
  taxId: p.taxId,
  branchCode: p.branchCode,
  address: '',
});

/** ลำดับชนิดบรรทัดหักบนเส้นรวม (ตาม DEDUCTION_TYPES) */
const DEDUCTION_ORDER: DeductionType[] = ['CASH_ADVANCE', 'FUEL_PROVIDED', 'FINE', 'DAMAGE'];

/**
 * PDF ใบสำคัญจ่ายรถร่วม (ST6-T04) — render ตามคำขอ (ไม่ใช่เอกสารภาษี — docs/04 "เก็บ PDF ณ วันออก" ใช้กับเอกสารภาษี; spec/12 §3)
 * ข้อมูลอ่านใน transaction สั้นแล้ว render นอก transaction (แบบใบแจ้งหนี้ ST5-T08)
 * **ตัวเลขทุกตัวมาจาก `SettlementsService.get`** (DTO เดียวกับ `GET /v1/settlements/{id}`) — ยอดบน PDF = API โดยโครงสร้าง ·
 * ใบที่อนุมัติแล้วใช้ยอด WHT ที่ตรึง (`wht_amount`) · สุทธิ = `buyNetAfterWht`
 */
/** เปลี่ยนเมื่อแม่แบบเปลี่ยน (key ของ cache) */
export const SETTLEMENT_PDF_TEMPLATE_VERSION = 2; // 2: เส้นทาง "→" → "–" (Sarabun ไม่มี "→" — spec/12 §3)
const PDF_CACHE_TTL_MS = 10 * 60_000;
const PDF_CACHE_MAX = 50;

@Injectable()
export class SettlementPdfService {
  private readonly cache = new Map<string, { pdf: Buffer; at: number }>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  constructor(
    private readonly db: DbService,
    private readonly renderer: PdfRenderer,
    private readonly settlements: SettlementsService,
  ) {}

  /**
   * @param id uuid ของใบ
   * @param onlyPaid ลิงก์รถร่วม: ต้นแบบ TMS Subcon มีปุ่ม "ใบจ่ายเงิน" เฉพาะงวดที่จ่ายแล้ว → ใบที่ยังไม่จ่าย 409
   */
  async render(
    id: string,
    onlyPaid = false,
  ): Promise<{ model: SettlementPrintModel; dto: SettlementDto; pdf: Buffer }> {
    const ctx = requestContext.require();
    const { model, dto } = await this.db.withTenant(ctx.tenantId!, async (tx: Tx) => {
      ctx.tx = tx as never;
      try {
        return await this.loadModel(tx, id, onlyPaid);
      } finally {
        ctx.tx = undefined;
      }
    });
    // review M1: ใบ PAID = สิ้นสุด (ข้อมูลบนใบไม่เปลี่ยน) → render ครั้งเดียวต่อ (ใบ, version, แม่แบบ) แล้วใช้ซ้ำ ·
    // คำขอพร้อมกันรอผล render เดียวกัน — ไม่ให้ลิงก์เดียวกินคิว Chromium ที่ใช้ร่วมทุก tenant
    if (dto.status !== 'PAID')
      return { model, dto, pdf: await this.renderer.pdf(settlementVoucherDocument(model)) };
    const key = `${id}:${dto.version}:t${SETTLEMENT_PDF_TEMPLATE_VERSION}`;
    const hit = this.cache.get(key);
    if (hit && hit.at > Date.now() - PDF_CACHE_TTL_MS) return { model, dto, pdf: hit.pdf };
    let job = this.inflight.get(key);
    if (!job) {
      job = this.renderer
        .pdf(settlementVoucherDocument(model))
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    const pdf = await job;
    this.cache.delete(key);
    this.cache.set(key, { pdf, at: Date.now() });
    while (this.cache.size > PDF_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return { model, dto, pdf };
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
    const tenant = await tx.tenant.findFirst({ select: { yearStyle: true } });
    const yearStyle = tenant?.yearStyle === 'CE' ? 'CE' : 'BE';

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
      },
    };
  }
}
