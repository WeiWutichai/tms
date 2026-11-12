import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
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
import {
  CleanText,
  IsNullable,
  IsOptionalNotNull,
  MasterListQuery,
  NormalizeCode,
} from '../master/master-kit';

/**
 * หมวดเหตุผลที่เปิดใช้ใน API (ST2-T12; docs/04 B Reason master: ค้างวางแผน / ส่งไม่สำเร็จ / ปฏิเสธรับ / ไม่เซ็นเอกสาร /
 * ล่าช้า / dispute + ยกเลิก (ต้นแบบ TMS v4 เหตุผล "ยกเลิก") + ยกเว้นกฎ (docs/01 §3.2 `OVERRIDE`))
 * `CREDIT_NOTE` / `DEBIT_NOTE` อยู่ใน enum ของฐานแต่ยังไม่เปิด — ต้องมี ETDA purpose code (research §ใบลดหนี้) → ST5
 */
export const REASON_CATEGORIES = [
  'ORDER_HOLD',
  'DELIVERY_FAILED',
  'REJECTED_BY_RECEIVER',
  'POD_MISSING',
  'DELAY',
  'SETTLEMENT_DISPUTE',
  'CANCEL',
  'OVERRIDE',
] as const;
export type ReasonCategoryApi = (typeof REASON_CATEGORIES)[number];

/** นัดส่งใหม่อัตโนมัติ — "ส่งไม่สำเร็จ" เท่านั้น (docs/01 §3.2; CHECK ในฐาน) */
export const AUTO_RESCHEDULE_CATEGORIES: readonly ReasonCategoryApi[] = ['DELIVERY_FAILED'];
/** แสดงบนหน้า tracking ของผู้รับ — เฉพาะเหตุผลหน้างานที่ผู้รับเห็นได้ (ไม่ใช่เหตุภายใน เช่น ใบค้าง/ข้อโต้แย้ง) */
export const TRACKING_CATEGORIES: readonly ReasonCategoryApi[] = [
  'DELIVERY_FAILED',
  'REJECTED_BY_RECEIVER',
  'POD_MISSING',
  'DELAY',
];

const CODE_RE = /^[A-Z0-9][A-Z0-9_\-]{0,39}$/;
const EXT_RE = /^[\x21-\x7e]{1,100}$/;

/** ฟิลด์ที่แก้ได้ (create / PATCH / PUT external) */
export class ReasonCodeFieldsDto {
  @ApiPropertyOptional({ example: 'Shop closed', nullable: true, type: String })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(100)
  labelEn?: string | null;

  @ApiPropertyOptional({ description: 'บังคับแนบรูป (ค่าเริ่มต้น false)' })
  @IsOptionalNotNull()
  @IsBoolean()
  requiresPhoto?: boolean;

  @ApiPropertyOptional({
    description:
      'บังคับกรอกโน้ต (ค่าเริ่มต้น false) — รายการ "อื่น ๆ" ของระบบต้องเป็น true เสมอ (MD-221)',
  })
  @IsOptionalNotNull()
  @IsBoolean()
  requiresNote?: boolean;

  @ApiPropertyOptional({
    description:
      'นัดส่งใหม่อัตโนมัติ (สร้างจุดส่งใหม่วันถัดไป — ST4-T12) ใช้ได้เฉพาะหมวด DELIVERY_FAILED (อื่น → 422 `not_applicable`)',
  })
  @IsOptionalNotNull()
  @IsBoolean()
  autoReschedule?: boolean;

  @ApiPropertyOptional({
    description:
      'แสดงเหตุผลบนหน้า tracking ของผู้รับ — เฉพาะหมวด DELIVERY_FAILED / REJECTED_BY_RECEIVER / POD_MISSING / DELAY (อื่น → 422 `not_applicable`)',
  })
  @IsOptionalNotNull()
  @IsBoolean()
  showOnTracking?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 9998,
    description:
      'ลำดับในหมวด (น้อยขึ้นก่อน) — ไม่ส่งตอนสร้าง = ต่อท้ายหมวด (มากสุด + 10); "อื่น ๆ" ของระบบอยู่ท้ายเสมอ (9999)',
  })
  @IsOptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(9998)
  sortOrder?: number;
}

