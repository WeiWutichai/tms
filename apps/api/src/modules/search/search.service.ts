import { Injectable } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { encodeId } from '../../common/ids';
import { likeEscape } from '../../common/ilike';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { arabicDigits, plateNorm } from '../vehicles/vehicles.service';
import {
  SEARCH_TYPES,
  type SearchHitDto,
  type SearchMatch,
  type SearchResultDto,
  type SearchType,
} from './search.dto';

/** scope ที่ต้องมีต่อชนิด — ตรงกับ GET รายการของชนิดนั้น (ไม่มีสิทธิ์อ่าน = ไม่ค้นชนิดนั้นเลย) */
export const SEARCH_SCOPE: Record<SearchType, string> = {
  order: 'orders:read',
  deliveryOrder: 'orders:read',
  trip: 'trips:read',
  invoice: 'invoices:read',
  billingNote: 'invoices:read',
  customer: 'master:read',
  vehicle: 'master:read',
};

const BLANK = {
  status: null,
  customerName: null,
  customerRef: null,
  plate: null,
  vehicleType: null,
  driverName: null,
  code: null,
  overdue: false,
  orderId: null,
  tripId: null,
} satisfies Omit<SearchHitDto, 'type' | 'id' | 'label' | 'matchedOn'>;

/** อันดับความตรง: ตรงทั้งคำ 0 · ขึ้นต้นด้วย 1 · มีอยู่ 2 · ไม่ตรง 9 (ไม่สนตัวพิมพ์) */
export function matchRank(value: string | null | undefined, needle: string): number {
  if (!value || !needle) return 9;
  const v = value.toLowerCase();
  const n = needle.toLowerCase();
  if (v === n) return 0;
  if (v.startsWith(n)) return 1;
  return v.includes(n) ? 2 : 9;
}

interface Ranked {
  hit: SearchHitDto;
  rank: number;
}

/** เรียงตามอันดับความตรง (stable — แถวเข้ามาเรียงแก้ล่าสุดก่อนแล้ว) แล้วตัดตาม limit */
function top(rows: Ranked[], limit: number): SearchHitDto[] {
  return rows
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.hit);
}

/** ช่องที่ตรงดีที่สุดของแถว (เลขเอกสารก่อน PO เมื่ออันดับเท่ากัน) */
function best(
  needle: string,
  fields: [SearchMatch, string | null | undefined][],
): { on: SearchMatch; rank: number } {
  let on = fields[0]![0];
  let rank = 9;
  for (const [k, v] of fields) {
    const r = matchRank(v, needle);
    if (r < rank) {
      rank = r;
      on = k;
    }
  }
  return { on, rank };
}

/**
 * ค้นหา global ⌘K (ST9-T09; docs/04 I "ค้นหา global (⌘K)", NFR-606/707)
 * - อ่านผ่าน transaction ของคำขอ (RLS ตาม tenant) — ไม่มีทางเห็นข้อมูลบริษัทอื่น/sandbox อื่น
 * - ค้นเฉพาะชนิดที่ผู้เรียกมี scope อ่าน · ไม่ส่งยอดเงิน/ราคาใด ๆ กลับ
 * - ILIKE '%q%' (escape `%`/`_`/`\\`) — ต่อชนิดอ่านย้อนตาม (tenant_id, updated_at, id) แล้วกรอง จนครบ `take`
 *   (index trigram ใช้ไม่ได้ภายใต้ RLS เพราะ ILIKE ไม่ใช่ leakproof — review ST9-T09) · พอสำหรับ 10–200 คัน
 *   ทางเลือกถ้าช้า: btree `text_pattern_ops` สำหรับค้นแบบขึ้นต้น (LIKE 'q%' — ตัวดำเนินการ leakproof)
 * - เลขเอกสาร/PO/รหัสลูกค้า: เลขไทย → อารบิกก่อนค้น (สูตรเดียวกับทะเบียน) · ชื่อลูกค้าค้นตามที่พิมพ์
 * - อันดับ: จัดเฉพาะใน "หน้าต่าง" `take` แถวที่แก้ล่าสุดที่ตรง (limit × 4 ≤ 40 ต่อชนิด) — แถวเก่ากว่านั้นที่ตรงทั้งคำอาจไม่ขึ้น
 */
