import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  BILLING_STATUSES,
  DO_STATUSES,
  type BillingStage,
  type BillingStatus,
  type DoStatus,
} from '@tms/domain';
import { ListQuery } from '../../common/pagination';
import { CleanText, IsNullable } from '../master/master-kit';

/** ทศนิยมเป็นสตริง ≤ 3 ตำแหน่ง (numeric(14,3)) — ไม่รับ number กัน float */
const QTY_RE = /^\d{1,11}(\.\d{1,3})?$/;
const BILLING_STAGES = [
  'DELIVERED',
  'RELEASED',
  'IN_DRAFT',
  'INVOICED',
  'PARTIALLY_PAID',
  'PAID',
  'CREDITED',
] as const satisfies readonly BillingStage[];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DeliveryOrderListQuery extends ListQuery {
  @ApiPropertyOptional({ example: 'ord_3f2a…', description: 'ใบสั่งขนส่ง (SO)' })
  @IsOptional()
  @Matches(/^ord_[0-9a-f]{32}$/)
  orderId?: string;

  @ApiPropertyOptional({ example: 'cus_3f2a…' })
  @IsOptional()
  @Matches(/^cus_[0-9a-f]{32}$/)
  customerId?: string;

  @ApiPropertyOptional({
    description: `สถานะ คั่นด้วย , (${DO_STATUSES.join(' / ')})`,
    example: 'DRAFT,PLANNED',
  })
  @IsOptional()
  @Matches(new RegExp(`^(${DO_STATUSES.join('|')})(,(${DO_STATUSES.join('|')}))*$`))
  status?: string;

  @ApiPropertyOptional({ example: '2026-11-01', description: 'วันที่ DO ตั้งแต่ (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_RE)
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-11-30', description: 'วันที่ DO ถึง (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_RE)
  dateTo?: string;
}

export class DeliveryOrderLineQtyDto {
  @ApiProperty({ example: 1, description: 'ลำดับบรรทัดสินค้าของ SO' })
  @IsInt()
  @Min(1)
  @Max(10000)
  soLineNo!: number;

  @ApiProperty({ example: '12.5', description: 'ปริมาณ > 0 (สตริงทศนิยม ≤ 3 ตำแหน่ง)' })
  @IsString()
  @Matches(QTY_RE)
  qty!: string;

  @ApiPropertyOptional({ example: 'TON', description: 'ถ้าระบุต้องตรงหน่วยของบรรทัด SO' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;
}

export class CreateDeliveryOrderDto {
  @ApiProperty({ example: 'ord_3f2a…' })
  @Matches(/^ord_[0-9a-f]{32}$/)
  orderId!: string;

  @ApiPropertyOptional({
    example: 2,
    description: 'ลำดับจุดส่งของ SO — บังคับเมื่อ SO มีหลายจุดส่ง (1 DO ต่อ 1 จุดส่ง)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  destStopSeq?: number;

  @ApiPropertyOptional({ example: 1, description: 'ลำดับจุดรับ — ไม่ระบุ = จุดรับแรก' })
  @IsOptional()
  @IsInt()
  @Min(1)
  originStopSeq?: number;

  @ApiPropertyOptional({
    type: [DeliveryOrderLineQtyDto],
    description: 'ไม่ระบุ = ปริมาณคงเหลือทั้งหมดของ SO (ห้ามเกินคงเหลือ)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DeliveryOrderLineQtyDto)
  lines?: DeliveryOrderLineQtyDto[];
}

export class DeliveryOrderSplitPartDto {
  @ApiProperty({ type: [DeliveryOrderLineQtyDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DeliveryOrderLineQtyDto)
  lines!: DeliveryOrderLineQtyDto[];
}

export class SplitDeliveryOrderDto {
  @ApiProperty({
    type: [DeliveryOrderSplitPartDto],
    description: '≥ 2 ส่วน — ปริมาณรวมต่อบรรทัดต้องเท่าใบเดิมพอดี',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DeliveryOrderSplitPartDto)
  parts!: DeliveryOrderSplitPartDto[];
}

export class MergeDeliveryOrdersDto {
  @ApiProperty({
    type: [String],
    example: ['do_3f2a…'],
    description: 'DO ที่จะรวมเข้าใบนี้ (SO + จุดส่งเดียวกัน, DRAFT, ไม่อยู่ในเที่ยว)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @Matches(/^do_[0-9a-f]{32}$/, { each: true })
  deliveryOrderIds!: string[];
}

export class CancelDeliveryOrderDto {
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'ลูกค้าขอยกเลิกการส่งรอบนี้' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'rsn_3f2a…',
    description: 'เหตุผลมาตรฐานหมวด CANCEL',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^rsn_[0-9a-f]{32}$/)
  reasonCodeId?: string | null;
}

/** ST5-T06 ย้อนผลส่งถึง (docs/04 F4 DELIVERED) — If-Match = version */
export class RevertDeliveryDto {
  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'คนขับกดปิดงานผิดจุด ของยังไม่ถึงลูกค้า',
    description: 'เหตุผล (บังคับ ≥ 10 ตัวอักษร — ลง audit + ประวัติสถานะ)',
  })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'rsn_3f2a…',
    description: 'เหตุผลมาตรฐานหมวด DELIVERY_FAILED (ส่งไม่สำเร็จ) — ใช้ต่อกับส่งซ้ำ/คืนคลัง',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^rsn_[0-9a-f]{32}$/)
  reasonCodeId?: string | null;
}

export class DeliveryOrderLineDto {
  @ApiProperty() lineNo!: number;
  @ApiProperty({ description: 'ลำดับบรรทัดของ SO' }) soLineNo!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '12.5' }) qtyPlanned!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ST4-T10 ส่งได้จริง (จากหลักฐานส่งฉบับล่าสุด) — null = ยังไม่บันทึก (ถือว่าตามแผน)',
  })
  qtyActual!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ST4-T10 ผู้รับปฏิเสธ = แผน − ส่งจริง',
  })
  rejectQty!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'rsn_3f2a…',
    description:
      'ST4-T10 เหตุผลปฏิเสธรับ (หมวด REJECTED_BY_RECEIVER) — ข้อความ ณ เวลาบันทึกดูที่ GET …/pod',
  })
  rejectReasonCodeId!: string | null;
  @ApiProperty({
    example: '4',
    description:
      'ST4-T11 ของที่ปฏิเสธรับซึ่งส่งซ้ำแล้ว (ผลรวมบรรทัดของ DO ใหม่ที่ยังไม่ยกเลิก — `rejectedFromId` = ใบนี้)',
  })
  redeliveredQty!: string;
  @ApiProperty({ example: '0', description: 'ST4-T11 ของที่ปฏิเสธรับซึ่งคืนคลังแล้ว' })
  returnedQty!: string;
  @ApiProperty({
    example: '6',
    description: 'ST4-T11 ปฏิเสธรับที่ยังไม่ได้จัดการ (ปฏิเสธ − ส่งซ้ำ − คืนคลัง)',
  })
  openRejectQty!: string;
  @ApiProperty({ example: 'TON' }) unit!: string;
  @ApiProperty({ nullable: true, type: String }) weightKg!: string | null;
  @ApiProperty({ nullable: true, type: String }) cbm!: string | null;
}

export class DeliveryOrderDto {
  @ApiProperty({ example: 'do_3f2a…' }) id!: string;
  @ApiProperty({ example: 'DO-6911-0001' }) doNo!: string;
  @ApiProperty({ enum: DO_STATUSES }) status!: DoStatus;
  @ApiProperty({ example: 'ord_3f2a…' }) orderId!: string;
  @ApiProperty({ example: 'cus_3f2a…' }) customerId!: string;
  @ApiProperty({ example: '2026-11-12' }) doDate!: string;
  @ApiProperty({ example: 'loc_3f2a…' }) originSiteId!: string;
  @ApiProperty({ example: 'loc_3f2a…' }) destSiteId!: string;
  @ApiProperty({ description: 'ลำดับจุดรับของ SO' }) originStopSeq!: number;
  @ApiProperty({ description: 'ลำดับจุดส่งของ SO' }) destStopSeq!: number;
  @ApiProperty({ nullable: true, type: String }) tripId!: string | null;
  @ApiProperty({ description: 'ชื่อลูกค้า (ST9-T01 — แสดงในรายการ)' }) customerName!: string;
  @ApiProperty({ description: 'ชื่อจุดรับ' }) originSiteName!: string;
  @ApiProperty({ description: 'ชื่อจุดส่ง' }) destSiteName!: string;
  @ApiProperty({ nullable: true, type: String, example: 'TRP-6911-0001' }) tripNo!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ทะเบียนรถของเที่ยว (snapshot)' })
  vehiclePlate!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'คนขับของเที่ยว (snapshot)' })
  driverName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'รถร่วมของเที่ยว (snapshot)' })
  carrierName!: string | null;
  @ApiProperty({ nullable: true, type: String }) weightKg!: string | null;
  @ApiProperty({ nullable: true, type: String }) cbm!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'PO ลูกค้า' })
  customerRef!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ใบแม่ที่ถูกแยก' })
  splitFromId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) splitIndex!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'ส่งใหม่ของ DO ใบนี้ (D-23)' })
  redeliveryOfId!: string | null;
  @ApiProperty({
    example: 0,
    description:
      'ST4-T12 ครั้งที่นัดส่งใหม่อัตโนมัติของสายงานนี้ (0 = ใบแรก) — เกินค่าตั้ง `dispatch.maxAutoReschedules` → ใบสั่งค้าง RESCHEDULES_EXHAUSTED',
  })
  rescheduleCount!: number;
  @ApiProperty({
    description:
      'ST4-T11 ส่งซ้ำโดยผู้ใช้ (ไม่ใช่นัดส่งใหม่อัตโนมัติ) — ผลส่งไม่สำเร็จถูกพลิกภายหลังระบบไม่คืนใบเดิมเอง',
  })
  redeliveryManual!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ST4-T11 ใบส่งซ้ำของที่ลูกค้าปฏิเสธรับจาก DO นี้ (ใบเดิมคงส่งแล้ว) — ไม่นับปริมาณจัดสรรของ SO',
  })
  rejectedFromId!: string | null;
  @ApiProperty({ example: 'NONE' }) podStatus!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ST5-T04 เวลาส่งบัญชี (RELEASED — docs/04 F4) · null = ยังไม่ส่ง',
  })
  releasedAt!: string | null;
  @ApiProperty({
    enum: BILLING_STATUSES,
    example: 'UNBILLED',
    description:
      'ST5-T05 สถานะวางบิล (docs/04 F3 — แยกจาก `status`): UNBILLED ยังไม่อยู่ในใบแจ้งหนี้ · IN_DRAFT อยู่ในร่าง · ' +
      'INVOICED ใบออกเลขแล้ว · CREDITED ใบถูกลดหนี้เต็มใบ (วางบิลใหม่ได้) — DO หนึ่งใบอยู่ในใบแจ้งหนี้ที่ active ได้ใบเดียว',
  })
  billingStatus!: BillingStatus;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ST5-T06 เวลาใบแจ้งหนี้ของ DO ออกเลข (INVOICED — docs/04 F4) · null = ยังไม่ออก/ดึงเข้าร่างใหม่หลังลดหนี้',
  })
  invoicedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ST5-T06 เวลารับชำระครบ (PAID — docs/04 F4; บันทึกรับชำระ ST5-T22) · null = ยังไม่ชำระครบ',
  })
  paidAt!: string | null;
  @ApiProperty({
    nullable: true,
    enum: BILLING_STAGES,
    example: 'RELEASED',
    description:
      'ST5-T06 ขั้น lifecycle วางบิล (docs/04 F4 — คำนวณ ไม่เก็บ): DELIVERED ส่งถึง · RELEASED ส่งบัญชีแล้ว · IN_DRAFT อยู่ในร่าง · ' +
      'INVOICED ออกใบแล้ว · PAID ชำระครบ · CREDITED ลดหนี้เต็มใบ · null = ยังไม่ส่งถึง/ส่งไม่สำเร็จ/ยกเลิก',
  })
  billingStage!: BillingStage | null;
  @ApiProperty({ type: [DeliveryOrderLineDto] }) lines!: DeliveryOrderLineDto[];
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** ST9-T01 ตัวนับ DO ของวันนี้ (เวลาไทย) — dashboard ปฏิบัติการ */
export class DeliveryOrderSummaryDto {
  @ApiProperty({ example: '2026-11-18', description: 'วันนี้ตามเวลาไทย (Asia/Bangkok) ที่ใช้นับ' })
  date!: string;
  @ApiProperty({
    description: 'งานวันนี้ = `?dateFrom=date&dateTo=date&status=` ทุกสถานะยกเว้น CANCELLED',
  })
  today!: number;
  @ApiProperty({
    description: 'ส่งแล้ว = `status=DELIVERED,POD_PENDING,UNBILLED,BILLED` ของวัน `date`',
  })
  delivered!: number;
  @ApiProperty({ description: 'ส่งไม่สำเร็จ = `status=FAILED` ของวัน `date`' })
  failed!: number;
}

