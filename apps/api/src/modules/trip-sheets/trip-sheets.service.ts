import { Injectable } from '@nestjs/common';
import { Prisma, type StoredDocument } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { bkkTime } from '../../common/thai-date';
import { DbService, type Tx } from '../../db/db.service';
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { store } from '../documents/documents.controller';
import { addressText } from '../geo/geo.service';
import { MagicLinkService } from '../links/magic-link.service';
import { tripSheetDocument, type TripSheetPage, type TripSheetStop } from './trip-sheet.template';

/** ลิงก์ใบคุมรถที่คัดลอกส่งให้คนขับ — ใช้ได้ 72 ชม. (spec/12 §3 ST3-T20 DECISION) */
export const SHEET_LINK_TTL_S = 72 * 3600;
export const SHEET_LINK_PURPOSE = 'trip_sheet' as const;
export const SHEET_LINK_ACTION = 'sheet.view';

const LINES = {
  where: {},
  orderBy: { lineNo: 'asc' },
  select: { description: true, qtyPlanned: true, unit: true },
} as const;
const DO_SELECT = {
  where: { status: { not: 'CANCELLED' } },
  orderBy: { doNo: 'asc' },
  select: { doNo: true, lines: LINES },
} as const;

export const SHEET_INCLUDE = {
  stops: {
    where: { removedAt: null },
    orderBy: { sequence: 'asc' },
    include: {
      site: { select: { name: true, address: true, contact: true } },
      deliveryOrders: DO_SELECT,
      pickupOrders: DO_SELECT,
    },
  },
  deliveryOrders: {
    where: { status: { not: 'CANCELLED' } },
    orderBy: { doNo: 'asc' },
    take: 1,
    select: { salesOrder: { select: { billingCompany: { select: { legalName: true } } } } },
  },
} as const satisfies Prisma.TripInclude;
type SheetTrip = Prisma.TripGetPayload<{ include: typeof SHEET_INCLUDE }>;

const qty = (d: Prisma.Decimal) =>
  Number(d.toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 });

function appointment(s: SheetTrip['stops'][number]): string | null {
  if (s.windowStart && s.windowEnd) return `${bkkTime(s.windowStart)}–${bkkTime(s.windowEnd)}`;
  const at = s.windowStart ?? s.plannedArrival;
  return at ? bkkTime(at) : null;
}

function contactOf(c: unknown): { name: string | null; phone: string | null } {
  const o = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { name: str(o.name), phone: str(o.phone) };
}

/** ข้อมูลหน้าใบคุมรถจากเที่ยว (snapshot ณ ตอนสร้าง) — `units` = รหัสหน่วย → ชื่อไทย (ไม่มี = แสดงรหัส) */
export function sheetPage(
  t: SheetTrip,
  units: ReadonlyMap<string, string> = new Map(),
): TripSheetPage {
  return {
    tripNo: t.tripNo ?? '—',
    tripDate: t.tripDate.toISOString().slice(0, 10),
    plate: t.vehiclePlateSnapshot,
    vehicleType: t.vehicleTypeSnapshot,
    trailerPlate: t.trailerPlateSnapshot,
    driverName: t.driverNameSnapshot,
    carrierName: t.carrierNameSnapshot,
    stops: t.stops.map((s): TripSheetStop => {
      const c = contactOf(s.site.contact);
      // จุดรับ = สินค้าที่ต้องขึ้นรถ (DO ที่รับที่จุดนี้) · จุดส่ง = สินค้าที่ต้องลง
      const dos = s.type === 'PICKUP' ? s.pickupOrders : s.deliveryOrders;
      return {
        sequence: s.sequence,
        type: s.type,
        siteName: s.site.name,
        address: addressText(s.site.address),
        appointment: appointment(s),
        contactName: c.name,
        contactPhone: c.phone,
        dos: dos.map((d) => ({
          doNo: d.doNo ?? '—',
          goods: d.lines.map(
            (l) =>
              `${l.description} ${qty(l.qtyPlanned)} ${units.get(l.unit.toUpperCase()) ?? l.unit}`,
          ),
        })),
      };
    }),
  };
}

/** รหัสหน่วย (ตัวใหญ่) → ชื่อไทย ของบริษัท (รวมที่ลบแล้ว — บรรทัดเก่ายังอ้างได้) */
export async function unitNames(tx: Tx): Promise<Map<string, string>> {
  const us = await tx.unit.findMany({ select: { code: true, nameTh: true } });
  return new Map(us.map((u) => [u.code.toUpperCase(), u.nameTh]));
}

export interface SheetResult {
  doc: StoredDocument;
  trips: { id: string; tripNo: string | null }[];
}

