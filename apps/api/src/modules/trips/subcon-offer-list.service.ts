import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../../common/clock';
import { DbService } from '../../db/db.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { decodeCursor, toPage } from '../../common/pagination';
import { OFFER_TTL_MS, offerDeadline } from './offer-links';
import {
  type SubconOfferListQuery,
  type SubconOfferListStatus,
  type SubconOfferPageDto,
  type SubconOfferRowDto,
  type SubconOfferSummaryDto,
} from './subcon-offer-list.dto';

const NONE = '00000000-0000-0000-0000-000000000000';

/**
 * หน้า "จ่ายงานรถร่วม" (`/sub` — ต้นแบบ TMS v4 `specSub`/`kpisX('sub')`) — รายการการจ้างรถร่วมข้ามเที่ยว
 * [DECISION — lead 24 พ.ย. 2569 เพื่อ UAT, ย้อนได้ — spec/12 §3 แถว "หน้า /sub"]
 * - **หนึ่งแถวต่อเที่ยว = การจ้างล่าสุดของเที่ยว** (ต้นแบบหนึ่งแถวต่องาน) — การจ้างเดิมที่ถูกแทน (ส่งรายถัดไป/เปลี่ยนผู้รับเหมา/
 *   ปฏิเสธแล้วจ้างใหม่) ดูได้ที่ประวัติของเที่ยว (`GET /trips/{id}/offers`) · การจ้างล่าสุดที่ถูกถอน (WITHDRAWN — ยกเลิกเที่ยว/งาน) ไม่แสดง
 * - EXPIRED = ปิดเป็น EXPIRED แล้ว หรือรอตอบที่ลิงก์หมดอายุแล้ว (job ยังไม่ปิด — นิยามเดียวกับ `SubconOfferService.expired`)
 */
