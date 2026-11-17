import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  POD_FIELD_LEVELS,
  POD_FIELD_TYPES,
  POD_OUTCOMES,
  POD_PHOTO_MIN_COUNT_MAX,
  type PodChecklistSource,
} from '@tms/domain';

/** หนึ่งข้อใน POD checklist (ST4-T05; docs/04 E2) — ใช้อธิบาย schema ใน OpenAPI (ตัวตรวจจริง = `parsePodRequirements`) */
export class PodFieldDto {
  @ApiProperty({
    example: 'photo',
    description:
      'อ้างอิงในหลักฐานที่ส่ง — PHOTO/SIGNATURE/NOTE = photo/signature/note (ไม่ต้องส่ง); BOOLEAN ตั้งเอง ^[a-z][a-z0-9_]{0,39}$',
  })
  key!: string;
  @ApiProperty({ enum: POD_FIELD_TYPES }) type!: (typeof POD_FIELD_TYPES)[number];
  @ApiProperty({
    enum: POD_FIELD_LEVELS,
    description:
      'DISABLED = ไม่ใช้ · ENABLED = ใช้ ไม่บังคับ · REQUIRED = บังคับ (ขาด → ปิดงานไม่ได้)',
  })
  level!: (typeof POD_FIELD_LEVELS)[number];
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'ข้อความที่ผู้รับ/คนขับต้องยืนยัน — บังคับสำหรับ BOOLEAN เท่านั้น',
  })
  label?: string;
  @ApiPropertyOptional({
    minimum: 1,
    maximum: POD_PHOTO_MIN_COUNT_MAX,
    description: 'จำนวนรูปขั้นต่ำเมื่อบังคับ — PHOTO เท่านั้น (ไม่ส่ง = 1)',
  })
  minCount?: number;
}

export class PodChecklistDto {
  @ApiProperty({
    type: [PodFieldDto],
    description:
      'PHOTO/SIGNATURE/NOTE มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN ได้สูงสุด 10 ข้อ — response เรียงตามชนิดเสมอ',
  })
  fields!: PodFieldDto[];
}

/** `customer.pod_requirements` / ค่าตั้ง `pod.checklist` — ชุดต่อผลการส่ง (เฟสนี้มีเฉพาะ success; ชุด failure = ST4-T06) */
export class PodRequirementsDto {
  @ApiPropertyOptional({
    type: PodChecklistDto,
    description: 'ชุดเมื่อส่งสำเร็จ — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร',
  })
  success?: PodChecklistDto;
}

export class EffectivePodChecklistDto {
  @ApiProperty({ enum: POD_OUTCOMES }) outcome!: (typeof POD_OUTCOMES)[number];
  @ApiProperty({
    enum: ['TENANT', 'CUSTOMER'],
    description: 'TENANT = ใช้ค่าเริ่มต้นขององค์กร · CUSTOMER = ลูกค้ากำหนดเอง',
  })
  source!: PodChecklistSource;
  @ApiProperty({ type: [PodFieldDto] }) fields!: PodFieldDto[];
  @ApiProperty({
    type: [PodFieldDto],
    description:
      'ชุดค่าเริ่มต้นขององค์กร (ใช้เมื่อลูกค้าไม่กำหนดเอง) — แสดง/ตั้งต้นเมื่อสลับโหมดใน drawer ลูกค้า',
  })
  tenantFields!: PodFieldDto[];
}

export class CustomerPodChecklistDto {
  @ApiProperty({ type: [EffectivePodChecklistDto], description: 'checklist ที่ใช้จริงต่อผลการส่ง' })
  data!: EffectivePodChecklistDto[];
}
