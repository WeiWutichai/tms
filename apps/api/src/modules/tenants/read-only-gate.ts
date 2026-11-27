import { Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { PrismaService } from '../../db/prisma.service';

/** ไฟล์ที่แอปคนขับจองได้ระหว่าง read_only (review S1 — หลักฐานส่ง: รูป/ลายเซ็น) */
export const READ_ONLY_DOCUMENT_KINDS = ['POD_PHOTO', 'POD_SIGNATURE'] as const;

/**
 * P1-ST1-T03 (review S1 · spec/01 ตาราง 1.6 "แอปคนขับปิดงานที่จ่ายไปแล้ว + POD: read_only ✓ (งานที่ออกวิ่งก่อนเปลี่ยนสถานะ)")
 * route ที่ติด `@AllowReadOnlyTenant()` ผ่าน AuthGuard ได้ใน read_only — ตัวนี้ตรวจต่อว่าเป็นงานของเที่ยวที่ "ออกวิ่ง" แล้วก่อนเปลี่ยนสถานะ:
 * เที่ยว `IN_PROGRESS` และมี stop event แรกที่รับก่อน `tenant.statusChangedAt` · ไม่ใช่ → 403 `tenant_read_only`
 * สถานะอื่นไม่ทำอะไร (guard ตัดสินแล้ว) · หา resource ไม่เจอ = ปล่อยให้ service ตอบ 404 ตามเดิม
 * ใช้ client platform (หาเที่ยวจาก id ที่ AuthGuard/route ยืนยัน tenant แล้ว — ระบุ tenant_id ทุก query)
 */
@Injectable()
export class ReadOnlyTripGate {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.platform;
  }

  /** สถานะ (บริษัทจริงของ sandbox) + เวลาเปลี่ยนสถานะ — null = ไม่ใช่ read_only */
  private async readOnlySince(tenantId: string): Promise<Date | null> {
    const t = await this.db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        status: true,
        statusChangedAt: true,
        liveTenant: { select: { status: true, statusChangedAt: true } },
      },
    });
    const s = t?.liveTenant ?? t;
    return s?.status === 'READ_ONLY' ? (s.statusChangedAt ?? new Date(0)) : null;
  }

  private tenantId(): string {
    return requestContext.require().tenantId!;
  }

  /** เที่ยวออกวิ่งก่อน read_only หรือไม่ */
  async assertTrip(tenantId: string, tripId: string | null | undefined): Promise<void> {
    const since = await this.readOnlySince(tenantId);
    if (!since || !tripId) return;
    const trip = await this.db.trip.findFirst({
      where: { id: tripId, tenantId },
      select: { status: true },
    });
    if (!trip) return;
    const started =
      trip.status === 'IN_PROGRESS' &&
      (await this.db.stopEvent.count({
        where: { tenantId, tripId, receivedAt: { lt: since } },
      })) > 0;
    if (!started)
      throw new ProblemException('tenant_read_only', undefined, undefined, {
        tenantStatus: 'read_only',
      });
  }

  async forStop(stopId: string): Promise<void> {
    const tenantId = this.tenantId();
    if (!(await this.readOnlySince(tenantId))) return;
    const s = await this.db.tripStop.findFirst({
      where: { id: stopId, tenantId },
      select: { tripId: true },
    });
    if (s) await this.assertTrip(tenantId, s.tripId);
  }

  async forDeliveryOrder(doId: string): Promise<void> {
    const tenantId = this.tenantId();
    if (!(await this.readOnlySince(tenantId))) return;
    const d = await this.db.deliveryOrder.findFirst({
      where: { id: doId, tenantId },
      select: { tripId: true },
    });
    if (d) await this.assertTrip(tenantId, d.tripId);
  }

  /** ลิงก์ POD ของรถร่วม (ผูกกับการจ้าง = เที่ยวเดียว) */
  async forOffer(offerId: string): Promise<void> {
    const tenantId = this.tenantId();
    if (!(await this.readOnlySince(tenantId))) return;
    const o = await this.db.subconOffer.findFirst({
      where: { id: offerId, tenantId },
      select: { tripId: true },
    });
    if (o) await this.assertTrip(tenantId, o.tripId);
  }

  /** จองไฟล์ใน read_only ได้เฉพาะหลักฐานส่ง (รูป/ลายเซ็น) */
  async assertDocumentKind(kind: string): Promise<void> {
    if (!(await this.readOnlySince(this.tenantId()))) return;
    if (!(READ_ONLY_DOCUMENT_KINDS as readonly string[]).includes(kind))
      throw new ProblemException('tenant_read_only', undefined, undefined, {
        tenantStatus: 'read_only',
      });
  }
}
