import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  type Connector,
  type IntegrationOutbox,
  Prisma,
  type QueueResolutionKind,
} from '@prisma/client';
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
  ValidateNested,
} from 'class-validator';
import { encodeId, tryDecodeId } from '../../common/ids';
import { decodeCursor, encodeCursor } from '../../common/pagination';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { CleanText, lockKey, MasterReasonDto } from '../master/master-kit';
import { commandDto, ConnectorsService } from './connectors.service';
import { ConnectorCommandDto } from './connector.dto';
import {
  ERP_SINK,
  ErpAdapterSink,
  mappingDocumentsOf,
  NOT_NOTIFIED_SKIPS,
} from './erp-adapter.sink';
import {
  MAX_EXTERNAL_DOCUMENTS,
  type CanonicalDocument,
  type ExternalDocumentPart,
} from './erp-adapter';
import { canSeeBodies } from './erp-sync-log';
import { documentDate } from './canonical';
import { MAP_ENTITY, ErpSyncService } from './erp-sync.service';
import { invoiceActors, isPersonActor } from './erp-reissue';

/**
 * ST7-T19 คิวเชื่อมระบบบัญชีที่ลูกค้าดูเอง (docs/01 §6.4 "Error queue UI"; docs/04 G3 "Error queue ลูกค้าดูเอง"; spec/07 §2)
 *
 * แท็บ (docs/04 G3: รอคิว / ล้มเหลว / สำเร็จ — docs/01 §6.4):
 * - `queued`  รอคิว = PENDING / IN_FLIGHT / FAILED_RETRYABLE (ระบบส่งเอง พร้อมเวลาครั้งถัดไป `nextRunAt`)
 * - `failed`  ล้มเหลว = **ต้องมีคนทำ** และยังไม่มีคนจัดการ: FAILED_FINAL ทุก class · SKIPPED ที่แจ้งบัญชี (ไม่อยู่ใน `NOT_NOTIFIED_SKIPS`
 *             เช่น `regenerate_required`, `void_manual_required`) · DONE ที่ `manualExternalIdRequired` (DUPLICATE หาเอกสารไม่เจอ — #85)
 * - `done`    สำเร็จ = DONE / SKIPPED ที่ไม่ต้องมีคนทำ + รายการที่คนจัดการแล้วด้วย "ข้าม" / "กรอกเลขเอง"
 * คำสั่งที่ส่งซ้ำแล้ว (RETRIED) ไม่อยู่ในแท็บใด — คำสั่งใหม่แทนที่ (ดูย้อนได้ด้วย `GET /connectors/{id}/commands?status=`)
 *
 * การจัดการ (แอปแก้ integration_outbox ไม่ได้ — 0090 → บันทึกใน `connector_queue_resolution` 1 แถว/คำสั่ง + audit_log):
 * - ส่งซ้ำ = `ErpSyncService.resend` (canonical ฉบับที่ออก · อยู่ใน ERP แล้ว = REPLACE_DOCUMENT) — ใช้หลังแก้ mapping / ผังรหัส /
 *   เปิดงวดบัญชี · คำสั่งที่ส่งซ้ำไม่ได้ (ต้องทำในระบบบัญชีเอง เช่น `regenerate_required`) → 409 `queue_action_not_allowed`
 * - ข้าม = override → เหตุผล ≥ 10 ตัว + audit `connector.queue_skipped`
 * - กรอกเลขฝั่งระบบบัญชีเอง = override → เหตุผล + audit `connector.queue_external_id` · บันทึก external_mapping สถานะ MISMATCH
 *   `erp_content_unverified` (ทางระมัดระวังแบบ ST7-T15: ยังไม่มีหลักฐานว่าเนื้อหาตรง — รอบ reconcile ยืนยัน; docs/01 §6.4
 *   "ยัง reconcile ได้ถ้าคนกรอก external_mapping มือ")
 */

export const QUEUE_TABS = ['queued', 'failed', 'done'] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
const ERROR_CLASSES = [
  'TRANSIENT',
  'AMBIGUOUS',
  'DUPLICATE',
  'VALIDATION',
  'AUTH',
  'NOT_FOUND',
  'PERIOD_CLOSED',
  'CAPABILITY',
] as const;
const QUEUE_SORT = 'queue.updatedAt';
/** คำสั่งส่งเอกสารที่ส่งซ้ำ/กรอกเลขเองได้ (ErpSyncService.resend รองรับ) */
export const DOCUMENT_PUSH_OPS: ReadonlySet<string> = new Set([
  'PUSH_INVOICE',
  'PUSH_SETTLEMENT',
  'REPLACE_DOCUMENT',
]);
/** ส่งซ้ำแล้วได้ผลเดิมแน่นอน — ต้องทำในระบบบัญชีเอง (ข้ามพร้อมเหตุผลแทน) */
const NOT_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'regenerate_required',
  'replace_not_supported',
  'replace_requires_approval',
  'paid_locked',
  'void_manual_required',
]);

// ---------- คู่มือต่อ error code (docs/04 G3 "คู่มือต่อ error code"; docs/01 §6.4 "คู่มือต่อ class") ----------

