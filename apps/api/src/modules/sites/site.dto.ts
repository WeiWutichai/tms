import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CustomerAddressDto } from '../customers/customer.dto';
import {
  cleanLine,
  CleanText,
  IsNullable,
  IsOptionalNotNull,
  MasterListQuery,
  NormalizeCode,
} from '../master/master-kit';

/** ประเภทสถานที่ — ต้นแบบ TMS v4: ต้นทาง / ปลายทาง / คลัง / ศูนย์กระจาย [OPEN spec/12 §3: spec/02 `type` 8 ค่า] */
export const SITE_KINDS = ['PICKUP', 'DROPOFF', 'WAREHOUSE'] as const;
/** ตัวกรองสถานะพิกัด (ST2-T03) — REVIEW = PENDING ที่มีพิกัดเสนอรอคนยืนยัน */
export const GEOCODE_FILTERS = ['OK', 'REVIEW', 'PENDING', 'FAILED'] as const;
/** รถเข้าได้สูงสุด (เรียงจากเล็กไปใหญ่) — ต้นแบบ: 6 ล้อ / 10 ล้อ / พ่วง / เทรลเลอร์ · ผูก vehicle_type ใน ST2-T04 */
export const VEHICLE_CLASSES = ['6W', '10W', 'TRAILER', 'SEMI_TRAILER'] as const;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** ที่อยู่สถานที่ — โครงเดียวกับที่อยู่ลูกค้า (`line1` บังคับ, ช่องแยกไม่บังคับ — MD-009) */
export class SiteAddressDto extends CustomerAddressDto {}

/** ผู้ติดต่อหน้างาน (docs/01 §3.2 `contact` jsonb) */
export class SiteContactDto {
  @ApiProperty({ example: 'คุณวิไล' })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: '02-300-4100' })
  @IsOptionalNotNull()
  @CleanText()
  @Matches(/^\+?[0-9][0-9 \-]{5,24}$/)
  phone?: string;

  @ApiPropertyOptional({ example: 'receiving@example.co.th' })
  @IsOptionalNotNull()
  @IsEmail()
  @MaxLength(200)
  email?: string;
}

/** alias: ตัดช่องว่าง/อักขระมองไม่เห็น, ทิ้งค่าว่าง, ตัดซ้ำแบบไม่สนตัวพิมพ์ (คงลำดับ) */
const CleanAliases = () =>
  Transform(({ value }: { value: unknown }) => {
    if (!Array.isArray(value)) return value;
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const v of value) {
      if (typeof v !== 'string') {
        out.push(v);
        continue;
      }
      const c = cleanLine(v);
      if (!c || seen.has(c.toLowerCase())) continue;
      seen.add(c.toLowerCase());
      out.push(c);
    }
    return out;
  });

/** ฟิลด์ที่แก้ได้ (ใช้ร่วม create / PATCH / PUT external) — `name`, `address` ประกาศในแต่ละ DTO */
export class SiteFieldsDto {
  @ApiPropertyOptional({
    enum: SITE_KINDS,
    description: 'PICKUP = ต้นทาง, DROPOFF = ปลายทาง (ค่าเริ่มต้น), WAREHOUSE = คลัง / ศูนย์กระจาย',
  })
  @IsOptionalNotNull()
  @IsIn(SITE_KINDS)
  kind?: (typeof SITE_KINDS)[number];

  @ApiPropertyOptional({
    example: 'cus_…',
    nullable: true,
    type: String,
    description: 'ลูกค้าเจ้าของจุด — null = จุดของบริษัทเอง (คลัง/ลานจอด) ใช้ได้กับทุกลูกค้า',
  })
  @IsNullable()
  @IsString()
  customerId?: string | null;

  @ApiPropertyOptional({
    example: 13.417,
    nullable: true,
    type: Number,
    description: 'ละติจูด (ส่งคู่กับ lng) — มีพิกัด → geocodeStatus OK, null ทั้งคู่ → PENDING',
  })
  @IsNullable()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat?: number | null;

  @ApiPropertyOptional({ example: 101.001, nullable: true, type: Number })
  @IsNullable()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng?: number | null;

