import { Controller, Get, Header, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { MonitorAlert } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Clock } from '../../common/clock';
import { PlatformAuth, Public } from '../../common/decorators';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { PrismaService } from '../../db/prisma.service';
import { AvailabilityService, bangkokMonthOf } from './availability.service';
import { httpMetrics } from './http-metrics';
import { MonitorCollector } from './monitor-collector';
import { RULE_UNIT, type RuleKey } from './monitor-config';
import { renderPrometheus } from './prometheus';

class ReadinessDto {
  @ApiProperty({ enum: ['ok', 'degraded', 'down'], example: 'ok' })
  status!: string;
  @ApiProperty({ enum: ['ok', 'down'] })
  db!: string;
  @ApiProperty({ enum: ['ok', 'pending', 'failed', 'unknown'] })
  migrations!: string;
  @ApiProperty({ enum: ['ok', 'stale', 'missing', 'unknown'] })
  worker!: string;
  @ApiProperty({ type: Number, nullable: true, example: 12 })
  workerHeartbeatAgeSec!: number | null;
}

/** token ของตัวเก็บ metrics (Prometheus) — ไม่ตั้ง = ปิด endpoint (404) */
function metricsAuthorized(req: Request): boolean {
  const want = process.env.METRICS_TOKEN ?? '';
  if (!want) throw new ProblemException('not_found');
  if (want.length < 24) throw new ProblemException('not_found', 'METRICS_TOKEN ต้องยาว ≥ 24 ตัว');
  const h = req.header('authorization') ?? '';
  const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const exp = Buffer.from(want);
  return got.length === exp.length && timingSafeEqual(got, exp);
}

/**
 * ST9-T19 health / readiness / metrics (ใช้โดยระบบเฝ้าดู ไม่ใช่ UI)
 * - `/v1/healthz` liveness: process ตอบได้ (ไม่แตะฐาน)
 * - `/v1/readyz` readiness: ฐานข้อมูล + migration ครบ (503 ถ้าไม่พร้อม) · worker หยุด = `degraded` (ยัง 200)
 * - `/v1/metrics` Prometheus text — ต้องส่ง `Authorization: Bearer <METRICS_TOKEN>` (ไม่ตั้ง = 404) และควรจำกัดเครือข่ายที่ proxy ด้วย
 */
@ApiTags('platform')
@Controller()
export class MonitoringController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly collector: MonitorCollector,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  @Get('healthz')
  @Public()
  @ApiOperation({ summary: 'Liveness — process ทำงาน (ไม่ตรวจฐานข้อมูล)' })
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  healthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  @ApiOperation({
    summary: 'Readiness — ฐานข้อมูล + migration + heartbeat ของ worker',
    description:
      '200 = รับคำขอได้ (`degraded` = worker ไม่ส่ง heartbeat เกิน 3 นาที — งานเบื้องหลังหยุด แต่ API ใช้ได้) · 503 = ฐานข้อมูลล่ม/migration ไม่ครบ',
  })
  @ApiOkResponse({ type: ReadinessDto })
  @ApiResponse({ status: 503, type: ReadinessDto, description: 'ไม่พร้อม (ฐานข้อมูล/migration)' })
  async readyz(@Res({ passthrough: true }) res: Response): Promise<ReadinessDto> {
    const r = await this.availability.readiness(this.clock.now());
    if (r.status === 'down') res.status(503);
    res.setHeader('Cache-Control', 'no-store');
    return r;
  }

  @Get('metrics')
  @Public()
  @ApiBearerAuth()
  @ApiProduces('text/plain')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Metrics (Prometheus text format) สำหรับระบบเฝ้าดูของ Innovera',
    description:
      'ต้องส่ง `Authorization: Bearer <METRICS_TOKEN>` (env ≥ 24 ตัว) — ไม่ตั้ง env = 404 · ควรเปิดเฉพาะเครือข่ายภายในที่ proxy · label ไม่มีชื่อบริษัท/ผู้ใช้ (connector ใช้รหัส `con_…`) · ตัวนับ HTTP เป็นของ instance ที่ตอบ (ตัวเก็บต้อง scrape ทุก instance)',
  })
  @ApiOkResponse({
    content: { 'text/plain': { schema: { type: 'string', example: 'tms_up 1\n' } } },
  })
  async metrics(@Req() req: Request): Promise<string> {
    if (!metricsAuthorized(req)) throw new ProblemException('unauthorized');
    const now = this.clock.now();
    const month = bangkokMonthOf(now);
    const [snap, avail, alerts] = await Promise.all([
      this.collector.collect(now),
      this.availability.monthly(month, now),
      this.prisma.platform.monitorAlert.findMany({
        where: { status: 'OPEN' },
        select: { rule: true, subject: true, severity: true },
        orderBy: { key: 'asc' },
      }),
    ]);
    return renderPrometheus(snap, httpMetrics, {
      month,
      availabilityRatio: avail.availabilityPct === null ? null : avail.availabilityPct / 100,
      alerts,
    });
  }
}

