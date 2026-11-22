import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { PAYMENT_MISMATCH_CODES } from './reconcile-results.service';

export const RECONCILE_RESULT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export const RECONCILE_SEVERITIES = ['MONEY', 'FIELD', 'INFO'] as const;
export const RECONCILE_SOURCES = ['AFTER_PUSH', 'NIGHTLY', 'PRE_CLOSE', 'MANUAL'] as const;
export const RECONCILE_OUTCOMES = [
  'MATCH',
  'MISMATCH',
  'REMOTE_MISSING',
  'ERP_UNREACHABLE',
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
    description: 'NIGHTLY = รอบดึงรายวัน · MANUAL = สั่งเอง (`POST /reconcile-runs`)',
  })
  source!: string;
  @ApiProperty({ enum: RECONCILE_RESULT_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String, example: 'PAYMENT_STATUS' }) check!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: PAYMENT_MISMATCH_CODES,
    description:
      '`remote_exceeds_total` ระบบบัญชีตัดหนี้เกินยอดใบ · `remote_paid_amount_short` ระบบบัญชีบอกชำระครบแต่ยอดตัดหนี้น้อยกว่ายอดใบ · ' +
      '`remote_less_than_tms` ระบบบัญชีตัดหนี้น้อยกว่าที่ TMS บันทึกรับ · `tms_has_other_payments` ระบบบัญชีตัดหนี้มากกว่า TMS แต่ใบมีรับชำระที่บันทึกเอง ' +
      '(ไม่บันทึกเพิ่มให้เอง) · `connector_payment_reversed` รายการที่ระบบสร้างจากยอดนี้ถูกกลับรายการใน TMS แล้ว · ' +
      '`remote_wht_inconsistent` ภาษีหัก ณ ที่จ่ายที่รายงานขัดกัน · `payment_rejected` กฎรับชำระของ TMS ไม่รับ (ดู `reason`)',
  })
  code!: string | null;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
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
    enum: ['PAYMENT_STATUS'],
    description: 'PAYMENT_STATUS = ดึงสถานะรับชำระของใบแจ้งหนี้ที่ยังค้างจากระบบบัญชี',
  })
  @IsIn(['PAYMENT_STATUS'])
  check!: 'PAYMENT_STATUS';
}

export class ReconcileRunDto {
  @ApiProperty({
    enum: ['QUEUED', 'ALREADY_QUEUED'],
    description: 'ALREADY_QUEUED = มีรอบของ connector นี้รอ/กำลังทำอยู่ (ไม่สร้างซ้ำ)',
  })
  status!: 'QUEUED' | 'ALREADY_QUEUED';
  @ApiProperty({ example: 'PAYMENT_STATUS' }) check!: string;
  @ApiProperty({ example: 'con_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' }) connectorId!: string;
}
