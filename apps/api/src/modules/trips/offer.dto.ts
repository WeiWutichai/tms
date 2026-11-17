import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SUBCON_REJECT_CODES } from '@tms/domain';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PriceField } from '../../common/price-fields';
import { CleanText, IsNullable } from '../master/master-kit';

export const OFFER_VIEW_STATUSES = [
  'OFFERED',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'WITHDRAWN',
] as const;

export class OfferRejectReasonDto {
  @ApiProperty({ enum: SUBCON_REJECT_CODES }) code!: string;
  @ApiProperty({ example: 'รถไม่ว่างวันที่รับงาน' }) label!: string;
}

export class OfferTermsDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: '1.00',
    description:
      'หัก ณ ที่จ่าย % ของบรรทัดค่าขนส่งตาม rate card (ราคาที่กรอกเอง = null — ใช้ค่าตั้งต้นตอนจ่าย)',
  })
  whtRate!: string | null;
  @ApiProperty({ example: 15 }) paymentTermDays!: number;
  @ApiProperty({ description: 'จ่ายหลังส่ง POD' }) requirePodToPay!: boolean;
}

export class OfferAcceptedDto {
  @ApiProperty({ example: '74-5521' }) plate!: string;
  @ApiProperty({ nullable: true, type: String, example: 'สมชาย ใจดี' }) driverName!: string | null;
}

/**
 * หน้าลิงก์ข้อเสนองานของรถร่วม (ST3-T23 — docs/04 D3/M10, spec/04 §5 S1) · ไม่มีราคาขาย/กำไร/ที่อยู่ลูกค้า/ข้อเสนอของรายอื่น
 * (EXE-080) — ราคาจ้างของตัวเองเห็นผ่าน scope `prices.buy:read` ของลิงก์
 */
export class OfferLinkViewDto {
  @ApiProperty({ description: 'ชื่อบริษัทขนส่ง (tenant)' }) company!: string;
  @ApiProperty({ description: 'ชื่อรถร่วม (ผู้รับเหมา) ของข้อเสนอ' }) carrierName!: string;
  @ApiProperty({
    enum: OFFER_VIEW_STATUSES,
    description:
      'OFFERED รอตอบ · ACCEPTED รับงานแล้ว · REJECTED ปฏิเสธแล้ว · EXPIRED หมดเวลาตอบรับ · WITHDRAWN ถอนข้อเสนอ',
  })
  status!: string;
  @ApiProperty({ example: 'TRP-2611-0004' }) tripNo!: string;
  @ApiProperty({ example: '2026-11-18' }) tripDate!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เวลารับสินค้า (จุดแรก)' }) pickupAt!:
    string | null;
  @ApiProperty({ nullable: true, type: String, example: 'คลังบางปู' }) origin!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'ท่าเรือแหลมฉบัง ประตู 3' })
  destination!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อลูกค้า (ไม่มีที่อยู่/ผู้ติดต่อ)' })
  customerName!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '6 ล้อ' }) vehicleTypeName!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '8600' }) weightKg!: string | null;
  @ApiPropertyOptional({
    type: String,
    example: '5600.00',
    description: 'ราคาจ้าง (ก่อน VAT) — ราคาซื้อของรถร่วมรายนี้เอง',
  })
  @PriceField('buy')
  buyAmount?: string;
  @ApiProperty({ type: OfferTermsDto }) terms!: OfferTermsDto;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้ติดต่อฝั่งบริษัท (ผู้ส่งข้อเสนอ)' })
  contactName!: string | null;
  @ApiProperty({ description: 'หมดเวลาตอบรับ (เวลาเซิร์ฟเวอร์ตัดสิน)' }) expiresAt!: string;
  @ApiProperty({ description: 'เวลาเซิร์ฟเวอร์ (ใช้นับถอยหลัง)' }) serverTime!: string;
  @ApiProperty({ nullable: true, type: OfferAcceptedDto }) accepted!: OfferAcceptedDto | null;
  @ApiProperty({ nullable: true, enum: SUBCON_REJECT_CODES, type: String })
  rejectReason!: string | null;
  @ApiProperty({ type: [OfferRejectReasonDto] }) rejectReasons!: OfferRejectReasonDto[];
}

