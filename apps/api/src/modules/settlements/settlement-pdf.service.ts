import { Injectable } from '@nestjs/common';
import { tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import type { FinanceParty } from '../../pdf/finance-document';
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { bangkokToday } from '../vehicle-documents/expiry';
import type { DeductionType, SettlementDto } from './settlement.dto';
import {
  settlementVoucherDocument,
  sumDecimal,
  type SettlementPrintModel,
} from './settlement-pdf.template';
import { SettlementsService } from './settlements.service';

/** ลำดับชนิดบรรทัดหักบนเส้นรวม (ตาม DEDUCTION_TYPES) */
const DEDUCTION_ORDER: DeductionType[] = ['CASH_ADVANCE', 'FUEL_PROVIDED', 'FINE', 'DAMAGE'];

/**
 * PDF ใบสำคัญจ่ายรถร่วม (ST6-T04) — render ตามคำขอ (ไม่ใช่เอกสารภาษี — docs/04 "เก็บ PDF ณ วันออก" ใช้กับเอกสารภาษี; spec/12 §3)
 * ข้อมูลอ่านใน transaction สั้นแล้ว render นอก transaction (แบบใบแจ้งหนี้ ST5-T08)
 * **ตัวเลขทุกตัวมาจาก `SettlementsService.get`** (DTO เดียวกับ `GET /v1/settlements/{id}`) — ยอดบน PDF = API โดยโครงสร้าง ·
 * ใบที่อนุมัติแล้วใช้ยอด WHT ที่ตรึง (`wht_amount`) · สุทธิ = `buyNetAfterWht`
 */
@Injectable()
export class SettlementPdfService {
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
    return { model, dto, pdf: await this.renderer.pdf(settlementVoucherDocument(model)) };
  }

  async loadModel(
    tx: Tx,
    id: string,
    onlyPaid = false,
  ): Promise<{ model: SettlementPrintModel; dto: SettlementDto }> {
    const dto = await this.settlements.get(id);
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
      select: { payingCompanyId: true },
    });
    const tenant = await tx.tenant.findFirst({ select: { yearStyle: true, name: true } });
    const yearStyle = tenant?.yearStyle === 'CE' ? 'CE' : 'BE';

    // แถวต่อเที่ยว (ลำดับตามบรรทัดแรกของเที่ยว): ค่าเที่ยว = Σ FREIGHT · ค่าใช้จ่ายหน้างาน = Σ SURCHARGE
    const rows = tripIds.map((tid) => {
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
        route: first ? (last ? `${first} → ${last}` : first) : null,
        tripFee: sum('FREIGHT'),
        siteExpenses: sum('SURCHARGE'),
        driver: t.driverNameSnapshot,
      };
    });
    const drivers = new Set(rows.map((r) => r.driver));
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
        payer: await this.payer(tx, row.payingCompanyId, tenant?.name ?? ''),
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

  /**
   * ผู้จ่าย = "จ้างในนาม" ของใบ (ไม่ตั้ง = บริษัทแรกของ tenant) · สาขา = สาขาผู้ออกตั้งต้น → สำนักงานใหญ่ (กติกาเดียวกับผู้ออกใบแจ้งหนี้)
   * ไม่มีนิติบุคคลเลย = ชื่อ tenant (ไม่มีเลขผู้เสียภาษี)
   */
  private async payer(tx: Tx, companyId: string | null, tenantName: string): Promise<FinanceParty> {
    const co = await tx.company.findFirst({
      where: companyId ? { id: companyId } : { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!co) return { name: tenantName, taxId: null, branchCode: null, address: '' };
    const branches = await tx.branch.findMany({
      where: { companyId: co.id },
      orderBy: { branchCode: 'asc' },
    });
    const b =
      branches.find((x) => x.isDefaultIssuer) ?? branches.find((x) => x.branchCode === '00000');
    // ต้นแบบ #pv ไม่แสดงที่อยู่ผู้จ่าย (ชื่อ + สาขา + เลขผู้เสียภาษีเท่านั้น)
    return { name: co.legalName, taxId: co.taxId, branchCode: b?.branchCode ?? null, address: '' };
  }
}
