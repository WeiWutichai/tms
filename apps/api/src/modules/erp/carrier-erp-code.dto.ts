import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsNullable } from '../master/master-kit';
import { CustomerErpCodeConnectorDto } from './customer-erp-code.dto';

/**
 * รหัสรถร่วม (ผู้ขาย/เจ้าหนี้) ในระบบบัญชีที่เชื่อมต่อ (ST7-T15; docs/01 §3.7 `external_mapping` entity CARRIER, §7.3–7.4)
 * 1 รายการต่อ connector ที่ยังไม่ยกเลิก — ยังไม่เคยตั้ง = `externalId` null, `version` 0
 */
export class CarrierErpCodeDto {
  @ApiProperty({ type: CustomerErpCodeConnectorDto }) connector!: CustomerErpCodeConnectorDto;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'V0001',
    description:
      'รหัสรถร่วม (ผู้ขาย/เจ้าหนี้) ในระบบบัญชี — ใช้ส่งใบสำคัญจ่าย (`carrier.externalId` ของ canonical) · ' +
      'null = ยังไม่ map → ระบบบัญชีที่บังคับรหัสผู้ขายจะรับใบสำคัญจ่ายของรถร่วมนี้ไม่ได้ (ระบบที่จับคู่เองได้ เช่น ด้วยเลขผู้เสียภาษี ยังส่งได้)',
  })
  externalId!: string | null;
  @ApiProperty({
    enum: ['SYNCED', 'PENDING', 'FAILED', 'MISMATCH', 'RETIRED', 'UNMAPPED'],
    description: 'UNMAPPED = ยังไม่มีแถว · PENDING = ล้างรหัสแล้ว · SYNCED = มีรหัสในระบบบัญชี',
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) updatedAt!: string | null;
  @ApiProperty({ description: 'version ของแถว (ส่งเป็น If-Match ตอน PUT) — ยังไม่เคยตั้ง = 0' })
  version!: number;
}

export class CarrierErpCodeListDto {
  @ApiProperty({ type: [CarrierErpCodeDto] }) data!: CarrierErpCodeDto[];
}

export class SetCarrierErpCodeDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'V0001',
    description:
      'รหัสรถร่วมในระบบบัญชี (1–64 ตัว ไม่มีอักขระควบคุม) · null/ว่าง = ยกเลิก · ' +
      'รหัสผูกกับรถร่วมอื่นแล้ว → 409 `external_id_conflict`',
  })
  @IsNullable()
  @IsString()
  @MaxLength(64)
  externalId!: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: 'บัญชียืนยันรหัสผู้ขายใหม่ในระบบบัญชีแล้ว',
    description:
      'บังคับ (≥ 10 ตัวอักษร) เมื่อเปลี่ยนหรือยกเลิกรหัสที่ตั้งไว้แล้ว (422) — บันทึกใน audit',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}
