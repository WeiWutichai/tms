import {
  Body,
  Controller,
  Delete,
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
import { TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { PROBLEMS, type ProblemCode } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import {
  CreateSavedViewDto,
  SavedViewDto,
  SavedViewListQuery,
  SavedViewPageDto,
  UpdateSavedViewDto,
} from './saved-views.dto';
import { SavedViewsService, toSavedViewDto } from './saved-views.service';

const P = (code: ProblemCode, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance: '/v1/saved-views/svw_3f2a…',
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const V404 = {
  status: 404,
  description:
    'ไม่พบมุมมอง (รวมของผู้ใช้อื่น/บริษัทอื่น) หรือ credential ไม่ใช่ผู้ใช้ (API key — ไม่มีมุมมองส่วนตัว)',
  examples: { not_found: P('not_found') },
};
const V409 = {
  status: 409,
  description: 'ชื่อซ้ำในหน้าเดียวกัน (ไม่สนตัวพิมพ์) / เกิน 50 มุมมองต่อหน้า',
  examples: {
    duplicate: P('duplicate', {
      errors: [{ field: 'name', code: 'duplicate', message: 'view name already exists' }],
    }),
    conflict: P('conflict'),
  },
};
const V412 = {
  status: 412,
  description: 'If-Match ไม่ตรง version (แก้จากอีกแท็บ/เครื่อง)',
  examples: { precondition_failed: P('precondition_failed') },
};
const V422 = {
  status: 422,
  description: 'ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (เช่น `state.q` ยาวเกิน, key ผิดรูป)',
  examples: {
    validation_failed: P('validation_failed', {
      errors: [{ field: 'state.q', code: 'too_long', message: 'max 200 chars' }],
    }),
  },
};

/**
 * มุมมองที่บันทึกไว้ของตาราง/รายงาน (ST9-T11; docs/04 I UI pattern มาตรฐาน "saved views", H "บันทึก filter")
 * ต่อผู้ใช้ที่ login — ไม่ต้องมี scope เฉพาะ (เก็บแค่ค่าตัวกรอง ไม่มีข้อมูลธุรกิจ; ข้อมูลในตารางยังตรวจสิทธิ์ที่ API ของหน้านั้น)
 * แชร์ในทีม = P1
 */
@ApiTags('saved-views')
@ApiBearerAuth()
@Controller('saved-views')
export class SavedViewsController {
  constructor(private readonly views: SavedViewsService) {}

  @Get()
  @ApiOperation({ summary: 'มุมมองของฉันในหน้านี้' })
  @ApiProblems(V404, V422)
  @ApiOkResponse({ type: SavedViewPageDto })
  list(@Query() q: SavedViewListQuery) {
    return this.views.list(q);
  }

  @Post()
  @ApiOperation({
    summary: 'บันทึกมุมมอง',
    description:
      'state + คอลัมน์ที่ซ่อน ของหน้าตอนนี้ · `isDefault: true` = ยกเลิกค่าเริ่มต้นเดิมของหน้านั้นให้อัตโนมัติ',
  })
  @ApiProblems(V404, V409, V422)
  @ApiCreatedResponse({ type: SavedViewDto })
  async create(
    @Body() body: CreateSavedViewDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SavedViewDto> {
    const v = await this.views.create(body);
    setEtag(res, v.version);
    return toSavedViewDto(v);
  }

  @Get(':id')
  @TenantResource('savedView')
  @ApiProblems(V404)
  @ApiOkResponse({ type: SavedViewDto })
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const v = await this.views.get(decodeIdOr404('savedView', id));
    setEtag(res, v.version);
    return toSavedViewDto(v);
  }

  @Patch(':id')
  @TenantResource('savedView')
  @ApiOperation({ summary: 'แก้ชื่อ / ตัวกรอง / คอลัมน์ / ค่าเริ่มต้น' })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(V404, V409, V412, V422)
  @ApiOkResponse({ type: SavedViewDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateSavedViewDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SavedViewDto> {
    const v = await this.views.update(decodeIdOr404('savedView', id), body, expectedVersion(req));
    setEtag(res, v.version);
    return toSavedViewDto(v);
  }

  @Delete(':id')
  @HttpCode(204)
  @TenantResource('savedView')
  @ApiOperation({ summary: 'ลบมุมมอง (soft — ค่าส่วนตัว ไม่ต้องใส่เหตุผล)' })
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiProblems(V404, V412)
  @ApiNoContentResponse()
  async remove(@Param('id') id: string, @Req() req: Request): Promise<void> {
    await this.views.remove(decodeIdOr404('savedView', id), expectedVersion(req));
  }
}
