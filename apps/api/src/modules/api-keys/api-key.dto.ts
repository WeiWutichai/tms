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
} from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { CleanText, IsNullable, IsOptionalNotNull, MasterReasonDto } from '../master/master-kit';
import { IP_ALLOWLIST_MAX } from './key-material';

export const API_KEY_STATUSES = ['active', 'expiring', 'rotating', 'expired', 'revoked'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];
/** อายุที่เลือกได้ (spec/07 §6 + ต้นแบบ cfKey: 30 / 90 / 365 วัน / ไม่หมดอายุ) — ค่าเริ่ม 90 ตามต้นแบบ */
export const API_KEY_TTL_DAYS = [30, 90, 365] as const;
/** หมุน key: เวลาที่ key เดิมยังใช้ได้ (docs/04 G1 `revokeAt` ≤ 7 วัน) — ค่าเริ่ม 24 ชม. ตามต้นแบบ */
export const ROTATE_GRACE_MAX_HOURS = 7 * 24;

const SCOPE_RE = /^[a-z][a-z.-]*:[a-z*]+$/;

export class ApiKeyDto {
  @ApiProperty({ example: 'key_8f3a…' }) id!: string;
  @ApiProperty({ example: 'ERP sync' }) name!: string;
  @ApiProperty({ enum: ['live', 'test'] }) mode!: 'live' | 'test';
  @ApiProperty({ example: 'tk_live_8f3a', description: 'ส่วนต้นของ key (ไม่ใช่ secret)' })
  prefix!: string;
  @ApiProperty({ type: [String], example: ['orders:read', 'orders:write'] }) scopes!: string[];
  @ApiProperty({ type: [String], example: ['203.150.12.0/24'], description: 'ว่าง = ทุก IP' })
  ipAllowlist!: string[];
  @ApiProperty({
    enum: API_KEY_STATUSES,
    description:
      'active · expiring (หมดอายุภายใน 30 วัน) · rotating (หมุนแล้ว ใช้ได้ถึง revokeAt) · expired · revoked',
  })
  status!: ApiKeyStatus;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastUsedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastUsedIp!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'เวลาที่ key หยุดทำงาน (หมุน = อนาคต ≤ 7 วัน · เพิกถอน = เวลาที่เพิกถอน)',
  })
  revokeAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) revokeReason!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'key ใหม่ที่ออกแทน (หมุนแล้ว)' })
  rotatedToId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'key เดิมที่หมุนมา' })
  rotatedFromId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้สร้าง (usr_…)' })
  createdBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdByName!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

/** ผลการสร้าง/หมุน — `secret` แสดงครั้งเดียว ระบบไม่เก็บ (INT-070) */
export class ApiKeySecretDto extends ApiKeyDto {
  @ApiProperty({ example: 'tk_live_8f3a…', description: 'API key เต็ม — แสดงครั้งเดียว' })
  secret!: string;
  @ApiProperty({
    example: 'key_8f3a…',
    description:
      'client_id สำหรับ POST /oauth/token (grantType=client_credentials) — คู่กับ secret',
  })
  clientId!: string;
}

export class ApiKeyPageDto {
  @ApiProperty({ type: [ApiKeyDto] }) data!: ApiKeyDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class ApiKeySummaryDto {
  @ApiProperty() all!: number;
  @ApiProperty() active!: number;
  @ApiProperty({ description: 'ใช้งานและหมดอายุภายใน 30 วัน (นับรวมใน active ด้วย)' })
  expiring!: number;
  @ApiProperty() rotating!: number;
  @ApiProperty() expired!: number;
  @ApiProperty() revoked!: number;
}

export class ApiKeyListQuery extends ListQuery {
  @ApiPropertyOptional({
    description: `สถานะคั่นด้วย , (${API_KEY_STATUSES.join(' / ')}) — expiring = active ที่หมดอายุใน 30 วัน`,
  })
  @IsOptional()
  @Matches(new RegExp(`^(${API_KEY_STATUSES.join('|')})(,(${API_KEY_STATUSES.join('|')}))*$`))
  status?: string;

  @ApiPropertyOptional({ description: 'ค้นชื่อ key' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ description: 'มี scope นี้' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  scope?: string;
}

export class UpdateApiKeyDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ type: [String], example: ['orders:read'], minItems: 1 })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @Matches(SCOPE_RE, { each: true })
  scopes?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['203.150.12.0/24'],
    description: `IPv4/IPv6 หรือ CIDR สูงสุด ${IP_ALLOWLIST_MAX} รายการ · ว่าง = ทุก IP`,
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(IP_ALLOWLIST_MAX)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  ipAllowlist?: string[];
}

export class CreateApiKeyDto {
  @ApiProperty({ maxLength: 80, example: 'ERP sync' })
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({
    enum: ['live', 'test'],
    default: 'live',
    description: '`test` ต้องมี sandbox (ST7-T09) — ตอนนี้ตอบ 422',
  })
  @IsOptional()
  @IsIn(['live', 'test'])
  mode?: 'live' | 'test';

  @ApiPropertyOptional({
    enum: API_KEY_TTL_DAYS,
    nullable: true,
    default: 90,
    description: 'อายุ key (วัน) — null = ไม่หมดอายุ',
  })
  @IsNullable()
  @Type(() => Number)
  @IsIn(API_KEY_TTL_DAYS as unknown as number[])
  expiresInDays?: number | null;

  @ApiProperty({ type: [String], example: ['orders:read'], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @Matches(SCOPE_RE, { each: true })
  scopes!: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['203.150.12.0/24'],
    description: `IPv4/IPv6 หรือ CIDR สูงสุด ${IP_ALLOWLIST_MAX} รายการ · ว่าง = ทุก IP`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(IP_ALLOWLIST_MAX)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  ipAllowlist?: string[];
}

export class RotateApiKeyDto extends MasterReasonDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: ROTATE_GRACE_MAX_HOURS,
    default: 24,
    description: 'ชั่วโมงที่ key เดิมยังใช้ได้ (0 = หยุดทันที, สูงสุด 168 = 7 วัน)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(ROTATE_GRACE_MAX_HOURS)
  graceHours?: number;
}

export class RevokeApiKeyDto extends MasterReasonDto {}

export class ScopeOptionDto {
  @ApiProperty({ example: 'orders:read' }) scope!: string;
  @ApiProperty({ description: 'ผู้เรียกให้ scope นี้กับ key ได้ไหม (มีสิทธิ์นี้เอง — INT-073)' })
  grantable!: boolean;
}

export class ScopeListDto {
  @ApiProperty({ type: [ScopeOptionDto] }) data!: ScopeOptionDto[];
}
