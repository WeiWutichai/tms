import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  RequireFeature,
  RequireScope,
  SandboxAware,
  TenantResource,
} from '../../common/decorators';
import { decodeIdOr404, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { ConnectorsService } from './connectors.service';
import { PaymentStatusPullService } from './payment-status-pull.service';
import {
  CreateReconcileRunDto,
  ReconcileResultDto,
  ReconcileResultListQuery,
  ReconcileResultPageDto,
  ReconcileRunDto,
} from './reconcile-result.dto';
import { ReconcileResultsService } from './reconcile-results.service';

const prob = (
  code: string,
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title,
  status,
  code,
  ...extra,
});
const E409_RUN = {
  status: 409,
  description:
    '`invalid_state_transition` — connector นี้ดึงสถานะรับชำระไม่ได้ตอนนี้ (`reason`: `connector_not_active` ยังไม่เปิดใช้/หยุดอยู่ · ' +
    '`capability_not_enabled` ระบบบัญชีนี้ไม่รองรับหรือยังไม่เปิด `fetchPaymentStatus` · `adapter_unavailable`)',
  examples: {
    invalid_state_transition: prob(
      'invalid_state_transition',
      409,
      'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
      { reason: 'capability_not_enabled' },
    ),
  },
};

/**
 * ผลกระทบยอดกับระบบภายนอก (ST7-T21; docs/01 §5.2 กลุ่ม 14 `reconcile-results`, `POST /reconcile-runs`; docs/04 G3 "Payment status pull")
 * ตอนนี้ครอบเฉพาะ "สถานะรับชำระจากระบบบัญชี" — เทียบเอกสาร 4 รอบ (ST8-T11) และการปิดรายการ/หน้า MISMATCH (ST8-T12) ต่อยอดจาก resource นี้
 * อ่าน `integrations:read` · สั่งรอบเอง `settings:write` (คนเท่านั้น — แบบเดียวกับการจัดการ connector) · ฟีเจอร์ `conn` · sandbox ใช้ได้กับ DemoProvider เท่านั้น (D-81 · D68-58)
 */
@ApiTags('connectors')
@ApiBearerAuth()
@SandboxAware()
@RequireFeature('conn')
@Controller()
export class ReconcileController {
  constructor(
    private readonly results: ReconcileResultsService,
    private readonly pull: PaymentStatusPullService,
    private readonly connectors: ConnectorsService,
    private readonly db: DbService,
  ) {}

  @Get('reconcile-results')
  @RequireScope('integrations:read')
  @ApiOkResponse({
    type: ReconcileResultPageDto,
    description:
      'รายการที่ข้อมูล TMS ไม่ตรงกับระบบบัญชีที่เชื่อมต่อ (MISMATCH) — ตอนนี้ = ยอดรับชำระของใบแจ้งหนี้ (`check` PAYMENT_STATUS, severity MONEY) · ' +
      'กรอง `status` OPEN/ACKNOWLEDGED/RESOLVED, `connectorId`, `invoiceId`, `severity` · cursor มาตรฐาน (updatedAt, id) · ' +
      'ส่วนต่างเดิมไม่สร้างรายการซ้ำ (`lastSeenAt` = รอบล่าสุดที่ยังพบ) · ระบบ**ไม่ปรับยอดใน TMS เอง** — แก้ที่ต้นเหตุ (บันทึก/กลับรายการรับชำระ) แล้วรอบถัดไปปิดให้ (`RESOLVED`) · ' +
      'ยอดเงินต้องมี `prices.sell:read`',
  })
  list(@Query() q: ReconcileResultListQuery): Promise<ReconcileResultPageDto> {
    return this.results.list(q);
  }

  @Get('reconcile-results/:id')
  @TenantResource('reconcileResult')
  @RequireScope('integrations:read')
  @ApiOkResponse({ type: ReconcileResultDto })
  get(@Param('id') id: string): Promise<ReconcileResultDto> {
    return this.results.get(decodeIdOr404('reconcileResult', id));
  }

  @Post('reconcile-runs')
  @HttpCode(202)
  @RequireScope('settings:write')
  @ApiAcceptedResponse({
    type: ReconcileRunDto,
    description:
      'สั่งรอบกระทบยอดเอง (source MANUAL) — `check` PAYMENT_STATUS: ดึงสถานะรับชำระของใบแจ้งหนี้ที่ยังค้างจากระบบบัญชีของ connector นี้ทันที ' +
      '(ปกติระบบดึงเองวันละครั้งตั้งแต่ 06:00 น.) · ทำงานเบื้องหลัง — ผลดูที่ `GET /payments` (รายการ source CONNECTOR) และ `GET /reconcile-results` · ' +
      'มีรอบของ connector นี้ค้างอยู่ = `ALREADY_QUEUED` · connector ไม่พบ → 404 · ดึงไม่ได้ตอนนี้ → 409 · เฉพาะผู้ใช้ (API key สั่งไม่ได้ → 403)',
  })
  @ApiProblems(E409_RUN)
  async run(@Body() body: CreateReconcileRunDto): Promise<ReconcileRunDto> {
    this.connectors.assertHuman();
    const id = tryDecodeId('connector', body.connectorId);
    if (!id) throw new ProblemException('not_found');
    const tx = this.db.tx;
    const row = await tx.connector.findUnique({ where: { id } });
    if (!row) throw new ProblemException('not_found');
    const tenantId = requestContext.require().tenantId!;
    const why = await this.pull.whyNot(tenantId, row);
    if (why)
      throw new ProblemException('invalid_state_transition', undefined, undefined, { reason: why });
    const status = await this.pull.enqueueManual(tx, tenantId, id);
    return { status, check: body.check, connectorId: body.connectorId };
  }
}