class RequiredReasonFields extends ReasonCodeFieldsDto {
  @ApiProperty({ enum: REASON_CATEGORIES, description: 'หมวด — เปลี่ยนไม่ได้หลังสร้าง' })
  @IsIn(REASON_CATEGORIES)
  category!: ReasonCategoryApi;

  @ApiProperty({
    example: 'ลูกค้าปิดทำการ',
    description: 'ข้อความเหตุผล — ห้ามซ้ำในหมวด (ไม่สนตัวพิมพ์)',
  })
  @CleanText()
  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  label!: string;
}

export class CreateReasonCodeDto extends RequiredReasonFields {
  @ApiPropertyOptional({
    example: 'SHOP_CLOSED',
    description: 'รหัส (ตัวใหญ่ A-Z 0-9 _ -) ไม่ซ้ำในหมวด — ไม่ส่ง = ระบบออกเลขถัดไป `RSN-0001`',
  })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({ description: 'รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้' })
  @IsOptionalNotNull()
  @Matches(EXT_RE)
  externalId?: string;
}

/** `PUT /reason-codes/external/{externalId}` — ข้อมูลเต็ม (ตอนอัปเดต หมวดต้องเท่าเดิม, รหัสใช้ตอนสร้างเท่านั้น) */
export class UpsertReasonCodeDto extends RequiredReasonFields {
  @ApiPropertyOptional({ example: 'SHOP_CLOSED', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;
}

export class UpdateReasonCodeDto extends ReasonCodeFieldsDto {
  @ApiPropertyOptional({
    example: 'SHOP_CLOSED',
    description: 'รหัสของระบบ (system) เปลี่ยนไม่ได้',
  })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({ example: 'ลูกค้าปิดทำการ' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  label?: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

export class ReasonCodeListQuery extends MasterListQuery {
  @ApiPropertyOptional({
    description: 'หมวด คั่นด้วย , เช่น DELIVERY_FAILED,DELAY',
    example: 'DELIVERY_FAILED',
  })
  @IsOptional()
  @Matches(new RegExp(`^(${REASON_CATEGORIES.join('|')})(,(${REASON_CATEGORIES.join('|')}))*$`))
  category?: string;

  @ApiPropertyOptional({ description: 'ข้อความเหตุผลมีคำนี้' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'true = เฉพาะรหัสของระบบ' })
  @IsOptional()
  @IsIn(['true', 'false'])
  system?: 'true' | 'false';
}

export class ReasonCodeExportQuery extends ReasonCodeListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}

export class ReasonCodeDto {
  @ApiProperty({ example: 'rsn_3f2a…' }) id!: string;
  @ApiProperty({ enum: REASON_CATEGORIES }) category!: ReasonCategoryApi;
  @ApiProperty({ example: 'SHOP_CLOSED' }) code!: string;
  @ApiProperty({ example: 'ลูกค้าปิดทำการ' }) label!: string;
  @ApiProperty({ nullable: true, type: String }) labelEn!: string | null;
  @ApiProperty() requiresPhoto!: boolean;
  @ApiProperty() requiresNote!: boolean;
  @ApiProperty() autoReschedule!: boolean;
  @ApiProperty() showOnTracking!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({
    description:
      'รหัสของระบบ (state machine/งานอัตโนมัติใช้ หรือรายการ "อื่น ๆ" ของหมวด) — ลบ/ปิดใช้/เปลี่ยนรหัสไม่ได้ แก้ข้อความและธงได้',
  })
  system!: boolean;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone)',
  })
  deletedAt?: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ReasonCodePageDto {
  @ApiProperty({ type: [ReasonCodeDto] }) data!: ReasonCodeDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
