import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsNullable } from '../master/master-kit';

/** connector ที่แสดงในแท็บ "รหัสระบบบัญชี" ของลูกค้า (ST8-T05) */
export class CustomerErpCodeConnectorDto {
  @ApiProperty({ example: 'con_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' }) id!: string;
  @ApiProperty({ example: 'krs', description: 'รหัส adapter (ป้ายที่มา `ERP:{key}` ของใบ)' })
  adapterKey!: string;
  @ApiProperty({ example: 'KRS', description: 'ชื่อระบบบัญชี' }) displayName!: string;
  @ApiProperty({ enum: ['ACTIVE', 'PAUSED', 'ERROR'] }) status!: string;
}

/**
 * รหัสลูกค้าในระบบบัญชีที่เชื่อมต่อ (ST8-T05; docs/01 §3.7 `external_mapping` entity CUSTOMER, A.4)
 * 1 รายการต่อ connector ที่ยังไม่ยกเลิก — ยังไม่เคยตั้ง = `externalId` null, `version` 0
 */
export class CustomerErpCodeDto {
  @ApiProperty({ type: CustomerErpCodeConnectorDto }) connector!: CustomerErpCodeConnectorDto;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'C0001',
    description:
      'รหัสลูกค้าในระบบบัญชี (ใช้ส่งเอกสาร — KRS: `custOrSuppCode` ของบริษัทที่ออก Invoice) · null = ยังไม่ map → ใบแจ้งหนี้ของลูกค้านี้ส่งเข้าระบบบัญชีไม่ได้',
  })
  externalId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'C0001',
    description:
      'รหัสลูกค้าในข้อมูลขาเข้าของ connector (KRS: รหัสใน SO ของบริษัทที่เปิด SO) — ใบที่ดึงมาด้วยรหัสนี้จับคู่ลูกค้านี้เอง · ' +
      'ได้จากการ "จับคู่ลูกค้า" ที่หน้าใบค้าง (รหัสในระบบบัญชีต้องกรอกเองที่นี่ — [OPEN — KRS A.6] ยังไม่ยืนยันว่าเป็นรหัสเดียวกัน)',
  })
  sourceCode!: string | null;
  @ApiProperty({
    enum: ['SYNCED', 'PENDING', 'FAILED', 'MISMATCH', 'RETIRED', 'UNMAPPED'],
    description:
      'UNMAPPED = ยังไม่มีแถว · PENDING = มีรหัสต้นทางแต่ยังไม่มีรหัสในระบบบัญชี · SYNCED = มีรหัสในระบบบัญชี',
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) updatedAt!: string | null;
  @ApiProperty({ description: 'version ของแถว (ส่งเป็น If-Match ตอน PUT) — ยังไม่เคยตั้ง = 0' })
  version!: number;
}

export class CustomerErpCodeListDto {
  @ApiProperty({ type: [CustomerErpCodeDto] }) data!: CustomerErpCodeDto[];
}

export class SetCustomerErpCodeDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'C0001',
    description:
      'รหัสลูกค้าในระบบบัญชี (1–64 ตัว ไม่มีอักขระควบคุม) · null/ว่าง = ยกเลิก (ใบแจ้งหนี้ส่งเข้าระบบบัญชีไม่ได้จนกว่าตั้งใหม่) · ' +
      'รหัสผูกกับลูกค้าอื่นแล้ว → 409 `external_id_conflict`',
  })
  @IsNullable()
  @IsString()
  @MaxLength(64)
  externalId!: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: 'บัญชียืนยันรหัสลูกค้าใหม่ในระบบบัญชีแล้ว',
    description:
      'บังคับ (≥ 10 ตัวอักษร) เมื่อเปลี่ยนหรือยกเลิกรหัสที่ตั้งไว้แล้ว (422) — บันทึกใน audit',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}
