import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { webBaseUrl } from '../../auth/password-reset.controller';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { signDocumentUrl, UPLOAD_TTL_S } from '../documents/signed-url';
import { encodeLinkToken, MagicLinkService } from '../links/magic-link.service';
import { lockKey } from '../master/master-kit';
import { readSettings } from '../settings/settings.service';
import { normalizeDoNo } from '../trips/pod-link.service';
import {
  TRACKING_STEPS,
  type TrackingLinkDto,
  type TrackingLinkStateDto,
  type TrackingShipmentDto,
  type TrackingStage,
  type TrackingViewDto,
} from './tracking.dto';

/** magic link ของหน้าติดตาม (ST1-T06 จองชื่อ `tracking` ไว้แล้ว) */
export const TRACKING_PURPOSE = 'tracking';
export const TRACKING_ACTION = 'tracking.view';
/** ลิงก์ชี้ DO (เปิดแล้วเห็นงานเลย — spec/04 §4) หรือชี้ลูกค้า (ผู้รับค้นเลข DO/PO + เบอร์ 4 ตัวท้าย — EXE-062) */
export const TRACKING_ENTITIES = { do: 'delivery_order', customer: 'customer' } as const;
/** อายุ token สูงสุด (spec/04 §4 ตั้งต่อ tenant 7–90 วัน) — อายุจริงของงานที่จบแล้วตรวจที่ service (`tracking.linkDays`) */
export const TRACKING_LINK_MAX_DAYS = 90;
/** รูป POD บนหน้าติดตาม: URL อายุ 15 นาที (EXE-064) */
const POD_URL_TTL_S = UPLOAD_TTL_S;
const POD_PHOTOS_MAX = 6;
/** เวลาตอบขั้นต่ำของ lookup — พบ/ไม่พบใช้เวลาใกล้กัน (กันเดาจากเวลา) */
const LOOKUP_MIN_MS = Number(process.env.TRACKING_LOOKUP_MIN_MS ?? 250);

const DELIVERED_SET = new Set(['DELIVERED', 'POD_PENDING', 'UNBILLED', 'BILLED']);
const SETTING_KEYS = [
  'org.name',
  'tracking.contactPhone',
  'tracking.showPod',
  'tracking.linkDays',
] as const;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** สถานะสาธารณะจากสถานะ DO + ความคืบหน้าของเที่ยว (stepper — spec/04 §4 "stepper สะท้อนสถานะ stop/trip") */
export function trackingStage(
  doStatus: string,
  trip: { started: boolean; pickupDone: boolean },
): TrackingStage {
  if (doStatus === 'CANCELLED') return 'CANCELLED';
  if (doStatus === 'FAILED' || doStatus === 'RETURNED') return 'FAILED';
  if (DELIVERED_SET.has(doStatus)) return 'DELIVERED';
  if (doStatus === 'PICKED_UP' || (doStatus === 'DISPATCHED' && trip.pickupDone))
    return 'IN_TRANSIT';
  if (doStatus === 'DISPATCHED' && trip.started) return 'DEPARTED';
  return 'ACCEPTED';
}

/** ทะเบียนปิด 2 หลักท้ายของชุดตัวเลขสุดท้าย ("70-1234 กทม." → "70-12xx กทม.") — EXE-044 `plateMasked` */
export function maskPlate(plate: string | null | undefined): string | null {
  const p = (plate ?? '').trim();
  if (!p) return null;
  const m = /^(.*?)(\d+)(\D*)$/.exec(p);
  if (!m || m[2]!.length < 2) return 'xx';
  return `${m[1]}${m[2]!.slice(0, -2)}xx${m[3]}`;
}

/** จำนวนทศนิยม → สตริงไม่มีศูนย์ท้าย ("20.000" → "20") */
const qtyText = (v: Prisma.Decimal | null | undefined) =>
  v == null ? null : v.toFixed(3).replace(/\.?0+$/, '');
const digits = (s: string) => s.replace(/\D/g, '');
const province = (addr: unknown): string | null => {
  const p = addr && typeof addr === 'object' ? (addr as Record<string, unknown>).province : null;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
};
const contactPhone = (contact: unknown): string =>
  contact && typeof contact === 'object'
    ? digits(String((contact as Record<string, unknown>).phone ?? ''))
    : '';

