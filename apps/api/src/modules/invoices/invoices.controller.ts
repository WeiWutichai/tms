import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { scopeAllows } from '@tms/domain';
import type { Request, Response } from 'express';
import {
  NoTransaction,
  RateLimitClass,
  RequireScope,
  TenantResource,
} from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404, tryDecodeId } from '../../common/ids';
import { PROBLEMS, ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { DeliveryOrderDto } from '../delivery-orders/delivery-order.dto';
import { toDeliveryOrderDto } from '../delivery-orders/do-dto';
import { T403, T404, T409, T412, T422 } from '../trips/trip-problems';
import { isRealDate } from '../vehicle-documents/expiry';
import {
  BillingQueuePageDto,
  BillingQueueQuery,
  BulkReleaseDeliveryOrdersDto,
  BulkReleaseResultsDto,
  ReleaseDeliveryOrderDto,
  UnreleaseDeliveryOrderDto,
} from './billing-queue.dto';
import { BillingQueueService } from './billing-queue.service';
import { BillingReleaseService } from './billing-release.service';
import {
  AddInvoiceLineDto,
  CreateInvoiceDto,
  InvoiceDeliveryOrdersDto,
  InvoiceDto,
  InvoiceLineIdsDto,
  InvoiceListQuery,
  InvoiceMoveResultDto,
  InvoicePageDto,
  InvoiceReasonDto,
  InvoiceSummaryCountsDto,
  MoveInvoiceDeliveryOrdersDto,
  RemoveInvoiceDeliveryOrdersDto,
  UpdateInvoiceDto,
  UpdateInvoiceLineDto,
} from './invoice.dto';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoicesService } from './invoices.service';

const NF = { ...T404, description: 'ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น)' };
const IF_MATCH = {
  name: 'If-Match',
  required: false,
  description: 'ETag (version) จาก GET — ไม่ตรง → 412',
};
const PULL_409 = {
  status: 409,
  description:
    '`not_ready_to_bill` — DO ยังไม่พร้อม (ตรวจซ้ำตอนดึง): `reasons[]` + `deliveryOrders[]` (ต่อ DO: `reasons`, `missing`) — ' +
    'รวม `NOT_RELEASED` (ยังไม่ส่งบัญชี) · `do_already_drafted` — DO อยู่ในใบแจ้งหนี้อื่นที่ยัง active · ' +
    '`invalid_state_transition` — ใบไม่ใช่ร่าง',
  examples: {
    not_ready_to_bill: {
      type: 'https://docs.tms.example/problems/not_ready_to_bill',
      title: PROBLEMS.not_ready_to_bill.th,
      status: 409,
      code: 'not_ready_to_bill',
      reasons: ['NOT_RELEASED'],
      deliveryOrders: [
        { deliveryOrderId: 'do_3f2a…', doNo: 'DO-2611-00012', reasons: ['NOT_RELEASED'] },
      ],
    },
    do_already_drafted: {
      type: 'https://docs.tms.example/problems/do_already_drafted',
      title: PROBLEMS.do_already_drafted.th,
      status: 409,
      code: 'do_already_drafted',
      deliveryOrderId: 'do_3f2a…',
      doNo: 'DO-2611-00012',
      billingStatus: 'IN_DRAFT',
    },
  },
};

const NOT_READY = {
  status: 409,
  description:
    '`not_ready_to_bill` — DO ยังไม่พร้อมวางบิล: `reasons[]` (NOT_DELIVERED · BILLING_HOLD · PRICING_UNAVAILABLE · NO_REVENUE · ' +
    'REVENUE_PROVISIONAL · REVENUE_LOCKED · SURCHARGE_PENDING · STOP_TIMES_MISSING · POD_INCOMPLETE · IN_INVOICE) + `missing[]` เมื่อหลักฐานไม่ครบ',
  examples: {
    not_ready_to_bill: {
      type: 'https://docs.tms.example/problems/not_ready_to_bill',
      title: PROBLEMS.not_ready_to_bill.th,
      status: 409,
      code: 'not_ready_to_bill',
      instance: '/v1/delivery-orders/do_3f2a…/release',
      requestId: 'b6a1c2d3-…',
      reasons: ['POD_INCOMPLETE'],
      missing: [{ key: 'photo', type: 'PHOTO', code: 'min_count', expected: 1, actual: 0 }],
    },
  },
};

