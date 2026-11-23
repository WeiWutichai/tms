import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CleanText } from '../master/master-kit';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { RECONCILE_LEVELS } from './reconcile-compare';
import { DOCUMENT_RESULT_CODES, PAYMENT_MISMATCH_CODES } from './reconcile-results.service';

/** ST8-T11 ใบที่สั่งเทียบเองได้ต่อครั้ง */
export const MAX_MANUAL_RECONCILE = 200;
export const RECONCILE_RUN_CHECKS = ['PAYMENT_STATUS', 'DOCUMENT'] as const;
export const RECONCILE_RESULT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export const RECONCILE_SEVERITIES = ['MONEY', 'FIELD', 'INFO'] as const;
export const RECONCILE_SOURCES = ['AFTER_PUSH', 'NIGHTLY', 'PRE_CLOSE', 'MANUAL'] as const;
export const RECONCILE_OUTCOMES = [
  'MATCH',
  'MISMATCH',
  'REMOTE_MISSING',
  'ERP_UNREACHABLE',
  'NOT_COMPARABLE',
] as const;

export class ReconcileResultListQuery extends ListQuery {
  @ApiPropertyOptional({
    enum: RECONCILE_RESULT_STATUSES,
    description:
      'OPEN = ยังต่างอยู่และยังไม่มีคนยอมรับ · ACKNOWLEDGED = คนยอมรับความต่างแล้ว · RESOLVED = ระบบปิดแล้ว (รอบถัดไปตรงกัน/ส่วนต่างเปลี่ยน)',
  })
  @IsOptional()
  @IsIn(RECONCILE_RESULT_STATUSES)
  status?: (typeof RECONCILE_RESULT_STATUSES)[number];

  @ApiPropertyOptional({ example: 'con_…' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  connectorId?: string;

  @ApiPropertyOptional({ example: 'ivc_…', description: 'ผลของใบแจ้งหนี้นี้' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  invoiceId?: string;

  @ApiPropertyOptional({ enum: RECONCILE_SEVERITIES })
  @IsOptional()
  @IsIn(RECONCILE_SEVERITIES)
  severity?: (typeof RECONCILE_SEVERITIES)[number];
}

export class ReconcileConnectorDto {
  @ApiProperty({ example: 'con_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' }) id!: string;
  @ApiProperty({ example: 'demo', description: 'รหัส adapter ของ connector' }) adapterKey!: string;
}

/** ST8-T11 ช่องที่ต่าง (หัวเอกสาร / ยอดรวม) — ช่องเงินอยู่ใน `sell*Value` (สิทธิ์ราคาขาย) */
export class ReconcileFieldDiffDto {
  @ApiProperty({
    example: 'dueDate',
    description: 'path ของช่องใน canonical (เช่น `customer.externalId`)',
  })
  field!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ค่าฝั่ง TMS (ว่าง = null) · ช่องเงิน = null (ดู `sellLocalValue`) · ชื่อคนขับ = `***`',
  })
  local!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ค่าฝั่งระบบบัญชี (ว่าง = null)' })
  remote!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'ค่าเงินฝั่ง TMS — `prices.sell:read`',
  })
  @PriceField('sell')
  sellLocalValue?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'ค่าเงินฝั่งระบบบัญชี — `prices.sell:read`',
  })
  @PriceField('sell')
  sellRemoteValue?: string | null;
}

/** ST8-T11 รายการ (อ้างด้วยเลขรายการของ TMS + เลข DO ที่ใช้จับคู่) */
export class ReconcileLineRefDto {
  @ApiProperty({
    nullable: true,
    type: 'integer',
    description: 'เลขรายการในใบของ TMS (ฝั่งระบบบัญชีที่จับคู่ไม่ได้ = null)',
  })
  lineNo!: number | null;
  @ApiProperty({ nullable: true, type: String, example: 'DO-2611-0001' })
  deliveryOrderNumber!: string | null;
}

export class ReconcileLineFieldDiffDto extends ReconcileFieldDiffDto {
  @ApiProperty({ nullable: true, type: 'integer' }) lineNo!: number | null;
  @ApiProperty({ nullable: true, type: String }) deliveryOrderNumber!: string | null;
}

