import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CleanText } from '../master/master-kit';

/**
 * DTO สาธารณะของหน้าติดตามของผู้รับ (ST4-T14; docs/04 E2 "Tracking link สาธารณะ", spec/04 §4 EXE-D)
 * **endpoint แยก คืนเฉพาะ DTO สาธารณะ** (EXE-061) — ไม่มีราคา/ค่าขนส่ง, DO อื่นในเที่ยว, ที่อยู่, ชื่อ/เบอร์/รูปคนขับ,
 * ทะเบียนเต็ม, ประวัติเส้นทาง, ข้อความภายใน (test ตรวจ response ทั้งก้อนแบบ recursive)
 */
export const TRACKING_STAGES = [
  'ACCEPTED',
  'DEPARTED',
  'IN_TRANSIT',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
] as const;
export type TrackingStage = (typeof TRACKING_STAGES)[number];
/** ขั้นของ stepper (ต้นแบบ: รับงาน → ออกรถ → กำลังส่ง → ส่งแล้ว; ส่งไม่สำเร็จแทนขั้นสุดท้าย) */
export const TRACKING_STEPS = ['ACCEPTED', 'DEPARTED', 'IN_TRANSIT', 'DELIVERED'] as const;

export class TrackingCompanyDto {
  @ApiProperty({ example: 'ศรีไทยขนส่ง', description: 'ชื่อบริษัทขนส่ง (ค่าตั้ง org.name)' })
  name!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '02-118-4400',
    description: 'เบอร์บริษัท (ค่าตั้ง tracking.contactPhone) — ไม่ใช่เบอร์คนขับ · null = ไม่ตั้ง',
  })
  phone!: string | null;
}

export class TrackingStepDto {
  @ApiProperty({ enum: TRACKING_STEPS }) key!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'เวลาที่ถึงขั้นนี้ (ISO 8601) — null = ยังไม่ถึง/ไม่ทราบเวลา',
  })
  at!: string | null;
  @ApiProperty({ description: 'ถึงขั้นนี้แล้ว' }) done!: boolean;
}

export class TrackingEtaDto {
  @ApiProperty({ description: 'ต้นช่วงเวลาที่คาดว่าจะถึง (ISO 8601)' }) from!: string;
  @ApiProperty({ description: 'ปลายช่วง (เท่ากับ from = เวลาเดียว)' }) to!: string;
  @ApiProperty({
    enum: ['PLAN'],
    description: 'ที่มา — PLAN = ช่วงเวลาตามแผน/ที่ลูกค้าขอ (เฟส 0 ยังไม่มี ETA สด — P1)',
  })
  basis!: string;
}

export class TrackingRouteDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'สมุทรปราการ',
    description: 'จังหวัดต้นทาง',
  })
  from!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'ชลบุรี', description: 'จังหวัดปลายทาง' })
  to!: string | null;
}

export class TrackingVehicleDto {
  @ApiProperty({ nullable: true, type: String, example: 'รถ 6 ล้อ' }) typeName!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '70-12xx กทม.',
    description: 'ทะเบียนปิด 2 หลักท้าย (EXE-044/061 — ไม่เผยทะเบียนเต็ม)',
  })
  plateMasked!: string | null;
}

export class TrackingItemDto {
  @ApiProperty({ example: 'ปูนซีเมนต์' }) description!: string;
  @ApiProperty({ example: '20', description: 'จำนวนตามแผน' }) qty!: string;
  @ApiProperty({ example: 'ตัน' }) unit!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'จำนวนที่ส่งจริง (เมื่อส่งแล้วและบันทึกไว้)',
  })
  qtyDelivered!: string | null;
}

export class TrackingImageDto {
  @ApiProperty({ description: 'URL มีลายเซ็น อายุ 15 นาที (EXE-064)' }) url!: string;
  @ApiProperty() expiresAt!: string;
}

