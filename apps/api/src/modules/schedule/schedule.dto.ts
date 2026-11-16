import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { SCHEDULE_ENTRY_KINDS, type ScheduleEntryKind } from '@tms/domain';
import { CleanText } from '../master/master-kit';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ScheduleEntryListQuery {
  @ApiProperty({ example: '2026-11-17', format: 'date', description: 'วันแรก (วันไทย)' })
  @Matches(DATE_RE)
  from!: string;

  @ApiProperty({
    example: '2026-11-23',
    format: 'date',
    description: 'วันสุดท้าย (รวม) — ช่วงไม่เกิน 62 วัน',
  })
  @Matches(DATE_RE)
  to!: string;

  @ApiPropertyOptional({ example: 'drv_…', description: 'เฉพาะคนขับคนนี้' })
  @IsOptional()
  @IsString()
  driverId?: string;

  @ApiPropertyOptional({ example: 'veh_…', description: 'เฉพาะรถคันนี้' })
  @IsOptional()
  @IsString()
  vehicleId?: string;
}

export class CreateScheduleEntryDto {
  @ApiProperty({
    enum: SCHEDULE_ENTRY_KINDS,
    description:
      'LEAVE = วันลาคนขับ (ต้องมี driverId) · NOTE = โน้ตรายวันของคนขับหรือรถ (อย่างใดอย่างหนึ่ง)',
  })
  @IsIn(SCHEDULE_ENTRY_KINDS)
  kind!: ScheduleEntryKind;

  @ApiPropertyOptional({ example: 'drv_…' })
  @IsOptional()
  @IsString()
  driverId?: string;

  @ApiPropertyOptional({ example: 'veh_…', description: 'เฉพาะ NOTE' })
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @ApiProperty({ example: '2026-11-18', format: 'date', description: 'วันแรก (วันไทย)' })
  @Matches(DATE_RE)
  startsOn!: string;

  @ApiProperty({
    example: '2026-11-19',
    format: 'date',
    description: 'วันสุดท้าย (รวม) ≥ startsOn · ช่วงไม่เกิน 366 วันรวมวันแรกและวันสุดท้าย',
  })
  @Matches(DATE_RE)
  endsOn!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    example: 'ลาป่วย',
    description: 'เหตุผลการลา / ข้อความโน้ต',
  })
  @CleanText()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;
}

export class CancelScheduleEntryDto {
  @ApiProperty({ minLength: 10, maxLength: 500, description: 'เหตุผล (ลง audit)' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class ScheduleEntryDriverDto {
  @ApiProperty({ example: 'drv_…' }) id!: string;
  @ApiProperty() name!: string;
}

export class ScheduleEntryVehicleDto {
  @ApiProperty({ example: 'veh_…' }) id!: string;
  @ApiProperty() plate!: string;
  @ApiProperty({ example: 'TH-10' }) plateProvince!: string;
}

export class ScheduleEntryDto {
  @ApiProperty({ example: 'sch_…' }) id!: string;
  @ApiProperty({ enum: SCHEDULE_ENTRY_KINDS }) kind!: ScheduleEntryKind;
  @ApiProperty({ type: ScheduleEntryDriverDto, nullable: true })
  driver!: ScheduleEntryDriverDto | null;
  @ApiProperty({ type: ScheduleEntryVehicleDto, nullable: true })
  vehicle!: ScheduleEntryVehicleDto | null;
  @ApiProperty({ format: 'date' }) startsOn!: string;
  @ApiProperty({ format: 'date' }) endsOn!: string;
  @ApiProperty({ description: 'เหตุผลการลา / ข้อความโน้ต' }) note!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class ScheduleEntryListDto {
  @ApiProperty({ type: [ScheduleEntryDto] }) data!: ScheduleEntryDto[];
}
