import { MAX_DOS_PER_INVOICE } from './billing-limits';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RateLimitClass, RequireScope } from '../../common/decorators';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { T403, T422 } from '../trips/trip-problems';
import { isRealDate } from '../vehicle-documents/expiry';
import { CreateInvoiceRunDto, InvoiceRunAcceptedDto, InvoiceRunResultDto } from './invoice-run.dto';
import { InvoiceRunService } from './invoice-run.service';

/**
 * รอบวางบิล (ST5-T12; docs/04 F3 "Invoice run (async)", docs/04 G2 #6 `POST /invoice-runs`, docs/01 §5.2 #8)
 * ไม่มีหน้าจอในต้นแบบ — API อย่างเดียว [DECISION spec/12 §3]
 */
@ApiTags('invoices')
@ApiBearerAuth()
@ApiExtraModels(InvoiceRunResultDto)
@Controller('invoice-runs')
export class InvoiceRunsController {
  constructor(private readonly runs: InvoiceRunService) {}

  @Post()
  @HttpCode(202)
  @RateLimitClass('heavy')
  @RequireScope('invoices:draft')
  @ApiOperation({
    summary:
      'สั่งรอบวางบิล (async) — สร้างร่างใบแจ้งหนี้ทุกลูกค้าตาม billing_cycle (+ ร่างใบวางบิล)',
    description:
      'D-54 บัญชีเบา: ร่าง **ไม่มีเลข ไม่ใช่เอกสารภาษี** · ลูกค้าที่ `billingCycle` = รอบที่สั่ง (ไม่รวม `MANUAL` และลูกค้าที่ปิดใช้ `INACTIVE`) ที่มี DO พร้อมวางบิล ' +
      '(กฎเดียวกับ `GET /invoices/queue` + เวลาจุดส่งครบ) วันที่ DO อยู่ในงวด → ร่างผ่านทางเดียวกับ `POST /invoices` ' +
      '(ตรวจซ้ำตอนดึง · กันวางบิลซ้ำระดับ DB · audit `invoice.draft_created`) · `MONTHLY`/`WEEKLY` = **ใบแจ้งหนี้ใบเดียวต่อลูกค้าต่อรอบ** งวด = ที่สั่ง ' +
      `(เพดาน ${MAX_DOS_PER_INVOICE} DO ต่อใบ — เกินจึงแบ่งหลายร่าง + \`splitByCap\`) · \`PER_DO\` = 1 ร่างต่อ DO · \`billingNotes\` (ค่าเริ่มต้น true) = ร่างใบวางบิลจากใบแจ้งหนี้ที่ออกแล้วยังค้าง ` +
      'และยังไม่อยู่ในใบวางบิลที่ active **เฉพาะใบของงวดนี้** (วันสิ้นงวดของใบ `periodTo` อยู่ในงวดของรอบ — ใบที่งวดคร่อมขอบรอบเข้ารอบที่งวดจบ; ใบที่ไม่มีงวดใช้วันที่ออก) (1 ร่างต่อผู้ออก/สาขาผู้ออก) · ' +
      '**สั่งซ้ำไม่สร้างซ้ำ:** DO/ใบแจ้งหนี้ที่ถูกดึงแล้วไม่ถูกเลือกอีก · **ร่างละ transaction** (รวมการส่งบัญชีของ DO ในกลุ่ม) — กลุ่มที่ล้มย้อนทั้งกลุ่ม ' +
      'กลุ่ม/ลูกค้าอื่นไม่ล้มตาม · DO ที่ไม่ผ่านตอนดึง (ระบุตัวได้) ถูกข้าม (`skippedDeliveryOrders`) · ร่างลงชื่อผู้สั่งเป็นผู้สร้าง (กฎแบ่งหน้าที่ของ finalize ใช้เหมือนสร้างมือ) · ' +
      '202 `{jobId, statusUrl}` → `GET /v1/jobs/{id}`: `progress` ต่อร่าง · `result` = `InvoiceRunResult` (ผลต่อลูกค้า SUCCEEDED/PARTIAL/FAILED/NOTHING_TO_BILL + ลิงก์ร่าง ≤ 50 ต่อลูกค้า ' +
      '— ไม่มียอดเงิน) · ไม่มีลูกค้า PARTIAL/FAILED = `succeeded`, มี = `succeeded_with_errors` · จบ = webhook `job.completed` · ' +
      '**ไฟล์สรุปรอบ .xlsx** (`result.summary.url` = `GET /v1/exports/{jobId}` เฉพาะผู้สั่งที่มี `export:run`; ยอดเงินในไฟล์เฉพาะผู้สั่งที่มี `prices.sell:read`; ใช้ได้ 7 วัน; แจ้งเตือนผู้สั่งพร้อมลิงก์) · ' +
      'ไม่มีรอบอัตโนมัติตามเวลา (สั่งเองเท่านั้น) · ' +
      'ผู้สั่งดู `statusUrl` ได้แม้ไม่มี `jobs:read` · job เก็บ 7 วัน · นับเป็นคำขอหนัก (rate limit ชั้น heavy)',
  })
  @ApiProblems(T403('invoices:draft'), T422)
  @ApiAcceptedResponse({
    type: InvoiceRunAcceptedDto,
    description: 'รับงานแล้ว ติดตามที่ `statusUrl`',
  })
  create(@Body() body: CreateInvoiceRunDto): Promise<InvoiceRunAcceptedDto> {
    const bad = (['periodFrom', 'periodTo'] as const).flatMap((f) =>
      !isRealDate(body[f])
        ? [{ field: f, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]
        : [],
    );
    if (!bad.length && body.periodFrom > body.periodTo)
      bad.push({
        field: 'periodTo',
        code: 'before_period_from',
        message: 'periodTo must be ≥ periodFrom',
      });
    if (bad.length) throw new ProblemException('validation_failed', undefined, bad);
    return this.runs.enqueue(body);
  }
}
