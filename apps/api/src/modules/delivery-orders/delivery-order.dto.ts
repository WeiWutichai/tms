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
import { DO_STATUSES, type DoStatus } from '@tms/domain';
import { ListQuery } from '../../common/pagination';
import { CleanText, IsNullable } from '../master/master-kit';

/** ทศนิยมเป็นสตริง ≤ 3 ตำแหน่ง (numeric(14,3)) — ไม่รับ number กัน float */
const QTY_RE = /^\d{1,11}(\.\d{1,3})?$/;
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

  @ApiPropertyOptional({ example: 'rsn_3f2a…', description: 'เหตุผลมาตรฐานหมวด CANCEL' })
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
  @ApiProperty({ nullable: true, type: String }) qtyActual!: string | null;
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
  @ApiProperty({ nullable: true, type: String }) weightKg!: string | null;
  @ApiProperty({ nullable: true, type: String }) cbm!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'PO ลูกค้า' })
  customerRef!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ใบแม่ที่ถูกแยก' })
  splitFromId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) splitIndex!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'ส่งใหม่ของ DO ใบนี้ (D-23)' })
  redeliveryOfId!: string | null;
  @ApiProperty({ example: 'NONE' }) podStatus!: string;
  @ApiProperty({ type: [DeliveryOrderLineDto] }) lines!: DeliveryOrderLineDto[];
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
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
