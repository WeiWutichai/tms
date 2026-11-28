import { Body, Controller, Get, HttpCode, Param, Post, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PlatformAuth } from '../common/decorators';
import { defaultFileStore } from '../pdf/file-store';
import { EXT } from '../modules/documents/mime';
import { SignupQueueService } from '../modules/signup/signup-queue.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

const KINDS = ['signup', 'join', 'contact'] as const;
const CHECKS = ['duplicate', 'not_found', 'mismatch', 'match'] as const;
const FIELDS = [
  'name',
  'address',
  'branch',
  'businessStatus',
  'vatRegisteredSince',
  'tsic',
] as const;

export class SignupQueueItemDto {
  @ApiProperty({
    example: 'ten_…',
    description: '`ten_…` = บริษัทที่รอยืนยัน · `jrq_…` = คำขอเข้าร่วมบริษัทเดิม',
  })
  id!: string;
  @ApiProperty({
    enum: KINDS,
    description:
      'signup = สมัครใหม่ (pending_verification) · join = ขอเข้าร่วมบริษัทเดิม (owner ไม่ตอบใน 3 วันทำการ) · contact = "ติดต่อเรา"',
  })
  kind!: string;
  @ApiProperty({ description: 'ชื่อบริษัท (ที่กรอก / บริษัทเดิมของคำขอเข้าร่วม)' }) name!: string;
  @ApiProperty({ nullable: true, type: String }) taxId!: string | null;
  @ApiProperty({ nullable: true, type: String }) branchCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) applicantName!: string | null;
  @ApiProperty({ nullable: true, type: String }) applicantEmail!: string | null;
  @ApiProperty({ nullable: true, type: Number }) fleetSizeOwn!: number | null;
  @ApiProperty({ nullable: true, type: Number }) fleetSizeSubcon!: number | null;
  @ApiProperty({
    enum: CHECKS,
    description: 'ผลตรวจ: เลขซ้ำ / ไม่พบในกรมสรรพากร (หรือเรียกไม่สำเร็จ) / ข้อมูลต่าง / ตรงกัน',
  })
  check!: string;
  @ApiProperty({ enum: ['pending', 'info_requested'] }) status!: string;
  @ApiProperty({
    type: [String],
    description:
      'ธง: same_tax_other_branch, no_accounting_software (R-02 — แปลงเป็นจ่ายจริงไม่ได้จนกว่า P1-ST7)',
  })
  flags!: string[];
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ format: 'date-time', description: 'เริ่มนับเวลารอในคิว' }) waitingSince!: string;
  @ApiProperty({ description: 'รอเกิน SLA 1 วันทำการ (ขอข้อมูลเพิ่มแล้ว = รอผู้สมัคร ไม่นับ)' })
  overSla!: boolean;
}

export class SignupQueueListDto {
  @ApiProperty({
    enum: ['auto_when_verified', 'manual_all'],
    description:
      'นโยบาย `signup.approvalPolicy` ปัจจุบัน (เปลี่ยนที่ PUT /v1/platform/settings/signup.approvalPolicy)',
  })
  policy!: string;
  @ApiProperty({ type: [SignupQueueItemDto], description: 'เรียงตามเวลารอ นานสุดก่อน' })
  data!: SignupQueueItemDto[];
}

export class SignupQueueCompareRowDto {
  @ApiProperty({ enum: FIELDS }) field!: string;
  @ApiProperty({ nullable: true, type: String, description: 'ที่กรอก' }) entered!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'กรมสรรพากร (null = ไม่พบ/เรียกไม่สำเร็จ)',
  })
  rd!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'กรมพัฒนาธุรกิจการค้า — เฟส 1 ไม่มี API (R-08) = null เสมอ ค้นด้วยมือ',
  })
  dbd!: string | null;
  @ApiProperty({ description: 'ที่กรอกต่างจากข้อมูลทางการ → ไฮไลต์' }) differs!: boolean;
}
export class SignupQueueCertificateDto {
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
}
export class SignupQueueDuplicateDto {
  @ApiProperty({ example: 'ten_…' }) tenantId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
}
export class SignupQueueHistoryRowDto {
  @ApiProperty({ enum: ['tenant', 'join', 'session'] }) kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ enum: ['ip', 'email', 'both'] }) match!: string;
  @ApiProperty({ format: 'date-time' }) at!: string;
}
export class SignupQueueVerificationDto {
  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'info_requested'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: String }) decidedByName!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
}
export class SignupQueueManualSearchDto {
  @ApiProperty({ description: 'หน้าค้นผู้จด VAT ของกรมสรรพากร' }) rd!: string;
  @ApiProperty({ description: 'หน้าค้นนิติบุคคลของกรมพัฒนาธุรกิจการค้า' }) dbd!: string;
}
export class SignupQueueDetailDto extends SignupQueueItemDto {
  @ApiProperty({ enum: ['found', 'tin_only', 'not_found', 'unavailable'] }) rdStatus!: string;
  @ApiProperty({
    type: SignupQueueManualSearchDto,
    description: 'ลิงก์ค้นด้วยมือ (spec §10.3 ข้อ 8)',
  })
  manualSearch!: SignupQueueManualSearchDto;
  @ApiProperty({ type: [SignupQueueCompareRowDto] }) compare!: SignupQueueCompareRowDto[];
  @ApiProperty({ type: SignupQueueCertificateDto, nullable: true })
  certificate!: SignupQueueCertificateDto | null;
  @ApiProperty({
    type: SignupQueueDuplicateDto,
    nullable: true,
    description: 'บริษัทเดิมที่ใช้เลขนี้',
  })
  duplicate!: SignupQueueDuplicateDto | null;
  @ApiProperty({
    type: [SignupQueueHistoryRowDto],
    description: 'การสมัครอื่นจาก IP/อีเมลเดียวกัน',
  })
  history!: SignupQueueHistoryRowDto[];
  @ApiProperty({ nullable: true, type: String }) accountingSoftware!: string | null;
  @ApiProperty({ nullable: true, type: String }) planCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'กำหนด owner ตอบ (join)',
  })
  ownerDueAt!: string | null;
  @ApiProperty({ type: SignupQueueVerificationDto, nullable: true })
  verification!: SignupQueueVerificationDto | null;
}

