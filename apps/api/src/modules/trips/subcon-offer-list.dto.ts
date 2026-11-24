import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { ListQuery } from '../../common/pagination';
import { PriceField } from '../../common/price-fields';

/** สถานะของแถวในหน้า "จ่ายงานรถร่วม" (`/sub`) — EXPIRED รวมข้อเสนอที่ลิงก์หมดอายุแล้วแต่ job ยังไม่ปิด */
export const SUBCON_OFFER_LIST_STATUSES = ['OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;
export type SubconOfferListStatus = (typeof SUBCON_OFFER_LIST_STATUSES)[number];
const ST = SUBCON_OFFER_LIST_STATUSES.join('|');

export class SubconOfferListQuery extends ListQuery {
  @ApiPropertyOptional({
    description: `สถานะ คั่นด้วย , (${SUBCON_OFFER_LIST_STATUSES.join(' / ')}) — EXPIRED รวมข้อเสนอรอตอบที่เลยเวลาหมดอายุของลิงก์แล้ว`,
    example: 'REJECTED,EXPIRED',
  })
  @IsOptional()
  @Matches(new RegExp(`^(${ST})(,(${ST}))*$`))
  status?: string;

  @ApiPropertyOptional({ example: 'car_3f2a…' })
  @IsOptional()
  @Matches(/^car_[0-9a-f]{32}$/)
  carrierId?: string;
}

export class SubconOfferRowDto {
  @ApiProperty({ example: 'sco_3f2a…' }) id!: string;
  @ApiProperty({ example: 'trp_3f2a…' }) tripId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'TRP-2611-0001' }) tripNo!: string | null;
  @ApiProperty({ example: '2026-11-13', description: 'วันที่เที่ยว (วันที่ส่ง)' })
  tripDate!: string;
  @ApiProperty({ example: 'OFFERED', description: 'สถานะเที่ยวปัจจุบัน' }) tripStatus!: string;
  @ApiProperty({
    type: [String],
    example: ['DO-2611-0012'],
    description: 'เลข DO ในเที่ยว (ไม่รวมที่ยกเลิก)',
  })
  deliveryOrderNos!: string[];
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อจุดแรกของเที่ยว' })
  origin!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ชื่อจุดสุดท้ายของเที่ยว' })
  destination!: string | null;
  @ApiProperty({ example: 'car_3f2a…' }) carrierId!: string;
  @ApiProperty({ description: 'ชื่อผู้รับเหมา ณ วันจ้าง (snapshot)' }) carrierName!: string;
  @ApiProperty({ enum: SUBCON_OFFER_LIST_STATUSES }) status!: SubconOfferListStatus;
  @ApiPropertyOptional({
    type: String,
    example: '6800.00',
    description: 'ราคาซื้อที่ตกลง (ก่อน VAT) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyAmount?: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '9500.00',
    description:
      'รายได้ของเที่ยว ณ ตอนจ้าง (ก่อน VAT — ใช้คิด margin) — เห็นเมื่อมี `prices.sell:read` · null = ยังไม่มีราคา',
  })
  @PriceField('sell')
  sellAmount?: string | null;
  @ApiProperty({ description: 'ส่งข้อเสนอเมื่อ' }) offeredAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ลิงก์ข้อเสนอหมดอายุ (48 ชม.)' })
  expiresAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) respondedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ทะเบียนที่รถร่วมกรอกตอนรับงาน' })
  acceptedPlate!: string | null;
  @ApiProperty({ nullable: true, type: String }) acceptedDriverName!: string | null;
  @ApiProperty() updatedAt!: string;
}

export class SubconOfferPageDto {
  @ApiProperty({ type: [SubconOfferRowDto] }) data!: SubconOfferRowDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class SubconOfferSummaryDto {
  @ApiProperty({ description: 'รอตอบ = `status=OFFERED`' }) offered!: number;
  @ApiProperty({ description: 'รับงานแล้ว = `status=ACCEPTED`' }) accepted!: number;
  @ApiProperty({ description: 'ปฏิเสธ = `status=REJECTED`' }) rejected!: number;
  @ApiProperty({ description: 'หมดเวลา = `status=EXPIRED`' }) expired!: number;
  @ApiPropertyOptional({
    type: String,
    example: '48200.00',
    description:
      'ต้นทุนรถร่วมเดือนนี้ = Σ ราคาซื้อของงานที่รับแล้ว (ACCEPTED) ที่วันที่เที่ยวอยู่ในเดือนนี้ (เวลาไทย) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyAcceptedThisMonth?: string;
}
