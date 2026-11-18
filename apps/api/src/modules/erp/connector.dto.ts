import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CONNECTOR_KEY_RE, CONNECTOR_STATUSES, ERP_CAPABILITIES } from '@tms/domain';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
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
  MasterOptionalReasonDto,
  MasterReasonDto,
} from '../master/master-kit';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ERP_CODE_EXAMPLE = 'PP01';

export class ConnectorConfigFieldDto {
  @ApiProperty({ example: 'baseUrl' }) key!: string;
  @ApiProperty({ description: 'credential — ไม่ส่งค่ากลับ, แสดงได้แค่ "ตั้งแล้ว"' })
  secret!: boolean;
  @ApiProperty() required!: boolean;
  @ApiProperty({ enum: ['string', 'url'] }) kind!: 'string' | 'url';
  @ApiProperty({ nullable: true, type: Number }) maxLength!: number | null;
  @ApiProperty({
    nullable: true,
    type: [String],
    description: 'ค่าที่เลือกได้ (null = กรอกอิสระ) — ค่านอกรายการ → 422 `invalid_option`',
  })
  options!: string[] | null;
}

/** adapter ที่เปิดเป็น connector ได้ (catalog ในโค้ด — ไม่มีตัวใดเป็นค่าเริ่มต้น, spec/07 INT-010) */
export class ErpAdapterDto {
  @ApiProperty({ example: 'demo', description: '`adapterKey` ที่ใช้ตอนสร้าง connector' })
  key!: string;
  @ApiProperty({ example: 'Demo ERP' }) displayName!: string;
  @ApiProperty({
    description:
      'true = ERP จำลอง (DemoProvider — สำหรับสาธิต/ทดสอบ ไม่ส่งข้อมูลไปที่ใด) · มีเฉพาะ dev/test/staging ที่เปิด `ERP_DEMO_ADAPTERS` — หน้าจอต้องติดป้าย "จำลอง"',
  })
  demo!: boolean;
  @ApiProperty({
    type: [String],
    enum: ERP_CAPABILITIES,
    description: 'capability ที่ adapter รองรับ (docs/01 §6.1) — UI แสดงเฉพาะที่อยู่ในรายการนี้',
  })
  capabilities!: string[];
  @ApiProperty({ type: [ConnectorConfigFieldDto] }) configFields!: ConnectorConfigFieldDto[];
}

export class ErpAdapterListDto {
  @ApiProperty({ type: [ErpAdapterDto] }) data!: ErpAdapterDto[];
}

/** ST7-T22 webhook ขาเข้าของ connector (ไม่มีค่า token — แสดงครั้งเดียวตอนออก/หมุน) */
export class ConnectorInboundDto {
  @ApiProperty({
    description:
      'adapter รับ webhook ขาเข้าได้ไหม (false = ออก token ไม่ได้ — 409 `inbound_not_supported`)',
  })
  supported!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'whin_Q2x9',
    description: 'ส่วนต้นของ token ปัจจุบัน · null = ยังไม่เปิดรับ (ไม่มี URL)',
  })
  tokenPrefix!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) tokenRotatedAt!:
    string | null;
}