/**
 * ใบงานประจำวัน / ใบคุมรถ PDF (ST3-T20; docs/04 D2 "ใบงานประจำวัน", spec/05 ใบคุมรถ, spec/03 §4 "พิมพ์ A4 ใบคุมรถ")
 * - snapshot: PDF = ข้อมูล ณ ตอนสร้าง · สร้างใหม่ = ไฟล์ใหม่ (FileStore เขียนครั้งเดียว + แถว stored_document ใหม่) · audit ทุกครั้ง
 * - route ไม่ถือ transaction ระหว่าง render (Chromium ~1 วิ/ไฟล์): อ่าน → render → เขียนแถว + audit คนละ transaction
 */
@Injectable()
export class TripSheetsService {
  constructor(
    private readonly db: DbService,
    private readonly pdf: PdfRenderer,
    private readonly audit: AuditService,
    private readonly links: MagicLinkService,
  ) {}

  /** transaction ของ tenant ปัจจุบัน + ให้ AuditService/โค้ดที่ใช้ `db.tx` ทำงานในนั้น */
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

  private async header(tx: Tx, trips: SheetTrip[]) {
    const tenant = await tx.tenant.findFirst({ select: { name: true, yearStyle: true } });
    const company = trips.find((t) => t.deliveryOrders[0])?.deliveryOrders[0]?.salesOrder
      .billingCompany.legalName;
    return {
      companyName: company ?? tenant?.name ?? '',
      yearStyle: (tenant?.yearStyle === 'CE' ? 'CE' : 'BE') as 'BE' | 'CE',
    };
  }

  private async render(
    load: (tx: Tx) => Promise<SheetTrip[]>,
  ): Promise<{ pdf: Buffer; trips: SheetTrip[] }> {
    const { trips, head, units } = await this.inTx(async (tx) => {
      const trips = await load(tx);
      return { trips, head: await this.header(tx, trips), units: await unitNames(tx) };
    });
    const pdf = await this.pdf.pdf(
      tripSheetDocument({ ...head, pages: trips.map((t) => sheetPage(t, units)) }),
    );
    return { pdf, trips };
  }

  /** เก็บไฟล์ + แถว stored_document (kind PDF) + audit ใน transaction เดียว */
  private async save(
    pdf: Buffer,
    trips: SheetTrip[],
    meta: { entityType: string; entityId: string | null; filename: string; extra: object },
    after?: (tx: Tx, doc: StoredDocument) => Promise<void>,
  ): Promise<StoredDocument> {
    const ctx = requestContext.require();
    const f = await store().put(ctx.tenantId!, pdf, 'pdf');
    return this.inTx(async (tx) => {
      const doc = await tx.storedDocument.create({
        data: {
          tenantId: ctx.tenantId!,
          status: 'READY',
          kind: 'PDF',
          mimeType: 'application/pdf',
          fileKey: f.key,
          sha256: f.sha256,
          sizeBytes: f.size,
          filename: meta.filename,
          entityType: meta.entityType,
          entityId: meta.entityId,
          createdBy: ctx.actorId ?? null,
          metadata: {
            document: 'TRIP_SHEET',
            ...meta.extra,
            trips: trips.map((t) => ({
              id: encodeId('trip', t.id),
              tripNo: t.tripNo,
              version: t.version,
              status: t.status,
            })),
          },
        },
      });
      await this.audit.record({
        action: 'trip_sheet.generated',
        entityType: meta.entityType,
        entityId: meta.entityId ?? doc.id,
        after: {
          documentId: encodeId('document', doc.id),
          sha256: f.sha256,
          ...meta.extra,
          trips: trips.map((t) => t.tripNo),
        },
      });
      if (after) await after(tx, doc);
      return doc;
    });
  }

  private async loadTrip(tx: Tx, id: string): Promise<SheetTrip[]> {
    const t = await tx.trip.findUnique({ where: { id }, include: SHEET_INCLUDE });
    if (!t) throw new ProblemException('not_found');
    if (t.status === 'CANCELLED')
      throw new ProblemException(
        'invalid_state_transition',
        'cannot print a cancelled trip — ยกเลิกเที่ยวแล้ว พิมพ์ใบคุมรถไม่ได้',
      );
    if (!t.stops.length) throw new ProblemException('trip_empty');
    return [t];
  }

  /** ใบคุมรถ 1 เที่ยว */
  async forTrip(
    id: string,
    after?: (tx: Tx, doc: StoredDocument, trip: SheetTrip) => Promise<void>,
  ): Promise<SheetResult> {
    const { pdf, trips } = await this.render((tx) => this.loadTrip(tx, id));
    const t = trips[0]!;
    const doc = await this.save(
      pdf,
      trips,
      {
        entityType: 'trip',
        entityId: t.id,
        filename: `ใบคุมรถ-${t.tripNo ?? 'TRP'}.pdf`,
        extra: { scope: 'TRIP' },
      },
      after ? (tx, d) => after(tx, d, t) : undefined,
    );
    return { doc, trips: [{ id: t.id, tripNo: t.tripNo }] };
  }

