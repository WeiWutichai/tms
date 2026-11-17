import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
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
  STOP_EVENT_DECISIONS,
  STOP_EVENT_FLAGS,
  STOP_EVENT_LATE_REASONS,
  STOP_EVENT_SOURCES,
  STOP_EXEC_STATES,
  STOP_EVENT_TYPES,
  STOP_OUTCOMES,
  type StopOutcome,
} from '@tms/domain';
import { IsDateTimeWithOffset } from '../../common/validation';
import { CleanText, IsNullable } from '../master/master-kit';

/**
 * ช่องร่วมของทุก action (docs/04 E1: `clientEventId`, `occurredAt`, GPS, accuracy) — `receivedAt` = เวลา server,
 * `source` = server กำหนดจากผู้เรียก (ไม่รับจาก body) · ส่ง lat ต้องส่ง lng ด้วย
 */
export class StopEventBaseDto {
  @ApiProperty({
    format: 'uuid',
    example: '6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f',
    description:
      'UUID ที่ client สร้างตอนกดปุ่ม (UUIDv4) — unique ต่อบริษัท: ส่งซ้ำ (จุด + ชนิดเดิม) → **200 + event เดิม** ไม่สร้างแถวใหม่ · ใช้กับจุด/ชนิดอื่น → 409 `stop_event_duplicate`',
  })
  @IsUUID('all')
  clientEventId!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-17T09:42:00+07:00',
    description:
      'เวลาที่เกิดจริงบนเครื่อง (RFC 3339 `YYYY-MM-DDTHH:MM:SS[.fff]` + `Z`/`±HH:MM` — รับ `±HHMM`) — ใช้เรียงลำดับและเป็นเวลาถึง/ออก · บันทึกย้อนหลังได้',
  })
  @IsISO8601({ strict: true })
  @IsDateTimeWithOffset()
  occurredAt!: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: -90,
    maximum: 90,
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

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: -180,
    maximum: 180,
    example: 100.6089,
  })
  @IsOptional()
  @IsNullable()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 9_999_999,
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
  @ApiProperty({ format: 'date-time', description: 'เวลาเกิดจริงบนเครื่อง (UTC)' })
  occurredAt!: string;
  @ApiProperty({ format: 'date-time', description: 'เวลาที่ server รับ (UTC)' })
  receivedAt!: string;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'ST4-T03: เวลาที่ event ถูกนับในสถานะจุด/เที่ยว/DO (projection) — null = ไม่นับ (ขัดลำดับ/มาหลังปิด/เวลาเพี้ยนที่ยังไม่ตัดสิน, ผู้จัดรถไม่ใช้, หรือเที่ยวจบ/ยกเลิกแล้ว = ประวัติเท่านั้น)',
  })
  appliedAt!: string | null;
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
  @ApiProperty({
    description:
      'ขัด state machine ของจุดเมื่อเรียงตาม occurredAt (เช่น ปิดงานก่อนถึงจุด) — คำนวณใหม่ทุกครั้งที่มี event/การตัดสินใหม่ของจุด',
  })
  sequenceConflict!: boolean;
  @ApiProperty({
    description:
      'occurredAt อนาคตเกิน 5 นาที หรือย้อนหลังเกิน 24 ชม. จาก receivedAt (ธง ไม่แก้เวลา)',
  })
  clockSkew!: boolean;
  @ApiProperty({
    enum: STOP_EVENT_LATE_REASONS,
    nullable: true,
    type: String,
    description:
      'event มาหลังจุดถูกถอด / เที่ยวยกเลิก / เที่ยวจบ — รับเก็บเป็นประวัติ ไม่นับจนกว่าผู้จัดรถยอมรับ',
  })
  lateReason!: string | null;
  @ApiProperty({
    enum: STOP_EVENT_FLAGS,
    isArray: true,
    description: 'ธงที่รอผู้จัดรถตัดสิน (หน้า ศูนย์ข้อยกเว้น) — ว่าง = ปกติ',
  })
  flags!: string[];
}

class StopEventResolutionDto {
  @ApiProperty({
    enum: STOP_EVENT_DECISIONS,
    description: 'ACCEPT = ใช้ event นี้ · IGNORE = ไม่ใช้ (เก็บเป็นประวัติ)',
  })
  decision!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: STOP_EVENT_FLAGS, isArray: true, description: 'ธง ณ เวลาตัดสิน' })
  flags!: string[];
  @ApiProperty({ nullable: true, type: String, description: 'ผู้ตัดสิน (user id)' })
  resolvedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) resolvedAt!: string;
}

/** event ในลำดับที่มีผลของจุด (GET /stops/{id}/events) */
export class SequencedStopEventDto extends StopEventDto {
  @ApiProperty({
    enum: ['APPLIED', 'REDUNDANT', 'CONFLICT', 'ACCEPTED', 'IGNORED', 'LATE', 'SKEWED'],
    description:
      'APPLIED เปลี่ยนสถานะ · REDUNDANT ซ้ำความหมาย · CONFLICT ขัดลำดับ รอตัดสิน · ACCEPTED ผู้จัดรถยอมรับ · IGNORED ผู้จัดรถไม่ใช้ · LATE มาหลังปิด รอตัดสิน · SKEWED เวลาเครื่องเพี้ยน รอตัดสิน',
  })
  seqStatus!: string;
  @ApiProperty({ description: 'นับในลำดับที่มีผล' }) counted!: boolean;
  @ApiProperty({ nullable: true, type: StopEventResolutionDto })
  resolution!: StopEventResolutionDto | null;
}

