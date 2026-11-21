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
  ApiTags,
} from '@nestjs/swagger';
import { scopeAllows } from '@tms/domain';
import type { Request, Response } from 'express';
import { NoTransaction, RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { PROBLEMS, ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { T403, T404, T409, T412, T422 } from '../trips/trip-problems';
import {
  AcknowledgeBillingNoteDto,
  BillingNoteCandidatesDto,
  BillingNoteCandidatesQuery,
  BillingNoteDto,
  BillingNoteListQuery,
  BillingNotePageDto,
  BillingNotePdfQuery,
  BillingNoteReasonDto,
  BillingNoteSummaryCountsDto,
  CollectBillingNoteDto,
  CreateBillingNoteDto,
  UpdateBillingNoteDto,
} from './billing-note.dto';
import { BillingNotesService } from './billing-notes.service';

const NF = { ...T404, description: 'ไม่พบใบวางบิล (รวมของบริษัทอื่น)' };
const IF_MATCH = {
  name: 'If-Match',
  required: false,
  description: 'ETag (version) จาก GET — ไม่ตรง → 412',
};
const ATTACH_409 = {
  status: 409,
  description:
    '`invoice_already_billed` — ใบแจ้งหนี้อยู่ในใบวางบิลอื่นที่ active (ร่าง/ออกแล้ว) `invoices[]` · ' +
    '`invoice_not_billable` — ใบแจ้งหนี้ยังไม่ออก/ไม่ค้างชำระ `invoices[]` · `invalid_state_transition` — ใบวางบิลไม่ใช่ร่าง',
  examples: {
    invoice_already_billed: {
      type: 'https://docs.tms.example/problems/invoice_already_billed',
      title: PROBLEMS.invoice_already_billed.th,
      status: 409,
      code: 'invoice_already_billed',
      invoices: [
        {
          invoiceId: 'ivc_…',
          invoiceNo: 'INV-00000-2611-0013',
          billingNoteId: 'bn_…',
          billingNoteNo: 'BN-2611-0004',
        },
      ],
    },
    invoice_not_billable: {
      type: 'https://docs.tms.example/problems/invoice_not_billable',
      title: PROBLEMS.invoice_not_billable.th,
      status: 409,
      code: 'invoice_not_billable',
      invoices: [{ invoiceId: 'ivc_…', invoiceNo: null, status: 'DRAFT' }],
    },
  },
};

const sellOnly = () => {
  const ctx = requestContext.require();
  if (!scopeAllows(ctx.scopes ?? [], 'prices.sell:read'))
    throw new ProblemException('permission_denied', undefined, undefined, {
      requiredScope: 'prices.sell:read',
    });
};

/**
 * ใบวางบิล (ST5-T11; docs/01 §5.2 #9 `billing-notes` — `POST`, `GET`, `/finalize`, `/collect`; docs/04 F2; spec/05 §3 BIL-039)
 * D-54 บัญชีเบา: **ไม่ใช่เอกสารภาษี — ไม่กระทบ VAT/WHT** · TMS ออกเลขใบวางบิลเอง (D-55) · ไม่มี webhook (ไม่อยู่ใน docs/01 §5.3)
 */
@ApiTags('billing-notes')
@ApiBearerAuth()
@Controller('billing-notes')
export class BillingNotesController {
  constructor(private readonly svc: BillingNotesService) {}

  // ประกาศ `summary` / `candidates` ก่อน `:id` เสมอ — test/billing-notes.test.ts ตรวจลำดับ route
  @Get('summary')
  @RequireScope('invoices:read')
  @ApiOperation({ summary: 'จำนวนใบวางบิลตามสถานะ (แท็บ)' })
  @ApiProblems(T403('invoices:read'))
  @ApiOkResponse({ type: BillingNoteSummaryCountsDto })
  summary(): Promise<BillingNoteSummaryCountsDto> {
    return this.svc.summary();
  }

  @Get('candidates')
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'ใบแจ้งหนี้ของลูกค้าที่ใส่ในใบวางบิลได้',
    description:
      'ออกแล้วและยังค้างชำระ (ISSUED) และไม่อยู่ในใบวางบิลอื่นที่ active (ร่าง/ออกแล้ว) · เรียงวันที่ออก · ≤ 500 ใบ · ยอด `sell*` เห็นเมื่อมี `prices.sell:read`',
  })
  @ApiProblems(T403('invoices:read'), T422)
  @ApiOkResponse({ type: BillingNoteCandidatesDto })
  candidates(@Query() q: BillingNoteCandidatesQuery): Promise<BillingNoteCandidatesDto> {
    return this.svc.candidates(q.customerId);
  }

  @Get()
  @RequireScope('invoices:read')
  @ApiOperation({
    summary: 'รายการใบวางบิล',
    description:
      'กรองลูกค้า (`customerId` รับ `ext:`) / สถานะ · cursor มาตรฐาน (updatedAt, id) · ร่างไม่มีเลข · ยอด `sell*` เห็นเมื่อมี `prices.sell:read`',
  })
  @ApiProblems(T403('invoices:read'), T422)
  @ApiOkResponse({ type: BillingNotePageDto })
  list(@Query() q: BillingNoteListQuery): Promise<BillingNotePageDto> {
    return this.svc.list(q);
  }

  @Post()
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'สร้างร่างใบวางบิลจากใบแจ้งหนี้หลายใบของลูกค้าเดียว (ไม่มีเลข)',
    description:
      'ใบแจ้งหนี้ต้องเป็นของลูกค้ารายนี้ **ออกแล้วและยังค้างชำระ** (ISSUED — ไม่งั้น 409 `invoice_not_billable`) ผู้ออก/สาขาผู้ออกเดียวกัน (422 `issuer_mismatch`) · ' +
      '**ใบแจ้งหนี้หนึ่งใบอยู่ในใบวางบิลที่ active ได้ใบเดียว** (409 `invoice_already_billed` — กันระดับ DB) · ยอดวางบิล = Σ ยอดค้าง · ' +
      'WHT ที่คาดว่าจะถูกหักเป็นประมาณการ (D-54) · ไม่กระทบ VAT/WHT · audit `billing_note.draft_created`',
  })
  @ApiProblems(T403('invoices:draft'), ATTACH_409, T422)
  @ApiCreatedResponse({ type: BillingNoteDto })
  async create(
    @Body() body: CreateBillingNoteDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingNoteDto> {
    const out = await this.svc.create(body);
    setEtag(res, out.version);
    return out;
  }

  @Get(':id')
  @TenantResource('billingNote')
  @RequireScope('invoices:read')
  @ApiOperation({ summary: 'ใบวางบิล + ใบแจ้งหนี้ในใบ + ผู้รับวางบิล' })
  @ApiProblems(T403('invoices:read'), NF)
  @ApiOkResponse({ type: BillingNoteDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingNoteDto> {
    const out = await this.svc.get(decodeIdOr404('billingNote', id));
    setEtag(res, out.version);
    return out;
  }

  @Patch(':id')
  @TenantResource('billingNote')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'แก้ร่าง — ชุดใบแจ้งหนี้ วันนัดรับเช็ค/โอน หมายเหตุ',
    description:
      'เฉพาะ DRAFT (อื่น ๆ → 409) · `invoiceIds` = ชุดใหม่ทั้งหมด (ใบที่ไม่อยู่ในชุดถูกถอด — ยังเห็นในประวัติ `active=false`) · audit `billing_note.draft_updated`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft'), NF, ATTACH_409, T412, T422)
  @ApiOkResponse({ type: BillingNoteDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateBillingNoteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingNoteDto> {
    const out = await this.svc.update(decodeIdOr404('billingNote', id), body, expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/finalize')
  @HttpCode(200)
  @NoTransaction()
  @TenantResource('billingNote')
  @RequireScope('invoices:finalize')
  @ApiOperation({
    summary: 'ออกเอกสาร — ออกเลขใบวางบิล (ชุด BN) + ล็อก',
    description:
      'DRAFT → ISSUED · ตรวจใบแจ้งหนี้ซ้ำ (ยังออกแล้วค้างชำระ — 409 `invoice_not_billable`) · ต้องมีวันนัดรับเช็ค/โอน ≥ วันวางบิล (422 `collectionDate`) · ' +
      'วันวางบิล = วันนี้ (เวลาไทย) · ออกเลขชุด BN (เรียงไม่ข้าม) · snapshot ลูกค้า/ผู้ออก/ยอดต่อใบ · audit `billing_note.issued` · ' +
      'แล้ว render PDF ต้นฉบับเก็บแบบเขียนครั้งเดียว · หลังนี้แก้ไม่ได้ (ยกเลิกแล้วสร้างใหม่)',
  })
  @ApiHeader({
    ...IF_MATCH,
    required: true,
    description: 'ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
  })
  @ApiProblems(T403('invoices:finalize'), NF, ATTACH_409, T412, T422)
  @ApiOkResponse({ type: BillingNoteDto })
  async finalize(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingNoteDto> {
    const out = await this.svc.finalize(decodeIdOr404('billingNote', id), expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @TenantResource('billingNote')
  @RequireScope('invoices:finalize')
  @ApiOperation({
    summary: 'บันทึกผู้รับวางบิล (ชื่อฝั่งลูกค้า + วันที่รับ)',
    description:
      'ใบที่ออกแล้ว (ISSUED/COLLECTED) · วันที่รับ ≥ วันวางบิล และไม่เกินวันนี้ · บันทึกซ้ำ = แก้ (audit ค่าเดิม/ใหม่ `billing_note.acknowledged`) · ไม่เปลี่ยนสถานะ',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:finalize'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: BillingNoteDto })
  async acknowledge(
    @Param('id') id: string,
    @Body() body: AcknowledgeBillingNoteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingNoteDto> {
    const out = await this.svc.acknowledge(
      decodeIdOr404('billingNote', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/collect')
  @HttpCode(200)
  @TenantResource('billingNote')
  @RequireScope('invoices:finalize')
  @ApiOperation({
    summary: 'รับเช็ค/โอนแล้ว — ISSUED → COLLECTED',
    description:
      'สถานะสิ้นสุด · ใบแจ้งหนี้ในใบ**ยังนับว่าวางบิลแล้ว** (ใส่ใบวางบิลใหม่ไม่ได้ — กติกาเช็คคืน/รับบางส่วน = ST5-T13/T18) · ไม่เปลี่ยนสถานะ/ยอดของใบแจ้งหนี้ · ' +
      'audit `billing_note.collected`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:finalize'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: BillingNoteDto })
  async collect(
    @Param('id') id: string,
    @Body() body: CollectBillingNoteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingNoteDto> {
    const out = await this.svc.collect(
      decodeIdOr404('billingNote', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('billingNote')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary: 'ยกเลิกใบวางบิล — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'DRAFT → CANCELLED (`invoices:draft`) · ISSUED → CANCELLED (ต้องมี `invoices:finalize` ด้วย — 403) · เลขคงอยู่ ไม่ถูกใช้ซ้ำ · ' +
      'ไม่กระทบใบแจ้งหนี้ (BIL-039 — วางบิลใหม่ได้) · COLLECTED ยกเลิกไม่ได้ (409) · audit `billing_note.cancelled` + เหตุผล',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('invoices:draft', 'invoices:finalize'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: BillingNoteDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: BillingNoteReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingNoteDto> {
    const out = await this.svc.cancel(
      decodeIdOr404('billingNote', id),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Get(':id/proforma')
  @NoTransaction()
  @TenantResource('billingNote')
  @RequireScope('invoices:read')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'PDF ตัวอย่างของร่างใบวางบิล — ไม่มีเลข มีลายน้ำ "ร่าง"',
    description:
      'เฉพาะ DRAFT (อื่น ๆ → 409 ใช้ `/pdf`) · แม่แบบเดียวกับใบแจ้งหนี้ (TMS Print #bill) · render ใหม่ทุกครั้ง ไม่เก็บไฟล์ · ต้องมี `prices.sell:read`',
  })
  @ApiProduces('application/pdf')
  @ApiProblems(T403('invoices:read'), NF, T409())
  @ApiOkResponse({ description: 'application/pdf' })
  async proforma(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    sellOnly();
    const pdf = await this.svc.proforma(decodeIdOr404('billingNote', id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="billing-note-proforma-${id}.pdf"`);
    return new StreamableFile(pdf);
  }

  @Get(':id/pdf')
  @NoTransaction()
  @TenantResource('issuedBillingNote')
  @RequireScope('invoices:read')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'PDF ใบวางบิลที่ออกแล้ว — ต้นฉบับ / สำเนา (ไฟล์ที่เก็บ ณ วันออก)',
    description:
      'ใบที่ออกเลขแล้ว (ISSUED/COLLECTED/ยกเลิกหลังออก) — ร่าง → 409 ใช้ `/proforma` · `copy=COPY` render จาก snapshot ครั้งแรกแล้วเก็บ · ' +
      'header `X-Content-SHA256` · ต้องมี `prices.sell:read`',
  })
  @ApiProduces('application/pdf')
  @ApiProblems(T403('invoices:read'), NF, T409('invoice_pdf_template_changed'))
  @ApiOkResponse({ description: 'application/pdf' })
  async pdf(
    @Param('id') id: string,
    @Query() q: BillingNotePdfQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    sellOnly();
    const { doc, data } = await this.svc.ensurePdf(
      decodeIdOr404('billingNote', id),
      q.copy ?? 'ORIGINAL',
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-SHA256', doc.sha256 ?? '');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(doc.filename ?? 'billing-note.pdf')}"`,
    );
    return new StreamableFile(data);
  }
}