export class TrackingPodDto {
  @ApiProperty({ nullable: true, type: String, example: 'คุณสมศรี' }) receiverName!: string | null;
  @ApiProperty({ description: 'เวลาบันทึกหลักฐานส่ง' }) recordedAt!: string;
  @ApiProperty({ type: [TrackingImageDto] }) photos!: TrackingImageDto[];
  @ApiProperty({ type: TrackingImageDto, nullable: true }) signature!: TrackingImageDto | null;
}

export class TrackingShipmentDto {
  @ApiProperty({ example: 'DO-2611-00060' }) doNo!: string;
  @ApiProperty({ example: 'บจก. สยามพลาสติก', description: 'ชื่อผู้ส่ง (ลูกค้า)' })
  customerName!: string;
  @ApiProperty({ nullable: true, type: String, example: 'PO-45861', description: 'เลข PO ลูกค้า' })
  customerRef!: string | null;
  @ApiProperty({
    enum: TRACKING_STAGES,
    description:
      'สถานะสาธารณะ: ACCEPTED รับงาน · DEPARTED ออกรถ · IN_TRANSIT กำลังส่ง (รับของแล้ว) · DELIVERED ส่งแล้ว · FAILED ส่งไม่สำเร็จ · CANCELLED ยกเลิก',
  })
  status!: string;
  @ApiProperty({ type: [TrackingStepDto] }) steps!: TrackingStepDto[];
  @ApiProperty({ type: TrackingEtaDto, nullable: true }) eta!: TrackingEtaDto | null;
  @ApiProperty({ nullable: true, type: String, description: 'เวลาส่งถึง (ส่งแล้ว)' })
  deliveredAt!: string | null;
  @ApiProperty({ type: String, format: 'date', description: 'วันที่ของใบส่งของ' }) doDate!: string;
  @ApiProperty({ type: TrackingRouteDto }) route!: TrackingRouteDto;
  @ApiProperty({ type: TrackingVehicleDto, nullable: true }) vehicle!: TrackingVehicleDto | null;
  @ApiProperty({ type: [TrackingItemDto] }) items!: TrackingItemDto[];
  @ApiProperty({
    type: TrackingPodDto,
    nullable: true,
    description: 'หลักฐานส่ง — เฉพาะเมื่อส่งแล้วและบริษัทเปิด tracking.showPod',
  })
  pod!: TrackingPodDto | null;
  @ApiProperty({ description: 'เวลาอัปเดตสถานะล่าสุด' }) updatedAt!: string;
}

export class TrackingViewDto {
  @ApiProperty({ type: TrackingCompanyDto }) company!: TrackingCompanyDto;
  @ApiProperty({
    enum: ['SHIPMENT', 'SEARCH'],
    description:
      'SHIPMENT = ลิงก์ต่อ DO (มี shipment) · SEARCH = ลิงก์ของลูกค้า ต้องค้นด้วย lookup',
  })
  mode!: string;
  @ApiProperty({ type: TrackingShipmentDto, nullable: true }) shipment!: TrackingShipmentDto | null;
}

export class TrackingLookupDto {
  @ApiProperty({
    example: 'PO-45861',
    maxLength: 50,
    description: 'เลขใบส่งของ (DO) หรือเลข PO ลูกค้า (ไม่สนตัวพิมพ์/ช่องว่างหัวท้าย)',
  })
  @CleanText()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  ref!: string;

  @ApiProperty({ example: '4507', description: 'เบอร์โทรผู้รับ (ปลายทาง) 4 ตัวท้าย — EXE-062' })
  @IsString()
  @Matches(/^[0-9]{4}$/)
  phoneLast4!: string;
}

// ---------- ฝั่งภายใน (ผู้จัดรถออก/เพิกถอนลิงก์) ----------

export class TrackingLinkDto {
  @ApiProperty({ example: 'mlk_3f2a…' }) linkId!: string;
  @ApiProperty({ example: 'https://app.example/t/ml1.…', description: 'URL หน้าติดตาม (มี token)' })
  url!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) lastUsedAt!: string | null;
}