interface Guide {
  title: string;
  action: string;
}
const CLASS_GUIDE: Record<string, Guide> = {
  TRANSIENT: {
    title: 'ระบบบัญชีไม่ตอบหรือขัดข้องชั่วคราว',
    action:
      'ระบบลองส่งใหม่อัตโนมัติครบแล้ว ตรวจว่าระบบบัญชีเปิดใช้งานได้ (ทดสอบการเชื่อมต่อในหน้าตั้งค่า) แล้วกดส่งซ้ำ',
  },
  AMBIGUOUS: {
    title: 'ไม่ทราบผลว่าระบบบัญชีได้รับเอกสารหรือไม่',
    action:
      'ตรวจในระบบบัญชีว่ามีเอกสารเลขนี้หรือยัง — มีแล้ว: กรอกเลขเอกสารฝั่งระบบบัญชีเอง · ยังไม่มี: กดส่งซ้ำ (ระบบค้นก่อนส่งเพื่อกันเอกสารซ้ำ)',
  },
  DUPLICATE: {
    title: 'ระบบบัญชีมีเลขอ้างอิงนี้แล้ว แต่หาเอกสารไม่พบ',
    action:
      'ค้นเอกสารเลขนี้ในระบบบัญชี แล้วกรอกเลขเอกสารฝั่งระบบบัญชีเอง เพื่อให้ TMS จับคู่และตรวจยอดได้',
  },
  VALIDATION: {
    title: 'ระบบบัญชีไม่รับข้อมูลของเอกสาร',
    action:
      'แก้ข้อมูลตามรายการช่องที่ผิด (เช่น รหัสลูกค้า/รหัสสินค้าในระบบบัญชี) แล้วกดส่งซ้ำ — ถ้าบันทึกในระบบบัญชีเองแล้ว ให้ข้ามพร้อมเหตุผล',
  },
  AUTH: {
    title: 'ระบบบัญชีไม่ยอมรับ key ที่ตั้งไว้',
    action: 'ผู้ดูแลเปลี่ยน key ในหน้าตั้งค่าการเชื่อมต่อแล้วทดสอบ — คำสั่งที่รออยู่จะส่งต่อเอง',
  },
  NOT_FOUND: {
    title: 'ไม่พบเอกสารนี้ในระบบบัญชีแล้ว (อาจถูกลบ)',
    action:
      'ตรวจกับฝ่ายบัญชีว่าเอกสารถูกลบในระบบบัญชีหรือไม่ — ต้องการส่งใหม่ให้กดส่งซ้ำ · ไม่ต้องการ ให้ข้ามพร้อมเหตุผล',
  },
  PERIOD_CLOSED: {
    title: 'งวดบัญชีของวันที่เอกสารปิดแล้วในระบบบัญชี',
    action:
      'ให้ฝ่ายบัญชีเปิดงวดในระบบบัญชีแล้วกดส่งซ้ำ — ถ้าไม่เปิดงวด ให้บันทึกปรับปรุงในงวดปัจจุบันในระบบบัญชีเอง แล้วข้ามพร้อมเหตุผล',
  },
  CAPABILITY: {
    title: 'ระบบบัญชีไม่รองรับการทำรายการนี้ผ่านการเชื่อมต่อ',
    action: 'ทำรายการนี้ในระบบบัญชีเอง แล้วข้ามพร้อมเหตุผล',
  },
};
const CODE_GUIDE: Record<string, Guide> = {
  erp_mapping_incomplete: {
    title: 'ยังไม่ได้จับคู่รหัสสินค้าในระบบบัญชี',
    action: 'เปิดลิงก์หน้าจับคู่รหัส ใส่รหัสสินค้าให้ครบตามรายการที่ขาด แล้วกดส่งซ้ำ',
  },
  erp_master_code_unknown: {
    title: 'มีค่าที่ไม่อยู่ในผังรหัสของระบบบัญชี',
    action: 'เปิดลิงก์หน้าผังรหัส นำเข้าหรือแก้รหัสตามรายการที่ขาด แล้วกดส่งซ้ำ',
  },
  invalid_payload: {
    title: 'ข้อมูลเอกสารไม่ครบหรือผิดรูป',
    action: 'แจ้งทีม Innovera พร้อมเลขเอกสาร — ไม่ต้องส่งซ้ำจนกว่าจะแก้',
  },
  regenerate_required: {
    title: 'เอกสารเปลี่ยนในส่วนที่ระบบบัญชีแก้อัตโนมัติไม่ได้',
    action: 'ยกเลิกเอกสารเดิมและออกใหม่ในระบบบัญชีเอง แล้วข้ามพร้อมเหตุผล',
  },
  replace_requires_approval: {
    title: 'ต้องมีผู้อนุมัติก่อนแทนที่เอกสารในระบบบัญชี (ลงบัญชีแล้ว หรือใบเก่าเกินกำหนด)',
    action:
      'ผู้อนุมัติ (คนละคนกับผู้ขอ) ตรวจยอดหลังปรับแล้วกดอนุมัติพร้อมเหตุผล ระบบจึงส่ง — ถ้าแก้ในระบบบัญชีเองแล้ว ให้ข้ามพร้อมเหตุผล · ' +
      'ยกเลิกแล้วออกใหม่: ปุ่ม "ลงบัญชีแล้ว" ต้องกดที่ใบเดิมก่อนออกใบใหม่แทน (หลังแทนที่ ธงย้ายตามไปใบใหม่)',
  },
  replace_not_supported: {
    title: 'ระบบบัญชีแก้เอกสารผ่านการเชื่อมต่อไม่ได้',
    action: 'แก้เอกสารในระบบบัญชีเอง แล้วข้ามพร้อมเหตุผล',
  },
  paid_locked: {
    title: 'เอกสารรับชำระแล้ว ไม่ส่งการแก้ไข',
    action: 'ตรวจกับฝ่ายบัญชีว่าต้องปรับปรุงในระบบบัญชีหรือไม่ แล้วข้ามพร้อมเหตุผล',
  },
  void_manual_required: {
    title: 'ต้องยกเลิกเอกสารในระบบบัญชีเอง',
    action: 'ยกเลิกเอกสารเลขนี้ในระบบบัญชี แล้วข้ามพร้อมเหตุผล',
  },
  duplicate_unresolved: CLASS_GUIDE.DUPLICATE!,
  manual_external_id_rejected: {
    title: 'เลขเอกสารที่กรอกไว้ยืนยันกับระบบบัญชีไม่ผ่าน',
    action:
      'เลขที่กรอกไม่พบในระบบบัญชี หรือเป็นเอกสารของใบอื่น/สลับใบกัน — ตรวจเลขของแต่ละใบในระบบบัญชีแล้วกรอกใหม่',
  },
};

/** คู่มือของคำสั่ง (รหัสเฉพาะก่อน แล้วตาม ErrorClass) — null = ไม่มีปัญหาที่ต้องอธิบาย */
export function queueGuide(errorClass: string | null, code: string | null): QueueGuideDto | null {
  const key =
    code && CODE_GUIDE[code] ? code : errorClass && CLASS_GUIDE[errorClass] ? errorClass : null;
  if (!key) return null;
  const g = (CODE_GUIDE[key] ?? CLASS_GUIDE[key])!;
  return { key, title: g.title, action: g.action };
}

// ---------- DTO ----------

export class ConnectorQueueQuery {
  @ApiPropertyOptional({
    enum: QUEUE_TABS,
    default: 'failed',
    description: 'รอคิว / ล้มเหลว (ต้องมีคนทำ) / สำเร็จ',
  })
  @IsOptional()
  @IsIn(QUEUE_TABS)
  tab?: QueueTab;

  @ApiPropertyOptional({
    enum: ERROR_CLASSES,
    description: 'กรองตาม ErrorClass (จัดกลุ่มแท็บล้มเหลว)',
  })
  @IsOptional()
  @IsIn(ERROR_CLASSES)
  errorClass?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    description: 'ค่า nextCursor จากหน้าก่อน (เรียงตามเวลาที่เปลี่ยนล่าสุด ใหม่สุดก่อน)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;
}

export class QueueGuideDto {
  @ApiProperty({
    example: 'PERIOD_CLOSED',
    description: 'รหัสที่ใช้เลือกคู่มือ (code เฉพาะ หรือ ErrorClass)',
  })
  key!: string;
  @ApiProperty({ example: 'งวดบัญชีของวันที่เอกสารปิดแล้วในระบบบัญชี' }) title!: string;
  @ApiProperty({ description: 'สิ่งที่ต้องทำ (ภาษาไทย)' }) action!: string;
}

/** รายการที่ขาด (`erp_mapping_incomplete` = รหัสสินค้า · `erp_master_code_unknown` = ผังรหัส) */
export class QueueMissingDto {
  @ApiPropertyOptional({ example: 'svc_…' }) serviceItemId?: string;
  @ApiPropertyOptional({ nullable: true, type: String }) code?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) nameTh?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) itemCode?: string | null;
  @ApiPropertyOptional({ example: 'UNIT' }) kind?: string;
  @ApiPropertyOptional({ nullable: true, type: String }) value?: string | null;
  @ApiPropertyOptional({ type: [String] }) fields?: string[];
  @ApiProperty({ example: 'UNMAPPED' }) status!: string;
}

export class QueueFieldErrorDto {
  @ApiProperty() field!: string;
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}

export class QueueResolutionDto {
  @ApiProperty({ enum: ['RETRIED', 'SKIPPED', 'MANUAL_EXTERNAL_ID'] }) kind!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'RETRIED: คำสั่งใหม่ที่ส่งแทน' })
  supersededBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ nullable: true, type: String }) resolvedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) resolvedAt!: string;
}

export class QueueActionsDto {
  @ApiProperty({ description: 'ส่งซ้ำได้' }) retry!: boolean;
  @ApiProperty({ description: 'ข้ามพร้อมเหตุผลได้' }) skip!: boolean;
  @ApiProperty({ description: 'กรอกเลขเอกสารฝั่งระบบบัญชีเองได้' }) externalId!: boolean;
  @ApiProperty({
    description:
      'ST8-T13 อนุมัติการแทนที่เอกสารในระบบบัญชีได้ (รายการ `replace_requires_approval`) — ผู้เรียกต้องมีสิทธิ์อนุมัติและไม่ใช่ผู้ขอ',
  })
  approve!: boolean;
}

export class ConnectorQueueItemDto extends ConnectorCommandDto {
  @ApiProperty({ enum: QUEUE_TABS }) tab!: string;
  @ApiProperty({ nullable: true, type: String, example: 'INV-00000-2611-0001' })
  documentNo!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'รอคิว: เวลาที่จะลองครั้งถัดไป',
  })
  nextRunAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ข้อความผิดพลาด (ตัด secret แล้ว)' })
  errorMessage!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ลิงก์หน้าที่ต้องแก้ (mapping / ผังรหัส)',
  })
  link!: string | null;
  @ApiProperty({ type: [QueueMissingDto] }) missing!: QueueMissingDto[];
  @ApiProperty({ type: [QueueFieldErrorDto], description: 'ช่องที่ระบบบัญชีแจ้งว่าผิด' })
  fields!: QueueFieldErrorDto[];
  @ApiProperty() manualExternalIdRequired!: boolean;
  @ApiProperty({ nullable: true, type: QueueGuideDto }) guide!: QueueGuideDto | null;
  @ApiProperty({ nullable: true, type: QueueResolutionDto }) resolution!: QueueResolutionDto | null;
  @ApiProperty({ type: QueueActionsDto }) actions!: QueueActionsDto;
  @ApiProperty({
    description:
      'ผู้เรียกไม่มีสิทธิ์ดูราคาของเอกสารชนิดนี้ — sync log ของคำสั่งนี้จะไม่มี body (ซ่อนปุ่ม "ดู payload")',
  })
  bodiesHidden!: boolean;
}

