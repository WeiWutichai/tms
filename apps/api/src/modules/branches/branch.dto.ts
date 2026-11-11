import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ListQuery } from '../../common/pagination';

/** ที่อยู่ตาม ภ.พ.20 (docs/01 §3.1 branch.address) */
const trimStr = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AddressDto {
  @ApiProperty({ example: '88/12 ถนนบางนา-ตราด กม. 12' })
  @Transform(trimStr)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  line1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string;

  @ApiProperty({ example: 'บางพลีใหญ่' })
  @Transform(trimStr)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  subdistrict!: string;

  @ApiProperty({ example: 'บางพลี' })
  @Transform(trimStr)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  district!: string;

  @ApiProperty({ example: 'สมุทรปราการ' })
  @Transform(trimStr)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  province!: string;

  @ApiProperty({ example: '10540' })
  @Matches(/^\d{5}$/)
  postcode!: string;
}

export class CreateBranchDto {
  @ApiProperty({ example: 'cmp_…', description: 'นิติบุคคลเจ้าของสาขา' })
  @IsString()
  companyId!: string;

  @ApiProperty({ example: '00000', description: 'รหัสสาขา 5 หลัก (00000 = สำนักงานใหญ่)' })
  @Matches(/^\d{5}$/)
  branchCode!: string;

  @ApiPropertyOptional({
    example: 'สำนักงานใหญ่',
    description: 'ข้อความที่พิมพ์บนเอกสาร — ไม่ส่ง = "สำนักงานใหญ่" / "สาขาที่ 00001"',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  branchLabel?: string;

  @ApiProperty({ type: AddressDto })
  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;

  @ApiPropertyOptional({
    default: true,
    description:
      'สาขานี้ออกใบกำกับภาษีในนามตัวเอง — false = สำนักงานใหญ่ออกแทน (hq_prints_for_all ต่อสาขา)',
  })
  @IsOptional()
  @IsBoolean()
  issuesTaxInvoice?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'สาขาที่ใช้ออกเอกสารถ้าไม่ระบุ (1 ต่อนิติบุคคล)',
  })
  @IsOptional()
  @IsBoolean()
  isDefaultIssuer?: boolean;
}

export class UpdateBranchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  branchLabel?: string;

  @ApiPropertyOptional({ type: AddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  issuesTaxInvoice?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefaultIssuer?: boolean;
}

export class BranchListQuery extends ListQuery {
  @ApiPropertyOptional({ description: 'กรองตามนิติบุคคล (cmp_…)' })
  @IsOptional()
  @IsString()
  companyId?: string;
}

export class BranchDto {
  @ApiProperty({ example: 'brn_…' }) id!: string;
  @ApiProperty({ example: 'cmp_…' }) companyId!: string;
  @ApiProperty({ example: '00000' }) branchCode!: string;
  @ApiProperty() branchLabel!: string;
  @ApiProperty({ type: AddressDto }) address!: AddressDto;
  @ApiProperty({ description: 'ออกใบกำกับภาษีในนามสาขานี้ (สำนักงานใหญ่ = true เสมอ)' })
  issuesTaxInvoice!: boolean;
  @ApiProperty() isDefaultIssuer!: boolean;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class BranchPageDto {
  @ApiProperty({ type: [BranchDto] }) data!: BranchDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
