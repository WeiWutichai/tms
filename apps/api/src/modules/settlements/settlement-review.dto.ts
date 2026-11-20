import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CleanText } from '../master/master-kit';
import {
  CARRIER_REVIEW_RESPONSES,
  SettlementDto,
  type CarrierReviewResponse,
} from './settlement.dto';

/** อายุลิงก์ให้รถร่วมตรวจ (spec/05 §11.9 "ลิงก์รถร่วมหมดอายุ (7 วัน) → ส่งใหม่ได้") */
export const REVIEW_LINK_TTL_DAYS = 7;
/** รูปประกอบต่อคำตอบ (เท่าต้นแบบ TMS Subcon "+ เพิ่มรูป" ถึง 6) */
export const REVIEW_PHOTOS_MAX = 6;
export const REVIEW_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** 10 MB/ไฟล์ (docs/04 I — เท่า /v1/documents) */
export const REVIEW_FILE_MAX_BYTES = 10 * 1024 * 1024;

// ---------- ฝั่งบริษัท ----------

export class SettlementReviewLinkDto {
  @ApiProperty({ example: 'mlk_…' }) id!: string;
  @ApiProperty({
    description:
      'ลิงก์หน้าตรวจของรถร่วม (`/link/settlement/{token}`) — ส่งทาง LINE/SMS ด้วย POST /v1/messages/send-link หรือคัดลอกไปส่งเอง · แสดงครั้งเดียว (ไม่เก็บ token)',
  })
  url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class SettlementSentDto {
  @ApiProperty({ type: SettlementDto }) settlement!: SettlementDto;
  @ApiProperty({ type: SettlementReviewLinkDto }) link!: SettlementReviewLinkDto;
}

// ---------- ฝั่งรถร่วม (ลิงก์) ----------

export class ReviewLinkLineReviewDto {
  @ApiProperty({ enum: CARRIER_REVIEW_RESPONSES }) response!: CarrierReviewResponse;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ description: 'จำนวนรูปที่แนบ' }) photoCount!: number;
  @ApiProperty({ format: 'date-time' }) respondedAt!: string;
}

export class ReviewLinkLineDto {
  @ApiProperty({ example: 'stln_…' }) id!: string;
  @ApiProperty() lineNo!: number;
  @ApiProperty({
    enum: ['FREIGHT', 'SURCHARGE', 'DEDUCTION'],
    description: 'FREIGHT = ค่าจ้าง · SURCHARGE = ค่าใช้จ่ายหน้างาน · DEDUCTION = รายการหัก',
  })
  lineType!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เลขเที่ยว' }) tripNo!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'วันที่เที่ยวจบ (เวลาไทย)' })
  tripDate!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'จุดรับแรก' }) origin!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'จุดส่งสุดท้าย' })
  destination!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty({ nullable: true, type: String }) deductionType!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เอกสารอ้างอิงของรายการหัก' })
  reference!: string | null;
  @ApiProperty({
    example: '4500.00',
    description: 'ราคาซื้อของรถร่วมรายนี้ (รายการหัก = ติดลบ) — ไม่มีราคาขาย',
  })
  amount!: string;
  @ApiProperty({ nullable: true, type: ReviewLinkLineReviewDto })
  review!: ReviewLinkLineReviewDto | null;
}

export class ReviewLinkViewDto {
  @ApiProperty({ description: 'ชื่อบริษัทขนส่ง (ผู้จ่าย)' }) company!: string;
  @ApiProperty({ description: 'ชื่อรถร่วม (ตามใบ)' }) carrierName!: string;
  @ApiProperty({
    enum: ['SENT_TO_CARRIER', 'APPROVED'],
    description: 'SENT_TO_CARRIER = รอรถร่วมตรวจ (ตอบได้) · APPROVED = อนุมัติแล้ว (ดูอย่างเดียว)',
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เลขใบ (ออกตอนอนุมัติ)' })
  settlementNo!: string | null;
  @ApiProperty({ example: '2026-11-01' }) periodFrom!: string;
  @ApiProperty({ example: '2026-11-15' }) periodTo!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เลขใบแจ้งหนี้ของรถร่วม' })
  carrierInvoiceNo!: string | null;
  @ApiProperty() tripCount!: number;
  @ApiProperty({ example: '13500.00', description: 'ยอดรวม (ก่อนหัก)' }) grossAmount!: string;
  @ApiProperty({ example: '2500.00', description: 'รวมรายการหัก (ค่าบวก)' })
  deductionAmount!: string;
  @ApiProperty({
    example: '11000.00',
    description: 'ยอดสุทธิ = ยอดรวม − รายการหัก (ยังไม่หัก ณ ที่จ่าย — ST6-T08)',
  })
  netAmount!: string;
  @ApiProperty({ description: 'ตอบ (ยอมรับ/โต้แย้ง) ได้อยู่ไหม' }) canRespond!: boolean;
  @ApiProperty({ format: 'date-time', description: 'ลิงก์ใช้ได้ถึง' }) expiresAt!: string;
  @ApiProperty({ type: [ReviewLinkLineDto], description: 'บรรทัดที่ยังใช้ เรียงตามลำดับในใบ' })
  lines!: ReviewLinkLineDto[];
}

export class ReviewLinkFileReserveDto {
  @ApiProperty({ example: 'stln_…', description: 'บรรทัดที่จะแนบรูป' })
  @IsString()
  @Matches(/^stln_[0-9a-f]{32}$/)
  lineId!: string;
  @ApiProperty({ enum: REVIEW_IMAGE_MIME })
  @IsIn(REVIEW_IMAGE_MIME)
  mime!: (typeof REVIEW_IMAGE_MIME)[number];
  @ApiProperty({ example: 182044, description: `ขนาด (byte) ไม่เกิน ${REVIEW_FILE_MAX_BYTES}` })
  @IsInt()
  @Min(1)
  @Max(REVIEW_FILE_MAX_BYTES)
  bytes!: number;
  @ApiPropertyOptional({ example: 'waiting.jpg', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  filename?: string;
}

export class ReviewLinkFileDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty({ description: 'PUT เนื้อไฟล์ไปที่นี่ (หมดอายุ 15 นาที)' }) uploadUrl!: string;
  @ApiProperty({ format: 'date-time' }) urlExpiresAt!: string;
}

export class ReviewLinkRespondDto {
  @ApiProperty({
    enum: CARRIER_REVIEW_RESPONSES,
    description: 'ACCEPTED = ยอมรับ · DISPUTED = โต้แย้ง (ต้องมีเหตุผลหรือรูปอย่างน้อยหนึ่งอย่าง)',
  })
  @IsIn(CARRIER_REVIEW_RESPONSES)
  response!: CarrierReviewResponse;
  @ApiPropertyOptional({
    maxLength: 500,
    nullable: true,
    type: String,
    example: 'ค่ารอไม่ตรง รอ 3 ชม.',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
  @ApiPropertyOptional({
    type: [String],
    maxItems: REVIEW_PHOTOS_MAX,
    description: `รูปประกอบการโต้แย้ง (จองผ่าน \`/files\` ของลิงก์นี้สำหรับบรรทัดนี้) ไม่เกิน ${REVIEW_PHOTOS_MAX} รูป · ยอมรับ = ไม่มีรูป`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(REVIEW_PHOTOS_MAX)
  @IsString({ each: true })
  photoDocumentIds?: string[];
}

export class ReviewLinkRespondResultDto {
  @ApiProperty({ type: ReviewLinkLineDto }) line!: ReviewLinkLineDto;
}
