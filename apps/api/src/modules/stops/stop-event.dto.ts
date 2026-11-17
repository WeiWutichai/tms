import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  FAIL_OUTCOMES,
  STOP_EVENT_SOURCES,
  STOP_EVENT_TYPES,
  STOP_OUTCOMES,
  type StopOutcome,
} from '@tms/domain';
import { CleanText, IsNullable } from '../master/master-kit';

/** เวลาต้องมี offset (เวลาเครื่องที่ไม่มีเขตเวลาตีความผิดได้) */
const TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * ช่องร่วมของทุก action (docs/04 E1: `clientEventId`, `occurredAt`, GPS, accuracy) — `receivedAt` = เวลา server,
 * `source` = server กำหนดจากผู้เรียก (ไม่รับจาก body) · ส่ง lat ต้องส่ง lng ด้วย
 */
export class StopEventBaseDto {
  @ApiProperty({
    format: 'uuid',
    example: '6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f',
    description:
      'UUID ที่ client สร้างตอนกดปุ่ม (UUIDv4) — unique ต่อบริษัท: ส่งซ้ำ → 409 `stop_event_duplicate` (ไม่สร้างแถวใหม่)',
  })
  @IsUUID('all')
  clientEventId!: string;

  @ApiProperty({
    example: '2026-11-17T09:42:00+07:00',
    description:
      'เวลาที่เกิดจริงบนเครื่อง (ISO 8601 พร้อม offset) — ใช้เรียงลำดับและเป็นเวลาถึง/ออก · บันทึกย้อนหลังได้',
  })
  @IsISO8601({ strict: true })
  @Matches(TZ_RE, { message: 'occurredAt must include a timezone offset' })
  occurredAt!: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 13.6447,
    description:
      'ละติจูด ณ เวลากด (ส่งคู่กับ lng; เก็บทศนิยม 6 ตำแหน่ง) — null/ไม่ส่ง = ไม่ได้ให้สิทธิ์ตำแหน่ง',
  })
  @IsOptional()
  @IsNullable()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 100.6089 })
  @IsOptional()
  @IsNullable()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 12.5,
    description: 'ความแม่นของพิกัด (เมตร)',
  })
  @IsOptional()
  @IsNullable()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(9_999_999)
  accuracyM?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'rsn_3f2a…',
    description:
      'เหตุผลมาตรฐาน — ถึง/ออก: ล่าช้า (DELAY) หรือกดนอกรัศมี (OVERRIDE) ไม่บังคับ · ส่งไม่สำเร็จ: บังคับ (DELIVERY_FAILED / REJECTED_BY_RECEIVER)',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^rsn_[0-9a-f]{32}$/)
  reasonCodeId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description: 'หมายเหตุ (บังคับเมื่อเหตุผลที่เลือกตั้ง "ต้องมีหมายเหตุ")',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string | null;
}

/** POST /stops/{id}/arrive — ถึงจุด */
export class ArriveStopDto extends StopEventBaseDto {}

/** POST /stops/{id}/depart — ออกเดินทางมุ่งหน้าไปจุดนี้ (docs/01 §3.9) */
export class DepartStopDto extends StopEventBaseDto {}

/** POST /stops/{id}/complete — ปิดงานที่จุด พร้อมผล */
export class CompleteStopDto extends StopEventBaseDto {
  @ApiProperty({
    enum: STOP_OUTCOMES,
    description:
      'DELIVERED = ส่งสำเร็จ · PARTIAL = ส่งบางส่วน · FAILED = ส่งไม่สำเร็จ · UNDELIVERED_RETAIN = ส่งไม่สำเร็จ ของยังอยู่บนรถ (FAILED/UNDELIVERED_RETAIN บังคับเหตุผล)',
  })
  @IsIn(STOP_OUTCOMES)
  outcome!: StopOutcome;
}

/** POST /stops/{id}/fail — ส่งไม่สำเร็จ (เหตุผลบังคับ) */
export class FailStopDto extends StopEventBaseDto {
  @ApiPropertyOptional({
    enum: FAIL_OUTCOMES,
    type: String,
    nullable: true,
    description: 'ไม่ส่ง = ไม่ระบุ · UNDELIVERED_RETAIN = ของยังอยู่บนรถ',
  })
  @IsOptional()
  @IsNullable()
  @IsIn(FAIL_OUTCOMES)
  outcome?: StopOutcome | null;
}

class StopEventReasonDto {
  @ApiProperty({ example: 'rsn_3f2a…' }) id!: string;
  @ApiProperty({ example: 'DELIVERY_FAILED' }) category!: string;
  @ApiProperty({ example: 'CUSTOMER_CLOSED' }) code!: string;
  @ApiProperty({ example: 'ลูกค้าปิดทำการ', description: 'ข้อความ ณ เวลาที่บันทึก (snapshot)' })
  label!: string;
}

export class StopEventDto {
  @ApiProperty({ example: 'evt_3f2a…' }) id!: string;
  @ApiProperty({ example: 'stp_3f2a…' }) stopId!: string;
  @ApiProperty({ example: 'trp_3f2a…' }) tripId!: string;
  @ApiProperty({ enum: STOP_EVENT_TYPES }) type!: string;
  @ApiProperty({ enum: STOP_OUTCOMES, nullable: true, type: String }) outcome!: string | null;
  @ApiProperty({ format: 'uuid' }) clientEventId!: string;
  @ApiProperty({ description: 'เวลาเกิดจริงบนเครื่อง (UTC)' }) occurredAt!: string;
  @ApiProperty({ description: 'เวลาที่ server รับ (UTC)' }) receivedAt!: string;
  @ApiProperty({ nullable: true, type: Number }) lat!: number | null;
  @ApiProperty({ nullable: true, type: Number }) lng!: number | null;
  @ApiProperty({ nullable: true, type: Number }) accuracyM!: number | null;
  @ApiProperty({
    enum: STOP_EVENT_SOURCES,
    description:
      'WEB = ผู้ใช้บันทึกแทนผ่านเว็บ/ผู้ใช้ภายใน · LINK = ลิงก์รถร่วม · API = ระบบภายนอก',
  })
  source!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้บันทึก (user id)' })
  recordedBy!: string | null;
  @ApiProperty({ nullable: true, type: StopEventReasonDto }) reason!: StopEventReasonDto | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
}