class StopEffectiveDto {
  @ApiProperty({
    enum: STOP_EXEC_STATES,
    description: 'สถานะจากลำดับ event ที่มีผล (ยังไม่ลง trip_stop — ST4-T03)',
  })
  state!: string;
  @ApiProperty({ enum: STOP_OUTCOMES, nullable: true, type: String }) outcome!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'ออกเดินทางมุ่งหน้าไปจุดนี้ (DEPART แรก)',
  })
  enRouteAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'ถึงจุด (ARRIVE แรก)',
  })
  arrivedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'ปิดงาน (COMPLETE/FAIL ที่มีผล)',
  })
  closedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastEventId!: string | null;
}

export class StopEventSequenceDto {
  @ApiProperty({
    type: [SequencedStopEventDto],
    description: 'เรียง occurredAt → ชนิด → receivedAt',
  })
  data!: SequencedStopEventDto[];
  @ApiProperty({ type: StopEffectiveDto }) effective!: StopEffectiveDto;
}

/** ธงต่อ event (หน้า ศูนย์ข้อยกเว้น) */
export class StopEventFlagDto {
  @ApiProperty({ example: 'evt_3f2a…', description: 'id ของ event ที่มีธง' }) id!: string;
  @ApiProperty({ type: StopEventDto }) event!: StopEventDto;
  @ApiProperty({ enum: STOP_EVENT_FLAGS, isArray: true, description: 'ธงปัจจุบัน' })
  flags!: string[];
  @ApiProperty({
    enum: ['OPEN', 'RESOLVED'],
    description: 'RESOLVED = มีการตัดสินที่ธงตรงกับธงปัจจุบัน',
  })
  status!: string;
  @ApiProperty({ example: 'trp_3f2a…' }) tripId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'TRP-2611-0042' }) tripNo!: string | null;
  @ApiProperty({ example: 'DISPATCHED' }) tripStatus!: string;
  @ApiProperty({ example: 'stp_3f2a…' }) stopId!: string;
  @ApiProperty({ example: 2 }) stopSequence!: number;
  @ApiProperty({ enum: ['PICKUP', 'DELIVERY', 'RETURN'] }) stopType!: string;
  @ApiProperty({ example: 'คลังสินค้าบางนา' }) siteName!: string;
  @ApiProperty({ nullable: true, type: String, example: '70-2281' }) vehiclePlate!: string | null;
  @ApiProperty({ nullable: true, type: String }) customerName!: string | null;
  @ApiProperty({ type: [String], example: ['DO-2611-00022'] }) doNos!: string[];
  @ApiProperty({
    enum: STOP_EXEC_STATES,
    nullable: true,
    type: String,
    description: 'สถานะของจุดตามลำดับที่มีผล ก่อน event นี้ (เฉพาะธงขัดลำดับ)',
  })
  stateBefore!: string | null;
  @ApiProperty({ nullable: true, type: StopEventResolutionDto, description: 'การตัดสินที่มีผล' })
  resolution!: StopEventResolutionDto | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อผู้บันทึก event (ผู้ใช้ภายใน)' })
  recordedByName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อผู้ตัดสิน' })
  resolvedByName!: string | null;
}

export class StopEventFlagPageDto {
  @ApiProperty({ type: [StopEventFlagDto] }) data!: StopEventFlagDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class StopEventFlagSummaryDto {
  @ApiProperty({ description: 'ยังไม่ตัดสิน (ใหม่)' }) open!: number;
  @ApiProperty({ description: 'ตัดสินแล้วทั้งหมด' }) resolved!: number;
  @ApiProperty({ description: 'ตัดสินแล้ววันนี้ (เวลาไทย)' }) resolvedToday!: number;
}

export class StopEventFlagListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 25 })
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

  @ApiPropertyOptional({ enum: ['open', 'resolved', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['open', 'resolved', 'all'])
  status?: 'open' | 'resolved' | 'all';

  @ApiPropertyOptional({ enum: STOP_EVENT_FLAGS })
  @IsOptional()
  @IsIn(STOP_EVENT_FLAGS)
  flag?: (typeof STOP_EVENT_FLAGS)[number];

  @ApiPropertyOptional({
    description: 'true = เฉพาะที่ตัดสินวันนี้ (เวลาไทย) — การ์ด "ปิดแล้ววันนี้"',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  resolvedToday?: 'true' | 'false';

  @ApiPropertyOptional({ description: 'ค้นเลขเที่ยว / ทะเบียนรถ / ชื่อจุด / เลข DO / ชื่อลูกค้า' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ResolveStopEventFlagDto {
  @ApiProperty({
    enum: STOP_EVENT_DECISIONS,
    description:
      'ACCEPT = ใช้ event นี้ (นับในลำดับแม้ขัด/มาหลังปิด) · IGNORE = ไม่ใช้ (เก็บเป็นประวัติ ไม่นับ)',
  })
  @IsIn(STOP_EVENT_DECISIONS)
  decision!: (typeof STOP_EVENT_DECISIONS)[number];

  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    description: 'เหตุผล (บังคับ ≥ 10 ตัวอักษร — ลง audit)',
  })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
