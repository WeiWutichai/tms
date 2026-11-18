import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { scopeAllows } from '@tms/domain';
import type { Request } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { resolveRef } from '../../common/external-id';
import { encodeId } from '../../common/ids';
import { PROBLEMS, ProblemException, type ProblemCode } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import {
  apiOrigin,
  DocumentDto,
  readyDocumentDto,
  toDocumentDto,
} from '../documents/documents.controller';
import { StopEventDto } from '../stops/stop-event.dto';
import { toStopEventDto } from '../stops/stops.controller';
import { OrderTrackingDto } from '../tracking/tracking.dto';
import { TrackingService } from '../tracking/tracking.service';

/** ตัวอย่าง problem+json ของ sub-resource ของ order (OpenAPI) */
const P = (code: ProblemCode, instance: string, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance,
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const R403 = (sub: string) => ({
  status: 403,
  description: 'ไม่มีสิทธิ์ (`orders:read`)',
  examples: {
    permission_denied: P('permission_denied', `/v1/orders/ord_3f2a…/${sub}`, {
      module: 'orders',
      action: 'read',
      required: ['orders:read'],
    }),
  },
});
const R404 = (sub: string) => ({
  status: 404,
  description: 'ไม่พบใบสั่งขนส่ง (รวมของบริษัทอื่น / `ext:` ที่ไม่มี)',
  examples: { not_found: P('not_found', `/v1/orders/ord_3f2a…/${sub}`) },
});

export class OrderDocumentDto extends DocumentDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'do_3f2a…',
    description: 'DO ที่ไฟล์ผูกอยู่ (หลักฐานส่ง) · ไฟล์ที่ผูกกับตัวใบสั่ง = null',
  })
  deliveryOrderId!: string | null;
}

export class OrderDocumentListDto {
  @ApiProperty({
    type: [OrderDocumentDto],
    description:
      'ไฟล์ของ order และ DO ทุกใบ (รวมที่ยกเลิก) เรียงตามเวลาที่จอง · `downloadUrl` (หมดอายุ 5 นาที) ให้เฉพาะผู้มี `documents:read` และไฟล์ที่อัปโหลดเสร็จ',
  })
  data!: OrderDocumentDto[];
}

export class OrderEventDto {
  @ApiProperty({
    enum: ['STATUS', 'STOP_EVENT'],
    description: 'STATUS = สถานะใบเปลี่ยน · STOP_EVENT = event หน้างาน',
  })
  kind!: string;
  @ApiProperty({
    example: '2026-11-19T02:15:00.000Z',
    description: 'เวลาเกิด — STATUS = เวลาเปลี่ยนสถานะ · STOP_EVENT = occurredAt ของอุปกรณ์',
  })
  at!: string;
  @ApiProperty({ enum: ['order', 'delivery_order', 'stop'] }) entityType!: string;
  @ApiProperty({ example: 'do_3f2a…', description: 'id ของใบ/จุด (ord_ / do_ / stp_)' })
  entityId!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'DO-6911-0001',
    description: 'เลขเอกสาร (จุดแวะ = null)',
  })
  entityNo!: string | null;
  @ApiProperty({
    example: 'dispatched',
    description:
      'ชื่อเหตุการณ์ — STATUS = event ของ state machine (เช่น `received`, `dispatched`) · STOP_EVENT = ชนิด (`ARRIVE` …)',
  })
  event!: string;
  @ApiProperty({ nullable: true, type: String, example: 'PLANNED' }) fromStatus!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'DISPATCHED' }) toStatus!: string | null;
  @ApiProperty({
    type: StopEventDto,
    nullable: true,
    description: 'รายละเอียด event หน้างาน (occurredAt + receivedAt, พิกัด, ผล) — STATUS = null',
  })
  stopEvent!: StopEventDto | null;
}

export class OrderEventListDto {
  @ApiProperty({
    type: [OrderEventDto],
    description:
      'ประวัติของ order เรียงตามเวลา: สถานะของใบสั่ง + DO ทุกใบ (doc_status_history) และ event หน้างานของจุดรับ/ส่งของ DO (รวมที่ขัดลำดับ — ผลที่มีผลดู `GET /v1/stops/{id}/events`)',
  })
  data!: OrderEventDto[];
}

