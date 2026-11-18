import { Injectable, type OnModuleInit } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { encodeId } from '../../common/ids';
import { assertPriceWriteAllowed } from '../../common/price-fields';
import { ProblemException } from '../../common/problem';
import { problemBody } from '../../common/problem-body';
import { requestContext, type RequestContext } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation';
import { DbService, type Tx } from '../../db/db.service';
import { requestActor, resolveJobActor, type JobActor } from '../../jobs/job-actor';
import { JobOutcome, JobQueue } from '../../jobs/job-queue.service';
import type { BulkOrderResultDto, BulkOrderResultsDto } from './order-bulk.dto';
import { CreateOrderDto, type SoStatusValue } from './order.dto';
import { OrdersService } from './orders.service';

export const ORDERS_BULK_JOB = 'orders.bulk';

/** ตัวตรวจ body เดียวกับ global pipe (whitelist + forbidNonWhitelisted + transform) — ใช้กับทีละรายการ */
const PIPE = createValidationPipe();

interface BulkJobPayload {
  items: Record<string, unknown>[];
  actor: JobActor;
  locale: 'th' | 'en';
}

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * Bulk ใบสั่งขนส่ง (ST7-T10; docs/04 G1 "Bulk / async", docs/01 §5.1)
 * - แต่ละรายการ = คำขอ `POST /v1/orders` หนึ่งครั้ง: ตรวจ DTO ด้วย pipe เดียวกัน → สิทธิ์ราคา → `OrdersService.create`
 *   (→ `OrderIntakeService.upsertOrder` ทางเขียนเดียว) **ใน transaction ของตัวเอง** — รายการที่ไม่ผ่านไม่ย้อนรายการอื่น
 *   และรายการที่ผ่านแล้ว commit ทันที (event/webhook `order.created` ต่อใบเหมือนคำขอเดี่ยว)
 * - ทำตามลำดับใน `items[]` (externalId ซ้ำในชุดเดียวกัน = ตัวหลังอัปเดตใบของตัวแรก — 200)
 * - async (`Prefer: respond-async`): job `orders.bulk` รันโค้ดเดียวกันในชื่อผู้สั่ง (scope ตอนสั่ง ∩ สิทธิ์ปัจจุบัน)
 */