export class ConnectorQueueListDto {
  @ApiProperty({ type: [ConnectorQueueItemDto] }) data!: ConnectorQueueItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class ConnectorQueueSummaryDto {
  @ApiProperty() queued!: number;
  @ApiProperty({ description: 'ต้องมีคนทำ (badge ที่เมนู)' }) failed!: number;
  @ApiProperty() done!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { VALIDATION: 2, PERIOD_CLOSED: 1 },
    description: 'แท็บล้มเหลวแยกตาม ErrorClass',
  })
  failedByClass!: Record<string, number>;
}

export class QueueRetryAllDto {
  @ApiPropertyOptional({
    enum: ERROR_CLASSES,
    description: 'ส่งซ้ำเฉพาะ ErrorClass นี้ (ไม่ส่ง = ทุกรายการที่ส่งซ้ำได้)',
  })
  @IsOptional()
  @IsIn(ERROR_CLASSES)
  errorClass?: string;
}

export class QueueRetryResultDto {
  @ApiProperty({ type: ConnectorQueueItemDto, description: 'คำสั่งใหม่ที่ส่งแทน' })
  command!: ConnectorQueueItemDto;
}

export class QueueRetryAllResultDto {
  @ApiProperty({ description: 'จำนวนที่สร้างคำสั่งส่งซ้ำ' }) retried!: number;
  @ApiProperty({ description: 'จำนวนในแท็บล้มเหลวที่ส่งซ้ำไม่ได้ (ต้องข้าม/กรอกเลขเอง)' })
  notRetryable!: number;
  @ApiProperty({ description: 'เหลือที่ยังไม่ได้ทำ (ทำครั้งละไม่เกิน 200)' }) remaining!: number;
}

export class QueueSkipDto extends MasterReasonDto {}

/** ST8-T13 อนุมัติการแทนที่เอกสารในระบบบัญชี — เหตุผล ≥ 10 ตัว */
export class QueueApproveDto extends MasterReasonDto {}

/** ST8-T09 เลขฝั่งระบบบัญชีของเอกสาร 1 ใบ (เอกสาร TMS ที่ระบบบัญชีเก็บเป็นหลายใบ — เช่น KRS แยกใบตาม vat_type) */
export class QueueExternalDocumentDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    example: 'INV-00000-2611-0001-V7',
    description: 'เลขอ้างอิงที่ TMS ส่งของใบนี้ (ต้องตรงกับการแยกใบของเอกสาร)',
  })
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[^\p{Cc}]+$/u)
  ref!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    example: '100042',
    description: 'id เอกสารฝั่งระบบบัญชีของใบนี้ (เช่น transactionNo ของ KRS)',
  })
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[^\p{Cc}]+$/u)
  externalId!: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description: 'เลขเอกสารที่แสดงในระบบบัญชี (ถ้าต่างจาก id)',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  @Matches(/^[^\p{Cc}]*$/u)
  externalDocNo?: string;
}

export class QueueExternalIdDto extends MasterReasonDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 100,
    example: 'IV6611-00042',
    description: 'id เอกสารฝั่งระบบบัญชี (เอกสารใบเดียว) — ส่งอย่างใดอย่างหนึ่งกับ `documents`',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[^\p{Cc}]+$/u)
  externalId?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description: 'เลขเอกสารที่แสดงในระบบบัญชี (ถ้าต่างจาก id)',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(60)
  @Matches(/^[^\p{Cc}]*$/u)
  externalDocNo?: string;

  @ApiPropertyOptional({
    type: [QueueExternalDocumentDto],
    minItems: 1,
    maxItems: MAX_EXTERNAL_DOCUMENTS,
    description:
      'ST8-T09 เอกสารที่ระบบบัญชีเก็บเป็นหลายใบ (เช่น KRS แยกใบตามชนิด VAT): เลขฝั่งระบบบัญชีต่อใบ — `ref` ต้องอยู่ในการแยกใบของเอกสาร · ' +
      'กรอกเฉพาะใบที่มีในระบบบัญชีแล้ว (ใบที่ไม่กรอก ระบบส่งให้ภายหลัง) · ระบบอ่านเอกสารจากระบบบัญชีมาเทียบก่อนเสมอ ไม่ส่งซ้ำ',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EXTERNAL_DOCUMENTS)
  @ValidateNested({ each: true })
  @Type(() => QueueExternalDocumentDto)
  documents?: QueueExternalDocumentDto[];
}

// ---------- service ----------

type Resolution = {
  kind: QueueResolutionKind;
  reason: string | null;
  supersededBy: string | null;
  externalId: string | null;
  resolvedBy: string | null;
  resolvedAt: Date;
};

/** ข้อเท็จจริงต่อคำสั่งที่ใช้ตัดสินแท็บ/ปุ่ม (คำนวณเป็นชุด) */
interface Facts {
  res: Resolution | null;
  /** review M3: มีคำสั่งหลังกว่าของเอกสารเดียวกัน (connector เดียวกัน) ที่สำเร็จ/ยังค้างอยู่ — รายการนี้ไม่ใช่งานของคนแล้ว */
  superseded: boolean;
  /** review M1: `resend` จะสร้างคำสั่งได้ (connector ไม่ยกเลิก · มีฉบับที่ออก · ไม่ก่อนวันเริ่มซิงก์) */
  resendable: boolean;
  /** review M2: external_mapping ของเอกสารนี้มี external_id แล้ว */
  mapped: boolean;
}

interface ErrorDetail {
  code?: unknown;
  message?: unknown;
  link?: unknown;
  missing?: unknown;
  fields?: unknown;
  manualExternalIdRequired?: unknown;
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v ? v.slice(0, max) : null;

const isDocPush = (row: Pick<IntegrationOutbox, 'operation' | 'entityType'>) =>
  DOCUMENT_PUSH_OPS.has(row.operation) &&
  (row.entityType === 'invoice' || row.entityType === 'settlement');

/** ต้องมีคนทำ (ไม่รวมว่าจัดการแล้วหรือยัง) — เงื่อนไขเดียวกับ SQL `NEEDS_HUMAN` */
export function needsHuman(r: Pick<IntegrationOutbox, 'status' | 'lastError'>): boolean {
  const e = (r.lastError ?? null) as ErrorDetail | null;
  const code = typeof e?.code === 'string' ? e.code : null;
  if (r.status === 'FAILED_FINAL') return true;
  if (r.status === 'SKIPPED') return !!code && !NOT_NOTIFIED_SKIPS.has(code);
  if (r.status === 'DONE') return e?.manualExternalIdRequired === true;
  return false;
}

// COALESCE: last_error ว่าง = NULL (ตรรกะ 3 ค่า) → ถือว่าไม่ต้องมีคนทำ
const NEEDS_HUMAN_SQL = Prisma.sql`COALESCE(
  o.status = 'FAILED_FINAL'
  OR (o.status = 'SKIPPED' AND o.last_error->>'code' IS NOT NULL
      AND o.last_error->>'code' NOT IN (${Prisma.join([...NOT_NOTIFIED_SKIPS])}))
  OR (o.status = 'DONE' AND (o.last_error->>'manualExternalIdRequired') = 'true'), false)`;
const RESOLVED_SQL = Prisma.sql`EXISTS (SELECT 1 FROM connector_queue_resolution r WHERE r.outbox_id = o.id)`;
export const RETRIED_SQL = Prisma.sql`EXISTS (SELECT 1 FROM connector_queue_resolution r WHERE r.outbox_id = o.id AND r.kind = 'RETRIED')`;
/** review M3: คำสั่งหลังกว่าของเอกสารเดียวกันสำเร็จแล้ว/ยังค้าง (เช่น ระบบส่งใหม่เองหลังเอกสารเปลี่ยน) */
const SUPERSEDED_SQL = Prisma.sql`EXISTS (SELECT 1 FROM integration_outbox o2
   WHERE o2.sink = o.sink AND o2.target_id = o.target_id AND o2.entity_type = o.entity_type
     AND o2.local_id = o.local_id AND o2.seq > o.seq
     AND o2.status IN ('DONE', 'PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'))`;
const OPEN_STATUSES = ['PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'];

/** แท็บ — รายการต้องมีคนทำที่ถูกแทนแล้ว (ส่งซ้ำ / คำสั่งหลังกว่า) ไม่อยู่ในแท็บใด · ST8-T14 รายงานปิดงวด + ST9-T04 dashboard เชื่อมต่อใช้เงื่อนไขเดียวกัน (alias `o`) */
export function tabSql(tab: QueueTab): Prisma.Sql {
  switch (tab) {
    case 'queued':
      return Prisma.sql`o.status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')`;
    case 'failed':
      return Prisma.sql`${NEEDS_HUMAN_SQL} AND NOT ${RESOLVED_SQL} AND NOT ${SUPERSEDED_SQL}`;
    case 'done':
      return Prisma.sql`o.status IN ('DONE', 'SKIPPED', 'FAILED_FINAL') AND (NOT ${NEEDS_HUMAN_SQL} OR ${RESOLVED_SQL})`;
  }
}

@Injectable()
export class ConnectorQueueService {
  constructor(
    private readonly db: DbService,
    private readonly connectors: ConnectorsService,
    private readonly sync: ErpSyncService,
    private readonly sink: ErpAdapterSink,
  ) {}

