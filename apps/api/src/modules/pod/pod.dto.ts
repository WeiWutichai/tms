import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  ACTUAL_QTY_NOTE_MAX,
  POD_BARCODES_MAX,
  POD_CUSTOMER_REF_MAX,
  POD_FILES_MAX,
  POD_NOTE_MAX,
  POD_OUTCOMES,
  POD_PHOTOS_MAX,
  POD_REASON_MIN,
  POD_RECEIVER_MAX,
  POD_RELATIONS,
  POD_SCAN_CODE_MAX,
  POD_SOURCES,
  POD_STATUSES,
} from '@tms/domain';
import { CleanText, IsNullable } from '../master/master-kit';
import { EffectivePodChecklistDto } from './pod-checklist.dto';

const DOC_ID = /^doc_[0-9a-f]{32}$/;

/** ST4-T10 ยอดส่งจริงของบรรทัด DO หนึ่งบรรทัด (docs/01 §5.3 `lines[]` — อ้างบรรทัดด้วย `lineNo` ของ DO) */
export class PodLineInputDto {
  @ApiProperty({
    example: 1,
    description: 'ลำดับบรรทัดของ DO (`lines[].lineNo` ของ GET /v1/delivery-orders/{id})',
  })
  @IsInt()
  @Min(1)
  lineNo!: number;

  @ApiProperty({
    example: '90',
    description:
      'จำนวนที่ส่งได้จริง (หน่วยเดียวกับบรรทัด) 0 ≤ ค่า ≤ แผน ทศนิยมไม่เกิน 3 ตำแหน่ง — สตริง (ห้าม float) · เกินแผน → 422 `exceeds_planned`',
  })
  @IsString()
  @Matches(/^\d{1,11}(\.\d{1,3})?$/)
  qtyActual!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '10',
    description:
      'จำนวนที่ผู้รับปฏิเสธ — ไม่ส่งได้ (ระบบคิด = แผน − ส่งจริง) · ส่งมาต้องเท่ากัน ไม่งั้น 422 `reject_qty_mismatch`',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^\d{1,11}(\.\d{1,3})?$/)
  rejectQty?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'rsn_3f2a…',
    description:
      'เหตุผลมาตรฐานหมวด `REJECTED_BY_RECEIVER` (ปฏิเสธรับ/ตีกลับ) — **บังคับเมื่อส่งจริงน้อยกว่าแผน** (ไม่มี → 422 `reason_required`) · ส่งครบแต่ส่งเหตุผลมา → 422 `reason_not_applicable` · เหตุผลที่บังคับรูป = หลักฐานต้องมีรูป ≥ 1 · บังคับโน้ต = ต้องมี `note`',
  })
  @IsOptional()
  @IsNullable()
  @IsString()
  @MaxLength(80)
  rejectReasonCodeId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: ACTUAL_QTY_NOTE_MAX,
    description: 'โน้ตของรายการที่ปฏิเสธ',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(ACTUAL_QTY_NOTE_MAX)
  note?: string | null;
}

/**
 * PUT /v1/delivery-orders/{id}/pod — บันทึกหลักฐานส่งฉบับใหม่ (ST4-T07; docs/01 §5.3 ชื่อช่องเดียวกับ `/driver/stops/{id}/pod`)
 * **ส่งทั้งฉบับ** (ช่องที่ไม่ส่ง = ว่างในฉบับใหม่ ยกเว้น `pin` ที่ไม่ส่ง = คงค่าเดิม) · ไฟล์ต้องอัปโหลดผ่าน `POST /v1/documents` ให้เสร็จ (ready) ก่อน
 */
