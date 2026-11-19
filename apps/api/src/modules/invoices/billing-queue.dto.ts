import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { DeliveryOrderDto } from '../delivery-orders/delivery-order.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DO_ID = /^do_[0-9a-f]{32}$/;

/** ตัวกรองคิวพร้อมวางบิล (ST5-T04; docs/04 F3 "กรองลูกค้า/ช่วงวัน") */
export class BillingQueueQuery extends ListQuery {
  @ApiPropertyOptional({
    example: 'cus_3f2a…',
    description: 'ลูกค้า — id หรือ `ext:{externalId}` (ไม่พบ = รายการว่าง)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerId?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'วันที่ส่งตั้งแต่ (YYYY-MM-DD — วันที่ของใบส่งของ `doDate`)',
  })
  @IsOptional()
  @Matches(DATE_RE)
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-11-15',
    description: 'วันที่ส่งถึง (YYYY-MM-DD — รวมทั้งวัน)',
  })
  @IsOptional()
  @Matches(DATE_RE)
  dateTo?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'กรองตามหลักฐานส่ง (POD): true = ครบ · false = ยังไม่ครบ (มีได้เฉพาะลูกค้าที่ปิด "ไม่มี POD ไม่วางบิล")',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  podComplete?: 'true' | 'false';

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'กรองตามขั้นส่งบัญชี: true = ส่งบัญชีแล้ว (RELEASED) · false = ยังไม่ส่ง',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  released?: 'true' | 'false';
}

export class BillingQueuePodDto {
  @ApiProperty({ enum: ['NONE', 'PARTIAL', 'COMPLETE'], description: 'ผลตรวจหลักฐานฉบับล่าสุด' })
  status!: string;
  @ApiProperty({
    description:
      'หลักฐานผ่านเกณฑ์ลูกค้าแล้ว (DO รอวางบิล — UNBILLED) ฉบับล่าสุดไม่ใช่ PARTIAL **และ** ผ่าน checklist ปัจจุบัน (`checklistOk`)',
  })
  complete!: boolean;
  @ApiProperty({
    description:
      'หลักฐานฉบับล่าสุดผ่าน checklist **ปัจจุบัน** ของลูกค้า (ตรวจเฉพาะแถวในหน้า — แบบเดียวกับตอนส่งบัญชี) · ' +
      'false ขณะ DO ผ่านเกณฑ์แล้ว = checklist เข้มขึ้นภายหลัง → ส่งบัญชีได้ 409 POD_INCOMPLETE จนกว่าจะแก้หลักฐาน · ' +
      'ตัวกรอง `podComplete` และ `customers[]` ใช้สถานะที่เก็บ (ไม่ตรวจซ้ำ)',
  })
  checklistOk!: boolean;
}

/** ใบส่งของในคิวพร้อมวางบิล */
export class BillingQueueRowDto {
  @ApiProperty({ example: 'do_…' }) id!: string;
  @ApiProperty({ example: 'DO-2611-0001' }) doNo!: string;
  @ApiProperty({ example: '2026-11-13', description: 'วันที่ส่ง (วันที่ของใบส่งของ)' })
  doDate!: string;
  @ApiProperty({ enum: ['DELIVERED', 'POD_PENDING', 'UNBILLED'] }) status!: string;
  @ApiProperty({ example: 'ord_…' }) orderId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'SO-2611-0001' }) soNo!: string | null;
  @ApiProperty({ example: 'cus_…' }) customerId!: string;
  @ApiProperty({ example: 'C-0001' }) customerCode!: string;
  @ApiProperty() customerName!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เลข PO ลูกค้า' })
  customerRef!: string | null;
  @ApiProperty({ description: 'ปลายทาง (ชื่อจุดส่ง)' }) destSiteName!: string;
  @ApiProperty({ nullable: true, type: String }) tripNo!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ทะเบียน (snapshot ของเที่ยว)' })
  vehiclePlate!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'รถร่วม (snapshot ของเที่ยว)' })
  carrierName!: string | null;
  @ApiProperty({ description: 'ค่าตั้งของลูกค้า "ไม่มี POD ไม่วางบิล"' })
  requirePodToBill!: boolean;
  @ApiProperty({ type: BillingQueuePodDto }) pod!: BillingQueuePodDto;
  @ApiProperty({
    description:
      'จุดส่งมีเวลาถึงและเวลาออกครบ (docs/04 F4 — เงื่อนไขส่งบัญชี) · false = ส่งบัญชีไม่ได้จนกว่าจะบันทึกเวลาถึง',
  })
  stopTimesComplete!: boolean;
  @ApiProperty({ description: 'จำนวนบรรทัดรายได้ที่ยังใช้ของ DO' }) revenueLineCount!: number;
  @ApiPropertyOptional({
    example: '4980.50',
    description:
      'ยอดรายได้ของ DO (รวมบรรทัดรายได้ที่ยังใช้ ก่อน VAT) — เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellTotal?: string;
  @ApiProperty({ nullable: true, type: String, description: 'เวลาส่งบัญชี (RELEASED)' })
  releasedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อผู้ส่งบัญชี' })
  releasedByName!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ example: '2026-11-19T03:00:00.000Z' }) updatedAt!: string;
}