  /** รายการในแท็บ (keyset cursor ตาม updated_at, id — ใหม่สุดก่อน) */
  async list(
    id: string,
    q: ConnectorQueueQuery,
    tx: Tx = this.db.tx,
  ): Promise<ConnectorQueueListDto> {
    const c = await this.connectors.get(id, tx);
    const limit = q.limit ?? 50;
    const where: Prisma.Sql[] = [
      Prisma.sql`o.sink = ${ERP_SINK}`,
      Prisma.sql`o.target_id = ${c.id}`,
      Prisma.sql`NOT ${RETRIED_SQL}`,
      tabSql(q.tab ?? 'failed'),
    ];
    if (q.errorClass) where.push(Prisma.sql`o.error_class = ${q.errorClass}`);
    if (q.cursor) {
      const k = decodeCursor(q.cursor, QUEUE_SORT);
      where.push(
        Prisma.sql`(o.updated_at < ${new Date(k.u)} OR (o.updated_at = ${new Date(k.u)} AND o.id < ${k.i}::uuid))`,
      );
    }
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT o.id FROM integration_outbox o
       WHERE ${Prisma.join(where, ' AND ')}
       ORDER BY o.updated_at DESC, o.id DESC
       LIMIT ${limit + 1}`;
    const hasMore = ids.length > limit;
    const pageIds = (hasMore ? ids.slice(0, limit) : ids).map((r) => r.id);
    const rows = await this.rows(tx, c, pageIds);
    const last = rows[rows.length - 1];
    return {
      data: rows.map((r) => this.item(r.row, r.f)),
      nextCursor:
        hasMore && last
          ? encodeCursor({ updatedAt: last.row.updatedAt, id: last.row.id }, QUEUE_SORT)
          : null,
      hasMore,
    };
  }

  /** ตัวนับต่อแท็บ + แท็บล้มเหลวแยก ErrorClass (badge ที่เมนู = `failed` — เงื่อนไขเดียวกับรายการ) */
  async summary(id: string, tx: Tx = this.db.tx): Promise<ConnectorQueueSummaryDto> {
    const c = await this.connectors.get(id, tx);
    const base = Prisma.sql`o.sink = ${ERP_SINK} AND o.target_id = ${c.id} AND NOT ${RETRIED_SQL}`;
    const [counts] = await tx.$queryRaw<{ queued: number; failed: number; done: number }[]>`
      SELECT count(*) FILTER (WHERE ${tabSql('queued')})::int AS queued,
             count(*) FILTER (WHERE ${tabSql('failed')})::int AS failed,
             count(*) FILTER (WHERE ${tabSql('done')})::int AS done
        FROM integration_outbox o WHERE ${base}`;
    const byClass = await tx.$queryRaw<{ cls: string | null; n: number }[]>`
      SELECT o.error_class AS cls, count(*)::int AS n FROM integration_outbox o
       WHERE ${base} AND ${tabSql('failed')} GROUP BY o.error_class`;
    return {
      queued: counts?.queued ?? 0,
      failed: counts?.failed ?? 0,
      done: counts?.done ?? 0,
      failedByClass: Object.fromEntries(byClass.map((r) => [r.cls ?? 'UNKNOWN', r.n])),
    };
  }

  /** ส่งซ้ำ 1 รายการ (หลังแก้ mapping / ผังรหัส / เปิดงวดบัญชี ฯลฯ) — คำสั่งใหม่ผ่าน `ErpSyncService.resend` */
  async retry(id: string, commandRef: string, tx: Tx = this.db.tx): Promise<QueueRetryResultDto> {
    const c = await this.connectors.get(id, tx);
    const { row } = await this.command(tx, c, commandRef);
    const newId = await this.retryRow(tx, c, row);
    const [fresh] = await this.rows(tx, c, [newId]);
    return { command: this.item(fresh!.row, fresh!.f) };
  }

  /**
   * ส่งซ้ำทุกรายการในแท็บล้มเหลวที่ส่งซ้ำได้ (ครั้งละไม่เกิน 200 — ตัวที่เหลือกดอีกครั้ง)
   * review M1: ทำทีละรายการใน SAVEPOINT — รายการที่ล้ม (จัดการไปแล้วพร้อมกัน / resend ไม่สร้างคำสั่ง) นับเป็น `notRetryable`
   * และไม่ย้อนรายการอื่น
   */
  async retryAll(
    id: string,
    body: QueueRetryAllDto,
    tx: Tx = this.db.tx,
  ): Promise<QueueRetryAllResultDto> {
    const c = await this.connectors.get(id, tx);
    const MAX = 200;
    const cls = body.errorClass ? Prisma.sql`AND o.error_class = ${body.errorClass}` : Prisma.empty;
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT o.id FROM integration_outbox o
       WHERE o.sink = ${ERP_SINK} AND o.target_id = ${c.id} AND NOT ${RETRIED_SQL} AND ${tabSql('failed')} ${cls}
       ORDER BY o.seq ASC`;
    const rows = await this.rows(
      tx,
      c,
      ids.map((r) => r.id),
    );
    let retried = 0;
    let notRetryable = 0;
    let remaining = 0;
    for (const { row, f } of rows) {
      if (!this.actions(row, f).retry) {
        notRetryable++;
        continue;
      }
      if (retried >= MAX) {
        remaining++;
        continue;
      }
      await tx.$executeRawUnsafe('SAVEPOINT queue_retry_row');
      try {
        await this.retryRow(tx, c, row);
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT queue_retry_row');
        retried++;
      } catch (e) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT queue_retry_row');
        if (!(e instanceof ProblemException)) throw e;
        notRetryable++;
      }
    }
    return { retried, notRetryable, remaining };
  }

  /** ข้ามพร้อมเหตุผล (override — คนเท่านั้น + audit) */
  async skip(
    id: string,
    commandRef: string,
    body: QueueSkipDto,
    tx: Tx = this.db.tx,
  ): Promise<ConnectorQueueItemDto> {
    const c = await this.connectors.get(id, tx);
    this.connectors.assertHuman(); // review L2: override ต้องเป็นคน (API key → 403) — แบบ reconcile รอบ MANUAL
    const { row, f } = await this.command(tx, c, commandRef);
    if (!this.actions(row, f).skip) throw notAllowed(this.why(row, f));
    await this.resolve(tx, c.id, row, { kind: 'SKIPPED', reason: body.reason });
    await this.audit(tx, c.id, 'connector.queue_skipped', row, body.reason, {});
    const [fresh] = await this.rows(tx, c, [row.id]);
    return this.item(fresh!.row, fresh!.f);
  }

