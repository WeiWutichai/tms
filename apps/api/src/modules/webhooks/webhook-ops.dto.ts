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
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'body ที่ส่ง (JSON envelope) — field ราคาที่ผู้ดูไม่มีสิทธิ์ `prices.sell:read`/`prices.buy:read` ถูกตัดออก · body ที่ไม่ใช่ JSON ต้องมีทั้งสองสิทธิ์ ไม่งั้น null',
  })
  requestBody!: string | null;
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

/** ST7-T11 `GET /v1/events` (docs/04 G2 #2 `events`; docs/01 §5.2 #2 `GET /events/{id}`) */
export class EventListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิม)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ enum: ['occurredAt', '-occurredAt'], default: '-occurredAt' })
  @IsOptional()
  @IsIn(['occurredAt', '-occurredAt'])
  sort?: 'occurredAt' | '-occurredAt';

  @ApiPropertyOptional({
    example: 'order.created,order.cancelled',
    description: 'ชนิด event คั่นด้วย , (ชื่อใน `GET /v1/webhooks/event-types`)',
  })
  @IsOptional()
  @Matches(/^[a-z_]+\.[a-z_.]+(,[a-z_]+\.[a-z_.]+)*$/)
  type?: string;

  @ApiPropertyOptional({ description: 'เกิดตั้งแต่ (ISO 8601)' })
  @IsOptional()
  @IsISO8601({ strict: true })
  occurredFrom?: string;

  @ApiPropertyOptional({ description: 'เกิดก่อน (ISO 8601)' })
  @IsOptional()
  @IsISO8601({ strict: true })
  occurredTo?: string;
}

export class EventDataDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'ตาม schema `WebhookEvent_*` ของ `type`',
  })
  object!: unknown;
  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description: 'ค่าเดิมของ field ที่เปลี่ยน (ชื่อเดียวกับ `object`)',
  })
  previousAttributes!: unknown;
}

export class EventRequestDto {
  @ApiProperty({ nullable: true, type: String }) id!: string | null;
  @ApiProperty({ nullable: true, type: String }) idempotencyKey!: string | null;
}

/** envelope เดียวกับที่ส่งทาง webhook (components.schemas.WebhookEnvelope — docs/04 G1) */
export class EventDto {
  @ApiProperty({
    example: 'evt_8f3a…',
    description: 'id เดียวกับ envelope / header X-TMS-Event-Id',
  })
  id!: string;
  @ApiProperty({ example: 'order.created' }) type!: string;
  @ApiProperty({ example: '1' }) version!: string;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ example: 'ten_…' }) tenantId!: string;
  @ApiProperty({ enum: ['live', 'test'] }) mode!: string;
  @ApiProperty({ type: EventDataDto }) data!: EventDataDto;
  @ApiProperty({ type: EventRequestDto }) request!: EventRequestDto;
}

export class EventPageDto {
  @ApiProperty({ type: [EventDto] }) data!: EventDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
