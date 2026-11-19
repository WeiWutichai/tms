import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PriceField } from '../../common/price-fields';

/** ชนิดต้นทุน (docs/01 §3.3 trip_cost.cost_type) */
export const TRIP_COST_TYPES = [
  'FUEL',
  'TOLL',
  'DRIVER_WAGE',
  'CARRIER_FEE',
  'ALLOWANCE',
  'REPAIR',
  'OTHER',
] as const;
/** สิ่งที่ยังขวางการปิดต้นทุน (COMPLETED → COSTED) */
export const TRIP_COST_BLOCKERS = [
  'TRIP_NOT_COMPLETED',
  'PENDING_FIELD_CHARGES',
  'CARRIER_FEE_MISSING',
  'REVENUE_PROVISIONAL',
  'REVENUE_MISSING',
  'PENDING_SELL_CHARGES',
  'COSTING_DISABLED',
] as const;
export type TripCostBlocker = (typeof TRIP_COST_BLOCKERS)[number];

/** บรรทัดต้นทุนของเที่ยว (`trip_cost` — ST6-T01) — ยอดเงินเห็นเมื่อมี `prices.buy:read` */
export class TripCostLineDto {
  @ApiProperty({ example: 'tco_…' }) id!: string;
  @ApiProperty({ enum: TRIP_COST_TYPES }) costType!: string;
  @ApiProperty({
    enum: ['RATE_CARD', 'MANUAL', 'GPS', 'ADVANCE'],
    description:
      'ที่มาของราคา: RATE_CARD = ตาม rate card ขาซื้อ · MANUAL = กรอกเอง/ค่าใช้จ่ายหน้างาน',
  })
  source!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['SUBCON_OFFER', 'FIELD', 'DO_SURCHARGE', null],
    description:
      'ต้นทางของบรรทัด: SUBCON_OFFER = ราคาที่ตกลงตอนจ้างรถร่วม (บรรทัดระบบ — snapshot ไม่ตาม rate card ที่แก้ภายหลัง) · ' +
      'FIELD / DO_SURCHARGE = ค่าใช้จ่ายหน้างานฝั่งซื้อ (ST4-T13)',
  })
  sourceType!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'sco_…',
    description:
      'id ของต้นทาง (`sco_` การจ้าง · `dsc_` บรรทัดฝั่งขายที่บันทึกคู่กัน) — ไม่มี = null',
  })
  sourceId!: string | null;
  @ApiProperty({
    enum: ['PENDING_CONFIRM', 'CONFIRMED', 'REJECTED', 'CANCELLED'],
    description:
      'บรรทัดระบบ = CONFIRMED เสมอ · ค่าใช้จ่ายหน้างานรอยืนยันก่อน (นับเป็นต้นทุนเมื่อ CONFIRMED)',
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String, example: 'car_…' }) carrierId!: string | null;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ธง VAT ที่คัดลอกจากรายการบริการ (snapshot) — null = ไม่มีรายการบริการให้คัดลอก',
  })
  vatType!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '1.00',
    description: 'อัตรา WHT (%) snapshot ของบรรทัด — ยังไม่คำนวณยอดหัก (ST6-T08)',
  })
  whtRate!: string | null;
  @ApiPropertyOptional({
    example: '4800.50',
    description: 'ยอดต้นทุนก่อน VAT (บาท; บรรทัดกลับรายการติดลบ) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyAmount?: string;
  @ApiPropertyOptional({
    example: '0.00',
    description: 'VAT ของบรรทัด (ขาซื้อยังเป็น 0 — รอนักบัญชี #58) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyVatAmount?: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'tco_…',
    description:
      'บรรทัดนี้กลับรายการของบรรทัดใด (เปลี่ยนรถร่วม/จ้างใหม่/ยกเลิกเที่ยว) — ไม่ลบ/ไม่แก้ยอดเดิม',
  })
  reversalOfId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'tco_…',
    description: 'บรรทัดที่กลับรายการบรรทัดนี้',
  })
  reversedById!: string | null;
  @ApiProperty({ description: 'อยู่ในใบสำคัญจ่ายแล้ว (`settlement_line_id` ไม่ว่าง)' })
  settled!: boolean;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
  @ApiProperty({ example: '2026-11-19T03:00:00.000Z' }) createdAt!: string;
}

