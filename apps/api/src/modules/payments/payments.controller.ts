import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
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
import { ApiExternalIdParam, ExternalIdPipe } from '../../common/external-id';
import { PROBLEMS } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { T403, T404, T409, T412, T422 } from '../trips/trip-problems';
import { AgingService } from './aging.service';
import {
  AgingQuery,
  AgingReportDto,
  CreatePaymentDto,
  PaymentDto,
  PaymentListQuery,
  PaymentPageDto,
  PaymentReasonDto,
  PaymentSummaryDto,
} from './payment.dto';
import { PaymentsService } from './payments.service';

const NF = { ...T404, description: 'ไม่พบการรับชำระ (รวมของบริษัทอื่น)' };
const IF_MATCH = {
  name: 'If-Match',
  required: true,
  description:
    'ETag (version) ของการรับชำระ — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
};
const STATE_409 = {
  ...T409(),
  description:
    '`invalid_state_transition` — กลับรายการแล้ว / ไม่ใช่เช็ค / เช็คไม่อยู่ในสถานะที่ทำได้',
};

/**
 * รับชำระ (ST5-T13; docs/04 F5, docs/01 §5.2 #11 `payments`, spec/05 §4) — **บัญชีเบา D-54: บันทึกเงิน/เช็คใน TMS (D-57) ไม่ออกใบเสร็จ (D-56)**
 */
