import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { Connector, Tenant } from '@prisma/client';
import { CONNECTOR_STATUSES } from '@tms/domain';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PlatformAuth, StepUpAlways, StepUpWhen } from '../common/decorators';
import { assertStepUp } from '../auth/step-up';
import { expectedVersion } from '../common/etag';
import { decodeIdOr404, encodeId } from '../common/ids';
import { ProblemException } from '../common/problem';
import { type RequestContext, requestContext } from '../common/request-context';
import { DbService } from '../db/db.service';
import { PrismaService } from '../db/prisma.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { NotificationEvents } from '../modules/notifications/notification-events';
import {
  ConnectorCommandDto,
  ConnectorCommandQuery,
  ConnectorDto,
  ConnectorHealthDto,
  CreateConnectorDto,
  ErpAdapterListDto,
} from '../modules/erp/connector.dto';
import { commandDto, ConnectorsService } from '../modules/erp/connectors.service';
import { CleanText } from '../modules/master/master-kit';

/** spec/01 §10: ทุกการเปลี่ยนข้อมูลลูกค้าจาก Console ต้องมีเหตุผล ≥ 10 ตัว + audit (PLT-004) */
class PlatformReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลูกค้าส่ง API key ใหม่ทาง ticket #4412' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class PlatformCreateConnectorDto extends CreateConnectorDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'เปิด connector ให้ลูกค้านำร่องตามสัญญา' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'true = ทดสอบการเชื่อมต่อแล้วเปิดใช้ทันที (ไม่ผ่าน → คงเป็น PAUSED และตอบ `activation` = ผลที่ล้ม)',
  })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}

export class PlatformCredentialsDto extends PlatformReasonDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'credential ชุดใหม่ (แทนทั้งชุด) — เก็บเข้ารหัส ไม่ส่งกลับ',
  })
  @IsObject()
  credentials!: Record<string, string>;
}

export class PlatformConnectorActionDto extends PlatformReasonDto {}