type LinkRow = { id: string; expiresAt: Date; createdAt: Date; lastUsedAt: Date | null };

/**
 * หน้าติดตามของผู้รับ (ST4-T14; docs/04 E2 "Tracking link สาธารณะ", docs/01 §5.2 #4, spec/04 §4 EXE-D)
 * - ลิงก์ = magic link `tracking` ชี้ DO (เปิดแล้วเห็นงาน) หรือชี้ลูกค้า (ค้นเลข DO/PO + เบอร์ผู้รับ 4 ตัวท้าย)
 * - ลิงก์ผิด/หมดอายุ/เพิกถอน/งานจบเกิน `tracking.linkDays` วัน/ค้นไม่พบ → 404 แบบเดียวกัน (ไม่บอกใบ้)
 * - DTO สาธารณะแยก (EXE-061) — ไม่ประกอบจาก DTO ภายใน
 */
@Injectable()
export class TrackingService {
  constructor(
    private readonly db: DbService,
    private readonly links: MagicLinkService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ ภายใน: ออก/ดู/เพิกถอนลิงก์

  private toLink(l: LinkRow): TrackingLinkDto {
    const token = encodeLinkToken(l.id, Math.floor(l.expiresAt.getTime() / 1000));
    return {
      linkId: encodeId('magicLink', l.id),
      url: `${webBaseUrl()}/t/${token}`,
      expiresAt: l.expiresAt.toISOString(),
      createdAt: l.createdAt.toISOString(),
      lastUsedAt: iso(l.lastUsedAt),
    };
  }

  private activeRows(tx: Tx, entityType: string, entityId: string) {
    return tx.magicLink.findMany({
      where: {
        purpose: TRACKING_PURPOSE,
        entityType,
        entityId,
        revokedAt: null,
        expiresAt: { gt: this.clock.now() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** ต้องมีแถวใน tenant นี้ (RLS — บริษัทอื่น = 404) */
  private async assertEntity(tx: Tx, kind: keyof typeof TRACKING_ENTITIES, id: string) {
    const row =
      kind === 'do'
        ? await tx.deliveryOrder.findFirst({ where: { id }, select: { id: true, status: true } })
        : await tx.customer.findFirst({
            where: { id, deletedAt: null },
            select: { id: true, status: true },
          });
    if (!row) throw new ProblemException('not_found');
    return row;
  }

  async current(kind: keyof typeof TRACKING_ENTITIES, id: string): Promise<TrackingLinkStateDto> {
    const tx = this.db.tx;
    await this.assertEntity(tx, kind, id);
    const [l] = await this.activeRows(tx, TRACKING_ENTITIES[kind], id);
    return { link: l ? this.toLink(l) : null };
  }

  /** ออกลิงก์ใหม่ — ลิงก์เดิมที่ยังใช้ได้ถูกเพิกถอน (1 ลิงก์ต่อ DO/ลูกค้า — EXE-060 "สร้างใหม่ = เพิกถอนอันเก่า") */
  async issue(kind: keyof typeof TRACKING_ENTITIES, id: string): Promise<TrackingLinkDto> {
    const tx = this.db.tx;
    const entity = await this.assertEntity(tx, kind, id);
    if (kind === 'do' && entity.status === 'CANCELLED')
      throw new ProblemException(
        'invalid_state_transition',
        'ใบส่งของที่ยกเลิกแล้วออกลิงก์ติดตามไม่ได้',
      );
    const entityType = TRACKING_ENTITIES[kind];
    await lockKey(tx, `tracking-link:${entityType}:${id}`);
    const actor = requestContext.get()?.actorId ?? undefined;
    for (const old of await this.activeRows(tx, entityType, id))
      await this.links.revoke(tx, old.id, 'ออกลิงก์ติดตามใหม่แทน', actor);
    const ctx = requestContext.require();
    const l = await this.links.issue(tx, ctx.tenantId!, {
      purpose: TRACKING_PURPOSE,
      entityType,
      entityId: id,
      actions: [TRACKING_ACTION],
      ttlSeconds: TRACKING_LINK_MAX_DAYS * 86_400,
      ...(actor ? { createdBy: actor } : {}),
    });
    const row = await tx.magicLink.findUniqueOrThrow({ where: { id: l.id } });
    return this.toLink(row);
  }

  /** เพิกถอน (เหตุผลบังคับ + audit ใน MagicLinkService) — ไม่มีลิงก์ที่ใช้ได้ = คืน `link: null` */
  async revoke(
    kind: keyof typeof TRACKING_ENTITIES,
    id: string,
    reason: string,
  ): Promise<TrackingLinkStateDto> {
    const tx = this.db.tx;
    await this.assertEntity(tx, kind, id);
    const actor = requestContext.get()?.actorId ?? undefined;
    for (const l of await this.activeRows(tx, TRACKING_ENTITIES[kind], id))
      await this.links.revoke(tx, l.id, reason, actor);
    return { link: null };
  }

  // ------------------------------------------------------------------ สาธารณะ

  private linkOf() {
    const l = requestContext.require().link;
    if (!l || l.purpose !== TRACKING_PURPOSE) throw new ProblemException('not_found');
    return l;
  }

  private async settings(tx: Tx) {
    const s = await readSettings(tx, requestContext.require().tenantId!, SETTING_KEYS);
    return {
      name: String(s['org.name'] ?? ''),
      phone: typeof s['tracking.contactPhone'] === 'string' ? s['tracking.contactPhone'] : null,
      showPod: s['tracking.showPod'] === true,
      linkDays: Number(s['tracking.linkDays'] ?? 30),
    };
  }

  /** เปิดลิงก์ — ลิงก์ DO: เห็นงานเลย · ลิงก์ลูกค้า: หน้าค้นหา */
  async view(origin: string): Promise<TrackingViewDto> {
    const tx = this.db.tx;
    const link = this.linkOf();
    const s = await this.settings(tx);
    const company = { name: s.name, phone: s.phone };
    if (link.entityType === TRACKING_ENTITIES.customer) {
      const c = await tx.customer.findFirst({
        where: { id: link.entityId, deletedAt: null },
        select: { id: true },
      });
      if (!c) throw new ProblemException('not_found');
      return { company, mode: 'SEARCH', shipment: null };
    }
    if (link.entityType !== TRACKING_ENTITIES.do) throw new ProblemException('not_found');
    const shipment = await this.shipment(tx, link.entityId, s, origin);
    if (!shipment) throw new ProblemException('not_found');
    return { company, mode: 'SHIPMENT', shipment };
  }

  /**
   * ค้นด้วยเลข DO หรือเลข PO ลูกค้า + เบอร์ผู้รับ 4 ตัวท้าย (EXE-062) — เฉพาะ DO ของลูกค้าที่ลิงก์ชี้
   * PO ซ้ำหลายใบ → ใบที่ยังไม่ยกเลิกล่าสุด ("สถานะล่าสุด") · ไม่พบ/เบอร์ไม่ตรง/ลิงก์ DO → 404 เดียวกัน
   */
  async lookup(ref: string, phoneLast4: string, origin: string): Promise<TrackingShipmentDto> {
    const started = Date.now();
    try {
      return await this.lookupInner(ref, phoneLast4, origin);
    } finally {
      const wait = LOOKUP_MIN_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async lookupInner(
    ref: string,
    phoneLast4: string,
    origin: string,
  ): Promise<TrackingShipmentDto> {
    const tx = this.db.tx;
    const link = this.linkOf();
    if (link.entityType !== TRACKING_ENTITIES.customer) throw new ProblemException('not_found');
    const q = ref.trim();
    const candidates = await tx.deliveryOrder.findMany({
      where: {
        customerId: link.entityId,
        doNo: { not: null },
        OR: [{ doNo: normalizeDoNo(q) }, { customerRef: { equals: q, mode: 'insensitive' } }],
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        destSite: { select: { contact: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    const matched = candidates.filter((d) => {
      const p = contactPhone(d.destSite.contact);
      return p.length >= 4 && p.slice(-4) === phoneLast4;
    });
    const pick = matched.find((d) => d.status !== 'CANCELLED') ?? matched[0];
    if (!pick) throw new ProblemException('not_found');
    const s = await this.settings(tx);
    const shipment = await this.shipment(tx, pick.id, s, origin);
    if (!shipment) throw new ProblemException('not_found');
    return shipment;
  }

  /** ประกอบ DTO สาธารณะของ DO — null = ใช้ไม่ได้แล้ว (งานจบเกิน linkDays วัน) */
  private async shipment(
    tx: Tx,
    doId: string,
    s: { showPod: boolean; linkDays: number },
    origin: string,
  ): Promise<TrackingShipmentDto | null> {
    const d = await tx.deliveryOrder.findFirst({
      where: { id: doId },
      select: {
        id: true,
        tenantId: true,
        doNo: true,
        doDate: true,
        status: true,
        customerRef: true,
        createdAt: true,
        updatedAt: true,
        salesOrderId: true,
        destStopSeq: true,
        customer: { select: { legalName: true } },
        originSite: { select: { address: true } },
        destSite: { select: { address: true } },
        tripId: true,
        tripStop: {
          select: { windowStart: true, windowEnd: true, plannedArrival: true },
        },
        pickupTripStop: { select: { status: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          select: { description: true, qtyPlanned: true, qtyActual: true, unit: true },
        },
      },
    });
    if (!d || !d.doNo) return null;
    const trip = d.tripId
      ? await tx.trip.findFirst({
          where: { id: d.tripId },
          select: {
            status: true,
            vehiclePlateSnapshot: true,
            vehicleTypeSnapshot: true,
            vehicleType: { select: { nameTh: true } },
            stops: {
              where: { removedAt: null },
              select: { arrivedAt: true },
            },
          },
        })
      : null;
    const history = await tx.docStatusHistory.findMany({
      where: { docType: 'delivery_order', docId: d.id },
      orderBy: { at: 'asc' },
      select: { toStatus: true, at: true },
    });
    const firstAt = (to: string[]) => history.find((h) => to.includes(h.toStatus))?.at ?? null;
    const lastAt = (to: string[]) =>
      [...history].reverse().find((h) => to.includes(h.toStatus))?.at ?? null;

    const pickupDone =
      d.pickupTripStop?.status === 'COMPLETED' || history.some((h) => h.toStatus === 'PICKED_UP');
    const arrivals = (trip?.stops ?? [])
      .map((x) => x.arrivedAt)
      .filter((x): x is Date => !!x)
      .sort((a, b) => a.getTime() - b.getTime());
    const started = trip?.status === 'IN_PROGRESS' || trip?.status === 'COMPLETED' || !!arrivals[0];
    const stage = trackingStage(d.status, { started, pickupDone });

    // เวลาจบงาน (ส่งแล้ว/ไม่สำเร็จ/ยกเลิก) + linkDays วัน → ลิงก์ใช้ไม่ได้ (spec/04 §4 expiresAt)
    const deliveredAt = stage === 'DELIVERED' ? lastAt(['DELIVERED']) : null;
    const endedAt =
      stage === 'DELIVERED'
        ? (deliveredAt ?? d.updatedAt)
        : stage === 'FAILED'
          ? (lastAt(['FAILED', 'RETURNED']) ?? d.updatedAt)
          : stage === 'CANCELLED'
            ? (lastAt(['CANCELLED']) ?? d.updatedAt)
            : null;
    if (endedAt && endedAt.getTime() + s.linkDays * 86_400_000 < this.clock.now().getTime())
      return null;

    const order: TrackingStage[] = [...TRACKING_STEPS];
    const reached =
      stage === 'FAILED' ? 3 : stage === 'CANCELLED' ? -1 : order.indexOf(stage as never);
    const stepAt: Record<string, Date | null> = {
      ACCEPTED: d.createdAt,
      DEPARTED: arrivals[0] ?? firstAt(['DISPATCHED']),
      IN_TRANSIT: firstAt(['PICKED_UP']),
      DELIVERED: stage === 'FAILED' ? lastAt(['FAILED', 'RETURNED']) : deliveredAt,
    };
    const steps = TRACKING_STEPS.map((key, i) => ({
      key,
      done: i <= reached,
      at: i <= reached ? iso(stepAt[key]) : null,
    }));

    // ETA = ช่วงเวลาตามแผน (จุดส่งในเที่ยว → ช่วงที่ลูกค้าขอในใบสั่ง) — ยังไม่มี ETA สด (P1)
    let win: { from: Date | null; to: Date | null } = {
      from: d.tripStop?.windowStart ?? null,
      to: d.tripStop?.windowEnd ?? null,
    };
    if (!win.from && d.tripStop?.plannedArrival)
      win = { from: d.tripStop.plannedArrival, to: d.tripStop.plannedArrival };
    if (!win.from && !d.tripStop) {
      const so = await tx.salesOrderStop.findFirst({
        where: { salesOrderId: d.salesOrderId, sequence: d.destStopSeq },
        select: { windowStart: true, windowEnd: true },
      });
      if (so?.windowStart) win = { from: so.windowStart, to: so.windowEnd };
    }
    const eta =
      win.from && (stage === 'ACCEPTED' || stage === 'DEPARTED' || stage === 'IN_TRANSIT')
        ? { from: win.from.toISOString(), to: (win.to ?? win.from).toISOString(), basis: 'PLAN' }
        : null;

    const units = [...new Set(d.lines.map((l) => l.unit))];
    const unitRows = units.length
      ? await tx.unit.findMany({
          where: { code: { in: units, mode: 'insensitive' } },
          select: { code: true, nameTh: true },
        })
      : [];
    const unitName = (u: string) =>
      unitRows.find((r) => r.code.toUpperCase() === u.toUpperCase())?.nameTh ?? u;

    const vehicle =
      trip && (stage === 'DEPARTED' || stage === 'IN_TRANSIT' || stage === 'DELIVERED')
        ? {
            typeName: trip.vehicleType?.nameTh ?? trip.vehicleTypeSnapshot ?? null,
            plateMasked: maskPlate(trip.vehiclePlateSnapshot),
          }
        : null;

    const pod = stage === 'DELIVERED' && s.showPod ? await this.pod(tx, d.id, origin) : null;
    const latest = history.at(-1)?.at ?? d.updatedAt;
    return {
      doNo: d.doNo,
      customerName: d.customer.legalName,
      customerRef: d.customerRef,
      status: stage,
      steps,
      eta,
      deliveredAt: iso(deliveredAt),
      doDate: d.doDate.toISOString().slice(0, 10),
      route: { from: province(d.originSite.address), to: province(d.destSite.address) },
      vehicle,
      items: d.lines.map((l) => ({
        description: l.description,
        qty: qtyText(l.qtyPlanned)!,
        unit: unitName(l.unit),
        qtyDelivered: stage === 'DELIVERED' ? qtyText(l.qtyActual) : null,
      })),
      pod,
      updatedAt: latest.toISOString(),
    };
  }

  /** หลักฐานส่งฉบับล่าสุด (สำเร็จ) — รูป/ลายเซ็นผ่าน URL มีลายเซ็นอายุ 15 นาที · ไม่มี PIN/โน้ต/บาร์โค้ด/ผู้บันทึก */
  private async pod(tx: Tx, doId: string, origin: string) {
    const p = await tx.deliveryOrderPod.findFirst({
      where: { deliveryOrderId: doId },
      orderBy: { version: 'desc' },
      select: {
        outcome: true,
        receiverName: true,
        createdAt: true,
        signatureDocumentId: true,
        photoDocumentIds: true,
      },
    });
    if (!p || p.outcome !== 'SUCCESS') return null;
    const ids = [...p.photoDocumentIds.slice(0, POD_PHOTOS_MAX), p.signatureDocumentId].filter(
      (x): x is string => !!x,
    );
    const ready = ids.length
      ? await tx.storedDocument.findMany({
          where: { id: { in: ids }, status: 'READY', mimeType: { startsWith: 'image/' } },
          select: { id: true, tenantId: true },
        })
      : [];
    const img = (id: string | null) => {
      const doc = id ? ready.find((r) => r.id === id) : undefined;
      if (!doc) return null;
      const sgn = signDocumentUrl('download', doc.tenantId, doc.id, POD_URL_TTL_S);
      return {
        url: `${origin.replace(/\/+$/, '')}/v1/documents/${encodeId('document', doc.id)}/content?${sgn.query}`,
        expiresAt: sgn.expiresAt.toISOString(),
      };
    };
    return {
      receiverName: p.receiverName,
      recordedAt: p.createdAt.toISOString(),
      photos: p.photoDocumentIds
        .slice(0, POD_PHOTOS_MAX)
        .map(img)
        .filter((x): x is NonNullable<typeof x> => !!x),
      signature: img(p.signatureDocumentId),
    };
  }
}
