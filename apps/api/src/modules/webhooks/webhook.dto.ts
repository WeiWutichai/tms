import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { WEBHOOK_EXTRA_HEADERS_MAX, WEBHOOK_EVENT_TYPES } from '@tms/domain';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ListQuery } from '../../common/pagination';
import {
  CleanText,
  IsNullable,
  IsOptionalNotNull,
  MasterOptionalReasonDto,
} from '../master/master-kit';

/**
 * สถานะที่แสดง (ต้นแบบ specApi hooks: ใช้งาน / ล้มเหลวต่อเนื่อง / ปิด)
 * active · failing (ใช้งานแต่ event ล่าสุดล้มเหลวติดกัน ≥ 1) · disabled (ผู้ใช้ปิด) · auto_disabled (ระบบปิด — ล้ม 50 event ติด)
 */
export const WEBHOOK_STATUSES = ['active', 'failing', 'disabled', 'auto_disabled'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

export class WebhookHeaderDto {
  @ApiProperty({ example: 'X-Client-Id', pattern: HEADER_NAME_RE.source })
  @IsString()
  @Matches(HEADER_NAME_RE)
  name!: string;

  @ApiProperty({ example: 'srithai-erp', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @Matches(/^[^\r\n]*$/)
  value!: string;
}

export class WebhookEndpointDto {
  @ApiProperty({ example: 'whe_8f3a…' }) id!: string;
  @ApiProperty({ example: 'https://erp.example.co.th/tms/webhook' }) url!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ type: [String], example: ['order.created', 'trip.dispatched'] })
  events!: string[];
  @ApiProperty({
    type: [String],
    example: ['X-Client-Id'],
    description: 'ชื่อ header เพิ่มเติม (ค่าไม่แสดง — อาจเป็น credential ของผู้รับ)',
  })
  extraHeaderNames!: string[];
  @ApiProperty({ enum: WEBHOOK_STATUSES }) status!: WebhookStatus;
  @ApiProperty({ description: 'event ที่ล้มเหลวขั้นสุดท้ายติดกัน (ครบ 50 → ปิดอัตโนมัติ)' })
  consecutiveFailures!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 99.6,
    description:
      'อัตราส่งสำเร็จ 7 วัน (% ของครั้งที่ส่ง event จริง — ไม่นับ event ทดสอบ) · null = ยังไม่มีการส่ง',
  })
  successRate7d!: number | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastDeliveryAt!:
    string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastSuccessAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'ผู้รับตอบ challenge ของ `webhook.verification` ถูกต้อง (ไม่บังคับ — ไม่บล็อกการส่ง)',
  })
  verifiedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) secretRotatedAt!:
    string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'หลังหมุน secret: ส่ง 2 ลายเซ็น (ใหม่ + เดิม) ถึงเวลานี้',
  })
  previousSecretExpiresAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) disabledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) disabledReason!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้สร้าง (usr_…)' })
  createdBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdByName!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class WebhookEndpointSecretDto extends WebhookEndpointDto {
  @ApiProperty({
    example: 'whsec_Zx81…',
    description: 'signing secret (HMAC-SHA256 ของ `t.rawBody`) — แสดงครั้งเดียว',
  })
  secret!: string;
}

export class WebhookPageDto {
  @ApiProperty({ type: [WebhookEndpointDto] }) data!: WebhookEndpointDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class WebhookSummaryDto {
  @ApiProperty() all!: number;
  @ApiProperty() active!: number;
  @ApiProperty() failing!: number;
  @ApiProperty({ description: 'ปิด (ผู้ใช้ปิด + ระบบปิดอัตโนมัติ)' }) disabled!: number;
  @ApiProperty({
    description: 'จำนวน endpoint ที่แพ็กเกจให้ (null = ไม่จำกัด)',
    nullable: true,
    type: Number,
  })
  limit!: number | null;
}

export class WebhookListQuery extends ListQuery {
  @ApiPropertyOptional({
    description: `สถานะคั่นด้วย , (${WEBHOOK_STATUSES.join(' / ')})`,
  })
  @IsOptional()
  @Matches(new RegExp(`^(${WEBHOOK_STATUSES.join('|')})(,(${WEBHOOK_STATUSES.join('|')}))*$`))
  status?: string;

  @ApiPropertyOptional({ description: 'ค้น URL บางส่วน' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  url?: string;
}

export class CreateWebhookDto {
  @ApiProperty({
    maxLength: 2048,
    example: 'https://erp.example.co.th/tms/webhook',
    description:
      'https:// เท่านั้น (dev/test ยอม http) · ห้าม IP ภายใน/localhost/metadata (กัน SSRF — ตรวจซ้ำทุกครั้งที่ส่ง)',
  })
  @IsString()
  @MaxLength(2048)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  url!: string;

  @ApiProperty({
    type: [String],
    enum: WEBHOOK_EVENT_TYPES,
    minItems: 1,
    description: 'event ที่สมัคร (ชื่อเต็ม — ไม่รับ `*`)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES as unknown as string[], { each: true })
  events!: string[];

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(200)
  description?: string | null;

  @ApiPropertyOptional({
    type: [WebhookHeaderDto],
    description: `header เพิ่มเติม ≤ ${WEBHOOK_EXTRA_HEADERS_MAX} รายการ (ห้ามทับ X-TMS-* / Content-Type) — เก็บเข้ารหัส`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WEBHOOK_EXTRA_HEADERS_MAX)
  @ValidateNested({ each: true })
  @Type(() => WebhookHeaderDto)
  extraHeaders?: WebhookHeaderDto[];
}

export class UpdateWebhookDto {
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptionalNotNull()
  @IsString()
  @MaxLength(2048)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  url?: string;

  @ApiPropertyOptional({ type: [String], enum: WEBHOOK_EVENT_TYPES, minItems: 1 })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES as unknown as string[], { each: true })
  events?: string[];

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(200)
  description?: string | null;

  @ApiPropertyOptional({
    type: [WebhookHeaderDto],
    description: 'แทนที่ header เพิ่มเติมทั้งชุด ([] = ล้าง)',
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(WEBHOOK_EXTRA_HEADERS_MAX)
  @ValidateNested({ each: true })
  @Type(() => WebhookHeaderDto)
  extraHeaders?: WebhookHeaderDto[];
}

/** ปิด / หมุน secret — เหตุผลไม่บังคับ (ต้นแบบทำทันทีไม่มีหน้าต่างเหตุผล; ลง audit เสมอ) */
export class WebhookActionDto extends MasterOptionalReasonDto {}

export class WebhookTestDto {
  @ApiPropertyOptional({
    enum: WEBHOOK_EVENT_TYPES,
    description:
      'event ตัวอย่างใน payload ของ `webhook.test` (ค่าเริ่ม = event แรกที่สมัคร — INT-107)',
  })
  @IsOptional()
  @IsIn(WEBHOOK_EVENT_TYPES as unknown as string[])
  eventType?: string;
}

export class WebhookTestResultDto {
  @ApiProperty({ description: 'ปลายทางตอบ 2xx' }) delivered!: boolean;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'HTTP status (null = ไม่ได้ response)',
  })
  status!: number | null;
  @ApiProperty() durationMs!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['http_status', 'redirect', 'timeout', 'network', 'ssrf_blocked', 'invalid_url'],
  })
  errorCode!: string | null;
  @ApiProperty({ example: 'evt_…', description: 'id ของ envelope ที่ส่ง' }) eventId!: string;
}
