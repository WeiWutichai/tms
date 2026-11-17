import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { POD_STATUSES, STOP_EVENT_SOURCES } from '@tms/domain';
import { PodFieldDto } from '../pod/pod-checklist.dto';
import { SubmitPodDto } from '../pod/pod.dto';
import { StopEventBaseDto } from '../stops/stop-event.dto';
import { OfferLinkViewDto } from './offer.dto';

/** ST4-T09 เพดานต่อการส่ง POD ผ่านลิงก์รถร่วม (backlog "รูป ≤ 5 ไฟล์/stop" — เว็บ 20/10) */
export const POD_LINK_PHOTOS_MAX = 5;
export const POD_LINK_FILES_MAX = 5;
/** ชนิดไฟล์ที่ลิงก์จองได้ + MIME ต่อชนิด (เหมือน PodService: รูป/ลายเซ็น = รูป · ไฟล์ = PDF/รูป) */
export const POD_LINK_FILE_KINDS = ['POD_PHOTO', 'POD_SIGNATURE', 'POD_FILE'] as const;
export const POD_LINK_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const POD_LINK_FILE_MIME = ['application/pdf', ...POD_LINK_IMAGE_MIME] as const;
/** 10 MB/ไฟล์ (docs/04 I — เท่า /v1/documents) */
export const POD_LINK_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DOC_ID = /^doc_[0-9a-f]{32}$/;

/** ชนิด event ที่ลิงก์รถร่วมส่งได้ (ST4-T08): ถึง / ออก(ไปจุดถัดไป) / ปิดงานจุดรับ / จุดส่ง (+ POD — ST4-T09) */
export const POD_LINK_EVENT_TYPES = ['ARRIVE', 'DEPART', 'COMPLETE'] as const;
export const POD_STOP_STATUSES = ['PENDING', 'ARRIVED', 'COMPLETED', 'FAILED', 'SKIPPED'] as const;

export class PodLinkQueryDto {
  @ApiPropertyOptional({
    example: 'DO-2611-00069',
    maxLength: 40,
    description:
      'เลข DO ที่ค้น (ไม่สนตัวพิมพ์/ช่องว่าง/เลขไทย) — ค้นเฉพาะ DO ในเที่ยวของลิงก์นี้ · ไม่ส่ง = ข้อมูลงานอย่างเดียว',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  doNo?: string;
}

/** จุดของ DO ในเที่ยว (จุดรับ/จุดส่ง) — ชื่อสถานที่เท่านั้น ไม่มีที่อยู่/ผู้ติดต่อ */
export class PodStopDto {
  @ApiProperty({ example: 'stp_3f2a…' }) id!: string;
  @ApiProperty({ enum: ['PICKUP', 'DELIVERY'], description: 'บทบาทของจุดนี้ต่อ DO' })
  role!: string;
  @ApiProperty({ example: 2, description: 'ลำดับจุดในเที่ยว' }) sequence!: number;
  @ApiProperty({ example: 'คลังบางปู' }) siteName!: string;
  @ApiProperty({ enum: POD_STOP_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String, example: 'DELIVERED' }) outcome!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เวลาถึงจุด' }) arrivedAt!:
    string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เวลาออกจากจุด = DEPART ของจุดถัดไป (docs/01 §3.9) — ยังไม่ออก/จุดสุดท้าย = null',
  })
  leftAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'stp_9a1b…',
    description: 'จุดถัดไปในเที่ยว — "ออกจากจุด" = ส่ง DEPART ที่จุดนี้ · จุดสุดท้าย = null',
  })
  nextStopId!: string | null;
  @ApiProperty({
    description:
      'จุดถัดไปยังไม่มี DEPART/ARRIVE/ปิดงานที่มีผล — กด "ออกจากจุด" ได้โดยไม่เกิด event ขัดลำดับ (จุดสุดท้าย = false)',
  })
  nextOpen!: boolean;
}

/** จำนวนครั้งที่ผู้จัดรถ "ไม่ใช้" event ชนิดนี้ของจุดนี้ — หน้าลิงก์ใช้สร้าง clientEventId รอบใหม่ (กดใหม่ได้) */
export class PodRetryDto {
  @ApiProperty({ example: 'stp_3f2a…' }) stopId!: string;
  @ApiProperty({ enum: POD_LINK_EVENT_TYPES }) type!: string;
  @ApiProperty({ example: 1 }) n!: number;
}