  /**
   * ST8-T13 อนุมัติการแทนที่เอกสารในระบบบัญชี (docs/01 §6.1 "replaceDocument ต้องมี approval ถ้าลงบัญชีแล้ว"; A.2 KRS "approval ถ้า
   * posted_at ไม่ว่าง หรืออายุใบ > N วัน") — รายการ SKIPPED `replace_requires_approval` เท่านั้น
   * - คนเท่านั้น (API key → 403) · เหตุผล ≥ 10 ตัว · **ผู้อนุมัติ ≠ ผู้ขอ** (`requestedBy` ของคำสั่ง: ผู้ออกใบใหม่/ผู้ยกเลิกใบเดิม/ผู้สั่งส่งซ้ำ)
   *   → 403 `erp_replace_self_approval`
   * - ผล: คำสั่งใหม่ (payload เดิม + `approval`) → sink ส่งได้โดยไม่ถามซ้ำ · รายการเดิม = RETRIED (`supersededBy`, เหตุผล) ·
   *   audit `connector.queue_approved` (ผู้อนุมัติ / ผู้ขอ / เหตุผล)
   */
  async approve(
    id: string,
    commandRef: string,
    body: QueueApproveDto,
    tx: Tx = this.db.tx,
  ): Promise<ConnectorQueueItemDto> {
    const c = await this.connectors.get(id, tx);
    this.connectors.assertHuman();
    const { row, f } = await this.command(tx, c, commandRef);
    if (!this.actions(row, f).approve) throw notAllowed(this.why(row, f, 'approve'));
    const actor = requestContext.get()?.actorId ?? null;
    const p = (row.payload ?? {}) as { requestedBy?: unknown };
    // review M3: ผู้ขอ = รายชื่อในคำสั่ง ∪ ทุกคนที่สร้าง/แก้/ออกเลขเอกสารนี้ (อ่าน ณ ตอนอนุมัติ)
    const requesters = [
      ...new Set([
        ...(Array.isArray(p.requestedBy)
          ? (p.requestedBy as unknown[]).filter(
              (x): x is string => typeof x === 'string' && isPersonActor(x),
            )
          : []),
        ...(row.entityType === 'invoice' ? await invoiceActors(tx, [row.localId]) : []),
      ]),
    ];
    // ไม่รู้ผู้ขอ (สร้างโดยระบบ) = ผู้อนุมัติต้องเป็นคน (ตรวจแล้ว) + บันทึกว่าไม่รู้ผู้ขอใน audit
    if (!actor || !isPersonActor(actor) || requesters.includes(actor))
      throw new ProblemException('erp_replace_self_approval', undefined, undefined, {
        requestedBy: requesters,
      });
    const newId = await this.sync.approveReplace(tx, row, {
      approvedBy: actor,
      reason: body.reason.trim(),
      approvedAt: new Date(),
    });
    if (!newId || newId === row.id) throw notAllowed('resend_unavailable');
    await this.resolve(tx, c.id, row, {
      kind: 'RETRIED',
      reason: body.reason,
      supersededBy: newId,
    });
    await this.audit(tx, c.id, 'connector.queue_approved', row, body.reason, {
      newCommandId: encodeId('outboxCommand', newId),
      requestedBy: requesters,
      ...(requesters.length ? {} : { requestersUnknown: true }),
      approvedBy: actor,
      replacedInvoiceId:
        typeof (row.payload as { reissueOf?: unknown } | null)?.reissueOf === 'string'
          ? encodeId('invoice', (row.payload as { reissueOf: string }).reissueOf)
          : null,
    });
    const [fresh] = await this.rows(tx, c, [row.id]);
    return this.item(fresh!.row, fresh!.f);
  }

  /**
   * กรอกเลขเอกสารฝั่งระบบบัญชีเอง (override — คนเท่านั้น + audit) — DUPLICATE ที่หาไม่เจอ (`manualExternalIdRequired`) หรือคำสั่งส่งเอกสาร
   * ที่ล้มเหลวแต่บัญชียืนยันว่าเอกสารอยู่ในระบบบัญชีแล้ว · บันทึก external_mapping (MISMATCH `erp_content_unverified` — รอ reconcile ยืนยัน)
   * review M2: เฉพาะเอกสารที่ยังไม่มี external_id (มีแล้ว = 409 `mapping_exists` — ไม่ทับเลขที่ยืนยันแล้วจากคิว)
   * id นี้ผูกกับเอกสารอื่นของ connector เดียวกันอยู่ → 409 `external_id_conflict`
   *
   * ST8-T09 (docs/01 A.5 409: "error queue ให้คนกรอก `transactionNo` จาก ERP มือ; แล้ว `GET` เทียบ — ไม่ retry POST"):
   * adapter ที่แยกเอกสาร TMS เป็นหลายใบ (`plannedDocuments` — เช่น KRS แยกตาม vat_type) → กรอกเป็น `documents` ต่อใบ
   * (`ref` ต้องอยู่ในแผนการแยกใบ · ใบที่ระบบรู้เลขแล้วต้องตรงกัน · กรอกเฉพาะใบที่มีในระบบบัญชี) — แผนมี 1 ใบ รับ `externalId` เดี่ยวได้
   * → mapping `PENDING` + `detail.documents` (ยังไม่ถือว่าอยู่ใน ERP ครบ) + คำสั่งส่งใหม่ (`resolution.supersededBy`) ซึ่ง sink
   * **GET ทุกใบที่รู้เลขก่อน** แล้วเทียบ: ตรง = SYNCED · ต่าง = MISMATCH · ไม่พบ = REMOTE_MISSING · ใบที่ไม่ได้กรอก = ส่งเฉพาะใบนั้น
   * (ERP ตอบซ้ำ = กลับมาที่คิวนี้) — ไม่ POST ใบที่กรอกเลขแล้วซ้ำ
   */
  async externalId(
    id: string,
    commandRef: string,
    body: QueueExternalIdDto,
    tx: Tx = this.db.tx,
  ): Promise<ConnectorQueueItemDto> {
    const c = await this.connectors.get(id, tx);
    this.connectors.assertHuman(); // review L2: override ต้องเป็นคน (API key → 403) — แบบ reconcile รอบ MANUAL
    const { row, f } = await this.command(tx, c, commandRef);
    const entity = row.entityType === 'invoice' ? MAP_ENTITY.invoice : MAP_ENTITY.settlement;
    if (isDocPush(row))
      await lockKey(tx, `external_mapping:${c.id}:${entity}:local:${row.localId}`);
    if (!this.actions(row, f).externalId) throw notAllowed(this.why(row, f, 'externalId'));
    const single = body.externalId?.trim() || '';
    if (!single === !body.documents?.length)
      throw invalid(
        'externalId',
        'one_of',
        'กรอก externalId (ใบเดียว) หรือ documents (หลายใบ) อย่างใดอย่างหนึ่ง',
      );
    const before = await tx.externalMapping.findUnique({
      where: {
        connectorId_entityType_localId: {
          connectorId: c.id,
          entityType: entity,
          localId: row.localId,
        },
      },
    });
    // ST8-T09 แผนการแยกใบของ adapter (ฉบับที่ออก — payload ของคำสั่งส่งแรก เหมือน `resend`)
    const plan = await this.plan(tx, c, row);
    // adapter แยกใบได้ (มีแผน / เตรียมแผนไม่ได้) หรือผู้ใช้กรอกต่อใบ → ทางต่อใบ (adapter เอกสารเดียว = ทางเดิมของ ST7-T19)
    if (plan.kind !== 'single' || body.documents?.length) {
      if (plan.kind === 'single')
        throw invalid(
          'documents',
          'not_split',
          'ระบบบัญชีนี้เก็บเอกสารนี้เป็นใบเดียว — กรอก externalId',
        );
      if (plan.kind === 'unavailable')
        throw invalid(
          'documents',
          'plan_unavailable',
          `ตรวจการแยกใบของเอกสารนี้ไม่ได้ (${plan.code}) — แก้ข้อมูล/ผังรหัสให้ครบก่อน`,
        );
      const docs =
        body.documents ??
        (plan.parts.length === 1
          ? [{ ref: plan.parts[0]!.ref, externalId: single, externalDocNo: body.externalDocNo }]
          : null);
      if (!docs)
        throw invalid(
          'documents',
          'documents_required',
          `เอกสารนี้อยู่ในระบบบัญชี ${plan.parts.length} ใบ — กรอกเลขต่อใบใน documents`,
        );
      return this.externalDocuments(tx, c, row, entity, before, plan.parts, docs, body.reason);
    }
    if (before?.externalId) throw notAllowed('mapping_exists');
    const externalId = single;
    await lockKey(tx, `external_mapping:${c.id}:${entity}:ext:${externalId}`);
    await this.assertNotMappedElsewhere(tx, c.id, entity, row, [externalId], 'externalId');
    const actor = requestContext.get()?.actorId ?? null;
    const lastError = {
      code: 'erp_content_unverified',
      source: 'manual',
      outboxId: encodeId('outboxCommand', row.id),
      at: new Date().toISOString(),
    };
    const docNo = body.externalDocNo?.trim() || null;
    if (before)
      await tx.externalMapping.update({
        where: { id: before.id },
        data: {
          externalId,
          externalDocNo: docNo ?? before.externalDocNo,
          status: 'MISMATCH',
          lastError,
          updatedBy: actor,
          version: { increment: 1 },
        },
      });
    else
      await tx.externalMapping.create({
        data: {
          tenantId: row.tenantId,
          connectorId: c.id,
          entityType: entity,
          localId: row.localId,
          localNumber: documentNo(row)?.slice(0, 60) ?? null,
          externalId,
          externalDocNo: docNo,
          status: 'MISMATCH',
          lastError,
          createdBy: actor,
          updatedBy: actor,
        },
      });
    await this.resolve(tx, c.id, row, {
      kind: 'MANUAL_EXTERNAL_ID',
      reason: body.reason,
      externalId,
    });
    await this.audit(tx, c.id, 'connector.queue_external_id', row, body.reason, {
      externalId,
      externalDocNo: docNo,
    });
    const [fresh] = await this.rows(tx, c, [row.id]);
    return this.item(fresh!.row, fresh!.f);
  }