@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly svc: PaymentsService,
    private readonly aging: AgingService,
  ) {}

  @Get()
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'รายการรับชำระ',
    description:
      'กรองใบแจ้งหนี้ (`invoiceId`) / ลูกค้า (`customerId` รับ `ext:`) / สถานะ · cursor มาตรฐาน (updatedAt, id) · ' +
      'ยอด `sell*` เห็นเมื่อมี `prices.sell:read`',
  })
  @ApiProblems(T403('invoices:read'), T422)
  @ApiOkResponse({ type: PaymentPageDto })
  list(@Query() q: PaymentListQuery): Promise<PaymentPageDto> {
    return this.svc.list(q);
  }

  // ประกาศ `summary` ก่อน `:id` เสมอ (ไม่งั้น /payments/summary ถูกจับเป็น id)
  @Get('summary')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary:
      'KPI หน้า "รับชำระ" — ยอดค้างรับ / เกินกำหนด / รับชำระเดือนนี้ / ครบกำหนดใน 7 วัน + จำนวนต่อแท็บ',
    description:
      'วันครบกำหนดและเดือน ตามเวลาไทย (Asia/Bangkok) · เกินกำหนด = ใบที่มีธง `overdue` (ค้างรับและเลยวันครบกำหนด — job รายวัน 00:05 เวลาไทย, ST5-T18)',
  })
  @ApiProblems(T403('invoices:read'))
  @ApiOkResponse({ type: PaymentSummaryDto })
  summary(): Promise<PaymentSummaryDto> {
    return this.svc.summary();
  }

  // ประกาศก่อน `:id` เช่นเดียวกับ summary
  @Get('aging')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'อายุลูกหนี้ — ยอดค้างตามช่วงอายุ รวมและต่อลูกค้า (ST5-T22)',
    description:
      'ใบค้างรับ (ISSUED / PARTIALLY_PAID ที่ยังมียอดค้าง) · ยอดค้าง = ยอดรวม − ยอดตัดชำระ · ' +
      'ช่วงอายุจาก `daysPastDue = asOf − dueDate` (เวลาไทย): ยังไม่ครบกำหนด (≤ 0) · 1–30 · 31–60 · 61–90 · เกิน 90 วัน · ' +
      '**Σ ทุกช่วง = `sellOutstanding` ของ `GET /payments/summary`** · `data` = ต่อลูกค้า (เฉพาะที่มียอดค้าง) เรียงตามชื่อ cursor มาตรฐาน · ' +
      'กรองลูกค้า `customerId` (รับ `ext:`) · asOf = วันนี้ · ยอด `sell*` เห็นเมื่อมี `prices.sell:read` (จำนวนใบเห็นเสมอ) · ' +
      'รายการใบในช่วงอายุ: `GET /invoices?receivable=open&aging=…`',
  })
  @ApiProblems(T403('invoices:read'), T422)
  @ApiOkResponse({ type: AgingReportDto })
  agingReport(@Query() q: AgingQuery): Promise<AgingReportDto> {
    return this.aging.report(q);
  }

  @Get(':id')
  @TenantResource('payment')
  @RequireScope('invoices:read')
  @ApiOperation({ summary: 'การรับชำระ + การตัดชำระต่อใบแจ้งหนี้' })
  @ApiProblems(T403('invoices:read'), NF)
  @ApiOkResponse({ type: PaymentDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const out = await this.svc.get(await this.svc.idOf(id));
    setEtag(res, out.version);
    return out;
  }

  @Post()
  @RequireScope('payments:record')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (ไม่บันทึกซ้ำ) เก็บ 24 ชม.',
  })
  @ApiOperation({
    summary: 'บันทึกรับชำระ (ตัดยอดใบแจ้งหนี้ — ไม่ออกใบเสร็จ D-56)',
    description:
      'ใบแจ้งหนี้ที่ออกแล้ว (ISSUED / PARTIALLY_PAID) ของลูกค้ารายเดียว หลายใบได้ (BIL-050) · ' +
      '**เงินรับ + WHT + ค่าธรรมเนียม + ส่วนต่าง = Σ `allocations.amount`** (BIL-051 — ไม่มีเงินรับเกิน/เครดิตลูกค้าในเฟสนี้) ไม่ตรง → 422 `payment_unbalanced` · ' +
      'ยอดตัดต่อใบ ≤ คงค้าง (ตรวจใต้ล็อกใบ — พร้อมกันก็ตัดเกินไม่ได้) → 409 `payment_exceeds_outstanding` · ' +
      'ใบไม่อยู่ในสถานะรับชำระ → 409 `invoice_not_payable` · วันที่รับ ≤ วันนี้ (เวลาไทย) · ' +
      '`CHEQUE` ต้องมี `chequeNo` `chequeBank` `chequeDate` (สถานะเช็คเริ่ม PENDING) · ส่วนต่าง > 0 ต้องมี `differenceReason` · ' +
      'WHT ที่ถูกหัก = บันทึกยอด (+ เลขที่ 50 ทวิ) — รับ/ตรวจ 50 ทวิ ที่ระบบบัญชี (D-54) · ' +
      'สถานะใบ: ตัดครบ → PAID · บางส่วน → PARTIALLY_PAID · เลขภายใน PAY · audit + webhook `payment.recorded` (transaction เดียว) · ' +
      'แก้/ลบไม่ได้ — กลับรายการด้วย `POST /payments/{id}/reverse`',
  })
  @ApiProblems(
    {
      ...T403('payments:record'),
      description:
        'ไม่มีสิทธิ์ `payments:record` / ส่วนต่างเกิน `payments.maxDifferenceAmount` โดยไม่มี `payments:reverse` (`payment_difference_over_limit`)',
      examples: {
        ...T403('payments:record').examples,
        payment_difference_over_limit: {
          type: 'https://docs.tms.example/problems/payment_difference_over_limit',
          title: PROBLEMS.payment_difference_over_limit.th,
          status: 403,
          code: 'payment_difference_over_limit',
          maxDifferenceAmount: '10.00',
          requiredScope: 'payments:reverse',
        },
      },
    },
    {
      status: 409,
      description: '`invoice_not_payable` · `payment_exceeds_outstanding` (`outstanding`)',
      examples: {
        ...T409('invoice_not_payable').examples,
        payment_exceeds_outstanding: {
          type: 'https://docs.tms.example/problems/payment_exceeds_outstanding',
          title: PROBLEMS.payment_exceeds_outstanding.th,
          status: 409,
          code: 'payment_exceeds_outstanding',
          invoiceId: 'ivc_…',
          invoiceNo: 'INV-00000-2611-0001',
          outstanding: '25000.00',
        },
      },
    },
    T422,
  )
  @ApiCreatedResponse({ type: PaymentDto })
  async record(
    @Body() body: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const out = await this.svc.record(body);
    setEtag(res, out.version);
    return out;
  }

  @Put('external/:externalId')
  @RequireScope('payments:record')
  @ApiExternalIdParam()
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว (ไม่ตรง → 412)',
  })
  @ApiOperation({
    summary: 'บันทึกรับชำระด้วยเลขของระบบต้นทาง (upsert — D68-45)',
    description:
      'ยังไม่มีการรับชำระที่ externalId นี้ → บันทึก (กติกาเดียวกับ `POST /payments`) 201 · ' +
      'มีแล้ว → **แก้ไม่ได้** (docs/04 F4): เนื้อหาเหมือนเดิม = 200 แถวเดิม (ส่งซ้ำได้ ไม่บันทึกซ้ำ) · ต่าง = 409 `conflict` — ' +
      'กลับรายการด้วย `POST /payments/{id}/reverse` แล้วบันทึกใหม่ด้วย externalId ใหม่ · ' +
      'ไม่มี `PATCH /payments/external/{externalId}` (การรับชำระแก้ไม่ได้) · path `{id}` ทุก route รับ `ext:{externalId}`',
  })
  @ApiProblems(
    T403('payments:record'),
    {
      status: 409,
      description:
        '`conflict` (มีแล้วแต่เนื้อหาต่าง) · `invoice_not_payable` · `payment_exceeds_outstanding`',
      examples: T409('conflict').examples,
    },
    T412,
    T422,
  )
  @ApiOkResponse({ type: PaymentDto, description: 'มีแล้ว เนื้อหาเหมือนเดิม → แถวเดิม' })
  @ApiCreatedResponse({ type: PaymentDto, description: 'ยังไม่มี → บันทึก' })
  async upsertExternal(
    @Param('externalId', ExternalIdPipe) externalId: string,
    @Body() body: CreatePaymentDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const { out, created } = await this.svc.upsertExternal(externalId, body, expectedVersion(req));
    res.status(created ? 201 : 200);
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/reverse')
  @HttpCode(200)
  @TenantResource('payment')
  @RequireScope('payments:reverse')
  @ApiOperation({
    summary: 'กลับรายการรับชำระ (แก้รับชำระด้วย reversal — docs/04 F4)',
    description:
      'RECORDED → REVERSED · ยอดค้างของใบกลับมา (PAID/PARTIALLY_PAID → ตามยอดที่เหลือ) · เหตุผล ≥ 10 ตัวอักษร + audit · ' +
      'webhook `payment.reversed` · บันทึกผิด = กลับรายการแล้วบันทึกใหม่ (ไม่มีแก้/ลบ)',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('payments:reverse'), NF, STATE_409, T412, T422)
  @ApiOkResponse({ type: PaymentDto })
  async reverse(
    @Param('id') id: string,
    @Body() body: PaymentReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const out = await this.svc.reverse(await this.svc.idOf(id), expectedVersion(req), body.reason);
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/bounce')
  @HttpCode(200)
  @TenantResource('payment')
  @RequireScope('payments:reverse')
  @ApiOperation({
    summary: 'เช็คคืน — กลับรายการรับชำระด้วยเช็ค (BIL-060)',
    description:
      'เช็คที่รอเคลียร์/ผ่านแล้ว → `chequeStatus` BOUNCED + REVERSED · ยอดค้างของใบกลับมา · เหตุผล + audit `payment.cheque_bounced` · ' +
      'webhook `payment.reversed` (`chequeStatus: BOUNCED`)',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('payments:reverse'), NF, STATE_409, T412, T422)
  @ApiOkResponse({ type: PaymentDto })
  async bounce(
    @Param('id') id: string,
    @Body() body: PaymentReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const out = await this.svc.bounceCheque(
      await this.svc.idOf(id),
      expectedVersion(req),
      body.reason,
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/clear')
  @HttpCode(200)
  @TenantResource('payment')
  @RequireScope('payments:record')
  @ApiOperation({
    summary: 'เช็คผ่าน (เคลียร์แล้ว) — PENDING → CLEARED',
    description:
      'ไม่เปลี่ยนยอดตัดหนี้ (ตัดยอดตั้งแต่บันทึกรับเช็ค) · audit `payment.cheque_cleared`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('payments:record'), NF, STATE_409, T412, T422)
  @ApiOkResponse({ type: PaymentDto })
  async clear(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const out = await this.svc.clearCheque(await this.svc.idOf(id), expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }
}