export class DeliveryOrderPageDto {
  @ApiProperty({ type: [DeliveryOrderDto] }) data!: DeliveryOrderDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class DeliveryOrderSplitResultDto {
  @ApiProperty({ type: [DeliveryOrderDto], description: 'ใบลูกที่สร้างจากการแยก' })
  data!: DeliveryOrderDto[];
}

/** ST4-T11 ปริมาณที่จะส่งซ้ำ/คืนคลังของบรรทัด DO หนึ่งบรรทัด */
export class ReturnLineInputDto {
  @ApiProperty({ example: 1, description: 'ลำดับบรรทัดของ DO (`lines[].lineNo`)' })
  @IsInt()
  @Min(1)
  lineNo!: number;

  @ApiProperty({
    example: '10',
    description: '> 0 และไม่เกินที่ปฏิเสธรับคงเหลือ (`openRejectQty`) — ทศนิยม ≤ 3 ตำแหน่ง',
  })
  @IsString()
  @Matches(QTY_RE)
  qty!: string;
}

/** ST4-T11 ส่งซ้ำ / คืนคลัง (POST …/redeliver, …/return) */
export class ResolveRejectionDto {
  @ApiProperty({
    example: 'rsn_3f2a…',
    description:
      'เหตุผล: DO ส่งแล้ว (ปฏิเสธรับบางส่วน/ทั้งหมด) = หมวด REJECTED_BY_RECEIVER · DO ส่งไม่สำเร็จ = หมวด DELIVERY_FAILED',
  })
  @Matches(/^rsn_[0-9a-f]{32}$/)
  reasonCodeId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description:
      'โน้ต — บังคับเมื่อเหตุผลติ๊ก "บังคับโน้ต"; ชื่อเหตุผล + โน้ต รวม ≥ 10 ตัวอักษร (MD-222)',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @ApiPropertyOptional({
    type: [ReturnLineInputDto],
    description:
      'เฉพาะ DO ส่งแล้ว: บรรทัด + ปริมาณ (ไม่ส่ง = ทุกบรรทัดที่ยังปฏิเสธคงเหลือ ทั้งจำนวน) · DO ส่งไม่สำเร็จ = ทั้งใบเสมอ (ส่งมา → 422)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineInputDto)
  lines?: ReturnLineInputDto[];
}

export class RedeliverDeliveryOrderDto extends ResolveRejectionDto {
  @ApiPropertyOptional({
    example: '2026-11-19',
    description: 'วันส่งของ DO ใหม่ (เวลาไทย) — ไม่ส่ง = วันนี้ · ก่อนวันนี้ → 422',
  })
  @IsOptional()
  @Matches(DATE_RE)
  doDate?: string;
}

export class ReturnDeliveryOrderDto extends ResolveRejectionDto {}

export class RedeliverResultDto {
  @ApiProperty({
    type: DeliveryOrderDto,
    description:
      'ใบเดิม — ส่งแล้ว: คงสถานะ (ยอดส่งซ้ำ/คงเหลือใหม่) · ส่งไม่สำเร็จ: CANCELLED (event redeliver)',
  })
  source!: DeliveryOrderDto;
  @ApiProperty({
    type: DeliveryOrderDto,
    description: 'DO ใหม่ (DRAFT รอจัดรถ) อ้าง `redeliveryOfId`',
  })
  redelivery!: DeliveryOrderDto;
}
