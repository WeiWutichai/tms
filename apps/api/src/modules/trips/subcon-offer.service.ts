import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isSubconRejectReason, SUBCON_REJECT_REASONS, subconRejectLabelTh } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { isThaiPhone, phoneNorm } from '../drivers/drivers.service';
import { PROVINCES } from '../vehicles/provinces';
import { arabicDigits, plateNorm } from '../vehicles/vehicles.service';
import { LINE_USER_ID_RE } from '../messaging/messaging.dto';
import { MessagingService } from '../messaging/messaging.service';
import { OFFER_LINK_PURPOSE, OfferLinks, POD_LINK_PURPOSE, podLinkUsable } from './offer-links';
import type {
  AcceptOfferDto,
  OfferLinkDto,
  OfferLinkViewDto,
  RejectOfferDto,
  SubconOfferDto,
} from './offer.dto';
import { TripService } from './trip.service';

const field422 = (field: string, code: string, message: string, detail?: string) =>
  new ProblemException('validation_failed', detail, [{ field, code, message }]);

/** ชื่อ/อักษรย่อจังหวัด (ไม่มีจุด) ยาวก่อน — ตัดจังหวัดที่พิมพ์ต่อท้ายทะเบียน ("74-5521 ชบ.") */
const PROVINCE_WORDS = PROVINCES.flatMap((p) => [
  { code: p[0], word: p[1] },
  { code: p[0], word: p[2].replace(/\./g, '') },
]).sort((a, b) => b.word.length - a.word.length);

/**
 * ทะเบียนที่รถร่วมพิมพ์ → ทะเบียน normalize (สูตรเดียวกับ `vehicle.plate_norm`) + จังหวัด (ถ้าพิมพ์ต่อท้าย)
 * จังหวัดตัดเฉพาะเมื่อส่วนหน้าลงท้ายด้วยตัวเลข (ทะเบียนไทยลงท้ายด้วยเลขเสมอ — กันตัดอักษรหมวดของทะเบียน)
 */