@Injectable()
export class OrderBulkService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrdersService,
    private readonly queue: JobQueue,
  ) {}

  onModuleInit() {
    this.queue.register(
      ORDERS_BULK_JOB,
      async ({ tenantId, job, withTx, progress }) => {
        // ล้ม/หมด lease กลางงาน = บางรายการ commit ไปแล้ว — ไม่ทำซ้ำ (รายการที่ไม่มี externalId จะเกิดใบซ้ำ)
        if (job.attempts > 1)
          throw new Error('bulk job interrupted — not re-run; check orders by externalId');
        const p = job.payload as unknown as BulkJobPayload;
        const actor = await withTx((tx) => resolveJobActor(tx, p.actor ?? {}));
        const ctx: RequestContext = {
          requestId: `job:${encodeId('job', job.id)}`,
          tenantId,
          locale: p.locale === 'en' ? 'en' : 'th',
          ...(actor.actorId ? { actorId: actor.actorId } : {}),
          scopes: actor.scopes,
          principalType: actor.principalType ?? 'user',
          ...(actor.actAs ? { actAs: actor.actAs } : {}),
          ...(actor.ip ? { ip: actor.ip } : {}),
        };
        const items = Array.isArray(p.items) ? p.items : [];
        const out = await requestContext.run(ctx, () =>
          this.run(items, withTx, (done) => progress((done * 100) / Math.max(1, items.length))),
        );
        return new JobOutcome(out, out.failed ? 'SUCCEEDED_WITH_ERRORS' : 'SUCCEEDED');
      },
      // ไม่ถือ transaction ยาว (แต่ละรายการเปิดเอง) · ล้มแล้วไม่ลองใหม่ (ดูข้างบน) · จบ = webhook `job.completed`
      { outsideTransaction: true, publicEvent: true },
    );
  }

  /** ทำทันทีใน request (route ติด @NoTransaction — แต่ละรายการเปิด transaction ของ tenant เอง) */
  runNow(items: Record<string, unknown>[]): Promise<BulkOrderResultsDto> {
    const tenantId = requestContext.require().tenantId!;
    return this.run(items, (fn) => this.db.withTenant(tenantId, fn));
  }

  /** ส่งเป็น job — คืน jobId (ตรวจรายการตอนรัน) */
  async enqueue(items: Record<string, unknown>[]): Promise<{ jobId: string; statusUrl: string }> {
    const ctx = requestContext.require();
    const payload: BulkJobPayload = {
      items,
      // actorId ดิบ (API client / dev token ไม่ใช่ uuid) — audit ของแต่ละใบลงชื่อผู้สั่งเดียวกับคำขอเดี่ยว
      actor: { ...requestActor(), actorId: ctx.actorId ?? null },
      locale: ctx.locale,
    };
    const job = await this.db.withTenant(ctx.tenantId!, (tx) =>
      this.queue.enqueue(tx, {
        tenantId: ctx.tenantId!,
        type: ORDERS_BULK_JOB,
        payload,
        maxAttempts: 1,
      }),
    );
    const jobId = encodeId('job', job.id);
    return { jobId, statusUrl: `/v1/jobs/${jobId}` };
  }

  private async run(
    items: Record<string, unknown>[],
    withTx: WithTx,
    onProgress?: (done: number) => Promise<void>,
  ): Promise<BulkOrderResultsDto> {
    const results: BulkOrderResultDto[] = [];
    for (let i = 0; i < items.length; i++) {
      results.push(await this.one(items[i], i, withTx));
      // อัปเดตทุก 10 รายการ (เขียนด้วย connection แยก — ไม่ต้องทุกใบ)
      if (onProgress && (i + 1) % 10 === 0) await onProgress(i + 1);
    }
    const succeeded = results.filter((r) => r.outcome !== 'FAILED').length;
    return { results, total: results.length, succeeded, failed: results.length - succeeded };
  }

  private async one(item: unknown, index: number, withTx: WithTx): Promise<BulkOrderResultDto> {
    const ext =
      item &&
      typeof item === 'object' &&
      typeof (item as { externalId?: unknown }).externalId === 'string'
        ? ((item as { externalId: string }).externalId as string)
        : null;
    try {
      const ctx = requestContext.require();
      // สิทธิ์เดียวกับ POST /v1/orders (job: ผู้สั่งอาจถูกถอดสิทธิ์ระหว่างรอ)
      if (!scopeAllows(ctx.scopes ?? [], 'orders:write'))
        throw new ProblemException('permission_denied', undefined, undefined, {
          module: 'orders',
          action: 'write',
          required: ['orders:write'],
        });
      const dto = (await PIPE.transform(item, {
        type: 'body',
        metatype: CreateOrderDto,
      })) as CreateOrderDto;
      assertPriceWriteAllowed(dto, ctx);
      const r = await withTx((tx) =>
        requestContext.run({ ...ctx, tx }, () => this.orders.create(dto)),
      );
      return {
        index,
        status: r.created ? 201 : 200,
        outcome: r.created ? 'CREATED' : 'UPDATED',
        id: encodeId('salesOrder', r.order.id),
        soNo: r.order.soNo,
        orderStatus: r.order.status.toLowerCase() as SoStatusValue,
        externalId: r.order.externalId,
        holdCodes: r.holds.map((h) => h.code),
        problem: null,
      };
    } catch (e) {
      const problem = problemBody(e);
      return {
        index,
        status: problem.status,
        outcome: 'FAILED',
        id: null,
        soNo: null,
        orderStatus: null,
        externalId: ext,
        holdCodes: [],
        problem,
      };
    }
  }
}
