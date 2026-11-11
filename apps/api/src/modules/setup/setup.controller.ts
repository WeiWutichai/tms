import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { RequireScope } from '../../common/decorators';
import { ProblemException } from '../../common/problem';
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
/** ขั้นที่ค่าเริ่มต้นใช้ได้เลย — ผู้ใช้ยืนยันได้โดยไม่ต้องเปลี่ยนค่า */
export const REVIEWABLE = ['org', 'tax', 'numbering'] as const;

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
export class ReviewStepDto {
  @ApiProperty({ enum: REVIEWABLE }) @IsIn([...REVIEWABLE]) step!: (typeof REVIEWABLE)[number];
}

type Status = 'todo' | 'done' | 'skipped';

/**
 * Setup checklist (ST1-T21; docs/04 A5, spec/01 §4) — เฉพาะผู้ตั้งค่าบริษัทได้ (settings:write = owner/admin ตาม A3)
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
    const tenantId = ctx.tenantId!;
    const state = await this.state(tx, tenantId);
    const hidden = !!ctx.actorId && state.hiddenFor.includes(ctx.actorId);
    // ครบแล้ว = การ์ดหายถาวร ไม่ต้องนับอะไรอีก (หน้าภาพรวมเรียกทุกครั้งที่เปิด)
    if (state.completedAt) {
      const steps = SETUP_STEPS.map((key) => ({
        key,
        status: (key !== 'connector'
          ? 'done'
          : state.connectorSkippedAt
            ? 'skipped'
            : 'todo') as Status,
        required: !OPTIONAL.includes(key),
      }));
      return this.dto(steps, true, hidden);
    }
    const done = await this.compute(tx, state);
    const steps = SETUP_STEPS.map((key) => ({
      key,
      status: done[key],
      required: !OPTIONAL.includes(key),
    }));
    let completed = false;
    if (steps.every((s) => !s.required || s.status !== 'todo')) {
      // ครั้งแรกที่ครบ → บันทึกถาวร + audit `setup.completed` ครั้งเดียว (PLT-041) — updateMany แบบมีเงื่อนไข
      // กัน request พร้อมกันบันทึกซ้ำ (แถวถูกล็อกแล้วตรวจเงื่อนไขใหม่)
      const r = await tx.setupChecklistState.updateMany({
        where: { tenantId, completedAt: null },
        data: { completedAt: new Date() },
      });
      if (r.count === 1)
        await this.audit.record({
          action: 'setup.completed',
          entityType: 'tenant',
          entityId: tenantId,
        });
      completed = true;
    }
    return this.dto(steps, completed, hidden);
  }

  /** ยืนยันค่าเริ่มต้นของขั้น org / tax / numbering (หน้าตั้งค่าเรียกเมื่อกดบันทึกโดยไม่เปลี่ยนค่า หรือเปิดหน้าเลขเอกสาร) */
  @Post('reviewed')
  @HttpCode(200)
  @RequireScope('settings:write')
  @ApiOkResponse({ type: SetupChecklistDto })
  async reviewed(@Body() body: ReviewStepDto): Promise<SetupChecklistDto> {
    const tx = this.db.tx;
    const tenantId = requestContext.require().tenantId!;
    await this.state(tx, tenantId);
    const n = await tx.$executeRaw`
      UPDATE setup_checklist_state
         SET reviewed_steps = array_append(reviewed_steps, ${body.step}), updated_at = now()
       WHERE tenant_id = ${tenantId}::uuid AND NOT (${body.step} = ANY(reviewed_steps))`;
    if (n === 1)
      await this.audit.record({
        action: 'setup.step_reviewed',
        entityType: 'tenant',
        entityId: tenantId,
        after: { step: body.step },
      });
    return this.get();
  }

  /** ขั้นเชื่อมระบบบัญชีไม่บังคับ — "ไม่เชื่อม ใช้ TMS ออกเอกสารเอง" (spec/01 §4 ขั้น 6) */
  @Post('connector-skip')
  @HttpCode(200)
  @RequireScope('settings:write')
  @ApiOkResponse({ type: SetupChecklistDto })
  async skipConnector(@Body() body: SkipConnectorDto): Promise<SetupChecklistDto> {
    const tx = this.db.tx;
    const tenantId = requestContext.require().tenantId!;
    await this.state(tx, tenantId);
    const r = await tx.setupChecklistState.updateMany({
      where: { tenantId, connectorSkippedAt: null },
      data: { connectorSkippedAt: new Date() },
    });
    if (r.count === 1)
      await this.audit.record({
        action: 'setup.connector_skipped',
        entityType: 'tenant',
        entityId: tenantId,
        reason: body.reason,
      });
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
    const me = ctx.actorId;
    // ซ่อนได้เฉพาะผู้ใช้จริง (API key ไม่มีหน้าภาพรวม)
    if (!me || !/^[0-9a-f-]{36}$/i.test(me))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'actor',
          code: 'user_required',
          message: 'only a signed-in user can hide the card',
        },
      ]);
    const tenantId = ctx.tenantId!;
    await this.state(tx, tenantId);
    // แก้ array ในคำสั่งเดียว — สองคนกดพร้อมกันไม่ทับกัน
    if (hidden)
      await tx.$executeRaw`
        UPDATE setup_checklist_state
           SET hidden_for = array_append(hidden_for, ${me}::uuid), updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid AND NOT (${me}::uuid = ANY(hidden_for))`;
    else
      await tx.$executeRaw`
        UPDATE setup_checklist_state
           SET hidden_for = array_remove(hidden_for, ${me}::uuid), updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid`;
    return this.get();
  }

  private dto(steps: SetupStepDto[], completed: boolean, hidden: boolean): SetupChecklistDto {
    return {
      steps,
      done: steps.filter((s) => s.status !== 'todo').length,
      total: steps.length,
      completed,
      hidden,
    };
  }

  /** แถวสถานะของ tenant — สร้างครั้งแรกด้วย ON CONFLICT DO NOTHING (เปิดหลายแท็บพร้อมกันไม่ชนกัน) */
  private async state(tx: Tx, tenantId: string) {
    const found = await tx.setupChecklistState.findUnique({ where: { tenantId } });
    if (found) return found;
    await tx.$executeRaw`
      INSERT INTO setup_checklist_state (tenant_id, updated_at) VALUES (${tenantId}::uuid, now())
      ON CONFLICT (tenant_id) DO NOTHING`;
    return (await tx.setupChecklistState.findUnique({ where: { tenantId } }))!;
  }

  /** ตรวจแต่ละขั้นจากข้อมูลจริง (RLS จำกัดเฉพาะ tenant นี้) — findFirst หยุดที่แถวแรก, กรอง entityType ให้ใช้ index */
  private async compute(
    tx: Tx,
    state: { connectorSkippedAt: Date | null; reviewedSteps: string[] },
  ): Promise<Record<SetupStep, Status>> {
    const yes = (b: boolean) => (b ? 'done' : 'todo') as Status;
    const reviewed = (s: string) => state.reviewedSteps.includes(s);
    const changed = (entityType: string, action: string, prefix?: string) =>
      tx.auditLog
        .findFirst({
          where: { entityType, action, ...(prefix ? { entityId: { startsWith: prefix } } : {}) },
          select: { id: true },
        })
        .then(Boolean);
    const [org, tax, numbering, branchBad, branchAny, imported, master, team] = await Promise.all([
      reviewed('org') || changed('tenant_setting', 'tenant_setting.updated', 'org.'),
      reviewed('tax') || changed('tenant_setting', 'tenant_setting.updated', 'tax.'),
      reviewed('numbering') || changed('document_series', 'document_series.updated'),
      // ที่อยู่ไม่ครบ (ข้อมูลเก่า/นำเข้า — API สร้างสาขาบังคับที่อยู่ครบแล้ว)
      tx.$queryRaw<{ n: number }[]>`
        SELECT 1 AS n FROM branch
         WHERE coalesce(trim(address->>'line1'), '') = ''
            OR coalesce(trim(address->>'province'), '') = ''
            OR coalesce(trim(address->>'postcode'), '') = ''
         LIMIT 1`.then((r) => r.length > 0),
      tx.branch.findFirst({ select: { id: true } }).then(Boolean),
      tx.importJob
        .findFirst({
          where: {
            status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] },
            importedRows: { gt: 0 },
          },
          select: { id: true },
        })
        .then(Boolean),
      Promise.all([
        tx.customer.findFirst({ select: { id: true } }),
        tx.carrier.findFirst({ select: { id: true } }),
        tx.vehicle.findFirst({ select: { id: true } }),
        tx.driver.findFirst({ select: { id: true } }),
      ]).then((r) => r.some(Boolean)),
      // ทีม = ผู้ใช้ที่ใช้งานอยู่ + ผู้ถูกเชิญที่คำเชิญยังใช้ได้ (หมดอายุ/เพิกถอนแล้วไม่นับ)
      tx.appUser.count({
        where: {
          deletedAt: null,
          OR: [
            { status: 'ACTIVE' },
            {
              status: 'INVITED',
              invitations: {
                some: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
              },
            },
          ],
        },
        take: 2,
      }),
    ]);
    return {
      org: yes(org),
      branch: yes(branchAny && !branchBad),
      numbering: yes(numbering),
      tax: yes(tax),
      import: yes(imported || master),
      team: yes(team >= 2),
      connector: state.connectorSkippedAt ? 'skipped' : 'todo',
    };
  }
}
