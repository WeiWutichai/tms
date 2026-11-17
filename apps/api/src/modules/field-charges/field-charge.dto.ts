import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength, ValidateBy } from 'class-validator';
import { PriceField } from '../../common/price-fields';
import { CleanText } from '../master/master-kit';

/** ฝั่งของบรรทัด: SELL = เก็บลูกค้า (`do_surcharge`) · BUY = ต้นทุนเที่ยว (`trip_cost`) · BOTH = บันทึกทั้งสองฝั่งพร้อมกัน */
export const FIELD_CHARGE_SIDES = ['SELL', 'BUY', 'BOTH'] as const;
export type FieldChargeSide = (typeof FIELD_CHARGE_SIDES)[number];
export const FIELD_CHARGE_STATUSES = [
  'PENDING_CONFIRM',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
] as const;
export type FieldChargeStatus = (typeof FIELD_CHARGE_STATUSES)[number];

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const QTY = /^\d{1,10}(\.\d{1,3})?$/;

/**
 * บันทึกค่าใช้จ่ายหน้างานของเที่ยว (ST4-T13; docs/04 E2) — ธงภาษี (vat_type, wht_rate) คัดลอกจากรายการบริการ ไม่รับจาก client
 * ราคาขาย (`sellUnitPrice`) ต้องมี `prices.sell:write` · ราคาซื้อ (`buyAmount`) ต้องมี `prices.buy:write` (A3)
 */
export class CreateFieldChargeDto {
  @ApiProperty({
    enum: FIELD_CHARGE_SIDES,
    description:
      'SELL = เก็บเงินลูกค้า (บรรทัดเพิ่มในใบแจ้งหนี้ของ DO) · BUY = ต้นทุนเที่ยว (จ่ายรถร่วม/คนขับ) · BOTH = ทั้งสองฝั่ง ใช้รูปหลักฐานเดียวกัน',
  })
  @IsIn([...FIELD_CHARGE_SIDES])
  side!: FieldChargeSide;

  @ApiProperty({
    example: 'svc_…',
    description:
      'รายการบริการ (ค่าบริการเสริม `isSurcharge` ที่ใช้งานอยู่ ฝั่งตรงกับบรรทัด — ไม่รับหน่วย % ของค่าขนส่ง)',
  })
  @IsString()
  serviceItemId!: string;

  @ApiPropertyOptional({
    example: 'do_…',
    description: 'ใบส่งของในเที่ยวนี้ — บังคับเมื่อ side = SELL/BOTH',
  })
  @IsOptional()
  @IsString()
  deliveryOrderId?: string;

  @ApiPropertyOptional({
    example: '1',
    description: 'จำนวน (ทศนิยม ≤ 3 ตำแหน่ง, > 0) ของฝั่งขาย — ไม่ส่ง = 1',
  })
  @IsOptional()
  @Matches(QTY, { message: 'qty must be a decimal with up to 3 places' })
  qty?: string;

  @ApiPropertyOptional({
    example: '500.00',
    description:
      'ราคาขายต่อหน่วยก่อน VAT (บาท) — บังคับเมื่อ side = SELL/BOTH · ต้องมีสิทธิ์ `prices.sell:write` (เห็นเมื่อมี `prices.sell:read`)',
  })
  @IsOptional()
  @Matches(MONEY, { message: 'sellUnitPrice must be money (2 decimals)' })
  @PriceField('sell')
  sellUnitPrice?: string;

  @ApiPropertyOptional({
    example: '180.00',
    description:
      'ยอดต้นทุนฝั่งซื้อ (บาท ตามใบเสร็จ) — บังคับเมื่อ side = BUY/BOTH · ต้องมีสิทธิ์ `prices.buy:write` หรือ ' +
      '`trips:dispatch` + `prices.buy:read` (ผู้จ่ายงานบันทึกหน้างาน — ยืนยันโดยผู้อื่น) · ตอบกลับเป็น `buyAmount`',
  })
  @IsOptional()
  @Matches(MONEY, { message: 'costAmount must be money (2 decimals)' })
  costAmount?: string;

