import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsOptionalNotNull } from '../master/master-kit';

export const CHANNEL_KEYS = ['line', 'sms'] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];
export const DELIVERY_STATUSES = ['queued', 'sending', 'sent', 'failed'] as const;

/** LINE userId ของ Messaging API (ได้จาก webhook follow/message — ไม่ใช่ LINE ID ที่คนตั้งเอง) */
export const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

export class SendLinkDto {
  @ApiProperty({ enum: CHANNEL_KEYS, description: 'ช่องทาง' })
  @IsIn(CHANNEL_KEYS)
  channel!: ChannelKey;

  @ApiProperty({
    description:
      'URL ลิงก์ที่ระบบออกให้ (เช่น `url` จาก POST /v1/carriers/{id}/upload-links) — ต้องเป็นลิงก์ที่ยังใช้ได้ของบริษัทนี้ ' +
      'ระบบเลือก template + สิทธิ์ตามชนิดลิงก์ (carrier_docs → `master:write`; trip_offer ยังส่งไม่ได้จนถึง ST3-T23) · ' +
      'ผู้รับ = ช่องทางที่บันทึกไว้ของผู้รับเหมาเจ้าของลิงก์ (เบอร์มือถือ / LINE userId) — ระบุผู้รับเองไม่ได้',
  })
  @IsString()
  @MaxLength(1000)
  url!: string;
}

export class MessageDeliveryDto {
  @ApiProperty({ example: 'msg_…' }) id!: string;
  @ApiProperty({ enum: CHANNEL_KEYS }) channel!: ChannelKey;
  @ApiProperty({ example: 'carrier_docs_link' }) template!: string;
  @ApiProperty({ enum: DELIVERY_STATUSES }) status!: string;
  @ApiProperty({ example: '081•••5678', description: 'ผู้รับแบบปิดบัง (ไม่คืนค่าเต็มเสมอ)' })
  recipient!: string;
  @ApiProperty({ nullable: true, type: String, example: 'car_…' }) carrierId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'mlk_…' }) linkId!: string | null;
  @ApiProperty({ nullable: true, type: String }) entityType!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'id แบบ opaque ของ entity' })
  entityId!: string | null;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, type: String, example: 'mock' }) provider!: string | null;
  @ApiProperty({ nullable: true, type: String }) providerMessageId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'สาเหตุที่ส่งไม่สำเร็จ: provider_unavailable · provider_auth_failed · provider_rejected · not_configured · channel_disabled · lease_expired',
  })
  errorCode!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) sentAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) failedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'รอบส่งถัดไป (ยังไม่จบ)',
  })
  nextAttemptAt!: string | null;
}

export class MessageDeliveryListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'ค่า nextCursor จากหน้าก่อน' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ example: 'car_…', description: 'เฉพาะที่ส่งถึงผู้รับเหมารายนี้' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  carrierId?: string;

  @ApiPropertyOptional({ example: 'mlk_…', description: 'เฉพาะลิงก์นี้' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  linkId?: string;

  @ApiPropertyOptional({ enum: CHANNEL_KEYS })
  @IsOptional()
  @IsIn(CHANNEL_KEYS)
  channel?: ChannelKey;

  @ApiPropertyOptional({ enum: DELIVERY_STATUSES })
  @IsOptional()
  @IsIn(DELIVERY_STATUSES)
  status?: string;
}

export class MessageDeliveryPageDto {
  @ApiProperty({ type: [MessageDeliveryDto] }) data!: MessageDeliveryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class ChannelStatusDto {
  @ApiProperty({ enum: CHANNEL_KEYS }) channel!: ChannelKey;
  @ApiProperty({ description: 'ส่งทางช่องนี้ได้ตอนนี้ไหม (false = ซ่อนปุ่มส่ง ใช้คัดลอกลิงก์แทน)' })
  available!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['provider_disabled', 'not_configured', 'channel_disabled'],
    description: 'เหตุที่ใช้ไม่ได้',
  })
  reason!: string | null;
}

export class ChannelStatusListDto {
  @ApiProperty({ type: [ChannelStatusDto] }) data!: ChannelStatusDto[];
}

export class MessagingSettingsDto {
  @ApiProperty({ description: 'เปิดส่งทาง LINE OA' }) lineEnabled!: boolean;
  @ApiProperty({ description: 'ตั้ง channel access token แล้ว' }) lineConfigured!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '•••• a1B2',
    description: '4 ตัวท้ายของ token',
  })
  lineTokenHint!: string | null;
  @ApiProperty({ description: 'เปิดส่ง SMS (บัญชีผู้ให้บริการระดับระบบ)' }) smsEnabled!: boolean;
  @ApiProperty({
    description: 'ผู้ให้บริการ LINE ที่ระบบใช้อยู่',
    example: 'line',
    nullable: true,
    type: String,
  })
  lineProvider!: string | null;
  @ApiProperty({
    description: 'ผู้ให้บริการ SMS ที่ระบบใช้อยู่',
    example: 'http',
    nullable: true,
    type: String,
  })
  smsProvider!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) updatedAt!: string | null;
}

export class UpdateMessagingSettingsDto {
  @ApiPropertyOptional({
    description:
      'channel access token (long-lived) จาก LINE Developers Console — เขียนอย่างเดียว ไม่คืนค่า · null = ลบ (ปิด LINE ด้วย)',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9+/=._-]{20,512}$/, { message: 'lineChannelAccessToken format is invalid' })
  lineChannelAccessToken?: string | null;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  lineEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  smsEnabled?: boolean;
}