  /** ใบงานประจำวัน: ทุกเที่ยวของวัน (หรือของรถคันเดียว) ที่ยังไม่ยกเลิกและมีจุดแวะ — 1 เที่ยว/หน้า เรียงตามรถ → เวลาออก */
  async forDay(date: string, vehicleId: string | null): Promise<SheetResult> {
    const { pdf, trips } = await this.render(async (tx) => {
      if (vehicleId && !(await tx.vehicle.findUnique({ where: { id: vehicleId } })))
        throw new ProblemException('validation_failed', undefined, [
          { field: 'vehicleId', code: 'not_found', message: 'vehicle not found' },
        ]);
      const ts = await tx.trip.findMany({
        where: {
          tripDate: new Date(`${date}T00:00:00Z`),
          status: { not: 'CANCELLED' },
          stops: { some: { removedAt: null } },
          ...(vehicleId ? { vehicleId } : {}),
        },
        include: SHEET_INCLUDE,
        orderBy: [
          { vehiclePlateSnapshot: { sort: 'asc', nulls: 'last' } },
          { plannedStartAt: { sort: 'asc', nulls: 'last' } },
          { tripNo: 'asc' },
        ],
        take: 201,
      });
      if (!ts.length)
        throw new ProblemException('validation_failed', 'no trips to print on this date', [
          { field: 'date', code: 'no_trips', message: 'no trips on this date' },
        ]);
      if (ts.length > 200)
        throw new ProblemException('validation_failed', 'too many trips (max 200 per file)', [
          { field: 'date', code: 'too_many_trips', message: 'filter by vehicle' },
        ]);
      return ts;
    });
    const plate = vehicleId ? (trips[0]?.vehiclePlateSnapshot ?? '') : '';
    const doc = await this.save(pdf, trips, {
      entityType: vehicleId ? 'vehicle' : 'trip_sheet',
      entityId: vehicleId,
      filename: `ใบคุมรถ-${date}${plate ? `-${plate.replace(/\s+/g, '')}` : ''}.pdf`,
      extra: { scope: 'DAY', date, vehicleId: vehicleId ? encodeId('vehicle', vehicleId) : null },
    });
    return { doc, trips: trips.map((t) => ({ id: t.id, tripNo: t.tripNo })) };
  }

  /**
   * "ส่งให้คนขับ" (เฟส 0 = คัดลอกลิงก์): สร้างใบคุมรถใหม่ (ข้อมูลล่าสุด) + magic link เปิด PDF ได้โดยไม่ login 72 ชม.
   * ส่งเข้า LINE/SMS ของคนขับโดยตรง = ST4 (ช่อง ST3-T21 ส่งถึงผู้รับเหมาเท่านั้น — spec/12 §3)
   */
  async driverLink(id: string): Promise<SheetResult & { token: string; expiresAt: Date }> {
    const ctx = requestContext.require();
    let link: { token: string; expiresAt: Date } | null = null;
    const r = await this.forTrip(id, async (tx, doc, t) => {
      const l = await this.links.issue(tx, ctx.tenantId!, {
        purpose: SHEET_LINK_PURPOSE,
        entityType: 'stored_document',
        entityId: doc.id,
        actions: [SHEET_LINK_ACTION],
        ttlSeconds: SHEET_LINK_TTL_S,
        createdBy: ctx.actorId,
      });
      link = { token: l.token, expiresAt: l.expiresAt };
      await this.audit.record({
        action: 'trip_sheet.shared',
        entityType: 'trip',
        entityId: t.id,
        after: {
          documentId: encodeId('document', doc.id),
          linkId: encodeId('magicLink', l.id),
          channel: 'COPY_LINK',
          driver: t.driverNameSnapshot,
          expiresAt: l.expiresAt.toISOString(),
        },
      });
    });
    return { ...r, ...link! };
  }

  /** เปิด PDF จากลิงก์ (principal `link`) — ไฟล์ที่ลิงก์ชี้เท่านั้น */
  async linkedFile(documentId: string): Promise<{ doc: StoredDocument; data: Buffer }> {
    const doc = await this.db.tx.storedDocument.findUnique({ where: { id: documentId } });
    if (!doc || doc.status !== 'READY' || !doc.fileKey || doc.kind !== 'PDF')
      throw new ProblemException('not_found');
    return { doc, data: await store().get(doc.fileKey) };
  }
}