class AlertListQuery {
  @ApiPropertyOptional({ enum: ['open', 'resolved', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['open', 'resolved', 'all'])
  status?: 'open' | 'resolved' | 'all';
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class AvailabilityQuery {
  @ApiPropertyOptional({
    example: '2026-11',
    description: 'เดือนตามเวลาไทย (ไม่ส่ง = เดือนปัจจุบัน)',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}

export class MonitorAlertDto {
  @ApiProperty({ example: 'alr_0f8fad5bd9cb469fa165a7f2c4b1e0a1' })
  id!: string;
  @ApiProperty({ example: 'outbox_lag:webhook' })
  key!: string;
  @ApiProperty({ example: 'outbox_lag' })
  rule!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'webhook',
    description: 'sink / รหัส connector',
  })
  subject!: string | null;
  @ApiProperty({ enum: ['critical', 'warning'] })
  severity!: string;
  @ApiProperty({ enum: ['open', 'resolved'] })
  status!: string;
  @ApiProperty({ enum: ['seconds', 'ratio', 'count', 'flag'] })
  unit!: string;
  @ApiProperty({ example: 300 })
  threshold!: number;
  @ApiProperty({ example: 420 })
  openValue!: number;
  @ApiProperty({ example: 480 })
  lastValue!: number;
  @ApiProperty()
  openedAt!: Date;
  @ApiProperty()
  lastSeenAt!: Date;
  @ApiProperty({ type: Date, nullable: true })
  resolvedAt!: Date | null;
  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'เวลาที่อีเมลแจ้งทีมเข้าคิว/ส่ง (null = ไม่มีผู้รับ)',
  })
  notifiedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true })
  resolveNotifiedAt!: Date | null;
}

export class MonitorCheckDto {
  @ApiProperty({ example: 'job_lag' })
  key!: string;
  @ApiProperty({ example: 'job_lag' })
  rule!: string;
  @ApiProperty({ type: String, nullable: true })
  subject!: string | null;
  @ApiProperty({ enum: ['ok', 'pending', 'firing'] })
  state!: string;
  @ApiProperty({ enum: ['seconds', 'ratio', 'count', 'flag'] })
  unit!: string;
  @ApiProperty({ type: Number, nullable: true })
  value!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  threshold!: number | null;
  @ApiProperty()
  evaluatedAt!: Date;
}

export class MonthlyAvailabilityDto {
  @ApiProperty({ example: '2026-11' })
  month!: string;
  @ApiProperty({ example: 99.5 })
  targetPct!: number;
  @ApiProperty({ type: Date, nullable: true })
  measuredFrom!: Date | null;
  @ApiProperty({ type: Date, nullable: true })
  measuredTo!: Date | null;
  @ApiProperty({ description: 'นาทีในช่วงที่วัด' })
  minutes!: number;
  @ApiProperty()
  upMinutes!: number;
  @ApiProperty()
  downMinutes!: number;
  @ApiProperty({ description: 'นาทีที่ไม่มีผล probe — นับเป็นล่ม' })
  missingMinutes!: number;
  @ApiProperty({ type: Number, nullable: true, example: 99.93 })
  availabilityPct!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 100 })
  coveragePct!: number | null;
  @ApiProperty({ type: Boolean, nullable: true })
  met!: boolean | null;
}

