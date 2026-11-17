import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** สถานะของการส่ง 1 ครั้ง (webhook_delivery) — delivered 2xx · failed รอลองใหม่อัตโนมัติ · exhausted ล้มขั้นสุดท้าย/ไม่ลองใหม่ */
export const DELIVERY_STATUSES = ['delivered', 'failed', 'exhausted'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const ERROR_CODES = [
  'http_status',
  'redirect',
  'timeout',
  'network',
  'ssrf_blocked',
  'invalid_url',
  'invalid_request',
];

/** `GET /v1/webhook-deliveries` — keyset ตามเวลาส่ง (ใหม่สุดก่อน) · docs/01 §5.1 limit/cursor */
export class WebhookDeliveryListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ enum: ['sentAt', '-sentAt'], default: '-sentAt' })
  @IsOptional()
  @IsIn(['sentAt', '-sentAt'])
  sort?: 'sentAt' | '-sentAt';

  @ApiPropertyOptional({
    example: 'evt_8f3a…',
    description: 'id ของ event (`id` ใน envelope / header X-TMS-Event-Id)',
  })
  @IsOptional()
  @Matches(/^evt_[0-9a-f]{32}$/)
  eventId?: string;

  @ApiPropertyOptional({ example: 'whe_8f3a…' })
  @IsOptional()
  @Matches(/^whe_[0-9a-f]{32}$/)
  endpointId?: string;

  @ApiPropertyOptional({
    description: 'คั่นด้วย , เช่น `failed,exhausted`',
    example: 'failed,exhausted',
  })
  @IsOptional()
  @Matches(/^(delivered|failed|exhausted)(,(delivered|failed|exhausted))*$/)
  status?: string;

  @ApiPropertyOptional({ example: 'order.created' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
  eventType?: string;

  @ApiPropertyOptional({
    description: 'true = เฉพาะ event ทดสอบ/ยืนยันปลายทาง · false = เฉพาะ event จริง',
  })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  test?: boolean;

  @ApiPropertyOptional({ format: 'date-time', description: 'ส่งตั้งแต่เวลานี้' })
  @IsOptional()
  @IsISO8601()
  sentFrom?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'ส่งก่อนเวลานี้' })
  @IsOptional()
  @IsISO8601()
  sentTo?: string;
}

export class WebhookDeliveryDto {
  @ApiProperty({ example: 'whd_8f3a…' }) id!: string;
  @ApiProperty({ example: 'whe_8f3a…' }) endpointId!: string;
  @ApiProperty({
    example: 'evt_8f3a…',
    description: 'id ใน envelope — เท่ากันทุกครั้งที่ส่ง event เดิม (ผู้รับกันซ้ำด้วยค่านี้)',
  })
  eventId!: string;
  @ApiProperty({ example: 'order.created' }) eventType!: string;
  @ApiProperty({ description: 'ครั้งที่ส่ง (= header X-TMS-Attempt)' }) attempt!: number;
  @ApiProperty({ description: 'event ทดสอบ / ยืนยันปลายทาง (ส่งซ้ำไม่ได้)' }) test!: boolean;
  @ApiProperty({ enum: DELIVERY_STATUSES }) status!: DeliveryStatus;
  @ApiProperty({ example: 'https://erp.example.co.th/tms/webhook' }) requestUrl!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'HTTP status (null = ไม่ได้ response)',
  })
  responseStatus!: number | null;
  @ApiProperty() durationMs!: number;
  @ApiProperty({ nullable: true, type: String, enum: ERROR_CODES }) errorCode!: string | null;
  @ApiProperty({ format: 'date-time' }) sentAt!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'เวลาลองใหม่อัตโนมัติครั้งถัดไป (status = failed)',
  })
  nextRetryAt!: string | null;
}

export class WebhookDeliveryDetailDto extends WebhookDeliveryDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'header ที่ส่ง — ค่าของ header เพิ่มเติมแสดงเป็น `***` · ลายเซ็นแสดงบางส่วน (ไม่มี secret)',
  })
  requestHeaders!: Record<string, string>;
  @ApiProperty({ description: 'body ที่ส่ง (JSON envelope ตรงตามที่ส่ง)' }) requestBody!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'body ที่ผู้รับตอบ (ตัดที่ 4 KB)',
  })
  responseBody!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'รายละเอียดข้อผิดพลาดการเชื่อมต่อ' })
  errorMessage!: string | null;
}

export class WebhookDeliveryPageDto {
  @ApiProperty({ type: [WebhookDeliveryDto] }) data!: WebhookDeliveryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class RedeliverQuery {
  @ApiPropertyOptional({
    example: 'whe_8f3a…',
    description: 'ส่งเฉพาะ endpoint นี้ · ไม่ระบุ = ทุก endpoint ที่เปิดอยู่และสมัคร event ชนิดนี้',
  })
  @IsOptional()
  @Matches(/^whe_[0-9a-f]{32}$/)
  endpointId?: string;
}

export const RESEND_STATES = ['delivered', 'failed', 'queued', 'skipped'] as const;

export class WebhookResendResultDto {
  @ApiProperty({ example: 'whe_8f3a…' }) endpointId!: string;
  @ApiProperty({ example: 'evt_8f3a…' }) eventId!: string;
  @ApiProperty({
    description: 'ครั้งที่ส่ง (X-TMS-Attempt) — ต่อจากครั้งล่าสุดของ event นี้ที่ endpoint นี้',
  })
  attempt!: number;
  @ApiProperty({
    enum: RESEND_STATES,
    description:
      'delivered = ผู้รับตอบ 2xx · failed = ไม่สำเร็จ (ไม่ลองใหม่อัตโนมัติ) · queued = เข้าคิวแล้ว worker จะส่ง · skipped = endpoint ถูกปิดระหว่างส่ง',
  })
  state!: (typeof RESEND_STATES)[number];
  @ApiProperty({ nullable: true, type: String, example: 'whd_8f3a…' }) deliveryId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) status!: number | null;
  @ApiProperty({ nullable: true, type: Number }) durationMs!: number | null;
  @ApiProperty({ nullable: true, type: String, enum: ERROR_CODES }) errorCode!: string | null;
}

export class WebhookRedeliverResultDto {
  @ApiProperty({ type: [WebhookResendResultDto] }) data!: WebhookResendResultDto[];
}