  @ApiPropertyOptional({
    minimum: 50,
    maximum: 2000,
    description: 'รัศมี geofence (เมตร) — ค่าเริ่มต้น 200 (spec/02 §2)',
  })
  @IsOptionalNotNull()
  @IsInt()
  @Min(50)
  @Max(2000)
  geofenceRadiusM?: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 50,
    example: ['โรงงานสยามพลาสติก', 'SPC ชลบุรี'],
    description:
      'ชื่อเรียกอื่น — ค้นหา `q` เจอด้วย alias และใช้จับคู่ข้อความปลายทางอัตโนมัติ (ST3-T06)',
  })
  @IsOptionalNotNull()
  @CleanAliases()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(150, { each: true })
  aliases?: string[];

  @ApiPropertyOptional({ example: '08:00', nullable: true, type: String, description: 'HH:MM' })
  @IsNullable()
  @Matches(HHMM)
  openTime?: string | null;

  @ApiPropertyOptional({
    example: '17:00',
    nullable: true,
    type: String,
    description: 'HH:MM — น้อยกว่า openTime = ปิดวันถัดไป (ข้ามเที่ยงคืน); ว่างทั้งคู่ = 24 ชม.',
  })
  @IsNullable()
  @Matches(HHMM)
  closeTime?: string | null;

  @ApiPropertyOptional({
    enum: VEHICLE_CLASSES,
    nullable: true,
    description:
      'รถเข้าได้สูงสุด: 6W = 6 ล้อ, 10W = 10 ล้อ, TRAILER = พ่วง, SEMI_TRAILER = เทรลเลอร์ · null = ไม่จำกัด',
  })
  @IsNullable()
  @IsIn(VEHICLE_CLASSES)
  maxVehicleClass?: (typeof VEHICLE_CLASSES)[number] | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 720,
    nullable: true,
    type: Number,
    description: 'service time — เวลาขึ้น/ลงของโดยประมาณ (นาที)',
  })
  @IsNullable()
  @IsInt()
  @Min(0)
  @Max(720)
  serviceTimeMin?: number | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1440,
    nullable: true,
    type: Number,
    description: 'free time ค่ารอที่จุดนี้ (นาที) — null = ใช้ค่าของลูกค้า/องค์กร',
  })
  @IsNullable()
  @IsInt()
  @Min(0)
  @Max(1440)
  freeTimeMin?: number | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 999,
    nullable: true,
    type: Number,
    description:
      'ช่องโหลด (loading bays) — ใช้กับคลัง/ต้นทาง (docs/04 B คลัง, spec/02 §2 dockCount) · null = ไม่ระบุ',
  })
  @IsNullable()
  @IsInt()
  @Min(0)
  @Max(999)
  dockCount?: number | null;

  @ApiPropertyOptional({ type: SiteContactDto, nullable: true })
  @IsNullable()
  @ValidateNested()
  @Type(() => SiteContactDto)
  contact?: SiteContactDto | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000, description: 'หมายเหตุ' })
  @IsNullable()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : value,
  )
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class CreateSiteDto extends SiteFieldsDto {
  @ApiProperty({ example: 'โรงงานสยามพลาสติก ชลบุรี', maxLength: 150 })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiProperty({ type: SiteAddressDto })
  @ValidateNested()
  @Type(() => SiteAddressDto)
  address!: SiteAddressDto;

  @ApiPropertyOptional({
    example: 'LOC-00001',
    description: 'รหัสสถานที่ — ไม่ส่ง = ระบบออกเลขถัดไป (MD-002)',
  })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(/^[A-Z0-9][A-Z0-9_\-./]{0,19}$/)
  code?: string;

  @ApiPropertyOptional({ description: 'รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้' })
  @IsOptionalNotNull()
  @Matches(/^[\x21-\x7e]{1,100}$/)
  externalId?: string;
}

export class UpdateSiteDto extends SiteFieldsDto {
  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ type: SiteAddressDto })
  @IsOptionalNotNull()
  @ValidateNested()
  @Type(() => SiteAddressDto)
  address?: SiteAddressDto;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(/^[\x21-\x7e]{1,100}$/)
  externalId?: string | null;
}

