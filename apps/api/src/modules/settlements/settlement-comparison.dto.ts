import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PriceField } from '../../common/price-fields';
import { LINE_STATUSES, type LineStatus } from './settlement-dispute';
import {
  SETTLEMENT_STATUSES,
  SettlementDisputeSummaryDto,
  SettlementLineCompanyReviewDto,
  type SettlementStatus,
} from './settlement.dto';

/**
 * หน้าเทียบ planned vs executed vs claimed + POD (ST6-T06; docs/04 F6 "Dispute — หน้าเอกสารคู่ยอด")
 * - planned = ราคาซื้อที่ตกลงตอนจ้างรถร่วม (subcon_offer ที่สร้างบรรทัดต้นทุน)
 * - executed = ยอดของบรรทัดในใบ (ต้นทุนที่ยืนยันแล้วของเที่ยวที่วิ่งจบ)
 * - claimed = ยอดที่รถร่วมเรียก (ยอมรับ = เท่ายอดในใบ · โต้แย้ง = ยอดที่ระบุ ถ้าไม่ระบุ = null)
 */
export class ComparisonClaimDto {
  @ApiProperty({ enum: ['ACCEPTED', 'DISPUTED'] }) response!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ type: [String], example: ['doc_…'] }) photoIds!: string[];
  @ApiProperty({ format: 'date-time' }) respondedAt!: string;
}

export class ComparisonLineDto {
  @ApiProperty({ example: 'stln_…' }) id!: string;
  @ApiProperty() lineNo!: number;
  @ApiProperty({ enum: ['FREIGHT', 'SURCHARGE', 'DEDUCTION'] }) lineType!: string;
  @ApiProperty({ nullable: true, type: String, example: 'trp_…' }) tripId!: string | null;
  @ApiProperty({ nullable: true, type: String }) tripNo!: string | null;
  @ApiProperty({ nullable: true, type: String }) costType!: string | null;
  @ApiProperty({ nullable: true, type: String }) deductionType!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty({ nullable: true, type: String, description: 'เอกสารอ้างอิงของบรรทัดหัก' })
  reference!: string | null;
  @ApiProperty({ enum: LINE_STATUSES, description: 'สถานะรายการในรอบตรวจปัจจุบัน' })
  status!: LineStatus;
  @ApiProperty({
    nullable: true,
    enum: ['SUBCON_OFFER'],
    description:
      'ที่มาของยอดตามแผน — SUBCON_OFFER = ราคาที่ตกลงตอนจ้างรถร่วม · null = ไม่มีแผน (ค่าใช้จ่ายหน้างาน/รายการหัก/บรรทัดก่อน ST3-T22)',
  })
  plannedSource!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'rate card ที่ใช้ตอนจ้าง (ถ้ามี)',
  })
  plannedRateCardCode!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '4500.00',
    description: 'ยอดตามแผน (planned) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyPlannedAmount?: string | null;
  @ApiPropertyOptional({
    example: '4500.00',
    description:
      'ยอดที่วิ่งจริงในใบ (executed — ยอดบรรทัด, รายการหัก = ติดลบ) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyExecutedAmount?: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '5200.00',
    description:
      'ยอดที่รถร่วมเรียก (claimed) — ยอมรับ = ยอดในใบ · โต้แย้งพร้อมยอด = ยอดนั้น · ยังไม่ตอบ/โต้แย้งไม่ระบุยอด = null — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyClaimedAmount?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '700.00',
    description:
      'ส่วนต่าง claimed − executed (null = ไม่มียอดที่เรียก) — เห็นเมื่อมี `prices.buy:read`',
  })
  @PriceField('buy')
  buyClaimedDifference?: string | null;
  @ApiProperty({
    nullable: true,
    type: ComparisonClaimDto,
    description: 'คำตอบล่าสุดของรถร่วมในรอบตรวจปัจจุบัน',
  })
  claim!: ComparisonClaimDto | null;
  @ApiProperty({ nullable: true, type: SettlementLineCompanyReviewDto })
  companyReview!: SettlementLineCompanyReviewDto | null;
}

export class ComparisonPodDto {
  @ApiProperty({ example: 'do_…' }) deliveryOrderId!: string;
  @ApiProperty({ nullable: true, type: String }) doNo!: string | null;
  @ApiProperty({ description: 'สถานะ DO' }) status!: string;
  @ApiProperty({ description: 'สถานะหลักฐาน (NONE / PARTIAL / COMPLETE)' }) podStatus!: string;
  @ApiProperty({
    description:
      'หลักฐานผ่านเกณฑ์จ่ายรถร่วม (กฎเดียวกับคิวจ่าย: ส่งสำเร็จผ่านเกณฑ์ POD ลูกค้าและไม่ PARTIAL · ส่งไม่สำเร็จ/ตีกลับ = หลักฐานครบ)',
  })
  passed!: boolean;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'ฉบับ POD ล่าสุด (null = ยังไม่บันทึก)',
  })
  podVersion!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'SUCCESS / FAILURE' })
  outcome!: string | null;
  @ApiProperty({ nullable: true, type: String }) receiverName!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) recordedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '10',
    description: 'ปริมาณตามแผนรวม (จาก POD ล่าสุด — null = ไม่ได้บันทึกยอดส่งจริง ถือว่าตามแผน)',
  })
  qtyPlanned!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '9', description: 'ปริมาณส่งจริงรวม' })
  qtyActual!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '1', description: 'ปริมาณปฏิเสธรับรวม' })
  rejectQty!: string | null;
  @ApiProperty({
    type: [String],
    example: ['doc_…'],
    description: 'รูป/ลายเซ็น/ไฟล์ของ POD ล่าสุด — เปิดผ่าน GET /v1/documents/{id}',
  })
  documentIds!: string[];
}

export class ComparisonTripDto {
  @ApiProperty({ example: 'trp_…' }) id!: string;
  @ApiProperty() tripNo!: string;
  @ApiProperty({ example: '2026-11-03', description: 'วันที่วางแผน' }) tripDate!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'วิ่งจบเมื่อ' })
  completedAt!: string | null;
  @ApiProperty({ description: 'POD ผ่านเกณฑ์ครบทุก DO ของเที่ยว' }) podComplete!: boolean;
  @ApiProperty({ type: [ComparisonPodDto] }) deliveryOrders!: ComparisonPodDto[];
}

export class SettlementComparisonDto {
  @ApiProperty({ example: 'stl_…' }) id!: string;
  @ApiProperty({ enum: SETTLEMENT_STATUSES }) status!: SettlementStatus;
  @ApiProperty({ description: 'รอบตรวจปัจจุบัน (0 = ยังไม่เคยส่ง)' }) round!: number;
  @ApiProperty({ nullable: true, type: String, description: 'เลขใบแจ้งหนี้ของรถร่วม' })
  carrierInvoiceNo!: string | null;
  @ApiProperty({ type: SettlementDisputeSummaryDto }) dispute!: SettlementDisputeSummaryDto;
  @ApiProperty({ type: [ComparisonLineDto], description: 'บรรทัดที่ยังใช้ เรียงตามลำดับในใบ' })
  lines!: ComparisonLineDto[];
  @ApiProperty({ type: [ComparisonTripDto], description: 'เที่ยวของบรรทัด + POD ต่อ DO' })
  trips!: ComparisonTripDto[];
}
