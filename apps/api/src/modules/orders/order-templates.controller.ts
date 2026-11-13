import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { MasterReasonDto } from '../master/master-kit';
import {
  CreateOrderTemplateDto,
  OrderTemplateDto,
  OrderTemplateListQuery,
  OrderTemplatePageDto,
  UpdateOrderTemplateDto,
} from './order-template.dto';
import { OrderTemplatesService, toTemplateDto } from './order-templates.service';

/**
 * เทมเพลตงานประจำของใบสั่งขนส่ง (ST3-T02; docs/04 C "กรอกมือ") — อ่าน `orders:read` · บันทึก/แก้/ลบ `orders:write`
 * สร้างใบจากเทมเพลต: นำ `payload` (เลื่อนวันที่ตามต้องการ) ไปส่ง `POST /v1/orders` — ไม่มี endpoint ลัด (API-first)
 */
@ApiTags('order-templates')
@ApiBearerAuth()
@Controller('order-templates')
export class OrderTemplatesController {
  constructor(private readonly templates: OrderTemplatesService) {}

  private async one(id: string, res: Response): Promise<OrderTemplateDto> {
    const t = await this.templates.get(id);
    setEtag(res, t.version);
    return toTemplateDto(t, await this.templates.customersOf([t]));
  }

  @Get()
  @RequireScope('orders:read')
  @ApiOkResponse({ type: OrderTemplatePageDto })
  list(@Query() q: OrderTemplateListQuery) {
    return this.templates.list(q);
  }

  @Post()
  @RequireScope('orders:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'บันทึกเทมเพลต',
    description:
      'payload ตรวจด้วยกฎเดียวกับ POST /v1/orders (422 `payload.…`) · ชื่อซ้ำ (ไม่สนตัวพิมพ์) → 409 `duplicate`',
  })
  @ApiCreatedResponse({ type: OrderTemplateDto })
  async create(
    @Body() body: CreateOrderTemplateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderTemplateDto> {
    const t = await this.templates.create(body);
    return this.one(t.id, res);
  }

  @Get(':id')
  @TenantResource('orderTemplate')
  @RequireScope('orders:read')
  @ApiOkResponse({ type: OrderTemplateDto })
  get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.one(decodeIdOr404('orderTemplate', id), res);
  }

  @Patch(':id')
  @TenantResource('orderTemplate')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: OrderTemplateDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateOrderTemplateDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderTemplateDto> {
    const t = await this.templates.update(
      decodeIdOr404('orderTemplate', id),
      body,
      expectedVersion(req),
    );
    return this.one(t.id, res);
  }

  /** ลบ (soft) พร้อมเหตุผล ≥ 10 ตัวอักษร — ใบที่สร้างไปแล้วไม่กระทบ */
  @Post(':id/delete')
  @HttpCode(204)
  @TenantResource('orderTemplate')
  @RequireScope('orders:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.templates.remove(
      decodeIdOr404('orderTemplate', id),
      body.reason,
      expectedVersion(req),
    );
  }
}