export class PlatformConnectorQuery {
  @ApiPropertyOptional({ example: 'ten_…' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tenantId?: string;

  @ApiPropertyOptional({
    enum: CONNECTOR_STATUSES,
    description: 'ไม่ระบุ = ทุกสถานะยกเว้น DISCONNECTED',
  })
  @IsOptional()
  @IsIn(CONNECTOR_STATUSES)
  status?: string;
}

export class PlatformCommandQuery extends ConnectorCommandQuery {
  @ApiPropertyOptional({ example: 'ten_…' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tenantId?: string;

  @ApiPropertyOptional({ example: 'con_…' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  connectorId?: string;
}

export class PlatformQueueCountDto {
  @ApiProperty({ description: 'รอส่ง/กำลังส่ง/รอส่งซ้ำ' }) open!: number;
  @ApiProperty({ description: 'ล้มเหลวขั้นสุดท้าย' }) failed!: number;
}

export class PlatformConnectorDto extends ConnectorDto {
  @ApiProperty({ example: 'ten_…' }) tenantId!: string;
  @ApiProperty() tenantName!: string;
  @ApiProperty({ type: PlatformQueueCountDto }) queue!: PlatformQueueCountDto;
}

export class PlatformConnectorListDto {
  @ApiProperty({ type: [PlatformConnectorDto] }) data!: PlatformConnectorDto[];
}

export class PlatformActivationDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty({ nullable: true, type: String }) code!: string | null;
}

export class PlatformConnectorCreatedDto extends PlatformConnectorDto {
  @ApiProperty({
    nullable: true,
    type: PlatformActivationDto,
    description: 'ผลการเปิดใช้เมื่อส่ง `activate: true` (null = ไม่ได้ขอ)',
  })
  activation!: PlatformActivationDto | null;
}

export class PlatformCommandDto extends ConnectorCommandDto {
  @ApiProperty({ example: 'ten_…' }) tenantId!: string;
  @ApiProperty() tenantName!: string;
  @ApiProperty({ example: 'con_…' }) connectorId!: string;
  @ApiProperty({ example: 'demo' }) adapterKey!: string;
}

export class PlatformCommandListDto {
  @ApiProperty({ type: [PlatformCommandDto] }) data!: PlatformCommandDto[];
}

const OPEN = ['PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'] as const;
const IF_MATCH = {
  name: 'If-Match',
  required: false,
  description: 'ETag/version ของ connector — ไม่ตรง → 412',
};
type Change = 'created' | 'credentials' | 'resumed' | 'paused' | 'error' | 'recovered';

/**
 * Connectors ใน Platform Console (ST7-T20; docs/02 §5 "Connectors", docs/04 G3/A6)
 * - ทีม Innovera เปิด connector ให้ tenant, ใส่/หมุน credential, ทดสอบ, เปิด/หยุด, ดูคิว (outbox sink `erp`) ข้าม tenant
 * - ทุกการเปลี่ยนเรียก ConnectorsService ตัวเดียวกับ `/v1/connectors` ภายใต้ tenant นั้น (RLS + กฎเดียวกัน: แพ็กเกจ `conn`, limit,
 *   1 ตัวต่อนิติบุคคล, credential เข้ารหัสไม่ส่งกลับ, เปิดใช้ต้องทดสอบผ่าน) · audit ลง audit_log ของ tenant (actor `platform:<id>`)
 *   ให้ owner เห็นในประวัติของ connector (spec/01 §11.5) · ต้องมีเหตุผล ≥ 10 ตัวทุกการเปลี่ยน (PLT-004)
 * - สิทธิ์ [DECISION spec/12 §3]: ดู = ทุก role · เปลี่ยน/ทดสอบ = SUPER_ADMIN (SUPPORT อ่านอย่างเดียว — docs/04 A6)
 * - sandbox (`mode = test`) ไม่แสดง/ไม่รับ (ตาม ST7-T09 — connector ใช้ได้เฉพาะบริษัทจริง)
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@Controller('platform')
export class PlatformConnectorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly connectors: ConnectorsService,
    private readonly entitlements: EntitlementService,
    private readonly events: NotificationEvents,
  ) {}

  @Get('connectors/adapters')
  @PlatformAuth()
  @ApiOkResponse({ type: ErpAdapterListDto })
  adapters(): ErpAdapterListDto {
    return { data: this.connectors.adapterCatalog() };
  }

  @Get('connectors')
  @PlatformAuth()
  @ApiOkResponse({ type: PlatformConnectorListDto })
  async list(@Query() q: PlatformConnectorQuery): Promise<PlatformConnectorListDto> {
    const db = this.prisma.platform;
    const tenantId = q.tenantId ? decodeIdOr404('tenant', q.tenantId) : undefined;
    const rows = await db.connector.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        ...(q.status
          ? { status: q.status as Connector['status'] }
          : { status: { not: 'DISCONNECTED' } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 500,
    });
    const tenants = await db.tenant.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] }, mode: 'live' },
    });
    const live = new Map(tenants.map((t) => [t.id, t]));
    const shown = rows.filter((r) => live.has(r.tenantId));
    const queue = await this.queueOf(shown.map((r) => r.id));
    return {
      data: shown.map((r) => this.toDto(r, live.get(r.tenantId)!, queue.get(r.id))),
    };
  }

  /** คิวคำสั่ง (outbox sink `erp`) ข้าม tenant — ใหม่สุดก่อน · ไม่มี payload (request/response log = ST7-T19) */
  @Get('connectors/commands')
  @PlatformAuth()
  @ApiOkResponse({ type: PlatformCommandListDto })
  async commands(@Query() q: PlatformCommandQuery): Promise<PlatformCommandListDto> {
    const db = this.prisma.platform;
    const tenantId = q.tenantId ? decodeIdOr404('tenant', q.tenantId) : undefined;
    const connectorId = q.connectorId ? decodeIdOr404('connector', q.connectorId) : undefined;
    const rows = await db.integrationOutbox.findMany({
      where: {
        sink: 'erp',
        ...(tenantId ? { tenantId } : {}),
        ...(connectorId ? { targetId: connectorId } : {}),
        ...(q.status ? { status: q.status as 'PENDING' } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      take: q.limit ?? 50,
    });
    const ids = [...new Set(rows.map((r) => r.targetId).filter((x): x is string => !!x))];
    const [cons, tenants] = await Promise.all([
      db.connector.findMany({
        where: { id: { in: ids.filter((x) => UUID.test(x)) } },
        select: { id: true, adapterKey: true },
      }),
      db.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] }, mode: 'live' },
        select: { id: true, name: true },
      }),
    ]);
    const con = new Map(cons.map((c) => [c.id, c.adapterKey]));
    const ten = new Map(tenants.map((t) => [t.id, t.name]));
    return {
      data: rows
        .filter((r) => ten.has(r.tenantId))
        .map((r) => ({
          ...commandDto(r),
          tenantId: encodeId('tenant', r.tenantId),
          tenantName: ten.get(r.tenantId)!,
          connectorId: r.targetId ? encodeId('connector', r.targetId) : '',
          adapterKey: (r.targetId && con.get(r.targetId)) || '',
        })),
    };
  }

  /** เปิด connector ให้ tenant (สร้างเป็น PAUSED — `activate: true` = ทดสอบแล้วเปิดใช้ทันทีถ้าผ่าน) */
  @Post('tenants/:id/connectors')
  @PlatformAuth('SUPER_ADMIN')
  @StepUpWhen('ส่ง `credentials` หรือ `settings` มาด้วย (D-77)', 'platform')
  @ApiCreatedResponse({
    type: PlatformConnectorCreatedDto,
    description:
      'แพ็กเกจไม่มีการเชื่อมต่อ → 403 `feature_not_in_plan` · นิติบุคคลเดียวกันมีแล้ว → 409 `connector_scope_taken` · เกิน limit → 409 `connector_limit_reached`',
  })
  async create(
    @Param('id') id: string,
    @Body() body: PlatformCreateConnectorDto,
  ): Promise<PlatformConnectorCreatedDto> {
    const t = await this.tenant(id);
    if (t.status === 'CANCELLED') throw new ProblemException('invalid_state_transition');
    if (!(await this.entitlements.enabled(t.id, 'conn')))
      throw new ProblemException('feature_not_in_plan', undefined, undefined, { feature: 'conn' });
    const { reason, activate, ...input } = body;
    // D-77 (PO 23 พ.ย. 2569): ใส่ credential / ค่าตั้ง (เช่น baseUrl = ปลายทางที่ credential ถูกส่งไป) ตอนเปิด → step-up ของ Console
    if (hasKeys(input.credentials) || hasKeys(input.settings)) assertStepUp();
    const created = await this.asTenant(t.id, true, () => this.connectors.create(input, reason));
    let row = created;
    let activation: PlatformActivationDto | null = null;
    if (activate) {
      try {
        row = await this.asTenant(t.id, false, () =>
          this.connectors.resume(created.id, { reason }, created.version),
        );
        activation = { ok: true, code: null };
      } catch (e) {
        if (!(e instanceof ProblemException) || e.code !== 'connector_health_failed') throw e;
        row = await this.connector(created.id);
        const err = (row.lastHealthError ?? null) as { code?: string } | null;
        activation = { ok: false, code: err?.code ?? 'health_failed' };
      }
    }
    await this.notify(t.id, row, activation?.ok ? 'resumed' : 'created', reason);
    return { ...this.toDto(row, t, { open: 0, failed: 0 }), activation };
  }

  /** ใส่/หมุน credential (แทนทั้งชุด) — ไม่ส่งกลับ · audit มีแค่ชื่อช่อง + เหตุผล */
  @Put('connectors/:id/credentials')
  @PlatformAuth('SUPER_ADMIN')
  @StepUpAlways('platform') // D-77
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({ type: PlatformConnectorDto })
  async credentials(
    @Param('id') id: string,
    @Body() body: PlatformCredentialsDto,
    @Req() req: Request,
  ): Promise<PlatformConnectorDto> {
    const { c, t } = await this.target(id);
    assertStepUp(); // D-77 — ตรวจหลัง validation/404
    const row = await this.asTenant(t.id, true, () =>
      this.connectors.setCredentials(
        c.id,
        { credentials: body.credentials, reason: body.reason },
        expectedVersion(req),
      ),
    );
    await this.notify(t.id, row, 'credentials', body.reason);
    return this.withQueue(row, t);
  }

  @Post('connectors/:id/health')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN')
  @ApiOkResponse({ type: ConnectorHealthDto, description: 'ทดสอบการเชื่อมต่อ (เหมือนของ tenant)' })
  async health(@Param('id') id: string): Promise<ConnectorHealthDto> {
    const { c, t } = await this.target(id);
    const r = await this.asTenant(t.id, false, () => this.connectors.health(c.id));
    // สถานะเปลี่ยนจากการทดสอบ (ACTIVE → ERROR / ERROR → ACTIVE) = แจ้ง owner ด้วย
    if (r.connector.status !== c.status) {
      const row = await this.connector(c.id);
      await this.notify(
        t.id,
        row,
        row.status === 'ERROR' ? 'error' : 'recovered',
        'healthCheck (Platform Console)',
      );
    }
    return r;
  }

  @Post('connectors/:id/resume')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN')
  @ApiOkResponse({
    type: PlatformConnectorDto,
    description: 'เปิดใช้หลังทดสอบผ่าน · ไม่ผ่าน → 409 `connector_health_failed`',
  })
  @ApiHeader(IF_MATCH)
  async resume(
    @Param('id') id: string,
    @Body() body: PlatformConnectorActionDto,
    @Req() req: Request,
  ): Promise<PlatformConnectorDto> {
    const { c, t } = await this.target(id);
    const row = await this.asTenant(t.id, false, () =>
      this.connectors.resume(c.id, { reason: body.reason }, expectedVersion(req)),
    );
    await this.notify(t.id, row, 'resumed', body.reason);
    return this.withQueue(row, t);
  }

  @Post('connectors/:id/pause')
  @HttpCode(200)
  @PlatformAuth('SUPER_ADMIN')
  @ApiOkResponse({ type: PlatformConnectorDto })
  @ApiHeader(IF_MATCH)
  async pause(
    @Param('id') id: string,
    @Body() body: PlatformConnectorActionDto,
    @Req() req: Request,
  ): Promise<PlatformConnectorDto> {
    const { c, t } = await this.target(id);
    const row = await this.asTenant(t.id, true, () =>
      this.connectors.pause(c.id, { reason: body.reason }, expectedVersion(req)),
    );
    await this.notify(t.id, row, 'paused', body.reason);
    return this.withQueue(row, t);
  }

  // ---------- helpers ----------

  /**
   * เรียก ConnectorsService ในฐานะ tenant นั้น: context ใหม่ (tenantId + actor `platform:<id>` เดิม) และ
   * `tx = true` = transaction ที่ตั้ง app.tenant_id (RLS) ให้ `db.tx` · `false` = service เปิด transaction เอง (route @NoTransaction ฝั่ง tenant)
   */
  private asTenant<T>(tenantId: string, tx: boolean, fn: () => Promise<T>): Promise<T> {
    const ctx: RequestContext = { ...requestContext.require(), tenantId, tx: undefined };
    return requestContext.run(ctx, () =>
      tx
        ? this.db.withTenant(tenantId, async (t) => {
            ctx.tx = t;
            try {
              return await fn();
            } finally {
              ctx.tx = undefined;
            }
          })
        : fn(),
    );
  }

  private async tenant(id: string): Promise<Tenant> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: decodeIdOr404('tenant', id) },
    });
    if (!t || t.mode !== 'live') throw new ProblemException('not_found');
    return t;
  }

  private async connector(id: string): Promise<Connector> {
    const c = await this.prisma.platform.connector.findUnique({ where: { id } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  /** connector + บริษัทของมัน สำหรับการเปลี่ยน — บริษัทที่ปิดบัญชีแล้ว (CANCELLED) เปลี่ยนไม่ได้ (เหมือนตอนเปิด) */
  private async target(id: string): Promise<{ c: Connector; t: Tenant }> {
    const c = await this.connector(decodeIdOr404('connector', id));
    const t = await this.prisma.platform.tenant.findUnique({ where: { id: c.tenantId } });
    if (!t || t.mode !== 'live') throw new ProblemException('not_found');
    if (t.status === 'CANCELLED') throw new ProblemException('invalid_state_transition');
    return { c, t };
  }

  /** แจ้ง owner ของบริษัท (ในระบบ + อีเมล) หลังทีมงานเปลี่ยน connector — ล้มแล้วไม่กระทบการเปลี่ยน */
  private async notify(tenantId: string, c: Connector, action: Change, reason: string) {
    await this.db.withTenant(tenantId, (tx) =>
      this.events.connectorChangedByPlatform(tx, {
        tenantId,
        connectorId: c.id,
        label: this.connectors.toDto(c).displayName ?? c.adapterKey,
        action,
        reason,
      }),
    );
  }

  private async queueOf(ids: string[]): Promise<Map<string, PlatformQueueCountDto>> {
    const out = new Map<string, PlatformQueueCountDto>();
    if (!ids.length) return out;
    const g = await this.prisma.platform.integrationOutbox.groupBy({
      by: ['targetId', 'status'],
      where: { sink: 'erp', targetId: { in: ids }, status: { in: [...OPEN, 'FAILED_FINAL'] } },
      _count: { _all: true },
    });
    for (const r of g) {
      if (!r.targetId) continue;
      const q = out.get(r.targetId) ?? { open: 0, failed: 0 };
      if (r.status === 'FAILED_FINAL') q.failed += r._count._all;
      else q.open += r._count._all;
      out.set(r.targetId, q);
    }
    return out;
  }

  private async withQueue(c: Connector, t: Tenant): Promise<PlatformConnectorDto> {
    return this.toDto(c, t, (await this.queueOf([c.id])).get(c.id));
  }

  private toDto(c: Connector, t: Tenant, queue?: PlatformQueueCountDto): PlatformConnectorDto {
    return {
      ...this.connectors.toDto(c),
      tenantId: encodeId('tenant', t.id),
      tenantName: t.name,
      queue: queue ?? { open: 0, failed: 0 },
    };
  }
}

/** target_id ของ sink `erp` = uuid ของ connector (กันค่าอื่นที่ไม่ใช่ uuid ทำให้ query ล้ม) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** มีอย่างน้อย 1 ช่อง (D-77 — เหมือน D-67 ฝั่ง tenant) */
function hasKeys(o: object | null | undefined): boolean {
  return !!o && Object.keys(o).length > 0;
}