export class SubmitPodDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: POD_RECEIVER_MAX,
    example: 'สมศรี ใจงาม',
    description: 'ชื่อผู้รับ',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(POD_RECEIVER_MAX)
  receiverName?: string | null;

  @ApiPropertyOptional({
    enum: POD_RELATIONS,
    type: String,
    nullable: true,
    description:
      'ความสัมพันธ์ของผู้รับ: SELF = ผู้รับเอง · SECURITY = รปภ. · STAFF = พนักงาน · OTHER = อื่น ๆ',
  })
  @IsOptional()
  @IsNullable()
  @IsIn(POD_RELATIONS)
  receiverRelation?: (typeof POD_RELATIONS)[number] | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'doc_3f2a…',
    description: 'ลายเซ็นผู้รับ — เอกสาร kind `POD_SIGNATURE` (PNG/JPEG/WebP) ที่อัปโหลดเสร็จแล้ว',
  })
  @IsOptional()
  @IsNullable()
  @Matches(DOC_ID)
  signatureDocumentId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    maxItems: POD_PHOTOS_MAX,
    description: `รูปหลักฐานส่ง — เอกสาร kind \`POD_PHOTO\` (รูป) ไม่เกิน ${POD_PHOTOS_MAX} ใบ ไม่ซ้ำ · นับกับ "รูปขั้นต่ำ" ของ checklist`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POD_PHOTOS_MAX)
  @Matches(DOC_ID, { each: true })
  photoDocumentIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: POD_FILES_MAX,
    description: `ไฟล์อื่น (เช่น ใบส่งของที่เซ็นแล้ว ใบชั่ง) — เอกสาร kind \`POD_FILE\` (PDF/รูป) ไม่เกิน ${POD_FILES_MAX} ไฟล์ · ไม่นับเป็นรูปของ checklist`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POD_FILES_MAX)
  @Matches(DOC_ID, { each: true })
  fileDocumentIds?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '14940',
    description: 'น้ำหนักชั่งปลายทาง (กก.) ทศนิยมไม่เกิน 3 ตำแหน่ง — สตริง (ห้าม float)',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^\d{1,11}(\.\d{1,3})?$/)
  weighedKg?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: POD_CUSTOMER_REF_MAX,
    example: 'GR-2611-0042',
    description:
      'เลขอ้างอิงของลูกค้าตอนรับของ (เช่น เลขใบรับสินค้า) — เก็บในหลักฐานส่ง **ไม่แก้** `customerRef` (เลข PO) ของ DO',
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(POD_CUSTOMER_REF_MAX)
  customerRef?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: POD_NOTE_MAX })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(POD_NOTE_MAX)
  note?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    example: { goods_ok: true },
    description: 'ข้อยืนยัน (BOOLEAN) ตาม key ใน checklist — key ที่ไม่มีใน checklist → 422',
  })
  @IsOptional()
  @IsObject()
  checks?: Record<string, boolean>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { box_state: 'ดี' },
    description: 'คำตอบคำถามเลือกตอบ (SINGLE_CHOICE) ตาม key — ต้องเป็นตัวเลือกในรายการ',
  })
  @IsOptional()
  @IsObject()
  choices?: Record<string, string>;

  @ApiPropertyOptional({
    type: [String],
    maxItems: POD_BARCODES_MAX,
    description: `รหัสบาร์โค้ด/QR ที่สแกนได้ (BARCODE) ยาวไม่เกิน ${POD_SCAN_CODE_MAX} — ชื่อตาม docs/01 §5.3`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POD_BARCODES_MAX)
  @IsString({ each: true })
  @MaxLength(POD_SCAN_CODE_MAX, { each: true })
  barcodes?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: POD_BARCODES_MAX,
    deprecated: true,
    description:
      'ชื่อเดิมของ `barcodes` (spec/04 §13 `Pod.scanCodes[]`) — รับได้เพื่อความเข้ากันได้ · ส่งทั้งสองชื่อต้องเหมือนกัน',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POD_BARCODES_MAX)
  @IsString({ each: true })
  @MaxLength(POD_SCAN_CODE_MAX, { each: true })
  scanCodes?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '4821',
    description:
      'รหัส PIN ที่ผู้รับกรอก (ตัวเลขครบจำนวนหลักตาม checklist) — เก็บแบบเข้ารหัส response แสดงแบบปิดบังเท่านั้น · **ไม่ส่ง = คงค่าของฉบับก่อน** (อ่านค่าจริงคืนไม่ได้) · null = ล้าง',
  })
  @IsOptional()
  @IsNullable()
  @Matches(/^[0-9]{1,8}$/)
  pin?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 10,
    description: 'คะแนนความพึงพอใจของผู้รับ (RATING) 1–คะแนนเต็มของ checklist',
  })
  @IsOptional()
  @IsNullable()
  @IsInt()
  @Min(1)
  @Max(10)
  rating?: number | null;

  @ApiPropertyOptional({
    type: [PodLineInputDto],
    maxItems: 500,
    description:
      'ST4-T10 ยอดส่งจริงต่อรายการ (เฉพาะ DO ที่ส่งแล้ว — ชุดสำเร็จ; DO ส่งไม่สำเร็จ/ตีกลับ → 422 `not_applicable`) · **ไม่ส่ง = คงค่าของฉบับก่อน** · บรรทัดที่ไม่อยู่ในรายการ = คงค่าเดิม (ยังไม่เคยบันทึก = ตามแผน)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PodLineInputDto)
  lines?: PodLineInputDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: POD_REASON_MIN,
    maxLength: 500,
    description: `เหตุผลการแก้ — **บังคับเมื่อมีหลักฐานอยู่แล้ว** (ฉบับที่ 2 ขึ้นไป, ≥ ${POD_REASON_MIN} ตัวอักษร) ลง audit`,
  })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class PodDocumentDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty({ example: 'POD_PHOTO' }) kind!: string;
  @ApiProperty() mime!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class PodMissingDto {
  @ApiProperty({ example: 'photo' }) key!: string;
  @ApiProperty({ example: 'PHOTO' }) type!: string;
  @ApiProperty({ enum: ['required', 'min_count', 'invalid'] }) code!: string;
  @ApiPropertyOptional() expected?: number;
  @ApiPropertyOptional() actual?: number;
  @ApiPropertyOptional() label?: string;
}

export class PodVersionDto {
  @ApiProperty({ example: 2 }) version!: number;
  @ApiProperty({ enum: ['PARTIAL', 'COMPLETE'] }) podStatus!: string;
  @ApiProperty({ enum: POD_SOURCES }) source!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เหตุผลการแก้ (ฉบับแรก = null)' })
  reason!: string | null;
  @ApiProperty({ nullable: true, type: String }) recordedBy!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อผู้ใช้ภายในที่บันทึก' })
  recordedByName!: string | null;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
}