export class ReconcileLineCountDto {
  @ApiProperty({ type: 'integer', description: 'จำนวนรายการที่ TMS ส่ง' }) local!: number;
  @ApiProperty({ type: 'integer', description: 'จำนวนรายการที่อ่านกลับจากระบบบัญชี' })
  remote!: number;
}

/**
 * ST8-T11 ส่วนต่างของเนื้อหาเอกสาร (docs/01 §6.5 — `check` DOCUMENT, `code` content_mismatch) — ระบุ "รายการไหน" ต่าง
 * ระดับ: HEADER (FIELD) · LINE_COUNT (MONEY — จำนวนไม่เท่า / รายการของเราที่หาย `missingLines`) · TOTAL (MONEY — เฉพาะเมื่อระบบบัญชีคืนยอดมา)
 * · LINE_FIELD (FIELD — จับคู่ด้วยเลข DO) · EXTRA_LINE (MONEY — ระบบบัญชีมีแต่ TMS ไม่มี)
 */
export class ReconcileDocumentDiffDto {
  @ApiProperty({ enum: RECONCILE_LEVELS, isArray: true }) levels!: string[];
  @ApiProperty({ type: ReconcileLineCountDto, nullable: true })
  lineCount!: ReconcileLineCountDto | null;
  @ApiProperty({ type: [ReconcileLineRefDto], description: 'รายการของ TMS ที่ไม่พบในระบบบัญชี' })
  missingLines!: ReconcileLineRefDto[];
  @ApiProperty({ type: [ReconcileLineRefDto], description: 'รายการที่ระบบบัญชีมีแต่ TMS ไม่มี' })
  extraLines!: ReconcileLineRefDto[];
  @ApiProperty({ type: [ReconcileFieldDiffDto] }) header!: ReconcileFieldDiffDto[];
  @ApiProperty({ type: [ReconcileLineFieldDiffDto] }) lineFields!: ReconcileLineFieldDiffDto[];
  @ApiProperty({ type: [ReconcileFieldDiffDto], description: 'ยอดรวม / ยอด VAT (tolerance 0.01)' })
  total!: ReconcileFieldDiffDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'remote_has_no_amounts',
    description:
      'ไม่ได้เทียบยอดเพราะ… (`remote_has_no_amounts` = ระบบบัญชีไม่คืนยอดเงิน — ไม่คำนวณแทน) · null = เทียบแล้ว',
  })
  totalSkipped!: string | null;
  @ApiProperty({ description: 'รายการต่างเกินเพดานที่เก็บ (1,000 ต่อกลุ่ม) — แสดงไม่ครบ' })
  truncated!: boolean;
}

/** ST8-T11 เอกสารฝั่งระบบบัญชีที่ไม่ใช่ของใบนี้ */
export class ReconcileRefMismatchDto {
  @ApiProperty({ example: '100002' }) externalId!: string;
  @ApiProperty({ example: 'INV-00000-6911-0001', description: 'เลขอ้างอิงที่ TMS คาด' })
  expectedRef!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เลขอ้างอิงที่อยู่ในเอกสารฝั่งระบบบัญชี',
  })
  actualRef!: string | null;
}

/**
 * ผลกระทบยอดกับระบบภายนอก 1 รายการ (ST7-T21; docs/01 §3.7 `reconcile_result`)
 * ตอนนี้มีเฉพาะ "ยอดรับชำระฝั่งระบบบัญชี ≠ TMS" (`check` = PAYMENT_STATUS) — การเทียบเอกสารรายบรรทัด = ST8-T11
 */
