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
  ApiHeader,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { CompaniesService, toCompanyDto } from './companies.service';
import {
  CompanyDto,
  CompanyListQuery,
  CompanyPageDto,
  CreateCompanyDto,
  StatusChangeDto,
  UpdateCompanyDto,
} from './company.dto';

/**
 * นิติบุคคล (docs/01 §3.1, §5.2 #7) — ST0 ใช้เป็น endpoint ตัวอย่างของ plumbing ทั้งหมด
 * (id prefix, ext:, problem+json, idempotency, cursor, fields, ETag/If-Match, state machine)
 */
@ApiTags('companies')
@ApiBearerAuth()
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.companies.getByExternalId(id.slice(4));
    return this.companies.get(decodeIdOr404('company', id));
  }

  @Post()
  @RequireScope('companies:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: CompanyDto })
  async create(
    @Body() body: CreateCompanyDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompanyDto> {
    const c = await this.companies.create(body);
    setEtag(res, c.version);
    return toCompanyDto(c);
  }

  @Get()
  @RequireScope('companies:read')
  @ApiOkResponse({ type: CompanyPageDto })
  list(@Query() q: CompanyListQuery) {
    return this.companies.list(q);
  }

  @Get(':id')
  @TenantResource('company')
  @RequireScope('companies:read')
  @ApiOkResponse({ type: CompanyDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompanyDto> {
    const c = await this.resolve(id);
    setEtag(res, c.version);
    return toCompanyDto(c);
  }

  @Patch(':id')
  @TenantResource('company')
  @RequireScope('companies:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: CompanyDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateCompanyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompanyDto> {
    const current = await this.resolve(id);
    const c = await this.companies.update(current.id, body, expectedVersion(req));
    setEtag(res, c.version);
    return toCompanyDto(c);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @TenantResource('company')
  @RequireScope('companies:write')
  @ApiOkResponse({ type: CompanyDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: StatusChangeDto,
    @Req() req: Request,
  ): Promise<CompanyDto> {
    const current = await this.resolve(id);
    return toCompanyDto(
      await this.companies.changeStatus(
        current.id,
        'deactivate',
        body.reason,
        expectedVersion(req),
      ),
    );
  }

  @Post(':id/activate')
  @HttpCode(200)
  @TenantResource('company')
  @RequireScope('companies:write')
  @ApiOkResponse({ type: CompanyDto })
  async activate(
    @Param('id') id: string,
    @Body() body: StatusChangeDto,
    @Req() req: Request,
  ): Promise<CompanyDto> {
    const current = await this.resolve(id);
    return toCompanyDto(
      await this.companies.changeStatus(current.id, 'activate', body.reason, expectedVersion(req)),
    );
  }
}
