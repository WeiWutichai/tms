import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CleanText, IsNullable, IsOptionalNotNull } from '../master/master-kit';
import {
  VEHICLE_DOC_TYPES,
  type VehicleDocTypeKey,
} from '../vehicle-documents/vehicle-document.dto';

/** ประเภทที่รถร่วมส่งผ่านลิงก์: เอกสารรถ (docs/01 §3.8) + ใบขับขี่ของคนขับ */
export const SUBMISSION_DOC_TYPES = [...VEHICLE_DOC_TYPES, 'DRIVER_LICENCE'] as const;
export type SubmissionDocType = VehicleDocTypeKey | 'DRIVER_LICENCE';
export const SUBMISSION_STATUSES = ['pending_review', 'approved', 'rejected'] as const;
export type SubmissionStatusKey = (typeof SUBMISSION_STATUSES)[number];

/** ไฟล์ที่ลิงก์รับ — ชนิดเดียวกับไฟล์แนบเอกสารรถ (PDF/รูป) */
export const LINK_FILE_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- admin: ลิงก์ ----------

export class CreateUploadLinkDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 30,
    description: 'อายุลิงก์ (วัน) — ไม่ส่ง = 7 วัน',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  ttlDays?: number;
}

export class UploadLinkDto {
  @ApiProperty({ example: 'mlk_…' }) id!: string;
  @ApiProperty({ enum: ['active', 'expired', 'revoked'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastUsedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) revokedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) revokedReason!: string | null;
}

export class IssuedUploadLinkDto extends UploadLinkDto {
  @ApiProperty({
    description:
      'URL หน้าอัปโหลดสำหรับรถร่วม (เปิดบนมือถือได้โดยไม่ login) — แสดงครั้งเดียวตอนสร้าง ระบบไม่ส่งข้อความให้เอง',
  })
  url!: string;
  @ApiProperty({ description: 'token ของลิงก์ (อยู่ใน url แล้ว)' }) token!: string;
}

export class UploadLinkListDto {
  @ApiProperty({ type: [UploadLinkDto] }) data!: UploadLinkDto[];
}

// ---------- รายการที่ส่งมา ----------

export class SubmissionFileDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty() mime!: string;
  @ApiProperty() bytes!: number;
}

class SubjectVehicleDto {
  @ApiProperty() id!: string;
  @ApiProperty() plate!: string;
  @ApiProperty({ nullable: true, type: String }) plateProvince!: string | null;
}
class SubjectDriverDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}
class SubjectCarrierDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() legalName!: string;
}

export class CarrierDocSubmissionDto {
  @ApiProperty({ example: 'cds_…' }) id!: string;
  @ApiProperty({ enum: SUBMISSION_STATUSES }) status!: SubmissionStatusKey;
  @ApiProperty({ type: SubjectCarrierDto }) carrier!: SubjectCarrierDto;
  @ApiProperty({ type: SubjectVehicleDto, nullable: true }) vehicle!: SubjectVehicleDto | null;
  @ApiProperty({ type: SubjectDriverDto, nullable: true }) driver!: SubjectDriverDto | null;
  @ApiProperty({ enum: SUBMISSION_DOC_TYPES }) docType!: SubmissionDocType;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เอกสารรถฉบับที่จะต่ออายุ (OTHER)' })
  targetDocumentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) docNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) issuer!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) startsOn!: string | null;
  @ApiProperty({ format: 'date' }) expiresOn!: string;
  @ApiProperty({ type: [SubmissionFileDto] }) files!: SubmissionFileDto[];
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) reviewedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เหตุผลที่อนุมัติ/ไม่อนุมัติ' })
  reviewReason!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เอกสารรถที่เกิดจากการอนุมัติ (vdoc_…)',
  })
  resultDocumentId!: string | null;
}

export class CarrierDocSubmissionListDto {
  @ApiProperty({ type: [CarrierDocSubmissionDto] }) data!: CarrierDocSubmissionDto[];
}

export class SubmissionListQuery {
  @ApiPropertyOptional({ example: 'car_…' })
  @IsOptional()
  @Matches(/^car_[0-9a-f]{32}$/)
  carrierId?: string;

