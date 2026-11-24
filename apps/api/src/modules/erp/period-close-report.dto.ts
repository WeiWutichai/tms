import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { PriceField } from '../../common/price-fields';
import { RECONCILE_OUTCOMES, RECONCILE_SEVERITIES } from './reconcile-result.dto';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** ST8-T14 ตัวกรองรายงานปิดงวด (ค่าเป็น string — ใช้ร่วมกับงานส่งออก `POST /v1/exports` resource `reconcile-period-close`) */
export class PeriodCloseReportQuery {
  @ApiProperty({
    example: 'con_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
    description: 'connector ที่ปิดงวด',
  })
  @IsString()
  @MaxLength(120)
  connectorId!: string;

  @ApiProperty({
    example: '2026-11',
    description: 'งวด (YYYY-MM) — สิ้นเดือน = 00:00 น. วันที่ 1 ของเดือนถัดไป เวลาไทย',
  })
  @IsString()
  @Matches(MONTH, { message: 'month must be YYYY-MM' })
  month!: string;
}

export class PeriodCloseConnectorDto {
  @ApiProperty({ example: 'con_…' }) id!: string;
  @ApiProperty({ example: 'krs' }) adapterKey!: string;
  @ApiProperty({ nullable: true, type: String, example: 'KRS' }) displayName!: string | null;
}

export class PeriodCloseSummaryDto {
  @ApiProperty({
    description: 'MISMATCH ค้าง ณ สิ้นเดือน (severity MONEY/FIELD) — เกณฑ์ผ่าน (ก) ต้อง = 0',
  })
  outstanding!: number;
  @ApiProperty({ description: 'ในจำนวนที่ค้าง: severity MONEY' }) outstandingMoney!: number;
  @ApiProperty({ description: 'ในจำนวนที่ค้าง: severity FIELD' }) outstandingField!: number;
  @ApiProperty({
    description:
      'รายการ INFO ที่ยังเปิด ณ สิ้นเดือน (อ่านเอกสารจากระบบบัญชีไม่ได้ / เทียบไม่ได้) — ไม่นับเป็นค้าง แต่แปลว่ามีเอกสารที่ยังไม่ได้ยืนยัน · > 0 = `passed` false',
  })
  unverified!: number;
  @ApiProperty({ description: 'รายการที่ยอมรับความต่าง (ack) ในเดือนนี้' }) acknowledged!: number;
  @ApiProperty({ description: 'เอกสารที่ยังไม่ถูกส่ง (ณ เวลาที่ออกรายงาน) · > 0 = `passed` false' })
  notSent!: number;
  @ApiProperty({ description: 'ในจำนวนที่ยังไม่ส่ง: รอคิว (ระบบส่งเอง)' }) notSentQueued!: number;
  @ApiProperty({ description: 'ในจำนวนที่ยังไม่ส่ง: ล้มเหลว (ต้องมีคนทำ)' }) notSentFailed!: number;
}

export class PeriodCloseMismatchDto {
  @ApiProperty({ example: 'rcr_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String, example: 'ivc_…' }) invoiceId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'INV-2611-0001' })
  localNumber!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'DOCUMENT',
    description: 'PAYMENT_STATUS / DOCUMENT',
  })
  check!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'content_mismatch' }) code!: string | null;
  @ApiProperty({ enum: RECONCILE_OUTCOMES }) result!: string;
  @ApiProperty({ enum: RECONCILE_SEVERITIES }) severity!: string;
  @ApiProperty({ format: 'date-time', description: 'เวลาของรอบตรวจที่พบ (`run_at`)' })
  foundAt!: string;
  @ApiProperty({ format: 'date-time' }) lastSeenAt!: string;
  @ApiProperty({
    enum: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'],
    description: 'สถานะ ณ เวลาที่ออกรายงาน (รายการที่ปิดหลังสิ้นเดือนยังนับเป็นค้างของงวดนี้)',
  })
  currentStatus!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'เวลาที่ปิด/ยอมรับ (หลังสิ้นเดือน) — null = ยังเปิดอยู่',
  })
  closedAt!: string | null;
  @ApiPropertyOptional({
    description:
      'ส่วนต่างยอด (ระบบบัญชี − TMS) — ยอดรับชำระ หรือยอดรวมเอกสาร (`totals.total`) · ไม่มี = ไม่ใช่ส่วนต่างยอด · `prices.sell:read`',
  })
  @PriceField('sell')
  sellDifferenceAmount?: string;
}

export class PeriodCloseAcknowledgedDto extends PeriodCloseMismatchDto {
  @ApiProperty({ format: 'date-time' }) acknowledgedAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้ยอมรับ (id ผู้ใช้ / actor)' })
  acknowledgedBy!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อผู้ยอมรับ' })
  acknowledgedByName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เหตุผลที่ยอมรับความต่าง' })
  ackReason!: string | null;
}