export class ReconcileResultDto {
  @ApiProperty({ example: 'rec_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' }) id!: string;
  @ApiProperty({ type: ReconcileConnectorDto }) connector!: ReconcileConnectorDto;
  @ApiProperty({ example: 'INVOICE', description: 'ชนิดเอกสารฝั่ง TMS ที่เทียบ' })
  entityType!: string;
  @ApiProperty({ nullable: true, type: String, example: 'ivc_…' }) invoiceId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'INV-00000-2611-0001' })
  localNumber!: string | null;
  @ApiProperty({ enum: RECONCILE_OUTCOMES }) result!: string;
  @ApiProperty({ enum: RECONCILE_SEVERITIES, description: 'MONEY = กระทบยอดเงิน' })
  severity!: string;
  @ApiProperty({
    enum: RECONCILE_SOURCES,
    description:
      'AFTER_PUSH = หลังส่งสำเร็จ (ทันที + 60 นาที) · NIGHTLY = รอบรายวัน · PRE_CLOSE = ก่อนปิดงวด (วันทำการสุดท้ายของเดือน 17:00) · MANUAL = สั่งเอง (`POST /reconcile-runs`)',
  })
  source!: string;
  @ApiProperty({ enum: RECONCILE_RESULT_STATUSES }) status!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'PAYMENT_STATUS',
    description:
      'PAYMENT_STATUS = ยอดรับชำระ (ST7-T21) · DOCUMENT = เนื้อหาเอกสารที่ส่งแล้ว (ST8-T11 — `content_mismatch` / `remote_missing` / `erp_unreachable`)',
  })
  check!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: [...PAYMENT_MISMATCH_CODES, ...DOCUMENT_RESULT_CODES],
    description:
      '`remote_exceeds_total` ระบบบัญชีตัดหนี้เกินยอดใบ · `remote_paid_amount_short` ระบบบัญชีบอกชำระครบแต่ยอดตัดหนี้น้อยกว่ายอดใบ · ' +
      '`remote_less_than_tms` ระบบบัญชีตัดหนี้น้อยกว่าที่ TMS บันทึกรับ · `tms_has_other_payments` ระบบบัญชีตัดหนี้มากกว่า TMS แต่ใบมีรับชำระที่บันทึกเอง ' +
      '(ไม่บันทึกเพิ่มให้เอง) · `connector_payment_reversed` ใบนี้เคยมีรายการที่ระบบสร้างแล้วถูกกลับรายการใน TMS (ไม่สร้างให้อีก) · ' +
      '`remote_wht_unknown` ระบบบัญชีไม่บอกภาษีหัก ณ ที่จ่าย · `remote_wht_inconsistent` ภาษีหัก ณ ที่จ่ายที่รายงานขัดกัน · ' +
      '`remote_paid_at_invalid` วันที่รับชำระไม่มี/เป็นอนาคต/ก่อนวันออกใบ · `payment_rejected` กฎรับชำระของ TMS ไม่รับ (ดู `reason`) · ' +
      '`remote_missing` (ST7-T16) แทนที่/อ่านเอกสารแล้วระบบบัญชีตอบว่าไม่พบ — ส่งใหม่เป็นเลขใหม่ต้องให้บัญชีรับรู้ · ' +
      '`content_mismatch` (ST8-T11) เนื้อหาเอกสารในระบบบัญชีไม่ตรงกับที่ TMS ออก (ดู `documentDiff`) · ' +
      '`erp_unreachable` (ST8-T11) อ่านเอกสารจากระบบบัญชีไม่สำเร็จจนหมดรอบลองใหม่ (INFO) · ' +
      '`remote_ref_mismatch` (ST8-T11) เลขเอกสารฝั่งระบบบัญชีที่รู้ชี้ไปเอกสารที่ไม่ใช่ของใบนี้ (ดู `refMismatches`, MONEY) · ' +
      '`not_comparable` (ST8-T11) เทียบเนื้อหาไม่ได้ — ระบบบัญชีนี้ไม่ประกาศส่วนที่เทียบได้ / ไม่มีข้อมูลการส่งของใบ (INFO, `reason`)',
  })
  code!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'invoice_not_payable',
    description: 'รหัสเหตุผลเพิ่มเติม (เฉพาะ `payment_rejected`) — เป็นรหัสเท่านั้น ไม่มียอดเงิน',
  })
  reason!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'PARTIALLY_PAID' })
  localStatus!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'PAID' }) remoteStatus!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  remotePaidAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เลขเอกสารฝั่งระบบบัญชี' })
  externalDocNo!: string | null;
  @ApiPropertyOptional({ description: 'ยอดตัดหนี้ของใบใน TMS (รวม WHT) — `prices.sell:read`' })
  @PriceField('sell')
  sellLocalPaidAmount?: string;
  @ApiPropertyOptional({
    description: 'ยอดตัดหนี้สะสมที่ระบบบัญชีรายงาน — `prices.sell:read`',
  })
  @PriceField('sell')
  sellRemotePaidAmount?: string;
  @ApiPropertyOptional({ description: 'ระบบบัญชี − TMS — `prices.sell:read`' })
  @PriceField('sell')
  sellDifferenceAmount?: string;
  @ApiProperty({
    type: [ReconcileRefMismatchDto],
    nullable: true,
    description:
      'ST8-T11 `code` remote_ref_mismatch: เอกสารฝั่งระบบบัญชีที่เลขที่รู้ชี้ไป แต่เลขอ้างอิงของเราในเอกสารไม่ตรง (ไม่ใช่ของใบนี้) · อื่น ๆ = null',
  })
  refMismatches!: ReconcileRefMismatchDto[] | null;
  @ApiProperty({
    type: ReconcileDocumentDiffDto,
    nullable: true,
    description:
      'ST8-T11 ส่วนต่างของเนื้อหาเอกสาร (`check` DOCUMENT + `code` content_mismatch) · อื่น ๆ = null',
  })
  documentDiff!: ReconcileDocumentDiffDto | null;
  @ApiProperty({ format: 'date-time', description: 'รอบที่พบครั้งแรก' }) runAt!: string;
  @ApiProperty({ format: 'date-time', description: 'รอบล่าสุดที่ยังพบส่วนต่างเดิม' })
  lastSeenAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) resolvedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  acknowledgedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ReconcileResultPageDto {
  @ApiProperty({ type: [ReconcileResultDto] }) data!: ReconcileResultDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class CreateReconcileRunDto {
  @ApiProperty({ example: 'con_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' })
  @IsString()
  @MaxLength(120)
  connectorId!: string;

  @ApiProperty({
    enum: RECONCILE_RUN_CHECKS,
    description:
      'PAYMENT_STATUS = ดึงสถานะรับชำระของใบแจ้งหนี้ที่ยังค้างจากระบบบัญชี · ' +
      'DOCUMENT (ST8-T11) = อ่านใบแจ้งหนี้ที่เลือก (`invoiceIds`) กลับจากระบบบัญชีแล้วเทียบเนื้อหา (source MANUAL — ต้องมี `reason`)',
  })
  @IsIn(RECONCILE_RUN_CHECKS)
  check!: (typeof RECONCILE_RUN_CHECKS)[number];

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_MANUAL_RECONCILE,
    example: ['ivc_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e'],
    description: 'ใบแจ้งหนี้ที่จะเทียบ (บังคับเมื่อ `check` = DOCUMENT · 1–200 ใบ)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MANUAL_RECONCILE)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  invoiceIds?: string[];

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'เหตุผล (≥ 10 ตัวอักษร ลง audit) — บังคับเมื่อ `check` = DOCUMENT',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReconcileRunDto {
  @ApiProperty({
    enum: ['QUEUED', 'ALREADY_QUEUED'],
    description:
      'ALREADY_QUEUED = มีรอบของ connector นี้รอ/กำลังทำอยู่ (ไม่สร้างซ้ำ) · DOCUMENT: QUEUED เมื่อมีอย่างน้อย 1 ใบเข้าคิว',
  })
  status!: 'QUEUED' | 'ALREADY_QUEUED';
  @ApiProperty({ example: 'PAYMENT_STATUS' }) check!: string;
  @ApiProperty({ example: 'con_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' }) connectorId!: string;
  @ApiPropertyOptional({
    type: 'integer',
    description:
      'DOCUMENT: จำนวนใบที่เข้าคิวอ่านเอกสาร (คำสั่ง FETCH_DOCUMENT ผ่านคิวของ connector)',
  })
  queued?: number;
  @ApiPropertyOptional({
    type: [String],
    description:
      'DOCUMENT: ใบที่เทียบไม่ได้เพราะยังไม่อยู่ในระบบบัญชีนี้ (ไม่มีเลขเอกสารฝั่งระบบบัญชี / ยกเลิกแล้ว)',
  })
  notInErp?: string[];
}
