import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';
import { TripCostLineDto } from '../trips/trip-costs.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ตัวกรองคิวจ่ายรถร่วม (ST6-T02; docs/04 F6 "คิวจ่ายรถร่วม" — กรอง carrier/ช่วงวัน) */
export class SettlementQueueQuery extends ListQuery {
  @ApiPropertyOptional({
    example: 'car_3f2a…',
    description: 'รถร่วม — id หรือ `ext:{externalId}` (ไม่พบ = รายการว่าง)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  carrierId?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'วันที่เที่ยวจบตั้งแต่ (YYYY-MM-DD ตามเวลาไทย — `completedAt`)',
  })
  @IsOptional()
  @Matches(DATE_RE)
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-11-15',
    description: 'วันที่เที่ยวจบถึง (YYYY-MM-DD ตามเวลาไทย — รวมทั้งวัน)',
  })
  @IsOptional()
  @Matches(DATE_RE)
  dateTo?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'กรองตามหลักฐานส่ง (POD) ของเที่ยว: true = ครบ · false = ยังไม่ครบ (มีได้เฉพาะรถร่วมที่ปิด "ไม่มี POD ไม่จ่าย")',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  podComplete?: 'true' | 'false';
}

export class SettlementQueuePodDto {
  @ApiProperty({
    description:
      'หลักฐานส่งครบทุก DO ของเที่ยว — ส่งสำเร็จ: DO ผ่านเกณฑ์ POD ของลูกค้าแล้ว (UNBILLED/BILLED) และหลักฐานล่าสุดไม่ใช่ PARTIAL · ' +
      'ส่งไม่สำเร็จ/ตีกลับ/ยกเลิกเพื่อนัดส่งใหม่: หลักฐานชุด "ไม่สำเร็จ" ครบ (`podStatus` COMPLETE) · เที่ยวที่ไม่มี DO = ไม่ครบ',
  })
  complete!: boolean;
  @ApiProperty({ description: 'จำนวน DO ที่นับ (ไม่รวม DO ที่ยกเลิกโดยไม่ได้ออกส่ง)' })
  deliveryOrders!: number;
  @ApiProperty({ description: 'จำนวน DO ที่หลักฐานครบ' }) completeCount!: number;
}

/** เที่ยวในคิวจ่าย — เที่ยว COSTED ของรถร่วมที่ยังมีบรรทัดต้นทุนที่ยังไม่อยู่ในใบสำคัญจ่าย */
export class SettlementQueueTripDto {
  @ApiProperty({ example: 'trp_…' }) id!: string;
  @ApiProperty({ nullable: true, type: String, example: 'TRP-2611-0001' }) tripNo!: string | null;
  @ApiProperty({ example: '2026-11-13' }) tripDate!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เวลาเที่ยวจบ' })
  completedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'เวลาปิดต้นทุน (COSTED)' })
  costedAt!: string | null;
  @ApiProperty({ example: 'car_…' }) carrierId!: string;
  @ApiProperty({ description: 'ชื่อรถร่วม ณ วันจ้าง (snapshot ของเที่ยว)' }) carrierName!: string;
  @ApiProperty({ description: 'ค่าตั้งของรถร่วม "ไม่มี POD ไม่จ่าย"' }) requirePodToPay!: boolean;
  @ApiProperty({ type: SettlementQueuePodDto }) pod!: SettlementQueuePodDto;
  @ApiProperty({
    type: [TripCostLineDto],
    description:
      'บรรทัดที่รอจ่าย: ต้นทุน CONFIRMED ของรถร่วมรายปัจจุบันที่ยังไม่อยู่ในใบสำคัญจ่าย (ค่าจ้าง + ค่าใช้จ่ายหน้างานฝั่งซื้อที่ยืนยันแล้ว) — ' +
      'คู่บรรทัด/บรรทัดกลับรายการที่ยังไม่จ่ายทั้งคู่ไม่แสดง (หักล้างกันแล้ว)',
  })
  lines!: TripCostLineDto[];
  @ApiPropertyOptional({
    example: '4980.50',
    description:
      'ยอดรอจ่ายของเที่ยว (รวมบรรทัดข้างบน ก่อน VAT ก่อนหัก ณ ที่จ่าย) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyTotal?: string;
  @ApiProperty({ example: '2026-11-19T03:00:00.000Z' }) updatedAt!: string;
}

/** ยอดรวมต่อรถร่วม — นับทุกเที่ยวที่ตรงตัวกรอง (ไม่ขึ้นกับหน้า) */
export class SettlementQueueCarrierDto {
  @ApiProperty({ example: 'car_…' }) carrierId!: string;
  @ApiProperty({ example: 'SUB-0001' }) carrierCode!: string;
  @ApiProperty({ description: 'ชื่อรถร่วม (ข้อมูลหลักปัจจุบัน)' }) carrierName!: string;
  @ApiProperty() requirePodToPay!: boolean;
  @ApiProperty({ description: 'จำนวนเที่ยวในคิว' }) tripCount!: number;
  @ApiPropertyOptional({
    example: '24902.50',
    description: 'ยอดรอจ่ายรวม (ก่อน VAT ก่อนหัก ณ ที่จ่าย) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyTotal?: string;
}

export class SettlementQueuePageDto {
  @ApiProperty({ type: [SettlementQueueTripDto] }) data!: SettlementQueueTripDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({
    type: [SettlementQueueCarrierDto],
    description:
      'สรุปต่อรถร่วมของทุกเที่ยวที่ตรงตัวกรอง (ไม่ขึ้นกับ cursor/limit) — เรียงตามรหัสรถร่วม',
  })
  carriers!: SettlementQueueCarrierDto[];
}