  @ApiPropertyOptional({ enum: SUBMISSION_STATUSES })
  @IsOptional()
  @IsIn(SUBMISSION_STATUSES)
  status?: SubmissionStatusKey;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, description: 'ไม่ส่ง = 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// ---------- public (ลิงก์) ----------

export class LinkFileReserveDto {
  @ApiProperty({ enum: LINK_FILE_MIME }) @IsIn([...LINK_FILE_MIME]) mime!: string;
  @ApiProperty({ example: 182044, description: 'ขนาดไฟล์ (byte) ไม่เกิน 10 MB' })
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  bytes!: number;
  @ApiPropertyOptional({ example: 'กรมธรรม์.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  filename?: string;
}

export class LinkFileDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty({ description: 'PUT เนื้อไฟล์ไปที่นี่ (หมดอายุ 15 นาที)' }) uploadUrl!: string;
  @ApiProperty({ format: 'date-time' }) urlExpiresAt!: string;
}

export class CreateSubmissionDto {
  @ApiPropertyOptional({
    example: 'veh_…',
    description: 'เอกสารรถ — ส่งอย่างใดอย่างหนึ่งกับ driverId',
  })
  @IsOptional()
  @Matches(/^veh_[0-9a-f]{32}$/)
  vehicleId?: string;

  @ApiPropertyOptional({ example: 'drv_…', description: 'ใบขับขี่ — docType = DRIVER_LICENCE' })
  @IsOptional()
  @Matches(/^drv_[0-9a-f]{32}$/)
  driverId?: string;

  @ApiProperty({ enum: SUBMISSION_DOC_TYPES })
  @IsIn(SUBMISSION_DOC_TYPES)
  docType!: SubmissionDocType;

  @ApiPropertyOptional({ example: 'vdoc_…', description: 'OTHER: ฉบับที่จะต่ออายุ' })
  @IsOptional()
  @Matches(/^vdoc_[0-9a-f]{32}$/)
  targetDocumentId?: string;

  @ApiPropertyOptional({ example: 'POL-27-10431', description: 'เลขที่เอกสาร / เลขใบขับขี่' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  docNo?: string;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'วิริยะประกันภัย' })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(120)
  issuer?: string | null;

  @ApiPropertyOptional({ format: 'date', description: 'วันเริ่มมีผล — บังคับสำหรับเอกสารรถ' })
  @IsOptional()
  @Matches(DATE_RE)
  startsOn?: string;

  @ApiProperty({ format: 'date' })
  @Matches(DATE_RE)
  expiresOn!: string;

  @ApiProperty({
    type: [String],
    description:
      'ไฟล์จาก POST /v1/public/carrier-docs/{token}/files ที่อัปโหลดเสร็จแล้ว (1–5 ไฟล์)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @Matches(/^doc_[0-9a-f]{32}$/, { each: true })
  fileDocumentIds!: string[];

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 500 })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class LinkSubmissionResultDto {
  @ApiProperty({ example: 'cds_…' }) id!: string;
  @ApiProperty({ enum: SUBMISSION_STATUSES }) status!: SubmissionStatusKey;
}

/** รายการ 1 ช่องบนหน้าอัปโหลด (เอกสาร 1 ประเภทของรถ 1 คัน หรือใบขับขี่ของคนขับ 1 คน) */
export class LinkItemDto {
  @ApiProperty({ enum: SUBMISSION_DOC_TYPES }) docType!: SubmissionDocType;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'OTHER: ฉบับที่ต่ออายุ' })
  targetDocumentId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' })
  currentExpiresOn!: string | null;
  @ApiProperty({
    enum: ['missing', 'expired', 'expiring', 'ok', 'pending_review'],
    description:
      'ok/expiring/expired ตามวันหมดฉบับปัจจุบัน (expiring = ≤ 30 วัน) · pending_review = ส่งแล้วรอตรวจ',
  })
  state!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) pendingSince!: string | null;
}

class LinkVehicleDto {
  @ApiProperty() id!: string;
  @ApiProperty() plate!: string;
  @ApiProperty({ nullable: true, type: String }) plateProvince!: string | null;
  @ApiProperty({ type: [LinkItemDto] }) items!: LinkItemDto[];
}
class LinkDriverDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: LinkItemDto }) licence!: LinkItemDto;
}
export class LinkSubmissionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'ทะเบียนรถ หรือชื่อคนขับ' }) subject!: string;
  @ApiProperty({ enum: SUBMISSION_DOC_TYPES }) docType!: SubmissionDocType;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ format: 'date' }) expiresOn!: string;
  @ApiProperty() fileCount!: number;
  @ApiProperty({ enum: SUBMISSION_STATUSES }) status!: SubmissionStatusKey;
  @ApiProperty({ nullable: true, type: String, description: 'เหตุผลที่ไม่อนุมัติ' })
  rejectReason!: string | null;
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
}

export class CarrierDocsLinkViewDto {
  @ApiProperty({ description: 'ชื่อบริษัทขนส่ง (tenant)' }) company!: string;
  @ApiProperty() carrierName!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: [LinkVehicleDto] }) vehicles!: LinkVehicleDto[];
  @ApiProperty({ type: [LinkDriverDto] }) drivers!: LinkDriverDto[];
  @ApiProperty({ type: [LinkSubmissionDto], description: 'ส่งล่าสุด 30 รายการ' })
  submissions!: LinkSubmissionDto[];
}