/** ST5-T06 ใบส่งของอยู่ในใบแจ้งหนี้ (ร่าง/ออกเลขแล้ว) — ย้อนการส่งบัญชีไม่ได้ */
const IN_INVOICE_409 = {
  status: 409,
  description:
    '`invalid_state_transition` + `errors[].code = do_in_invoice` + `billingStatus` (IN_DRAFT ถอดออกจากร่างก่อน · INVOICED ย้อนไม่ได้)',
  examples: {
    do_in_invoice: {
      type: 'https://docs.tms.example/problems/invalid_state_transition',
      title: PROBLEMS.invalid_state_transition.th,
      status: 409,
      code: 'invalid_state_transition',
      instance: '/v1/delivery-orders/do_3f2a…/unrelease',
      requestId: 'b6a1c2d3-…',
      errors: [
        { field: 'deliveryOrderId', code: 'do_in_invoice', message: 'delivery order is INVOICED' },
      ],
      billingStatus: 'INVOICED',
      doStatus: 'BILLED',
    },
  },
};

/**
 * วางบิล (AR — docs/04 F3, docs/01 §5.2 #8 `invoices`)
 * ST5-T04: คิวพร้อมวางบิล — ร่าง/ออกใบ = ST5-T07/T09
 */
@ApiTags('invoices')
@ApiBearerAuth()
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly queue: BillingQueueService,
    private readonly svc: InvoicesService,
    private readonly pdf: InvoicePdfService,
  ) {}

  // ประกาศ `queue` ก่อน `:id` เสมอ (ไม่งั้น /invoices/queue ถูกจับเป็น id) — test/invoices-draft.test.ts ตรวจลำดับ route
  @Get('queue')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'คิวพร้อมวางบิล (DO ที่ส่งแล้ว หลักฐานครบ และราคาพร้อม)',
    description:
      'DO ที่ส่งถึงแล้ว (DELIVERED/POD_PENDING/UNBILLED) ที่ใบสั่ง `pricingStatus = AVAILABLE` และมีบรรทัดรายได้ที่ยืนยันแล้ว ' +
      '(ไม่มีบรรทัดยอดชั่วคราว/ล็อก ไม่มีค่าใช้จ่ายหน้างานฝั่งขายรอยืนยัน) และไม่ถูกระงับวางบิล · ' +
      'ลูกค้าที่เปิด "ไม่มี POD ไม่วางบิล" (`requirePodToBill`, ค่าเริ่มต้นเปิด) → DO ที่หลักฐานส่งยังไม่ครบตาม checklist ไม่ขึ้นคิว · ' +
      'กรองลูกค้า (`customerId` รับ `ext:`) / ช่วงวันที่ส่ง (`doDate`) / หลักฐานครบ / ส่งบัญชีแล้ว · ' +
      '`customers` = ยอดรวมต่อลูกค้าของทุกแถวที่ตรงตัวกรอง · ยอดเงิน (`sell*`) เห็นเมื่อมี `prices.sell:read`',
  })
  @ApiProblems(T403('invoices:read'), T422)
  @ApiOkResponse({ type: BillingQueuePageDto })
  async list(@Query() q: BillingQueueQuery): Promise<BillingQueuePageDto> {
    const bad = (['dateFrom', 'dateTo'] as const).flatMap((f) =>
      q[f] !== undefined && !isRealDate(q[f]!)
        ? [{ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]
        : [],
    );
    if (q.dateFrom && q.dateTo && !bad.length && q.dateFrom > q.dateTo)
      bad.push({ field: 'dateTo', code: 'before_date_from', message: 'dateTo must be ≥ dateFrom' });
    if (bad.length) throw new ProblemException('validation_failed', undefined, bad);
    return this.queue.list(q);
  }

  // ---------- ST5-T07 ร่างใบแจ้งหนี้ (D-54: ใบแจ้งหนี้ — ไม่ใช่ใบกำกับภาษี) ----------

  @Get('summary')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'จำนวนใบแจ้งหนี้ตามสถานะ (แท็บ/KPI)',
    description: 'นับทั้ง tenant · เกินกำหนดเป็น 0 จนกว่าจะมีวันครบกำหนด/รับชำระ (ST5-T09/T22)',
  })
  @ApiProblems(T403('invoices:read'))
  @ApiOkResponse({ type: InvoiceSummaryCountsDto })
  summary(): Promise<InvoiceSummaryCountsDto> {
    return this.svc.summary();
  }

  @Post('preview')
  @HttpCode(200)
  @NoTransaction()
  @RequireScope('invoices:draft')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'PDF ตัวอย่างจาก DO ที่เลือก — ไม่บันทึกอะไร',
    description:
      'body เดียวกับ `POST /invoices` · ตรวจกติกาชุดเดียวกัน (ลูกค้าเดียว, เงื่อนไขส่งบัญชี + คิวพร้อมวางบิล, กันวางบิลซ้ำ) แต่ **ไม่สร้างร่าง ไม่ส่งบัญชี ไม่ลง audit** ' +
      '(ทำใน transaction แล้วย้อนทั้งหมด) · ไม่มีเลข มีลายน้ำ "ร่าง" ไม่มีคำว่า "ใบกำกับภาษี" · ต้องมี `prices.sell:read`',
  })
  @ApiProduces('application/pdf')
  @ApiProblems(T403('invoices:draft'), PULL_409, T422)
  @ApiOkResponse({ description: 'application/pdf' })
  async preview(
    @Body() body: CreateInvoiceDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const ctx = requestContext.require();
    if (!scopeAllows(ctx.scopes ?? [], 'prices.sell:read'))
      throw new ProblemException('permission_denied', undefined, undefined, {
        requiredScope: 'prices.sell:read',
      });
    const { pdf } = await this.pdf.preview(body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="proforma-preview.pdf"');
    return new StreamableFile(pdf);
  }

  @Get()
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'รายการใบแจ้งหนี้',
    description:
      'กรองลูกค้า (`customerId` รับ `ext:` — ไม่พบ = ว่าง) / สถานะ · cursor มาตรฐาน (updatedAt, id) · ร่างไม่มีเลข (`invoiceNo` = null) · ' +
      'ยอด `sell*` เห็นเมื่อมี `prices.sell:read`',
  })
  @ApiProblems(T403('invoices:read'), T422)
  @ApiOkResponse({ type: InvoicePageDto })
  listInvoices(@Query() q: InvoiceListQuery): Promise<InvoicePageDto> {
    return this.svc.list(q);
  }

  @Post()
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'สร้างร่างใบแจ้งหนี้จาก DO หลายใบของลูกค้าเดียว (ไม่มีเลข)',
    description:
      'D-54 บัญชีเบา: **ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี** · ทุก DO ต้องเป็นของลูกค้ารายนี้ **ส่งบัญชีแล้ว** (`POST /delivery-orders/{id}/release`) และ ' +
      '**ตรวจความพร้อมซ้ำตอนดึง** (เงื่อนไขเดียวกับคิว `GET /invoices/queue` + เวลาจุดส่ง + หลักฐานตาม checklist ปัจจุบัน — ไม่เชื่อเวลาส่งบัญชีอย่างเดียว) ' +
      'ไม่ผ่าน → 409 `not_ready_to_bill` · DO อยู่ในใบอื่นที่ active → 409 `do_already_drafted` (กันวางบิลซ้ำ — ระดับ DB) · ' +
      '1 บรรทัด = 1 บรรทัดรายได้ของ DO (ค่าขนส่ง/บริการประกอบ/ค่าใช้จ่ายหน้างาน — `vatType`/`whtRate` ต่อบรรทัด) · ' +
      'DO → `billingStatus` IN_DRAFT (ราคาที่ order ล็อก) · ยอด VAT/WHT **ประมาณการ** (computeDocumentTax) · ' +
      'ผู้ออก = บริษัทวางบิลตั้งต้นของลูกค้า + สาขาผู้ออกตั้งต้น · เครดิตจากลูกค้า · งวดไม่ส่ง = ช่วงวันที่ DO · ' +
      '**ไม่เข้า outbox/webhook** (ส่งระบบบัญชีหลังออกเลข) · audit `invoice.draft_created`',
  })
  @ApiProblems(T403('invoices:draft'), PULL_409, T422)
  @ApiCreatedResponse({ type: InvoiceDto })
  async create(
    @Body() body: CreateInvoiceDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.create(body);
    setEtag(res, out.version);
    return out;
  }

  @Get(':id')
  @TenantResource('invoice')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'ใบแจ้งหนี้ + บรรทัด + บรรทัดบนเอกสาร (Group / Merge / Single)',
    description:
      '`lines` = บรรทัดจริง (รวมที่ถอดออกแล้ว `active=false`) · `printLines` = รูปบนเอกสารตาม `lineMode` + กลุ่มที่รวมเอง · ' +
      'ยอดภาษีเป็นประมาณการ (`taxEstimated`) · `sell*` เห็นเมื่อมี `prices.sell:read`',
  })
  @ApiProblems(T403('invoices:read'), NF)
  @ApiOkResponse({ type: InvoiceDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.get(decodeIdOr404('invoice', id));
    setEtag(res, out.version);
    return out;
  }

  @Get(':id/proforma')
  @NoTransaction()
  @TenantResource('invoice')
  @RequireScope('invoices:read')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'PDF ตัวอย่าง (pro forma) ของร่าง — ไม่มีเลข มีลายน้ำ "ร่าง"',
    description:
      'เฉพาะใบ DRAFT (อื่น ๆ → 409 — PDF ใบที่ออกแล้ว = ST5-T08) · render ใหม่ทุกครั้งตามร่างล่าสุด (ไม่เก็บไฟล์) · ' +
      'ไม่มีคำว่า "ใบกำกับภาษี" · ยอด VAT/WHT ประมาณการ · ต้องมี `prices.sell:read` (มีราคา) ไม่งั้น 403',
  })
  @ApiProduces('application/pdf')
  @ApiProblems(T403('invoices:read'), NF, T409())
  @ApiOkResponse({ description: 'application/pdf' })
  async proforma(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const ctx = requestContext.require();
    if (!scopeAllows(ctx.scopes ?? [], 'prices.sell:read'))
      throw new ProblemException('permission_denied', undefined, undefined, {
        requiredScope: 'prices.sell:read',
      });
    const { pdf } = await this.pdf.proforma(decodeIdOr404('invoice', id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="proforma-${id}.pdf"`);
    return new StreamableFile(pdf);
  }

  @Patch(':id')
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'แก้หัวร่าง — รูปบรรทัด (Group / Merge / Single) งวด เครดิต เลข PO หมายเหตุ',
    description: 'เฉพาะ DRAFT (อื่น ๆ → 409) · audit `invoice.draft_updated` (เฉพาะช่องที่เปลี่ยน)',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateInvoiceDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.update(decodeIdOr404('invoice', id), body, expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/delivery-orders')
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'เพิ่ม DO เข้าร่าง',
    description:
      'กฎเดียวกับตอนสร้าง (ส่งบัญชีแล้ว + ตรวจความพร้อมซ้ำ · กันวางบิลซ้ำ) · ลูกค้าอื่น → 422 `customer_mismatch` · audit `invoice.delivery_orders_added`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, PULL_409, T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async addDos(
    @Param('id') id: string,
    @Body() body: InvoiceDeliveryOrdersDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.addDeliveryOrders(
      decodeIdOr404('invoice', id),
      body.deliveryOrderIds,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/delivery-orders/remove')
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ถอด DO ออกจากร่าง — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'บรรทัดของ DO คงอยู่ (`active` false + เหตุผล — ไม่มีการลบ) · DO กลับ UNBILLED (ขึ้นคิวพร้อมวางบิลอีก ราคาที่ order ปลดล็อก) · ' +
      'DO ไม่อยู่ในร่างนี้ → 422 `not_on_invoice` · audit `invoice.delivery_orders_removed`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async removeDos(
    @Param('id') id: string,
    @Body() body: RemoveInvoiceDeliveryOrdersDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.removeDeliveryOrders(
      decodeIdOr404('invoice', id),
      body.deliveryOrderIds,
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/delivery-orders/move')
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ย้าย DO ไปร่างอื่น (ลูกค้า + สาขาผู้ออกเดียวกัน)',
    description:
      'ถอดจากร่างนี้แล้วดึงเข้าร่างปลายทางใน transaction เดียว (ตรวจความพร้อมซ้ำ — ไม่ผ่าน = ไม่ย้ายเลย) · ปลายทางไม่ใช่ร่าง → 409 · ' +
      'ลูกค้า/สาขาต่างกัน → 422 `customer_mismatch` · If-Match = version ของร่างต้นทาง · ETag ตอบกลับ = ต้นทาง · audit ทั้งสองใบ',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, PULL_409, T412, T422)
  @ApiOkResponse({ type: InvoiceMoveResultDto })
  async moveDos(
    @Param('id') id: string,
    @Body() body: MoveInvoiceDeliveryOrdersDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceMoveResultDto> {
    const out = await this.svc.moveDeliveryOrders(
      decodeIdOr404('invoice', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, out.source.version);
    return out;
  }

  @Post(':id/lines')
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'เพิ่มบรรทัดเอง (ไม่ผูก DO) — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'ประเภท VAT / อัตราหัก ณ ที่จ่าย / หน่วย ตามรายการบริการ (snapshot) · ยอด = จำนวน × ราคา ปัดครึ่งขึ้น 2 ตำแหน่ง · ' +
      'ราคาต้องมี `prices.sell:write` · audit `invoice.line_added`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async addLine(
    @Param('id') id: string,
    @Body() body: AddInvoiceLineDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.addLine(decodeIdOr404('invoice', id), body, expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/lines/merge')
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'รวมบรรทัด (Merge) บนเอกสาร',
    description:
      '≥ 2 บรรทัดที่ยังใช้ ประเภท VAT + อัตราหักเดียวกัน (ปน → 422 `mixed_tax_treatment`) · รวมเป็นบรรทัดเดียวบนเอกสาร — ยอดเงิน/ภาษีไม่เปลี่ยน · ' +
      'audit `invoice.lines_merged`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async merge(
    @Param('id') id: string,
    @Body() body: InvoiceLineIdsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.mergeLines(
      decodeIdOr404('invoice', id),
      body.lineIds,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/lines/split')
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'แยกบรรทัดที่รวมไว้ — กลับไปตามรูปบรรทัดของใบ',
    description: 'audit `invoice.lines_split`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async split(
    @Param('id') id: string,
    @Body() body: InvoiceLineIdsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.splitLines(
      decodeIdOr404('invoice', id),
      body.lineIds,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Patch(':id/lines/:lineId')
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'แก้บรรทัดในร่าง — คำอธิบาย / ส่วนลด',
    description:
      'ส่วนลด = แก้ราคาที่ร่าง (ราคาที่ order ล็อก) — ≥ 0 และ ≤ ยอดก่อนส่วนลด · ต้องมี `prices.sell:write` + `reason` · ' +
      'ยอดบรรทัด = ยอดก่อนส่วนลด − ส่วนลด · audit `invoice.line_updated`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: UpdateInvoiceLineDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.updateLine(
      decodeIdOr404('invoice', id),
      decodeIdOr404('invoiceLine', lineId),
      body,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/lines/:lineId/remove')
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ถอดบรรทัดที่เพิ่มเอง — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'บรรทัดคงอยู่ (`active` false + เหตุผล) · บรรทัดของ DO ถอดทั้ง DO ด้วย `POST /invoices/{id}/delivery-orders/remove` (422 `delivery_order_line`) · ' +
      'audit `invoice.line_removed`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async removeLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: InvoiceReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.removeLine(
      decodeIdOr404('invoice', id),
      decodeIdOr404('invoiceLine', lineId),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ยกเลิกร่าง — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'DRAFT → CANCELLED (docs/01 §4.4 — ไม่มีการลบ) · บรรทัดหยุดนับ · DO กลับ UNBILLED (ขึ้นคิวอีก) · ใบที่ออกแล้วยกเลิกที่นี่ไม่ได้ (409 — ST5-T10) · ' +
      'audit `invoice.draft_cancelled`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: InvoiceReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.svc.cancel(
      decodeIdOr404('invoice', id),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }
}

/**
 * ขั้นส่งบัญชี (RELEASED — ST5-T04; docs/04 F3/F4) ของใบส่งของ — สิทธิ์ `invoices:draft` (A3: owner/admin/invoicer/accounting)
 */
@ApiTags('delivery-orders')
@ApiBearerAuth()
@Controller('delivery-orders')
export class DeliveryOrderReleaseController {
  constructor(private readonly release: BillingReleaseService) {}

  @Post(':id/release')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ส่งบัญชี (RELEASED) — ใบส่งของพร้อมวางบิล',
    description:
      'ตรวจเงื่อนไขชุดเดียวกับคิวพร้อมวางบิล + จุดส่งมีเวลาถึง/ออกครบ + (ลูกค้าเปิด "ไม่มี POD ไม่วางบิล") หลักฐานล่าสุดผ่าน checklist **ปัจจุบัน** ' +
      'ของลูกค้า → บันทึกเวลา/ผู้ส่งบัญชี + audit `delivery_order.released` · สถานะ DO ไม่เปลี่ยน · ส่งแล้ว = ตอบ DO เดิม (ไม่ทำซ้ำ)',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(T403('invoices:draft'), T422, NOT_READY)
  @ApiOkResponse({ type: DeliveryOrderDto })
  async releaseOne(
    @Param('id') id: string,
    @Body() body: ReleaseDeliveryOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const r = await this.release.release(decodeIdOr404('deliveryOrder', id), {
      version: expectedVersion(req),
      note: body.note ?? null,
    });
    setEtag(res, r.d.version);
    return toDeliveryOrderDto(r.d);
  }

  @Post(':id/unrelease')
  @HttpCode(200)
  @TenantResource('deliveryOrder')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ย้อนการส่งบัญชี (RELEASED → DELIVERED)',
    description:
      'docs/04 F4 "RELEASED ย้อนได้โดย Invoicer": ล้างเวลา/ผู้ส่งบัญชี + audit `delivery_order.unreleased` (เหตุผลบังคับ) · ' +
      'หลังย้อนแก้จุดแวะ/ยอดส่งจริงได้อีก (ล็อกหลังส่งบัญชี — 409 `do_released`) · ใบส่งของในร่างใบแจ้งหนี้ → 409 `do_in_invoice` ' +
      '(ถอดออกจากร่างก่อน) · ออกใบแล้ว (INVOICED) ย้อนไม่ได้ — ใช้ใบลดหนี้ · ยังไม่ส่งบัญชี = ตอบใบเดิม (ไม่ทำซ้ำ)',
  })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(T403('invoices:draft'), T422, IN_INVOICE_409)
  @ApiOkResponse({ type: DeliveryOrderDto })
  async unrelease(
    @Param('id') id: string,
    @Body() body: UnreleaseDeliveryOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryOrderDto> {
    const d = await this.release.unrelease(decodeIdOr404('deliveryOrder', id), {
      version: expectedVersion(req),
      reason: body.reason,
    });
    setEtag(res, d.version);
    return toDeliveryOrderDto(d);
  }

  @Post('bulk-release')
  @RateLimitClass('heavy')
  @HttpCode(207)
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ส่งบัญชีหลายใบส่งของ',
    description:
      '≤ 100 รายการ ทำทีละรายการแยกกัน (สำเร็จบางรายการได้) · เงื่อนไขเหมือน `POST /delivery-orders/{id}/release` · ' +
      'ตอบ 207 เสมอเมื่อคำขอถูกต้อง — ดู `results[].outcome` / `problem`',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiProblems(T403('invoices:draft'), T422)
  @ApiResponse({ status: 207, type: BulkReleaseResultsDto, description: 'ผลต่อรายการ' })
  async bulkRelease(@Body() body: BulkReleaseDeliveryOrdersDto): Promise<BulkReleaseResultsDto> {
    const ids = body.items.map((i) => i.deliveryOrderId);
    const dup = ids.flatMap((x, i) =>
      ids.indexOf(x) !== i
        ? [{ field: `items[${i}].deliveryOrderId`, code: 'duplicate', message: 'listed twice' }]
        : [],
    );
    if (dup.length) throw new ProblemException('validation_failed', undefined, dup);
    const out = await this.release.bulkRelease(
      body.items.map((i) => ({
        id: tryDecodeId('deliveryOrder', i.deliveryOrderId),
        version: i.version,
      })),
      body.note ?? null,
    );
    const results = out.map((r, i) => {
      const deliveryOrderId = body.items[i]!.deliveryOrderId;
      if ('ok' in r)
        return {
          deliveryOrderId,
          doNo: r.ok.d.doNo,
          status: 200,
          outcome: r.ok.outcome,
          deliveryOrder: toDeliveryOrderDto(r.ok.d),
          problem: null,
        };
      const problem = problemOf(r.error);
      return {
        deliveryOrderId,
        doNo: null,
        status: problem.status,
        outcome: 'FAILED' as const,
        deliveryOrder: null,
        problem,
      };
    });
    const n = (o: string) => results.filter((r) => r.outcome === o).length;
    return { results, succeeded: n('RELEASED'), unchanged: n('UNCHANGED'), failed: n('FAILED') };
  }
}

/** problem body ของรายการใน bulk (รูปเดียวกับ ProblemFilter — ไม่มี instance/requestId ต่อรายการ) */
function problemOf(p: ProblemException) {
  const locale = requestContext.get()?.locale ?? 'th';
  const def = PROBLEMS[p.code];
  return {
    type: `https://docs.tms.example/problems/${p.code}`,
    title: def[locale],
    status: def.status as number,
    code: p.code as string,
    ...(p.detail ? { detail: p.detail } : {}),
    ...(p.errors?.length ? { errors: p.errors } : {}),
    ...((p.extra ?? {}) as Record<string, unknown>),
  };
}
