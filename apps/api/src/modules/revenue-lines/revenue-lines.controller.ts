import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { resolveRef } from '../../common/external-id';
import { decodeIdOr404 } from '../../common/ids';
import { OrdersService } from '../orders/orders.service';
import { ApiProblems } from '../../common/problem.dto';
import { T403, T404, T409, T412, T422 } from '../trips/trip-problems';
import { OrderLockService } from '../orders/order-lock.service';
import {
  AddRevenueLineDto,
  DeliveryOrderRevenueDto,
  RevenueLineDto,
  RevenueLineListDto,
  RevenueLineReasonDto,
} from './revenue-line.dto';
import { RevenueLinesService } from './revenue-lines.service';

const NF = { ...T404, description: 'ไม่พบ (รวมของบริษัทอื่น)' };

/**
 * บรรทัดรายได้ของใบสั่ง (ST5-T01; docs/04 F3 "Revenue line ตั้งแต่สร้าง order")
 * อ่าน `orders:read` (ยอดเห็นเมื่อมี `prices.sell:read`) · เพิ่ม/ยกเลิกบรรทัดเอง `orders:write` + `prices.sell:write`
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrderRevenueLinesController {
  constructor(
    private readonly svc: RevenueLinesService,
    private readonly locks: OrderLockService,
    private readonly orders: OrdersService,
  ) {}

  /** `{id}` หรือ `ext:{externalId}` → uuid ของใบสั่ง (ST7-T02) — ไม่พบ/บริษัทอื่น → 404 */
  private async orderId(id: string): Promise<string> {
    return resolveRef(
      'salesOrder',
      id,
      async (u) => u,
      async (e) => (await this.orders.getByExternalId(e)).id,
    );
  }

  @Get(':id/revenue-lines')
  @TenantResource('salesOrder')
  @RequireScope('orders:read')
  @ApiOperation({
    summary: 'บรรทัดรายได้ของใบสั่ง (ฐานของบรรทัดใบแจ้งหนี้)',
    description:
      'ระบบสร้างจากราคาของใบสั่ง (`SO_CHARGE` — rate card snapshot / ราคาที่กำหนดเอง **แบ่งลงใบส่งของ** ตามปริมาณของใบ: ลูกค้าวางบิลตามยอดส่งจริง = ยอดส่งจริง ' +
      '(ยังไม่บันทึก = แผน `provisional`), ยังไม่มีใบส่งของ = ระดับใบสั่ง) และค่าใช้จ่ายหน้างานที่ยืนยันแล้ว ' +
      '(`DO_SURCHARGE`) · แก้ใบสั่ง → บรรทัดระบบคิดใหม่ บรรทัดที่คนเพิ่ม (`MANUAL`) คงไว้ · บรรทัดที่อยู่ในเอกสารที่ออกเลขแล้ว `locked` = ไม่เปลี่ยน · ' +
      'ไม่คำนวณภาษี (มีเฉพาะ vatType/whtRate ต่อบรรทัด) · รวมบรรทัดที่ยกเลิก (`status` VOIDED)',
  })
  @ApiProblems(T403('orders:read'), NF)
  @ApiOkResponse({ type: RevenueLineListDto })
  async list(@Param('id') id: string): Promise<RevenueLineListDto> {
    return { data: await this.svc.list(await this.orderId(id)) };
  }

  @Post(':id/revenue-lines')
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiOperation({
    summary: 'เพิ่มบรรทัดรายได้เอง — คงไว้เมื่อระบบคิดราคาใหม่',
    description:
      'ธงภาษีคัดลอกจากรายการบริการฝั่งขาย ณ เวลาเพิ่ม · ยอด = จำนวน × ราคา (ปัดครึ่งขึ้นเป็นสตางค์) · ต้องมี `prices.sell:write` · ' +
      'เหตุผล ≥ 10 ตัวอักษร (audit `sales_order.revenue_line_added`) · ใบสั่งปิด/ยกเลิก หรือมีบรรทัดที่ออกใบแจ้งหนี้แล้ว → 409',
  })
  @ApiProblems(T403('prices.sell:write'), NF, T409('order_locked_for_update'), T422)
  @ApiCreatedResponse({ type: RevenueLineDto })
  async add(
    @Param('id') id: string,
    @Body() body: AddRevenueLineDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevenueLineDto> {
    const soId = await this.orderId(id);
    await this.locks.assertWritable(soId);
    const out = await this.svc.add(soId, body);
    setEtag(res, out.version);
    return out;
  }
}

@ApiTags('orders')
@ApiBearerAuth()
@Controller('revenue-lines')
export class RevenueLinesController {
  constructor(
    private readonly svc: RevenueLinesService,
    private readonly locks: OrderLockService,
  ) {}

  @Post(':id/void')
  @HttpCode(200)
  @TenantResource('revenueLine')
  @RequireScope('orders:write')
  @ApiOperation({
    summary: 'ยกเลิกบรรทัดรายได้ที่คนเพิ่มเอง — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'บรรทัดระบบ (SO_CHARGE / DO_SURCHARGE) ยกเลิกไม่ได้ — แก้ที่ใบสั่ง/ค่าใช้จ่ายหน้างาน (409) · บรรทัดที่ล็อก (ออกเลขแล้ว) / ใบสั่งปิดหรือยกเลิก / ใบสั่งถูกล็อกการแก้โดยผู้อื่น → 409 · ' +
      'ต้องมี `prices.sell:write` · audit `sales_order.revenue_line_voided`',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag (version) — ไม่ตรง → 412' })
  @ApiProblems(T403('prices.sell:write'), NF, T409('order_locked_for_update'), T412, T422)
  @ApiOkResponse({ type: RevenueLineDto })
  async void(
    @Param('id') id: string,
    @Body() body: RevenueLineReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevenueLineDto> {
    const lineId = decodeIdOr404('revenueLine', id);
    await this.locks.assertWritable(await this.svc.salesOrderOf(lineId));
    const out = await this.svc.void(lineId, body.reason, expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }
}

@ApiTags('delivery-orders')
@ApiBearerAuth()
@Controller('delivery-orders')
export class DeliveryOrderRevenueLinesController {
  constructor(private readonly svc: RevenueLinesService) {}

  @Get(':id/revenue-lines')
  @TenantResource('deliveryOrder')
  @RequireScope('orders:read')
  @ApiOperation({
    summary: 'บรรทัดรายได้ของใบส่งของ + รายได้รวมของใบ',
    description:
      'รายได้ต่อใบส่งของ (docs/01 §3.3 `revenue_amount` — PO ตัดสิน 19 พ.ย. 2569): ราคาของใบสั่งที่แบ่งลงใบนี้ตามปริมาณ (snapshot × ยอดส่งจริง ' +
      'เมื่อลูกค้าวางบิลตามยอดส่งจริง — ยังไม่บันทึก = แผน `provisional`) + ค่าใช้จ่ายหน้างานที่ยืนยันแล้ว + บรรทัดที่คนเพิ่มผูกใบนี้ · ' +
      '`sellRevenueTotal` = ผลรวมบรรทัดที่ยังใช้ (ยอดเห็นเมื่อมี `prices.sell:read`) · ใบที่ยกเลิก = บรรทัด VOIDED ยอด 0.00 · ไม่คำนวณภาษี',
  })
  @ApiProblems(T403('orders:read'), NF)
  @ApiOkResponse({ type: DeliveryOrderRevenueDto })
  async list(@Param('id') id: string): Promise<DeliveryOrderRevenueDto> {
    return this.svc.listForDeliveryOrder(decodeIdOr404('deliveryOrder', id));
  }
}
