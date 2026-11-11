import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
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

const CODE_RE = /^[A-Z0-9][A-Z0-9_\-./]{0,19}$/;
const EXT_RE = /^[\x21-\x7e]{1,100}$/;
const SITE_ID_RE = /^loc_[0-9a-f]{32}$/;
/** ระยะทางสูงสุดที่รับ (กม.) — numeric(8,1) */
export const MAX_DISTANCE_KM = 9_999_999.9;
/** เวลามาตรฐานสูงสุด 7 วัน (นาที) */
export const MAX_STANDARD_MINUTES = 10_080;
/** เงิน: ไม่ติดลบ ≤ 12 หลัก ทศนิยม ≤ 2 (numeric(14,2)) — รูปแบบเดียวกับเอกสารรถ */
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;

const NotesText = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : value,
  );

/** ฟิลด์ที่แก้ได้ทุกแบบ (create / PATCH / PUT external) — ช่องบังคับประกาศใน DTO ของแต่ละแบบ */
export class RouteFieldsDto {
  @ApiPropertyOptional({
    example: 150,
    nullable: true,
    type: Number,
    description: 'เวลาเดินทางมาตรฐาน (นาที) 1–10,080 · null = ไม่ระบุ',
  })
  @IsNullable()
  @IsInt()
  @Min(1)
  @Max(MAX_STANDARD_MINUTES)
  standardMinutes?: number | null;

  @ApiPropertyOptional({
    example: '120.00',
    nullable: true,
    type: String,
    description:
      'ค่าผ่านทางต่อเที่ยว (บาท) เป็นข้อความ ทศนิยม ≤ 2 ตำแหน่ง ≥ 0 (เงินห้ามใช้ float) · null = ไม่มี/ไม่ระบุ',
  })
  @IsNullable()
  @Matches(MONEY_RE)
  tollAmount?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000, description: 'หมายเหตุ' })
  @IsNullable()
  @NotesText()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

class RequiredRouteFields extends RouteFieldsDto {
  @ApiProperty({ example: 'loc_3f2a…', description: 'ต้นทาง (สถานที่ — `customer-sites`)' })
  @Matches(SITE_ID_RE)
  originId!: string;

  @ApiProperty({
    example: 'loc_8c1d…',
    description: 'ปลายทาง (สถานที่) — ต้องต่างจากต้นทาง · คู่ต้นทาง→ปลายทางห้ามซ้ำ (ทิศทางมีผล)',
  })
  @Matches(SITE_ID_RE)
  destinationId!: string;

  @ApiProperty({
    example: 95,
    description: 'ระยะทางอ้างอิง (กม.) > 0 ทศนิยม ≤ 1 ตำแหน่ง — ราคาแบบต่อ กม. ใช้ค่านี้',
  })
  @IsNumber({ maxDecimalPlaces: 1, allowNaN: false, allowInfinity: false })
  @Min(0.1)
  @Max(MAX_DISTANCE_KM)
  distanceKm!: number;
}