export function parseOfferPlate(input: string): { norm: string; province: string | null } {
  const s = arabicDigits(input).replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  for (const p of PROVINCE_WORDS) {
    if (!s.endsWith(p.word)) continue;
    // "จ. ชลบุรี" / "จังหวัดชลบุรี" — ตัดคำนำหน้าจังหวัดด้วย (QA L1)
    const head = s
      .slice(0, -p.word.length)
      .trim()
      .replace(/\s*(?:จังหวัด|จ)$/, '')
      .trim();
    if (/\d$/.test(head)) return { norm: plateNorm(head), province: p.code };
  }
  return { norm: plateNorm(s), province: null };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const MSG_CHANNEL: Record<string, string> = { LINE: 'line', SMS: 'sms' };

type OfferRow = Prisma.SubconOfferGetPayload<{
  include: {
    trip: {
      include: {
        stops: { include: { site: { select: { name: true } } } };
        deliveryOrders: { select: { customerId: true; weightKg: true } };
      };
    };
    carrier: { select: { paymentTermDays: true; requirePodToPay: true } };
  };
}>;

/**
 * ลิงก์ข้อเสนองานของรถร่วม (ST3-T23; docs/04 D3 "ส่งลิงก์ LINE/SMS ไม่ต้อง login" + M10, docs/01 §5.5, spec/04 §5 EXE-E)
 * - หน้า public: ดูข้อเสนอ (ไม่มีราคาขาย/ที่อยู่ลูกค้า/ผู้ติดต่อปลายทาง) · รับงาน (ทะเบียน + ชื่อ/เบอร์คนขับ) · ปฏิเสธ (+ เหตุผล)
 * - รับงาน = `/assign` เดิมของ TripService (OFFERED → ASSIGNED, snapshot, กฎ ST3-T14 — บล็อกเอกสาร/ใบขับขี่ → 409 ทันที
 *   ตาม [DECISION PLN-152]) · รถ/คนขับต้องเป็นของรถร่วมรายนี้ที่ลงทะเบียนไว้ [DECISION spec/12 §3 — ไม่สร้าง master จากลิงก์]
 * - ปฏิเสธ = `TripService.rejectOffer` (OFFERED → PLANNING, SO ON_HOLD CARRIER_REJECTED, กลับรายการค่าจ้าง)
 * - กดซ้ำด้วยข้อมูลเดิม (double-tap / refresh) = ได้ผลเดิม (200) · ตอบไปแล้วด้วยค่าอื่น/ถูกถอน → 409 `offer_closed`
 */
@Injectable()
export class SubconOfferService {
  constructor(
    private readonly db: DbService,
    private readonly trips: TripService,
    private readonly links: OfferLinks,
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
    /** ST3-T24 (review L1): ตัดสินหมดเวลาด้วย Clock (server time) ชุดเดียวกับ job */
    private readonly clock: Clock,
  ) {}

  private async load(tx: Tx, offerId: string): Promise<OfferRow> {
    const o = await tx.subconOffer.findFirst({
      where: { id: offerId },
      include: {
        trip: {
          include: {
            stops: {
              where: { removedAt: null },
              orderBy: { sequence: 'asc' },
              include: { site: { select: { name: true } } },
            },
            deliveryOrders: {
              where: { status: { not: 'CANCELLED' } },
              select: { customerId: true, weightKg: true },
            },
          },
        },
        carrier: { select: { paymentTermDays: true, requirePodToPay: true } },
      },
    });
    if (!o) throw new ProblemException('not_found');
    return o;
  }

  private expired(o: { status: string; expiresAt: Date | null }) {
    return (
      o.status === 'OFFERED' && !!o.expiresAt && o.expiresAt.getTime() <= this.clock.now().getTime()
    );
  }

  // ---------- หน้า public ----------

  async view(offerId: string, markViewed = true): Promise<OfferLinkViewDto> {
    const tx = this.db.tx;
    const o = await this.load(tx, offerId);
    if (markViewed && !o.viewedAt) {
      // เปิดลิงก์ครั้งแรก (PLN-150 `viewedAt`) — ครั้งเดียว (updateMany ตามเงื่อนไข กันสองเครื่องพร้อมกัน)
      const r = await tx.subconOffer.updateMany({
        where: { id: o.id, viewedAt: null },
        data: { viewedAt: this.clock.now() },
      });
      if (r.count)
        await this.audit.record({
          action: 'subcon_offer.viewed',
          entityType: 'trip',
          entityId: o.tripId,
          after: { offerId: encodeId('subconOffer', o.id) },
        });
    }
    return this.viewDto(tx, o);
  }

  private async viewDto(tx: Tx, o: OfferRow): Promise<OfferLinkViewDto> {
    const t = o.trip;
    const first = t.stops[0];
    const last = t.stops[t.stops.length - 1];
    const customerIds = [...new Set(t.deliveryOrders.map((d) => d.customerId))];
    const [tenant, customers, vt, user] = await Promise.all([
      tx.tenant.findFirst({ select: { name: true } }),
      customerIds.length
        ? tx.customer.findMany({
            where: { id: { in: customerIds } },
            select: { legalName: true },
            orderBy: { legalName: 'asc' },
          })
        : Promise.resolve([]),
      o.vehicleTypeId
        ? tx.vehicleType.findFirst({ where: { id: o.vehicleTypeId }, select: { nameTh: true } })
        : Promise.resolve(null),
      o.offeredBy && /^[0-9a-f-]{36}$/.test(o.offeredBy)
        ? tx.appUser.findFirst({ where: { id: o.offeredBy }, select: { name: true } })
        : Promise.resolve(null),
    ]);
    const weights = t.deliveryOrders.map((d) => d.weightKg);
    const weight = weights.some((w) => w !== null)
      ? weights
          .reduce<Prisma.Decimal>((a, w) => (w ? a.add(w) : a), new Prisma.Decimal(0))
          .toFixed(3)
          .replace(/\.?0+$/, '')
      : null;
    const q = (o.rateQuote ?? {}) as { whtRate?: string | null };
    const status = this.expired(o) ? 'EXPIRED' : o.status;
    // ST4-T08: รับงานแล้ว → ลิงก์งาน (แท็บ "ส่ง POD": ค้น DO + กดถึง/ออก) — ผู้ถือลิงก์ข้อเสนอคือรถร่วมรายเดียวกัน
    // ลิงก์งานหมดอายุ/เพิกถอน/เที่ยวจบเกิน 7 วัน → null (QA L4)
    const [pod] = podLinkUsable(o, t, this.clock.now())
      ? await this.links.active(tx, [o.id], [POD_LINK_PURPOSE])
      : [];
    return {
      company: tenant?.name ?? '',
      carrierName: o.carrierNameSnapshot,
      status,
      tripNo: t.tripNo!,
      tripDate: t.tripDate.toISOString().slice(0, 10),
      pickupAt: iso(first?.plannedArrival ?? first?.windowStart ?? null),
      origin: first?.site.name ?? null,
      destination: last && last !== first ? last.site.name : null,
      customerName: customers.length ? customers.map((c) => c.legalName).join(' · ') : null,
      vehicleTypeName: vt?.nameTh ?? t.vehicleTypeSnapshot ?? null,
      weightKg: weight,
      buyAmount: o.buyAmount.toFixed(2),
      terms: {
        // ธงหัก ณ ที่จ่ายมาจาก rate card เท่านั้น (ราคากรอกเอง = ไม่แสดง — ชุดเดียวกับใบสั่งงาน ST3-T22 / #58)
        whtRate: o.priceSource === 'RATE_CARD' ? (q.whtRate ?? null) : null,
        paymentTermDays: o.carrier.paymentTermDays,
        requirePodToPay: o.carrier.requirePodToPay,
      },
      contactName: user?.name ?? null,
      expiresAt: (o.expiresAt ?? new Date(o.offeredAt.getTime() + 48 * 3600_000)).toISOString(),
      serverTime: this.clock.now().toISOString(),
      accepted:
        o.status === 'ACCEPTED' && o.acceptedPlate
          ? { plate: o.acceptedPlate, driverName: o.acceptedDriverName }
          : null,
      rejectReason: o.status === 'REJECTED' ? o.rejectReasonCode : null,
      rejectReasons: SUBCON_REJECT_REASONS.map((r) => ({ code: r.code, label: r.labelTh })),
      podUrl: pod ? this.links.podUrl(pod) : null,
    };
  }

  /** ปิดแล้ว → 409 (หมดเวลา = ข้อความเฉพาะ — spec/04 §5 ข้อ 8 "ใช้ server time ตัดสิน") */
  private closed(o: { status: string; expiresAt: Date | null }) {
    return new ProblemException(
      'offer_closed',
      this.expired(o) ? 'หมดเวลาตอบรับข้อเสนอนี้แล้ว' : undefined,
      undefined,
      // ST9-T12 QA Q2: ชื่อ `offerStatus` — เดิม `status` ทับ status (HTTP) ของ problem+json
      { offerStatus: this.expired(o) ? 'EXPIRED' : o.status },
    );
  }

  async accept(offerId: string, body: AcceptOfferDto): Promise<OfferLinkViewDto> {
    const tx = this.db.tx;
    const o = await this.load(tx, offerId);
    if (o.status !== 'OFFERED' && o.status !== 'ACCEPTED') throw this.closed(o);
    if (this.expired(o)) throw this.closed(o);

    // รถ: ทะเบียนของรถร่วมรายนี้ที่ลงทะเบียนไว้ (ไม่ปลด/ไม่ลบ/ไม่ใช่หาง)
    const plate = parseOfferPlate(body.vehiclePlate);
    if (!plate.norm) throw field422('vehiclePlate', 'required', 'vehicle plate is required');
    const cands = await tx.vehicle.findMany({
      where: {
        carrierId: o.carrierId,
        ownership: 'SUBCONTRACT',
        deletedAt: null,
        status: { not: 'RETIRED' },
        unitRole: { not: 'TRAILER' },
        plateNorm: plate.norm,
      },
      select: { id: true, plate: true, plateProvince: true },
    });
    const vs = plate.province ? cands.filter((v) => v.plateProvince === plate.province) : cands;

    // คนขับ: เบอร์ของคนขับรถร่วมรายนี้ที่ลงทะเบียนไว้ (ใบขับขี่ตรวจตามกฎ ST3-T14)
    const phone = phoneNorm(body.driverPhone.trim());
    if (!isThaiPhone(phone))
      throw field422(
        'driverPhone',
        'invalid_phone',
        'driver phone must be a Thai phone number',
        'เบอร์คนขับไม่ถูกต้อง',
      );
    const driver = await tx.driver.findFirst({
      where: {
        carrierId: o.carrierId,
        employmentType: 'CARRIER_DRIVER',
        deletedAt: null,
        status: { not: 'INACTIVE' },
        phoneNorm: phone,
      },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    // ไม่ตรง → 422 แบบเดียว (ไม่บอกว่าทะเบียนหรือเบอร์ผิด — กันไล่เดาข้อมูล: review L3) · เหตุจริงลง audit (คงอยู่แม้ rollback)
    const miss =
      vs.length === 0
        ? 'vehicle_not_registered'
        : vs.length > 1
          ? 'plate_ambiguous'
          : !driver
            ? 'driver_not_registered'
            : null;
    if (miss) {
      await this.audit.recordDetached({
        action: 'subcon_offer.accept_failed',
        entityType: 'trip',
        entityId: o.tripId,
        after: {
          offerId: encodeId('subconOffer', o.id),
          cause: miss,
          vehiclePlate: body.vehiclePlate,
          driverName: body.driverName,
        },
      });
      throw field422(
        'vehiclePlate',
        'registration_mismatch',
        'vehicle plate or driver phone does not match the registered data of this carrier',
        'ทะเบียนหรือเบอร์คนขับไม่ตรงกับข้อมูลที่ลงทะเบียนไว้กับบริษัท',
      );
    }
    const vehicle = vs[0]!;
    const drv = driver!;

    // กดซ้ำ/refresh ด้วยรถ+คนขับเดิม = ผลเดิม
    const same = (x: {
      status: string;
      acceptedVehicleId: string | null;
      acceptedDriverId: string | null;
    }) =>
      x.status === 'ACCEPTED' &&
      x.acceptedVehicleId === vehicle.id &&
      x.acceptedDriverId === drv.id;
    if (o.status === 'ACCEPTED') {
      if (same(o)) return this.viewDto(tx, o);
      throw this.closed(o);
    }
    try {
      await this.trips.assign(
        o.tripId,
        { vehicleId: vehicle.id, driverId: drv.id },
        tx,
        undefined,
        { viaOffer: o.id },
      );
    } catch (e) {
      if (e instanceof ProblemException && e.code === 'assignment_blocked') {
        // PLN-152 [DECISION — แบบเข้ม]: แจ้งรถร่วมทันที "รถ/คนขับนี้รับงานไม่ได้: {เหตุผล} กรุณาเลือกคันอื่น"
        const blocks = ((e.extra?.blocks ?? []) as { message: string }[]).map((b) => b.message);
        throw new ProblemException(
          'assignment_blocked',
          `รถ/คนขับนี้รับงานไม่ได้: ${blocks.join(' · ')} กรุณาเลือกคันอื่น`,
          undefined,
          { reasons: blocks },
        );
      }
      if (e instanceof ProblemException && e.code === 'offer_closed') {
        // อีกเครื่องตอบก่อน — ถ้าเป็นการรับด้วยรถ/คนขับเดียวกัน = ผลเดิม
        const now = await this.load(tx, offerId);
        if (same(now)) return this.viewDto(tx, now);
        throw this.closed(now);
      }
      throw e;
    }
    await this.audit.record({
      action: 'subcon_offer.accepted',
      entityType: 'trip',
      entityId: o.tripId,
      after: {
        offerId: encodeId('subconOffer', o.id),
        vehiclePlate: vehicle.plate,
        driver: drv.name,
        // ชื่อที่รถร่วมพิมพ์ (ระบบใช้ชื่อตามที่ลงทะเบียน — review L4)
        typedDriverName: body.driverName,
        via: 'LINK',
      },
    });
    return this.viewDto(tx, await this.load(tx, offerId));
  }

  async reject(offerId: string, body: RejectOfferDto): Promise<OfferLinkViewDto> {
    const tx = this.db.tx;
    if (!isSubconRejectReason(body.reason))
      throw field422('reason', 'invalid_reason', 'unknown reject reason');
    const o = await this.load(tx, offerId);
    // กดซ้ำด้วยเหตุผลเดิม = ผลเดิม
    if (o.status === 'REJECTED' && o.rejectReasonCode === body.reason) return this.viewDto(tx, o);
    if (o.status !== 'OFFERED' || this.expired(o)) throw this.closed(o);
    try {
      await this.trips.rejectOffer(
        o.tripId,
        o.id,
        {
          reasonCode: body.reason,
          reasonLabel: subconRejectLabelTh(body.reason),
          note: body.note ?? null,
          via: 'LINK',
        },
        tx,
      );
    } catch (e) {
      if (e instanceof ProblemException && e.code === 'offer_closed') {
        const now = await this.load(tx, offerId);
        if (now.status === 'REJECTED' && now.rejectReasonCode === body.reason)
          return this.viewDto(tx, now);
        throw this.closed(now);
      }
      throw e;
    }
    return this.viewDto(tx, await this.load(tx, offerId));
  }

  // ---------- ฝั่งผู้จัดรถ ----------

  /** ลิงก์ที่ใช้ได้ของการจ้างที่ใช้งานอยู่ (รอตอบ/รับแล้ว) ของเที่ยว — ไม่มี = null · ช่องทางที่ส่งถึงรถร่วมรายนี้ได้ */
  async currentLink(tripId: string): Promise<{
    link: OfferLinkDto | null;
    podLink: OfferLinkDto | null;
    channels: { line: boolean; sms: boolean };
  }> {
    const tx = this.db.tx;
    const offer = await tx.subconOffer.findFirst({
      where: { tripId, status: { in: ['OFFERED', 'ACCEPTED'] } },
      orderBy: { offeredAt: 'desc' },
      select: { id: true, status: true, carrier: { select: { phone: true, lineContact: true } } },
    });
    if (!offer) return { link: null, podLink: null, channels: { line: false, sms: false } };
    const [l] = await this.links.active(tx, [offer.id]);
    // ST4-T08 ลิงก์งานหลังรับงาน (ค้น DO + กดถึง/ออก)
    const [pod] =
      offer.status === 'ACCEPTED'
        ? await this.links.active(tx, [offer.id], [POD_LINK_PURPOSE])
        : [];
    // ส่งได้ = ช่องเปิดใช้ + ผู้รับเหมามีผู้รับที่ส่งได้ (LINE userId / มือถือ — สูตรเดียวกับ /messages/send-link: QA L7)
    const open = new Set(
      (await this.messaging.channels()).filter((c) => c.available).map((c) => c.channel),
    );
    const mobile = /^0[689]\d{8}$/.test(phoneNorm((offer.carrier.phone ?? '').trim()));
    return {
      link: l ? this.linkDto(offer.id, l) : null,
      podLink: pod ? this.linkDto(offer.id, pod, true) : null,
      channels: {
        line:
          !!l && open.has('line') && LINE_USER_ID_RE.test((offer.carrier.lineContact ?? '').trim()),
        sms: !!l && open.has('sms') && mobile,
      },
    };
  }

  private linkDto(
    offerId: string,
    l: { id: string; expiresAt: Date; createdAt: Date },
    pod = false,
  ) {
    return {
      offerId: encodeId('subconOffer', offerId),
      linkId: encodeId('magicLink', l.id),
      url: pod ? this.links.podUrl(l) : this.links.url(l),
      expiresAt: l.expiresAt.toISOString(),
      issuedAt: l.createdAt.toISOString(),
    };
  }

  /**
   * ออกลิงก์ใหม่ (ลิงก์เดิมรั่ว/ส่งผิดคน): เพิกถอนลิงก์เดิม + ออกใหม่อายุเท่าเดิม (ไม่ต่อเวลาตอบ) · เฉพาะข้อเสนอที่ยังรอตอบ
   * ล็อกแถวการจ้างกันออกพร้อมกันสองครั้ง
   */
  async reissue(tripId: string): Promise<OfferLinkDto> {
    const tx = this.db.tx;
    const head = await tx.subconOffer.findFirst({
      where: { tripId, status: { in: ['OFFERED', 'ACCEPTED'] } },
      select: { id: true, status: true },
    });
    if (!head) throw new ProblemException('offer_closed');
    if (head.status === 'ACCEPTED') return this.reissuePod(tripId, head.id);
    await tx.$queryRaw`SELECT id FROM subcon_offer WHERE id = ${head.id}::uuid FOR UPDATE`;
    const o = await tx.subconOffer.findUniqueOrThrow({ where: { id: head.id } });
    if (o.status !== 'OFFERED' || this.expired(o)) throw this.closed(o);
    await this.links.revoke(tx, [o.id], 'REISSUED', tripId, [OFFER_LINK_PURPOSE]);
    const actor = requestContext.require().actorId ?? null;
    const l = await this.links.issue(tx, o, actor);
    await this.audit.record({
      action: 'subcon_offer.link_reissued',
      entityType: 'trip',
      entityId: tripId,
      after: { offerId: encodeId('subconOffer', o.id), linkId: encodeId('magicLink', l.id) },
    });
    return this.linkDto(o.id, { id: l.id, expiresAt: l.expiresAt, createdAt: new Date() });
  }

  /**
   * ST4-T08: รับงานแล้ว → ออกลิงก์งานใหม่ (ลิงก์เดิมรั่ว/หาย หรือรับงานก่อนมีลิงก์งาน) — เพิกถอนลิงก์งานเดิม + audit
   * เที่ยวจบ/ยกเลิกแล้ว → 409 `offer_closed`
   */
  private async reissuePod(tripId: string, offerId: string): Promise<OfferLinkDto> {
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM subcon_offer WHERE id = ${offerId}::uuid FOR UPDATE`;
    const o = await tx.subconOffer.findUniqueOrThrow({
      where: { id: offerId },
      include: { trip: { select: { status: true } } },
    });
    if (
      o.status !== 'ACCEPTED' ||
      !['ASSIGNED', 'DISPATCHED', 'IN_PROGRESS'].includes(o.trip.status)
    )
      throw this.closed(o);
    await this.links.revoke(tx, [o.id], 'POD_REISSUED', tripId, [POD_LINK_PURPOSE]);
    const l = await this.links.issuePod(tx, o, requestContext.require().actorId ?? null);
    await this.audit.record({
      action: 'subcon_offer.pod_link_reissued',
      entityType: 'trip',
      entityId: tripId,
      after: { offerId: encodeId('subconOffer', o.id), linkId: encodeId('magicLink', l.id) },
    });
    return this.linkDto(o.id, { id: l.id, expiresAt: l.expiresAt, createdAt: new Date() }, true);
  }

  /** ประวัติการจ้างของเที่ยว (ใหม่สุดก่อน) + การส่งลิงก์ทาง LINE/SMS */
  async history(tripId: string): Promise<SubconOfferDto[]> {
    const tx = this.db.tx;
    const rows = await tx.subconOffer.findMany({
      where: { tripId },
      orderBy: [{ offeredAt: 'desc' }, { id: 'desc' }],
    });
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const users = [...new Set(rows.flatMap((r) => (r.offeredBy ? [r.offeredBy] : [])))].filter(
      (x) => /^[0-9a-f-]{36}$/.test(x),
    );
    const [names, msgs] = await Promise.all([
      users.length
        ? tx.appUser.findMany({ where: { id: { in: users } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      tx.messageDelivery.findMany({
        where: { entityType: 'subcon_offer', entityId: { in: ids } },
        select: {
          id: true,
          entityId: true,
          channel: true,
          status: true,
          recipientMasked: true,
          createdAt: true,
          sentAt: true,
          errorCode: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const nameOf = new Map(names.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: encodeId('subconOffer', r.id),
      carrierId: encodeId('carrier', r.carrierId),
      carrierName: r.carrierNameSnapshot,
      status: this.expired(r) ? 'EXPIRED' : r.status,
      buyAmount: r.buyAmount.toFixed(2),
      offeredAt: r.offeredAt.toISOString(),
      offeredByName: r.offeredBy ? (nameOf.get(r.offeredBy) ?? null) : null,
      expiresAt: iso(r.expiresAt),
      viewedAt: iso(r.viewedAt),
      respondedAt: iso(r.respondedAt),
      respondedVia: r.respondedVia,
      rejectReason: r.rejectReasonCode,
      rejectNote: r.rejectNote,
      acceptedPlate: r.acceptedPlate,
      acceptedDriverName: r.acceptedDriverName,
      closedAt: iso(r.closedAt),
      closedReason: r.closedReason,
      messages: msgs
        .filter((m) => m.entityId === r.id)
        .map((m) => ({
          id: encodeId('messageDelivery', m.id),
          channel: MSG_CHANNEL[m.channel] ?? 'line',
          status: m.status.toLowerCase(),
          recipient: m.recipientMasked,
          createdAt: m.createdAt.toISOString(),
          sentAt: iso(m.sentAt),
          errorCode: m.errorCode,
        })),
    }));
  }
}
