import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  POD_FIELD_LEVELS,
  POD_FIELD_TYPES,
  POD_OUTCOMES,
  POD_OPTION_MAX,
  POD_OPTIONS_MAX,
  POD_OPTIONS_MIN,
  POD_PHOTO_MIN_COUNT_MAX,
  POD_PIN_LENGTH_DEFAULT,
  POD_PIN_LENGTH_MAX,
  POD_PIN_LENGTH_MIN,
  POD_RATING_MAX_DEFAULT,
  POD_RATING_MAX_MAX,
  POD_RATING_MAX_MIN,
  type PodChecklistSource,
} from '@tms/domain';

/** หนึ่งข้อใน POD checklist (ST4-T05/T06; docs/04 E2) — ใช้อธิบาย schema ใน OpenAPI (ตัวตรวจจริง = `parsePodRequirements`) */
export class PodFieldDto {
  @ApiProperty({
    example: 'photo',
    description:
      'อ้างอิงในหลักฐานที่ส่ง — PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING = ชื่อชนิดตัวเล็ก (ไม่ต้องส่ง); BOOLEAN/SINGLE_CHOICE ตั้งเอง ^[a-z][a-z0-9_]{0,39}$',
  })
  key!: string;
  @ApiProperty({ enum: POD_FIELD_TYPES }) type!: (typeof POD_FIELD_TYPES)[number];
  @ApiProperty({
    enum: POD_FIELD_LEVELS,
    description:
      'DISABLED = ไม่ใช้ · ENABLED = ใช้ ไม่บังคับ (ค่าที่ส่งของ BARCODE/SINGLE_CHOICE/PIN/RATING ยังต้องถูกรูปแบบ) · REQUIRED = บังคับ (ขาด → ปิดงานไม่ได้)',
  })
  level!: (typeof POD_FIELD_LEVELS)[number];
  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'BOOLEAN = ข้อความที่ผู้รับ/คนขับต้องยืนยัน · SINGLE_CHOICE = คำถาม — บังคับสำหรับสองชนิดนี้เท่านั้น',
  })
  label?: string;
  @ApiPropertyOptional({
    minimum: 1,
    maximum: POD_PHOTO_MIN_COUNT_MAX,
    description: 'จำนวนรูปขั้นต่ำเมื่อบังคับ — PHOTO เท่านั้น (ไม่ส่ง = 1)',
  })
  minCount?: number;
  @ApiPropertyOptional({
    type: [String],
    minItems: POD_OPTIONS_MIN,
    maxItems: POD_OPTIONS_MAX,
    description: `ตัวเลือก — SINGLE_CHOICE เท่านั้น (บังคับ, ${POD_OPTIONS_MIN}–${POD_OPTIONS_MAX} ข้อ ข้อละ 1–${POD_OPTION_MAX} ตัวอักษร ไม่ซ้ำ)`,
  })
  options?: string[];
  @ApiPropertyOptional({
    minimum: POD_PIN_LENGTH_MIN,
    maximum: POD_PIN_LENGTH_MAX,
    description: `จำนวนหลักของรหัสที่ผู้รับกรอก — PIN เท่านั้น (ไม่ส่ง = ${POD_PIN_LENGTH_DEFAULT}) · PIN เก็บเป็นค่าที่บันทึก ตรวจรูปแบบตัวเลขครบหลัก ยังไม่เทียบกับรหัสที่ส่งล่วงหน้า`,
  })
  length?: number;
  @ApiPropertyOptional({
    minimum: POD_RATING_MAX_MIN,
    maximum: POD_RATING_MAX_MAX,
    description: `คะแนนเต็ม — RATING เท่านั้น (ไม่ส่ง = ${POD_RATING_MAX_DEFAULT}; ผู้รับให้คะแนน 1–max)`,
  })
  max?: number;
}

export class PodChecklistDto {
  @ApiProperty({
    type: [PodFieldDto],
    description:
      'PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด)',
  })
  fields!: PodFieldDto[];
}

/** `customer.pod_requirements` / ค่าตั้ง `pod.checklist` — ชุดต่อผลการส่ง (success / failure — ST4-T06) */
export class PodRequirementsDto {
  @ApiPropertyOptional({
    type: PodChecklistDto,
    description: 'ชุดเมื่อส่งสำเร็จ — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร',
  })
  success?: PodChecklistDto;
  @ApiPropertyOptional({
    type: PodChecklistDto,
    description:
      'ชุดเมื่อส่งไม่สำเร็จ (outcome FAILED / UNDELIVERED_RETAIN) — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร · ค่าองค์กร: ไม่ส่ง = ค่าระบบ (รูป ≥ 1 + หมายเหตุ บังคับ)',
  })
  failure?: PodChecklistDto;
}

export class EffectivePodChecklistDto {
  @ApiProperty({
    enum: POD_OUTCOMES,
    description:
      'SUCCESS = ส่งสำเร็จ (DELIVERED/PARTIAL) · FAILURE = ส่งไม่สำเร็จ (FAILED/UNDELIVERED_RETAIN)',
  })
  outcome!: (typeof POD_OUTCOMES)[number];
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