/**
 * ส่ง POD ของ DO ผ่านลิงก์ได้หรือไม่ (ST4-T09) — ไม่มีรูป/ลิงก์ไฟล์/PIN/ชื่อผู้บันทึก
 * `mode`: CLOSE = ถึงจุดส่งแล้ว ส่ง POD = ปิดงานจุดส่ง (COMPLETE + POD ในคำขอเดียว) ·
 * SUBMIT = จุดส่งปิดแล้ว (DO ส่งแล้ว) ยังไม่มี POD → ส่ง POD อย่างเดียว · null = ส่งไม่ได้/ส่งแล้ว
 */
export class PodLinkDoPodDto {
  @ApiProperty({ enum: ['CLOSE', 'SUBMIT'], nullable: true, type: String })
  mode!: 'CLOSE' | 'SUBMIT' | null;
  @ApiProperty({ description: 'มีหลักฐานส่งของ DO นี้แล้ว (ส่งผ่านลิงก์หรือผู้จัดรถบันทึก)' })
  sent!: boolean;
  @ApiProperty({ enum: POD_STATUSES }) podStatus!: string;
  @ApiProperty({ example: POD_LINK_PHOTOS_MAX, description: 'รูปได้ไม่เกินต่อการส่ง' })
  photosMax!: number;
  @ApiProperty({
    type: [PodFieldDto],
    description:
      'checklist ชุดส่งสำเร็จของลูกค้า (เฉพาะข้อที่ไม่ปิด) — ขาดข้อบังคับ = ส่งไม่ได้ (422)',
  })
  fields!: PodFieldDto[];
}

/** DO ที่ส่ง POD ผ่านลิงก์นี้แล้ว (ต้นแบบ "ส่งแล้ว · n รูป · รอตรวจ") */
export class PodLinkSentDto {
  @ApiProperty({ example: 'DO-2611-00069' }) doNo!: string;
  @ApiProperty({ example: 2 }) photoCount!: number;
}

export class PodDoDto {
  @ApiProperty({ example: 'DO-2611-00069' }) doNo!: string;
  @ApiProperty({ example: '2026-11-17' }) doDate!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อลูกค้า (ไม่มีที่อยู่)' })
  customerName!: string | null;
  @ApiProperty({ nullable: true, type: PodStopDto }) pickup!: PodStopDto | null;
  @ApiProperty({ nullable: true, type: PodStopDto }) delivery!: PodStopDto | null;
  @ApiProperty({
    type: [PodRetryDto],
    description: 'event ที่ผู้จัดรถ "ไม่ใช้" ต่อ (จุด, ชนิด) — มีเฉพาะ n > 0',
  })
  retries!: PodRetryDto[];
  @ApiProperty({ type: PodLinkDoPodDto, description: 'หลักฐานส่งของ DO นี้ (ST4-T09)' })
  pod!: PodLinkDoPodDto;
}

/**
 * หน้าลิงก์งานของรถร่วม (ST4-T08; docs/01 §5.5 `GET /public/pod/{token}?doNo=`, spec/04 §5 S4/S5)
 * `job` = ใบสั่งงานเดียวกับลิงก์ข้อเสนอ (แท็บ "งาน") · `match` = DO ที่ค้น (เฉพาะในเที่ยวนี้) + จุดรับ/ส่ง
 */
export class PodLinkViewDto {
  @ApiProperty({ type: OfferLinkViewDto }) job!: OfferLinkViewDto;
  @ApiProperty({ example: 'DISPATCHED', description: 'สถานะเที่ยว' }) tripStatus!: string;
  @ApiProperty({
    description: 'กดถึง/ออกได้ (เที่ยวปล่อยรถแล้วและยังไม่จบ — DISPATCHED / IN_PROGRESS)',
  })
  recordable!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'DO-2611-00069',
    description: 'เลข DO แรกของงานนี้ (ข้อความช่วยเมื่อค้นไม่พบ — ต้นแบบ "หรือดู DO-…")',
  })
  doHint!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เลข DO ที่ค้น (ปรับรูปแล้ว)' })
  query!: string | null;
  @ApiProperty({
    nullable: true,
    type: PodDoDto,
    description: 'null = ไม่ได้ค้น หรือไม่พบในงานนี้',
  })
  match!: PodDoDto | null;
  @ApiProperty({ type: [PodLinkSentDto], description: 'DO ที่ส่ง POD ผ่านลิงก์นี้แล้ว (ST4-T09)' })
  sent!: PodLinkSentDto[];
  @ApiProperty({ description: 'เวลาเซิร์ฟเวอร์' }) serverTime!: string;
}