/** ฉบับปัจจุบัน (ล่าสุด) */
export class PodRecordDto extends PodVersionDto {
  @ApiProperty({ enum: POD_OUTCOMES, description: 'ชุด checklist ที่ใช้ตรวจตอนบันทึก' })
  outcome!: string;
  @ApiProperty({ nullable: true, type: String }) receiverName!: string | null;
  @ApiProperty({ enum: POD_RELATIONS, nullable: true, type: String })
  receiverRelation!: string | null;
  @ApiProperty({ type: PodDocumentDto, nullable: true }) signature!: PodDocumentDto | null;
  @ApiProperty({ type: [PodDocumentDto] }) photos!: PodDocumentDto[];
  @ApiProperty({ type: [PodDocumentDto] }) files!: PodDocumentDto[];
  @ApiProperty({ nullable: true, type: String, example: '14940' }) weighedKg!: string | null;
  @ApiProperty({ nullable: true, type: String }) customerRef!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'boolean' } })
  checks!: Record<string, boolean>;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  choices!: Record<string, string>;
  @ApiProperty({ type: [String] }) barcodes!: string[];
  @ApiProperty({
    nullable: true,
    type: String,
    example: '••••',
    description: 'PIN แบบปิดบัง (ไม่มีทางอ่านค่าจริงผ่าน API)',
  })
  pinMasked!: string | null;
  @ApiProperty({
    description:
      'อ่าน PIN ที่เก็บไม่ได้ (กุญแจเข้ารหัสหาย/หมุนผิด) — ยังนับว่ากรอกแล้ว แจ้งผู้ดูแลตรวจกุญแจ',
  })
  pinUnreadable!: boolean;
  @ApiProperty({ nullable: true, type: Number }) rating!: number | null;
  @ApiProperty({ type: [PodMissingDto], description: 'รายการที่ขาดตอนบันทึก' })
  missing!: PodMissingDto[];
}

export class PodLineReasonDto {
  @ApiProperty({ example: 'rsn_3f2a…' }) id!: string;
  @ApiProperty({ example: 'SHORT_QTY' }) code!: string;
  @ApiProperty({ example: 'จำนวนไม่ครบ', description: 'ข้อความ ณ เวลาที่บันทึก (snapshot)' })
  label!: string;
}

/** ST4-T10 บรรทัด DO + ยอดส่งจริงปัจจุบัน (ฉบับล่าสุด) */
export class PodLineDto {
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ example: 'กล่อง' }) unit!: string;
  @ApiProperty({ example: '100' }) qtyPlanned!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '90',
    description: 'null = ยังไม่บันทึก (ถือว่าตามแผน)',
  })
  qtyActual!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '10' }) rejectQty!: string | null;
  @ApiProperty({ type: PodLineReasonDto, nullable: true }) rejectReason!: PodLineReasonDto | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
}

/** GET/PUT /v1/delivery-orders/{id}/pod */
export class DeliveryOrderPodDto {
  @ApiProperty({ example: 'do_…' }) deliveryOrderId!: string;
  @ApiProperty({ example: 'DO-2611-00052' }) doNo!: string;
  @ApiProperty({
    example: 'UNBILLED',
    description: 'สถานะ DO (ตัวใหญ่ — เหมือน GET /v1/delivery-orders/{id})',
  })
  doStatus!: string;
  @ApiProperty({ enum: POD_STATUSES }) podStatus!: string;
  @ApiProperty({
    description: 'บันทึก/แก้หลักฐานได้ในสถานะ DO ปัจจุบัน (ส่งแล้ว/ส่งไม่สำเร็จ ยังไม่วางบิล)',
  })
  editable!: boolean;
  @ApiProperty({ nullable: true, type: String, example: '15000', description: 'น้ำหนักตามใบสั่ง' })
  plannedWeightKg!: string | null;
  @ApiProperty({
    type: EffectivePodChecklistDto,
    description: 'checklist ที่ใช้จริงตอนนี้ (ชุดตามสถานะ DO: ส่งไม่สำเร็จ = ชุดไม่สำเร็จ)',
  })
  checklist!: EffectivePodChecklistDto;
  @ApiProperty({
    type: [PodMissingDto],
    description: 'เทียบหลักฐานปัจจุบันกับ checklist ตอนนี้ (ว่าง = ครบ)',
  })
  missing!: PodMissingDto[];
  @ApiProperty({
    type: PodRecordDto,
    nullable: true,
    description: 'ฉบับปัจจุบัน — null = ยังไม่มี',
  })
  current!: PodRecordDto | null;
  @ApiProperty({ type: [PodVersionDto], description: 'ทุกฉบับ ใหม่ → เก่า' })
  versions!: PodVersionDto[];
  @ApiProperty({
    type: [PodLineDto],
    description: 'ST4-T10 บรรทัดของ DO (แผน vs ส่งจริง vs ปฏิเสธ + เหตุผล) ตามฉบับล่าสุด',
  })
  lines!: PodLineDto[];
}