/** `PUT /customer-sites/external/{externalId}` — ข้อมูลเต็ม (ฟิลด์ที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertSiteDto extends SiteFieldsDto {
  @ApiProperty({ maxLength: 150 })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiProperty({ type: SiteAddressDto })
  @ValidateNested()
  @Type(() => SiteAddressDto)
  address!: SiteAddressDto;

  @ApiPropertyOptional({ example: 'LOC-00001', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(/^[A-Z0-9][A-Z0-9_\-./]{0,19}$/)
  code?: string;
}

export class SiteListQuery extends MasterListQuery {
  @ApiPropertyOptional({ enum: SITE_KINDS })
  @IsOptional()
  @IsIn(SITE_KINDS)
  kind?: (typeof SITE_KINDS)[number];

  @ApiPropertyOptional({
    description: 'กรองตามลูกค้า (cus_…) หรือ `none` = เฉพาะจุดของบริษัทเอง',
  })
  @IsOptional()
  @Matches(/^(none|cus_[0-9a-f]{32})$/)
  customerId?: string;

  @ApiPropertyOptional({ description: 'ชื่อลูกค้ามีคำนี้' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  customerName?: string;

  @ApiPropertyOptional({
    description: 'alias ตรงตัว (ไม่สนตัวพิมพ์) — ใช้จับคู่ข้อความปลายทางกับสถานที่',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(150)
  alias?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'true = มีพิกัด, false = ยังไม่ปักหมุด',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  pinned?: 'true' | 'false';

  @ApiPropertyOptional({
    enum: GEOCODE_FILTERS,
    description:
      'สถานะพิกัด: OK = มีพิกัด · REVIEW = รอยืนยันพิกัดที่ geocode เสนอ · PENDING = ยังไม่มีพิกัดและไม่มีข้อเสนอ · FAILED = หาพิกัดไม่พบ',
  })
  @IsOptional()
  @IsIn(GEOCODE_FILTERS)
  geocode?: (typeof GEOCODE_FILTERS)[number];

  @ApiPropertyOptional({ enum: VEHICLE_CLASSES })
  @IsOptional()
  @IsIn(VEHICLE_CLASSES)
  maxVehicleClass?: (typeof VEHICLE_CLASSES)[number];
}

export class SiteExportQuery extends SiteListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^loc_[0-9a-f]{32}(,loc_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

export class SiteCustomerRefDto {
  @ApiProperty({ example: 'cus_…' }) id!: string;
  @ApiProperty({ example: 'CUS-0001' }) code!: string;
  @ApiProperty() name!: string;
}

/** พิกัดที่ geocode เสนอ รอคนยืนยัน (ST2-T03) — ยืนยันแล้วย้ายไป lat/lng + geocodeStatus OK */
export class SiteGeocodeProposalDto {
  @ApiProperty({ example: 13.3612 }) lat!: number;
  @ApiProperty({ example: 100.9847 }) lng!: number;
  @ApiProperty({ minimum: 0, maximum: 1, example: 0.8, description: 'ความมั่นใจ 0–1' })
  confidence!: number;
  @ApiProperty({ example: 'mock', description: 'ผู้ให้บริการที่เสนอ' }) provider!: string;
  @ApiProperty({ format: 'date-time' }) at!: string;
}

