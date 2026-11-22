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
import { verifyStepUpToken } from '../../auth/tokens';
import { requestContext } from '../../common/request-context';
import { NoTransaction, RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { T403, T404, T409, T412, T422 } from '../trips/trip-problems';
import { PROBLEMS } from '../../common/problem';
import { isRealDate } from '../vehicle-documents/expiry';
import { SettlementComparisonDto } from './settlement-comparison.dto';
import { SettlementComparisonService } from './settlement-comparison.service';
import { SettlementQueuePageDto, SettlementQueueQuery } from './settlement-queue.dto';
import { SettlementQueueService } from './settlement-queue.service';
import {
  CreateSettlementDto,
  SettlementDto,
  SettlementItemsInput,
  SettlementKpiDto,
  SettlementListQuery,
  SettlementPageDto,
  SettlementPayDto,
  SettlementReasonDto,
  UpdateSettlementDto,
} from './settlement.dto';
import { SettlementReviewLinkDto, SettlementSentDto } from './settlement-review.dto';
import { SettlementPdfService } from './settlement-pdf.service';
import { SettlementsService } from './settlements.service';

const NF = { ...T404, description: 'ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น)' };
const IF_MATCH = {
  name: 'If-Match',
  required: false,
  description: 'ETag (version) — ไม่ตรง → 412',
};

/**
 * Settlement รถร่วม (AP — docs/04 F6, docs/01 §4.5, §5.2 #12 `settlements`)
 * ST6-T02 คิวจ่ายรถร่วม · ST6-T03 ใบสำคัญจ่าย (ร่าง) · ST6-T05 ส่งรถร่วมตรวจผ่านลิงก์ · ST6-T06 dispute + หน้าเทียบ · ST6-T07 อนุมัติ · ST6-T09 บันทึกจ่าย
 * อ่าน `settlements:read` (ยอดเห็นเมื่อมี `prices.buy:read`) · สร้าง/แก้ร่าง/ยกเลิกร่าง `settlements:create` · อนุมัติ `settlements:approve` · จ่าย `settlements:pay`
 */
@ApiTags('settlements')
@ApiBearerAuth()
@Controller('settlements')
export class SettlementsController {
  constructor(
    private readonly queue: SettlementQueueService,
    private readonly svc: SettlementsService,
    private readonly comparison: SettlementComparisonService,
    private readonly pdf: SettlementPdfService,
  ) {}

  @Get('queue')
  @RequireScope('settlements:read')
  @ApiOperation({
    summary: 'คิวจ่ายรถร่วม (เที่ยวที่ปิดต้นทุนแล้วและยังไม่อยู่ในใบสำคัญจ่าย)',
    description:
      'เที่ยว **COSTED** ของรถร่วมที่ยังมีบรรทัดต้นทุนรอจ่าย (ค่าจ้าง CARRIER_FEE + ค่าใช้จ่ายหน้างานฝั่งซื้อที่ยืนยันแล้ว ของรถร่วมรายปัจจุบัน ' +
      'ที่ยังไม่อยู่ในใบสำคัญจ่าย) · รถร่วมที่ตั้ง "ไม่มี POD ไม่จ่าย" (`requirePodToPay`) → เที่ยวที่หลักฐานส่งยังไม่ครบไม่ขึ้นคิว · ' +
      'กรองรถร่วม (`carrierId` รับ `ext:`) / ช่วงวันที่เที่ยวจบ (เวลาไทย) / หลักฐานครบ · `carriers` = ยอดรวมต่อรถร่วมของทุกแถวที่ตรงตัวกรอง · ' +
      'ยอดเงิน (`buy*`) เห็นเมื่อมี `prices.buy:read` · ปิดต้นทุนเที่ยว (COMPLETED → COSTED) ปิดใช้ได้ด้วย kill switch ' +
      '(`POST /trips/{id}/cost` → 409 `trip_costing_unavailable`) — ระหว่างนั้นคิวว่าง',
  })
  @ApiProblems(T403('settlements:read'), T422)
  @ApiOkResponse({ type: SettlementQueuePageDto })
  async list(@Query() q: SettlementQueueQuery): Promise<SettlementQueuePageDto> {
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

  @Get('summary')
  @RequireScope('settlements:read')
  @ApiOperation({
    summary: 'KPI หน้า "Settlement รถร่วม" — จำนวนต่อสถานะ + ยอดจ่ายแล้วเดือนนี้',
    description:
      'จำนวนใบต่อสถานะ (docs/01 §4.5) สำหรับแท็บ/การ์ด KPI ของหน้า `settle` · `buyPaidThisMonth` = Σ ยอดจ่ายหลังหัก ณ ที่จ่าย (ที่ตรึงตอนอนุมัติ) ของใบที่จ่ายแล้วในเดือนนี้ (เวลาไทย) — เห็นเมื่อมี `prices.buy:read`',
  })
  @ApiProblems(T403('settlements:read'))
  @ApiOkResponse({ type: SettlementKpiDto })
  summary(): Promise<SettlementKpiDto> {
    return this.svc.kpi();
  }

  @Get()
  @RequireScope('settlements:read')
  @ApiOperation({
    summary: 'รายการใบสำคัญจ่ายรถร่วม',
    description:
      'กรองรถร่วม (`carrierId` รับ `ext:` — ไม่พบ = รายการว่าง) / สถานะ · cursor มาตรฐาน (updatedAt, id) · ยอด `buy*` เห็นเมื่อมี `prices.buy:read`',
  })
  @ApiProblems(T403('settlements:read'), T422)
  @ApiOkResponse({ type: SettlementPageDto })
  listSettlements(@Query() q: SettlementListQuery): Promise<SettlementPageDto> {
    return this.svc.list(q);
  }

  @Post()
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'ติ๊กเที่ยว → สร้างร่างใบสำคัญจ่าย (DRAFT — ยังไม่มีเลขเอกสาร)',
    description:
      'รถร่วม 1 ราย หลายเที่ยว: `tripIds` (ทุกบรรทัดที่รอจ่ายของเที่ยว) และ/หรือ `tripCostIds` (รายบรรทัด) — ต้องอยู่ในคิวจ่าย (`GET /settlements/queue`) ' +
      'ของรถร่วมรายนี้ มิฉะนั้น 409 `trip_cost_not_payable` · บรรทัดที่อยู่ในใบอื่นที่ยังใช้แล้ว → **409 `trip_cost_already_settled`** (กันจ่ายซ้ำ — unique ระดับ DB) · ' +
      'บรรทัดหัก (`deductions`) กรอกมือ ยอดติดลบ + เอกสารอ้างอิง · ' +
      'ยอดสุทธิ `buyNetPayable` = ยอดรวม − รายการหัก (ก่อนหัก ณ ที่จ่าย) · หัก ณ ที่จ่าย**ประมาณการ** (ST6-T08) `buyWhtAmount` = ยอดก่อนหัก × อัตราของบรรทัด (`whtRate` ที่คัดลอกจากต้นทุน — ไม่มีธงใช้ค่าตั้งต้นของรถร่วม) ปัดครั้งเดียวต่อกลุ่มอัตรา + ขั้นต่ำ `tax.whtMinimumAmount` · `buyNetAfterWht` = ยอดจ่ายหลังหัก · `whtEstimate` แยกอัตรา + แบบ ภ.ง.ด.3/53 (ร่าง — ยังไม่ผ่านนักบัญชี) · ' +
      'งวดไม่ส่ง = ช่วงวันที่เที่ยวจบ (เวลาไทย) · audit `settlement.created`',
  })
  @ApiProblems(
    T403('settlements:create'),
    T409('trip_cost_already_settled', 'trip_cost_not_payable'),
    T422,
  )
  @ApiCreatedResponse({ type: SettlementDto })
  async create(
    @Body() body: CreateSettlementDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const out = await this.svc.create(body);
    setEtag(res, out.version);
    return out;
  }

  @Get(':id')
  @TenantResource('settlement')
  @RequireScope('settlements:read')
  @ApiOperation({
    summary: 'ใบสำคัญจ่ายรถร่วม + บรรทัด (รวมบรรทัดที่นำออกแล้ว)',
  })
  @ApiProblems(T403('settlements:read'), NF)
  @ApiOkResponse({ type: SettlementDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const out = await this.svc.get(decodeIdOr404('settlement', id));
    setEtag(res, out.version);
    return out;
  }

  @Get(':id/pdf')
  @NoTransaction()
  @TenantResource('settlement')
  @RequireScope('settlements:read')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'PDF ใบสำคัญจ่ายรถร่วม (ST6-T04) — รายการเที่ยว ยอด หัก ณ ที่จ่าย (ประมาณการ) สุทธิ',
    description:
      'แม่แบบตามต้นแบบ TMS Print #pv (แม่แบบการเงินร่วมกับใบแจ้งหนี้) · ทุกตัวเลขมาจาก `GET /v1/settlements/{id}` ชุดเดียวกัน: ' +
      'ยอดซื้อรวม = `buyGrossAmount` · หัก ณ ที่จ่ายแยกอัตรา = `whtEstimate.byRate` (รวม = `buyWhtAmount`; ใบที่อนุมัติแล้ว = ยอดที่ตรึง) · ' +
      'บรรทัดหักรวมต่อชนิด · จ่ายสุทธิ = `buyNetAfterWht` · ยอดหัก ณ ที่จ่ายติด * (ประมาณการ D-54 — 50 ทวิ ออกที่ระบบบัญชี D-58) · ' +
      'ยังไม่อนุมัติ = ลายน้ำ "ร่าง" ไม่มีเลข (render ตามคำขอ) · จ่ายแล้ว = วันที่จ่าย + วิธีจ่าย + เลขอ้างอิง · ใบที่มีเลขแล้ว (อนุมัติ / จ่ายแล้ว): render ครั้งแรกที่ขอแล้วเก็บไฟล์ — ครั้งต่อไปได้ไฟล์เดิม ไม่ render ใหม่ (ST9-T15; ฉบับอนุมัติและฉบับจ่ายแล้วเก็บแยกกัน; header `X-Content-SHA256` ของไฟล์ที่เก็บ) · ' +
      'ใบที่ยกเลิก → 409 · ต้องมี `prices.buy:read` ไม่งั้น 403',
  })
  @ApiProduces('application/pdf')
  @ApiProblems(T403('settlements:read'), NF, T409())
  @ApiOkResponse({ description: 'application/pdf', schema: { type: 'string', format: 'binary' } })
  async voucherPdf(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const ctx = requestContext.require();
    if (!scopeAllows(ctx.scopes ?? [], 'prices.buy:read'))
      throw new ProblemException('permission_denied', undefined, undefined, {
        requiredScope: 'prices.buy:read',
      });
    const { dto, pdf, stored } = await this.pdf.render(decodeIdOr404('settlement', id));
    if (stored?.sha256) res.setHeader('X-Content-SHA256', stored.sha256);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${(dto.settlementNo ?? `settlement-draft-${id}`).replace(/[^\w.-]/g, '_')}.pdf"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(pdf);
  }

  @Get(':id/comparison')
  @TenantResource('settlement')
  @RequireScope('settlements:read')
  @ApiOperation({
    summary: 'หน้าเทียบ planned vs executed vs claimed + POD (ST6-T06)',
    description:
      'docs/04 F6 "Dispute — หน้าเอกสารคู่ยอด" · ต่อบรรทัดที่ยังใช้: ยอดตามแผน (ราคาที่ตกลงตอนจ้างรถร่วม) / ยอดในใบ / ยอดที่รถร่วมเรียก + ส่วนต่าง + สถานะรายการ (OPEN/DISPUTED/APPROVED) + คำตอบของรถร่วม + การตัดสินของบริษัท · ' +
      'ต่อเที่ยว: POD ล่าสุดต่อ DO (ผ่านเกณฑ์จ่ายไหม, ปริมาณตามแผน/ส่งจริง/ปฏิเสธ, เอกสาร) · ยอด `buy*` เห็นเมื่อมี `prices.buy:read`',
  })
  @ApiProblems(T403('settlements:read'), NF)
  @ApiOkResponse({ type: SettlementComparisonDto })
  compare(@Param('id') id: string): Promise<SettlementComparisonDto> {
    return this.comparison.compare(decodeIdOr404('settlement', id));
  }

  @Patch(':id')
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'แก้หัวใบร่าง — งวด เลขใบแจ้งหนี้/วันที่/เลขใบเสร็จของรถร่วม หมายเหตุ',
    description: 'เฉพาะ DRAFT (อื่น ๆ → 409) · audit `settlement.updated` (เฉพาะช่องที่เปลี่ยน)',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('settlements:create'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: SettlementDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateSettlementDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const out = await this.svc.update(decodeIdOr404('settlement', id), body, expectedVersion(req));
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/lines')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'เพิ่มเที่ยว/บรรทัดต้นทุน/บรรทัดหักเข้าใบร่าง',
    description:
      'กฎเดียวกับตอนสร้าง (409 `trip_cost_already_settled` / `trip_cost_not_payable`) · เฉพาะ DRAFT · audit `settlement.lines_added`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(
    T403('settlements:create'),
    NF,
    T409('trip_cost_already_settled', 'trip_cost_not_payable'),
    T412,
    T422,
  )
  @ApiOkResponse({ type: SettlementDto })
  async addLines(
    @Param('id') id: string,
    @Body() body: SettlementItemsInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const out = await this.svc.addLines(
      decodeIdOr404('settlement', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/lines/:lineId/remove')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'นำบรรทัดออกจากใบร่าง — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'บรรทัดคงอยู่ (`active` false + เหตุผล — ไม่มีการลบ) · บรรทัดต้นทุนกลับเข้าคิวจ่าย · เฉพาะ DRAFT · audit `settlement.line_removed`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('settlements:create'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: SettlementDto })
  async removeLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: SettlementReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const sid = decodeIdOr404('settlement', id);
    const out = await this.svc.removeLine(
      sid,
      decodeIdOr404('settlementLine', lineId),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'ยกเลิกใบร่าง — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'DRAFT → CANCELLED (docs/01 §4.5) · ทุกบรรทัดถูกนำออก บรรทัดต้นทุนกลับเข้าคิวจ่าย · ยอดของใบคงไว้ ณ เวลายกเลิก · audit `settlement.cancelled`',
  })
  @ApiHeader(IF_MATCH)
  @ApiProblems(T403('settlements:create'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: SettlementDto })
  async cancel(
    @Param('id') id: string,
    @Body() body: SettlementReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const out = await this.svc.cancel(
      decodeIdOr404('settlement', id),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }
  @Post(':id/send-to-carrier')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'ส่งให้รถร่วมตรวจผ่านลิงก์ (DRAFT → SENT_TO_CARRIER)',
    description:
      'docs/04 F6 "รถร่วมตรวจผ่านลิงก์", docs/01 §4.5 · ต้องมีบรรทัดค่าขนส่ง (409 `settlement_empty`) และยอดสุทธิไม่ติดลบ (409 `settlement_net_negative`) · ' +
      'ออกลิงก์อายุ 7 วัน (`link.url` แสดงครั้งเดียว — ส่งทาง LINE/SMS ด้วย POST /v1/messages/send-link หรือคัดลอกไปส่งเอง) · รอบตรวจ +1 · ' +
      'ใบที่ส่งแล้วแก้/เพิ่ม/นำบรรทัดออก/ยกเลิกไม่ได้ (409) จนกว่าจะเรียกกลับ · **ผู้ส่งนับเป็นผู้เตรียมใบ — อนุมัติใบนี้ไม่ได้** · audit `settlement.sent`',
  })
  @ApiHeader({
    ...IF_MATCH,
    required: true,
    description: 'ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
  })
  @ApiProblems(
    T403('settlements:create'),
    NF,
    T409('settlement_empty', 'settlement_net_negative'),
    T412,
    T422,
  )
  @ApiOkResponse({ type: SettlementSentDto })
  async send(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementSentDto> {
    const out = await this.svc.send(decodeIdOr404('settlement', id), expectedVersion(req));
    setEtag(res, out.settlement.version);
    return out;
  }

  @Post(':id/review-link')
  @HttpCode(201)
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'ออกลิงก์ให้รถร่วมใหม่ (ลิงก์เดิมหมดอายุ/หาย)',
    description:
      'ใบ SENT_TO_CARRIER / DISPUTED = ลิงก์ตรวจ (ดู + ยอมรับ/โต้แย้ง) — ผู้ออกนับเป็นผู้เตรียมใบ · ' +
      'ใบ APPROVED / PAID = ลิงก์**ดูอย่างเดียว** (ดูสถานะ/ใบจ่ายเงิน — ตอบ/แนบรูปไม่ได้; D-59) — ไม่เพิ่มผู้เตรียม หัวใบไม่เปลี่ยน · ' +
      'ร่าง/ยกเลิก → 409 · เพิกถอนลิงก์เดิม · คำตอบของรถร่วมในรอบนี้คงอยู่ · audit `settlement.review_link_reissued` (`viewOnly`)',
  })
  @ApiProblems(T403('settlements:create'), NF, T409())
  @ApiCreatedResponse({ type: SettlementReviewLinkDto })
  reissueLink(@Param('id') id: string): Promise<SettlementReviewLinkDto> {
    return this.svc.reissueLink(decodeIdOr404('settlement', id));
  }

  @Post(':id/recall')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'เรียกใบกลับมาแก้ (SENT_TO_CARRIER / DISPUTED → DRAFT) — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'เช่น รถร่วมโต้แย้งรายการ แล้วต้องแก้/นำบรรทัดออก (docs/01 §4.5 DISPUTED → DRAFT "แก้รายการ") · เพิกถอนลิงก์ตรวจ · คำตอบของรถร่วมเก็บเป็นประวัติ (ส่งใหม่ = รอบใหม่) · ' +
      'รายการที่โต้แย้งค้างยังบล็อกอนุมัติร่างตรง (นำออก / ยืนยันยอดเดิม / ส่งรอบใหม่) · audit `settlement.recalled`',
  })
  @ApiHeader({
    ...IF_MATCH,
    required: true,
    description: 'ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
  })
  @ApiProblems(T403('settlements:create'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: SettlementDto })
  async recall(
    @Param('id') id: string,
    @Body() body: SettlementReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const out = await this.svc.recall(
      decodeIdOr404('settlement', id),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/lines/:lineId/dispute')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'บัญชีติด dispute รายการ (ST6-T06) — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'docs/01 §4.5 "SENT_TO_CARRIER → DISPUTED : รถร่วม/บัญชีติด dispute รายการ" · เฉพาะใบ SENT_TO_CARRIER / DISPUTED (อื่น ๆ → 409) · ' +
      'บรรทัดที่โต้แย้งค้างอยู่แล้ว / นำออกแล้ว → 409 · หัวใบ → DISPUTED (อนุมัติไม่ได้จนเคลียร์) · ไม่แสดงให้รถร่วมเห็น · audit `settlement.line_flagged`',
  })
  @ApiHeader({
    ...IF_MATCH,
    required: true,
    description: 'ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
  })
  @ApiProblems(T403('settlements:create'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: SettlementDto })
  async disputeLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: SettlementReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const sid = decodeIdOr404('settlement', id);
    const out = await this.svc.disputeLine(
      sid,
      decodeIdOr404('settlementLine', lineId),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/lines/:lineId/resolve')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:create')
  @ApiOperation({
    summary: 'เคลียร์ dispute — ยืนยันยอดเดิมพร้อมเหตุผล ≥ 10 ตัวอักษร (ST6-T06)',
    description:
      'spec/05 BIL-136 · เฉพาะบรรทัดที่โต้แย้งค้าง ของใบ DISPUTED / ร่างที่เรียกกลับ / SENT_TO_CARRIER ที่มีโต้แย้งค้าง (อื่น ๆ → 409) · ปิดทุก dispute ก่อนหน้าของบรรทัดในรอบนี้ (รถร่วม + บัญชี) → สถานะรายการ APPROVED · ' +
      'ถ้าปิดข้อโต้แย้งของรถร่วม: **รถร่วมตอบบรรทัดนี้ในรอบนี้ไม่ได้อีก** (409 `settlement_line_resolved`) และเห็นเหตุผลนี้บนลิงก์ตรวจ · ปิดแค่ธงภายในของบัญชี: รถร่วมยังตอบได้และไม่เห็นเหตุผล · เคลียร์ครบ → DISPUTED กลับเป็น SENT_TO_CARRIER (อนุมัติได้) · ' +
      '**ผู้เคลียร์นับเป็นผู้เตรียมใบ — อนุมัติใบนี้ไม่ได้** (separation of duties) · แก้ยอด = เรียกกลับแล้วนำบรรทัดออก/เพิ่มใหม่ · audit `settlement.line_resolved`',
  })
  @ApiHeader({
    ...IF_MATCH,
    required: true,
    description: 'ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
  })
  @ApiProblems(T403('settlements:create'), NF, T409(), T412, T422)
  @ApiOkResponse({ type: SettlementDto })
  async resolveLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: SettlementReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const sid = decodeIdOr404('settlement', id);
    const out = await this.svc.resolveLine(
      sid,
      decodeIdOr404('settlementLine', lineId),
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/approve')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:approve')
  @ApiOperation({
    summary: 'อนุมัติใบสำคัญจ่าย (separation of duties) → ออกเลข STL — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'SENT_TO_CARRIER → APPROVED หรือ DRAFT → APPROVED (docs/01 §4.5 — DRAFT ตรงได้เมื่อไม่ตั้ง `settlement.carrierReviewRequired` ไม่งั้น 409 `settlement_review_required`) · ' +
      'ใบ DISPUTED / มีรายการโต้แย้งค้างในรอบตรวจปัจจุบัน (รถร่วมโต้แย้ง/บัญชีติด dispute ที่ยังไม่เคลียร์) → 409 `settlement_disputed` (`disputedCount`) · **ผู้ใช้ที่ login เท่านั้น** (API key / OAuth client / ลิงก์ ไม่มี scope นี้) · ' +
      '**ผู้เตรียมใบ (ผู้สร้าง / ผู้แก้หัวใบ / ผู้เพิ่มหรือนำบรรทัดออก / ผู้ส่งให้รถร่วมตรวจ / ผู้เคลียร์ dispute — key = ผู้ออก key) อนุมัติไม่ได้ → 403 `settlement_self_approval`** (ระบุผู้เตรียมไม่ได้ = ปฏิเสธ) · ' +
      'ยอดสุทธิเกินวงเงินที่ตั้ง (`settlement.approvalStepUpAmount` — ค่าเริ่ม 100,000 บาท; 0 = ทุกใบ) ต้องส่ง `X-Step-Up` ของผู้อนุมัติ ' +
      '(จาก `POST /v1/auth/step-up` ยืนยัน TOTP) ไม่งั้น 403 `step_up_required` · ไม่มีบรรทัดค่าขนส่ง (FREIGHT) → 409 `settlement_empty` · ' +
      'ยอดสุทธิติดลบ → 409 `settlement_net_negative` · ออกเลขชุด STL ตอนนี้เท่านั้น (ร่างไม่กินเลข; ออกแล้วแก้ไม่ได้) · ใบที่อนุมัติแล้วแก้/เพิ่ม/นำบรรทัดออก/ยกเลิกไม่ได้ (409) · ' +
      '**ตรึงหัก ณ ที่จ่ายประมาณการ** (ST6-T08: ยอด + ขั้นต่ำที่ใช้ + ค่าตั้งต้นอัตราของรถร่วม — ค่าตั้ง/รถร่วมเปลี่ยนทีหลังไม่กระทบใบ; `whtEstimate.frozen` = true) · วงเงิน step-up เทียบยอดสุทธิก่อนหัก ณ ที่จ่าย · audit `settlement.approved` (+ `buyWhtAmount`) + webhook `settlement.approved`',
  })
  @ApiHeader({
    ...IF_MATCH,
    required: true,
    description: 'ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412',
  })
  @ApiHeader({
    name: 'X-Step-Up',
    required: false,
    description:
      'token step-up 2FA ของผู้อนุมัติ (อายุ 5 นาที) — บังคับเมื่อยอดสุทธิเกินวงเงินที่ตั้ง',
  })
  @ApiProblems(
    {
      status: 403,
      description:
        'ไม่มีสิทธิ์ `settlements:approve` / ผู้สร้างอนุมัติเอง (`settlement_self_approval`) / ต้องยืนยัน 2FA ซ้ำ (`step_up_required`)',
      examples: Object.fromEntries(
        (['permission_denied', 'settlement_self_approval', 'step_up_required'] as const).map(
          (code) => [
            code,
            {
              type: `https://docs.tms.example/problems/${code}`,
              title: PROBLEMS[code].th,
              status: 403,
              code,
            },
          ],
        ),
      ),
    },
    NF,
    T409(
      'settlement_empty',
      'settlement_net_negative',
      'settlement_disputed',
      'settlement_review_required',
    ),
    T412,
    T422,
  )
  @ApiOkResponse({ type: SettlementDto })
  async approve(
    @Param('id') id: string,
    @Body() body: SettlementReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const ctx = requestContext.require();
    const token = req.header('x-step-up');
    const su = token ? await verifyStepUpToken(token) : null;
    const steppedUp = !!su && su.sub === ctx.actorId && su.tid === ctx.tenantId;
    const out = await this.svc.approve(
      decodeIdOr404('settlement', id),
      body.reason,
      expectedVersion(req),
      steppedUp,
    );
    setEtag(res, out.version);
    return out;
  }

  @Post(':id/mark-paid')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:pay')
  @ApiOperation({
    summary: 'บันทึกจ่ายใบสำคัญจ่ายรถร่วม (APPROVED → PAID) — วันที่จ่าย วิธี เลขอ้างอิง ธนาคาร',
    description:
      'docs/04 F6 "จ่าย" + docs/01 §4.5 APPROVED → PAID · **เฉพาะใบ APPROVED** (ร่าง/รอตรวจ/โต้แย้ง/ยกเลิก/จ่ายแล้ว → 409 `invalid_state_transition`) · ' +
      'จ่ายเต็มยอดครั้งเดียว — ยอดที่จ่าย = `buyNetAfterWht` (ยอดสุทธิ − หัก ณ ที่จ่ายประมาณการที่ตรึงตอนอนุมัติ — ไม่เปลี่ยน) · ' +
      '`paidDate` (= วันที่หักภาษี) ตั้งแต่วันอนุมัติถึงวันนี้ (เวลาไทย) — ก่อนวันอนุมัติ → 422 `before_approval` · `reference` บังคับเมื่อ TRANSFER / CHEQUE · ' +
      'ใบที่ไม่ใช่ APPROVED (รวมจ่ายแล้ว/คำขอซ้ำพร้อมกัน) → 409 ก่อนตรวจ If-Match · ' +
      '**ผู้อนุมัติใบนี้บันทึกจ่ายเองไม่ได้ → 403 `settlement_self_payment`** (D-60 — key = ผู้ออก key; owner ปิดกฎได้ด้วยค่าตั้ง `settlement.allowApproverMarkPaid` — audit `sodWaived`) · ' +
      'เที่ยวที่บรรทัดต้นทุนจ่ายครบแล้ว COSTED → **SETTLED** (ไม่กลับเข้าคิวจ่าย) · ใบ PAID แก้ไม่ได้ · ' +
      'audit `settlement.paid` + webhook `settlement.paid` (ระบบบัญชีสร้างเจ้าหนี้/AP ร่างจาก event นี้ — 50 ทวิ ออกที่ระบบบัญชี, D-58) · ' +
      'ไฟล์โอนธนาคาร (bulk payment) = P1',
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
        'ไม่มีสิทธิ์ `settlements:pay` / ผู้อนุมัติใบนี้บันทึกจ่ายเอง (`settlement_self_payment` — D-60)',
      examples: Object.fromEntries(
        (['permission_denied', 'settlement_self_payment'] as const).map((code) => [
          code,
          {
            type: `https://docs.tms.example/problems/${code}`,
            title: PROBLEMS[code].th,
            status: 403,
            code,
          },
        ]),
      ),
    },
    NF,
    T409(),
    T412,
    T422,
  )
  @ApiOkResponse({ type: SettlementDto })
  async markPaid(
    @Param('id') id: string,
    @Body() body: SettlementPayDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettlementDto> {
    const out = await this.svc.markPaid(
      decodeIdOr404('settlement', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, out.version);
    return out;
  }
}