/**
 * Sub-resource อ่านอย่างเดียวของ order สำหรับระบบภายนอก (ST7-T11; docs/04 G2 #1 `/documents`, `/tracking`, `/events`;
 * research benchmark §10 #1, #11) — UI ใช้ endpoint เดียวกันได้ (API-first) · `{id}` รับ `ext:{externalId}`
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrderResourcesController {
  constructor(
    private readonly db: DbService,
    private readonly tracking: TrackingService,
  ) {}

  /** `ord_…` หรือ `ext:{externalId}` → ใบ (ไม่พบ/tenant อื่น = 404) */
  private resolve(id: string) {
    const select = { id: true, soNo: true, status: true } as const;
    const tx = this.db.tx;
    return resolveRef(
      'salesOrder',
      id,
      async (u) => tx.salesOrder.findUnique({ where: { id: u }, select }),
      async (e) => tx.salesOrder.findFirst({ where: { externalId: e }, select }),
    ).then((o) => {
      if (!o) throw new ProblemException('not_found');
      return o;
    });
  }

  private deliveryOrders(orderId: string) {
    return this.db.tx.deliveryOrder.findMany({
      where: { salesOrderId: orderId },
      orderBy: [{ createdAt: 'asc' }, { doNo: 'asc' }],
      select: { id: true, doNo: true, tripStopId: true, pickupTripStopId: true },
    });
  }

  @Get(':id/documents')
  @TenantResource('salesOrder')
  @RequireScope('orders:read')
  @ApiOperation({
    summary: 'ไฟล์ของ order (หลักฐานส่ง POD ของ DO ทุกใบ + ไฟล์ที่ผูกกับใบสั่ง)',
    description:
      'อ่านอย่างเดียว — อัปโหลดไฟล์ใหม่ใช้ `POST /v1/documents` (presigned) แล้วผูกผ่าน `PUT /v1/delivery-orders/{id}/pod` · ' +
      'ไม่มี `documents:read` = ได้ metadata แต่ไม่มี `downloadUrl`',
  })
  @ApiProblems(R403('documents'), R404('documents'))
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: OrderDocumentListDto })
  async documents(@Param('id') id: string, @Req() req: Request): Promise<OrderDocumentListDto> {
    const o = await this.resolve(id);
    const dos = await this.deliveryOrders(o.id);
    const rows = await this.db.tx.storedDocument.findMany({
      where: {
        kind: { not: 'EXPORT' },
        OR: [
          { entityType: 'sales_order', entityId: o.id },
          ...(dos.length
            ? [{ entityType: 'delivery_order', entityId: { in: dos.map((d) => d.id) } }]
            : []),
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const canRead = scopeAllows(requestContext.require().scopes ?? [], 'documents:read');
    const origin = apiOrigin(req);
    return {
      data: rows.map((d) => ({
        ...(canRead && d.status === 'READY' ? readyDocumentDto(d, origin) : toDocumentDto(d)),
        deliveryOrderId:
          d.entityType === 'delivery_order' && d.entityId
            ? encodeId('deliveryOrder', d.entityId)
            : null,
      })),
    };
  }

  @Get(':id/tracking')
  @TenantResource('salesOrder')
  @RequireScope('orders:read')
  @ApiOperation({
    summary: 'สถานะติดตามของ order — ขั้น ETA ตำแหน่งล่าสุด ต่อ DO',
    description:
      'ขั้น (stepper) และ ETA ตามกติกาของหน้าติดตามผู้รับ (ST4-T14) · ETA = ช่วงเวลาตามแผน (ยังไม่มี ETA สด — P1) · ' +
      'ตำแหน่ง = พิกัดของ event หน้างานล่าสุดของเที่ยว (ไม่มี GPS สด) · ทะเบียนปิด 2 หลัก · ห้าม cache',
  })
  @ApiProblems(R403('tracking'), R404('tracking'))
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: OrderTrackingDto })
  async trackingView(@Param('id') id: string, @Req() req: Request): Promise<OrderTrackingDto> {
    const o = await this.resolve(id);
    return {
      orderId: encodeId('salesOrder', o.id),
      soNo: o.soNo,
      orderStatus: o.status,
      deliveryOrders: await this.tracking.orderTracking(o.id, apiOrigin(req)),
    };
  }

  @Get(':id/events')
  @TenantResource('salesOrder')
  @RequireScope('orders:read')
  @ApiOperation({
    summary: 'ประวัติ order — สถานะใบสั่ง/DO + event หน้างาน เรียงตามเวลา',
    description:
      'audit trail สำหรับระบบภายนอก (ไม่รวมบันทึก/ข้อความภายใน) · event หน้างานมีทั้ง `occurredAt` (อุปกรณ์) และ `receivedAt` (server)',
  })
  @ApiProblems(R403('events'), R404('events'))
  @ApiOkResponse({ type: OrderEventListDto })
  async events(@Param('id') id: string): Promise<OrderEventListDto> {
    const tx = this.db.tx;
    const o = await this.resolve(id);
    const dos = await this.deliveryOrders(o.id);
    const doNo = new Map(dos.map((d) => [d.id, d.doNo]));
    const stopIds = [
      ...new Set(
        dos.flatMap((d) => [d.pickupTripStopId, d.tripStopId]).filter((s): s is string => !!s),
      ),
    ];
    const [history, stopEvents] = await Promise.all([
      tx.docStatusHistory.findMany({
        where: {
          OR: [
            { docType: 'sales_order', docId: o.id },
            ...(dos.length
              ? [{ docType: 'delivery_order', docId: { in: dos.map((d) => d.id) } }]
              : []),
          ],
        },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      }),
      stopIds.length
        ? tx.stopEvent.findMany({
            where: { tripStopId: { in: stopIds } },
            orderBy: [{ occurredAt: 'asc' }, { receivedAt: 'asc' }],
          })
        : Promise.resolve([]),
    ]);
    const items: OrderEventDto[] = [
      ...history.map((h) => {
        const isOrder = h.docType === 'sales_order';
        return {
          kind: 'STATUS',
          at: h.at.toISOString(),
          entityType: isOrder ? 'order' : 'delivery_order',
          entityId: isOrder ? encodeId('salesOrder', h.docId) : encodeId('deliveryOrder', h.docId),
          entityNo: isOrder ? o.soNo : (doNo.get(h.docId) ?? null),
          event: h.event,
          fromStatus: h.fromStatus,
          toStatus: h.toStatus,
          stopEvent: null,
        };
      }),
      ...stopEvents.map((e) => ({
        kind: 'STOP_EVENT',
        at: e.occurredAt.toISOString(),
        entityType: 'stop',
        entityId: encodeId('tripStop', e.tripStopId),
        entityNo: null,
        event: e.type,
        fromStatus: null,
        toStatus: null,
        stopEvent: toStopEventDto(e),
      })),
    ];
    // เรียงตามเวลา (คงลำดับเดิมเมื่อเวลาเท่ากัน — สถานะก่อน event หน้างาน)
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return { data: items };
  }
}
