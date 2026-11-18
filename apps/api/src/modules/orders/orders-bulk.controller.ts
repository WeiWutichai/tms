import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  IdempotencyLockMs,
  NoTransaction,
  RateLimitClass,
  RequireScope,
} from '../../common/decorators';
import { ApiProblems } from '../../common/problem.dto';
import {
  BulkJobAcceptedDto,
  BulkOrderResultsDto,
  BulkOrdersDto,
  ORDERS_BULK_MAX,
} from './order-bulk.dto';
import { OrderBulkService } from './order-bulk.service';

const P = (code: string, status: number, title: string, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title,
  status,
  code,
  instance: '/v1/orders:bulk',
  requestId: 'b6a1c2d3-…',
  ...extra,
});

/** เวลาจอง Idempotency-Key ของ bulk (ST7-T10) */
const BULK_IDEMPOTENCY_LOCK_MS = 10 * 60_000;

/** `Prefer: respond-async` (RFC 7240) — ขอให้ทำเป็น job */
function wantsAsync(req: Request): boolean {
  return (req.header('prefer') ?? '')
    .split(',')
    .some((p) => p.trim().split(';')[0]!.trim().toLowerCase() === 'respond-async');
}

/**
 * Bulk / async สาธารณะ (ST7-T10; docs/04 G1 "Bulk / async", docs/01 §5.1) — path แบบ custom method `orders:bulk`
 * (ไม่ชนกับ `/orders/{id}`) · แต่ละรายการใช้ทางเดียวกับ `POST /v1/orders`
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller()
export class OrdersBulkController {
  constructor(private readonly bulk: OrderBulkService) {}

  @Post('orders\\:bulk')
  @NoTransaction() // แต่ละรายการ commit ใน transaction ของตัวเอง (ไม่ใช่ทั้งชุด)
  @RateLimitClass('heavy')
  // คำขอ sync 200 ใบใช้หลายวินาทีถึงหลายสิบวินาที — จอง key 10 นาที (ค่าเริ่ม 60 วิ สั้นไป: ส่งซ้ำระหว่างทำจะทำซ้อน)
  @IdempotencyLockMs(BULK_IDEMPOTENCY_LOCK_MS)
  @RequireScope('orders:write')
  @HttpCode(207)
  @ApiOperation({
    summary: 'สร้าง/อัปเดตใบสั่งขนส่งหลายใบ (≤ 200) — 207 ผลต่อรายการ หรือ 202 job',
    description:
      `แต่ละรายการ = \`POST /v1/orders\` หนึ่งครั้ง (ตรวจรูปแบบ, สิทธิ์ราคา, จับคู่, ราคา, ใบค้าง, event \`order.created\`) ` +
      `ใน transaction ของตัวเอง — รายการที่ไม่ผ่านไม่ย้อนรายการอื่น · ใบที่มี \`externalId\` ของใบเดิม = อัปเดตใบเดิม (ส่งซ้ำไม่เกิดใบซ้ำ) · ` +
      `ทั้งคำขอ 422 เฉพาะ \`items\` ไม่ใช่ array / ว่าง / เกิน ${ORDERS_BULK_MAX} รายการ · body ไม่เกิน 1 MB · ` +
      'นับเป็นคำขอหนัก (rate limit ชั้น heavy) · ' +
      'ส่ง header `Prefer: respond-async` = ทำเป็น job → 202 `{jobId, statusUrl}` → `GET /v1/jobs/{id}` ' +
      '(`result` = รูปเดียวกับ 207; ทุกรายการผ่าน = `succeeded`, มีรายการไม่ผ่าน = `succeeded_with_errors`) + webhook `job.completed` · ' +
      'job เก็บ 7 วันหลังจบ',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (207 เดิม หรือ 202 jobId เดิม พร้อม `Preference-Applied` เดิม) + `Idempotent-Replayed: true` · ' +
      '**header `Prefer` ไม่นับเป็นส่วนของคำขอ** — key เดิมได้ผลของคำขอแรกเสมอ แม้ครั้งหลังส่ง/ไม่ส่ง `Prefer` ต่างไป · ' +
      'ระหว่างที่คำขอแรกยังทำอยู่ (จองไว้ 10 นาที) ส่งซ้ำ = 409 `idempotency_in_progress` · เก็บ 24 ชม.',
  })
  @ApiHeader({
    name: 'Prefer',
    required: false,
    description:
      '`respond-async` (RFC 7240) = ทำเป็น job → 202 + `Preference-Applied: respond-async` · ไม่ส่ง/ค่าอื่น = ทำทันที (207) · ' +
      'ผู้สั่งดู `statusUrl` ได้แม้ไม่มีสิทธิ์ `jobs:read`',
  })
  @ApiResponse({
    status: 207,
    type: BulkOrderResultsDto,
    description: 'ผลต่อรายการ เรียงตาม items[]',
  })
  @ApiResponse({
    status: 202,
    type: BulkJobAcceptedDto,
    description: '`Prefer: respond-async` — รับงานแล้ว ติดตามที่ `statusUrl`',
    headers: {
      'Preference-Applied': {
        description: '`respond-async` (มีทั้งตอนตอบครั้งแรกและตอน replay ด้วย Idempotency-Key)',
        schema: { type: 'string', example: 'respond-async' },
      },
    },
  })
  @ApiProblems(
    {
      status: 400,
      description: 'JSON เสีย / Idempotency-Key ผิดรูป',
      examples: { bad_request: P('bad_request', 400, 'คำขอไม่ถูกต้อง') },
    },
    {
      status: 403,
      description: 'ไม่มีสิทธิ์ `orders:write` / ส่งราคาโดยไม่มีสิทธิ์แก้ราคา',
      examples: {
        permission_denied: P('permission_denied', 403, 'ไม่มีสิทธิ์ทำรายการนี้', {
          module: 'orders',
          action: 'write',
          required: ['orders:write'],
        }),
      },
    },
    {
      status: 409,
      description: '`idempotency_in_progress` — คำขอเดียวกันกำลังทำอยู่',
      examples: {
        idempotency_in_progress: P('idempotency_in_progress', 409, 'คำขอเดียวกันกำลังประมวลผลอยู่'),
      },
    },
    {
      status: 413,
      description: 'body ใหญ่เกิน 1 MB',
      examples: {
        payload_too_large: P('payload_too_large', 413, 'ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด'),
      },
    },
    {
      status: 422,
      description: '`items` ไม่ใช่ array / ว่าง / เกิน 200 · `idempotency_mismatch`',
      examples: {
        validation_failed: P('validation_failed', 422, 'ข้อมูลไม่ถูกต้อง', {
          errors: [
            {
              field: 'items',
              code: 'arrayMaxSize',
              message: 'items must contain no more than 200 elements',
            },
          ],
        }),
        idempotency_mismatch: P(
          'idempotency_mismatch',
          422,
          'Idempotency-Key นี้เคยใช้กับข้อมูลอื่น',
        ),
      },
    },
  )
  async create(
    @Body() body: BulkOrdersDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BulkOrderResultsDto | BulkJobAcceptedDto> {
    if (wantsAsync(req)) {
      res.status(202);
      res.setHeader('Preference-Applied', 'respond-async');
      return this.bulk.enqueue(body.items);
    }
    return this.bulk.runNow(body.items);
  }
}