  /**
   * ST8-T09 กรอกเลขฝั่ง ERP ต่อใบของเอกสารที่ adapter แยกเป็นหลายใบ — ตรวจ `ref` กับแผน · ใบที่รู้เลขแล้ว (mapping ส่งไม่ครบ) ต้องตรง ·
   * id ไม่ซ้ำกันและไม่ผูกกับเอกสารอื่น → mapping `PENDING` (`documentsPartial`, ไม่รู้แน่ว่ามีแค่นี้ → sink GET ยืนยันก่อน) + คำสั่งส่งใหม่
   */
  private async externalDocuments(
    tx: Tx,
    c: Connector,
    row: IntegrationOutbox,
    entity: 'INVOICE' | 'SETTLEMENT',
    before: { id: string; externalId: string | null; detail: unknown } | null,
    parts: readonly Pick<ExternalDocumentPart, 'ref' | 'group' | 'lineNos'>[],
    docs: readonly { ref: string; externalId: string; externalDocNo?: string }[],
    reason: string,
  ): Promise<ConnectorQueueItemDto> {
    const detail = (before?.detail ?? {}) as { documentsPartial?: unknown };
    // review M2 เดิม: เอกสารที่ยืนยันแล้ว (external_id โดยไม่ใช่การส่งไม่ครบ) ไม่ทับ
    if (before?.externalId && detail.documentsPartial !== true) throw notAllowed('mapping_exists');
    const known = new Map(
      (detail.documentsPartial === true ? mappingDocumentsOf(before?.detail) : []).map((p) => [
        p.ref,
        p,
      ]),
    );
    const planned = new Map(parts.map((p, i) => [p.ref, { ...p, i }]));
    const entered = new Map<string, { externalId: string; externalDocNo: string | null }>();
    const replaced: { ref: string; from: string; to: string }[] = [];
    const ids = new Set<string>();
    docs.forEach((d, i) => {
      const ref = d.ref.trim();
      const externalId = d.externalId.trim();
      if (!planned.has(ref))
        throw invalid(
          `documents[${i}].ref`,
          'unknown_ref',
          `เลขอ้างอิง ${ref} ไม่อยู่ในการแยกใบของเอกสารนี้ (${parts.map((p) => p.ref).join(', ')})`.slice(
            0,
            300,
          ),
        );
      if (entered.has(ref))
        throw invalid(`documents[${i}].ref`, 'duplicate', 'กรอกเลขอ้างอิงนี้ซ้ำ');
      if (ids.has(externalId))
        throw invalid(`documents[${i}].externalId`, 'duplicate', 'ใช้ id เดียวกันกับหลายใบไม่ได้');
      const k = known.get(ref);
      // review M1: ใบที่คนกรอกไว้แต่ยังไม่ยืนยันกับระบบบัญชี — แก้ทับได้ (ลง audit `replaced`) · ใบที่ระบบยืนยันแล้วต้องตรง
      if (k?.source === 'manual' && k.externalId !== externalId)
        replaced.push({ ref, from: k.externalId, to: externalId });
      else if (k && k.externalId !== externalId)
        throw invalid(
          `documents[${i}].externalId`,
          'known_mismatch',
          `ระบบรู้เลขของใบ ${ref} แล้ว (${k.externalId}) — ไม่ตรงกับที่กรอก`,
        );
      ids.add(externalId);
      entered.set(ref, { externalId, externalDocNo: d.externalDocNo?.trim() || null });
    });
    for (const [ref, k] of known)
      if (!entered.has(ref)) {
        if (!planned.has(ref))
          throw invalid(
            'documents',
            'plan_changed',
            `ใบ ${ref} ที่ส่งไปแล้วไม่อยู่ในการแยกใบครั้งนี้ — ต้องตรวจในระบบบัญชี`,
          );
        if (ids.has(k.externalId))
          throw invalid('documents', 'duplicate', `id ${k.externalId} เป็นของใบ ${ref} แล้ว`);
        ids.add(k.externalId);
      }
    // ทุกใบที่รู้เลข (กรอก ∪ รู้แล้ว) ตามลำดับแผน
    const merged: ExternalDocumentPart[] = parts.flatMap((p) => {
      const e = entered.get(p.ref);
      const k = known.get(p.ref);
      if (!e && !k) return [];
      return [
        {
          ref: p.ref,
          externalId: e?.externalId ?? k!.externalId,
          externalDocNo: e?.externalDocNo ?? k?.externalDocNo ?? null,
          group: p.group,
          lineNos: [...p.lineNos],
          // review M1: ที่มาของ id — กรอกครั้งนี้ / กรอกไว้ก่อนแต่ยังไม่ยืนยัน = manual (ยืนยันไม่ผ่าน → ถอยกลับให้คนกรอกใหม่)
          ...(e || k?.source === 'manual' ? { source: 'manual' as const } : {}),
        },
      ];
    });
    for (const x of [...ids].sort())
      await lockKey(tx, `external_mapping:${c.id}:${entity}:ext:${x}`);
    await this.assertNotMappedElsewhere(tx, c.id, entity, row, [...ids], 'documents');
    const actor = requestContext.get()?.actorId ?? null;
    const head = merged[0]!;
    const lastError = {
      code: 'manual_external_id',
      source: 'manual',
      outboxId: encodeId('outboxCommand', row.id),
      documentsEntered: entered.size,
      documentsPlanned: parts.length,
      at: new Date().toISOString(),
    };
    const nextDetail = {
      ...((before?.detail ?? {}) as Record<string, unknown>),
      documents: merged.map((p) => ({ ...p, lineNos: [...p.lineNos] })),
      documentsPartial: true,
      // คนยืนยันว่าใบที่กรอกมีอยู่ — แต่ยังไม่รู้แน่ว่าระบบบัญชีมีแค่นี้ → sink GET ยืนยันก่อนส่ง (ไม่เชื่อ "รู้แน่")
      documentsComplete: false,
    } as unknown as Prisma.InputJsonValue;
    if (before)
      await tx.externalMapping.update({
        where: { id: before.id },
        data: {
          externalId: head.externalId,
          externalDocNo: head.externalDocNo,
          status: 'PENDING',
          detail: nextDetail,
          lastError,
          updatedBy: actor,
          version: { increment: 1 },
        },
      });
    else
      await tx.externalMapping.create({
        data: {
          tenantId: row.tenantId,
          connectorId: c.id,
          entityType: entity,
          localId: row.localId,
          localNumber: documentNo(row)?.slice(0, 60) ?? null,
          externalId: head.externalId,
          externalDocNo: head.externalDocNo,
          status: 'PENDING',
          detail: nextDetail,
          lastError,
          createdBy: actor,
          updatedBy: actor,
        },
      });
    // GET เทียบ (ไม่ POST ใบที่กรอกแล้ว) — คำสั่งส่งใหม่ของเอกสารนี้ (sink: mapping ส่งไม่ครบ → ค้นก่อนเสมอ)
    const verify = await this.sync.resend(
      tx,
      row.entityType as 'invoice' | 'settlement',
      row.localId,
      c.id,
    );
    await this.resolve(tx, c.id, row, {
      kind: 'MANUAL_EXTERNAL_ID',
      reason,
      externalId: head.externalId,
      ...(verify && verify !== row.id ? { supersededBy: verify } : {}),
    });
    await this.audit(tx, c.id, 'connector.queue_external_id', row, reason, {
      externalId: head.externalId,
      externalDocNo: head.externalDocNo,
      documents: merged.map((p) => ({
        ref: p.ref,
        externalId: p.externalId,
        externalDocNo: p.externalDocNo,
        entered: entered.has(p.ref),
      })),
      documentsPlanned: parts.length,
      ...(replaced.length ? { replaced } : {}),
      verifyCommandId: verify ? encodeId('outboxCommand', verify) : null,
    });
    const [fresh] = await this.rows(tx, c, [row.id]);
    return this.item(fresh!.row, fresh!.f);
  }

