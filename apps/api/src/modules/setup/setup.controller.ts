import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { RequireScope } from '../../common/decorators';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';

/**
 * ขั้นตาม backlog ST1-T21 / docs/04 A5 (องค์กร → สาขา → เลขเอกสาร → ภาษี → import master → เชิญทีม → connector)
 * — ต้นแบบ/spec/01 §4 ใช้ชุดอื่น (รถ คนขับ SO แรก) ซึ่งยังไม่มีในเฟสนี้ [OPEN spec/12 §3, PROGRESS ข้อ 19]
 */
export const SETUP_STEPS = [
  'org',
  'branch',
  'numbering',
  'tax',
  'import',
  'team',
  'connector',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
const OPTIONAL: SetupStep[] = ['connector'];
const SAVED = ['tenant_setting.updated', 'tenant_setting.reviewed'];

export class SetupStepDto {
  @ApiProperty({ enum: SETUP_STEPS }) key!: SetupStep;
  @ApiProperty({ enum: ['todo', 'done', 'skipped'] }) status!: 'todo' | 'done' | 'skipped';
  @ApiProperty() required!: boolean;
}
export class SetupChecklistDto {
  @ApiProperty({ type: [SetupStepDto] }) steps!: SetupStepDto[];
  @ApiProperty({ description: 'จำนวนขั้นที่เสร็จหรือข้ามแล้ว' }) done!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ description: 'ครบทุกขั้นบังคับแล้ว (การ์ดหายถาวร — PLT-041)' })
  completed!: boolean;
  @ApiProperty({ description: 'ผู้ใช้คนนี้กดซ่อนการ์ด' }) hidden!: boolean;
}
export class SkipConnectorDto {
  @ApiProperty({ example: 'ใช้ TMS ออกเอกสารเอง ไม่เชื่อมระบบบัญชี' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/**
 * Setup checklist (ST1-T21; docs/04 A5, spec/01 §4) — เฉพาะผู้ตั้งค่าบริษัทได้ (settings:write)
 * สถานะทุกขั้นคำนวณจากข้อมูลจริงทุกครั้งที่เรียก (PLT-040): ทำเสร็จแล้ว % เพิ่มเอง ไม่ต้องติ๊ก
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('setup-checklist')
export class SetupChecklistController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireScope('settings:write')
  @ApiOkResponse({ type: SetupChecklistDto })
  async get(): Promise<SetupChecklistDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const state = await this.state(tx, ctx.tenantId!);
    const done = await this.compute(tx, state.connectorSkippedAt !== null);
    const steps = SETUP_STEPS.map((key) => ({
      key,
      status: done[key],
      required: !OPTIONAL.includes(key),
    }));
    let completedAt = state.completedAt;
    // ครบขั้นบังคับครั้งแรก → บันทึกถาวร + audit `setup.completed` (ใช้วัด activation — PLT-041)
    if (!completedAt && steps.every((s) => !s.required || s.status !== 'todo')) {
      completedAt = new Date();
      await tx.setupChecklistState.update({
        where: { tenantId: ctx.tenantId! },
        data: { completedAt },
      });
      await this.audit.record({
        action: 'setup.completed',
        entityType: 'tenant',
        entityId: ctx.tenantId!,
      });
    }
    return {
      steps,
      done: steps.filter((s) => s.status !== 'todo').length,
      total: steps.length,
      completed: completedAt !== null,
      hidden: !!ctx.actorId && state.hiddenFor.includes(ctx.actorId),
    };
  }

  /** ขั้นเชื่อมระบบบัญชีไม่บังคับ — "ไม่เชื่อม ใช้ TMS ออกเอกสารเอง" (spec/01 §4 ขั้น 6) */
  @Post('connector-skip')
  @HttpCode(200)
  @RequireScope('settings:write')
  @ApiOkResponse({ type: SetupChecklistDto })
  async skipConnector(@Body() body: SkipConnectorDto): Promise<SetupChecklistDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const s = await this.state(tx, ctx.tenantId!);
    if (!s.connectorSkippedAt) {
      await tx.setupChecklistState.update({
        where: { tenantId: ctx.tenantId! },
        data: { connectorSkippedAt: new Date() },
      });
      await this.audit.record({
        action: 'setup.connector_skipped',
        entityType: 'tenant',
        entityId: ctx.tenantId!,
        reason: body.reason,
      });
    }
    return this.get();
  }

  /** ซ่อนการ์ดเฉพาะผู้ใช้คนนี้ (spec/01 §4 ปุ่ม "ซ่อน") */
  @Post('hide')
  @HttpCode(200)
  @RequireScope('settings:write')
  @ApiOkResponse({ type: SetupChecklistDto })
  async hide(): Promise<SetupChecklistDto> {
    return this.setHidden(true);
  }

  /** แสดงการ์ดอีกครั้ง (เมนูช่วยเหลือ — ภายหลัง) */
  @Post('show')
  @HttpCode(200)
  @RequireScope('settings:write')
  @ApiOkResponse({ type: SetupChecklistDto })
  async show(): Promise<SetupChecklistDto> {
    return this.setHidden(false);
  }

  private async setHidden(hidden: boolean): Promise<SetupChecklistDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const s = await this.state(tx, ctx.tenantId!);
    const me = ctx.actorId;
    if (me && /^[0-9a-f-]{36}$/i.test(me)) {
      const next = hidden
        ? [...new Set([...s.hiddenFor, me])]
        : s.hiddenFor.filter((x) => x !== me);
      await tx.setupChecklistState.update({
        where: { tenantId: ctx.tenantId! },
        data: { hiddenFor: next },
      });
    }
    return this.get();
  }

