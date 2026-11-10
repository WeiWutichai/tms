import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../db/prisma.service';

@ApiTags('platform')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  @ApiOkResponse({ schema: { example: { status: 'ok', db: 'ok' } } })
  async health() {
    await this.prisma.platform.$queryRaw`SELECT 1`;
    return { status: 'ok', db: 'ok' };
  }
}
