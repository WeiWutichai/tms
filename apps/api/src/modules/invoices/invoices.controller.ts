import {
  MAX_DOS_PER_INVOICE,
  UNWIND_IDEMPOTENCY_LOCK_MS,
  UNWIND_TX_TIMEOUT_MS,
} from './billing-limits';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
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
  StepUpAlways,
  RequireScope,
  TenantResource,
  IdempotencyLockMs,
  TransactionTimeout,
} from '../../common/decorators';
import { assertHumanStepUp } from '../../auth/step-up';
import { expectedVersion, setEtag } from '../../common/etag';
import { ApiExternalIdParam, ExternalIdPipe, extRef } from '../../common/external-id';
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
  InvoicePdfQuery,
  UnmarkInvoiceSentDto,
  VoidInvoiceDto,
} from './invoice.dto';
import { InvoiceCancelService } from './invoice-cancel.service';
import { InvoiceStatusService } from './invoice-status.service';
import { InvoiceFinalizeService } from './invoice-finalize.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoicesService } from './invoices.service';
import {
  DocumentEmailListDto,
  DocumentEmailResultDto,
  SEND_422,
  SEND_429,
  SendInvoiceDto,
} from './document-email.dto';
import { DocumentEmailService } from './document-email.service';
import { documentSyncDto } from '../erp/document-sync.dto';
import { ExternalMappingService } from '../erp/external-mapping.service';

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
    private readonly finalizer: InvoiceFinalizeService,
    private readonly canceller: InvoiceCancelService,
    private readonly status: InvoiceStatusService,
    private readonly mail: DocumentEmailService,
    private readonly mappings: ExternalMappingService,
  ) {}

  // ประกาศ `queue` ก่อน `:id` เสมอ (ไม่งั้น /invoices/queue ถูกจับเป็น id) — test/invoices-draft.test.ts ตรวจลำดับ route
  @Get('queue')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'คิวพร้อมวางบิล (DO ที่ส่งแล้ว หลักฐานครบ และราคาพร้อม)',
    description:
      'DO ที่ส่งถึงแล้ว (DELIVERED/POD_PENDING/UNBILLED) ที่ใบสั่งมีราคา (`pricingStatus = AVAILABLE` หรือกำหนดราคาเองแล้ว — `POST /orders/{id}/manual-price`) และมีบรรทัดรายได้ที่ยืนยันแล้ว ' +
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
    summary: 'จำนวนและยอดใบแจ้งหนี้ตามสถานะ (แท็บ/KPI + Dashboard บิล)',
    description:
      'นับทั้ง tenant · แท็บแยกกันไม่ซ้อน: เกินกำหนด (ธง `overdue` — ST5-T18) มาก่อน "ออกแล้ว"/"ชำระบางส่วน" · ' +
      'ST9-T02 Dashboard บิล: ยอดต่อแท็บ (`sellDraftTotal` = ยอดรวมร่าง · `sell*Outstanding` = ยอดรวม − ยอดตัดชำระ — ' +
      'ตรงกับ Σ ของ `GET /invoices` ตัวกรองเดียวกัน) + ใบที่ออกเดือนนี้ (ถึงวันนี้) vs เดือนก่อน (ทั้งเดือน) ตาม `issueDate` เวลาไทย ไม่รวมร่าง/ยกเลิก · ' +
      'ค้างวางบิล = `GET /invoices/queue` `totals` · รับชำระเดือนนี้/ก่อน = `GET /payments/summary` · ' +
      'ยอด `sell*` เห็นเมื่อมี `prices.sell:read` (จำนวนเห็นเสมอ) · D-54: ใบแจ้งหนี้ไม่ใช่ใบกำกับภาษี ยอด VAT/WHT เป็นประมาณการ',
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

  @Put('external/:externalId')
  @RequireScope('invoices:draft')
  @ApiExternalIdParam()
  @ApiHeader({ ...IF_MATCH, description: 'ETag — ใช้เมื่อใบมีอยู่แล้ว (ไม่ตรง → 412)' })
  @ApiOperation({
    summary: 'สร้าง/แก้ร่างใบแจ้งหนี้ด้วยเลขของระบบต้นทาง (upsert — D68-45)',
    description:
      'ยังไม่มีใบที่ externalId นี้ → สร้างร่าง (กติกาเดียวกับ `POST /invoices`) 201 · มีแล้ว → 200: ' +
      'ลูกค้า + ชุด DO ต้องตรงกับใบ (เพิ่ม/ถอด DO ใช้ `/invoices/{id}/delivery-orders…`) ไม่ตรง → 409 `conflict` · ' +
      'ช่องหัวใบ (งวด/รูปบรรทัด/เลข PO/หมายเหตุ) เหมือนเดิม → ใบเดิม version เดิม (ส่งซ้ำได้) · ต่าง: ร่าง → แก้ (เหมือน PATCH) · ' +
      '**ใบที่ออกแล้ว/ยกเลิกแก้ไม่ได้ → 409 `invalid_state_transition`** (docs/04 F3) · externalId ตั้งได้ตอนสร้างเท่านั้น · ' +
      'path `{id}` ทุก route รับ `ext:{externalId}`',
  })
  @ApiProblems(
    T403('invoices:draft'),
    {
      ...PULL_409,
      description: `${PULL_409.description} · \`conflict\` — ใบที่มีอยู่มีลูกค้า/ชุด DO ต่างจากที่ส่ง`,
      examples: { ...PULL_409.examples, ...T409('conflict').examples },
    },
    T412,
    T422,
  )
  @ApiOkResponse({ type: InvoiceDto, description: 'มีอยู่แล้ว → ใบเดิม (แก้หัวร่างถ้าต่าง)' })
  @ApiCreatedResponse({ type: InvoiceDto, description: 'ยังไม่มี → สร้างร่าง' })
  async upsertExternal(
    @Param('externalId', ExternalIdPipe) externalId: string,
    @Body() body: CreateInvoiceDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const { out, created } = await this.svc.upsertExternal(externalId, body, expectedVersion(req));
    res.status(created ? 201 : 200);
    setEtag(res, out.version);
    return out;
  }

  @Patch('external/:externalId')
  @RequireScope('invoices:draft')
  @ApiExternalIdParam()
  @ApiOperation({
    summary: 'แก้หัวร่างด้วยเลขของระบบต้นทาง (= `PATCH /invoices/ext:{externalId}`)',
    description:
      'กติกาเดียวกับ `PATCH /invoices/{id}` — เฉพาะ DRAFT (ออกแล้ว → 409) · ยังไม่มีใบนี้ → 404 (สร้างใช้ PUT)',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  patchExternal(
    @Param('externalId', ExternalIdPipe) externalId: string,
    @Body() body: UpdateInvoiceDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    return this.update(extRef(externalId), body, req, res);
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
    const uuid = await this.svc.idOf(id);
    const out = await this.svc.get(uuid);
    // ST7-T15 เลขเอกสารสองฝั่ง (docs/04 G3) — ผลการส่งเข้าระบบบัญชี แยกจากสถานะเอกสาร
    out.sync = documentSyncDto(await this.mappings.documentSync('INVOICE', uuid));
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
      'เฉพาะใบ DRAFT (อื่น ๆ → 409 — PDF ใบที่ออกแล้ว = ST5-T09) · แม่แบบใบแจ้งหนี้เต็ม (หัวผู้ออก/ลูกค้า + สาขา, เส้นรวมยกเว้น/7%, WHT ที่คาดว่าจะถูกหัก, ครบกำหนด, PO, จำนวนเงินตัวอักษร, แบ่งหน้า) · render ใหม่ทุกครั้งตามร่างล่าสุด (ไม่เก็บไฟล์) · ' +
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
    const { pdf } = await this.pdf.proforma(await this.svc.idOf(id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="proforma-${id}.pdf"`);
    return new StreamableFile(pdf);
  }

  @Post(':id/finalize')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('invoice')
  @RequireScope('invoices:finalize')
  @ApiOperation({
    summary: 'ออกเอกสาร (finalize) — ออกเลขใบแจ้งหนี้ + ล็อก (D-54: ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี)',
    description:
      'DRAFT → ISSUED (docs/01 §4.4, docs/04 F3) · ตรวจ (spec/05 BIL-037/038) → ไม่ผ่าน 409 `invoice_not_finalizable` + `reasons[]`: ' +
      '`no_lines` · `total_not_positive` · `customer_tax_id_missing` · `customer_branch_missing` · `line_vat_type_missing` · ' +
      '`revenue_line_provisional` (+ `lines[]` — ยอดยังไม่ยืนยัน บันทึกยอดส่งจริงก่อน) · `issuer_not_vat_registered` (ผู้ออกไม่จด VAT แต่มีบรรทัด VAT 7%) · ' +
      '**แบ่งหน้าที่ (docs/04 A3):** ผู้สร้าง/ผู้แก้ร่างล่าสุด (API key = ผู้ออก key) ออกใบนั้นเองไม่ได้ → 403 `invoice_self_finalize` ' +
      '(เว้น tenant ตั้ง `billing.allowSelfFinalize`) · ออกเลขชุด INV ต่อสาขาผู้ออก (เรียงไม่ข้าม พร้อมกันได้) · วันที่ออก = วันนี้ (เวลาไทย) · ' +
      'ครบกำหนด = วันที่ออก + เครดิต · เก็บ snapshot ลูกค้า/ผู้ออก · DO → INVOICED (+ UNBILLED → BILLED) · ล็อกบรรทัดรายได้ · ' +
      'audit + webhook `invoice.finalized` (transaction เดียว) · แล้ว render PDF ต้นฉบับเก็บแบบเขียนครั้งเดียว (`pdf`) · ' +
      '**ไม่มีเลขใบกำกับภาษี** (D-54/D-55 — ไม่ว่า connector ตั้งเจ้าของเอกสารภาษีเป็นใคร) · หลังนี้แก้/ยกเลิกร่าง/PATCH ไม่ได้ (409) · **sandbox (D-61):** ออกได้ — เลขจากชุดเลขของ sandbox ขึ้นต้น `TEST-` · PDF มีลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" · ไม่ส่งไป connector/ERP',
  })
  @ApiHeader({
    ...IF_MATCH,
    required: true,
    description: 'ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
  })
  @ApiProblems(
    {
      status: 403,
      description:
        'ไม่มีสิทธิ์ `invoices:finalize` / ผู้เตรียมร่างออกเอง (`invoice_self_finalize`)',
      examples: {
        ...T403('invoices:finalize').examples,
        invoice_self_finalize: {
          type: 'https://docs.tms.example/problems/invoice_self_finalize',
          title: PROBLEMS.invoice_self_finalize.th,
          status: 403,
          code: 'invoice_self_finalize',
        },
      },
    },
    NF,
    {
      status: 409,
      description:
        '`invoice_not_finalizable` (`reasons[]`) · `invalid_state_transition` (ไม่ใช่ร่าง)',
      examples: {
        invoice_not_finalizable: {
          type: 'https://docs.tms.example/problems/invoice_not_finalizable',
          title: PROBLEMS.invoice_not_finalizable.th,
          status: 409,
          code: 'invoice_not_finalizable',
          reasons: ['customer_branch_missing', 'revenue_line_provisional'],
          lines: [
            {
              id: 'ivl_…',
              lineNo: 2,
              deliveryOrderNo: 'DO-2611-00012',
              revenueLineId: 'rvl_…',
            },
          ],
        },
      },
    },
    T412,
    T422,
  )
  @ApiOkResponse({ type: InvoiceDto })
  async finalize(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.finalizer.finalize(await this.svc.idOf(id), expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }

  @Get(':id/pdf')
  @NoTransaction()
  @TenantResource('issuedInvoice')
  @RequireScope('invoices:read')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'PDF ใบแจ้งหนี้ที่ออกแล้ว — ต้นฉบับ / สำเนา (ไฟล์ที่เก็บ ณ วันออก)',
    description:
      'ใบที่ออกเลขแล้วเท่านั้น (ร่าง → 409 ใช้ `/proforma`) · `copy=ORIGINAL` (ค่าเริ่ม) = ไฟล์ต้นฉบับที่เก็บตอนออก · `copy=COPY` = สำเนา ' +
      'render จาก snapshot ณ วันออกครั้งแรกที่ขอแล้วเก็บ (spec/05 BIL-195/196) — ไม่ render ตามข้อมูลลูกค้าปัจจุบัน · ยังไม่มีไฟล์ (render ตอนออกล้ม) → สร้างให้แล้วเก็บ · ' +
      'header `X-Content-SHA256` · ไม่มีคำว่า "ใบกำกับภาษี" (D-54) · ต้องมี `prices.sell:read` ไม่งั้น 403 · ' +
      '**ใบที่ยกเลิกแล้ว (ST5-T10)** = ไฟล์ลายน้ำ "ยกเลิก" (spec/05 BIL-195) ที่ render ด้วยแม่แบบวันออกแล้วเก็บตอนยกเลิก · ' +
      'แม่แบบเปลี่ยนแล้วและยังไม่มีไฟล์ลายน้ำ → ส่งไฟล์ต้นฉบับที่เก็บแทน + header `X-Invoice-Pdf-Note: cancelled-watermark-unavailable` · ไฟล์ต้นฉบับ/สำเนาคงเดิม',
  })
  @ApiProduces('application/pdf')
  @ApiProblems(T403('invoices:read'), NF, T409())
  @ApiOkResponse({ description: 'application/pdf' })
  async issuedPdf(
    @Param('id') id: string,
    @Query() q: InvoicePdfQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const ctx = requestContext.require();
    if (!scopeAllows(ctx.scopes ?? [], 'prices.sell:read'))
      throw new ProblemException('permission_denied', undefined, undefined, {
        requiredScope: 'prices.sell:read',
      });
    const f = await this.finalizer.downloadPdf(await this.svc.idOf(id), q.copy ?? 'ORIGINAL');
    const data = f.data;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-SHA256', f.sha256);
    if (f.note) res.setHeader('X-Invoice-Pdf-Note', f.note);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`);
    return new StreamableFile(data);
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
    const out = await this.svc.update(await this.svc.idOf(id), body, expectedVersion(req));
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
      'กฎเดียวกับตอนสร้าง (ส่งบัญชีแล้ว + ตรวจความพร้อมซ้ำ · กันวางบิลซ้ำ) · ลูกค้าอื่น → 422 `customer_mismatch` · ' +
      `DO บนร่างรวมกับที่เพิ่มเกิน ${MAX_DOS_PER_INVOICE} ใบ → 422 \`too_many\` · audit \`invoice.delivery_orders_added\``,
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
      await this.svc.idOf(id),
      body.deliveryOrderIds,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/delivery-orders/remove')
  @TransactionTimeout(UNWIND_TX_TIMEOUT_MS)
  @IdempotencyLockMs(UNWIND_IDEMPOTENCY_LOCK_MS)
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
      await this.svc.idOf(id),
      body.deliveryOrderIds,
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/delivery-orders/move')
  @TransactionTimeout(UNWIND_TX_TIMEOUT_MS)
  @IdempotencyLockMs(UNWIND_IDEMPOTENCY_LOCK_MS)
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ย้าย DO ไปร่างอื่น (ลูกค้า + สาขาผู้ออกเดียวกัน)',
    description:
      'ถอดจากร่างนี้แล้วดึงเข้าร่างปลายทางใน transaction เดียว (ตรวจความพร้อมซ้ำ — ไม่ผ่าน = ไม่ย้ายเลย) · ปลายทางไม่ใช่ร่าง → 409 · ' +
      'ลูกค้า/สาขาต่างกัน → 422 `customer_mismatch` · ' +
      `DO บนร่างปลายทางรวมกับที่ย้ายเกิน ${MAX_DOS_PER_INVOICE} ใบ → 422 \`too_many\` (ไม่ย้ายเลย) · ` +
      'If-Match = version ของร่างต้นทาง · ETag ตอบกลับ = ต้นทาง · audit ทั้งสองใบ',
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
      await this.svc.idOf(id),
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
    const out = await this.svc.addLine(await this.svc.idOf(id), body, expectedVersion(req));
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
      await this.svc.idOf(id),
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
      await this.svc.idOf(id),
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
      await this.svc.idOf(id),
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
      await this.svc.idOf(id),
      decodeIdOr404('invoiceLine', lineId),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/cancel')
  @TransactionTimeout(UNWIND_TX_TIMEOUT_MS)
  @IdempotencyLockMs(UNWIND_IDEMPOTENCY_LOCK_MS)
  @HttpCode(200)
  @TenantResource('invoice')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ยกเลิกร่าง — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'DRAFT → CANCELLED (docs/01 §4.4 — ไม่มีการลบ) · บรรทัดหยุดนับ · DO กลับ UNBILLED (ขึ้นคิวอีก) · ' +
      'ใบที่ออกแล้วยกเลิกที่นี่ไม่ได้ (409 — ใช้ `POST /v1/invoices/{id}/void`) · audit `invoice.draft_cancelled`',
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
    const out = await this.svc.cancel(await this.svc.idOf(id), body.reason, expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/void')
  @TransactionTimeout(UNWIND_TX_TIMEOUT_MS)
  @IdempotencyLockMs(UNWIND_IDEMPOTENCY_LOCK_MS)
  @HttpCode(200)
  @TenantResource('issuedInvoice')
  @RequireScope('invoices:void')
  @StepUpAlways('human') // D-67: ยกเลิกใบที่ออกแล้ว — ผู้ใช้ต้อง step-up 2FA · API key ตาม scope `invoices:void`
  @ApiOperation({
    summary: 'ยกเลิกใบแจ้งหนี้ที่ออกแล้ว (void) — คงเลข · ยังไม่รับชำระ · เหตุผล ≥ 10 ตัวอักษร',
    description:
      'ST5-T10 (docs/04 F3 "ยกเลิกใบ" + G1/G2 `/invoices/{id}/void`; spec/05 §3.6/§7; D-54 ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี) · สิทธิ์ `invoices:void` (owner/admin/manager — spec/05 §19) · **If-Match บังคับ** ' +
      '(ไม่ส่ง → 422 `if_match_required`) · ISSUED → **CANCELLED คงเลข** (เลขไม่ถูกออกซ้ำ · record ไม่ถูกลบ) · ' +
      'รับชำระแล้ว (บางส่วน/ครบ) → 409 `invoice_has_payments` (`payments[]` — กลับรายการก่อน) · ' +
      'อยู่ในใบวางบิลที่ออกแล้ว/เก็บเงินแล้ว → 409 `invoice_on_billing_note` (`billingNoteNo` — ยกเลิกใบวางบิลก่อน) · ' +
      '**ส่งลูกค้าแล้ว** → 409 `invoice_sent_to_customer` (ST5-T18 — docs/04 F3 "เฉพาะยังไม่ส่งลูกค้า") · ร่าง → 409 (ใช้ `/cancel`) · ' +
      'ผล: DO INVOICED/BILLED → UNBILLED (วางบิลใหม่ได้) · ปลดล็อกบรรทัดรายได้ · ถอดออกจากใบวางบิลที่ยังเป็นร่าง · ' +
      'audit `invoice.cancelled` + webhook `invoice.voided` (ระบบบัญชีที่รับใบไปแล้วยกเลิกตาม — ST8-T16) · ' +
      '`reissue: true` = สร้างร่างฉบับใหม่แทน (DO ชุดเดิม + บรรทัดที่เพิ่มเอง) อ้างเลขเดิม (`replacedByInvoice` / `replacesInvoice`) — ออกเลขใหม่ตามปกติ · ' +
      'PDF ของใบที่ยกเลิกมีลายน้ำ "ยกเลิก" (spec/05 BIL-195)',
  })
  @ApiHeader({
    ...IF_MATCH,
    required: true,
    description: 'ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
  })
  @ApiProblems(
    T403('invoices:void'),
    NF,
    {
      status: 409,
      description:
        '`invalid_state_transition` (ร่าง/ยกเลิกแล้ว/สถานะอื่น) · `invoice_has_payments` · `invoice_on_billing_note` · `invoice_sent_to_customer` · `not_ready_to_bill` (ออกฉบับใหม่แทน — DO ไม่พร้อม)',
      examples: {
        invoice_on_billing_note: {
          type: 'https://docs.tms.example/problems/invoice_on_billing_note',
          title: PROBLEMS.invoice_on_billing_note.th,
          status: 409,
          code: 'invoice_on_billing_note',
          billingNoteId: 'bn_…',
          billingNoteNo: 'BN-00000-6911-0001',
          billingNoteStatus: 'ISSUED',
        },
        invoice_has_payments: {
          type: 'https://docs.tms.example/problems/invoice_has_payments',
          title: PROBLEMS.invoice_has_payments.th,
          status: 409,
          code: 'invoice_has_payments',
          currentStatus: 'PARTIALLY_PAID',
          payments: [{ paymentId: 'pay_…', paymentNo: 'PAY-6911-0001' }],
        },
      },
    },
    T412,
    T422,
  )
  @ApiOkResponse({ type: InvoiceDto })
  async void(
    @Param('id') id: string,
    @Body() body: VoidInvoiceDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    assertHumanStepUp(); // D-67 — ตรวจหลัง validation/404 (ไม่ใช่ใน guard)
    const out = await this.canceller.void(
      await this.svc.idOf(id),
      body.reason,
      body.reissue === true,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/mark-sent')
  @HttpCode(200)
  @TenantResource('issuedInvoice')
  @RequireScope('invoices:finalize')
  @ApiOperation({
    summary: 'ทำเครื่องหมาย "ส่งลูกค้าแล้ว"',
    description:
      'ST5-T18 (plan/11 #5 `sent_to_customer_at`; docs/04 F3) · สิทธิ์ `invoices:finalize` · ใบที่ออกเลขแล้วและไม่ถูกยกเลิก ' +
      '(ISSUED / PARTIALLY_PAID / PAID / ADJUSTED — อื่น ๆ 409 `invalid_state_transition`) · ส่งแล้วอยู่แล้ว = คืนค่าเดิม (ไม่เปลี่ยน) · ' +
      'audit `invoice.sent_to_customer` · ส่งแล้ว**ยกเลิกใบไม่ได้** (`/void` → 409 `invoice_sent_to_customer`) · ' +
      'ออกใบวางบิลตั้งธงนี้ให้อัตโนมัติ (ช่องทาง BILLING_NOTE) · ส่งอีเมล (`POST /invoices/{id}/send`, ชุดใบวางบิล) ตั้งช่องทาง EMAIL (ST5-T21)',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:finalize'), NF, T409(), T412)
  @ApiOkResponse({ type: InvoiceDto })
  async markSent(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.status.markSent(await this.svc.idOf(id), expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/unmark-sent')
  @HttpCode(200)
  @TenantResource('issuedInvoice')
  @RequireScope('invoices:void')
  @ApiOperation({
    summary: 'ล้างธง "ส่งลูกค้าแล้ว" (ทำเครื่องหมายผิด) — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'ST5-T18 · สิทธิ์ `invoices:void` (owner/admin/manager — สิทธิ์เดียวกับยกเลิกใบที่ออกแล้ว) · ยังไม่ส่ง = คืนค่าเดิม · ' +
      'audit `invoice.sent_to_customer_cleared` พร้อมเหตุผล · ยกเลิกใบวางบิลที่ออกแล้วล้างธงช่องทาง BILLING_NOTE ให้อัตโนมัติ',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:void'), NF, T412, T422)
  @ApiOkResponse({ type: InvoiceDto })
  async unmarkSent(
    @Param('id') id: string,
    @Body() body: UnmarkInvoiceSentDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceDto> {
    const out = await this.status.unmarkSent(
      await this.svc.idOf(id),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/send')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('issuedInvoice')
  @RequireScope('invoices:finalize')
  @ApiOperation({
    summary: 'ส่งใบแจ้งหนี้ / ใบแจ้งเตือนชำระ ทางอีเมลถึงลูกค้า (แนบ PDF ต้นฉบับ)',
    description:
      'ST5-T21 (docs/04 F3; spec/05 BIL-041) · สิทธิ์ `invoices:finalize` + `prices.sell:read` · ' +
      '`purpose=DOCUMENT` (ค่าเริ่ม): ใบที่ออกเลขแล้วและไม่ถูกยกเลิก (ISSUED / PARTIALLY_PAID / PAID / ADJUSTED) · ' +
      '`purpose=PAYMENT_REMINDER` (ต้นแบบหน้า "รับชำระ" เมนู "ส่งใบแจ้งเตือนชำระ"): เฉพาะใบที่ยังมียอดค้าง (ISSUED / PARTIALLY_PAID) — อื่น ๆ 409 `reason: not_outstanding` · ' +
      'แนบไฟล์ต้นฉบับที่เก็บ ณ วันออก (`GET /invoices/{id}/pdf`) · ผู้รับ = `to` หรือผู้ติดต่อของลูกค้าที่มีอีเมล · ' +
      'อีเมล 1 ฉบับต่อผู้รับผ่าน outbox (สถานะการส่งที่ `GET /invoices/{id}/emails`) · ผู้รับเดิมยังรอส่ง (ภายใน 10 นาที) → 409 `document_email_pending` · ' +
      'ยังไม่มีธง "ส่งลูกค้าแล้ว" → ตั้งช่องทาง EMAIL (ส่งแล้วยกเลิกใบไม่ได้ — ST5-T18) · audit `invoice.emailed` · sandbox ไม่ส่งออกจริง',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (ไม่ส่งอีเมลซ้ำ) เก็บ 24 ชม.',
  })
  @ApiProblems(
    T403('invoices:finalize'),
    NF,
    T409('invoice_pdf_template_changed', 'document_email_pending'),
    SEND_422,
    SEND_429,
  )
  @ApiOkResponse({ type: DocumentEmailResultDto })
  async send(
    @Param('id') id: string,
    @Body() body: SendInvoiceDto,
  ): Promise<DocumentEmailResultDto> {
    const ctx = requestContext.require();
    if (!scopeAllows(ctx.scopes ?? [], 'prices.sell:read'))
      throw new ProblemException('permission_denied', undefined, undefined, {
        requiredScope: 'prices.sell:read',
      });
    return this.mail.sendInvoice(await this.svc.idOf(id), body.to, body.purpose ?? 'DOCUMENT');
  }

  @Get(':id/emails')
  @NoTransaction()
  @TenantResource('invoice')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'ประวัติการส่งใบแจ้งหนี้ทางอีเมล + สถานะการส่งต่อผู้รับ',
    description:
      'ST5-T21 · การส่งรายใบ (`POST /invoices/{id}/send`) เท่านั้น — ส่งเป็นชุดใบวางบิลดูที่ `GET /billing-notes/{id}/emails` · ใหม่สุดก่อน (สูงสุด 100)',
  })
  @ApiProblems(T403('invoices:read'), NF)
  @ApiOkResponse({ type: DocumentEmailListDto })
  async emails(@Param('id') id: string): Promise<DocumentEmailListDto> {
    return this.mail.list('invoice', await this.svc.idOf(id));
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