export class TripCostSummaryDto {
  @ApiProperty({ example: 'COMPLETED' }) tripStatus!: string;
  @ApiPropertyOptional({
    example: '5000.50',
    description:
      'ต้นทุนรวมสุทธิ (บรรทัด CONFIRMED รวมบรรทัดกลับรายการ) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyTotal?: string;
  @ApiPropertyOptional({
    example: '4800.50',
    description:
      'ค่าจ้างรถร่วมสุทธิของการจ้างที่**รถร่วมรับงานแล้ว (ACCEPTED)** ของรายปัจจุบันเท่านั้น — ข้อเสนอที่รอตอบ (OFFERED) = 0.00 · เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyCarrierFee?: string;
  @ApiProperty({ description: 'จำนวนค่าใช้จ่ายหน้างานฝั่งซื้อที่รอยืนยัน' }) pendingCount!: number;
  @ApiProperty({
    type: [String],
    enum: TRIP_COST_BLOCKERS,
    description:
      'สิ่งที่ยังขวางการปิดต้นทุน: TRIP_NOT_COMPLETED = เที่ยวยังไม่จบ · PENDING_FIELD_CHARGES = มีค่าใช้จ่ายหน้างานรอยืนยัน · ' +
      'CARRIER_FEE_MISSING = เที่ยวรถร่วมไม่มีค่าจ้างของการจ้างที่ใช้งานอยู่ · ' +
      'REVENUE_PROVISIONAL = เที่ยวมีหลาย DO และรายได้ของ DO ใดยังไม่ยืนยัน (ยังไม่บันทึกยอดส่งจริง) — ปันตามสัดส่วนรายได้ไม่ได้ · ' +
      'REVENUE_MISSING = เที่ยวมีหลาย DO แต่รายได้รวมเป็น 0 — ไม่มีสัดส่วนให้ปัน (รอ PO กำหนด) · ' +
      'PENDING_SELL_CHARGES = มีค่าใช้จ่ายหน้างานฝั่งขายของเที่ยว/DO รอยืนยัน (หลังปิดต้นทุนยืนยันไม่ได้) · ' +
      'COSTING_DISABLED = ผู้ดูแลระบบปิดฟังก์ชันปิดต้นทุนชั่วคราว',
  })
  blockers!: TripCostBlocker[];
  @ApiProperty({ nullable: true, type: String, description: 'เวลาปิดต้นทุน (COSTED)' })
  costedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) costedBy!: string | null;
}

/** ต้นทุนเที่ยวที่ปันลง DO หนึ่งใบ (ST6-T01c — `trip_cost.allocated` รวมต่อ DO) */
export class TripCostAllocationDto {
  @ApiProperty({ example: 'do_…' }) deliveryOrderId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'DO-2611-00001' }) doNo!: string | null;
  @ApiPropertyOptional({
    example: '2400.25',
    description:
      'ต้นทุนเที่ยวที่ปันลงใบนี้ (บาท ก่อน VAT) — ตามสัดส่วนรายได้ของ DO ณ เวลาปิดต้นทุน · เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyAllocatedCost?: string;
}

export class TripCostListDto {
  @ApiProperty({ type: [TripCostLineDto] }) data!: TripCostLineDto[];
  @ApiProperty({ type: TripCostSummaryDto }) summary!: TripCostSummaryDto;
  @ApiProperty({
    type: [TripCostAllocationDto],
    description:
      'ต้นทุนที่ปันลง DO (เขียนตอนปิดต้นทุน COSTED — PO ตัดสิน 19 พ.ย. 2569: ต้นทุนสุทธิของเที่ยวปันครั้งเดียวตามสัดส่วนรายได้ของ DO, เศษสตางค์ → DO รายได้สูงสุด ' +
      '(เท่ากัน → เลข DO น้อยสุด)) · ผลรวม = `buyTotal` · ยังไม่ปิดต้นทุน / เที่ยวไม่มี DO = []',
  })
  allocations!: TripCostAllocationDto[];
}
