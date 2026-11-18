import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject } from 'class-validator';
import { CreateOrderDto, SO_STATUS_VALUES, type SoStatusValue } from './order.dto';

/** จำนวนรายการสูงสุดต่อคำขอ bulk (docs/04 G1 Bulk/async "≤ 200") */
export const ORDERS_BULK_MAX = 200;

/**
 * POST /v1/orders:bulk (ST7-T10) — `items[]` = body เดียวกับ `POST /v1/orders` ทีละรายการ
 * ตรวจรูปแบบของแต่ละรายการแยกกัน (รายการผิดไม่ทำให้ทั้งคำขอ 422) — ทั้งคำขอ 422 เฉพาะ `items` ไม่ใช่ array / ว่าง / เกิน 200
 */
export class BulkOrdersDto {
  @ApiProperty({
    type: [CreateOrderDto],
    minItems: 1,
    maxItems: ORDERS_BULK_MAX,
    description:
      'ใบสั่งขนส่ง 1–200 ใบ (รูปเดียวกับ body ของ `POST /v1/orders`) — ตรวจ/สร้างแยกทีละใบ; ใบที่มี `externalId` ของใบเดิม = อัปเดตใบเดิม (idempotent ต่อใบ)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ORDERS_BULK_MAX)
  @IsObject({ each: true })
  items!: Record<string, unknown>[];
}

/** ผลปฏิเสธของรายการ (รูปเดียวกับ application/problem+json ของคำขอเดี่ยว ไม่มี instance/requestId) */
export class BulkOrderProblemDto {
  @ApiProperty({ example: 'https://docs.tms.example/problems/validation_failed' }) type!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ example: 422 }) status!: number;
  @ApiProperty({ example: 'validation_failed' }) code!: string;
  @ApiPropertyOptional() detail?: string;
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'รายช่อง (422) — path ภายในรายการ เช่น `stops.0.siteId`',
  })
  errors?: { field: string; code: string; message: string }[];
}

export class BulkOrderResultDto {
  @ApiProperty({ example: 0, description: 'ลำดับของรายการใน `items[]` (เริ่ม 0)' }) index!: number;
  @ApiProperty({
    example: 201,
    description:
      'สถานะ HTTP ของรายการ (เท่ากับที่ `POST /v1/orders` จะตอบ): 201 สร้าง · 200 อัปเดตใบเดิมด้วย externalId · 4xx/5xx ไม่ผ่าน',
  })
  status!: number;
  @ApiProperty({ enum: ['CREATED', 'UPDATED', 'FAILED'] }) outcome!:
    'CREATED' | 'UPDATED' | 'FAILED';
  @ApiProperty({ nullable: true, type: String, example: 'ord_3f2a…' }) id!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'SO-6911-0001',
    description: 'ร่าง = null',
  })
  soNo!: string | null;
  @ApiProperty({ nullable: true, enum: SO_STATUS_VALUES, description: 'สถานะใบหลังทำ' })
  orderStatus!: SoStatusValue | null;
  @ApiProperty({ nullable: true, type: String, description: 'externalId ของรายการ (ถ้าส่ง)' })
  externalId!: string | null;
  @ApiProperty({
    type: [String],
    description:
      'เหตุค้างของการรับงาน (รับเข้าเป็น ON_HOLD ยังนับว่าสำเร็จ — เหมือน `POST /v1/orders`)',
  })
  holdCodes!: string[];
  @ApiProperty({ nullable: true, type: BulkOrderProblemDto, description: 'เหตุที่ไม่ผ่าน' })
  problem!: BulkOrderProblemDto | null;
}

export class BulkOrderResultsDto {
  @ApiProperty({ type: [BulkOrderResultDto], description: 'ผลต่อรายการ เรียงตาม `items[]`' })
  results!: BulkOrderResultDto[];
  @ApiProperty({ example: 200 }) total!: number;
  @ApiProperty({ example: 198, description: 'สร้าง/อัปเดตสำเร็จ' }) succeeded!: number;
  @ApiProperty({ example: 2 }) failed!: number;
}

export class BulkJobAcceptedDto {
  @ApiProperty({ example: 'job_3f2a…' }) jobId!: string;
  @ApiProperty({ example: '/v1/jobs/job_3f2a…' }) statusUrl!: string;
}