  private async state(tx: Tx, tenantId: string) {
    return (
      (await tx.setupChecklistState.findUnique({ where: { tenantId } })) ??
      (await tx.setupChecklistState.upsert({
        where: { tenantId },
        create: { tenantId },
        update: {},
      }))
    );
  }

  /** ตรวจแต่ละขั้นจากข้อมูลจริง (RLS จำกัดเฉพาะ tenant นี้) */
  private async compute(
    tx: Tx,
    connectorSkipped: boolean,
  ): Promise<Record<SetupStep, 'todo' | 'done' | 'skipped'>> {
    const yes = (b: boolean) => (b ? 'done' : 'todo') as 'done' | 'todo';
    const [orgSaved, taxSaved, branches, numbering, imported, masters, team] = await Promise.all([
      // ผู้ใช้บันทึกหน้าตั้งค่ากลุ่มนั้นแล้ว (เปลี่ยนค่า หรือกดบันทึกยืนยันค่าเริ่มต้น)
      tx.auditLog.count({ where: { action: { in: SAVED }, entityId: { startsWith: 'org.' } } }),
      tx.auditLog.count({ where: { action: { in: SAVED }, entityId: { startsWith: 'tax.' } } }),
      tx.branch.findMany({ select: { address: true } }),
      tx.auditLog.count({ where: { action: 'document_series.updated' } }),
      tx.importJob.count({
        where: { status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] }, importedRows: { gt: 0 } },
      }),
      Promise.all([
        tx.customer.count(),
        tx.carrier.count(),
        tx.vehicle.count(),
        tx.driver.count(),
      ]).then((c) => c.reduce((a, b) => a + b, 0)),
      tx.appUser.count({ where: { status: { in: ['ACTIVE', 'INVITED'] }, deletedAt: null } }),
    ]);
    const complete = (a: unknown) => {
      const x = (a ?? {}) as Record<string, unknown>;
      return ['line1', 'province', 'postcode'].every(
        (k) => typeof x[k] === 'string' && (x[k] as string).trim() !== '',
      );
    };
    return {
      org: yes(orgSaved > 0),
      branch: yes(branches.length > 0 && branches.every((b) => complete(b.address))),
      numbering: yes(numbering > 0),
      tax: yes(taxSaved > 0),
      import: yes(imported > 0 || masters > 0),
      team: yes(team >= 2),
      connector: connectorSkipped ? 'skipped' : 'todo',
    };
  }
}
