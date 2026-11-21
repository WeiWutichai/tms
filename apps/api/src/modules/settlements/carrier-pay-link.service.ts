import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { MagicLinkService } from '../links/magic-link.service';
import { linkUrl } from '../messaging/link-kinds';
import { lockKey } from '../master/master-kit';
import { bangkokToday } from '../vehicle-documents/expiry';
import {
  CARRIER_PAY_LINK_TTL_DAYS,
  type CarrierPayLinkDto,
  type CarrierPayLinkViewDto,
  type CarrierPaySettlementDto,
  type CarrierPayTripDto,
} from './carrier-pay-link.dto';
import { SettlementsService } from './settlements.service';

export const PAY_LINK_PURPOSE = 'carrier_pay' as const;
export const PAY_LINK_ENTITY = 'carrier' as const;
export const PAY_LINK_ACTIONS = { view: 'pay.view' } as const;
export const PAY_LINK_REVOKE_REASON = 'ออกลิงก์ค่าเที่ยวใหม่ — ลิงก์เดิมใช้ไม่ได้แล้ว';

/** สถานะใบที่รถร่วมเห็น (ร่าง = ภายใน · ยกเลิก = ไม่มีผล) */
const VISIBLE = ['SENT_TO_CARRIER', 'DISPUTED', 'APPROVED', 'PAID'];
const UNPAID_MAX = 30;
const PAID_MAX = 24;
const TRIPS_MAX = 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * ลิงก์ "ค่าเที่ยวของฉัน" ของรถร่วม (ST6-T11; docs/04 F7 "คนขับ/รถร่วมดูค่าเที่ยวของตัวเอง" P0 ลิงก์ — ย่อตาม D-54: ไม่มี 50 ทวิ)
 * - magic link (ST1-T06) purpose `carrier_pay`, entity = ผู้รับเหมา, action `pay.view` อย่างเดียว (ดูอย่างเดียว), scope `prices.buy:read`
 * - ออกใหม่ = เพิกถอนลิงก์เดิมที่ยังใช้ได้ของผู้รับเหมา (มีลิงก์ใช้ได้ทีละ 1 — แบบ D-63 "ออกลิงก์ใหม่") · audit
 * - หน้าลิงก์ (ต้นแบบ TMS Subcon แท็บ "การเงิน"): รอรับเงิน + การ์ดงวด (ใบสำคัญจ่ายที่ส่งให้รถร่วมแล้ว) + PDF ใบจ่ายเงินของงวดที่จ่ายแล้ว ·
 *   เที่ยวที่จบแต่ยังไม่เข้างวด [DECISION spec/12 §3] — ข้อมูลของรถร่วมรายนี้เท่านั้น ไม่มีราคาขาย/ลูกค้า/คนขับ
 */
@Injectable()
export class CarrierPayLinkService {
  constructor(
    private readonly db: DbService,
    private readonly links: MagicLinkService,
    private readonly audit: AuditService,
    private readonly settlements: SettlementsService,
  ) {}

