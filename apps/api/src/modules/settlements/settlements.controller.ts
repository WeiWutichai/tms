import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { verifyStepUpToken } from '../../auth/tokens';
import { requestContext } from '../../common/request-context';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { T403, T404, T409, T412, T422 } from '../trips/trip-problems';
import { PROBLEMS } from '../../common/problem';
import { isRealDate } from '../vehicle-documents/expiry';
import { SettlementQueuePageDto, SettlementQueueQuery } from './settlement-queue.dto';
import { SettlementQueueService } from './settlement-queue.service';
import {
  CreateSettlementDto,
  SettlementDto,
  SettlementItemsInput,
  SettlementListQuery,
  SettlementPageDto,
  SettlementReasonDto,
  UpdateSettlementDto,
} from './settlement.dto';
import { SettlementsService } from './settlements.service';

const NF = { ...T404, description: 'ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น)' };
const IF_MATCH = {
  name: 'If-Match',
  required: false,
  description: 'ETag (version) — ไม่ตรง → 412',
};

/**
 * Settlement รถร่วม (AP — docs/04 F6, docs/01 §4.5, §5.2 #12 `settlements`)
 * ST6-T02 คิวจ่ายรถร่วม · ST6-T03 ใบสำคัญจ่าย (ร่าง) · ST6-T07 อนุมัติ — ส่งรถร่วมตรวจ/dispute/จ่าย = ST6-T05/T06/T09
 * อ่าน `settlements:read` (ยอดเห็นเมื่อมี `prices.buy:read`) · สร้าง/แก้ร่าง/ยกเลิกร่าง `settlements:create` · อนุมัติ `settlements:approve`
 */
@ApiTags('settlements')
@ApiBearerAuth()
@Controller('settlements')
export class SettlementsController {
  constructor(
    private readonly queue: SettlementQueueService,
    private readonly svc: SettlementsService,
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
      'ยอดสุทธิ = ยอดรวม − รายการหัก (ยังไม่หัก ณ ที่จ่าย — ST6-T08; บรรทัดเก็บ `vatType`/`whtRate` ที่คัดลอกจากต้นทุน) · ' +
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
  @Post(':id/approve')
  @HttpCode(200)
  @TenantResource('settlement')
  @RequireScope('settlements:approve')
  @ApiOperation({
    summary: 'อนุมัติใบสำคัญจ่าย (separation of duties) → ออกเลข STL — เหตุผล ≥ 10 ตัวอักษร',
    description:
      'DRAFT → APPROVED (docs/01 §4.5 — ยังไม่มีขั้นให้รถร่วมตรวจ ST6-T05) · **ผู้สร้างใบอนุมัติเองไม่ได้ → 403 `settlement_self_approval`** · ' +
      'ยอดสุทธิเกินวงเงินที่ตั้ง (`settlement.approvalStepUpAmount` — ค่าเริ่ม 100,000 บาท) ต้องส่ง `X-Step-Up` ของผู้อนุมัติ ' +
      '(จาก `POST /v1/auth/step-up` ยืนยัน TOTP) ไม่งั้น 403 `step_up_required` · ไม่มีบรรทัดเที่ยว → 409 `settlement_empty` · ' +
      'ยอดสุทธิติดลบ → 409 `settlement_net_negative` · ออกเลขชุด STL ตอนนี้เท่านั้น (ร่างไม่กินเลข; ออกแล้วแก้ไม่ได้) · ใบที่อนุมัติแล้วแก้/เพิ่ม/นำบรรทัดออก/ยกเลิกไม่ได้ (409) · ' +
      'ยังไม่หัก ณ ที่จ่าย (ST6-T08) · audit `settlement.approved` + webhook `settlement.approved`',
  })
  @ApiHeader(IF_MATCH)
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
    T409('settlement_empty', 'settlement_net_negative'),
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
}
