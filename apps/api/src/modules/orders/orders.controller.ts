import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { ifMatch, setEtag } from '../../common/etag';
import { assertPriceWriteAllowed } from '../../common/price-fields';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import {
  CancelOrderDto,
  CreateOrderDto,
  SourceChangeDecisionDto,
  MapCustomerDto,
  MapStopSiteDto,
  OrderDto,
  OrderEditLockDto,
  OrderMapResultDto,
  OrderListQuery,
  OrderLockDto,
  OrderPageDto,
  OrderSummaryDto,
  ResolveSourceErrorDto,
  ManualPriceDto,
  OrderUnlockDto,
  UpdateOrderDto,
  UpsertOrderDto,
} from './order.dto';
import { OrderLockService } from './order-lock.service';
import { OrderBillingService } from './order-billing.service';
import { scopeAllows } from '@tms/domain';
import { requestContext } from '../../common/request-context';
import { OrdersService, toOrderDto } from './orders.service';
import type { UpsertOrderResult } from './order-intake.service';
import { ApiExternalIdParam, ExternalIdPipe, extRef, resolveRef } from '../../common/external-id';

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
const E400 = (idem: boolean) => ({
  status: 400,
  description: idem ? 'JSON เสีย / Idempotency-Key ผิดรูป (ต้องเป็น ASCII 1–255 ตัว)' : 'JSON เสีย',
  examples: {
    bad_request: P(
      'bad_request',
      400,
      'คำขอไม่ถูกต้อง',
      idem ? { detail: 'Idempotency-Key must be 1-255 visible ASCII chars' } : {},
    ),
  },
});
const E413 = {
  status: 413,
  description: 'body ใหญ่เกินกำหนด',
  examples: { payload_too_large: P('payload_too_large', 413, 'ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด') },
};
const E409 = (withConflict: boolean, idem = false) => ({
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
    ...(idem
      ? {
          idempotency_in_progress: P(
            'idempotency_in_progress',
            409,
            'คำขอเดียวกันกำลังประมวลผลอยู่',
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

const E422R = {
  status: 422,
  description: 'เหตุผลสั้นกว่า 10 ตัวอักษร / reason code ไม่ใช่หมวด CANCEL',
  examples: {
    validation_failed: P('validation_failed', 422, 'ข้อมูลไม่ถูกต้อง', {
      errors: [
        {
          field: 'reason',
          code: 'minLength',
          message: 'reason must be longer than or equal to 10 characters',
        },
      ],
    }),
  },
};
const ON_TRIP = P(
  'order_on_trip',
  409,
  'ใบสั่งขนส่งนี้มีใบส่งของอยู่ในเที่ยวรถ — ถอดออกจากเที่ยวก่อน',
  {
    deliveryOrders: ['DO-6911-0001'],
  },
);
const E409C = {
  status: 409,
  description:
    '`order_on_trip` — มีใบส่งของอยู่ในเที่ยว (ถอดออกจากเที่ยวก่อน) · `invalid_state_transition` — สถานะนี้ยกเลิกไม่ได้ (ออกรถ/ส่ง/ปิด/ยกเลิกแล้ว)',
  examples: {
    order_on_trip: ON_TRIP,
    invalid_state_transition: P(
      'invalid_state_transition',
      409,
      'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
      {
        from: 'IN_TRANSIT',
        event: 'cancel',
      },
    ),
  },
};
const E409S = {
  status: 409,
  description:
    '`order_on_trip` — ช่องที่ต้นทางแก้ยังล็อกเพราะมีใบส่งของในเที่ยว (ถอดออกจากเที่ยวก่อนแล้วรับ) · ' +
    '`order_locked_for_update` — ใบออกรถ/ปิด/ยกเลิกแล้ว · `source_change_not_pending` — ชุดนี้ถูกตัดสิน/มีชุดใหม่มาแทนแล้ว',
  examples: {
    order_on_trip: P(
      'order_on_trip',
      409,
      'ใบสั่งขนส่งนี้มีใบส่งของอยู่ในเที่ยวรถ — ถอดออกจากเที่ยวก่อน',
      {
        orderStatus: 'PLANNED',
        lockedFields: ['stops'],
      },
    ),
    source_change_not_pending: P(
      'source_change_not_pending',
      409,
      'การเปลี่ยนแปลงจากต้นทางชุดนี้ถูกตัดสินไปแล้ว หรือมีชุดใหม่มาแทน — โหลดใหม่',
      { changeStatus: 'SUPERSEDED' },
    ),
  },
};

const LOCK_EX = {
  userId: 'usr_7c1d…',
  userName: 'สมชาย ใจดี',
  acquiredAt: '2026-11-13T02:00:00.000Z',
  lastSeenAt: '2026-11-13T02:04:00.000Z',
  expiresAt: '2026-11-13T02:14:00.000Z',
  mine: false,
};
const LOCKED_BY_USER = P('order_locked_by_user', 409, 'ใบสั่งขนส่งนี้กำลังถูกแก้ไขโดยผู้ใช้อื่น', {
  editLock: LOCK_EX,
});
const E409_LOCK = {
  status: 409,
  description:
    '409 `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ (`editLock` = ผู้ถือ + เวลาหมดอายุ) · ' +
    '`order_lock_released` — ล็อกของผู้เรียกถูกผู้อื่นปลด (heartbeat/PATCH) จนกว่าจะเปิดแก้ใหม่ · ' +
    '`concurrent_update` — ล็อกเปลี่ยนมือระหว่างขอ ลองใหม่ได้',
  examples: {
    order_locked_by_user: LOCKED_BY_USER,
    order_lock_released: P(
      'order_lock_released',
      409,
      'การแก้ไขของคุณถูกปลดล็อกโดยผู้อื่นแล้ว — โหลดใหม่ก่อนแก้ต่อ',
      {
        releasedBy: { userId: 'usr_9b2e…', userName: 'ผู้จัดการ ตัวอย่าง' },
        releasedAt: '2026-11-13T02:06:00.000Z',
        reason: 'ผู้แก้ไม่อยู่ ต้องแก้วันรับของด่วน',
      },
    ),
    concurrent_update: P(
      'concurrent_update',
      409,
      'มีการแก้ไขข้อมูลเดียวกันพร้อมกัน กรุณาลองใหม่อีกครั้ง',
    ),
  },
};

/** 409 ของ action ที่ติดล็อกการแก้ (ST3-T08) — รวม example ล็อกเข้ากับ 409 เดิมของ endpoint */
const withLock = (e: {
  status: number;
  description: string;
  examples: Record<string, unknown>;
}) => ({
  ...e,
  description: `${e.description} · \`order_locked_by_user\` — ผู้ใช้อื่นเปิดแก้อยู่ · \`order_lock_released\` — ล็อกของผู้เรียกถูกปลด`,
  examples: {
    ...e.examples,
    order_locked_by_user: LOCKED_BY_USER,
    order_lock_released: E409_LOCK.examples.order_lock_released,
  },
});

const E409_STATE = {
  status: 409,
  description:
    '`invalid_state_transition` — ใบวางแผน/ออกรถ/ปิด/ยกเลิกแล้ว (ประเมินใหม่ได้เฉพาะก่อนวางแผน) หรือไม่มีปัญหาจากต้นทางให้ยืนยัน',
  examples: {
    invalid_state_transition: P(
      'invalid_state_transition',
      409,
      'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
      { from: 'PLANNED', event: 'reevaluate' },
    ),
    order_locked_for_update: LOCKED_EX,
  },
};

const E409_ALIAS = {
  ...E409(false),
  examples: {
    ...E409(false).examples,
    alias_conflict: P(
      'alias_conflict',
      409,
      'รหัสหรือชื่อลูกค้าตามต้นทางนี้เคยจับคู่กับลูกค้ารายอื่นไว้แล้ว — ยืนยันการย้ายพร้อมเหตุผล',
      { aliasKind: 'EXTERNAL_ID', aliasValue: 'NSF-777', mappedCustomerId: 'cus_3f2a…' },
    ),
  },
};

/**
 * ใบสั่งขนส่ง / Sales Order — Open API (ST3-T03; docs/04 C "Upsert ด้วย external id", "รับจาก Open API", docs/01 §5.2 #1)
 * ทุกการเขียนเรียก `OrderIntakeService.upsertOrder` (ทางเดียวของทุกทางเข้า) · UI ใช้ endpoint ชุดเดียวกันนี้
 * สิทธิ์: อ่าน `orders:read` · สร้าง/แก้ `orders:write` · ราคาขาย (`sellTotal`, `sellCharges`) เห็นเมื่อมี `prices.sell:read`
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly locks: OrderLockService,
    private readonly billing: OrderBillingService,
  ) {}

  private async resolve(id: string) {
    return resolveRef(
      'salesOrder',
      id,
      (u) => this.orders.get(u),
      (e) => this.orders.getByExternalId(e),
    );
  }

  /** ใบเดียว + ช่องที่แก้ได้ตามสถานะ (ฟอร์ม ST3-T02 ใช้ปิดช่อง) + ผู้ที่เปิดแก้อยู่ (ST3-T08) */
  private async full(row: Awaited<ReturnType<OrdersService['get']>>): Promise<OrderDto> {
    const dto: OrderDto = {
      ...toOrderDto(row),
      editableFields: await this.orders.editableFields(row),
      editLock: await this.locks.view(row.id),
    };
    // ST4-T10 ยอดวางบิล (ตามใบสั่ง / ตามยอดส่งจริง) — ราคาขายเท่านั้น (interceptor ตัดออกเมื่อไม่มีสิทธิ์)
    if (scopeAllows(requestContext.require().scopes ?? [], 'prices.sell:read'))
      dto.sellBilling = await this.billing.compute(row.id);
    // ชุดที่รอตัดสิน: ค่า "เดิม" เทียบข้อมูล TMS ตอนนี้ (list ใช้ diff ตอนรับ)
    if (dto.sourceChange && row.sourceChanges[0]) {
      const live = await this.orders.previewSourceChange(row.id, row.sourceChanges[0].id);
      if (live) dto.sourceChange.changes = live as typeof dto.sourceChange.changes;
    }
    return dto;
  }

  private async respond(r: UpsertOrderResult, res: Response): Promise<OrderDto> {
    const row = await this.orders.get(r.order.id);
    setEtag(res, row.version);
    return this.full(row);
  }

  /** ตัวนับของหน้ารายการ (แถบสรุป + แท็บ) */
  @Get('summary')
  @RequireScope('orders:read')
  @ApiOkResponse({ type: OrderSummaryDto })
  @ApiProblems(E403)
  summary(): Promise<OrderSummaryDto> {
    return this.orders.summary();
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
    description:
      'ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (สถานะ + ETag เดิม, header `Idempotent-Replayed: true`; body เท่ากันเชิง JSON — ลำดับ key อาจต่าง) เก็บ 24 ชม.',
  })
  @ApiCreatedResponse({
    type: OrderDto,
    description:
      'สร้างใบใหม่ (ข้อมูลไม่ครบ/จับคู่ไม่ได้ = ยังรับเข้าเป็น ON_HOLD + holdReason) · มี externalId ของใบเดิม = 200 อัปเดตใบเดิม',
  })
  @ApiOkResponse({
    type: OrderDto,
    description: 'มี externalId ของใบเดิม (ช่องทางเดียวกัน) → อัปเดตใบเดิม',
  })
  @ApiProblems(E400(true), E403, E409(true, true), E413, E422)
  async create(
    @Body() body: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const r = await this.orders.create(body);
    res.status(r.created ? 201 : 200);
    return this.respond(r, res);
  }

  @Put('external/:externalId')
  @ApiExternalIdParam()
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อใบมีอยู่แล้ว' })
  @ApiOperation({
    summary: 'สร้าง/แทนทั้งใบด้วย externalId (idempotent)',
    description:
      '**แทนทั้งใบ (full replace):** ช่องที่ไม่ส่ง = ว่าง/ค่าตั้งต้น (เช่น ไม่ส่ง customerRef = ล้างเลข PO, ไม่ส่ง lines = ไม่มีสินค้า) — ' +
      'ใบที่วางแผน/ออกรถแล้ว การล้างช่องที่ล็อกนับเป็นการแก้ → 409 `order_locked_for_update` · ยกเว้น `billingCompanyId` ไม่ส่ง = คงของเดิม · ' +
      'แก้บางช่องใช้ PATCH · ส่งซ้ำค่าเดิม = ไม่เปลี่ยน version',
  })
  @ApiOkResponse({ type: OrderDto, description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดใบใหม่)' })
  @ApiCreatedResponse({ type: OrderDto, description: 'ยังไม่มี → สร้าง (ที่มา API)' })
  @ApiProblems(E400(false), E403, E409(true), E412, E413, E422)
  async upsertExternal(
    @Param('externalId', ExternalIdPipe) externalId: string,
    @Body() body: UpsertOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const r = await this.orders.upsertExternal(externalId, body, ifMatch(req));
    res.status(r.created ? 201 : 200);
    return this.respond(r, res);
  }

  @Get(':id')
  @TenantResource('salesOrder')
  @RequireScope('orders:read')
  @ApiOkResponse({
    type: OrderDto,
    description:
      '`{id}` รับ `ext:{externalId}` ได้ · ETag = version ของใบ (ใช้กับ If-Match) — `editLock`/`editableFields` ' +
      'เปลี่ยนได้โดย version ไม่เปลี่ยน จึงไม่รองรับ conditional GET (`If-None-Match` ถูกละเลย ตอบ 200 เสมอ) + `Cache-Control: no-store`',
  })
  @ApiProblems(E403, E404)
  async get(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const o = await this.resolve(id);
    setEtag(res, o.version);
    // ST3-T08: ETag (version) ไม่ครอบสถานะล็อก — ห้าม browser เก็บ และห้าม express ตอบ 304 จาก If-None-Match
    // (ไม่งั้นป้าย "กำลังแก้ไขโดย …" ค้าง) · If-Match ของ PATCH/PUT ยังใช้ ETag = version เหมือนเดิม
    res.setHeader('Cache-Control', 'no-store');
    delete req.headers['if-none-match'];
    return this.full(o);
  }

  @Patch('external/:externalId')
  @RequireScope('orders:write')
  @ApiExternalIdParam()
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOperation({
    summary: 'แก้บางช่องด้วย externalId',
    description:
      'แก้บางช่องของใบที่มีอยู่ (กติกาเดียวกับ `PATCH /orders/{id}`) · ยังไม่มีใบนี้ → 404 — สร้างใหม่ใช้ PUT · ' +
      'ช่องทางเดียวกับ PUT: ใบที่ไม่ได้มาจาก API (กรอกมือ/Excel/connector) → 409 `external_id_conflict` · ' +
      '**ต่างจาก PUT: ติดล็อกการแก้ (ST3-T08)** — ผู้ใช้อื่นเปิดแก้อยู่ → 409 `order_locked_by_user`',
  })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(
    E400(false),
    E403,
    E404,
    {
      ...E409(true),
      description: `${LOCKED_DOC} · 409 \`order_locked_by_user\` — ผู้ใช้อื่นเปิดแก้อยู่ · 409 \`external_id_conflict\` — ใบจากช่องทางอื่น`,
      examples: {
        ...E409(true).examples,
        order_locked_by_user: LOCKED_BY_USER,
        order_lock_released: E409_LOCK.examples.order_lock_released,
      },
    },
    E412,
    E413,
    E422,
  )
  async patchExternal(
    @Param('externalId', ExternalIdPipe) externalId: string,
    @Body() body: UpdateOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    await this.orders.assertExternalSource(externalId);
    return this.update(extRef(externalId), body, req, res);
  }

  @Patch(':id')
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOperation({
    summary: 'แก้บางช่อง',
    description:
      'ผู้ใช้อื่นเปิดแก้อยู่ (ล็อกการแก้ยังไม่หมดอายุ — ST3-T08) → 409 `order_locked_by_user` · ผู้ถือล็อกแก้ได้และนับเป็นกิจกรรม (ต่ออายุ) · ' +
      'ล็อกของผู้เรียกถูกผู้อื่นปลด → 409 `order_lock_released` จนกว่าจะเปิดแก้ใหม่ (POST /lock) · ' +
      'ไม่มีล็อก = แก้ได้ตามปกติ · ทางเข้า POST/PUT external (API/connector/นำเข้า) ไม่ติดล็อก',
  })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(
    E400(false),
    E403,
    E404,
    {
      ...E409(false),
      description: `${LOCKED_DOC} · 409 \`order_locked_by_user\` — ผู้ใช้อื่นเปิดแก้อยู่`,
      examples: {
        ...E409(false).examples,
        order_locked_by_user: LOCKED_BY_USER,
        order_lock_released: E409_LOCK.examples.order_lock_released,
      },
    },
    E412,
    E413,
    E422,
  )
  async update(
    @Param('id') id: string,
    @Body() body: UpdateOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const current = await this.resolve(id);
    await this.locks.assertWritable(current.id);
    const r = await this.orders.update(current.id, body, ifMatch(req));
    return this.respond(r, res);
  }

  /**
   * ยกเลิกใบสั่งขนส่ง (ST3-T10; docs/04 C "ยกเลิก / คืนสถานะ", docs/01 §4.1) — เหตุผล ≥ 10 ตัวอักษร + reason code หมวด CANCEL (ไม่บังคับ)
   * ใบส่งของ (DO) ร่างถูกยกเลิกตามไปทั้งหมด · มี DO อยู่ในเที่ยว → 409 `order_on_trip` (ถอดออกจากเที่ยวก่อน)
   * ยกเลิกแล้วย้อนกลับไม่ได้ (สถานะสิ้นสุด) · event `order.cancelled`
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:cancel')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(E400(false), E403, E404, withLock(E409C), E412, E422R)
  async cancel(
    @Param('id') id: string,
    @Body() body: CancelOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const current = await this.resolve(id);
    await this.locks.assertWritable(current.id);
    await this.orders.cancel(current.id, body, ifMatch(req));
    const row = await this.orders.get(current.id);
    setEtag(res, row.version);
    return this.full(row);
  }

  /**
   * รับการเปลี่ยนแปลงจากต้นทาง (ST3-T10) — เขียนข้อมูลชุดนั้นด้วยกฎเดียวกับทางเข้า (คิดราคา/ใบค้าง/ใบส่งของใหม่)
   * ช่องที่ยังล็อก: มีใบส่งของในเที่ยว → 409 `order_on_trip` (ถอดออกจากเที่ยวก่อน) · เหตุผล ≥ 10 ตัวอักษร + audit
   */
  @Post(':id/source-changes/:changeId/accept')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'ETag ของใบที่ผู้ใช้เห็น diff — ไม่ตรง → 412',
  })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(E400(false), E403, E404, withLock(E409S), E412, E422R)
  async acceptSourceChange(
    @Param('id') id: string,
    @Param('changeId') changeId: string,
    @Body() body: SourceChangeDecisionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const current = await this.resolve(id);
    await this.locks.assertWritable(current.id);
    const r = await this.orders.decideSourceChange(
      current.id,
      changeId,
      true,
      body.reason,
      ifMatch(req),
    );
    return this.respond(r as UpsertOrderResult, res);
  }

  /** ไม่รับการเปลี่ยนแปลงจากต้นทาง — ข้อมูล TMS คงเดิม ปลดธง (ต้นทางส่งชุดเดิมซ้ำ = ไม่ขึ้นใหม่) · เหตุผล ≥ 10 ตัวอักษร + audit */
  @Post(':id/source-changes/:changeId/reject')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'ETag ของใบที่ผู้ใช้เห็น diff — ไม่ตรง → 412',
  })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(E400(false), E403, E404, withLock(E409S), E412, E422R)
  async rejectSourceChange(
    @Param('id') id: string,
    @Param('changeId') changeId: string,
    @Body() body: SourceChangeDecisionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const current = await this.resolve(id);
    await this.locks.assertWritable(current.id);
    await this.orders.decideSourceChange(current.id, changeId, false, body.reason, ifMatch(req));
    const row = await this.orders.get(current.id);
    setEtag(res, row.version);
    return this.full(row);
  }

  /**
   * ขอล็อกการแก้ / ต่ออายุ (heartbeat) — ST3-T08 (docs/04 C Edit lock)
   * หน้าจอเรียกตอนเปิดฟอร์มแก้ และซ้ำระหว่างผู้ใช้ยังใช้งาน (ทุก ~60 วินาทีที่มีกิจกรรม) — ล็อกหมดอายุเมื่อไม่มีกิจกรรม 10 นาที
   */
  @Post(':id/lock')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiOperation({
    summary: 'ขอ/ต่ออายุล็อกการแก้',
    description:
      'ได้ล็อก (หรือต่ออายุของตัวเอง) → 200 + ผู้ถือ/เวลาหมดอายุ (กิจกรรมล่าสุด + 10 นาที) · ผู้อื่นถืออยู่ → 409 `order_locked_by_user` · ' +
      'ล็อกของผู้อื่นที่หมดอายุแล้วถูกแทนที่ทันที · ใช้ได้เฉพาะผู้ใช้ในบริษัท (token อื่น → 403 `edit_lock_user_required`)',
  })
  @ApiOkResponse({ type: OrderEditLockDto })
  @ApiProblems(
    {
      ...E403,
      examples: {
        ...E403.examples,
        edit_lock_user_required: P(
          'edit_lock_user_required',
          403,
          'การล็อกเพื่อแก้ไขใช้ได้เฉพาะผู้ใช้ในระบบ',
        ),
      },
    },
    E404,
    E409_LOCK,
  )
  async lock(@Param('id') id: string, @Body() body: OrderLockDto): Promise<OrderEditLockDto> {
    const o = await this.resolve(id);
    return this.locks.acquire(o.id, body?.heartbeat === true);
  }

  /**
   * ปลดล็อกการแก้ — ST3-T08 · ของตัวเอง/ไม่มีล็อก/หมดอายุ = 204 (ส่งซ้ำได้ ใช้ตอนปิดฟอร์ม/ปิดแท็บ)
   * ของผู้อื่น = ต้องมี `orders:unlock` + `reason` ≥ 10 ตัวอักษร (ลง audit `order.edit_lock_released`)
   */
  @Post(':id/unlock')
  @HttpCode(204)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiOperation({
    summary: 'ปลดล็อกการแก้',
    description:
      'ของตัวเอง/ไม่มีล็อก/หมดอายุ → 204 · ล็อกของผู้อื่น: ต้องมีสิทธิ์ `orders:unlock` (ไม่มี → 403) และ `reason` ≥ 10 ตัวอักษร (422) — ลง audit พร้อมเหตุผล · ' +
      'ผู้ถือเดิมต่ออายุ/บันทึกไม่ได้ (409 `order_lock_released`) จนกว่าจะเปิดแก้ใหม่ — คนอื่นขอล็อกได้ทันที',
  })
  @ApiNoContentResponse()
  @ApiProblems(
    {
      ...E403,
      description: 'ไม่มีสิทธิ์ (`orders:write`; ปลดล็อกของผู้อื่นต้องมี `orders:unlock`)',
      examples: {
        permission_denied: P('permission_denied', 403, 'ไม่มีสิทธิ์ทำรายการนี้', {
          module: 'orders',
          action: 'unlock',
          required: ['orders:unlock'],
        }),
      },
    },
    E404,
    {
      status: 422,
      description: 'ปลดล็อกของผู้อื่นโดยไม่มีเหตุผล / เหตุผลสั้นกว่า 10 ตัวอักษร',
      examples: {
        validation_failed: P('validation_failed', 422, 'ข้อมูลไม่ถูกต้อง', {
          errors: [
            {
              field: 'reason',
              code: 'minLength',
              message: 'reason must be at least 10 characters',
            },
          ],
        }),
      },
    },
  )
  async unlock(@Param('id') id: string, @Body() body: OrderUnlockDto): Promise<void> {
    const o = await this.resolve(id);
    await this.locks.release(o.id, body.reason);
  }

  @Post(':id/stops/:sequence/map-site')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiOperation({
    summary: 'เลือกสถานที่ให้จุดที่ยังจับคู่ไม่ได้ + จำข้อความเป็น alias (ST3-T06)',
    description:
      'จุดลำดับ `{sequence}` (เริ่ม 1) ได้สถานที่ที่เลือก (`match.method = MANUAL`) แล้วระบบจำข้อความสถานที่ของจุดนี้เป็น alias ' +
      'ของสถานที่ → ใบถัดไปที่ข้อความเดิม (ไม่สนช่องว่าง/ตัวพิมพ์/คำนิติบุคคล) จับคู่เอง · ประเมินราคา + ใบค้างใหม่ทันที ' +
      '(LOCATION_UNMAPPED หาย / RATE_MISSING ถ้ายังไม่มี rate) · สถานที่ต้องเป็นของลูกค้าของใบหรือของบริษัท — ' +
      'ใบยังไม่มีลูกค้าเลือกได้เฉพาะสถานที่ของบริษัท (422 `customer_unmapped`) · หลังวางแผน → 409 `order_locked_for_update`',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: OrderMapResultDto })
  @ApiProblems(E400(false), E403, E404, E409(false), E412, E422)
  async mapStopSite(
    @Param('id') id: string,
    @Param('sequence') sequence: string,
    @Body() body: MapStopSiteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderMapResultDto> {
    const current = await this.resolve(id);
    if (!/^[1-9]\d{0,2}$/.test(sequence)) throw new ProblemException('not_found');
    await this.locks.assertWritable(current.id);
    const r = await this.orders.mapStopSite(
      current.id,
      Number(sequence),
      body.siteId,
      ifMatch(req),
    );
    return { ...(await this.respond(r, res)), aliasLearning: r.aliasLearning };
  }

  @Post(':id/reevaluate')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiOperation({
    summary: 'ตรวจใบค้างอีกครั้ง — คิดราคา + ประเมินเหตุค้างใหม่จากข้อมูลหลักปัจจุบัน (ST3-T07)',
    description:
      'หน้าใบค้างเรียกหลังเคลียร์เหตุที่ข้อมูลหลัก (เพิ่ม/อนุมัติ rate card → RATE_MISSING, ปักพิกัดสถานที่ → GEOCODING_ERROR, ' +
      'เปิดใช้ลูกค้า/สถานที่) · จับคู่อัตโนมัติด้วย alias ที่เรียนรู้ล่าสุดด้วย · ไม่แก้ข้อมูลงาน · ผลเหมือนเดิม = ไม่เพิ่ม version · ' +
      'เหตุหมด → กลับ `received` · เหตุที่ flow อื่นตั้ง (CARRIER_REJECTED ฯลฯ) ไม่ถูกปล่อย · ' +
      'ใช้ได้ก่อนวางแผน (draft/received/on_hold) — ไม่งั้น 409 `invalid_state_transition` · ' +
      'ใบค้างด้วยเหตุตอนจัดรถ/ส่ง (CARRIER_REJECTED ฯลฯ — เคยวางแผนแล้ว ไม่คิดราคาใหม่) → 409 `invalid_state_transition` (`holdReason`) · ' +
      'ผู้ใช้อื่นเปิดแก้อยู่ → 409 `order_locked_by_user`',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(E403, E404, withLock(E409_STATE), E412)
  async reevaluate(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const current = await this.resolve(id);
    await this.locks.assertWritable(current.id);
    return this.respond(await this.orders.recheck(current.id, ifMatch(req)), res);
  }

  @Post(':id/manual-price')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiOperation({
    summary:
      'กำหนดราคาเอง — ค่าขนส่งเมื่อไม่พบ rate card (spec/03 ORD-043 · ใบค้าง RATE_MISSING — ST3-T07)',
    description:
      'สร้างบรรทัด FREIGHT ที่มา `MANUAL` (รายการบริการระบบ FREIGHT — vat_type/wht_rate ตาม catalog) หรือแก้จำนวนเงินของบรรทัด MANUAL เดิม ' +
      '→ ประเมินใบค้างใหม่ (มีค่าขนส่ง MANUAL = ไม่ค้าง RATE_MISSING · เหตุหมด → `received`) · บรรทัด MANUAL ไม่ถูกลบตอนคิดราคาใหม่ · ' +
      'ต้องมี `orders:write` + `prices.sell:write` (ไม่มี → 403) · เหตุผล ≥ 10 ตัวอักษร (audit `sales_order.manual_price_set`) · ' +
      'ใช้ได้ก่อนวางแผน (หลังวางแผน → 409 `order_locked_for_update`) · มีค่าขนส่งจาก rate card แล้ว หรือใบค้างด้วยเหตุตอนจัดรถ/ส่ง → 409 `invalid_state_transition`',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(E400(false), E403, E404, withLock(E409_STATE), E412, E422)
  async manualPrice(
    @Param('id') id: string,
    @Body() body: ManualPriceDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    // สิทธิ์แก้ราคาขาย (A3 "ดู/แก้ราคาขาย"; MD-113) — interceptor ตรวจ field ราคาใน body แล้ว ตรวจซ้ำที่นี่ให้ชัด
    assertPriceWriteAllowed({ sellAmount: body.sellAmount });
    const current = await this.resolve(id);
    await this.locks.assertWritable(current.id);
    return this.respond(
      await this.orders.setManualPrice(current.id, body.sellAmount, body.reason, ifMatch(req)),
      res,
    );
  }

  @Post(':id/resolve-source-error')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiOperation({
    summary: 'ยืนยันข้อมูลใบที่ต้นทางแจ้งว่าไม่ครบ (ใบค้าง SOURCE_ERROR — ST3-T07)',
    description:
      'docs/01 §4.1 SOURCE_ERROR "ดู raw_payload, แก้มือ หรือรอ connector แก้": คนแก้ข้อมูลใบ (PATCH) แล้วยืนยัน → ล้างรายการปัญหาจากต้นทาง ' +
      'แล้วประเมินใบค้างใหม่ (เหตุอื่นยังค้างได้) · บังคับเหตุผล ≥ 10 ตัวอักษร (ลง audit `sales_order.source_error_resolved`) · ' +
      'ต้นทางส่งใบนี้มาใหม่ด้วยข้อมูลที่เปลี่ยน = ใช้ผลตรวจของต้นทางชุดใหม่ · ไม่มีปัญหาค้าง → 409 `invalid_state_transition` · ' +
      'หลังวางแผน → 409 `order_locked_for_update`',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: OrderDto })
  @ApiProblems(E400(false), E403, E404, withLock(E409_STATE), E412, E422)
  async resolveSourceError(
    @Param('id') id: string,
    @Body() body: ResolveSourceErrorDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDto> {
    const current = await this.resolve(id);
    await this.locks.assertWritable(current.id);
    return this.respond(
      await this.orders.resolveSourceError(current.id, body.reason, ifMatch(req)),
      res,
    );
  }

  @Post(':id/map-customer')
  @HttpCode(200)
  @TenantResource('salesOrder')
  @RequireScope('orders:write')
  @ApiOperation({
    summary: 'เลือกลูกค้าให้ใบที่ยังจับคู่ไม่ได้ + จำรหัส/ชื่อตามต้นทาง (ST3-T06)',
    description:
      'ใบได้ลูกค้าที่เลือก (`customer.match.method = MANUAL`) · ใบมีรหัสลูกค้าต้นทาง = จำรหัสนั้นของช่องทางนี้ ' +
      '(เช่น `ERP:krs`) · ไม่มีรหัส = จำชื่อตามต้นทาง → ใบถัดไปจับคู่เอง · เคยจำไว้กับลูกค้าอื่น = ย้ายมาลูกค้านี้ (audit) · ' +
      'จุดที่ยังว่างจับคู่ในขอบเขตลูกค้านี้ต่อ แล้วประเมินราคา + ใบค้างใหม่ · จุดที่เลือกสถานที่ของลูกค้าอื่นไว้ → 422 `site_other_customer` · ' +
      'รหัส/ชื่อนี้เคยจับคู่กับลูกค้าอื่น → 409 `alias_conflict` (ใบไม่เปลี่ยน) จนกว่าส่ง `confirmReassign: true` + `reason` · ' +
      'ชื่อทั่วไป (เงินสด, ลูกค้าทั่วไป, walk-in …) ไม่จำ (`aliasLearning = generic`) · alias รหัสที่คนจับคู่ชนะ externalId ของลูกค้า',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: OrderMapResultDto })
  @ApiProblems(E400(false), E403, E404, E409_ALIAS, E412, E422)
  async mapCustomer(
    @Param('id') id: string,
    @Body() body: MapCustomerDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderMapResultDto> {
    const current = await this.resolve(id);
    await this.locks.assertWritable(current.id);
    const r = await this.orders.mapCustomer(current.id, body, ifMatch(req));
    return { ...(await this.respond(r, res)), aliasLearning: r.aliasLearning };
  }
}