export class CreateRouteDto extends RequiredRouteFields {
  @ApiPropertyOptional({
    example: 'BKK-CBI',
    description: 'รหัส — ไม่ส่ง = ระบบออกเลขถัดไป `RT-0001` (MD-002)',
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

/** `PUT /routes/external/{externalId}` — ข้อมูลเต็ม (ฟิลด์ไม่บังคับที่ไม่ส่งตอนอัปเดต = คงเดิม) */
export class UpsertRouteDto extends RequiredRouteFields {
  @ApiPropertyOptional({ example: 'BKK-CBI', description: 'ใช้ตอนสร้างเท่านั้น' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @Matches(CODE_RE)
  code?: string;
}

export class UpdateRouteDto extends RouteFieldsDto {
  @ApiPropertyOptional({ example: 'loc_3f2a…' })
  @IsOptionalNotNull()
  @Matches(SITE_ID_RE)
  originId?: string;

  @ApiPropertyOptional({ example: 'loc_8c1d…' })
  @IsOptionalNotNull()
  @Matches(SITE_ID_RE)
  destinationId?: string;

  @ApiPropertyOptional({ example: 95 })
  @IsOptionalNotNull()
  @IsNumber({ maxDecimalPlaces: 1, allowNaN: false, allowInfinity: false })
  @Min(0.1)
  @Max(MAX_DISTANCE_KM)
  distanceKm?: number;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'null = ลบการผูก' })
  @IsNullable()
  @Matches(EXT_RE)
  externalId?: string | null;
}

export class RouteListQuery extends MasterListQuery {
  @ApiPropertyOptional({ description: 'ต้นทางตรงตัว (id สถานที่)' })
  @IsOptional()
  @Matches(SITE_ID_RE)
  originId?: string;

  @ApiPropertyOptional({ description: 'ปลายทางตรงตัว (id สถานที่)' })
  @IsOptional()
  @Matches(SITE_ID_RE)
  destinationId?: string;

  @ApiPropertyOptional({ description: 'สถานที่นี้เป็นต้นทางหรือปลายทาง (id สถานที่)' })
  @IsOptional()
  @Matches(SITE_ID_RE)
  siteId?: string;

  @ApiPropertyOptional({
    description: 'ชื่อ/รหัสต้นทางหรือปลายทางมีคำนี้ (ตัวกรองคอลัมน์ "เส้นทาง")',
  })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  route?: string;
}

export class RouteExportQuery extends RouteListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง' })
  @IsOptional()
  @Matches(/^rte_[0-9a-f]{32}(,rte_[0-9a-f]{32}){0,199}$/)
  ids?: string;
}

/** ระยะทาง/เวลาโดยประมาณจากพิกัดของสถานที่ (ปุ่ม "คำนวณจากพิกัด") — ไม่บันทึกอะไร */
export class RouteEstimateRequestDto {
  @ApiProperty({ example: 'loc_3f2a…' })
  @Matches(SITE_ID_RE)
  originId!: string;

  @ApiProperty({ example: 'loc_8c1d…' })
  @Matches(SITE_ID_RE)
  destinationId!: string;
}

export class RouteEstimateDto {
  @ApiProperty({
    enum: ['ok', 'no_coords', 'unavailable'],
    description:
      'ok = ได้ระยะทาง (ให้ผู้ใช้ตรวจแล้วบันทึก) · no_coords = สถานที่ยังไม่ปักหมุด · unavailable = ผู้ให้บริการแผนที่ไม่รองรับ/ขัดข้อง → กรอกเอง',
  })
  result!: 'ok' | 'no_coords' | 'unavailable';
  @ApiProperty({ nullable: true, type: Number, example: 95.4 }) distanceKm!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: 120 }) standardMinutes!: number | null;
  @ApiProperty({ example: 'mock', description: 'ผู้ให้บริการที่ใช้คำนวณ' }) provider!: string;
}

export class RouteSiteRefDto {
  @ApiProperty({ example: 'loc_3f2a…' }) id!: string;
  @ApiProperty({ example: 'LOC-00001' }) code!: string;
  @ApiProperty({ example: 'คลังสินค้าบางนา' }) name!: string;
  @ApiProperty({ enum: ['PICKUP', 'DROPOFF', 'WAREHOUSE'] }) kind!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
}

export class RouteDto {
  @ApiProperty({ example: 'rte_3f2a…' }) id!: string;
  @ApiProperty({ example: 'RT-0001' }) code!: string;
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty({ type: RouteSiteRefDto }) origin!: RouteSiteRefDto;
  @ApiProperty({ type: RouteSiteRefDto }) destination!: RouteSiteRefDto;
  @ApiProperty({ example: 95, description: 'ระยะทาง (กม.)' }) distanceKm!: number;
  @ApiProperty({ nullable: true, type: Number, example: 150 }) standardMinutes!: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '120.00',
    description: 'ค่าผ่านทาง (บาท) เป็นข้อความทศนิยม 2 ตำแหน่ง (เงิน ห้ามใช้ float)',
  })
  tollAmount!: string | null;
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

export class RoutePageDto {
  @ApiProperty({ type: [RouteDto] }) data!: RouteDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class RouteSummaryDto {
  @ApiProperty({ description: 'เส้นทางทั้งหมด (ไม่รวมที่ลบ)' }) total!: number;
  @ApiProperty() active!: number;
  @ApiProperty() inactive!: number;
  @ApiProperty({ description: 'เส้นทางที่มีค่าผ่านทาง > 0' }) withToll!: number;
  @ApiProperty({ description: 'เส้นทางที่ยังไม่ระบุเวลามาตรฐาน' }) noStandardTime!: number;
}
