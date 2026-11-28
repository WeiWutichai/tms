import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RequireScope } from '../../common/decorators';
import { SAMPLE_ENTITY_TYPES, SampleDataService } from './sample-data.service';

export class SampleCountsDto {
  @ApiProperty() customer!: number;
  @ApiProperty({ description: 'สถานที่ / จุดรับส่ง' }) customer_site!: number;
  @ApiProperty({ description: 'รถร่วม' }) carrier!: number;
  @ApiProperty() vehicle!: number;
  @ApiProperty({ description: 'คนขับ' }) driver!: number;
  @ApiProperty() rate_card!: number;
  @ApiProperty({ description: 'ใบสั่งขนส่ง' }) sales_order!: number;
}

export class SampleDataStatusDto {
  @ApiProperty({
    description:
      'ใส่ข้อมูลตัวอย่างได้ไหม — บริษัทช่วงทดลองใช้ (TRIALING / PENDING_VERIFICATION) หรือ sandbox',
  })
  allowed!: boolean;
  @ApiProperty({ description: 'มีแถวที่ติดธงข้อมูลตัวอย่างอยู่' }) loaded!: boolean;
  @ApiProperty({ type: SampleCountsDto, description: 'จำนวนแถวตัวอย่างที่ยังอยู่ต่อชนิด' })
  counts!: SampleCountsDto;
}

export class SampleKeptDto {
  @ApiProperty({ enum: SAMPLE_ENTITY_TYPES }) entityType!: string;
  @ApiProperty({ example: 'ord_…' }) id!: string;
  @ApiProperty({ description: 'รหัส/ชื่อ/เลขที่ให้ผู้ใช้จำได้', example: 'SO-2611-0001' })
  label!: string;
  @ApiProperty({
    enum: ['in_use'],
    description:
      'in_use = ถูกใช้ต่อแล้ว (มี DO/เอกสาร หรือข้อมูลจริงอ้างถึง) — ไม่ลบ คงธงตัวอย่างไว้',
  })
  reason!: string;
}

export class SampleDataClearDto extends SampleDataStatusDto {
  @ApiProperty({ type: SampleCountsDto, description: 'จำนวนที่ลบต่อชนิด' })
  removed!: SampleCountsDto;
  @ApiProperty({ type: [SampleKeptDto], description: 'แถวตัวอย่างที่ลบไม่ได้เพราะถูกใช้ต่อแล้ว' })
  kept!: SampleKeptDto[];
}

/**
 * ข้อมูลตัวอย่างสำหรับ trial (P1-ST2-T09; docs/02 §2) — ขั้น "ใส่ข้อมูลตัวอย่าง" ของการ์ดเริ่มต้นใช้งาน
 * สิทธิ์เดียวกับ setup checklist (settings:write = owner/admin)
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('sample-data')
export class SampleDataController {
  constructor(private readonly samples: SampleDataService) {}

  @Get()
  @RequireScope('settings:write')
  @ApiOperation({ summary: 'สถานะข้อมูลตัวอย่าง' })
  @ApiOkResponse({ type: SampleDataStatusDto })
  status(): Promise<SampleDataStatusDto> {
    return this.samples.status();
  }

  @Post()
  @HttpCode(200)
  @RequireScope('settings:write')
  @ApiOperation({
    summary: 'ใส่ข้อมูลตัวอย่าง',
    description:
      'ใส่บริษัทขนส่งสมมติ: ลูกค้า 3 · สถานที่ 7 · รถร่วม 2 · รถ 5 · คนขับ 2 · rate card (ขาย/ซื้อ อนุมัติแล้ว) · ใบสั่งขนส่ง 4 ' +
      '— ทุกแถวติดธงตัวอย่าง · ไม่ส่ง webhook · ช่วงทดลองใช้ไม่นับรถ active / usage · ออกใบแจ้งหนี้ให้ลูกค้าตัวอย่างไม่ได้ · เฉพาะช่วงทดลองใช้หรือ sandbox (409 `sample_data_not_allowed`) · ' +
      'มีอยู่แล้ว → 409 `sample_data_loaded`',
  })
  @ApiOkResponse({ type: SampleDataStatusDto })
  load(): Promise<SampleDataStatusDto> {
    return this.samples.load();
  }

  @Post('clear')
  @HttpCode(200)
  @RequireScope('settings:write')
  @ApiOperation({
    summary: 'ล้างข้อมูลตัวอย่าง',
    description:
      'ลบเฉพาะแถวที่ติดธงตัวอย่าง — แถวที่ถูกใช้ต่อแล้ว (เช่น SO ที่สร้าง DO / ออกเอกสารแล้ว, ลูกค้าที่ใบสั่งจริงอ้างถึง) ' +
      'ไม่ลบและคืนใน `kept` · ไม่มีข้อมูลตัวอย่าง = ไม่ทำอะไร',
  })
  @ApiOkResponse({ type: SampleDataClearDto })
  clear(): Promise<SampleDataClearDto> {
    return this.samples.clear();
  }
}
