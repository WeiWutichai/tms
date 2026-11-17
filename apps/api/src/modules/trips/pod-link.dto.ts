import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { STOP_EVENT_SOURCES } from '@tms/domain';
import { StopEventBaseDto } from '../stops/stop-event.dto';
import { OfferLinkViewDto } from './offer.dto';

/** ชนิด event ที่ลิงก์รถร่วมส่งได้ (ST4-T08): ถึง / ออก(ไปจุดถัดไป) / ปิดงานจุดรับ (ปิดงานจุดส่ง + POD = ST4-T09) */
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
  @ApiProperty({ description: 'เวลาเซิร์ฟเวอร์' }) serverTime!: string;
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
      'ARRIVE ถึงจุด · DEPART ออกเดินทางมุ่งหน้าไปจุดนี้ (ปุ่ม "ออกจากจุด" ส่งที่จุดถัดไป) · COMPLETE ปิดงานจุดรับ (outcome `DELIVERED` เท่านั้น — จุดส่งปิดด้วย POD ST4-T09)',
  })
  @IsIn(POD_LINK_EVENT_TYPES)
  type!: (typeof POD_LINK_EVENT_TYPES)[number];

  @ApiPropertyOptional({
    enum: ['DELIVERED'],
    nullable: true,
    type: String,
    description: 'เฉพาะ COMPLETE ของจุดรับ = DELIVERED (รับของครบ)',
  })
  @IsOptional()
  @IsIn(['DELIVERED'])
  outcome?: 'DELIVERED' | null;
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
}