@Injectable()
export class SearchService {
  constructor(private readonly db: DbService) {}

  allowedTypes(): SearchType[] {
    const scopes = requestContext.get()?.scopes ?? [];
    return SEARCH_TYPES.filter((t) => scopeAllows(scopes, SEARCH_SCOPE[t]));
  }

  async search(qRaw: string, limit = 5): Promise<SearchResultDto> {
    const q = qRaw.trim();
    const types = this.allowedTypes();
    // เลขเอกสาร/PO/รหัส: เลขไทย → อารบิก (ชื่อลูกค้าใช้คำค้นตามที่พิมพ์)
    const qn = arabicDigits(q);
    const like = { contains: likeEscape(qn), mode: 'insensitive' as const };
    const likeName = { contains: likeEscape(q), mode: 'insensitive' as const };
    // หน้าต่างจัดอันดับ: ดึงแถวที่ตรงและแก้ล่าสุด limit × 4 (≤ 40) แล้วจัด "ตรงทั้งคำ/ขึ้นต้น" ก่อน "มีอยู่"
    const take = Math.min(limit * 4, 40);
    const tx = this.db.tx;
    const out: SearchHitDto[] = [];

    for (const type of types) {
      switch (type) {
        case 'order': {
          const rows = await tx.salesOrder.findMany({
            where: { OR: [{ soNo: like }, { customerRef: like }] },
            select: {
              id: true,
              soNo: true,
              status: true,
              customerRef: true,
              customer: { select: { legalName: true } },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take,
          });
          out.push(
            ...top(
              rows.map((r) => {
                const m = best(qn, [
                  ['number', r.soNo],
                  ['po', r.customerRef],
                ]);
                return {
                  rank: m.rank,
                  hit: {
                    ...BLANK,
                    type,
                    id: encodeId('salesOrder', r.id),
                    label: r.soNo,
                    matchedOn: m.on,
                    status: r.status.toLowerCase(),
                    customerName: r.customer?.legalName ?? null,
                    customerRef: r.customerRef,
                  },
                };
              }),
              limit,
            ),
          );
          break;
        }
        case 'deliveryOrder': {
          const rows = await tx.deliveryOrder.findMany({
            where: { OR: [{ doNo: like }, { customerRef: like }] },
            select: {
              id: true,
              doNo: true,
              status: true,
              customerRef: true,
              salesOrderId: true,
              tripId: true,
              customer: { select: { legalName: true } },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take,
          });
          out.push(
            ...top(
              rows.map((r) => {
                const m = best(qn, [
                  ['number', r.doNo],
                  ['po', r.customerRef],
                ]);
                return {
                  rank: m.rank,
                  hit: {
                    ...BLANK,
                    type,
                    id: encodeId('deliveryOrder', r.id),
                    label: r.doNo,
                    matchedOn: m.on,
                    status: r.status,
                    customerName: r.customer.legalName,
                    customerRef: r.customerRef,
                    orderId: encodeId('salesOrder', r.salesOrderId),
                    tripId: r.tripId ? encodeId('trip', r.tripId) : null,
                  },
                };
              }),
              limit,
            ),
          );
          break;
        }
        case 'trip': {
          const rows = await tx.trip.findMany({
            where: { tripNo: like },
            select: { id: true, tripNo: true, status: true, vehiclePlateSnapshot: true },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take,
          });
          out.push(
            ...top(
              rows.map((r) => ({
                rank: matchRank(r.tripNo, qn),
                hit: {
                  ...BLANK,
                  type,
                  id: encodeId('trip', r.id),
                  label: r.tripNo,
                  matchedOn: 'number' as const,
                  status: r.status,
                  plate: r.vehiclePlateSnapshot,
                },
              })),
              limit,
            ),
          );
          break;
        }
        case 'invoice': {
          const rows = await tx.invoice.findMany({
            // ร่างไม่มีเลข — เจอได้จากเลข PO เท่านั้น
            where: { OR: [{ invoiceNo: like }, { customerPoNo: like }] },
            select: {
              id: true,
              invoiceNo: true,
              status: true,
              customerPoNo: true,
              overdueAt: true,
              customer: { select: { legalName: true } },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take,
          });
          out.push(
            ...top(
              rows.map((r) => {
                const m = best(qn, [
                  ['number', r.invoiceNo],
                  ['po', r.customerPoNo],
                ]);
                return {
                  rank: m.rank,
                  hit: {
                    ...BLANK,
                    type,
                    id: encodeId('invoice', r.id),
                    label: r.invoiceNo,
                    matchedOn: m.on,
                    status: r.status,
                    customerName: r.customer.legalName,
                    customerRef: r.customerPoNo,
                    overdue: r.overdueAt != null,
                  },
                };
              }),
              limit,
            ),
          );
          break;
        }
        case 'billingNote': {
          const rows = await tx.billingNote.findMany({
            where: { billingNoteNo: like },
            select: {
              id: true,
              billingNoteNo: true,
              status: true,
              customer: { select: { legalName: true } },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take,
          });
          out.push(
            ...top(
              rows.map((r) => ({
                rank: matchRank(r.billingNoteNo, qn),
                hit: {
                  ...BLANK,
                  type,
                  id: encodeId('billingNote', r.id),
                  label: r.billingNoteNo,
                  matchedOn: 'number' as const,
                  status: r.status,
                  customerName: r.customer.legalName,
                },
              })),
              limit,
            ),
          );
          break;
        }
        case 'customer': {
          const rows = await tx.customer.findMany({
            where: { deletedAt: null, OR: [{ legalName: likeName }, { code: like }] },
            select: { id: true, legalName: true, code: true, status: true },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take,
          });
          out.push(
            ...top(
              rows.map((r) => {
                const name = matchRank(r.legalName, q);
                const code = matchRank(r.code, qn);
                const m =
                  code < name
                    ? { on: 'code' as const, rank: code }
                    : { on: 'name' as const, rank: name };
                return {
                  rank: m.rank,
                  hit: {
                    ...BLANK,
                    type,
                    id: encodeId('customer', r.id),
                    label: r.legalName,
                    matchedOn: m.on,
                    status: r.status.toLowerCase(),
                    code: r.code,
                  },
                };
              }),
              limit,
            ),
          );
          break;
        }
        case 'vehicle': {
          // ทะเบียนเทียบแบบ normalize เดียวกับหน้าทะเบียนรถ (เลขไทย → อารบิก ตัดช่องว่าง/ขีด/จุด)
          const k = plateNorm(q);
          if (!k) break;
          const rows = await tx.vehicle.findMany({
            where: { deletedAt: null, plateNorm: { contains: likeEscape(k) } },
            select: {
              id: true,
              plate: true,
              plateNorm: true,
              status: true,
              vehicleType: { select: { nameTh: true } },
              defaultDrivers: {
                where: { deletedAt: null },
                select: { name: true },
                orderBy: { name: 'asc' },
                take: 1,
              },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take,
          });
          out.push(
            ...top(
              rows.map((r) => ({
                rank: matchRank(r.plateNorm, k),
                hit: {
                  ...BLANK,
                  type,
                  id: encodeId('vehicle', r.id),
                  label: r.plate,
                  matchedOn: 'plate' as const,
                  status: r.status.toLowerCase(),
                  plate: r.plate,
                  vehicleType: r.vehicleType.nameTh,
                  driverName: r.defaultDrivers[0]?.name ?? null,
                },
              })),
              limit,
            ),
          );
          break;
        }
      }
    }
    return { q, searched: types, data: out };
  }
}
