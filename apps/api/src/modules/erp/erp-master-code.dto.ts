import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ERP_MASTER_CODE_KINDS } from '@tms/domain';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsNullable } from '../master/master-kit';

/** รหัส 1 ตัวในผังรหัส ERP ของ connector (ST7-T18; docs/01 §7.4 `erp_master_code`) */
export class ErpMasterCodeDto {
  @ApiProperty({ enum: ERP_MASTER_CODE_KINDS }) kind!: string;
  @ApiProperty({ example: 'SV-FRT-01' }) code!: string;
  @ApiProperty({ nullable: true, type: String, example: 'ค่าขนส่ง' }) name!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '7.00',
    description:
      'เฉพาะ VAT_RATE: อัตรา % ของรหัสนี้ฝั่ง ERP (ข้อมูลอ้างอิงให้ adapter — ไม่เปลี่ยนการคำนวณภาษีของ TMS)',
  })
  rate!: string | null;
  @ApiProperty({
    enum: ['ADAPTER', 'IMPORT'],
    description: 'ADAPTER = ซิงก์จาก ERP · IMPORT = นำเข้าไฟล์',
  })
  source!: string;
  @ApiProperty({
    description: 'false = ไม่มีใน ERP แล้ว (ซิงก์ล่าสุด) หรือปิดจากไฟล์ — ใช้จับคู่ไม่ได้',
  })
  active!: boolean;
  @ApiProperty({ format: 'date-time' }) syncedAt!: string;
}

export class ErpMasterCodeListDto {
  @ApiProperty({ type: [ErpMasterCodeDto] }) data!: ErpMasterCodeDto[];
}

export class ErpMasterCodeListQuery {
  @ApiPropertyOptional({ enum: ERP_MASTER_CODE_KINDS })
  @IsOptional()
  @IsIn(ERP_MASTER_CODE_KINDS)
  kind?: string;

  @ApiPropertyOptional({ description: 'true = รวมรหัสที่ปิดใช้แล้ว' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  includeInactive?: boolean;
}

export class ErpMasterSyncDto {
  @ApiPropertyOptional({
    type: [String],
    enum: ERP_MASTER_CODE_KINDS,
    description:
      'ชนิดที่ซิงก์ (ไม่ส่ง = ทุกชนิดที่ adapter ดึงได้) — ชนิดที่ adapter ดึงไม่ได้ → 422',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ERP_MASTER_CODE_KINDS.length)
  @IsIn(ERP_MASTER_CODE_KINDS, { each: true })
  kinds?: string[];

  @ApiPropertyOptional({
    description:
      'true = ยอมรับเมื่อ ERP ส่งชุดว่างมาสำหรับชนิดที่มีรหัสใช้งานอยู่ (ปิดใช้ทั้งชุด) · ไม่ส่ง = ถือว่าล้ม (409 `master_sync_failed` reason `empty_catalogue`)',
  })
  @IsOptional()
  @IsBoolean()
  confirmEmpty?: boolean;
}

export class ErpMasterSyncKindResultDto {
  @ApiProperty({ enum: ERP_MASTER_CODE_KINDS }) kind!: string;
  @ApiProperty({ description: 'จำนวนรหัสที่ ERP ส่งมา (ที่ใช้ได้)' }) fetched!: number;
  @ApiProperty() created!: number;
  @ApiProperty({ description: 'มีอยู่แล้วและเปลี่ยนชื่อ/อัตรา/กลับมาใช้งาน' }) updated!: number;
  @ApiProperty({ description: 'ไม่มีใน ERP แล้ว → ปิดใช้ (ไม่ลบ)' }) deactivated!: number;
  @ApiProperty({ description: 'แถวที่ ERP ส่งมาแต่รูปแบบผิด/ซ้ำ (ข้าม)' }) skipped!: number;
}

export class ErpMasterSyncResultDto {
  @ApiProperty({ type: [ErpMasterSyncKindResultDto] }) results!: ErpMasterSyncKindResultDto[];
  @ApiProperty({ format: 'date-time' }) syncedAt!: string;
}

export class ErpMappingServiceItemDto {
  @ApiProperty({ example: 'svc_0f9c…' }) id!: string;
  @ApiProperty({ example: 'FREIGHT' }) code!: string;
  @ApiProperty({ example: 'ค่าขนส่ง' }) nameTh!: string;
  @ApiProperty({ enum: ['VAT_7', 'EXEMPT_TRANSPORT', 'ZERO_RATED'] }) vatType!: string;
  @ApiProperty({
    enum: ['SELL', 'BUY', 'BOTH'],
    description: 'ฝั่งซื้อใช้กับ settlement รถร่วม (PUSH_SETTLEMENT ก็ตรวจ mapping)',
  })
  side!: string;
  @ApiProperty({
    enum: ['ACTIVE', 'INACTIVE'],
    description: 'ปิดใช้แล้วยังจับคู่ได้ (อยู่บนเอกสารเก่า)',
  })
  status!: string;
}

/** 1 แถวของหน้า mapping "ค่าบริการ TMS ↔ รหัสสินค้า ERP" */
export class ErpItemMappingDto {
  @ApiProperty({ type: ErpMappingServiceItemDto }) serviceItem!: ErpMappingServiceItemDto;
  @ApiProperty({ nullable: true, type: String, example: 'SV-FRT-01' }) itemCode!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อรหัสจากผังรหัส ERP (ถ้ามี)' })
  itemName!: string | null;
  @ApiProperty({
    enum: ['MAPPED', 'UNMAPPED', 'CODE_UNKNOWN'],
    description:
      'UNMAPPED = ยังไม่จับคู่ · CODE_UNKNOWN = รหัสไม่อยู่ในผังรหัสสินค้าที่ใช้งานของ connector — ทั้งสองแบบทำให้เอกสารที่ใช้รายการนี้ส่งเข้า ERP ไม่ได้',
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) updatedAt!: string | null;
  @ApiProperty({
    description: 'version ของการจับคู่ (ส่งเป็น If-Match ตอน PUT) — ยังไม่เคยตั้ง = 0',
  })
  version!: number;
}

export class ErpMappingSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty() mapped!: number;
  @ApiProperty({ description: 'UNMAPPED + CODE_UNKNOWN' }) missing!: number;
  @ApiProperty({
    description:
      'จำนวนรหัสสินค้า (ITEM) ที่ใช้งานในผังรหัสของ connector — 0 = ยังไม่มีผังรหัส (รับรหัสที่กรอก ERP ตรวจตอนรับ)',
  })
  itemCodes!: number;
}

export class ErpItemMappingListDto {
  @ApiProperty({ type: [ErpItemMappingDto] }) data!: ErpItemMappingDto[];
  @ApiProperty({ type: ErpMappingSummaryDto }) summary!: ErpMappingSummaryDto;
}

export class SetErpItemMappingDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'SV-FRT-01',
    description:
      'รหัสสินค้า/บริการฝั่ง ERP (1–64 ตัว) · null/ว่าง = ยกเลิกการจับคู่ · connector มีผังรหัสสินค้าแล้วต้องเป็นรหัสที่ใช้งาน (422 `erp_code_unknown`)',
  })
  @IsNullable()
  @IsString()
  @MaxLength(64)
  itemCode!: string | null;
}