/**
 * หลักฐานส่งผ่านลิงก์ (ST4-T09) — ชื่อช่องเดียวกับ `PUT /v1/delivery-orders/{id}/pod` (เฉพาะส่วนที่ลิงก์ส่งได้)
 * ไฟล์ต้องจองผ่าน `POST /v1/public/pod/{token}/files` ของลิงก์นี้ **สำหรับ DO นี้** และอัปโหลดเสร็จแล้ว (อื่น ๆ = 422 not_found)
 * ต้องครบตาม checklist ของลูกค้า (ขาด → 422 `pod_incomplete` + `missing[]`) · ส่งได้ครั้งเดียวต่อ DO (แก้ = ผู้จัดรถ)
 */
export class PodLinkCaptureDto extends PickType(SubmitPodDto, [
  'signatureDocumentId',
  'note',
  'checks',
  'choices',
  'barcodes',
  'pin',
  'rating',
] as const) {
  @ApiProperty({ example: 'DO-2611-00069', maxLength: 40, description: 'เลข DO ในเที่ยวของลิงก์' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  doNo!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: POD_LINK_PHOTOS_MAX,
    description: `รูป (kind \`POD_PHOTO\`) ไม่เกิน ${POD_LINK_PHOTOS_MAX} ใบ — เกิน → 422`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POD_LINK_PHOTOS_MAX)
  @Matches(DOC_ID, { each: true })
  photoDocumentIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: POD_LINK_FILES_MAX,
    description: `ไฟล์อื่น (kind \`POD_FILE\` PDF/รูป) ไม่เกิน ${POD_LINK_FILES_MAX} ไฟล์`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POD_LINK_FILES_MAX)
  @Matches(DOC_ID, { each: true })
  fileDocumentIds?: string[];
}

/** ผลการส่ง POD ผ่านลิงก์ — ไม่มี PIN/ลิงก์ไฟล์ */
export class PodLinkCaptureResultDto {
  @ApiProperty({ example: 'DO-2611-00069' }) doNo!: string;
  @ApiProperty({ example: 'UNBILLED', description: 'สถานะ DO หลังส่ง' }) doStatus!: string;
  @ApiProperty({ enum: POD_STATUSES }) podStatus!: string;
  @ApiProperty() photoCount!: number;
  @ApiProperty() fileCount!: number;
  @ApiProperty() hasSignature!: boolean;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
  @ApiProperty({ description: 'true = ส่งซ้ำ (หลักฐานชุดเดิมของลิงก์นี้) ไม่สร้างฉบับใหม่' })
  replayed!: boolean;
}