/** รับงาน: ทะเบียนรถ (+ จังหวัดต่อท้ายได้) + ชื่อ/เบอร์คนขับ (docs/04 D3, docs/01 §5.5 `/accept`) */
export class AcceptOfferDto {
  @ApiProperty({
    example: '74-5521 ชบ.',
    description: 'ทะเบียนรถที่ลงทะเบียนไว้กับบริษัท (พิมพ์จังหวัดต่อท้ายได้)',
  })
  @CleanText()
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  vehiclePlate!: string;

  @ApiProperty({ example: 'สมชาย ใจดี' })
  @CleanText()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  driverName!: string;

  @ApiProperty({ example: '081-234-5678', description: 'เบอร์คนขับที่ลงทะเบียนไว้ (+66 ได้)' })
  @CleanText()
  @IsString()
  @MinLength(9)
  @MaxLength(20)
  driverPhone!: string;
}

/** ปฏิเสธ: เหตุผล (ชุดคงที่ — PLN-151) + หมายเหตุไม่บังคับ */
export class RejectOfferDto {
  @ApiProperty({ enum: SUBCON_REJECT_CODES })
  @IsIn(SUBCON_REJECT_CODES)
  reason!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsNullable()
  @CleanText()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** ลิงก์ข้อเสนองานที่ใช้ได้ของเที่ยว (ผู้จัดรถคัดลอก/ส่งทาง LINE/SMS) */
export class OfferLinkDto {
  @ApiProperty({ example: 'sco_3f2a…' }) offerId!: string;
  @ApiProperty({ example: 'mlk_3f2a…' }) linkId!: string;
  @ApiProperty({ example: 'https://app.example/link/offer/ml1.…' }) url!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() issuedAt!: string;
}

export class OfferLinkStateDto {
  @ApiProperty({
    nullable: true,
    type: OfferLinkDto,
    description:
      'null = ไม่มีลิงก์ที่ใช้ได้ (ยังไม่จ้าง / ปฏิเสธ-หมดเวลา-ยกเลิกแล้ว / ลิงก์หมดอายุ)',
  })
  link!: OfferLinkDto | null;
}

export class OfferMessageDto {
  @ApiProperty({ example: 'msg_3f2a…' }) id!: string;
  @ApiProperty({ enum: ['line', 'sms'] }) channel!: string;
  @ApiProperty({ enum: ['queued', 'sending', 'sent', 'failed'] }) status!: string;
  @ApiProperty({ example: 'U1a2•••••9f' }) recipient!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) sentAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) errorCode!: string | null;
}

/** ประวัติการจ้างรถร่วมของเที่ยว (ST3-T23 แท็บกิจกรรม — ทุกครั้ง รวมที่ปฏิเสธ/ถอน) */
export class SubconOfferDto {
  @ApiProperty({ example: 'sco_3f2a…' }) id!: string;
  @ApiProperty({ example: 'car_3f2a…' }) carrierId!: string;
  @ApiProperty() carrierName!: string;
  @ApiProperty({ enum: ['OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'] })
  status!: string;
  @ApiPropertyOptional({ type: String, example: '5600.00' })
  @PriceField('buy')
  buyAmount?: string;
  @ApiProperty() offeredAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อผู้ส่งข้อเสนอ' })
  offeredByName!: string | null;
  @ApiProperty({ nullable: true, type: String }) expiresAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'รถร่วมเปิดลิงก์ครั้งแรก' })
  viewedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) respondedAt!: string | null;
  @ApiProperty({ nullable: true, enum: ['LINK', 'USER'], type: String })
  respondedVia!: string | null;
  @ApiProperty({ nullable: true, enum: SUBCON_REJECT_CODES, type: String })
  rejectReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) rejectNote!: string | null;
  @ApiProperty({ nullable: true, type: String }) acceptedPlate!: string | null;
  @ApiProperty({ nullable: true, type: String }) acceptedDriverName!: string | null;
  @ApiProperty({ nullable: true, type: String }) closedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) closedReason!: string | null;
  @ApiProperty({ type: [OfferMessageDto], description: 'การส่งลิงก์ทาง LINE/SMS ของการจ้างนี้' })
  messages!: OfferMessageDto[];
}

export class SubconOfferListDto {
  @ApiProperty({ type: [SubconOfferDto] }) data!: SubconOfferDto[];
}
