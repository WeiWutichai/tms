import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { CleanText, IsOptionalNotNull } from '../master/master-kit';
import { OrderFieldsDto } from './order.dto';

/**
 * เทมเพลตงานประจำ (ST3-T02; docs/04 C "กรอกมือ: ฟอร์มเดียว, duplicate จาก order เดิม, template งานประจำ")
 * payload = body ของ `POST /v1/orders` (ไม่มี `draft`/`externalId`) — ตรวจด้วยกฎชุดเดียวกับใบสั่ง (`normalizeOrderInput`)
 * สร้างใบจากเทมเพลต = ผู้เรียกนำ payload ไปส่ง `POST /v1/orders` เอง (API-first — ไม่มี endpoint ลัด)
 * ตั้งเวลาสร้างล่วงหน้ารายวัน/สัปดาห์ = P1 (docs/04 C "งานประจำ (recurring)")
 */
export class OrderTemplatePayloadDto extends OmitType(OrderFieldsDto, ['draft'] as const) {}

export class CreateOrderTemplateDto {
  @ApiProperty({ example: 'ส่งน้ำดื่ม บางปู → แหลมฉบัง ทุกจันทร์', maxLength: 100 })
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    type: OrderTemplatePayloadDto,
    description:
      'ข้อมูลใบสั่งขนส่ง (รูปเดียวกับ body ของ POST /v1/orders) — `requestedDate` + ช่วงเวลาของจุด = วันอ้างอิง ' +
      '(ตอนสร้างใบ ผู้เรียกเลื่อนเป็นวันที่ต้องการโดยคงเวลาเดิม)',
  })
  @IsObject()
  @ValidateNested()
  @Type(() => OrderTemplatePayloadDto)
  payload!: OrderTemplatePayloadDto;
}

export class UpdateOrderTemplateDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptionalNotNull()
  @CleanText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ type: OrderTemplatePayloadDto, description: 'แทนทั้งก้อน' })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => OrderTemplatePayloadDto)
  payload?: OrderTemplatePayloadDto;
}

export class OrderTemplateCustomerDto {
  @ApiProperty({ example: 'cus_3f2a…' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() legalName!: string;
}

export class OrderTemplateDto {
  @ApiProperty({ example: 'otp_3f2a…' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: OrderTemplatePayloadDto }) payload!: OrderTemplatePayloadDto;
  @ApiProperty({
    nullable: true,
    type: OrderTemplateCustomerDto,
    description: 'ลูกค้าตาม payload.customer.id (ไม่พบ/ถูกลบ = null) — ใช้แสดงในรายการ',
  })
  customer!: OrderTemplateCustomerDto | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class OrderTemplatePageDto {
  @ApiProperty({ type: [OrderTemplateDto] }) data!: OrderTemplateDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class OrderTemplateListQuery extends ListQuery {
  @ApiPropertyOptional({ maxLength: 100, description: 'ค้นชื่อเทมเพลต (ไม่สนตัวพิมพ์)' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MaxLength(100)
  q?: string;
}
