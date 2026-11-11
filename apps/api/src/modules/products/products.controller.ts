import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditPageDto } from '../../audit/audit.controller';
import { RequireScope, TenantResource } from '../../common/decorators';
import { expectedVersion, setEtag } from '../../common/etag';
import { decodeIdOr404 } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { NextCodeDto } from '../customers/customer.dto';
import { sendExport, type ExportColumn } from '../master/export';
import { entityHistory, HistoryQuery } from '../master/history';
import { MasterOptionalReasonDto, MasterReasonDto } from '../master/master-kit';
import {
  CreateProductDto,
  ProductDto,
  ProductExportQuery,
  ProductListQuery,
  ProductPageDto,
  ProductSummaryDto,
  UpdateProductDto,
  UpsertProductDto,
} from './product.dto';
import { ProductsService, toProductDto } from './products.service';

const yes = (b: boolean) => (b ? 'ใช่' : '');
/** คอลัมน์ไฟล์ส่งออก — หัวคอลัมน์ไทยตรงกับ template นำเข้า (ST2-T23) */
const EXPORT_COLUMNS: ExportColumn<ProductDto>[] = [
  { header: 'รหัสสินค้า', value: (r) => r.code },
  { header: 'ชื่อสินค้า', value: (r) => r.name },
  { header: 'รหัสหน่วย', value: (r) => r.unit.code },
  { header: 'หน่วย', value: (r) => r.unit.name },
  { header: 'น้ำหนักต่อหน่วย (กก.)', value: (r) => r.weightPerUnitKg },
  { header: 'ปริมาตรต่อหน่วย (ลบ.ม.)', value: (r) => r.volumePerUnitCbm },
  {
    header: 'หน่วยแปลง',
    value: (r) => r.altUnits.map((a) => `${a.unit.code}=${a.factorToBase}`).join('; '),
  },
  { header: 'เปราะบาง', value: (r) => yes(r.fragile) },
  { header: 'อันตราย', value: (r) => yes(r.hazardous) },
  { header: 'เลข UN', value: (r) => r.unNumber },
  { header: 'Class', value: (r) => r.hazardClass },
  { header: 'ควบคุมอุณหภูมิ', value: (r) => yes(r.tempControlled) },
  { header: 'อุณหภูมิต่ำสุด (°C)', value: (r) => r.tempMinC },
  { header: 'อุณหภูมิสูงสุด (°C)', value: (r) => r.tempMaxC },
  { header: 'วางซ้อนได้', value: (r) => yes(r.stackable) },
  { header: 'บาร์โค้ด', value: (r) => r.barcode },
  { header: 'รหัสลูกค้า', value: (r) => r.customer?.code },
  { header: 'ลูกค้า', value: (r) => r.customer?.name },
  { header: 'รหัสในระบบต้นทาง', value: (r) => r.externalId },
  { header: 'สถานะ', value: (r) => (r.status === 'active' ? 'ใช้งาน' : 'ปิดใช้') },
];

/**
 * สินค้า (ST2-T10; docs/04 B สินค้า/หน่วย, spec/02 §3) — CRUD + `PUT /external/{id}` + export + ประวัติ (กฎร่วมทุก master)
 * สิทธิ์: อ่าน `master:read` · แก้/ปิดใช้/ลบ `master:write` (MD-011 dispatcher สร้าง/แก้สินค้าได้) · ส่งออก `export:run`
 */