  @ApiPropertyOptional({
    example: 'doc_…',
    description:
      'รูป/ไฟล์ใบเสร็จ (บังคับ — spec M15) จาก POST /v1/documents (kind RECEIPT, อัปโหลดเสร็จแล้ว, ยังไม่ผูกกับรายการอื่น) · ไม่ส่ง → 422 `evidence_required`',
  })
  @IsOptional()
  @IsString()
  evidenceDocumentId?: string;

  @ApiPropertyOptional({ maxLength: 500, example: 'รอคิวลงสินค้า 3 ชม.' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** ข้อความเหตุผล 10–500 ตัวอักษร — error เดียวต่อช่อง (ไม่ปน minLength/maxLength/isString — QA ST4-T13) */
const IsReason = () =>
  ValidateBy({
    name: 'reason',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && v.length >= 10 && v.length <= 500,
      defaultMessage: () => 'reason must be 10–500 characters',
    },
  });

/** เหตุผลของการยืนยัน/ปฏิเสธ/ยกเลิก (CLAUDE.md: ทุกการยกเลิก/อนุมัติต้องมีเหตุผล) */
export class FieldChargeReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า' })
  @CleanText()
  @IsReason()
  reason!: string;
}

export class FieldChargeEvidenceDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty() mime!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty({ description: 'ลิงก์ดาวน์โหลด (หมดอายุ 5 นาที)' }) downloadUrl!: string;
  @ApiProperty({ format: 'date-time' }) urlExpiresAt!: string;
}

export class FieldChargeDto {
  @ApiProperty({
    example: 'dsc_…',
    description: 'ฝั่งขาย `dsc_…` (do_surcharge) · ฝั่งซื้อ `tco_…`',
  })
  id!: string;
  @ApiProperty({ enum: ['SELL', 'BUY'] }) side!: 'SELL' | 'BUY';
  @ApiProperty({ enum: FIELD_CHARGE_STATUSES }) status!: FieldChargeStatus;
  @ApiProperty({ example: 'trp_…' }) tripId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'do_…' }) deliveryOrderId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'DO-2611-00001' }) doNo!: string | null;
  @ApiProperty({ example: 'svc_…' }) serviceItemId!: string;
  @ApiProperty({ example: 'WAIT', description: 'รหัสรายการ ณ เวลาบันทึก (snapshot)' })
  serviceItemCode!: string;
  @ApiProperty({ example: 'ค่ารอ', description: 'ชื่อรายการ ณ เวลาบันทึก (snapshot)' })
  description!: string;
  @ApiProperty({ nullable: true, type: String, example: 'ชั่วโมง' }) unitLabel!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['VAT_7', 'EXEMPT_TRANSPORT', 'ZERO_RATED'],
    description: 'ชนิด VAT (snapshot จากรายการบริการ)',
  })
  vatType!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '3.00',
    description: 'หัก ณ ที่จ่าย % (snapshot)',
  })
  whtRate!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '1', description: 'จำนวน (ฝั่งขาย)' })
  qty!: string | null;
  @ApiPropertyOptional({
    type: String,
    example: '500.00',
    description: 'ราคาต่อหน่วยฝั่งขาย — เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellUnitPrice?: string;
  @ApiPropertyOptional({
    type: String,
    example: '500.00',
    description:
      'ยอดฝั่งขายก่อน VAT = จำนวน × ราคา (ปัดครึ่งขึ้นเป็นสตางค์) — เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellAmount?: string;
  @ApiPropertyOptional({
    type: String,
    example: '180.00',
    description: 'ยอดต้นทุนฝั่งซื้อ — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyAmount?: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'TOLL',
    description: 'ชนิดต้นทุน (ฝั่งซื้อ: TOLL / OTHER)',
  })
  costType!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'บรรทัดอีกฝั่งที่บันทึกคู่กัน (side = BOTH)',
  })
  pairedId!: string | null;
  @ApiProperty({ nullable: true, type: FieldChargeEvidenceDto })
  evidence!: FieldChargeEvidenceDto | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdByName!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) decidedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) decidedByName!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionReason!: string | null;
  @ApiProperty() version!: number;
}

export class FieldChargeListDto {
  @ApiProperty({ type: [FieldChargeDto] }) data!: FieldChargeDto[];
}
