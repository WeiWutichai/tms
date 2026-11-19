import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, ValidateBy } from 'class-validator';
import { PriceField } from '../../common/price-fields';
import { CleanText } from '../master/master-kit';

export const REVENUE_LINE_SOURCE_TYPES = ['SO_CHARGE', 'DO_SURCHARGE', 'MANUAL'] as const;
export type RevenueLineSourceType = (typeof REVENUE_LINE_SOURCE_TYPES)[number];

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const QTY = /^\d{1,10}(\.\d{1,3})?$/;

/** ข้อความเหตุผล 10–500 ตัวอักษร — error เดียวต่อช่อง */
const IsReason = () =>
  ValidateBy({
    name: 'reason',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && v.length >= 10 && v.length <= 500,
      defaultMessage: () => 'reason must be 10–500 characters',
    },
  });

/**
 * เพิ่มบรรทัดรายได้เอง (ST5-T01) — ธงภาษี (vatType, whtRate) คัดลอกจากรายการบริการ ไม่รับจาก client
 * ราคาขาย (`sellUnitPrice`) ต้องมี `prices.sell:write`
 */
export class AddRevenueLineDto {
  @ApiProperty({
    example: 'svc_…',
    description: 'รายการบริการฝั่งขาย (SELL/BOTH) ที่ใช้งานอยู่',
  })
  @IsString()
  serviceItemId!: string;

  @ApiPropertyOptional({
    example: '1',
    description: 'จำนวน (ทศนิยม ≤ 3 ตำแหน่ง, > 0) — ไม่ส่ง = 1',
  })
  @IsOptional()
  @Matches(QTY, { message: 'qty must be a decimal with up to 3 places' })
  qty?: string;

  @ApiProperty({
    example: '500.00',
    description:
      'ราคาต่อหน่วยก่อน VAT (บาท) — ยอด = จำนวน × ราคา ปัดครึ่งขึ้นเป็นสตางค์ · ต้องมีสิทธิ์ `prices.sell:write`',
  })
  @Matches(MONEY, { message: 'sellUnitPrice must be money (2 decimals)' })
  @PriceField('sell')
  sellUnitPrice!: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'ข้อความบนบรรทัด — ไม่ส่ง = ชื่อรายการบริการ',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    example: 'do_…',
    description: 'ผูกกับใบส่งของของใบสั่งนี้ (ไม่ยกเลิก/ยังไม่วางบิล) — ไม่ส่ง = ระดับใบสั่ง',
  })
  @IsOptional()
  @IsString()
  deliveryOrderId?: string;

  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลูกค้าขอให้ช่วยยกของขึ้นชั้น 2' })
  @CleanText()
  @IsReason()
  reason!: string;
}

export class RevenueLineReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'เพิ่มผิดรายการ ลูกค้าไม่ได้ขอบริการนี้' })
  @CleanText()
  @IsReason()
  reason!: string;
}

export class RevenueLineDto {
  @ApiProperty({ example: 'rvl_…' }) id!: string;
  @ApiProperty({ description: 'ลำดับบรรทัดในใบสั่ง (ไม่ใช้ซ้ำ)' }) lineNo!: number;
  @ApiProperty({
    enum: REVENUE_LINE_SOURCE_TYPES,
    description:
      'SO_CHARGE = ราคาของใบสั่ง (rate card / ราคาที่กำหนดเอง) · DO_SURCHARGE = ค่าใช้จ่ายหน้างานที่ยืนยันแล้ว · MANUAL = คนเพิ่มเอง',
  })
  sourceType!: RevenueLineSourceType;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'dsc_…',
    description:
      'แหล่งของบรรทัด: `och_…` (บรรทัดราคาของใบสั่ง) · `dsc_…` (ค่าใช้จ่ายหน้างาน) · MANUAL = null',
  })
  sourceId!: string | null;
  @ApiProperty({ description: 'true = คนเพิ่มเอง (คงไว้เมื่อระบบคิดบรรทัดใหม่)' })
  isUserAdded!: boolean;
  @ApiProperty({ enum: ['FREIGHT', 'EXTRA_STOP', 'ACCESSORIAL'] }) kind!: string;
  @ApiProperty({ nullable: true, type: String, example: 'do_…' }) deliveryOrderId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'DO-2611-00001' }) doNo!: string | null;
  @ApiProperty({ example: 'svc_…' }) serviceItemId!: string;
  @ApiProperty({ example: 'FREIGHT', description: 'รหัสรายการ ณ เวลาคิด (snapshot)' })
  serviceItemCode!: string;
  @ApiProperty({ example: 'ค่าขนส่ง' }) description!: string;
  @ApiProperty({ example: '25', description: 'จำนวน (snapshot)' }) qty!: string;
  @ApiPropertyOptional({
    type: String,
    example: '350.00',
    description: 'ราคาขายต่อหน่วยก่อน VAT — เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellUnitPrice?: string;
  @ApiPropertyOptional({
    type: String,
    example: '8750.00',
    description: 'ยอดขายของบรรทัดก่อน VAT — เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellAmount?: string;
  @ApiProperty({
    enum: ['VAT_7', 'EXEMPT_TRANSPORT', 'ZERO_RATED'],
    description: 'ชนิด VAT ของบรรทัด (snapshot — ไม่คำนวณภาษีที่นี่)',
  })
  vatType!: string;
  @ApiProperty({ example: '1.00', description: 'หัก ณ ที่จ่าย % (snapshot)' }) whtRate!: string;
  @ApiProperty({ enum: ['ACTIVE', 'VOIDED'] }) status!: 'ACTIVE' | 'VOIDED';
  @ApiProperty({ description: 'true = อยู่ในเอกสารที่ออกเลขแล้ว — แก้/ยกเลิก/คิดใหม่ไม่ได้' })
  locked!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lockedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) voidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) voidReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class RevenueLineListDto {
  @ApiProperty({ type: [RevenueLineDto] }) data!: RevenueLineDto[];
}
