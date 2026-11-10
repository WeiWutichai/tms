import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { isValidThaiTaxId } from '../../common/thai-tax-id';

@ValidatorConstraint({ name: 'thai_tax_id' })
class ThaiTaxIdConstraint implements ValidatorConstraintInterface {
  validate(v: unknown) {
    return typeof v === 'string' && isValidThaiTaxId(v);
  }
  defaultMessage() {
    return 'taxId must be a valid 13-digit Thai tax ID';
  }
}

export class CreateCompanyDto {
  @ApiProperty({
    example: 'บริษัท ศรีไทยขนส่ง จำกัด',
    description: 'ชื่อตามจดทะเบียน (พิมพ์บนใบกำกับภาษี)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName!: string;

  @ApiPropertyOptional({ example: 'Srithai Transport Co., Ltd.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalNameEn?: string;

  @ApiProperty({ example: '0105536000014', description: 'เลขประจำตัวผู้เสียภาษี 13 หลัก' })
  @Validate(ThaiTaxIdConstraint)
  taxId!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  vatRegistered?: boolean;

  @ApiPropertyOptional({ description: 'รหัสฝั่งระบบภายนอก (ERP) — เรียกด้วย ext:{externalId} ได้' })
  @IsOptional()
  @IsString()
  @Matches(/^[\x21-\x7e]{1,100}$/)
  externalId?: string;
}

export class UpdateCompanyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalNameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  vatRegistered?: boolean;
}

export class StatusChangeDto {
  @ApiProperty({
    description: 'เหตุผล (บังคับทุกการเปลี่ยนสถานะ — ลง audit)',
    example: 'ปิดบริษัทในเครือ',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class CompanyListQuery extends ListQuery {
  @ApiPropertyOptional({ description: 'คั่นด้วย , เช่น active,inactive' })
  @IsOptional()
  @Matches(/^(active|inactive)(,(active|inactive))*$/)
  status?: string;
}

export class CompanyDto {
  @ApiProperty({ example: 'cmp_3f2a…' }) id!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty({ nullable: true, type: String }) legalNameEn!: string | null;
  @ApiProperty() taxId!: string;
  @ApiProperty() vatRegistered!: boolean;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: 'active' | 'inactive';
  @ApiProperty({ nullable: true, type: String }) externalId!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class CompanyPageDto {
  @ApiProperty({ type: [CompanyDto] }) data!: CompanyDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export const COMPANY_STATUSES = ['active', 'inactive'] as const;
