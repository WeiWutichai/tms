import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { RequireScope } from '../../common/decorators';
import { SettingsService } from './settings.service';

export class SettingDto {
  @ApiProperty({ example: 'security.idleTimeoutMinutes' }) key!: string;
  @ApiProperty({ description: 'ค่าปัจจุบัน (ชนิดตาม registry)', nullable: true }) value!: unknown;
  @ApiProperty({ nullable: true }) default!: unknown;
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
  @ApiOkResponse({ type: SettingListDto })
  async update(@Body() body: UpdateSettingsDto): Promise<SettingListDto> {
    return { data: await this.settings.update(body.values) };
  }
}