  /** ST8-T09 แผนการแยกใบ (adapter `plannedDocuments`) ของฉบับที่ออก */
  private async plan(tx: Tx, c: Connector, row: IntegrationOutbox) {
    const op = row.entityType === 'invoice' ? 'PUSH_INVOICE' : 'PUSH_SETTLEMENT';
    const first = await tx.integrationOutbox.findFirst({
      where: {
        sink: ERP_SINK,
        targetId: c.id,
        operation: op,
        entityType: row.entityType,
        localId: row.localId,
      },
      orderBy: { seq: 'asc' },
      select: { payload: true },
    });
    const doc = (first?.payload as { document?: CanonicalDocument } | null)?.document ?? null;
    return this.sink.plannedDocuments(tx, c, op, doc);
  }

  /** id ฝั่ง ERP ผูกกับเอกสารอื่นของ connector เดียวกันอยู่ (key หลัก หรือใบใน `detail.documents`) → 409 `external_id_conflict` */
  private async assertNotMappedElsewhere(
    tx: Tx,
    connectorId: string,
    entity: 'INVOICE' | 'SETTLEMENT',
    row: IntegrationOutbox,
    ids: string[],
    field: string,
  ) {
    const [other] = await tx.$queryRaw<{ localId: string }[]>`
      SELECT local_id::text AS "localId" FROM external_mapping
       WHERE connector_id = ${connectorId}::uuid AND entity_type = ${entity}::"ExternalEntityType"
         AND local_id <> ${row.localId}::uuid
         AND (external_id = ANY(${ids}::text[])
              OR (jsonb_typeof(detail->'documents') = 'array'
                  AND EXISTS (SELECT 1 FROM jsonb_array_elements(detail->'documents') e
                               WHERE e->>'externalId' = ANY(${ids}::text[]))))
       LIMIT 1`;
    if (other)
      throw new ProblemException(
        'external_id_conflict',
        'เลขนี้ผูกกับเอกสารอื่นของการเชื่อมต่อนี้แล้ว',
        [{ field, code: 'duplicate', message: 'เลขนี้ผูกกับเอกสารอื่นแล้ว' }],
        {
          documentId: encodeId(
            row.entityType === 'invoice' ? 'invoice' : 'settlement',
            other.localId,
          ),
        },
      );
  }

  // ---------- ภายใน ----------

  private async retryRow(tx: Tx, c: Connector, row: IntegrationOutbox): Promise<string> {
    await lockKey(tx, `queue:${row.id}`);
    const entity = row.entityType as 'invoice' | 'settlement';
    // review L1: ส่งซ้ำเอกสารเดียวกันพร้อมกัน (2 แถวของใบเดียว / 2 คน) — ตรวจคำสั่งที่ค้างของ resend ต้องไม่ race
    await lockKey(tx, `erp-resend:${c.id}:${entity}:${row.localId}`);
    const [{ f }] = (await this.rows(tx, c, [row.id])) as [{ row: IntegrationOutbox; f: Facts }];
    if (!this.actions(row, f).retry) throw notAllowed(this.why(row, f, 'retry'));
    const newId = await this.sync.resend(tx, entity, row.localId, c.id);
    // null = connector ยกเลิกแล้ว / ไม่มีฉบับที่ออก / เอกสารก่อนวันเริ่มซิงก์ (docs/01 §6.4 — ไม่สร้างคำสั่ง)
    if (!newId || newId === row.id) throw notAllowed('resend_unavailable');
    await this.resolve(tx, c.id, row, { kind: 'RETRIED', supersededBy: newId });
    await this.audit(tx, c.id, 'connector.queue_retried', row, null, {
      newCommandId: encodeId('outboxCommand', newId),
    });
    return newId;
  }

  private async command(tx: Tx, c: Connector, ref: string) {
    const outboxId = tryDecodeId('outboxCommand', ref);
    const row = outboxId
      ? await tx.integrationOutbox.findFirst({
          where: { id: outboxId, sink: ERP_SINK, targetId: c.id },
        })
      : null;
    if (!row) throw new ProblemException('not_found');
    await lockKey(tx, `queue:${row.id}`);
    const [{ f }] = (await this.rows(tx, c, [row.id])) as [{ row: IntegrationOutbox; f: Facts }];
    return { row, f };
  }