export class ConnectorDto {
  @ApiProperty({ example: 'con_8f3a…' }) id!: string;
  @ApiProperty({ example: 'demo' }) adapterKey!: string;
  @ApiProperty({
    example: 'Demo ERP',
    nullable: true,
    type: String,
    description: 'null = adapter ไม่ได้ติดตั้งในระบบนี้',
  })
  displayName!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'cmp_…',
    description:
      'นิติบุคคลที่ใช้ connector นี้ (Invoice As / Tender As) · null = ทุกนิติบุคคลที่ไม่มีของตัวเอง',
  })
  companyId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: ERP_CODE_EXAMPLE }) erpCompanyCode!:
    string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { brn_8f3a: 'PP01-BKK' },
    description: 'สาขา TMS → รหัสบริษัท/สาขาฝั่ง ERP (ไม่มี = ใช้ erpCompanyCode)',
  })
  branchMap!: Record<string, string>;
  @ApiProperty({ enum: CONNECTOR_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String }) statusReason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) statusChangedAt!:
    string | null;
  @ApiProperty({
    type: [String],
    enum: ERP_CAPABILITIES,
    description: 'capability ที่ adapter รองรับทั้งหมด',
  })
  capabilitiesSupported!: string[];
  @ApiProperty({ type: [String], enum: ERP_CAPABILITIES, description: 'ที่ tenant เปิด' })
  capabilitiesEnabled!: string[];
  @ApiProperty({
    type: [String],
    enum: ERP_CAPABILITIES,
    description: 'ใช้ได้จริง = รองรับ ∩ เปิด (ว่างเมื่อยกเลิกการเชื่อม)',
  })
  capabilities!: string[];
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'ค่าตั้งที่ไม่ลับ (base URL ฯลฯ)',
  })
  settings!: Record<string, string>;
  @ApiProperty({
    type: [String],
    example: ['apiKey'],
    description: 'ชื่อช่อง credential ที่ตั้งแล้ว — ค่าไม่ส่งกลับเด็ดขาด',
  })
  credentialKeys!: string[];
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) credentialsUpdatedAt!:
    string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date', example: '2026-12-01' })
  syncFromDate!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastHealthAt!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) lastHealthOk!: boolean | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: '{errorClass, code, message} ของ healthCheck ล่าสุดที่ล้ม',
  })
  lastHealthError!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) activatedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) disconnectedAt!:
    string | null;
  @ApiProperty({ type: ConnectorInboundDto }) inbound!: ConnectorInboundDto;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

/** ST7-T22 ผลการออก/หมุน token — `token`/`url` แสดงครั้งเดียว */
export class InboundTokenDto {
  @ApiProperty({
    example: 'whin_Q2x9…',
    description: 'token ใหม่ (แสดงครั้งเดียว ระบบเก็บเฉพาะ hash) — token เดิมใช้ไม่ได้ทันที',
  })
  token!: string;
  @ApiProperty({
    example: 'https://api.example.com/v1/inbound/demo/whin_Q2x9…',
    description: 'URL ที่ตั้งในระบบต้นทาง (ERP) ให้ส่ง webhook มา',
  })
  url!: string;
  @ApiProperty({ example: 'whin_Q2x9' }) tokenPrefix!: string;
  @ApiProperty({ format: 'date-time' }) tokenRotatedAt!: string;
  @ApiProperty({ type: ConnectorDto }) connector!: ConnectorDto;
}

export class ConnectorListDto {
  @ApiProperty({ type: [ConnectorDto] }) data!: ConnectorDto[];
}

export class ConnectorListQuery {
  @ApiPropertyOptional({
    enum: CONNECTOR_STATUSES,
    description: 'ไม่ระบุ = ทุกสถานะยกเว้น DISCONNECTED',
  })
  @IsOptional()
  @IsIn(CONNECTOR_STATUSES)
  status?: string;
}

export class CreateConnectorDto {
  @ApiProperty({
    example: 'demo',
    pattern: CONNECTOR_KEY_RE.source,
    description: 'จาก GET /connectors/adapters',
  })
  @IsString()
  @Matches(CONNECTOR_KEY_RE)
  adapterKey!: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'cmp_…',
    description: 'ไม่ส่ง/null = ทุกนิติบุคคล',
  })
  @IsNullable()
  @IsString()
  companyId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 64, example: ERP_CODE_EXAMPLE })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(64)
  erpCompanyCode?: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptionalNotNull()
  @IsObject()
  branchMap?: Record<string, string>;

  @ApiPropertyOptional({
    type: [String],
    enum: ERP_CAPABILITIES,
    description: 'ไม่ส่ง = เปิดทุกตัวที่ adapter รองรับ',
  })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(ERP_CAPABILITIES.length)
  @IsIn(ERP_CAPABILITIES, { each: true })
  capabilitiesEnabled?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'ค่าที่ไม่ลับตาม configFields',
  })
  @IsOptionalNotNull()
  @IsObject()
  settings?: Record<string, string>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'ช่อง secret ตาม configFields — เก็บเข้ารหัส ไม่ส่งกลับ',
  })
  @IsOptionalNotNull()
  @IsObject()
  credentials?: Record<string, string>;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date',
    description: '≤ วันนี้ (เวลาไทย)',
  })
  @IsNullable()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  syncFromDate?: string | null;
}