/** PLT-105 เหตุผล ≥ 10 ตัว — ไม่ส่ง/สั้นไป = 422 */
export class SignupQueueDecisionDto {
  @ApiProperty({
    example: 'ชื่อไม่ตรงกับ ภ.พ.20 ที่แนบมา กรุณาส่งเอกสารใหม่',
    minLength: 10,
    description:
      'ปฏิเสธ / ขอข้อมูลเพิ่ม: ส่งถึงผู้สมัครทางอีเมล (PLT-105) · อนุมัติ / ปิดเรื่อง / ตรวจต่อ / ส่งต่อ owner: เหตุผลภายใน ลง audit อย่างเดียว',
  })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
export class SignupQueueApproveDto extends SignupQueueDecisionDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'ข้อความถึงผู้สมัครในอีเมลอนุมัติ (ไม่บังคับ — เหตุผลภายในไม่ถูกส่ง)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  message?: string;
  @ApiPropertyOptional({
    description:
      'PLT-106 แก้ชื่อ/ที่อยู่ของบริษัทให้ตรงข้อมูลกรมสรรพากรในขั้นเดียวกับอนุมัติ (เฉพาะ signup ที่พบใน RD)',
  })
  @IsOptional()
  @IsBoolean()
  applyOfficialData?: boolean;
}

export class SignupQueueCloseDto extends SignupQueueDecisionDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'ข้อความถึงผู้ติดต่อ (ไม่บังคับ — ไม่ส่ง = ข้อความมาตรฐาน)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  message?: string;
}

/**
 * คิวอนุมัติการสมัคร (P1-ST2-T06; spec/01 §10.3) — ดู: ทีมทุกบทบาท (§11.4 "ดูลูกค้า")
 * อนุมัติ/ปฏิเสธ/ขอข้อมูลเพิ่ม: owner (SUPER_ADMIN) + support (SUPPORT) — finance (BILLING) ไม่ได้ (§11.4) · sales ยังไม่มีบทบาทใน Console
 * รายละเอียดกติกา: `SignupQueueService`
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform/signup-queue')
export class PlatformSignupQueueController {
  constructor(private readonly queue: SignupQueueService) {}

  @Get()
  @PlatformAuth()
  @ApiOkResponse({ type: SignupQueueListDto })
  async list(): Promise<SignupQueueListDto> {
    const r = await this.queue.list();
    return { policy: r.policy, data: r.items };
  }

  @Get(':id')
  @PlatformAuth()
  @ApiOkResponse({ type: SignupQueueDetailDto })
  detail(@Param('id') id: string): Promise<SignupQueueDetailDto> {
    return this.queue.detail(id);
  }

  @Get(':id/certificate')
  @PlatformAuth()
  @ApiProduces('application/pdf', 'image/jpeg', 'image/png')
  @ApiOkResponse({ description: 'ไฟล์หนังสือรับรองบริษัทที่ผู้สมัครแนบ (attachment, no-store)' })
  async certificate(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const doc = await this.queue.certificate(id);
    const data = await defaultFileStore().get(doc.fileKey!);
    const ext = (EXT as Record<string, string>)[doc.mimeType] ?? 'bin';
    const ascii = `company-certificate.${ext}`;
    const utf8 = encodeURIComponent(doc.filename ?? ascii).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(data);
  }

  @Post(':id/approve')
  @HttpCode(204)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  async approve(@Param('id') id: string, @Body() body: SignupQueueApproveDto): Promise<void> {
    await this.queue.approve(id, body);
  }

  @Post(':id/reject')
  @HttpCode(204)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  async reject(@Param('id') id: string, @Body() body: SignupQueueDecisionDto): Promise<void> {
    await this.queue.reject(id, body.reason);
  }

  /** "ตรวจต่อ" หลังผู้สมัครตอบ: info_requested → pending (เริ่มนับเวลารอใหม่) */
  @Post(':id/resume')
  @HttpCode(204)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  async resume(@Param('id') id: string, @Body() body: SignupQueueDecisionDto): Promise<void> {
    await this.queue.resume(id, body.reason);
  }

  /** "ติดต่อเรา": ปิดเรื่อง (ไม่เพิ่มคนเข้าบริษัท) — รายการอื่น 422 */
  @Post(':id/close')
  @HttpCode(204)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  async close(@Param('id') id: string, @Body() body: SignupQueueCloseDto): Promise<void> {
    await this.queue.close(id, body);
  }

  /** "ติดต่อเรา": ส่งต่อ owner ของบริษัทเดิม (คำขอเข้าร่วม +3 วันทำการ) — ไม่มี owner ที่ใช้งานอยู่ 409 */
  @Post(':id/forward-owner')
  @HttpCode(204)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  async forwardOwner(@Param('id') id: string, @Body() body: SignupQueueDecisionDto): Promise<void> {
    await this.queue.forwardToOwner(id, body.reason);
  }

  @Post(':id/request-info')
  @HttpCode(204)
  @PlatformAuth('SUPER_ADMIN', 'SUPPORT')
  async requestInfo(@Param('id') id: string, @Body() body: SignupQueueDecisionDto): Promise<void> {
    await this.queue.requestInfo(id, body.reason);
  }
}