export class MonitoringStatusDto {
  @ApiProperty()
  at!: Date;
  @ApiProperty({ type: ReadinessDto })
  readiness!: ReadinessDto;
  @ApiProperty({ type: MonthlyAvailabilityDto })
  availability!: MonthlyAvailabilityDto;
  @ApiProperty({ description: 'alert ที่เปิดอยู่' })
  openAlerts!: number;
  @ApiProperty({ type: [MonitorCheckDto] })
  checks!: MonitorCheckDto[];
}

const toAlertDto = (a: MonitorAlert): MonitorAlertDto => ({
  id: encodeId('monitorAlert', a.id),
  key: a.key,
  rule: a.rule,
  subject: a.subject,
  severity: a.severity,
  status: a.status.toLowerCase(),
  unit: RULE_UNIT[a.rule as RuleKey] ?? 'count',
  threshold: a.threshold,
  openValue: a.openValue,
  lastValue: a.lastValue,
  openedAt: a.openedAt,
  lastSeenAt: a.lastSeenAt,
  resolvedAt: a.resolvedAt,
  notifiedAt: a.notifiedAt,
  resolveNotifiedAt: a.resolveNotifiedAt,
});

/**
 * ST9-T19 Platform Console — สุขภาพระบบ (docs/02 §5 Health) · ทีม SUPER_ADMIN / SUPPORT
 * ต้นแบบ Platform Console ยังไม่มีหน้านี้ → มีแค่ API + อีเมล (spec/12 §3 แถว ST9-T19)
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform/monitoring')
export class PlatformMonitoringController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly clock: Clock,
  ) {}

  @Get('status')
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  @ApiOperation({
    summary:
      'สถานะระบบ: readiness, availability เดือนนี้, เงื่อนไขเฝ้าดูทั้งหมด (รอบประเมินล่าสุด)',
  })
  @ApiOkResponse({ type: MonitoringStatusDto })
  async status(): Promise<MonitoringStatusDto> {
    const now = this.clock.now();
    const [readiness, availability, openAlerts, checks] = await Promise.all([
      this.availability.readiness(now),
      this.availability.monthly(bangkokMonthOf(now), now),
      this.prisma.platform.monitorAlert.count({ where: { status: 'OPEN' } }),
      this.prisma.platform.monitorCheck.findMany({ orderBy: { key: 'asc' } }),
    ]);
    return {
      at: now,
      readiness,
      availability,
      openAlerts,
      checks: checks.map((c) => ({
        key: c.key,
        rule: c.rule,
        subject: c.subject,
        state: c.state.toLowerCase(),
        unit: RULE_UNIT[c.rule as RuleKey] ?? 'count',
        value: c.lastValue,
        threshold: c.threshold,
        evaluatedAt: c.lastEvalAt,
      })),
    };
  }

  @Get('alerts')
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  @ApiOperation({ summary: 'alert ล่าสุด (เปิดก่อน แล้วตามเวลาเกิดใหม่สุด)' })
  @ApiOkResponse({ type: [MonitorAlertDto] })
  async alerts(@Query() q: AlertListQuery): Promise<MonitorAlertDto[]> {
    const status = q.status ?? 'all';
    const rows = await this.prisma.platform.monitorAlert.findMany({
      where: status === 'all' ? {} : { status: status.toUpperCase() },
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }, { id: 'asc' }],
      take: q.limit ?? 50,
    });
    return rows.map(toAlertDto);
  }

  @Get('availability')
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  @ApiOperation({
    summary: 'availability รายเดือน (เป้า 99.5%)',
    description:
      'จาก self-probe `/v1/readyz` ทุก 1 นาที · นาทีที่ไม่มีผล probe นับเป็นล่ม · ยังไม่หัก maintenance ตามแผน (NFR-902)',
  })
  @ApiOkResponse({ type: MonthlyAvailabilityDto })
  async monthly(@Query() q: AvailabilityQuery): Promise<MonthlyAvailabilityDto> {
    const now = this.clock.now();
    return this.availability.monthly(q.month ?? bangkokMonthOf(now), now);
  }
}
