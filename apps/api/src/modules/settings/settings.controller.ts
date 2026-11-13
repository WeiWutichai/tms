import { Body, Controller, Get, Headers, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { verifyStepUpToken } from '../../auth/tokens';
import { requestContext } from '../../common/request-context';
import { IsObject, IsOptional } from 'class-validator';
import { RequireScope } from '../../common/decorators';
import { SettingsService } from './settings.service';

export class SettingDto {
  @ApiProperty({ example: 'security.idleTimeoutMinutes' }) key!: string;
  @ApiProperty({
    description: 'ค่าปัจจุบัน (ชนิดตาม registry)',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  value!: unknown;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) default!: unknown;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) updatedAt!: string | null;
}
export class SettingListDto {
  @ApiProperty({ type: [SettingDto] }) data!: SettingDto[];
}
export class UpdateSettingsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { 'org.yearStyle': 'BE', 'security.idleTimeoutMinutes': 60 },
    description: 'key → ค่าใหม่ (เฉพาะ key ที่จะแก้)',
  })
  @IsObject()
  values!: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { 'security.idleTimeoutMinutes': 2 },
    description: 'version ของแต่ละ key จาก GET (optimistic lock) — ไม่ตรง → 412',
  })
  @IsOptional()
  @IsObject()
  versions?: Record<string, number>;
}

/** ค่าตั้งองค์กร (ST1-T17) — อ่าน settings:read, แก้ settings:write (owner/admin ตาม A3) */
@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequireScope('settings:read')
  @ApiOkResponse({ type: SettingListDto })
  async list(): Promise<SettingListDto> {
    return { data: await this.settings.list() };
  }

  @Patch()
  @RequireScope('settings:write')
  @ApiHeader({
    name: 'X-Step-Up',
    required: false,
    description:
      'ต้องมีเมื่อแก้ที่ลดความปลอดภัย (ปิด 2FA ทั้งองค์กร / ปิดออกจากระบบอัตโนมัติ / ยืด idle timeout) — ไม่มี → 403 step_up_required',
  })
  @ApiOkResponse({ type: SettingListDto })
  async update(
    @Body() body: UpdateSettingsDto,
    @Headers('x-step-up') stepUp?: string,
  ): Promise<SettingListDto> {
    const ctx = requestContext.require();
    const su = stepUp ? await verifyStepUpToken(stepUp) : null;
    const steppedUp = !!su && su.sub === ctx.actorId && su.tid === ctx.tenantId;
    return { data: await this.settings.update(body.values, body.versions ?? {}, steppedUp) };
  }
}
