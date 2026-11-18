import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { CleanText, IsNullable, IsOptionalNotNull } from '../master/master-kit';

/** key ของหน้า — ตัวพิมพ์เล็ก ตัวเลข `_ . -` (เช่น `orders`, `orders.hold`, `vehicles`) */
export const PAGE_KEY = /^[a-z][a-z0-9_.-]{0,39}$/;
/** key ของตัวกรอง/คอลัมน์ในมุมมอง */
export const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
export const MAX_HIDDEN = 60;
const PAGE_DESC =
  'key ของหน้าจอ (ที่ใช้ในเว็บ: `orders` ใบสั่งขนส่ง · `orders.hold` ใบค้าง · `vehicles` ทะเบียนรถ)';

export class SavedViewListQuery extends ListQuery {
  @ApiProperty({ example: 'orders', description: PAGE_DESC })
  @IsString()
  @Matches(PAGE_KEY)
  page!: string;
}

export class CreateSavedViewDto {
  @ApiProperty({ example: 'orders', description: PAGE_DESC })
  @IsString()
  @Matches(PAGE_KEY)
  page!: string;

  @ApiProperty({ example: 'ของฉันวันนี้', maxLength: 60 })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
    example: { tab: 'all', q: 'SO-2569', source: 'API', overdue: false },
    description:
      'ตัวกรอง/แท็บของหน้า — object แบน ≤ 40 key (key ตามรูป `FIELD_KEY`), ค่า string ≤ 200 / number / boolean / null, ' +
      'ขนาดรวม ≤ 4,000 ตัวอักษร · ความหมายของ key ขึ้นกับหน้า (เว็บอ่านเฉพาะ key ที่รู้จัก)',
  })
  @IsObject()
  state!: Record<string, string | number | boolean | null>;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    example: ['source'],
    description: 'key คอลัมน์ที่ซ่อน · null/ไม่ส่ง = ตามค่าเริ่มต้นของตาราง',
  })
  @IsNullable()
  @IsArray()
  @ArrayMaxSize(MAX_HIDDEN)
  @IsString({ each: true })
  @Matches(FIELD_KEY, { each: true })
  hiddenColumns?: string[] | null;

  @ApiPropertyOptional({
    default: false,
    description:
      'เปิดหน้านี้ครั้งแรก (ต่อแท็บเบราว์เซอร์) ใช้มุมมองนี้ — ได้ 1 มุมมองต่อหน้า (ตั้งใหม่ = ยกเลิกอันเดิม)',
  })
  @IsOptionalNotNull()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateSavedViewDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
    description: 'แทนทั้งก้อน (กฎเดียวกับตอนสร้าง)',
  })
  @IsOptionalNotNull()
  @IsObject()
  state?: Record<string, string | number | boolean | null>;

  @ApiPropertyOptional({ type: [String], nullable: true, description: 'null = ตามค่าเริ่มต้น' })
  @IsNullable()
  @IsArray()
  @ArrayMaxSize(MAX_HIDDEN)
  @IsString({ each: true })
  @Matches(FIELD_KEY, { each: true })
  hiddenColumns?: string[] | null;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  isDefault?: boolean;
}

export class SavedViewDto {
  @ApiProperty({ example: 'svw_3f2a9c1e0b7d4e8f9a6b5c4d3e2f1a0b' })
  id!: string;
  @ApiProperty({ example: 'orders' })
  page!: string;
  @ApiProperty({ example: 'ของฉันวันนี้' })
  name!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
  })
  state!: Record<string, string | number | boolean | null>;
  @ApiProperty({ type: [String], nullable: true })
  hiddenColumns!: string[] | null;
  @ApiProperty()
  isDefault!: boolean;
  @ApiProperty({ example: 1 })
  version!: number;
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class SavedViewPageDto {
  @ApiProperty({ type: [SavedViewDto] })
  data!: SavedViewDto[];
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
  @ApiProperty()
  hasMore!: boolean;
}