/** สรุปต่อลูกค้า — นับทุกแถวที่ตรงตัวกรอง (ไม่ขึ้นกับหน้า) */
export class BillingQueueCustomerDto {
  @ApiProperty({ example: 'cus_…' }) customerId!: string;
  @ApiProperty({ example: 'C-0001' }) customerCode!: string;
  @ApiProperty() customerName!: string;
  @ApiProperty() requirePodToBill!: boolean;
  @ApiProperty({ description: 'จำนวน DO ในคิว' }) deliveryOrderCount!: number;
  @ApiProperty({ description: 'จำนวน DO ที่ส่งบัญชีแล้ว' }) releasedCount!: number;
  @ApiPropertyOptional({
    example: '24902.50',
    description: 'ยอดรายได้รวม (ก่อน VAT) — เห็นเมื่อมี `prices.sell:read`',
  })
  @PriceField('sell')
  sellTotal?: string;
}

export class BillingQueuePageDto {
  @ApiProperty({ type: [BillingQueueRowDto] }) data!: BillingQueueRowDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({
    type: [BillingQueueCustomerDto],
    description:
      'สรุปต่อลูกค้าของทุกแถวที่ตรงตัวกรอง (ไม่ขึ้นกับ cursor/limit) — เรียงตามรหัสลูกค้า',
  })
  customers!: BillingQueueCustomerDto[];
}

/** ส่งบัญชี DO เดียว (If-Match = version) */
export class ReleaseDeliveryOrderDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'หมายเหตุ (ไม่บังคับ — ลง audit)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class BulkReleaseItemDto {
  @ApiProperty({ example: 'do_3f2a…' })
  @Matches(DO_ID)
  deliveryOrderId!: string;

  @ApiPropertyOptional({
    example: 3,
    description: '`version` ที่ผู้ใช้เห็น (แทน If-Match ต่อรายการ) — ไม่ตรง → รายการนั้น 412',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  version?: number;
}

/** ส่งบัญชีหลาย DO (ทำทีละรายการแยกกัน — สำเร็จบางรายการได้) */
export class BulkReleaseDeliveryOrdersDto {
  @ApiProperty({ type: [BulkReleaseItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkReleaseItemDto)
  items!: BulkReleaseItemDto[];

  @ApiPropertyOptional({ maxLength: 500, description: 'หมายเหตุ (ไม่บังคับ — ลง audit ทุกรายการ)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** ผลปฏิเสธของรายการ (รูปเดียวกับ application/problem+json ของคำขอเดี่ยว) */
export class BulkReleaseProblemDto {
  @ApiProperty({ example: 'https://docs.tms.example/problems/not_ready_to_bill' }) type!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ example: 409 }) status!: number;
  @ApiProperty({ example: 'not_ready_to_bill' }) code!: string;
  @ApiPropertyOptional() detail?: string;
  @ApiPropertyOptional({
    type: [String],
    description: '409 `not_ready_to_bill` — เหตุที่ยังไม่พร้อม',
  })
  reasons?: string[];
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'รายการหลักฐานที่ขาด (เหตุ POD_INCOMPLETE)',
  })
  missing?: Record<string, unknown>[];
}

export class BulkReleaseResultDto {
  @ApiProperty({ example: 'do_3f2a…' }) deliveryOrderId!: string;
  @ApiProperty({ nullable: true, type: String }) doNo!: string | null;
  @ApiProperty({ example: 200, description: 'สถานะ HTTP ของรายการนี้ (200 = สำเร็จ/ไม่เปลี่ยน)' })
  status!: number;
  @ApiProperty({
    enum: ['RELEASED', 'UNCHANGED', 'FAILED'],
    description: '`UNCHANGED` = ส่งบัญชีแล้วอยู่ก่อน ไม่ได้ทำอะไร',
  })
  outcome!: 'RELEASED' | 'UNCHANGED' | 'FAILED';
  @ApiProperty({ nullable: true, type: DeliveryOrderDto, description: 'DO หลังทำ (สำเร็จ)' })
  deliveryOrder!: DeliveryOrderDto | null;
  @ApiProperty({ nullable: true, type: BulkReleaseProblemDto, description: 'เหตุที่ไม่สำเร็จ' })
  problem!: BulkReleaseProblemDto | null;
}

export class BulkReleaseResultsDto {
  @ApiProperty({ type: [BulkReleaseResultDto], description: 'ผลต่อรายการ เรียงตามคำขอ' })
  results!: BulkReleaseResultDto[];
  @ApiProperty({ example: 3 }) succeeded!: number;
  @ApiProperty({ example: 0 }) unchanged!: number;
  @ApiProperty({ example: 1 }) failed!: number;
}
