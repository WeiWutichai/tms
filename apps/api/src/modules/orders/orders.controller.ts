import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
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
  @ApiConflictResponse({ description: LOCKED_DOC })
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
  @ApiConflictResponse({ description: LOCKED_DOC })
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
    const r = await this.orders.upsertExternal(externalId, body, expectedVersion(req));
    res.status(r.created ? 201 : 200);
    return this.respond(r, res);
  }

  @Get(':id')
  @TenantResource('salesOrder')
  @RequireScope('orders:read')
  @ApiOkResponse({ type: OrderDto, description: '`{id}` รับ `ext:{externalId}` ได้' })
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
  @ApiConflictResponse({ description: LOCKED_DOC })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const current = await this.resolve(id);
    const r = await this.orders.update(current.id, body, expectedVersion(req));
    return this.respond(r, res);
  }
}
