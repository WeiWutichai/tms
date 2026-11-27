import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ActiveVehicleQuery {
  @ApiPropertyOptional({
    example: '2026-11',
    description: 'เดือนปฏิทินเวลาไทย YYYY-MM (ไม่ส่ง = เดือนนี้)',
  })
  @IsOptional()
  @IsString()
  @Matches(PERIOD_RE)
  period?: string;
}

export class ActiveVehicleItemDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'กข-1234',
    description:
      'ทะเบียนตามเที่ยวแรกที่ทำให้นับ — null = เอกสารรถร่วมไม่มีทะเบียน (`plateMissing`)',
  })
  plate!: string | null;
  @ApiProperty({
    description:
      'เที่ยวไม่มีทะเบียน — นับด้วยรถร่วม + คนขับแทน ให้เติมทะเบียนบนเที่ยว (spec/01 §7 ข้อ 8)',
  })
  plateMissing!: boolean;
  @ApiProperty({ description: 'รถร่วม (เที่ยวมีผู้รับเหมา)' }) subcontract!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'ประเภทรถตามเที่ยวแรก' })
  vehicleType!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ผู้รับเหมา (รถร่วม)' })
  carrierName!: string | null;
  @ApiProperty({ description: 'จำนวนเที่ยวในเดือนที่เข้าเงื่อนไขการนับของทะเบียนนี้' })
  trips!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'trp_…',
    description: 'เที่ยวแรกที่ทำให้นับ (null = ทีมผู้ให้บริการเพิ่มเอง / เที่ยวถูกลบ)',
  })
  firstTripId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'TRP-2611-0001' })
  firstTripNo!: string | null;
  @ApiProperty({
    format: 'date-time',
    description: 'เวลาที่เที่ยวแรกเข้าเงื่อนไข (ปล่อยรถ / ปิดงาน)',
  })
  firstCountedAt!: string;
  @ApiProperty({ description: 'ทีมผู้ให้บริการปรับหลังปิดยอด' }) adjusted!: boolean;
}

export class ActiveVehicleUsageDto {
  @ApiProperty({ example: '2026-11' }) period!: string;
  @ApiProperty({
    enum: ['open', 'finalized', 'invoiced'],
    description:
      'open = ยังนับอยู่ (ค่าสด) · finalized = ปิดยอดแล้ว (วันที่ 1 เวลา 02:00 น. ไทยของเดือนถัดไป)',
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) finalizedAt!: string | null;
  @ApiProperty({
    description:
      'รถ active ของเดือน (metric `vehicles.active`) = ทะเบียน normalize ที่มีเที่ยวเข้าเงื่อนไข ≥ 1 เที่ยว (docs/02 §2) · ' +
      'กติกาปัจจุบัน: เที่ยวที่ปล่อยรถแล้ว (ไม่นับร่าง/ยกเลิกก่อนออกวิ่ง/sandbox) นับตามเวลาไทย — plan/13 R-05',
  })
  activeVehicles!: number;
  @ApiProperty({ description: 'รถบริษัท' }) own!: number;
  @ApiProperty({ description: 'รถร่วม' }) subcontract!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'โควตารถ active ต่อเดือน (tenant.vehicle_quota → entitlement `veh`) — null = ไม่จำกัด',
  })
  limit!: number | null;
  @ApiProperty({ type: [ActiveVehicleItemDto] }) data!: ActiveVehicleItemDto[];
}

// ---------- Console ----------

export class PlatformActiveVehicleItemDto extends ActiveVehicleItemDto {
  @ApiProperty({ example: 'avu_…' }) id!: string;
  @ApiProperty({ description: 'ตัดออกจากการนับโดยทีมการเงิน (ไม่แสดงให้ลูกค้า)' })
  excluded!: boolean;
}

export class PlatformActiveVehicleUsageDto extends ActiveVehicleUsageDto {
  @ApiProperty({ type: [PlatformActiveVehicleItemDto] })
  declare data: PlatformActiveVehicleItemDto[];
}