/** แก้ค่าตั้ง (ไม่แก้นิติบุคคล/adapter — ยกเลิกแล้วสร้างใหม่) */
export class UpdateConnectorDto {
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 64 })
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(64)
  erpCompanyCode?: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptionalNotNull()
  @IsObject()
  branchMap?: Record<string, string>;

  @ApiPropertyOptional({ type: [String], enum: ERP_CAPABILITIES })
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(ERP_CAPABILITIES.length)
  @IsIn(ERP_CAPABILITIES, { each: true })
  capabilitiesEnabled?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'แทนค่าที่ไม่ลับทั้งชุด',
  })
  @IsOptionalNotNull()
  @IsObject()
  settings?: Record<string, string>;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date' })
  @IsNullable()
  @Matches(DATE_ONLY)
  @IsISO8601({ strict: true })
  syncFromDate?: string | null;
}

export class ConnectorCredentialsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'credential ชุดใหม่ (แทนทั้งชุด) — ช่อง secret ที่บังคับต้องครบ',
  })
  @IsObject()
  credentials!: Record<string, string>;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
  reason?: string;
}

export class ConnectorActionDto extends MasterOptionalReasonDto {}
export class ConnectorReasonDto extends MasterReasonDto {}

export class ConnectorHealthDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty({ nullable: true, type: String, example: 'AUTH' }) errorClass!: string | null;
  @ApiProperty({ nullable: true, type: String }) code!: string | null;
  @ApiProperty({ nullable: true, type: String }) message!: string | null;
  @ApiProperty({ format: 'date-time' }) checkedAt!: string;
  @ApiProperty({ type: ConnectorDto }) connector!: ConnectorDto;
}

export class EffectiveConnectorQuery {
  @ApiPropertyOptional({
    example: 'cmp_…',
    description:
      'นิติบุคคล — ไม่ระบุทั้งนิติบุคคลและสาขา = ค่าเริ่มต้นระดับ tenant (connector ทุกนิติบุคคล หรือ Standalone)',
  })
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional({ example: 'brn_…' })
  @IsOptional()
  @IsString()
  branchId?: string;

  @ApiPropertyOptional({
    enum: ['invoice', 'tender'],
    default: 'invoice',
    description: 'ออกบิลในนาม / จ้างในนาม',
  })
  @IsOptional()
  @IsIn(['invoice', 'tender'])
  kind?: 'invoice' | 'tender';
}

/** connector ที่เอกสารของนิติบุคคล/สาขาใช้ (routing ตามนิติบุคคล) — standalone = ไม่มี */
const SYNC_MODES = ['NOT_APPLICABLE', 'PUSH', 'REPLACE', 'MANUAL'];

/** docs/01 §6.1 — PUSH = ส่งด้วย method ของประเภทนั้น · REPLACE = ใบปรับส่งเป็นภาพรวมหลังปรับ · MANUAL = SKIPPED + แจ้งบัญชีทำมือ */
export class DocumentSyncDto {
  @ApiProperty({ enum: SYNC_MODES }) invoice!: string;
  @ApiProperty({ enum: SYNC_MODES }) creditNote!: string;
  @ApiProperty({ enum: SYNC_MODES }) debitNote!: string;
  @ApiProperty({ enum: SYNC_MODES }) settlement!: string;
}

