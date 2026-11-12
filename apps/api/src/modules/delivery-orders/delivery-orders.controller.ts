import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { DoLineRequest, DoStatus } from '@tms/domain';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { toPage } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { isRealDate } from '../vehicle-documents/expiry';
import {
  CancelDeliveryOrderDto,
  CreateDeliveryOrderDto,
  DeliveryOrderDto,
  DeliveryOrderListQuery,
  DeliveryOrderPageDto,
  DeliveryOrderSplitResultDto,
  MergeDeliveryOrdersDto,
  SplitDeliveryOrderDto,
  type DeliveryOrderLineQtyDto,
} from './delivery-order.dto';
import { DeliveryOrderService, type DeliveryOrderRecord } from './delivery-order.service';

const dec = (v: { toFixed: (n: number) => string } | null) =>
  v === null ? null : v.toFixed(3).replace(/\.?0+$/, '') || '0';

export function toDeliveryOrderDto(d: DeliveryOrderRecord): DeliveryOrderDto {
  return {
    id: encodeId('deliveryOrder', d.id),
    doNo: d.doNo!,
    status: d.status as DoStatus,
    orderId: encodeId('salesOrder', d.salesOrderId),
    customerId: encodeId('customer', d.customerId),
    doDate: d.doDate.toISOString().slice(0, 10),
    originSiteId: encodeId('site', d.originSiteId),
    destSiteId: encodeId('site', d.destSiteId),
    originStopSeq: d.originStopSeq,
    destStopSeq: d.destStopSeq,
    tripId: d.tripId ? encodeId('trip', d.tripId) : null,
    weightKg: dec(d.weightKg),
    cbm: dec(d.cbm),
    customerRef: d.customerRef,
    splitFromId: d.splitFromId ? encodeId('deliveryOrder', d.splitFromId) : null,
    splitIndex: d.splitIndex,
    redeliveryOfId: d.redeliveryOfId ? encodeId('deliveryOrder', d.redeliveryOfId) : null,
    podStatus: d.podStatus,
    lines: d.lines.map((l) => ({
      lineNo: l.lineNo,
      soLineNo: l.soLineNo,
      description: l.description,
      qtyPlanned: dec(l.qtyPlanned)!,
      qtyActual: dec(l.qtyActual),
      unit: l.unit,
      weightKg: dec(l.weightKg),
      cbm: dec(l.cbm),
    })),
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/**
 * ใบส่งของ (ST3-T09; docs/01 §5.2 #4 `delivery-orders`, D-26) — list/get + สร้างจาก SO + แยก/รวม/ยกเลิก
 * (`/split`, `/merge` ไม่อยู่ในรายการ docs §5.2 — บันทึก spec/12 §3) · PATCH/redeliver/tracking = งานถัดไป
 * สิทธิ์ (docs/04 A3): อ่าน `orders:read` · สร้าง/แยก/รวม `orders:write` (spec/03 §3.2 dispatcher) · ยกเลิก `orders:cancel`
 * ไม่มีราคา/รายได้ใน payload (ST5) · บรรทัดอ้างบรรทัด SO ด้วยลำดับ `soLineNo`
 */
@ApiTags('delivery-orders')
@ApiBearerAuth()
@Controller('delivery-orders')
export class DeliveryOrdersController {
  constructor(
    private readonly dos: DeliveryOrderService,
    private readonly db: DbService,
  ) {}

  @Get()
  @RequireScope('orders:read')
  @ApiOkResponse({ type: DeliveryOrderPageDto })
  async list(@Query() q: DeliveryOrderListQuery) {
    // รูปแบบผ่าน DTO แล้ว — วันที่ต้องมีจริง (2026-02-31 / 2026-13-45 → 422 ไม่ปัดเป็นเดือนถัดไป)
    const badDates = (['dateFrom', 'dateTo'] as const).flatMap((f) =>
      q[f] !== undefined && !isRealDate(q[f]!)
        ? [{ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]
        : [],
    );
    if (badDates.length) throw new ProblemException('validation_failed', undefined, badDates);
    const decode = (kind: 'salesOrder' | 'customer', v?: string) =>
      v === undefined
        ? undefined
        : (tryDecodeId(kind, v) ?? '00000000-0000-0000-0000-000000000000');
    const { rows, limit } = await this.dos.list({
      ...q,
      salesOrderId: decode('salesOrder', q.orderId),
      customerId: decode('customer', q.customerId),
      statuses: q.status ? (q.status.split(',') as DoStatus[]) : undefined,
    });
    return toPage(rows, limit, toDeliveryOrderDto, q.fields);
  }

  @Get(':id')
  @TenantResource('deliveryOrder')
  @RequireScope('orders:read')
  @ApiOkResponse({ type: DeliveryOrderDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const d = await this.dos.get(decodeIdOr404('deliveryOrder', id));
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }

  /** สร้าง DO จาก SO (ปริมาณคงเหลือทั้งหมด หรือบางส่วน/ต่อจุดส่ง) — ห้ามเกินที่สั่ง (422 `over_allocated`) */
  @Post()
  @RequireScope('orders:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: DeliveryOrderDto })
  async create(
    @Body() body: CreateDeliveryOrderDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const soId = tryDecodeId('salesOrder', body.orderId);
    const lines = soId
      ? await this.db.tx.salesOrderLine.findMany({
          where: { salesOrderId: soId },
          select: { id: true, lineNo: true },
        })
      : [];
    const so = soId
      ? await this.db.tx.salesOrder.findUnique({ where: { id: soId }, select: { id: true } })
      : null;
    if (!so)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'orderId', code: 'invalid_reference', message: 'order not found' },
      ]);
    const d = await this.dos.createFromOrder(so.id, {
      destStopSeq: body.destStopSeq,
      originStopSeq: body.originStopSeq,
      lines: body.lines ? mapLines(body.lines, lines, 'lines') : undefined,
    });
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }

  /** แยก DO (ORD-084): ใบนี้ CANCELLED → ใบลูก `{เลข}-{n}` ปริมาณรวมต่อบรรทัดเท่าเดิม */
  @Post(':id/split')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DeliveryOrderSplitResultDto })
  async split(
    @Param('id') id: string,
    @Body() body: SplitDeliveryOrderDto,
    @Req() req: Request,
  ): Promise<DeliveryOrderSplitResultDto> {
    const d = await this.dos.get(decodeIdOr404('deliveryOrder', id));
    const known = d.lines.flatMap((l) =>
      l.salesOrderLineId ? [{ id: l.salesOrderLineId, lineNo: l.soLineNo }] : [],
    );
    const parts = body.parts.map((p, i) => mapLines(p.lines, known, `parts[${i}].lines`));
    const kids = await this.dos.split(d.id, parts, undefined, expectedVersion(req));
    return { data: kids.map(toDeliveryOrderDto) };
  }

  /** รวม DO อื่นของ SO + จุดส่งเดียวกันเข้าใบนี้ (ORD-086) — ใบที่ถูกรวม CANCELLED */
  @Post(':id/merge')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag ของใบนี้ — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DeliveryOrderDto })
  async merge(
    @Param('id') id: string,
    @Body() body: MergeDeliveryOrdersDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const target = await this.dos.get(decodeIdOr404('deliveryOrder', id));
    const others = body.deliveryOrderIds.map((x) => decodeIdOr404('deliveryOrder', x));
    const d = await this.dos.merge([target.id, ...others], undefined, expectedVersion(req));
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }

  /** ยกเลิก DO (DRAFT ที่ไม่อยู่ในเที่ยว) — เหตุผล ≥ 10 ตัวอักษร + audit */
  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('orders:cancel')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: DeliveryOrderDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: CancelDeliveryOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const current = await this.dos.get(decodeIdOr404('deliveryOrder', id));
    let reasonCodeId: string | null = null;
    if (body.reasonCodeId) {
      reasonCodeId = tryDecodeId('reasonCode', body.reasonCodeId);
      if (!reasonCodeId)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'reasonCodeId', code: 'invalid_reference', message: 'reason code not found' },
        ]);
    }
    const d = await this.dos.cancel(
      current.id,
      { note: body.reason, reasonCodeId },
      undefined,
      expectedVersion(req),
    );
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }
}

/** soLineNo → id ของบรรทัด SO (ไม่รู้จัก → 422 รวมทุกช่อง) */
function mapLines(
  input: DeliveryOrderLineQtyDto[],
  known: { id: string; lineNo: number }[],
  field: string,
): DoLineRequest[] {
  const byNo = new Map(known.map((l) => [l.lineNo, l.id]));
  const bad = input.flatMap((l, i) =>
    byNo.has(l.soLineNo)
      ? []
      : [{ field: `${field}[${i}].soLineNo`, code: 'unknown_line', message: 'line not found' }],
  );
  if (bad.length) throw new ProblemException('validation_failed', undefined, bad);
  return input.map((l) => ({ salesOrderLineId: byNo.get(l.soLineNo)!, qty: l.qty, unit: l.unit }));
}
