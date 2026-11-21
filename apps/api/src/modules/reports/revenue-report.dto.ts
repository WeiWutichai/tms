import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PriceField } from '../../common/price-fields';

/** มิติของรายงานรายได้ (docs/04 H "รายได้: ต่อลูกค้า / เส้นทาง / รถ / ประเภทรถ / นิติบุคคล / เดือน") */
export const REVENUE_GROUP_BY = [
  'customer',
  'route',
  'vehicle',
  'vehicleType',
  'legalEntity',
  'month',
] as const;
export type RevenueGroupBy = (typeof REVENUE_GROUP_BY)[number];

/** ช่วงยาวสุดต่อคำขอ (เดือน) */
export const REVENUE_MAX_MONTHS = 24;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** ตัวกรอง (ค่าเป็น string ทั้งหมด — ใช้ร่วมกับงานส่งออก `POST /v1/exports` resource `revenue`) */
export class RevenueReportQuery {
  @ApiPropertyOptional({
    enum: REVENUE_GROUP_BY,
    default: 'customer',
    description:
      'จัดกลุ่มตาม: `customer` ลูกค้า · `route` เส้นทาง (ต้นทาง – ปลายทางของ DO) · `vehicle` รถ · `vehicleType` ประเภทรถ · ' +
      '`legalEntity` นิติบุคคลผู้ออกใบ · `month` เดือนที่ออกใบ',
  })
  @IsOptional()
  @IsIn([...REVENUE_GROUP_BY])
  groupBy?: RevenueGroupBy;

  @ApiPropertyOptional({
    example: '2026-11',
    description: `เดือนแรก (YYYY-MM ตามวันที่ออกใบ เวลาไทย) — ไม่ส่ง = เท่ากับ \`toMonth\` · ช่วงยาวสุด ${REVENUE_MAX_MONTHS} เดือน`,
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH, { message: 'fromMonth must be YYYY-MM' })
  fromMonth?: string;

  @ApiPropertyOptional({
    example: '2026-11',
    description: 'เดือนสุดท้าย (YYYY-MM รวมเดือนนี้) — ไม่ส่ง = เดือนปัจจุบัน (เวลาไทย)',
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH, { message: 'toMonth must be YYYY-MM' })
  toMonth?: string;
}

export class RevenueRowDto {
  @ApiProperty({
    example: 'cus_…',
    description:
      'คีย์ของแถว (คงที่ — ใช้อ้างอิง/ส่งออก): customer = id ลูกค้า · legalEntity = id นิติบุคคล (`cmp_`) · month = YYYY-MM · ' +
      'route = `{loc_ต้นทาง}>{loc_ปลายทาง}` · vehicle = id รถ หรือ `plate:{ทะเบียน}` (รถที่ไม่มีในทะเบียน) · ' +
      'vehicleType = id ประเภทรถ หรือ `name:{ชื่อ}` · แถวไม่ระบุ = `none`',
  })
  id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ชื่อที่แสดง — ลูกค้า/นิติบุคคล = ชื่อ ณ วันออกใบล่าสุดในช่วง (snapshot) · เส้นทาง = "ต้นทาง – ปลายทาง" (แยกใน `originName`/`destinationName`) · รถ = ทะเบียน ณ วันจ่ายงาน · ' +
      'ประเภทรถ = ชื่อ ณ วันจ่ายงาน · เดือน = YYYY-MM · null = ไม่ระบุ (บรรทัดไม่ผูก DO / DO ไม่มีเที่ยวหรือรถ)',
  })
  label!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'รหัสประกอบ — ลูกค้า: รหัสลูกค้า · นิติบุคคล: เลขผู้เสียภาษี · ประเภทรถ: รหัสประเภท · รถ: ประเภทรถ · อื่น ๆ null',
  })
  detail!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'เฉพาะ `groupBy=route`: ชื่อจุดต้นทาง (ข้อมูลหลักปัจจุบัน) · ไม่ระบุ = null',
  })
  originName?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'เฉพาะ `groupBy=route`: ชื่อจุดปลายทาง · ไม่ระบุ = null',
  })
  destinationName?: string | null;
  @ApiProperty({
    description: 'จำนวนใบแจ้งหนี้ที่มีบรรทัดในแถวนี้ (ใบเดียวอาจอยู่หลายแถว — รวมไม่ได้)',
  })
  invoiceCount!: number;
  @ApiProperty({ description: 'จำนวน DO ที่มีบรรทัดในแถวนี้' })
  deliveryOrderCount!: number;
  @ApiProperty({ description: 'จำนวนบรรทัดใบแจ้งหนี้' })
  lineCount!: number;
  @ApiPropertyOptional({
    example: '125000.00',
    description: 'รายได้ = Σ ยอดบรรทัด (หลังส่วนลด **ก่อน VAT**) — `prices.sell:read`',
  })
  @PriceField('sell')
  sellAmount?: string;
}

export class RevenueReportDto {
  @ApiProperty({ enum: REVENUE_GROUP_BY }) groupBy!: string;
  @ApiProperty({ example: '2026-11' }) fromMonth!: string;
  @ApiProperty({ example: '2026-11' }) toMonth!: string;
  @ApiProperty({ example: '2026-11-01', description: 'วันที่ออกใบตั้งแต่ (เวลาไทย)' })
  from!: string;
  @ApiProperty({ example: '2026-11-30', description: 'วันที่ออกใบถึง (รวม)' }) to!: string;
  @ApiProperty({ example: '2026-11-22', description: 'วันที่คำนวณ (วันนี้ เวลาไทย)' })
  asOf!: string;
  @ApiProperty({ description: 'จำนวนใบแจ้งหนี้ที่ออกในช่วง (ไม่รวมร่าง/ยกเลิก)' })
  invoiceCount!: number;
  @ApiProperty({ description: 'จำนวน DO ทั้งหมดที่มีบรรทัดในช่วง' }) deliveryOrderCount!: number;
  @ApiProperty({ description: 'จำนวนบรรทัดทั้งหมด' }) lineCount!: number;
  @ApiPropertyOptional({
    example: '480000.00',
    description:
      'รายได้รวมทั้งช่วง (ก่อน VAT) = Σ `sellAmount` ของทุกแถวในทุกมิติ = Σ ยอดก่อน VAT ของใบที่ออกในช่วง — `prices.sell:read`',
  })
  @PriceField('sell')
  sellAmount?: string;
  @ApiProperty({ type: [RevenueRowDto] }) data!: RevenueRowDto[];
}