export class EffectiveConnectorDto {
  @ApiProperty({ description: 'true = ไม่เชื่อม ERP (ทุก flow ทำใน TMS)' }) standalone!: boolean;
  @ApiProperty({ nullable: true, type: String }) connectorId!: string | null;
  @ApiProperty({ example: 'standalone' }) adapterKey!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty({
    description:
      'false = adapter ของ connector ไม่ได้ติดตั้ง/ปิดใน environment นี้ (เช่น demo ใน production) — ไม่ส่ง/ไม่ดึง',
  })
  adapterAvailable!: boolean;
  @ApiProperty({ nullable: true, enum: CONNECTOR_STATUSES }) status!: string | null;
  @ApiProperty({
    type: [String],
    enum: ERP_CAPABILITIES,
    description: 'ใช้ได้จริง (UI แสดงเฉพาะที่อยู่ในรายการนี้)',
  })
  capabilities!: string[];
  @ApiProperty({
    type: DocumentSyncDto,
    description:
      'มีขั้น sync ไหมต่อประเภทเอกสาร (ST7-T14) — `NOT_APPLICABLE` = ไม่แสดงสถานะ sync, เอกสารเดินสถานะใน TMS เอง (invoice ISSUED → PAID ไม่มี SENT)',
  })
  documentSync!: DocumentSyncDto;
  @ApiProperty({ description: 'ส่ง/ดึงได้ตอนนี้ (ACTIVE) — false = เอกสารเข้าคิวรอ' })
  sending!: boolean;
  @ApiProperty({ enum: ['company', 'tenant', 'none'] }) scope!: string;
  @ApiProperty({ nullable: true, type: String }) erpCompanyCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'cmp_…',
    description: 'นิติบุคคลที่ routing เลือก (null = ไม่ได้ระบุ — ค่าระดับ tenant)',
  })
  companyId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'brn_…' }) branchId!: string | null;
}

/** ST7-T22 ผลการรับ webhook ขาเข้า */
export class InboundReceiptDto {
  @ApiProperty({ example: true }) received!: boolean;
  @ApiProperty({
    description: 'true = event นี้ (provider + eventKey เดิม) เคยรับแล้ว — ไม่ประมวลผลซ้ำ',
  })
  duplicate!: boolean;
  @ApiProperty({ example: 'ibe_8f3a…', description: 'รายการใน ledger' }) id!: string;
}

// ---------- ST7-T20 คำสั่งที่ส่งผ่าน connector (บันทึกการซิงก์ย่อ) + Platform Console ----------

const COMMAND_STATUSES = [
  'PENDING',
  'IN_FLIGHT',
  'DONE',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'SKIPPED',
] as const;

export class ConnectorCommandQuery {
  @ApiPropertyOptional({ enum: COMMAND_STATUSES })
  @IsOptional()
  @IsIn(COMMAND_STATUSES)
  status?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * คำสั่ง 1 รายการในคิว outbox ของ connector (sink `erp`) — ไม่มี payload/ผลลัพธ์ดิบ (request/response log ตัด secret = ST7-T19)
 */
export class ConnectorCommandDto {
  @ApiProperty({ example: 'obx_…' }) id!: string;
  @ApiProperty({ example: 'PUSH_INVOICE' }) operation!: string;
  @ApiProperty({ example: 'invoice' }) entityType!: string;
  @ApiProperty({ description: 'id ของเอกสารใน TMS (uuid)' }) localId!: string;
  @ApiProperty({ enum: COMMAND_STATUSES }) status!: string;
  @ApiProperty() attempt!: number;
  @ApiProperty({ nullable: true, type: String, example: 'TRANSIENT' }) errorClass!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'รหัสผิดพลาดล่าสุด (ไม่มีข้อความดิบ)' })
  errorCode!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) doneAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ConnectorCommandListDto {
  @ApiProperty({ type: [ConnectorCommandDto] }) data!: ConnectorCommandDto[];
}
