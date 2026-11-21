import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PriceField } from '../../common/price-fields';

/** 1–365 (เก็บเป็นข้อความ — ตัวกรองของงานส่งออกเก็บเฉพาะค่า string) */
export const MIN_DAYS_RE = /^(?:[1-9]\d?|[12]\d\d|3[0-5]\d|36[0-5])$/;

export class UnbilledReportQuery {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 365,
    example: 7,
    description:
      'ส่งถึงแล้ว**เกิน**กี่วัน (วันนี้ − วันที่ส่งถึง > ค่านี้ เวลาไทย) — ไม่ส่ง = ค่าตั้งองค์กร `billing.unbilledAlertDays` (ค่าเริ่ม 7)',
  })
  @IsOptional()
  @IsString()
  @Matches(MIN_DAYS_RE, { message: 'minDays must be an integer 1–365' })
  minDays?: string;

  @ApiPropertyOptional({
    example: 'cus_…',
    description: 'ลูกค้ารายเดียว — id หรือ `ext:{externalId}`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน (เรียงวันที่ส่งถึงเก่าสุดก่อน)' })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  cursor?: string;
}

export class UnbilledCustomerRefDto {
  @ApiProperty({ example: 'cus_…' }) id!: string;
  @ApiProperty({ example: 'C-0001' }) code!: string;
  @ApiProperty() legalName!: string;
}

export class UnbilledOrderRefDto {
  @ApiProperty({ example: 'ord_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) soNo!: string | null;
}

export class UnbilledDeliveryOrderDto {
  @ApiProperty({ example: 'do_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String, example: 'DO-2611-0001' }) doNo!: string | null;
  @ApiProperty({ example: '2026-11-03' }) doDate!: string;
  @ApiProperty({
    enum: ['DELIVERED', 'POD_PENDING', 'UNBILLED'],
    description: 'สถานะ DO (ส่งถึงแล้ว — docs/01 §4.3)',
  })
  status!: string;
  @ApiProperty({ example: 'NONE', description: 'สถานะหลักฐานส่ง (NONE / PARTIAL / COMPLETE)' })
  podStatus!: string;
  @ApiProperty({
    enum: ['UNBILLED', 'CREDITED'],
    description: 'ยังไม่อยู่ในใบแจ้งหนี้ที่ active (ST5-T05)',
  })
  billingStatus!: string;
  @ApiProperty({ type: UnbilledCustomerRefDto }) customer!: UnbilledCustomerRefDto;
  @ApiProperty({ type: UnbilledOrderRefDto }) salesOrder!: UnbilledOrderRefDto;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'เวลาที่ระบบบันทึกสถานะส่งถึงครั้งล่าสุด (ประวัติสถานะ event `deliver` — ตัวเดียวกับหน้าต่างย้อนผลส่งถึง ST5-T06) · ไม่มีประวัติ (ข้อมูลเก่า/นำเข้า) = null และนับจากวันที่ DO',
  })
  deliveredAt!: string | null;
  @ApiProperty({ example: '2026-11-03', description: 'วันที่ส่งถึง (เวลาไทย) ที่ใช้นับวัน' })
  deliveredOn!: string;
  @ApiProperty({ example: 19, description: 'วันนี้ − วันที่ส่งถึง (วัน, เวลาไทย)' })
  daysSinceDelivery!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ส่งบัญชีแล้วเมื่อ (RELEASED — ST5-T04)',
  })
  releasedAt!: string | null;
  @ApiPropertyOptional({
    description: 'มูลค่าบรรทัดรายได้ที่ยังใช้ (ACTIVE) ของ DO ก่อน VAT — `prices.sell:read`',
  })
  @PriceField('sell')
  sellAmount?: string;
}

export class UnbilledReportDto {
  @ApiProperty({ example: '2026-11-22', description: 'วันที่คำนวณ (วันนี้ เวลาไทย)' })
  asOf!: string;
  @ApiProperty({ example: 7, description: 'เกณฑ์ที่ใช้ (วัน) — จาก `minDays` หรือค่าตั้งองค์กร' })
  minDays!: number;
  @ApiProperty({
    example: '2026-11-14',
    description: 'DO ที่ส่งถึงวันนี้หรือก่อนหน้านี้ (เวลาไทย) ขึ้นรายงาน = asOf − minDays − 1',
  })
  deliveredOnOrBefore!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'จำนวน DO ทั้งหมดที่ตรงเงื่อนไข — **เฉพาะหน้าแรก** (ไม่มี cursor); หน้าถัดไป = null',
  })
  count!: number | null;
  @ApiPropertyOptional({
    description: 'มูลค่ารวมทุก DO ที่ตรงเงื่อนไข — เฉพาะหน้าแรก · `prices.sell:read`',
  })
  @PriceField('sell')
  sellAmount?: string;
  @ApiProperty({ type: [UnbilledDeliveryOrderDto] }) data!: UnbilledDeliveryOrderDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