/** จองไฟล์ POD 1 ไฟล์ของ DO ในเที่ยว (ST4-T09) → PUT เนื้อไฟล์ที่ `uploadUrl` (ตรวจขนาด + MIME จริง) */
export class PodLinkFileReserveDto {
  @ApiProperty({ example: 'DO-2611-00069', maxLength: 40 })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  doNo!: string;
  @ApiProperty({
    enum: POD_LINK_FILE_KINDS,
    description: 'POD_PHOTO / POD_SIGNATURE = รูป (JPEG/PNG/WebP) · POD_FILE = PDF หรือรูป',
  })
  @IsIn(POD_LINK_FILE_KINDS)
  kind!: (typeof POD_LINK_FILE_KINDS)[number];
  @ApiProperty({ enum: POD_LINK_FILE_MIME })
  @IsIn(POD_LINK_FILE_MIME)
  mime!: (typeof POD_LINK_FILE_MIME)[number];
  @ApiProperty({ example: 182044, description: `ขนาด (byte) ไม่เกิน ${POD_LINK_FILE_MAX_BYTES}` })
  @IsInt()
  @Min(1)
  @Max(POD_LINK_FILE_MAX_BYTES)
  bytes!: number;
  @ApiPropertyOptional({ example: 'pod-1.jpg', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  filename?: string;
}

export class PodLinkFileDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty({ description: 'PUT เนื้อไฟล์ไปที่นี่ (หมดอายุ 15 นาที)' }) uploadUrl!: string;
  @ApiProperty({ format: 'date-time' }) urlExpiresAt!: string;
}

/**
 * กดถึง/ออกผ่านลิงก์ (docs/01 §5.5 `POST /public/pod/{token}/stops/{id}/events` — body เดียวกับ `/driver/*`)
 * `clientEventId` บังคับทุกครั้ง (ไม่มี outbox แต่ idempotent — refresh แล้วกดซ้ำไม่เกิด event ซ้ำ)
 * · ไม่รับเหตุผล/หมายเหตุ (หน้าลิงก์ไม่มีช่อง) · `source` = LINK ที่ server กำหนด
 */
export class PodLinkEventDto extends PickType(StopEventBaseDto, [
  'clientEventId',
  'occurredAt',
  'lat',
  'lng',
  'accuracyM',
] as const) {
  @ApiProperty({
    enum: POD_LINK_EVENT_TYPES,
    description:
      'ARRIVE ถึงจุด · DEPART ออกเดินทางมุ่งหน้าไปจุดนี้ (ปุ่ม "ออกจากจุด" ส่งที่จุดถัดไป) · COMPLETE ปิดงาน (outcome `DELIVERED` เท่านั้น) — จุดส่งต้องแนบ `pod` (ST4-T09)',
  })
  @IsIn(POD_LINK_EVENT_TYPES)
  type!: (typeof POD_LINK_EVENT_TYPES)[number];

  @ApiPropertyOptional({
    enum: ['DELIVERED'],
    nullable: true,
    type: String,
    description: 'เฉพาะ COMPLETE = DELIVERED (จุดรับ = รับของครบ · จุดส่ง = ส่งครบ)',
  })
  @IsOptional()
  @IsIn(['DELIVERED'])
  outcome?: 'DELIVERED' | null;

  @ApiPropertyOptional({
    type: PodLinkCaptureDto,
    description:
      'ST4-T09 **บังคับเมื่อ COMPLETE จุดส่ง** — หลักฐานของ DO ที่จุดนี้: ปิดงาน + บันทึก POD ในคำขอเดียว (ไม่ครบ checklist → 422 ไม่ปิดงาน) · ส่งซ้ำ clientEventId เดิม = ผลเดิม · จุดอื่นไม่รับ',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PodLinkCaptureDto)
  pod?: PodLinkCaptureDto;
}

/** ผลการกด (สร้างใหม่ 201 · ส่งซ้ำ clientEventId เดิม 200 + event เดิม) */
export class PodLinkEventResultDto {
  @ApiProperty({ example: 'evt_3f2a…' }) id!: string;
  @ApiProperty({ example: 'stp_3f2a…' }) stopId!: string;
  @ApiProperty({ enum: POD_LINK_EVENT_TYPES }) type!: string;
  @ApiProperty({ nullable: true, type: String }) outcome!: string | null;
  @ApiProperty({ format: 'uuid' }) clientEventId!: string;
  @ApiProperty() occurredAt!: string;
  @ApiProperty() receivedAt!: string;
  @ApiProperty({ enum: STOP_EVENT_SOURCES, example: 'LINK' }) source!: string;
  @ApiProperty({ description: 'true = ส่งซ้ำ (คืน event เดิม ไม่สร้างใหม่)' }) replayed!: boolean;
  @ApiProperty({
    enum: [
      'APPLIED',
      'REDUNDANT',
      'CONFLICT',
      'ACCEPTED',
      'IGNORED',
      'LATE',
      'SKEWED',
      'PICKUP_PENDING',
    ],
    description: 'ผลของ event ในลำดับของจุด (ST4-T02)',
  })
  seqStatus!: string;
  @ApiProperty({
    description: 'false = ยังไม่นับ (ธง/ขัดลำดับ/เวลาเพี้ยน/ไม่ใช้) — รอฝ่ายจัดรถตรวจสอบ',
  })
  counted!: boolean;
  @ApiPropertyOptional({
    type: PodLinkCaptureResultDto,
    description: 'ST4-T09 ปิดงานจุดส่งพร้อม POD — ผลการบันทึก POD',
  })
  pod?: PodLinkCaptureResultDto;
}