  async issue(carrierId: string): Promise<CarrierPayLinkDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const c = await tx.carrier.findFirst({ where: { id: carrierId, deletedAt: null } });
    if (!c) throw new ProblemException('not_found');
    await lockKey(tx, `carrier_pay.links:${c.id}`);
    const old = await tx.magicLink.findMany({
      where: {
        purpose: PAY_LINK_PURPOSE,
        entityType: PAY_LINK_ENTITY,
        entityId: c.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    for (const o of old)
      await this.links.revoke(tx, o.id, PAY_LINK_REVOKE_REASON, ctx.actorId ?? undefined);
    const l = await this.links.issue(tx, ctx.tenantId!, {
      purpose: PAY_LINK_PURPOSE,
      entityType: PAY_LINK_ENTITY,
      entityId: c.id,
      actions: [PAY_LINK_ACTIONS.view],
      scopes: ['prices.buy:read'],
      ttlSeconds: CARRIER_PAY_LINK_TTL_DAYS * 86_400,
      ...(ctx.actorId ? { createdBy: ctx.actorId } : {}),
    });
    await this.audit.record({
      action: 'carrier.pay_link_issued',
      entityType: 'carrier',
      entityId: c.id,
      after: {
        linkId: l.id,
        linkExpiresAt: l.expiresAt.toISOString(),
        revokedLinkIds: old.map((o) => o.id),
      },
    });
    return {
      id: encodeId('magicLink', l.id),
      url: linkUrl('carrier_pay', l),
      expiresAt: l.expiresAt.toISOString(),
    };
  }

  /** ผู้รับเหมาของลิงก์ (ลบแล้ว = ลิงก์ใช้ไม่ได้ 404) */
  private async carrier(carrierId: string) {
    const c = await this.db.tx.carrier.findFirst({
      where: { id: carrierId, deletedAt: null },
      select: { id: true, legalName: true, paymentTermDays: true },
    });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  async view(carrierId: string, linkId: string): Promise<CarrierPayLinkViewDto> {
    const tx = this.db.tx;
    const c = await this.carrier(carrierId);
    const link = await tx.magicLink.findUniqueOrThrow({ where: { id: linkId } });
    const since = new Date(`${bangkokToday()}T00:00:00.000Z`);
    since.setUTCFullYear(since.getUTCFullYear() - 1);
    const select = {
      id: true,
      status: true,
      settlementNo: true,
      periodFrom: true,
      periodTo: true,
      netPayable: true,
      whtAmount: true,
      paidDate: true,
      lines: {
        where: { voidedAt: null, lineType: { not: 'DEDUCTION' } },
        select: { tripId: true },
      },
    } satisfies Prisma.CarrierSettlementSelect;
    const [tenant, unpaid, paid] = await Promise.all([
      tx.tenant.findFirst({ select: { name: true } }),
      tx.carrierSettlement.findMany({
        where: { carrierId: c.id, status: { in: VISIBLE.filter((s) => s !== 'PAID') } },
        orderBy: [{ periodTo: 'desc' }, { id: 'desc' }],
        take: UNPAID_MAX,
        select,
      }),
      tx.carrierSettlement.findMany({
        where: { carrierId: c.id, status: 'PAID', paidDate: { gte: since } },
        orderBy: [{ paidDate: 'desc' }, { periodTo: 'desc' }, { id: 'desc' }],
        take: PAID_MAX,
        select,
      }),
    ]);
    const settlements: CarrierPaySettlementDto[] = [];
    for (const s of [...unpaid, ...paid]) {
      const frozen = s.whtAmount !== null;
      // ใบที่ยังไม่ตรึง หัก ณ ที่จ่าย (รอตรวจ) → ประมาณการจากสูตรเดียวกับหน้าใบ (`SettlementsService.get`)
      const amount = frozen
        ? s.netPayable.minus(s.whtAmount!).toFixed(2)
        : await this.settlements.get(s.id).then((d) => d.buyNetAfterWht ?? s.netPayable.toFixed(2));
      settlements.push({
        id: encodeId('settlement', s.id),
        settlementNo: s.settlementNo,
        // DISPUTED = รอตรวจ (ไม่เผยธงภายใน — ป้ายรายบรรทัดอยู่ที่ลิงก์ตรวจใบ ST6-T05)
        status: s.status === 'DISPUTED' ? 'SENT_TO_CARRIER' : s.status,
        periodFrom: ymd(s.periodFrom),
        periodTo: ymd(s.periodTo),
        tripCount: new Set(s.lines.map((l) => l.tripId).filter(Boolean)).size,
        amount,
        estimate: !frozen,
        paidDate: s.paidDate ? ymd(s.paidDate) : null,
      });
    }
    const due = settlements
      .filter((s) => s.status !== 'PAID')
      .reduce((a, s) => a.plus(s.amount), new Prisma.Decimal(0));
    return {
      company: tenant?.name ?? '',
      carrierName: c.legalName,
      paymentTermDays: c.paymentTermDays,
      dueAmount: due.toFixed(2),
      dueCount: settlements.filter((s) => s.status !== 'PAID').length,
      settlements,
      trips: await this.openTrips(c.id),
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /**
   * เที่ยวที่จบแล้ว (COMPLETED / COSTED / SETTLED) ของรถร่วมรายนี้ ที่ยังมีค่าจ้างไม่อยู่ในงวดที่รถร่วมเห็น
   * ค่าจ้าง = Σ `trip_cost` CONFIRMED ของรถร่วมรายนี้ที่ไม่อยู่ในบรรทัดที่ยังใช้ของใบ SENT/DISPUTED/APPROVED/PAID
   * (คู่กลับรายการหักล้างกันในผลรวม) · เที่ยวที่อยู่ในงวดครบแล้วไม่ขึ้น
   */
  private async openTrips(carrierId: string): Promise<CarrierPayTripDto[]> {
    const tx = this.db.tx;
    const rows = await tx.$queryRaw<
      { id: string; trip_no: string | null; trip_date: Date; open: Prisma.Decimal }[]
    >`
      WITH t AS (
        SELECT id, trip_no, trip_date, completed_at FROM trip
         WHERE carrier_id = ${carrierId}::uuid AND status IN ('COMPLETED', 'COSTED', 'SETTLED')
      ),
      c AS (
        SELECT tc.trip_id, tc.amount,
               (cs.status IS NOT NULL AND cs.status = ANY(${VISIBLE}::text[])) AS shown
          FROM trip_cost tc
          JOIN t ON t.id = tc.trip_id
          LEFT JOIN settlement_line sl ON sl.id = tc.settlement_line_id AND sl.voided_at IS NULL
          LEFT JOIN carrier_settlement cs ON cs.id = sl.settlement_id
         WHERE tc.carrier_id = ${carrierId}::uuid AND tc.status = 'CONFIRMED'
      )
      SELECT t.id::text AS id, t.trip_no, t.trip_date,
             COALESCE(SUM(c.amount) FILTER (WHERE NOT c.shown), 0) AS open
        FROM t LEFT JOIN c ON c.trip_id = t.id
       GROUP BY t.id, t.trip_no, t.trip_date, t.completed_at
      HAVING NOT COALESCE(bool_or(c.shown), false)
          OR COALESCE(SUM(c.amount) FILTER (WHERE NOT c.shown), 0) <> 0
       ORDER BY t.completed_at DESC NULLS LAST, t.trip_date DESC, t.trip_no DESC NULLS LAST
       LIMIT ${TRIPS_MAX}`;
    if (!rows.length) return [];
    const stops = await tx.tripStop.findMany({
      where: { tripId: { in: rows.map((r) => r.id) }, removedAt: null },
      orderBy: { sequence: 'asc' },
      select: { tripId: true, site: { select: { name: true } } },
    });
    const by = new Map<string, string[]>();
    for (const s of stops) {
      const list = by.get(s.tripId) ?? [];
      if (s.site?.name) list.push(s.site.name);
      by.set(s.tripId, list);
    }
    return rows.map((r) => {
      const names = by.get(r.id) ?? [];
      return {
        tripNo: r.trip_no,
        tripDate: ymd(r.trip_date),
        origin: names[0] ?? null,
        destination: names.length > 1 ? names[names.length - 1]! : null,
        amount: new Prisma.Decimal(r.open).toFixed(2),
      };
    });
  }

  /** ใบของรถร่วมรายนี้ที่จ่ายแล้ว (PDF ใบจ่ายเงิน) — ใบของรายอื่น/ยังไม่จ่าย = 404 (ไม่บอกใบ้) */
  async paidSettlement(carrierId: string, settlementId: string): Promise<string> {
    // route PDF ไม่มี transaction ของคำขอ (render นอก transaction) → อ่านใน transaction สั้นของ tenant ลิงก์
    const s = await this.db.withTenant(requestContext.require().tenantId!, (tx) =>
      tx.carrierSettlement.findFirst({
        where: { id: settlementId, carrierId, status: 'PAID', carrier: { deletedAt: null } },
        select: { id: true },
      }),
    );
    if (!s) throw new ProblemException('not_found');
    return s.id;
  }
}
