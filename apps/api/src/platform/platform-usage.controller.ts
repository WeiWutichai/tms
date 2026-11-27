import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, type Tenant } from '@prisma/client';
import { Clock } from '../common/clock';
import { PlatformAuth } from '../common/decorators';
import { decodeIdOr404, encodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { requestContext } from '../common/request-context';
import { PrismaService } from '../db/prisma.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import {
  ACTIVE_VEHICLES_METRIC,
  bangkokPeriod,
  readActiveVehicles,
  tallyActiveVehicles,
  type ActiveVehicleUsage,
} from '../modules/usage/active-vehicles';
import {
  ActiveVehicleQuery,
  AddActiveVehicleDto,
  PlatformActiveVehicleUsageDto,
  UsageAdjustReasonDto,
} from '../modules/usage/usage.dto';
import { plateNorm } from '../modules/vehicles/vehicles.service';
import { platformAudit } from './platform-audit';

/** ข้อความใน audit_log ของ tenant (ลูกค้าเห็น) — เหตุผลจริงอยู่ใน platform_audit_log เท่านั้น (แบบ PLT-066) */
export const USAGE_ADJUST_CUSTOMER_REASON = 'ทีมผู้ให้บริการปรับยอดรถ active หลังปิดยอดเดือน';

type Tx = Prisma.TransactionClient;

