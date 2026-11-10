import { Body, Controller, Get, Param, Patch, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { SequenceDto, SequenceListDto, UpdateSequenceDto } from './sequence.dto';
import { SequencesService } from './sequences.service';

/** ชุดเลขเอกสาร (docs/01 §5.2 #7 document-sequences) — ออกเลขจริงเกิดตอน finalize ในโมดูลเอกสาร ไม่มี endpoint ออกเลขตรง */
@ApiTags('document-sequences')
@ApiBearerAuth()
@Controller('document-sequences')
export class SequencesController {
  constructor(private readonly sequences: SequencesService) {}

  @Get()
  @RequireScope('settings:read')
  @ApiOkResponse({ type: SequenceListDto })
  async list(): Promise<SequenceListDto> {
    return { data: await this.sequences.list() };
  }

  @Get(':id')
  @TenantResource('sequence')
  @RequireScope('settings:read')
  @ApiOkResponse({ type: SequenceDto })
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const s = await this.sequences.get(decodeIdOr404('sequence', id));
    setEtag(res, s.version);
    return this.sequences.toDto(s, await this.sequences.yearStyle());
  }

  @Patch(':id')
  @TenantResource('sequence')
  @RequireScope('settings:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: SequenceDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateSequenceDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SequenceDto> {
    const s = await this.sequences.update(
      decodeIdOr404('sequence', id),
      body,
      expectedVersion(req),
    );
    setEtag(res, s.version);
    return this.sequences.toDto(s, await this.sequences.yearStyle());
  }
}
