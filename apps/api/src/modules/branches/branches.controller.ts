import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import {
  BranchDto,
  BranchListQuery,
  BranchPageDto,
  CreateBranchDto,
  UpdateBranchDto,
} from './branch.dto';
import { BranchesService, toBranchDto } from './branches.service';

/** สาขา (docs/01 §5.2 #7) — อ่าน: ทุก role ภายใน; แก้: settings:write (owner/admin ตาม A3) */
@ApiTags('branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Post()
  @RequireScope('settings:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: BranchDto })
  async create(
    @Body() body: CreateBranchDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BranchDto> {
    const b = await this.branches.create(body);
    setEtag(res, b.version);
    return toBranchDto(b);
  }

  @Get()
  @RequireScope('companies:read')
  @ApiOkResponse({ type: BranchPageDto })
  list(@Query() q: BranchListQuery) {
    return this.branches.list(q);
  }

  @Get(':id')
  @TenantResource('branch')
  @RequireScope('companies:read')
  @ApiOkResponse({ type: BranchDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BranchDto> {
    const b = await this.branches.get(decodeIdOr404('branch', id));
    setEtag(res, b.version);
    return toBranchDto(b);
  }

  @Patch(':id')
  @TenantResource('branch')
  @RequireScope('settings:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: BranchDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateBranchDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BranchDto> {
    const b = await this.branches.update(decodeIdOr404('branch', id), body, expectedVersion(req));
    setEtag(res, b.version);
    return toBranchDto(b);
  }
}
