import { scopeAllows } from '@tms/domain';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  RequireFeature,
  RequireScope,
  SandboxAware,
  TenantResource,
} from '../../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { ConnectorsService } from './connectors.service';
import { DocumentReconcileService } from './document-reconcile.service';
import { PaymentStatusPullService } from './payment-status-pull.service';
import {
  CreateReconcileRunDto,
  ReconcileReasonDto,
  ReconcileResultDto,
  ReconcileResultListQuery,
  ReconcileResultPageDto,
  ReconcileRunDto,
} from './reconcile-result.dto';
import { ReconcileCloseService } from './reconcile-close.service';
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
    '`capability_not_enabled` ระบบบัญชีนี้ไม่รองรับหรือยังไม่เปิด `fetchPaymentStatus` (DOCUMENT: `fetchDocument`) · `adapter_unavailable` · DOCUMENT: `connector_unhealthy` ระบบบัญชีไม่ตอบ คิวพักอยู่)',
  examples: {
    invalid_state_transition: prob(
      'invalid_state_transition',
      409,
      'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
      { reason: 'capability_not_enabled' },
    ),
  },
};

const E409_CLOSE = {
  status: 409,
  description:
    '`invalid_state_transition` — `reason`: `already_resolved` · `already_acknowledged` · `not_a_mismatch` (INFO) · `not_a_document_mismatch` · ' +
    '`overwrite_in_progress` (คำขอรออนุมัติ / คำสั่งส่งทับยังไม่จบหรือส่งแล้วรอรอบเทียบ) · `overwrite_not_requested` · `invoice_not_voided` · `invoice_voided` · ' +
    '`paid_locked` (รับชำระแล้ว) · `connector_disconnected` · `command_in_progress` (มีคำสั่งส่งของเอกสารนี้ค้าง) · `capability_not_implemented` (ระบบบัญชียังแทนที่ไม่ได้) · ' +
    '`replace_not_supported` · `nothing_to_resend`',
  examples: {
    invalid_state_transition: prob(
      'invalid_state_transition',
      409,
      'ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',
      {
        reason: 'invoice_not_voided',
      },
    ),
  },
};

