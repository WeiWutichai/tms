import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsDecimal } from '../../common/validation';
import {
  CleanText,
  IsNullable,
  IsOptionalNotNull,
  MasterListQuery,
  NormalizeCode,
} from '../master/master-kit';

/** ชนิดหน่วย (spec/02 §3 `kind` count/weight/volume) — ชื่อไทยอยู่ใน i18n ของเว็บ */
export const UNIT_KINDS = ['COUNT', 'WEIGHT', 'VOLUME'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** รหัสหน่วย string(10) (spec/02 §3) — ตัวใหญ่/ตัวเลข/._- */
const UNIT_CODE_RE = /^[A-Z0-9][A-Z0-9_\-.]{0,9}$/;

class UnitFieldsDto {
  @ApiPropertyOptional({
    example: 1000,
    nullable: true,
    type: Number,
    description: 'WEIGHT: 1 หน่วย = ? กก. (บังคับเมื่อ kind=WEIGHT, ตัน = 1000) · ชนิดอื่นต้องว่าง',
  })
  @IsNullable()
  @IsDecimal(6)
  @Min(0.000001)
  @Max(99_999_999)
  toKg?: number | null;

  @ApiPropertyOptional({
    example: 0.001,
    nullable: true,
    type: Number,
    description:
      'VOLUME: 1 หน่วย = ? ลบ.ม. (บังคับเมื่อ kind=VOLUME, ลิตร = 0.001) · ชนิดอื่นต้องว่าง',
  })
  @IsNullable()
  @IsDecimal(6)
  @Min(0.000001)
  @Max(99_999_999)
  toCbm?: number | null;
}

export class CreateUnitDto extends UnitFieldsDto {
  @ApiProperty({ example: 'DRUM', description: 'รหัสหน่วย ≤ 10 ตัว (ไม่สนตัวพิมพ์ — เก็บตัวใหญ่)' })
  @NormalizeCode()
  @IsString()
  @Matches(UNIT_CODE_RE)
  code!: string;

  @ApiProperty({ example: 'ถัง', description: 'ชื่อหน่วย — ห้ามซ้ำ (ไม่สนตัวพิมพ์)' })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  name!: string;

  @ApiProperty({
    enum: UNIT_KINDS,
    description:
      'COUNT = นับจำนวน (ชิ้น ถุง พาเลท), WEIGHT = น้ำหนัก (ต้องมี toKg), VOLUME = ปริมาตร (ต้องมี toCbm)',
  })
  @IsIn(UNIT_KINDS)
  kind!: UnitKind;
}

/** แก้หน่วย — หน่วยมาตรฐานของระบบแก้ได้เฉพาะชื่อ; หน่วยที่สินค้าใช้อยู่เปลี่ยนชนิด/ตัวแปลงไม่ได้ */
export class UpdateUnitDto extends UnitFieldsDto {
  @ApiPropertyOptional({ example: 'DRUM' })
  @IsOptionalNotNull()
  @NormalizeCode()
  @IsString()
  @Matches(UNIT_CODE_RE)
  code?: string;

  @ApiPropertyOptional({ example: 'ถัง' })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  name?: string;

  @ApiPropertyOptional({ enum: UNIT_KINDS })
  @IsOptionalNotNull()
  @IsIn(UNIT_KINDS)
  kind?: UnitKind;
}

export class UnitListQuery extends MasterListQuery {
  @ApiPropertyOptional({ enum: UNIT_KINDS })
  @IsOptional()
  @IsIn(UNIT_KINDS)
  kind?: UnitKind;
}

export class UnitDto {
  @ApiProperty({ example: 'unt_3f2a…' }) id!: string;
  @ApiProperty({ example: 'BAG' }) code!: string;
  @ApiProperty({ example: 'ถุง' }) name!: string;
  @ApiProperty({ enum: UNIT_KINDS }) kind!: UnitKind;
  @ApiProperty({ nullable: true, type: Number, example: null }) toKg!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: null }) toCbm!: number | null;
  @ApiProperty({
    description: 'หน่วยมาตรฐานของระบบ (ชุดเริ่มต้น) — ลบไม่ได้ แก้ได้เฉพาะชื่อ ปิดใช้ได้',
  })
  system!: boolean;
  @ApiProperty({ description: 'จำนวนสินค้าที่ใช้หน่วยนี้ (หน่วยหลักหรือหน่วยแปลง, ไม่นับที่ลบ)' })
  products!: number;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
  @ApiPropertyOptional({ format: 'date-time', nullable: true, type: String })
  deletedAt?: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class UnitPageDto {
  @ApiProperty({ type: [UnitDto] }) data!: UnitDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