class UsageReasonBody {
  @ApiProperty({
    example: 'ลูกค้าแจ้งว่าทะเบียนนี้เป็นรถทดสอบ ไม่ได้วิ่งจริง',
    minLength: 10,
    description: 'เหตุผลภายใน (ลง platform_audit_log — ลูกค้าไม่เห็น)',
  })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class UsageAdjustReasonDto extends UsageReasonBody {}

export class AddActiveVehicleDto extends UsageReasonBody {
  @ApiProperty({ example: '2026-10', description: 'เดือนที่ปิดยอดแล้ว' })
  @IsString()
  @Matches(PERIOD_RE)
  period!: string;
  @ApiProperty({ example: 'กข-1234' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  plate!: string;
}

// ---------- P1-ST1-T07 เมตริกอื่นต่อเดือน ----------

export class ApiCallsDto {
  @ApiProperty({ description: 'รวมทุก source' }) total!: number;
  @ApiProperty({ description: 'REST (API key / OAuth client)' }) rest!: number;
  @ApiProperty({ description: 'MCP (ยังไม่มีในเฟส 1 = 0)' }) mcp!: number;
}

export class UsageMetricsDto {
  @ApiProperty({ example: '2026-11' }) period!: string;
  @ApiProperty({
    enum: ['open', 'finalized', 'invoiced'],
    description:
      'open = ยังนับอยู่ (DO/ใบแจ้งหนี้อัปเดตทุก ≤ 10 นาที, API calls ≤ 30 วินาที) · finalized = ปิดยอดพร้อมรถ active (วันที่ 1 เวลา 02:00 น. ไทย)',
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) finalizedAt!: string | null;
  @ApiProperty({
    description: '`do.created` — DO ที่สร้างในเดือน (เวลาไทย) ไม่รวมที่ยกเลิก = ผลรวมรายวัน',
  })
  doCreated!: number;
  @ApiProperty({ description: '`invoices.issued` — ใบแจ้งหนี้ที่ออกเลขในเดือน = ผลรวมรายวัน' })
  invoicesIssued!: number;
  @ApiProperty({
    type: ApiCallsDto,
    description:
      '`api.calls` — คำขอ `/v1` ของ API key / OAuth client ที่ตอบ 2xx/3xx/4xx (ไม่นับ 429 และ 5xx) · ' +
      'UI ของระบบไม่นับ · key ของ sandbox ไม่นับ',
  })
  apiCalls!: ApiCallsDto;
  @ApiProperty({
    example: 1.25,
    description:
      '`storage.pod_gb` — ขนาดไฟล์ POD + เอกสารแนบที่อัปโหลด (GB = 1024³ ทศนิยม 2, สะสมไม่รีเซ็ต) ณ วันล่าสุดของเดือน',
  })
  podStorageGb!: number;
  @ApiProperty({ description: '`connectors.accounting` — connector ระบบบัญชีที่ active' })
  connectors!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'จำนวน connector สูงสุดตามแพ็กเกจ (entitlement `conn`) — null = ไม่จำกัด/ไม่กำหนด',
  })
  connectorLimit!: number | null;
  @ApiProperty({ description: '`users.active` — ผู้ใช้สถานะใช้งาน' }) users!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'เอกสาร e-Tax — ไม่มีในเฟส 1 (plan/13 R-17) จึงเป็น null เสมอ (UI แสดง "—")',
  })
  eTaxDocuments!: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date',
    description: 'วันของค่า POD/connector/ผู้ใช้ (null = ค่าสด)',
  })
  gaugeAsOf!: string | null;
  @ApiProperty({
    enum: ['usage_record', 'usage_daily'],
    description:
      'ที่มาของตัวเลข: usage_record = ยอดปิดของเมตริกเหล่านี้ · usage_daily = คำนวณจากยอดรายวัน (เดือนที่ยังเปิด หรือเดือนที่ปิดยอดรถ active ก่อนมีเมตริกอื่น)',
  })
  metricsSource!: string;
}