export class TrackingLinkStateDto {
  @ApiProperty({ type: TrackingLinkDto, nullable: true, description: 'null = ไม่มีลิงก์ที่ใช้ได้' })
  link!: TrackingLinkDto | null;
}

/** ST7-T11 ตำแหน่งล่าสุดที่รู้ของเที่ยว — จากพิกัดของ event หน้างาน (เฟส 0 ไม่มี GPS สด/telemetry — P2) */
export class OrderTrackingPositionDto {
  @ApiProperty({ example: 13.6658 }) lat!: number;
  @ApiProperty({ example: 100.6371 }) lng!: number;
  @ApiProperty({ nullable: true, type: Number, example: 12 }) accuracyM!: number | null;
  @ApiProperty({ example: '2026-11-19T09:42:00.000Z', description: 'occurredAt ของ event' })
  occurredAt!: string;
  @ApiProperty({ enum: ['STOP_EVENT'], description: 'ที่มาของพิกัด' }) basis!: string;
  @ApiProperty({ example: 'evt_3f2a…' }) eventId!: string;
}

/** ST7-T11 สถานะติดตามของ DO หนึ่งใบของ order (ภายใน — API key/ผู้ใช้ที่มี `orders:read`) */
export class OrderTrackingShipmentDto extends TrackingShipmentDto {
  @ApiProperty({ example: 'do_3f2a…' }) deliveryOrderId!: string;
  @ApiProperty({
    example: 'DISPATCHED',
    description: 'สถานะ DO ภายใน (`status` = ขั้นของหน้าติดตาม)',
  })
  doStatus!: string;
  @ApiProperty({ nullable: true, type: String, example: 'trp_3f2a…' }) tripId!: string | null;
  @ApiProperty({
    type: OrderTrackingPositionDto,
    nullable: true,
    description:
      'พิกัดล่าสุดที่บันทึกกับ event หน้างานของเที่ยว · ไม่มีพิกัด/ยังไม่มีเที่ยว = null',
  })
  lastPosition!: OrderTrackingPositionDto | null;
}

/** ST7-T11 `GET /v1/orders/{id}/tracking` (docs/04 G2 #1) */
export class OrderTrackingDto {
  @ApiProperty({ example: 'ord_3f2a…' }) orderId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'SO-6911-0001' }) soNo!: string | null;
  @ApiProperty({ example: 'IN_TRANSIT', description: 'สถานะใบสั่งขนส่ง' }) orderStatus!: string;
  @ApiProperty({
    type: [OrderTrackingShipmentDto],
    description:
      'ทุก DO ของ order (รวมที่ยกเลิก) ตามลำดับที่สร้าง — ขั้น/ETA/รายการใช้กติกาเดียวกับหน้าติดตามสาธารณะ (ST4-T14) แต่ไม่หมดอายุตาม `tracking.linkDays` และไม่มีรูป POD (ดู `GET /v1/orders/{id}/documents`)',
  })
  deliveryOrders!: OrderTrackingShipmentDto[];
}

/**
 * ออกลิงก์ติดตามใหม่ — เหตุผลการเพิกถอนลิงก์เดิม (review M2 Q-LINK/ST4-T14; CLAUDE.md "ทุกการยกเลิกต้องมีเหตุผล")
 * ไม่ส่ง = เหตุผลของระบบ "ออกลิงก์ติดตามใหม่แทน" (เข้ากันได้กับผู้เรียกเดิม) · หน้าเว็บส่งเมื่อมีลิงก์ที่ใช้ได้อยู่
 */
export class IssueTrackingLinkDto {
  @ApiPropertyOptional({ minLength: 10, maxLength: 500, example: 'ส่งลิงก์ให้ผู้รับผิดคน' })
  @IsOptional()
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason?: string;
}
