import { Body, Controller, HttpCode, Injectable, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { eventDefinition } from '@tms/domain';
import { randomUUID } from 'node:crypto';
import {
  NoTransaction,
  RateLimitClass,
  RequireFeature,
  RequireScope,
  SandboxAware,
} from '../../common/decorators';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { OutboxDispatcher } from '../integration/outbox.dispatcher';
import { eventSample } from '../webhooks/event-openapi';
import {
  TriggerTestEventDto,
  TriggerTestEventResultDto,
  type TriggerDeliveryDto,
} from './test-events.dto';

/**
 * ยิง event จำลองใน sandbox (ST7-T09) — เขียน domain_event ของ sandbox (commit) → trigger ในฐานสร้างคำสั่ง outbox
 * ต่อ webhook endpoint ที่สมัคร → หยิบส่งทันทีผ่าน dispatcher ตัวเดียวกับ worker (lease/fencing/ลายเซ็น/บันทึกการส่ง/retry เดิม)
 * หยิบไม่ได้ (worker หยิบไปแล้ว/เต็มเพดานต่อปลายทาง) = worker ส่งให้ (`queued`)
 */
@Injectable()
export class TestEventsService {
  constructor(
    private readonly db: DbService,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  async trigger(type: string): Promise<TriggerTestEventResultDto> {
    const ctx = requestContext.require();
    if (!ctx.sandbox) throw new ProblemException('sandbox_only');
    const def = eventDefinition(type);
    if (!def || def.phase !== 'active')
      throw new ProblemException('validation_failed', undefined, [
        { field: 'type', code: 'event_type_not_active', message: 'event type is not active' },
      ]);
    const tenantId = ctx.tenantId!;
    const object = eventSample(def.type);
    const { ev, cmds } = await this.db.withTenant(tenantId, async (tx) => {
      const ev = await tx.domainEvent.create({
        data: {
          tenantId,
          type: def.type,
          entityType: def.resource,
          localId: randomUUID(),
          snapshot: object as object,
          previousAttributes: {},
          requestId: ctx.requestId,
          actorId: ctx.actorId ?? null,
        },
      });
      const cmds = await tx.integrationOutbox.findMany({
        where: { eventId: ev.id, kind: 'WEBHOOK' },
        select: { id: true, targetId: true },
        orderBy: { seq: 'asc' },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorId: ctx.actorId ?? null,
          actAs: ctx.actAs ?? null,
          action: 'sandbox.event_triggered',
          entityType: 'domain_event',
          entityId: ev.id,
          after: { type: def.type, eventId: encodeId('event', ev.id), queued: cmds.length },
          requestId: ctx.requestId,
          ip: ctx.ip ?? null,
        },
      });
      return { ev, cmds };
    });
    // ส่งจริงทันที (พร้อมกันทุก endpoint — แต่ละรายรอปลายทาง ≤ 10 วิ)
    await Promise.all(cmds.map((c) => this.dispatcher.runNow(c.id).catch(() => false)));
    const after = await this.db.withTenant(tenantId, async (tx) => ({
      del: await tx.webhookDelivery.findMany({
        where: { eventId: ev.id },
        orderBy: { sentAt: 'desc' },
      }),
      st: await tx.integrationOutbox.findMany({
        where: { id: { in: cmds.map((c) => c.id) } },
        select: { id: true, status: true },
      }),
    }));
    const deliveries: TriggerDeliveryDto[] = cmds.map((c) => {
      const d = after.del.find((x) => x.outboxId === c.id);
      const st = after.st.find((x) => x.id === c.id)?.status;
      return {
        endpointId: c.targetId ? encodeId('webhookEndpoint', c.targetId) : '',
        state: d
          ? d.status === 'DELIVERED'
            ? 'delivered'
            : 'failed'
          : st === 'SKIPPED'
            ? 'skipped'
            : 'queued',
        deliveryId: d ? encodeId('webhookDelivery', d.id) : null,
        status: d?.responseStatus ?? null,
      };
    });
    return {
      eventId: encodeId('event', ev.id),
      type: def.type,
      mode: 'test',
      queued: cmds.length,
      deliveries,
      object,
    };
  }
}

/**
 * ST7-T09 Sandbox — `POST /v1/test/events/trigger` (docs/04 G1, docs/01 §5.1, spec/07 INT-061)
 * ยิง event จำลองของ event สาธารณะที่ active ในทะเบียน (ST7-T06) ใน **sandbox เท่านั้น**:
 * เขียน domain_event ของ sandbox (`data.object` = ตัวอย่างตาม schema ที่เผยแพร่) → trigger ในฐานสร้างคำสั่ง outbox
 * ต่อ webhook endpoint ของ sandbox ที่สมัคร event นี้ → ส่งจริงทันที (ลายเซ็น/retry/ประวัติการส่งเหมือน live, envelope `mode: "test"`)
 * - เรียกได้ด้วย key `tk_test_` หรือผู้ใช้ที่สลับโหมด Sandbox (`X-Tms-Mode: test`) · live → 403 `sandbox_only`
 * - scope `settings:read` (อ่านการตั้งค่า webhook — ให้ API key ได้) · ฟีเจอร์ `api` · คำขอหนัก (5/s)
 */
@ApiTags('sandbox')
@ApiBearerAuth()
@RequireFeature('api')
@SandboxAware()
@Controller('test/events')
export class TestEventsController {
  constructor(private readonly svc: TestEventsService) {}

  @Post('trigger')
  @HttpCode(200)
  @NoTransaction()
  @RateLimitClass('heavy')
  @RequireScope('settings:read')
  @ApiOkResponse({
    type: TriggerTestEventResultDto,
    description:
      'ยิงแล้วและส่งไป endpoint ของ sandbox ที่สมัคร event นี้ทันที (รอผลต่อ endpoint ≤ 10 วิ — ล้มตามรอบ retry ปกติ; ' +
      'ดูทุกครั้งที่ `GET /v1/webhook-deliveries?eventId=`) · นอก sandbox → 403 `sandbox_only` · ' +
      'event ที่ไม่อยู่ในทะเบียน/ยังไม่เปิด (pending) → 422',
  })
  trigger(@Body() body: TriggerTestEventDto): Promise<TriggerTestEventResultDto> {
    return this.svc.trigger(body.type);
  }
}
