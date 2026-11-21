import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CleanText } from '../master/master-kit';

/** ชนิดผลค้นหา — ลำดับนี้ = ลำดับกลุ่มที่ส่งกลับ */
export const SEARCH_TYPES = [
  'order',
  'deliveryOrder',
  'trip',
  'invoice',
  'billingNote',
  'customer',
  'vehicle',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** ตรงกับช่องไหน — `number` = เลขเอกสาร · `po` = เลข PO ลูกค้า · `plate` ทะเบียน · `name`/`code` ลูกค้า */
export const SEARCH_MATCH = ['number', 'po', 'plate', 'name', 'code'] as const;
export type SearchMatch = (typeof SEARCH_MATCH)[number];

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 64;

export class SearchQuery {
  @ApiProperty({
    minLength: SEARCH_MIN,
    maxLength: SEARCH_MAX,
    example: '2611-00',
    description:
      'คำค้น (ตัดช่องว่างหน้า-หลัง) — ค้นแบบ "มีคำนี้อยู่" ไม่สนตัวพิมพ์ ใน: เลข SO / DO / เที่ยว / ใบแจ้งหนี้ / ใบวางบิล, ' +
      'เลข PO ลูกค้า (SO/DO `customerRef`, ใบแจ้งหนี้ `customerPoNo`), ทะเบียนรถ (เทียบแบบ normalize: เลขไทย → อารบิก ตัดช่องว่าง/ขีด/จุด), ' +
      'ชื่อ/รหัสลูกค้า',
  })
  @CleanText()
  @IsString()
  @MinLength(SEARCH_MIN)
  @MaxLength(SEARCH_MAX)
  q!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 10, default: 5, description: 'จำนวนสูงสุดต่อชนิด' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

export class SearchHitDto {
  @ApiProperty({ enum: SEARCH_TYPES })
  type!: SearchType;

  @ApiProperty({
    example: 'do_3f2a…',
    description: 'id ของเอกสาร/ข้อมูลหลัก (prefix ตามชนิด: ord / do / trp / ivc / bn / cus / veh)',
  })
  id!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'DO-2611-0042',
    description:
      'ข้อความหลัก — เลขเอกสาร · ทะเบียน · ชื่อลูกค้า (null = ร่างที่ยังไม่มีเลข เจอจากเลข PO)',
  })
  label!: string | null;

  @ApiProperty({ enum: SEARCH_MATCH })
  matchedOn!: SearchMatch;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'DELIVERED',
    description:
      'สถานะตามชนิด (SO ตัวเล็กตาม OrderDto · DO/เที่ยว/ใบแจ้งหนี้/ใบวางบิล ตัวใหญ่ตาม enum · รถ/ลูกค้า ตัวเล็ก)',
  })
  status!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ชื่อลูกค้า (SO/DO/ใบแจ้งหนี้/ใบวางบิล)',
  })
  customerName!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'เลข PO ลูกค้า (SO/DO/ใบแจ้งหนี้)' })
  customerRef!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ทะเบียนรถ (เที่ยว: ณ วันจ่ายงาน · รถ)',
  })
  plate!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'ประเภทรถ (รถ)' })
  vehicleType!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'คนขับประจำ (รถ)' })
  driverName!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'รหัสลูกค้า (ลูกค้า)' })
  code!: string | null;

  @ApiProperty({ description: 'ใบแจ้งหนี้มีธงเกินกำหนด (ST5-T18) — ชนิดอื่น = false' })
  overdue!: boolean;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'SO ของ DO (`ord_…`) — ชนิดอื่น = null',
  })
  orderId!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เที่ยวของ DO (`trp_…`) — ยังไม่จัด/ชนิดอื่น = null',
  })
  tripId!: string | null;
}

export class SearchResultDto {
  @ApiProperty({ example: '2611-00', description: 'คำค้นหลังตัดช่องว่าง' })
  q!: string;

  @ApiProperty({
    type: [String],
    enum: SEARCH_TYPES,
    description:
      'ชนิดที่ค้นให้ตามสิทธิ์ของผู้เรียก (ชนิดที่ไม่มีสิทธิ์อ่าน = ไม่ค้นและไม่อยู่ในรายการนี้)',
  })
  searched!: SearchType[];

  @ApiProperty({
    type: [SearchHitDto],
    description: 'เรียงตามชนิด แล้วตรงทั้งคำ → ขึ้นต้นด้วย → มีอยู่ → แก้ล่าสุด',
  })
  data!: SearchHitDto[];
}
