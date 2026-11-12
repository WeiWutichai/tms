import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { ifMatch, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import {
  CreateOrderDto,
  OrderDto,
  OrderListQuery,
  OrderPageDto,
  UpdateOrderDto,
  UpsertOrderDto,
} from './order.dto';
import { OrdersService, toOrderDto } from './orders.service';
import type { UpsertOrderResult } from './order-intake.service';

const LOCKED_DOC =
  '409 `order_locked_for_update` — แก้ช่องที่สถานะไม่อนุญาต (errors[] = ช่อง, `editableFields` = ช่องที่แก้ได้): ' +
  'ก่อนวางแผนแก้ได้ทุกช่อง · PLANNED แก้ได้เฉพาะช่วงเวลาของจุด + customerRef · ตั้งแต่ in_transit แก้ได้เฉพาะ customerRef · ' +
  'ปิดงาน/ยกเลิกแก้ไม่ได้ · 409 `external_id_conflict` — externalId นี้เป็นของใบจากช่องทางอื่น';

const P = (code: string, status: number, title: string, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title,
  status,
  code,
  instance: '/v1/orders/ord_3f2a…',
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const E403 = {
  status: 403,
  description: 'ไม่มีสิทธิ์ (`orders:read` / `orders:write`)',
  examples: {
    permission_denied: P('permission_denied', 403, 'ไม่มีสิทธิ์ทำรายการนี้', {
      module: 'orders',
      action: 'write',
      required: ['orders:write'],
    }),
  },
};
const E404 = {
  status: 404,
  description: 'ไม่พบ (รวมใบของบริษัทอื่น)',
  examples: { not_found: P('not_found', 404, 'ไม่พบข้อมูล') },
};
const E412 = {
  status: 412,
  description: 'If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ',
  examples: {
    precondition_failed: P(
      'precondition_failed',
      412,
      'ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่',
    ),
  },
};
const E422 = {
  status: 422,
  description: 'รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`)',
  examples: {
    validation_failed: P('validation_failed', 422, 'ข้อมูลไม่ถูกต้อง', {
      errors: [
        { field: 'requestedDate', code: 'invalid_date', message: 'must be YYYY-MM-DD' },
        { field: 'stops[0].siteId', code: 'invalid_id', message: 'must be a uuid' },
        { field: 'lines[0].qty', code: 'invalid_type', message: 'must be a decimal string' },
      ],
    }),
    idempotency_mismatch: P('idempotency_mismatch', 422, 'Idempotency-Key นี้เคยใช้กับข้อมูลอื่น'),
  },
};
const LOCKED_EX = P(
  'order_locked_for_update',
  409,
  'แก้ข้อมูลนี้ของใบสั่งขนส่งไม่ได้ในสถานะปัจจุบัน',
  {
    errors: [
      {
        field: 'stops[1].siteId',
        code: 'locked',
        message: 'cannot change stops when order is IN_TRANSIT',
      },
      {
        field: 'lines[0].qty',
        code: 'locked',
        message: 'cannot change lines when order is IN_TRANSIT',
      },
    ],
    orderStatus: 'IN_TRANSIT',
    editableFields: ['customerRef'],
  },
);
const E409 = (withConflict: boolean) => ({
  status: 409,
  description: LOCKED_DOC,
  examples: {
    order_locked_for_update: LOCKED_EX,
    ...(withConflict
      ? {
          external_id_conflict: P(
            'external_id_conflict',
            409,
            'เลขอ้างอิงต้นทางนี้ถูกใช้กับใบสั่งขนส่งจากช่องทางอื่นแล้ว',
            { existingSource: 'CONNECTOR', existingConnector: 'krs' },
          ),
        }
      : {}),
    invalid_state_transition: P(
      'invalid_state_transition',
      409,
      'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
      {
        from: 'RECEIVED',
        event: 'save_draft',
      },
    ),
  },
});

/**
 * ใบสั่งขนส่ง / Sales Order — Open API (ST3-T03; docs/04 C "Upsert ด้วย external id", "รับจาก Open API", docs/01 §5.2 #1)
 * ทุกการเขียนเรียก `OrderIntakeService.upsertOrder` (ทางเดียวของทุกทางเข้า) · UI ใช้ endpoint ชุดเดียวกันนี้
 * สิทธิ์: อ่าน `orders:read` · สร้าง/แก้ `orders:write` · ราคาขาย (`sellTotal`, `sellCharges`) เห็นเมื่อมี `prices.sell:read`
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.orders.getByExternalId(id.slice(4));
    return this.orders.get(decodeIdOr404('salesOrder', id));
  }

  private async respond(r: UpsertOrderResult, res: Response): Promise<OrderDto> {
    const row = await this.orders.get(r.order.id);
    setEtag(res, row.version);
    return toOrderDto(row);
  }

  @Get()
  @RequireScope('orders:read')
  @ApiOkResponse({ type: OrderPageDto })
  @ApiProblems(E403, E422)
  list(@Query() q: OrderListQuery) {
    return this.orders.list(q);
  }

  @Post()
  @RequireScope('orders:write')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'ส่งซ้ำ key เดิม = ผลเดิม (24 ชม.)',
  })
  @ApiCreatedResponse({
    type: OrderDto,
    description:
      'สร้างใบใหม่ (ข้อมูลไม่ครบ/จับคู่ไม่ได้ = ยังรับเข้าเป็น ON_HOLD + holdReason) · มี externalId ของใบเดิม = 200 อัปเดตใบเดิม',
  })
  @ApiProblems(E403, E409(true), E422)
  async create(
    @Body() body: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const r = await this.orders.create(body);
    res.status(r.created ? 201 : 200);
    return this.respond(r, res);
  }

  @Put('external/:externalId')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อใบมีอยู่แล้ว' })
  @ApiOkResponse({ type: OrderDto, description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดใบใหม่)' })
  @ApiCreatedResponse({ type: OrderDto, description: 'ยังไม่มี → สร้าง (ที่มา API)' })
  @ApiProblems(E403, E409(true), E412, E422)
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const r = await this.orders.upsertExternal(externalId, body, ifMatch(req));
    res.status(r.created ? 201 : 200);
    return this.respond(r, res);
  }

  @Get(':id')
  @TenantResource('salesOrder')
  @RequireScope('orders:read')
  @ApiOkResponse({ type: OrderDto, description: '`{id}` รับ `ext:{externalId}` ได้' })
  @ApiProblems(E403, E404)
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<OrderDto> {
    const o = await this.resolve(id);
    setEtag(res, o.version);
    return toOrderDto(o);
  }

  @Patch(':id')
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(E403, E404, E409(false), E412, E422)
  async update(
    @Param('id') id: string,
    @Body() body: UpdateOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const current = await this.resolve(id);
    const r = await this.orders.update(current.id, body, ifMatch(req));
    return this.respond(r, res);
  }
}