export class SiteDto {
  @ApiProperty({ example: 'loc_3f2a…' }) id!: string;
  @ApiProperty({ example: 'LOC-00001' }) code!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ enum: SITE_KINDS }) kind!: (typeof SITE_KINDS)[number];
  @ApiProperty() name!: string;
  @ApiProperty({ type: SiteAddressDto }) address!: SiteAddressDto;
  @ApiProperty({
    type: SiteCustomerRefDto,
    nullable: true,
    description: 'null = จุดของบริษัทเอง',
  })
  customer!: SiteCustomerRefDto | null;
  @ApiProperty({ nullable: true, type: Number }) lat!: number | null;
  @ApiProperty({ nullable: true, type: Number }) lng!: number | null;
  @ApiProperty({
    enum: ['OK', 'PENDING', 'FAILED'],
    description:
      'OK = มีพิกัดแล้ว (กรอกเอง/ยืนยันแล้ว) · PENDING = ยังไม่ปักหมุด (รอ geocode หรือรอคนยืนยัน geocodeProposal) · ' +
      'FAILED = geocode ไม่พบ/คนปฏิเสธพิกัดที่เสนอ → ต้องปักหมุดเอง',
  })
  geocodeStatus!: 'OK' | 'PENDING' | 'FAILED';
  @ApiProperty({
    type: SiteGeocodeProposalDto,
    nullable: true,
    description:
      'พิกัดที่ geocode อัตโนมัติเสนอ รอคนยืนยัน (มีค่าเฉพาะเมื่อ geocodeStatus = PENDING) — ' +
      'ยืนยันด้วย POST /customer-sites/{id}/geocode/confirm, ปฏิเสธด้วย /geocode/reject',
  })
  geocodeProposal!: SiteGeocodeProposalDto | null;
  @ApiProperty() geofenceRadiusM!: number;
  @ApiProperty({ type: [String] }) aliases!: string[];
  @ApiProperty({ nullable: true, type: String }) openTime!: string | null;
  @ApiProperty({ nullable: true, type: String }) closeTime!: string | null;
  @ApiProperty({ enum: VEHICLE_CLASSES, nullable: true })
  maxVehicleClass!: (typeof VEHICLE_CLASSES)[number] | null;
  @ApiProperty({ nullable: true, type: Number }) serviceTimeMin!: number | null;
  @ApiProperty({ nullable: true, type: Number }) freeTimeMin!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'ช่องโหลด (คลัง/ต้นทาง)' })
  dockCount!: number | null;
  @ApiProperty({ type: SiteContactDto, nullable: true }) contact!: SiteContactDto | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
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

export class SitePageDto {
  @ApiProperty({ type: [SiteDto] }) data!: SiteDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class SiteKindCountDto {
  @ApiProperty() PICKUP!: number;
  @ApiProperty() DROPOFF!: number;
  @ApiProperty() WAREHOUSE!: number;
}

export class SiteSummaryDto {
  @ApiProperty({ description: 'ทั้งหมด (ไม่รวมที่ลบ)' }) total!: number;
  @ApiProperty({ description: 'มีพิกัดแล้ว' }) pinned!: number;
  @ApiProperty({ description: 'ยังไม่ปักหมุด' }) unpinned!: number;
  @ApiProperty({ description: 'จำกัดประเภทรถ (เข้าได้สูงสุด 6 ล้อ/10 ล้อ)' }) restricted!: number;
  @ApiProperty({ description: 'รอยืนยันพิกัดที่ geocode เสนอ (ST2-T03)' }) geocodeReview!: number;
  @ApiProperty({ description: 'หาพิกัดจากที่อยู่ไม่พบ — ต้องปักหมุดเอง (ST2-T03)' })
  geocodeFailed!: number;
  @ApiProperty({ type: SiteKindCountDto }) byKind!: SiteKindCountDto;
  @ApiProperty() active!: number;
  @ApiProperty() inactive!: number;
}

/** ยืนยันพิกัดที่ geocode เสนอ — เหตุผล/บันทึกไม่บังคับ (ลง audit) */
export class ConfirmGeocodeDto {
  @ApiPropertyOptional({ maxLength: 500, example: 'ตรวจกับ Street View แล้ว ตรงประตูทางเข้า' })
  @IsOptional()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

/** ประมาณพิกัดจากที่อยู่ (ปุ่ม "ประมาณจากที่อยู่" ในฟอร์มสถานที่) */
export class GeocodeRequestDto {
  @ApiProperty({ maxLength: 500, example: '99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110' })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address!: string;
}

export class GeocodeCandidateDto {
  @ApiProperty() lat!: number;
  @ApiProperty() lng!: number;
  @ApiProperty({ minimum: 0, maximum: 1 }) confidence!: number;
  @ApiProperty({ description: 'ข้อความที่ผู้ให้บริการจับคู่ได้' }) label!: string;
}

export class GeocodeResultDto {
  @ApiProperty({
    example: 'mock',
    description:
      'ผู้ให้บริการที่ใช้ (`none` = ยังไม่ได้ตั้งค่า → candidates ว่างเสมอ ให้ปักหมุดเอง)',
  })
  provider!: string;
  @ApiProperty({
    type: [GeocodeCandidateDto],
    description: 'เรียงความมั่นใจมาก → น้อย · ว่าง = หาไม่พบ',
  })
  candidates!: GeocodeCandidateDto[];
}