  /** แถว + ข้อเท็จจริง (resolution, ถูกแทน, ส่งซ้ำได้, มี external_id แล้ว) เป็นชุด */
  private async rows(tx: Tx, c: Connector, ids: string[]) {
    if (!ids.length) return [];
    const [rows, res] = await Promise.all([
      tx.integrationOutbox.findMany({ where: { id: { in: ids } } }),
      tx.connectorQueueResolution.findMany({ where: { outboxId: { in: ids } } }),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const resBy = new Map(res.map((r) => [r.outboxId, r]));
    const ordered = ids.map((i) => byId.get(i)).filter((r): r is IntegrationOutbox => !!r);
    const docRows = ordered.filter(isDocPush);
    const localIds = [...new Set(docRows.map((r) => r.localId))];
    const later = localIds.length
      ? await tx.integrationOutbox.findMany({
          where: {
            sink: ERP_SINK,
            targetId: c.id,
            localId: { in: localIds },
            status: { in: ['DONE', ...OPEN_STATUSES] as IntegrationOutbox['status'][] },
          },
          select: { seq: true, entityType: true, localId: true },
        })
      : [];
    // ฉบับที่ออก (payload ของคำสั่ง PUSH_* แรก — ที่ resend ใช้)
    const firsts = localIds.length
      ? await tx.integrationOutbox.findMany({
          where: {
            sink: ERP_SINK,
            targetId: c.id,
            localId: { in: localIds },
            // ST8-T13 ใบออกใหม่ที่แทนที่เอกสารของใบเดิม: ฉบับที่ออก = payload ของคำสั่งแทนที่ครั้งแรก (ไม่มี PUSH)
            operation: { in: ['PUSH_INVOICE', 'PUSH_SETTLEMENT', 'REPLACE_DOCUMENT'] },
          },
          orderBy: { seq: 'asc' },
          select: { entityType: true, localId: true, payload: true, operation: true },
        })
      : [];
    const issued = new Map<string, unknown>();
    for (const r of firsts) {
      const k = `${r.entityType}:${r.localId}`;
      const p = r.payload as { document?: unknown; reissueOf?: unknown } | null;
      if (r.operation === 'REPLACE_DOCUMENT' && typeof p?.reissueOf !== 'string') continue;
      if (!issued.has(k)) issued.set(k, p?.document);
    }
    const maps = localIds.length
      ? await tx.externalMapping.findMany({
          where: {
            connectorId: c.id,
            localId: { in: localIds },
            entityType: { in: [MAP_ENTITY.invoice, MAP_ENTITY.settlement] },
          },
          select: { entityType: true, localId: true, externalId: true, detail: true },
        })
      : [];
    // ST8-T09 mapping ที่บันทึกเอกสารฝั่ง ERP ไว้ไม่ครบ (`documentsPartial`) ยังกรอกเลขของใบที่เหลือได้
    const mapped = new Set(
      maps
        .filter(
          (m) =>
            m.externalId &&
            (m.detail as { documentsPartial?: unknown } | null)?.documentsPartial !== true,
        )
        .map((m) => `${m.entityType}:${m.localId}`),
    );
    const from = c.syncFromDate ? c.syncFromDate.toISOString().slice(0, 10) : null;
    return ordered.map((row) => {
      const k = `${row.entityType}:${row.localId}`;
      const doc = issued.get(k);
      const date = doc ? documentDate(doc) : null;
      const mapKey = `${row.entityType === 'invoice' ? MAP_ENTITY.invoice : MAP_ENTITY.settlement}:${row.localId}`;
      const f: Facts = {
        res: resBy.get(row.id) ?? null,
        superseded: later.some(
          (l) => l.entityType === row.entityType && l.localId === row.localId && l.seq > row.seq,
        ),
        resendable:
          isDocPush(row) && c.status !== 'DISCONNECTED' && !!doc && !(from && date && date < from),
        mapped: isDocPush(row) && mapped.has(mapKey),
      };
      return { row, f };
    });
  }

  private actions(row: IntegrationOutbox, f: Facts): QueueActionsDto {
    if (f.res || f.superseded || !needsHuman(row))
      return { retry: false, skip: false, externalId: false, approve: false };
    const e = (row.lastError ?? null) as ErrorDetail | null;
    const code = typeof e?.code === 'string' ? e.code : null;
    const reissue = typeof (row.payload as { reissueOf?: unknown } | null)?.reissueOf === 'string';
    return {
      // review L3: DUPLICATE ที่ต้องกรอกเลขเอง — ส่งซ้ำได้ผลเดิม
      retry:
        isDocPush(row) &&
        f.resendable &&
        e?.manualExternalIdRequired !== true &&
        !(code && NOT_RETRYABLE_CODES.has(code)),
      skip: true,
      // ST8-T13 ใบออกใหม่ที่แทนที่เอกสารของใบเดิม — เลขฝั่งระบบบัญชีเป็นของใบเดิมอยู่แล้ว (ไม่กรอกเอง)
      externalId: isDocPush(row) && !f.mapped && !reissue,
      approve:
        row.operation === 'REPLACE_DOCUMENT' &&
        row.status === 'SKIPPED' &&
        code === 'replace_requires_approval',
    };
  }

  /** เหตุผลที่ทำไม่ได้ (`why` ของ 409) */
  private why(
    row: IntegrationOutbox,
    f: Facts,
    action?: 'retry' | 'externalId' | 'approve',
  ): string {
    if (f.res) return 'already_resolved';
    if (f.superseded) return 'superseded';
    if (!needsHuman(row)) return 'not_failed';
    if (!isDocPush(row)) return 'not_a_document_push';
    if (action === 'approve') return 'not_awaiting_approval';
    if (action === 'externalId' && f.mapped) return 'mapping_exists';
    if (action === 'retry' && !f.resendable) return 'resend_unavailable';
    return 'not_retryable';
  }

  private tabOf(row: IntegrationOutbox, f: Facts): QueueTab {
    if (OPEN_STATUSES.includes(row.status)) return 'queued';
    return needsHuman(row) && !f.res ? 'failed' : 'done';
  }

  private item(row: IntegrationOutbox, f: Facts): ConnectorQueueItemDto {
    const e = (row.lastError ?? null) as ErrorDetail | null;
    const base = commandDto(row);
    const tab = this.tabOf(row, f);
    const res = f.res;
    return {
      ...base,
      tab,
      documentNo: documentNo(row),
      nextRunAt: tab === 'queued' ? row.nextRunAt.toISOString() : null,
      errorMessage: str(e?.message, 500),
      link: typeof e?.link === 'string' && e.link.startsWith('/') ? e.link.slice(0, 300) : null,
      missing: Array.isArray(e?.missing) ? (e.missing as QueueMissingDto[]).slice(0, 50) : [],
      fields: Array.isArray(e?.fields) ? (e.fields as QueueFieldErrorDto[]).slice(0, 50) : [],
      manualExternalIdRequired: e?.manualExternalIdRequired === true,
      guide:
        tab === 'queued' && !row.errorClass ? null : queueGuide(row.errorClass, base.errorCode),
      resolution: res
        ? {
            kind: res.kind,
            reason: res.reason,
            supersededBy: res.supersededBy ? encodeId('outboxCommand', res.supersededBy) : null,
            externalId: res.externalId,
            resolvedBy: res.resolvedBy,
            resolvedAt: res.resolvedAt.toISOString(),
          }
        : null,
      actions: this.actions(row, f),
      bodiesHidden: !canSeeBodies(row.entityType, requestContext.get()?.scopes ?? []),
    };
  }

  private async resolve(
    tx: Tx,
    connectorId: string,
    row: IntegrationOutbox,
    r: { kind: QueueResolutionKind; reason?: string; supersededBy?: string; externalId?: string },
  ) {
    try {
      await tx.connectorQueueResolution.create({
        data: {
          tenantId: row.tenantId,
          connectorId,
          outboxId: row.id,
          kind: r.kind,
          reason: r.reason?.trim() ?? null,
          supersededBy: r.supersededBy ?? null,
          externalId: r.externalId ?? null,
          resolvedBy: requestContext.get()?.actorId ?? null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw notAllowed('already_resolved');
      throw err;
    }
  }

  private async audit(
    tx: Tx,
    connectorId: string,
    action: string,
    row: IntegrationOutbox,
    reason: string | null,
    extra: Record<string, unknown>,
  ) {
    const ctx = requestContext.require();
    const e = (row.lastError ?? null) as ErrorDetail | null;
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId!,
        actorId: ctx.actorId ?? null,
        actAs: ctx.actAs ?? null,
        action,
        entityType: 'connector',
        entityId: connectorId,
        after: {
          commandId: encodeId('outboxCommand', row.id),
          operation: row.operation,
          entityType: row.entityType,
          documentNo: documentNo(row),
          status: row.status,
          errorClass: row.errorClass,
          errorCode: str(e?.code, 60),
          ...extra,
        } as Prisma.InputJsonValue,
        reason: reason?.trim() ?? null,
        requestId: ctx.requestId,
        ip: ctx.ip ?? null,
      },
    });
  }
}

function invalid(field: string, code: string, message: string) {
  return new ProblemException('validation_failed', undefined, [{ field, code, message }]);
}

function notAllowed(why: string) {
  return new ProblemException('queue_action_not_allowed', undefined, undefined, { why });
}

/** เลขเอกสาร TMS จาก payload (canonical `document.number` หรือ `ref.number`) */
function documentNo(row: Pick<IntegrationOutbox, 'payload'>): string | null {
  const p = (row.payload ?? null) as {
    document?: { number?: unknown };
    ref?: { number?: unknown };
  } | null;
  return str(p?.document?.number, 60) ?? str(p?.ref?.number, 60);
}