export class PeriodCloseUnsentDto {
  @ApiProperty({
    example: 'obx_…',
    description: 'คำสั่งล่าสุดของเอกสารในคิว (ดูที่ `GET /connectors/{id}/queue`)',
  })
  commandId!: string;
  @ApiProperty({ enum: ['invoice', 'settlement'] }) entityType!: string;
  @ApiProperty({ example: 'ivc_…', description: 'ใบแจ้งหนี้ (`ivc_`) / ใบสำคัญจ่าย (`stl_`)' })
  documentId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'INV-2611-0001' })
  documentNo!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-11-15',
    description: 'วันที่เอกสาร (ออกใบ / จ่าย)',
  })
  documentDate!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ลูกค้า / รถร่วม' })
  counterpartyName!: string | null;
  @ApiProperty({ example: 'PUSH_INVOICE' }) operation!: string;
  @ApiProperty({
    enum: ['queued', 'failed'],
    description: 'แท็บของคิว ST7-T19: queued = รอคิว (ระบบส่งเอง) · failed = ล้มเหลว ต้องมีคนทำ',
  })
  queueTab!: string;
  @ApiProperty({ example: 'FAILED_FINAL' }) status!: string;
  @ApiProperty({ nullable: true, type: String, example: 'PERIOD_CLOSED' }) errorClass!:
    string | null;
  @ApiProperty({ nullable: true, type: String, example: 'erp_mapping_incomplete' })
  errorCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'รอคิว: เวลาที่จะลองครั้งถัดไป',
  })
  nextRunAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiPropertyOptional({ description: 'ยอดรวมใบแจ้งหนี้ — `prices.sell:read`' })
  @PriceField('sell')
  sellTotalAmount?: string;
  @ApiPropertyOptional({ description: 'ยอดสุทธิใบสำคัญจ่าย — `prices.buy:read`' })
  @PriceField('buy')
  buyNetAmount?: string;
}

export class PeriodCloseReportDto {
  @ApiProperty({ type: PeriodCloseConnectorDto }) connector!: PeriodCloseConnectorDto;
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ example: '2026-11-01', format: 'date' }) periodStart!: string;
  @ApiProperty({ example: '2026-11-30', format: 'date' }) periodEnd!: string;
  @ApiProperty({
    format: 'date-time',
    description:
      'เวลาที่ใช้ตัด (สิ้นเดือนเวลาไทย หรือเวลาปัจจุบันถ้าเดือนยังไม่จบ) — ส่วน 1–2 คิด ณ เวลานี้',
  })
  asOf!: string;
  @ApiProperty({ description: 'เดือนจบแล้ว (เวลาปัจจุบัน ≥ สิ้นเดือน)' }) monthEnded!: boolean;
  @ApiProperty({
    description:
      'ผ่านเกณฑ์ (ก) docs/02 §7 ของงวดนี้ — เดือนจบแล้ว และ MISMATCH ค้าง ณ สิ้นเดือน = 0 และเอกสารที่ยังไม่ส่ง (`summary.notSent`) = 0 ' +
      'และยังไม่ได้ยืนยัน (`summary.unverified`) = 0 (PO 24 พ.ย. 2569) — ยังไม่ส่งนับ ณ เวลาที่ออกรายงาน',
  })
  passed!: boolean;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({ type: PeriodCloseSummaryDto }) summary!: PeriodCloseSummaryDto;
  @ApiProperty({
    type: [PeriodCloseMismatchDto],
    description:
      '(1) MISMATCH ค้าง ณ สิ้นเดือน: รอบตรวจพบ (`run_at`) ก่อนสิ้นเดือน และยังไม่ปิด/ยอมรับ ณ สิ้นเดือน (ปิดหลังสิ้นเดือน = ยังนับ) · พบหลังสิ้นเดือน = ไม่นับ',
  })
  outstanding!: PeriodCloseMismatchDto[];
  @ApiProperty({
    type: [PeriodCloseAcknowledgedDto],
    description: '(2) รายการที่ยอมรับความต่างในเดือนนี้ พร้อมผู้ยอมรับและเหตุผล',
  })
  acknowledged!: PeriodCloseAcknowledgedDto[];
  @ApiProperty({
    type: [PeriodCloseUnsentDto],
    description:
      '(3) เอกสารที่ยังไม่ถูกส่ง — วันที่เอกสารไม่เกินสิ้นเดือน และคำสั่งล่าสุดยังอยู่แท็บรอคิว/ล้มเหลวของคิว ST7-T19 **ณ เวลาที่ออกรายงาน**',
  })
  notSent!: PeriodCloseUnsentDto[];
  @ApiProperty({
    description: 'รายการบางส่วนถูกตัดที่เพดาน 5,000 ต่อส่วน (ตัวนับใน `summary` ครบ)',
  })
  truncated!: boolean;
}