/**
 * การใช้งานของลูกค้าใน Platform Console (P1-ST1-T06; spec/01 §7 PLT-074 "หลัง finalize แก้ได้เฉพาะ finance ใน Console พร้อมเหตุผล")
 * - ดู: ทุก role ของ Console (ต้นแบบ Console แท็บ "การใช้งาน")
 * - ปรับ (เพิ่มทะเบียน / ตัดออก / นับกลับ): SUPER_ADMIN, BILLING (= การเงิน — docs/04 A6) เฉพาะเดือนที่ปิดยอดแล้ว
 *   (เดือนที่ยังเปิด ระบบนับจากเที่ยวเอง — 409 invalid_state_transition) · เหตุผล ≥ 10 ตัว
 * - audit: เหตุผลจริง → platform_audit_log · audit_log ของ tenant ลงข้อความกลาง (ลูกค้าไม่เห็นเหตุผลภายใน)
 * - ยอด `usage_record.value` คำนวณใหม่จากแถวรถทุกครั้ง (`detail.adjusted = true`) · ใบแจ้งหนี้ที่ออกแล้ว (invoiced) แก้ไม่ได้
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@Controller('platform/tenants')
export class PlatformUsageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly clock: Clock,
  ) {}

  @Get(':id/usage/active-vehicles')
  @PlatformAuth()
  @ApiOperation({ summary: 'รถ active ของลูกค้าต่อเดือน (รวมแถวที่ตัดออก)' })
  @ApiOkResponse({ type: PlatformActiveVehicleUsageDto })
  async list(
    @Param('id') id: string,
    @Query() q: ActiveVehicleQuery,
  ): Promise<PlatformActiveVehicleUsageDto> {
    const t = await this.tenant(id);
    const period = q.period ?? bangkokPeriod(this.clock.now());
    const u = await readActiveVehicles(this.prisma.platform as unknown as Tx, t.id, period, {
      includeExcluded: true,
    });
    return this.toDto(t, u);
  }

  @Post(':id/usage/active-vehicles')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN', 'BILLING')
  @ApiOperation({ summary: 'เพิ่มทะเบียนเข้าการนับของเดือนที่ปิดยอดแล้ว' })
  @ApiOkResponse({ type: PlatformActiveVehicleUsageDto })
  async add(
    @Param('id') id: string,
    @Body() body: AddActiveVehicleDto,
  ): Promise<PlatformActiveVehicleUsageDto> {
    const t = await this.tenant(id);
    const key = plateNorm(body.plate);
    if (!key)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'plate', code: 'plate_format', message: 'plate is empty after normalization' },
      ]);
    await this.adjust(t, body.period, body.reason, async (tx) => {
      const dup = await tx.activeVehicleUsage.findUnique({
        where: {
          tenantId_period_plateNormalized: {
            tenantId: t.id,
            period: body.period,
            plateNormalized: key,
          },
        },
      });
      if (dup) throw new ProblemException('duplicate');
      const row = await tx.activeVehicleUsage.create({
        data: {
          tenantId: t.id,
          period: body.period,
          plateNormalized: key,
          plate: body.plate,
          rule: 'manual',
          source: 'console',
          firstCountedAt: this.clock.now(),
        },
      });
      return { action: 'usage.active_vehicle_added', row: row.id, after: { plate: body.plate } };
    });
    return this.list(id, { period: body.period });
  }

  @Post(':id/usage/active-vehicles/:rowId/exclude')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN', 'BILLING')
  @ApiOperation({ summary: 'ตัดทะเบียนออกจากการนับของเดือนที่ปิดยอดแล้ว' })
  @ApiOkResponse({ type: PlatformActiveVehicleUsageDto })
  exclude(@Param('id') id: string, @Param('rowId') rowId: string, @Body() b: UsageAdjustReasonDto) {
    return this.toggle(id, rowId, b.reason, true);
  }

  @Post(':id/usage/active-vehicles/:rowId/include')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN', 'BILLING')
  @ApiOperation({ summary: 'นับทะเบียนที่ตัดออกกลับเข้าไป' })
  @ApiOkResponse({ type: PlatformActiveVehicleUsageDto })
  include(@Param('id') id: string, @Param('rowId') rowId: string, @Body() b: UsageAdjustReasonDto) {
    return this.toggle(id, rowId, b.reason, false);
  }

  private async toggle(id: string, rowId: string, reason: string, excluded: boolean) {
    const t = await this.tenant(id);
    const row = await this.prisma.platform.activeVehicleUsage.findFirst({
      where: { id: decodeIdOr404('activeVehicleUsage', rowId), tenantId: t.id },
    });
    if (!row) throw new ProblemException('not_found');
    await this.adjust(t, row.period, reason, async (tx) => {
      const r = await tx.activeVehicleUsage.updateMany({
        where: { id: row.id, excludedAt: excluded ? null : { not: null } },
        data: { excludedAt: excluded ? this.clock.now() : null },
      });
      if (r.count === 0) throw new ProblemException('invalid_state_transition');
      return {
        action: excluded ? 'usage.active_vehicle_excluded' : 'usage.active_vehicle_included',
        row: row.id,
        after: { plate: row.plate, excluded },
      };
    });
    return this.list(id, { period: row.period });
  }

  /** ปรับยอดเดือนที่ปิดแล้ว: lock เดียวกับ finalize → เปลี่ยนแถว → คำนวณยอดใหม่ → audit 2 ชั้น */
  private async adjust(
    t: Tenant,
    period: string,
    reason: string,
    change: (tx: Tx) => Promise<{ action: string; row: string; after: Record<string, unknown> }>,
  ) {
    await this.prisma.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20, hashtext(${`${t.id}:${period}`}))`;
      const rec = await tx.usageRecord.findUnique({
        where: {
          tenantId_metric_period: { tenantId: t.id, metric: ACTIVE_VEHICLES_METRIC, period },
        },
      });
      // เดือนที่ยังเปิด: ระบบนับจากเที่ยวเอง · ออกใบแจ้งหนี้แล้ว: ห้ามแก้ (แก้ด้วยเอกสารปรับยอดของรอบบิล — P1-ST3)
      if (!rec || rec.status !== 'finalized')
        throw new ProblemException('invalid_state_transition');
      const c = await change(tx);
      const n = await tallyActiveVehicles(tx, t.id, period);
      const detail = {
        ...((rec.detail as Record<string, unknown>) ?? {}),
        own: n.own,
        subcontract: n.sub,
        plateMissing: n.missing,
        adjusted: true,
      };
      await tx.usageRecord.update({
        where: { id: rec.id },
        data: {
          value: new Prisma.Decimal(n.total),
          detail: detail as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      await platformAudit(tx, {
        action: c.action,
        entityType: 'usage_record',
        entityId: encodeId('activeVehicleUsage', c.row),
        reason,
        before: { period, value: Number(rec.value) },
        after: { period, value: n.total, ...c.after, tenant: encodeId('tenant', t.id) },
      });
      const ctx = requestContext.require();
      await tx.auditLog.create({
        data: {
          tenantId: t.id,
          actorId: `platform:${ctx.platformUser!.id}`,
          action: 'platform.usage_adjusted',
          entityType: 'usage_record',
          entityId: rec.id,
          before: { metric: ACTIVE_VEHICLES_METRIC, period, value: Number(rec.value) },
          after: { metric: ACTIVE_VEHICLES_METRIC, period, value: n.total },
          reason: USAGE_ADJUST_CUSTOMER_REASON,
          requestId: ctx.requestId,
          ip: ctx.ip ?? null,
        },
      });
    });
  }

  private async tenant(id: string): Promise<Tenant> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: decodeIdOr404('tenant', id) },
    });
    if (!t || t.mode !== 'live') throw new ProblemException('not_found');
    return t;
  }

  private async toDto(t: Tenant, u: ActiveVehicleUsage): Promise<PlatformActiveVehicleUsageDto> {
    const limit = t.vehicleQuota ?? (await this.entitlements.resolve(t.id)).veh?.limit ?? null;
    return {
      period: u.period,
      status: u.status,
      finalizedAt: u.finalizedAt,
      activeVehicles: u.count,
      own: u.own,
      subcontract: u.subcontract,
      limit,
      data: u.items.map((i) => ({
        id: encodeId('activeVehicleUsage', i.rowId),
        plate: i.plate,
        plateMissing: i.plateMissing,
        subcontract: i.subcontract,
        vehicleType: i.vehicleType,
        carrierName: i.carrierName,
        trips: i.trips,
        firstTripId: i.firstTripId,
        firstTripNo: i.firstTripNo,
        firstCountedAt: i.firstCountedAt,
        adjusted: i.adjusted,
        excluded: i.excluded,
      })),
    };
  }
}
