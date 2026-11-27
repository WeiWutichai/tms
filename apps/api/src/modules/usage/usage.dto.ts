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
