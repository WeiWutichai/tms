import { ApiProperty } from '@nestjs/swagger';

/** อายุลิงก์ "ค่าเที่ยวของฉัน" (ST6-T11) — ดูอย่างเดียว · [DECISION spec/12 §3 — ย้อนได้] 30 วัน (เพดานเดียวกับลิงก์เอกสารรถร่วม ST2-T21) */
export const CARRIER_PAY_LINK_TTL_DAYS = 30;

/** ลิงก์ที่เพิ่งออก (staff) — url แสดงครั้งเดียว (ไม่เก็บ token) */
export class CarrierPayLinkDto {
  @ApiProperty({ example: 'mlk_…' }) id!: string;
  @ApiProperty({
    description:
      'ลิงก์หน้า "ค่าเที่ยวของฉัน" ของรถร่วม (`/link/carrier-pay/{token}`) — ส่งทาง LINE/SMS ด้วย POST /v1/messages/send-link หรือคัดลอกไปส่งเอง · แสดงครั้งเดียว',
  })
  url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

// ---------- ฝั่งรถร่วม (ลิงก์) ----------

export class CarrierPaySettlementDto {
  @ApiProperty({ example: 'stl_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เลขใบ (ออกตอนอนุมัติ)' })
  settlementNo!: string | null;
  @ApiProperty({
    enum: ['SENT_TO_CARRIER', 'APPROVED', 'PAID'],
    description:
      'SENT_TO_CARRIER = รอตรวจ (รวมใบที่มีรายการโต้แย้ง — ไม่เผยการติดธงภายใน) · APPROVED = อนุมัติแล้ว รอจ่าย · PAID = จ่ายแล้ว · ร่าง/ยกเลิกไม่แสดง',
  })
  status!: string;
  @ApiProperty({ example: '2026-11-01' }) periodFrom!: string;
  @ApiProperty({ example: '2026-11-15' }) periodTo!: string;
  @ApiProperty() tripCount!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '10890.00',
    description:
      'ยอดจ่ายสุทธิหลังหัก ณ ที่จ่าย — ใบอนุมัติ/จ่ายแล้ว = ยอดที่ตรึง · ใบรอตรวจ = ประมาณการ (D-54) · null = ยังคำนวณไม่ได้ (ข้อมูลรถร่วมในใบไม่มีประเภทบุคคล/นิติบุคคล) · ราคาซื้อของรถร่วมรายนี้เท่านั้น',
  })
  amount!: string | null;
  @ApiProperty({ description: 'ยอดเป็นประมาณการ (ใบยังไม่อนุมัติ)' }) estimate!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'วันที่จ่าย (ใบจ่ายแล้ว)' })
  paidDate!: string | null;
}

export class CarrierPayTripDto {
  @ApiProperty({ nullable: true, type: String, description: 'เลขเที่ยว' }) tripNo!: string | null;
  @ApiProperty({ example: '2026-11-04', description: 'วันที่เที่ยว' }) tripDate!: string;
  @ApiProperty({ nullable: true, type: String, description: 'จุดรับแรก' }) origin!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'จุดส่งสุดท้าย' })
  destination!: string | null;
  @ApiProperty({
    example: '4500.00',
    description:
      'ค่าจ้างของเที่ยวที่ยังไม่เข้างวด (ก่อนหัก ณ ที่จ่าย) — ราคาซื้อของรถร่วมรายนี้เท่านั้น',
  })
  amount!: string;
}

export class CarrierPayLinkViewDto {
  @ApiProperty({ description: 'ชื่อบริษัทขนส่ง (ผู้จ่าย)' }) company!: string;
  @ApiProperty({ description: 'ชื่อรถร่วม' }) carrierName!: string;
  @ApiProperty({ description: 'เครดิตจ่าย (วัน) ของรถร่วม' }) paymentTermDays!: number;
  @ApiProperty({
    example: '38258.40',
    description:
      'รอรับเงิน = รวมยอดหลังหัก ณ ที่จ่ายของทุกงวดที่ยังไม่จ่าย (ไม่ขึ้นกับเพดานการ์ด · งวดที่ยังคำนวณไม่ได้ไม่รวม)',
  })
  dueAmount!: string;
  @ApiProperty({ description: 'จำนวนงวดที่ยังไม่จ่ายทั้งหมด' }) dueCount!: number;
  @ApiProperty({
    type: [CarrierPaySettlementDto],
    description:
      'งวด (ใบสำคัญจ่าย) — ยังไม่จ่าย (ล่าสุด ≤ 50) ก่อน แล้วจ่ายแล้วย้อนหลัง 12 เดือน (≤ 24)',
  })
  settlements!: CarrierPaySettlementDto[];
  @ApiProperty({
    type: [CarrierPayTripDto],
    description:
      'เที่ยวที่จบแล้วที่ยังมีค่าจ้างค้างให้รถร่วมรายนี้นอกงวดที่ส่งให้รถร่วม (ก่อนหัก ณ ที่จ่าย · ล่าสุดก่อน ไม่เกิน 100)',
  })
  trips!: CarrierPayTripDto[];
  @ApiProperty({ format: 'date-time', description: 'ลิงก์ใช้ได้ถึง' }) expiresAt!: string;
}