/**
 * ผลกระทบยอดกับระบบภายนอก (ST7-T21; docs/01 §5.2 กลุ่ม 14 `reconcile-results`, `POST /reconcile-runs`; docs/04 G3 "Payment status pull")
 * สถานะรับชำระจากระบบบัญชี (ST7-T21) · เทียบเอกสาร 4 รอบ (ST8-T11) · ปิดรายการไม่ตรง 3 ทาง + หน้า MISMATCH (ST8-T12)
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
    private readonly reconcile: DocumentReconcileService,
    private readonly connectors: ConnectorsService,
    private readonly db: DbService,
    private readonly close: ReconcileCloseService,
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

  // ---------- ST8-T12 ปิดรายการไม่ตรง 3 ทาง (docs/01 §6.5) — คนเท่านั้น · เหตุผล ≥ 10 ตัวอักษร · audit ผู้ทำ + เหตุผล ----------

  @Post('reconcile-results/:id/acknowledge')
  @HttpCode(200)
  @TenantResource('reconcileResult')
  @RequireScope('integrations:retry')
  @ApiOperation({
    summary: 'ยอมรับความต่าง (ack) พร้อมเหตุผล — ปิดรายการไม่ตรงทางที่ 3',
    description:
      'ST8-T12 (docs/01 §6.5 "ยอมรับความต่าง → ack พร้อมเหตุผล; รอบถัดไปไม่แจ้งซ้ำถ้า `diff_hash` เท่าเดิม") · สิทธิ์ `integrations:retry` (ฝ่ายบัญชี) · ' +
      'คนเท่านั้น (API key → 403) · ใช้ได้กับรายการ `result` MISMATCH / REMOTE_MISSING ที่ยังเปิด (ทั้งยอดรับชำระและเนื้อหาเอกสาร) · ' +
      'เนื้อหาเอกสาร: `sync.reconcileState` ของใบ → ACCEPTED (docs/01 §4.4) · การส่งทับยังดำเนินอยู่ → 409 `overwrite_in_progress` (คำสั่งจบแบบไม่สำเร็จ = ปิดได้) · ' +
      'ปิดแล้ว/ยอมรับแล้ว → 409 (`already_resolved` / `already_acknowledged`) · audit `reconcile.mismatch_acknowledged`',
  })
  @ApiOkResponse({ type: ReconcileResultDto })
  @ApiProblems(E409_CLOSE)
  acknowledge(
    @Param('id') id: string,
    @Body() body: ReconcileReasonDto,
  ): Promise<ReconcileResultDto> {
    return this.close.acknowledge(decodeIdOr404('reconcileResult', id), body.reason);
  }

  @Post('reconcile-results/:id/resolve-in-tms')
  @HttpCode(200)
  @TenantResource('reconcileResult')
  @RequireScope('integrations:retry')
  @ApiOperation({
    summary: 'ปิดรายการไม่ตรงทาง "แก้ที่ TMS" — ใบยกเลิกแล้ว (ออกใบใหม่แทน)',
    description:
      'ST8-T12 (docs/01 §6.5 ทางที่ 1 "ERP ถูก → แก้ที่ TMS ด้วย credit/debit note") · **D-54 [OPEN — PO]:** ใบลด/เพิ่มหนี้ไม่อยู่ใน TMS เฟส 0 → ระหว่างรอ ' +
      'ยกเลิกใบแล้วออกใหม่ด้วย `POST /invoices/{id}/void` (`reissue: true` — สิทธิ์ `invoices:void` + step-up ตาม endpoint นั้น) แล้วเรียก endpoint นี้ปิดรายการ · ' +
      'สิทธิ์ `integrations:retry` · คนเท่านั้น · เฉพาะเนื้อหาเอกสาร (`check` DOCUMENT) ที่ยังเปิด · ใบยังไม่ยกเลิก → 409 `invoice_not_voided` · ' +
      '`resolution` FIXED_IN_TMS + audit `reconcile.mismatch_closed` (ผู้ทำ + เหตุผล + ใบที่ออกแทน)',
  })
  @ApiOkResponse({ type: ReconcileResultDto })
  @ApiProblems(E409_CLOSE)
  resolveInTms(
    @Param('id') id: string,
    @Body() body: ReconcileReasonDto,
  ): Promise<ReconcileResultDto> {
    return this.close.resolveInTms(decodeIdOr404('reconcileResult', id), body.reason);
  }

  @Post('reconcile-results/:id/resend')
  @HttpCode(200)
  @TenantResource('reconcileResult')
  @RequireScope('integrations:retry')
  @ApiOperation({
    summary: 'ใช้ค่า TMS ส่งซ้ำ — ส่งเอกสารฉบับที่ออกทับระบบบัญชี (ทางที่ 2 "TMS ถูก")',
    description:
      'ST8-T12 (docs/01 §6.5 ทางที่ 2 `replaceDocument`) · สิทธิ์ `integrations:retry` · คนเท่านั้น · เฉพาะเนื้อหาเอกสารที่ยังเปิด · ' +
      'คำสั่ง REPLACE_DOCUMENT (หรือส่งใหม่เมื่อไม่อยู่ในระบบบัญชี) ผ่านประตูอนุมัติของ ST8-T13 — ลงบัญชีแล้ว/อายุใบเกิน N วัน = คำสั่ง SKIPPED ' +
      '`replace_requires_approval` (`overwrite.commandErrorCode`) → ใช้ "ขออนุมัติแก้" · รับชำระแล้ว → 409 `paid_locked` · มีคำสั่งค้าง → 409 `command_in_progress` · ' +
      'ระบบบัญชีแทนที่ไม่ได้ → 409 `capability_not_implemented` / `replace_not_supported` · `overwrite.status` SENT · รอบเทียบหลังส่งตรง = ปิดเอง ERP_OVERWRITTEN · ' +
      'audit `reconcile.overwrite_sent`',
  })
  @ApiOkResponse({ type: ReconcileResultDto })
  @ApiProblems(E409_CLOSE)
  resend(@Param('id') id: string, @Body() body: ReconcileReasonDto): Promise<ReconcileResultDto> {
    return this.close.resend(decodeIdOr404('reconcileResult', id), body.reason);
  }

  @Post('reconcile-results/:id/overwrite-request')
  @HttpCode(200)
  @TenantResource('reconcileResult')
  @RequireScope('integrations:retry')
  @ApiOperation({
    summary: 'ขออนุมัติส่งทับระบบบัญชีด้วยค่า TMS (ทางที่ 2 "TMS ถูก")',
    description:
      'ST8-T12 "ขออนุมัติแก้" (docs/01 §6.5 ทางที่ 2 — `replaceDocument` ต้อง approval ถ้าลงบัญชีแล้ว) · สิทธิ์ `integrations:retry` · คนเท่านั้น · เฉพาะเนื้อหาเอกสารที่ยังเปิด · ' +
      'ใบยกเลิกแล้ว → 409 `invoice_voided` · รับชำระแล้ว → 409 `paid_locked` · connector ยกเลิกการเชื่อม → 409 `connector_disconnected` · ' +
      'มีคำสั่งค้าง → 409 `command_in_progress` · ระบบบัญชีแทนที่ไม่ได้ → 409 `capability_not_implemented` / `replace_not_supported` · การส่งทับยังดำเนินอยู่ → 409 `overwrite_in_progress` · ' +
      'ถูกปฏิเสธแล้วขอใหม่ได้ · audit `reconcile.overwrite_requested`',
  })
  @ApiOkResponse({ type: ReconcileResultDto })
  @ApiProblems(E409_CLOSE)
  requestOverwrite(
    @Param('id') id: string,
    @Body() body: ReconcileReasonDto,
  ): Promise<ReconcileResultDto> {
    return this.close.requestOverwrite(decodeIdOr404('reconcileResult', id), body.reason);
  }

  @Post('reconcile-results/:id/overwrite-request/approve')
  @HttpCode(200)
  @TenantResource('reconcileResult')
  @RequireScope('credit-notes:approve')
  @ApiOperation({
    summary: 'อนุมัติส่งทับระบบบัญชีด้วยค่า TMS → คำสั่งแทนที่เอกสาร',
    description:
      'ST8-T12 · สิทธิ์ `credit-notes:approve` (ชุดเดียวกับการอนุมัติแทนที่ในคิว ST8-T13) · คนเท่านั้น · ' +
      '**ผู้อนุมัติต้องไม่ใช่ผู้ขอ และไม่ใช่ผู้สร้าง/แก้/ออกเลขใบ** (403 `erp_replace_self_approval`) · สร้างคำสั่งด้วยเอกสารฉบับที่ออก + `approval` ' +
      '{approvedBy, approvedAt, reason, reconcileResultId} ผ่านประตูอนุมัติของ ST8-T13 · มีคำสั่งของเอกสารค้าง → 409 `command_in_progress` · ' +
      'รับชำระแล้ว → 409 `paid_locked` · ระบบบัญชีแทนที่ไม่ได้ → 409 `capability_not_implemented` / `replace_not_supported` · ' +
      'รอบเทียบหลังส่งตรงกัน = ปิดเอง (`resolution` ERP_OVERWRITTEN) · ไม่มีคำขอ → 409 `overwrite_not_requested` · ' +
      'audit `reconcile.overwrite_approved` (+ `commandId`)',
  })
  @ApiOkResponse({ type: ReconcileResultDto })
  @ApiProblems(E409_CLOSE)
  approveOverwrite(
    @Param('id') id: string,
    @Body() body: ReconcileReasonDto,
  ): Promise<ReconcileResultDto> {
    return this.close.approveOverwrite(decodeIdOr404('reconcileResult', id), body.reason);
  }

  @Post('reconcile-results/:id/overwrite-request/reject')
  @HttpCode(200)
  @TenantResource('reconcileResult')
  @RequireScope('credit-notes:approve')
  @ApiOperation({
    summary: 'ไม่อนุมัติการส่งทับ — รายการกลับเป็น "ไม่ตรง"',
    description:
      'ST8-T12 · สิทธิ์ `credit-notes:approve` · คนเท่านั้น · ผู้ปฏิเสธต้องไม่ใช่ผู้ขอ (403 `erp_replace_self_approval`) · ขอใหม่ได้ · audit `reconcile.overwrite_rejected`',
  })
  @ApiOkResponse({ type: ReconcileResultDto })
  @ApiProblems(E409_CLOSE)
  rejectOverwrite(
    @Param('id') id: string,
    @Body() body: ReconcileReasonDto,
  ): Promise<ReconcileResultDto> {
    return this.close.rejectOverwrite(decodeIdOr404('reconcileResult', id), body.reason);
  }

  @Post('reconcile-runs')
  @HttpCode(202)
  // ST8-T11 (docs/01 §6.5 "บัญชีแก้แล้วอยากยืนยัน"): DOCUMENT สั่งได้ด้วย integrations:retry (role บัญชีมี) · PAYMENT_STATUS ยังต้อง settings:write
  @RequireScope('settings:write', 'integrations:retry')
  @ApiAcceptedResponse({
    type: ReconcileRunDto,
    description:
      'สั่งรอบกระทบยอดเอง (source MANUAL) — `check` PAYMENT_STATUS: ดึงสถานะรับชำระของใบแจ้งหนี้ที่ยังค้างจากระบบบัญชีของ connector นี้ทันที ' +
      '· `check` DOCUMENT (ST8-T11): อ่านใบแจ้งหนี้ที่เลือก (`invoiceIds` 1–200) กลับจากระบบบัญชีแล้วเทียบเนื้อหา (คำสั่ง FETCH_DOCUMENT ผ่านคิวของ connector · ' +
      'ต้องมี `reason` ≥ 10 ตัวอักษร ลง audit · ใบที่ไม่อยู่ในระบบบัญชีนี้คืนใน `notInErp` · ผลดูที่ `GET /reconcile-results` และ `sync.reconcileState` ของใบ) ' +
      '(ปกติระบบดึงเองวันละครั้งตั้งแต่ 06:00 น.) · ทำงานเบื้องหลัง — ผลดูที่ `GET /payments` (รายการ source CONNECTOR) และ `GET /reconcile-results` · ' +
      'มีรอบของ connector นี้ค้างอยู่ = `ALREADY_QUEUED` · connector ไม่พบ → 404 · ดึงไม่ได้ตอนนี้ → 409 · เฉพาะผู้ใช้ (API key สั่งไม่ได้ → 403) · ' +
      'สิทธิ์: PAYMENT_STATUS ต้อง `settings:write` · DOCUMENT ใช้ `settings:write` หรือ `integrations:retry` (ฝ่ายบัญชี — docs/01 §6.5)',
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
    if (body.check === 'DOCUMENT') {
      // ST8-T11 MANUAL (docs/01 §6.5 "ปุ่มบนหน้าจอ / POST /reconcile-runs — ที่เลือก") — เหตุผล + audit
      const reason = body.reason?.trim() ?? '';
      const ids = body.invoiceIds ?? [];
      const fields = [
        ...(ids.length
          ? []
          : [{ field: 'invoiceIds', code: 'required', message: 'เลือกใบแจ้งหนี้อย่างน้อย 1 ใบ' }]),
        ...(reason.length >= 10
          ? []
          : [{ field: 'reason', code: 'too_short', message: 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร' }]),
      ];
      if (fields.length) throw new ProblemException('validation_failed', undefined, fields);
      const why = await this.reconcile.whyNot(tenantId, row);
      if (why)
        throw new ProblemException('invalid_state_transition', undefined, undefined, {
          reason: why,
        });
      const uuids = ids.map((x) => tryDecodeId('invoice', x)).filter((x): x is string => !!x);
      const r = await this.reconcile.enqueueManual(tx, tenantId, row, uuids, reason);
      const bad = ids.filter((x) => !tryDecodeId('invoice', x));
      return {
        status: 'QUEUED',
        check: body.check,
        connectorId: body.connectorId,
        queued: r.queued,
        notInErp: [...bad, ...r.notInErp.map((u) => encodeId('invoice', u))],
      };
    }
    if (!scopeAllows(requestContext.require().scopes ?? [], 'settings:write'))
      throw new ProblemException('forbidden', 'PAYMENT_STATUS requires settings:write');
    const why = await this.pull.whyNot(tenantId, row);
    if (why)
      throw new ProblemException('invalid_state_transition', undefined, undefined, { reason: why });
    const status = await this.pull.enqueueManual(tx, tenantId, id);
    return { status, check: body.check, connectorId: body.connectorId };
  }
}