@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly db: DbService,
  ) {}

  private async resolve(id: string) {
    if (id.startsWith('ext:')) return this.products.getByExternalId(id.slice(4));
    return this.products.get(decodeIdOr404('product', id));
  }

  @Get()
  @RequireScope('master:read')
  @ApiOkResponse({ type: ProductPageDto })
  list(@Query() q: ProductListQuery) {
    return this.products.list(q);
  }

  @Get('summary')
  @RequireScope('master:read')
  @ApiOkResponse({ type: ProductSummaryDto })
  summary(): Promise<ProductSummaryDto> {
    return this.products.summary();
  }

  @Get('next-code')
  @RequireScope('master:write')
  @ApiOkResponse({ type: NextCodeDto, description: 'รหัสที่ระบบจะออกให้สินค้าใหม่ (`P-0001`)' })
  async nextCode(): Promise<NextCodeDto> {
    return { code: await this.products.nextCode() };
  }

  @Get('export')
  @RequireScope('export:run')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOkResponse({
    description: 'ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว)',
  })
  async export(
    @Query() q: ProductExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rows = await this.products.exportRows(q);
    return sendExport(res, q.format ?? 'xlsx', 'products', EXPORT_COLUMNS, rows);
  }

  /** สร้าง — รหัสซ้ำ → 409 `duplicate` (+ `existing`) */
  @Post()
  @RequireScope('master:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: ProductDto })
  async create(
    @Body() body: CreateProductDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    const p = await this.products.create(body);
    setEtag(res, p.version);
    return toProductDto(p);
  }

  @Put('external/:externalId')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag — ใช้เมื่อแถวมีอยู่แล้ว' })
  @ApiOkResponse({
    type: ProductDto,
    description: 'มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่)',
  })
  @ApiCreatedResponse({ type: ProductDto, description: 'ยังไม่มี → สร้าง' })
  async upsertExternal(
    @Param('externalId') externalId: string,
    @Body() body: UpsertProductDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    if (!/^[\x21-\x7e]{1,100}$/.test(externalId))
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'externalId',
          code: 'matches',
          message: 'externalId must be 1-100 printable ASCII',
        },
      ]);
    const { row, created } = await this.products.upsertExternal(
      externalId,
      body,
      expectedVersion(req),
    );
    res.status(created ? 201 : 200);
    setEtag(res, row.version);
    return toProductDto(row);
  }

  @Get(':id')
  @TenantResource('product')
  @RequireScope('master:read')
  @ApiOkResponse({ type: ProductDto })
  async get(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    const p = await this.resolve(id);
    setEtag(res, p.version);
    return toProductDto(p);
  }

  @Get(':id/history')
  @TenantResource('product')
  @RequireScope('master:read')
  @ApiOkResponse({ type: AuditPageDto, description: 'ประวัติการแก้จาก audit log ใหม่สุดก่อน' })
  async history(@Param('id') id: string, @Query() q: HistoryQuery): Promise<AuditPageDto> {
    const p = await this.resolve(id);
    return entityHistory(this.db.tx, 'product', p.id, q);
  }

  @Patch(':id')
  @TenantResource('product')
  @RequireScope('master:write')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: ProductDto })
  async update(
    @Param('id') id: string,
    @Body() body: UpdateProductDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    const current = await this.resolve(id);
    const p = await this.products.update(current.id, body, expectedVersion(req));
    setEtag(res, p.version);
    return toProductDto(p);
  }

  @Post(':id/deactivate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('product')
  @RequireScope('master:write')
  @ApiOkResponse({ type: ProductDto })
  async deactivate(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    const current = await this.resolve(id);
    const p = await this.products.changeStatus(
      current.id,
      'deactivate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, p.version);
    return toProductDto(p);
  }

  @Post(':id/activate')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(200)
  @TenantResource('product')
  @RequireScope('master:write')
  @ApiOkResponse({ type: ProductDto })
  async activate(
    @Param('id') id: string,
    @Body() body: MasterOptionalReasonDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductDto> {
    const current = await this.resolve(id);
    const p = await this.products.changeStatus(
      current.id,
      'activate',
      body.reason,
      expectedVersion(req),
    );
    setEtag(res, p.version);
    return toProductDto(p);
  }

  /** "ลบ" (MD-004) → soft delete + เหตุผล ≥ 10 */
  @Post(':id/delete')
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @HttpCode(204)
  @TenantResource('product')
  @RequireScope('master:write')
  @ApiNoContentResponse()
  async remove(
    @Param('id') id: string,
    @Body() body: MasterReasonDto,
    @Req() req: Request,
  ): Promise<void> {
    const current = await this.resolve(id);
    await this.products.remove(current.id, body.reason, expectedVersion(req));
  }
}