@Injectable()
export class SubconOfferListService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  /**
   * การจ้างล่าสุดของแต่ละเที่ยวที่ยังไม่ถูกถอน + สถานะที่แสดง (`st`) + แสดงในรายการ/ตัวนับไหม (`vis`)
   * - หมดเวลา = รอตอบที่เลยเวลาหมดอายุ (`offerDeadline`: `expires_at` หรือเวลาเสนอ + 48 ชม.) หรือปิดเป็น EXPIRED แล้ว
   * - `vis` (review M1 — งานที่ยังต้องดูแล): รอตอบ = เสมอ · ปฏิเสธ/หมดเวลา = เที่ยวยังรอจัด (PLANNING/OFFERED — ยังไม่จัดรถบริษัท/ยกเลิก/จ้างใหม่) ·
   *   รับงาน = เที่ยวยังไม่จบ/ไม่ยกเลิก (ไม่ใช่ COMPLETED/COSTED/SETTLED/CANCELLED)
   */
  private latest(now: Date) {
    const ttl = `${OFFER_TTL_MS / 1000} seconds`;
    return Prisma.sql`
      l0 AS (
        SELECT o.id, o.trip_id, o.carrier_id, o.updated_at, o.buy_amount, t.status::text AS trip_status,
               CASE WHEN o.status = 'OFFERED'
                         AND COALESCE(o.expires_at, o.offered_at + ${ttl}::interval) <= ${now}::timestamptz
                    THEN 'EXPIRED' ELSE o.status::text END AS st
          FROM subcon_offer o
          JOIN trip t ON t.id = o.trip_id
         WHERE o.status <> 'WITHDRAWN'
           AND NOT EXISTS (
             SELECT 1 FROM subcon_offer n
              WHERE n.trip_id = o.trip_id
                AND (n.offered_at, n.id) > (o.offered_at, o.id))
      ),
      l AS (
        SELECT l0.*,
               CASE l0.st
                 WHEN 'OFFERED' THEN true
                 WHEN 'ACCEPTED' THEN l0.trip_status NOT IN ('COMPLETED', 'COSTED', 'SETTLED', 'CANCELLED')
                 ELSE l0.trip_status IN ('PLANNING', 'OFFERED')
               END AS vis
          FROM l0
      )`;
  }

  async list(q: SubconOfferListQuery): Promise<SubconOfferPageDto> {
    const tx = this.db.tx;
    const now = this.clock.now();
    const conds: Prisma.Sql[] = [Prisma.sql`l.vis`];
    if (q.status) conds.push(Prisma.sql`l.st = ANY(${q.status.split(',')}::text[])`);
    if (q.carrierId !== undefined)
      conds.push(Prisma.sql`l.carrier_id = ${tryDecodeId('carrier', q.carrierId) ?? NONE}::uuid`);
    const limit = q.limit ?? 50;
    const desc = q.sort === '-updatedAt';
    const sort = desc ? '-updatedAt' : 'updatedAt';
    if (q.updatedAfter)
      conds.push(Prisma.sql`l.updated_at > ${new Date(q.updatedAfter)}::timestamptz`);
    if (q.cursor) {
      const c = decodeCursor(q.cursor, sort);
      conds.push(
        desc
          ? Prisma.sql`(l.updated_at, l.id) < (${c.u}::timestamptz, ${c.i}::uuid)`
          : Prisma.sql`(l.updated_at, l.id) > (${c.u}::timestamptz, ${c.i}::uuid)`,
      );
    }
    const order = desc
      ? Prisma.sql`l.updated_at DESC, l.id DESC`
      : Prisma.sql`l.updated_at ASC, l.id ASC`;
    const ids = await tx.$queryRaw<{ id: string; st: SubconOfferListStatus; updated_at: Date }[]>`
      WITH ${this.latest(now)}
      SELECT l.id, l.st, l.updated_at FROM l
       WHERE ${Prisma.join(conds, ' AND ')}
       ORDER BY ${order}
       LIMIT ${limit + 1}`;
    const rows = ids.length
      ? await tx.subconOffer.findMany({
          where: { id: { in: ids.map((r) => r.id) } },
          include: {
            trip: {
              select: {
                id: true,
                tripNo: true,
                tripDate: true,
                status: true,
                stops: {
                  where: { removedAt: null },
                  orderBy: { sequence: 'asc' },
                  select: { site: { select: { name: true } } },
                },
                deliveryOrders: {
                  where: { status: { not: 'CANCELLED' } },
                  orderBy: [{ doNo: 'asc' }],
                  select: { doNo: true },
                },
              },
            },
          },
        })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.flatMap((x) => {
      const r = byId.get(x.id);
      return r ? [{ ...r, st: x.st }] : [];
    });
    const page = toPage(
      ordered,
      { limit, sort },
      (r): SubconOfferRowDto => {
        const stops = r.trip.stops;
        return {
          id: encodeId('subconOffer', r.id),
          tripId: encodeId('trip', r.tripId),
          tripNo: r.trip.tripNo,
          tripDate: r.trip.tripDate.toISOString().slice(0, 10),
          tripStatus: r.trip.status,
          deliveryOrderNos: r.trip.deliveryOrders.flatMap((d) => (d.doNo ? [d.doNo] : [])),
          origin: stops[0]?.site.name ?? null,
          destination: stops.length ? stops[stops.length - 1]!.site.name : null,
          carrierId: encodeId('carrier', r.carrierId),
          carrierName: r.carrierNameSnapshot,
          status: r.st,
          buyAmount: r.buyAmount.toFixed(2),
          sellAmount: r.sellAmount?.toFixed(2) ?? null,
          offeredAt: r.offeredAt.toISOString(),
          expiresAt: offerDeadline(r).toISOString(),
          respondedAt: r.respondedAt?.toISOString() ?? null,
          acceptedPlate: r.acceptedPlate,
          acceptedDriverName: r.acceptedDriverName,
          updatedAt: r.updatedAt.toISOString(),
        };
      },
      q.fields,
    );
    return page as SubconOfferPageDto;
  }

  /** การ์ด KPI — นับด้วยนิยามเดียวกับรายการ (`status=` + `vis`) · ต้นทุนเดือนนี้ = งานรับแล้ว (รวมเที่ยวที่จบแล้ว ไม่รวมยกเลิก) ที่วันที่เที่ยวอยู่ในเดือนนี้ (เวลาไทย) */
  async summary(): Promise<SubconOfferSummaryDto> {
    const tx = this.db.tx;
    const now = this.clock.now();
    const [r] = await tx.$queryRaw<
      {
        offered: number;
        accepted: number;
        rejected: number;
        expired: number;
        cost: Prisma.Decimal | null;
      }[]
    >`
      WITH ${this.latest(now)}
      SELECT count(*) FILTER (WHERE l.vis AND l.st = 'OFFERED')::int AS offered,
             count(*) FILTER (WHERE l.vis AND l.st = 'ACCEPTED')::int AS accepted,
             count(*) FILTER (WHERE l.vis AND l.st = 'REJECTED')::int AS rejected,
             count(*) FILTER (WHERE l.vis AND l.st = 'EXPIRED')::int AS expired,
             sum(l.buy_amount) FILTER (
               WHERE l.st = 'ACCEPTED' AND l.trip_status <> 'CANCELLED'
                 AND date_trunc('month', t.trip_date) = date_trunc('month', (${now}::timestamptz AT TIME ZONE 'Asia/Bangkok')::date)
             ) AS cost
        FROM l JOIN trip t ON t.id = l.trip_id`;
    return {
      offered: r?.offered ?? 0,
      accepted: r?.accepted ?? 0,
      rejected: r?.rejected ?? 0,
      expired: r?.expired ?? 0,
      buyAcceptedThisMonth: new Prisma.Decimal(r?.cost ?? 0).toFixed(2),
    };
  }
}
