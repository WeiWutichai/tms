import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';

export const RESET_POLICIES = ['monthly', 'yearly', 'never'] as const;

export class UpdateSequenceDto {
  @ApiPropertyOptional({
    example: 'INV-{BR}-',
    description:
      'ตัวอักษร/ตัวเลข - _ / . และ {BR} (รหัสสาขา) ไม่เกิน 20 ตัว — เอกสารภาษีต้องมี {BR}',
  })
  @IsOptional()
  @Matches(/^(?:[A-Za-z0-9\-_/.]|\{BR\}){1,20}$/)
  prefix?: string;

  @ApiPropertyOptional({
    enum: RESET_POLICIES,
    description:
      'มีผลทันที — เอกสารภาษีที่งวดนี้ออกเลขไปแล้วเปลี่ยน prefix/รีเซ็ตไม่ได้ (422 series_in_use) จนกว่าจะขึ้นงวดใหม่',
  })
  @IsOptional()
  @IsIn(RESET_POLICIES)
  resetPolicy?: (typeof RESET_POLICIES)[number];
}

export class SequenceDto {
  @ApiProperty({ example: 'seq_…' }) id!: string;
  @ApiProperty({
    enum: ['SO', 'TRIP', 'DO', 'BN', 'INV', 'TXINV', 'RCP', 'CN', 'DN', 'STL', 'WHT', 'WO', 'INC'],
  })
  docType!: string;
  @ApiProperty({ example: 'INV-{BR}-' }) prefix!: string;
  @ApiProperty({ enum: RESET_POLICIES }) resetPolicy!: (typeof RESET_POLICIES)[number];
  @ApiProperty() padding!: number;
  @ApiProperty({ description: 'นับแยกต่อสาขาผู้ออก (เอกสารภาษี)' }) perBranch!: boolean;
  @ApiProperty({ example: '{YYMM}-{NNNN}' }) pattern!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'INV-00000-2611-0042',
    description: 'เลขถัดไปของงวดนี้ (ไม่จอง) — null เมื่อยังไม่มีสาขาออกเอกสาร',
  })
  nextNumber!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class SequenceListDto {
  @ApiProperty({ type: [SequenceDto] }) data!: SequenceDto[];
}
