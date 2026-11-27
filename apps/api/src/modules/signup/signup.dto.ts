import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** ขั้น 1 "สร้างบัญชี" (P1-ST2-T03; spec/01 §2 ขั้น 1) */
export class StartSignupDto {
  @ApiProperty({
    example: 'สมชาย ใจดี',
    description: 'ชื่อ-นามสกุล (ช่องเดียวตามต้นแบบ — ตรงกับ `name` ของผู้ใช้)',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'name@company.co.th' })
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    example: '+66812345678',
    description:
      'เบอร์มือถือไทย E.164 (+66 ตามด้วย 9 หลัก) — รับ 08x / +66 8x ได้ ระบบ normalize ให้',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  mobile!: string;

  @ApiProperty({
    format: 'password',
    description: '≥ 12 ตัว ไม่อยู่ในรายการรหัสที่รั่ว (นโยบาย ST1-T02)',
  })
  @IsString()
  @MaxLength(1024)
  password!: string;

  @ApiPropertyOptional({ enum: ['th', 'en'], description: 'ภาษาของข้อความ OTP (ค่าเริ่ม th)' })
  @IsOptional()
  @IsIn(['th', 'en'])
  locale?: string;
}

export class VerifySignupOtpDto {
  @ApiProperty({ example: '123456', description: 'รหัส 6 หลัก' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class SignupOtpStateDto {
  @ApiProperty({ enum: ['email', 'sms'], description: 'ช่องทางที่ส่งรหัส (อีเมลจนกว่า X-04)' })
  channel!: string;
  @ApiProperty({ description: 'ปลายทางที่ส่งรหัสไป (อีเมลหรือเบอร์ของผู้สมัคร)' })
  sentTo!: string;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'รหัสหมดอายุ (5 นาทีหลังส่ง) · null = ไม่มีรหัสที่ใช้ได้ (ต้องขอใหม่)',
  })
  expiresAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'ขอรหัสใหม่ได้ตั้งแต่เวลานี้ (60 วินาทีหลังส่ง)',
  })
  resendAvailableAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'ล็อกถึง (ผิด 5 ครั้ง → 15 นาที)',
  })
  lockedUntil!: string | null;
  @ApiProperty({ description: 'ใส่ผิดได้อีกกี่ครั้งก่อนล็อก' })
  attemptsLeft!: number;
}

export class SignupSessionDto {
  @ApiProperty({
    enum: [
      'account_pending_otp',
      'account_verified',
      'company_submitted',
      'completed',
      'abandoned',
    ],
  })
  status!: string;
  @ApiProperty({ description: 'ขั้นของ stepper: 1 บัญชี · 2 บริษัท · 3 แพ็กเกจ' })
  step!: number;
  @ApiProperty()
  name!: string;
  @ApiProperty()
  email!: string;
  @ApiProperty({ example: '+66812345678' })
  mobile!: string;
  @ApiProperty({
    type: SignupOtpStateDto,
    nullable: true,
    description: 'สถานะ OTP — มีเฉพาะ account_pending_otp',
  })
  otp!: SignupOtpStateDto | null;
}

export class SignupStartResultDto {
  @ApiProperty({
    description:
      'token ทำต่อ — ส่งใน header `X-Signup-Token` ของคำขอถัดไป · แสดงครั้งเดียว (ระบบเก็บแค่ hash) · login ด้วยอีเมล/รหัสของการสมัครได้ token ใหม่',
  })
  token!: string;
  @ApiProperty({ type: SignupSessionDto })
  session!: SignupSessionDto;
}
