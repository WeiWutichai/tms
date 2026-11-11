import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { ImportJob } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import { TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { AuditService } from '../../audit/audit.service';
import { IMPORT_MIME, type AllowedMime } from '../documents/mime';
import { ERROR_POLICIES, IMPORT_MODES, type ImportSpec } from './import-spec';
import { ImportFileError } from './parse';
import { ImportService, SYNC_MAX_ROWS, type SampleRow, type StoredIssue } from './import.service';

export class ImportColumnDto {
  @ApiProperty() key!: string;
  @ApiProperty() header!: string;
  @ApiProperty() required!: boolean;
}
export class ImportKindDto {
  @ApiProperty({ example: 'customer' }) kind!: string;
  @ApiProperty({ example: 'ลูกค้า' }) label!: string;
  @ApiProperty({ type: [ImportColumnDto] }) columns!: ImportColumnDto[];
  @ApiProperty({ enum: IMPORT_MODES, isArray: true }) modes!: string[];
}

export class CreateImportDto {
  @ApiProperty({ example: 'customer' }) @IsString() @Matches(/^[a-z][a-z0-9_]*$/) kind!: string;
  @ApiProperty({
    example: 'doc_…',
    description: 'ไฟล์ .xlsx/.csv ที่อัปโหลดแล้ว (POST /v1/documents kind IMPORT)',
  })
  @IsString()
  documentId!: string;
  @ApiPropertyOptional({ enum: IMPORT_MODES, description: 'ค่าเริ่มต้น create_only' })
  @IsOptional()
  @IsIn(IMPORT_MODES)
  mode?: string;
  @ApiPropertyOptional({ enum: ERROR_POLICIES, description: 'ค่าเริ่มต้น all_or_nothing' })
  @IsOptional()
  @IsIn(ERROR_POLICIES)
  errorPolicy?: string;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'ฟิลด์ → หัวคอลัมน์ในไฟล์ (ไม่ส่ง = จับคู่อัตโนมัติ)',
    example: { taxId: 'Tax ID' },
  })
  @IsOptional()
  @IsObject()
  mapping?: Record<string, string>;
}

export class UpdateImportDto {
  @ApiPropertyOptional({ enum: IMPORT_MODES }) @IsOptional() @IsIn(IMPORT_MODES) mode?: string;
  @ApiPropertyOptional({ enum: ERROR_POLICIES })
  @IsOptional()
  @IsIn(ERROR_POLICIES)
  errorPolicy?: string;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'ฟิลด์ → หัวคอลัมน์ในไฟล์ (ไม่มี key = ไม่จับคู่)',
  })
  @IsOptional()
  @IsObject()
  mapping?: Record<string, string>;
}

export class CancelImportDto {
  @ApiProperty({ example: 'อัปโหลดไฟล์ผิด' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ImportListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() cursor?: string;
}

export class ImportIssueDto {
  @ApiProperty({ description: 'เลขแถวในไฟล์ (ตรงกับ Excel)' }) row!: number;
  @ApiPropertyOptional() column?: string;
  @ApiPropertyOptional() value?: string;
  @ApiProperty({ example: 'required' }) code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ enum: ['error', 'warning'] }) severity!: string;
}
export class ImportSampleDto {
  @ApiProperty() row!: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  values!: Record<string, string>;
  @ApiProperty() error!: boolean;
}
export class ImportDto {
  @ApiProperty({ example: 'imp_…' }) id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty({
    enum: [
      'validating',
      'validated',
      'expired',
      'importing',
      'completed',
      'completed_with_errors',
      'failed',
      'cancelled',
    ],
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String }) fileName!: string | null;
  @ApiProperty({ enum: IMPORT_MODES }) mode!: string;
  @ApiProperty({ enum: ERROR_POLICIES }) errorPolicy!: string;
  @ApiProperty({ type: [String] }) headers!: string[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  mapping!: Record<string, string>;
  @ApiProperty() totalRows!: number;
  @ApiProperty() okRows!: number;
  @ApiProperty() errorRows!: number;
  @ApiProperty() importedRows!: number;
  @ApiProperty({
    type: [ImportIssueDto],
    description:
      'ปัญหารายแถว (GET /{id} ไม่เกิน 1,000 รายการแรก; รายการใน GET /imports ว่างเสมอ) — ครบทุกแถวใน /{id}/errors',
  })
  issues!: ImportIssueDto[];
  @ApiProperty({ description: 'มีปัญหามากกว่าที่ส่งใน issues' }) issuesTruncated!: boolean;
  @ApiProperty({ type: [ImportSampleDto] }) sample!: ImportSampleDto[];
  @ApiProperty({ nullable: true, type: String, description: 'ผิดทั้งไฟล์' }) fileError!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) jobId!: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class ImportPageDto {
  @ApiProperty({ type: [ImportDto] }) data!: ImportDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

/**
 * นำเข้า Excel/CSV แบบ dry-run (ST1-T19; docs/04 A5, spec/02 §11)
 * อัปโหลดไฟล์ด้วย /v1/documents (kind IMPORT) → POST /v1/imports (ตรวจ ไม่เขียน) → แก้ mapping (PATCH) →
 * POST /{id}/commit (ตรวจซ้ำแล้วเขียน) · ไฟล์ > 1,000 แถววิ่งเป็น job + แจ้งเตือนผู้สั่งเมื่อเสร็จ
 * สิทธิ์ = scope ของ entity นั้น (ImportSpec.scope) + ฟีเจอร์ในแพ็กเกจ — ไม่ผ่านตอบ 404 เหมือนไม่มี
 */
@ApiTags('imports')
@ApiBearerAuth()
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly db: DbService,
    private readonly imports: ImportService,
    private readonly audit: AuditService,
  ) {}

  @Get('kinds')
  @ApiOkResponse({ type: [ImportKindDto] })
  async kinds(): Promise<ImportKindDto[]> {
    const specs = await this.allowedSpecs();
    return specs.map((s) => ({
      kind: s.kind,
      label: s.label,
      columns: s.columns.map((c) => ({ key: c.key, header: c.header, required: !!c.required })),
      modes: s.modes ?? ['create_only'],
    }));
  }

  @Get('kinds/:kind/template')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ description: 'ไฟล์ template .xlsx' })
  async template(
    @Param('kind') kind: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const spec = await this.spec(kind);
    return xlsx(res, await this.imports.template(spec), `template-${spec.kind}.xlsx`);
  }

  /** สร้างงานนำเข้า + ตรวจ (dry-run) — ไฟล์ > 1,000 แถวตอบ status validating + jobId แล้วตรวจใน job */
  @Post()
  @ApiCreatedResponse({ type: ImportDto })
  async create(@Body() body: CreateImportDto): Promise<ImportDto> {
    const ctx = requestContext.require();
    const spec = await this.spec(body.kind);
    const tx = this.db.tx;
    const docId = tryDecodeId('document', body.documentId);
    const doc = docId ? await tx.storedDocument.findUnique({ where: { id: docId } }) : null;
    // ไฟล์ของตัวเองที่อัปโหลดเสร็จแล้วเท่านั้น (คนอื่นอ่านไฟล์นำเข้าของเราผ่านช่องนี้ไม่ได้)
    if (
      !doc ||
      doc.status !== 'READY' ||
      doc.kind !== 'IMPORT' ||
      doc.createdBy !== (ctx.actorId ?? null) ||
      !IMPORT_MIME.includes(doc.mimeType as AllowedMime)
    )
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'documentId',
          code: 'invalid_document',
          message: 'must be your own ready IMPORT document (.xlsx or .csv)',
        },
      ]);
    assertMode(spec, body.mode);
    const imp = await tx.importJob.create({
      data: {
        tenantId: ctx.tenantId!,
        kind: spec.kind,
        documentId: doc.id,
        fileName: doc.filename,
        mode: body.mode ?? 'create_only',
        errorPolicy: body.errorPolicy ?? 'all_or_nothing',
        mapping: cleanMapping(spec, body.mapping),
        expiresAt: new Date(Date.now() + 24 * 3600_000),
        createdBy: ctx.actorId ?? null,
      },
    });
    // เกิน 1,000 แถว → ตรวจเป็น job (อ่านไฟล์ครั้งเดียวเพื่อนับแถว)
    const done = await this.imports.validate(tx, imp, SYNC_MAX_ROWS, actor());
    return toDto(done ?? (await this.imports.enqueue(tx, imp, 'import.validate', actor())));
  }

  /** ประวัติการนำเข้า (ใหม่ → เก่า) — ไม่ส่ง issues/sample (ดูที่ GET /{id}) */
  @Get()
  @ApiOkResponse({ type: ImportPageDto })
  async list(@Query() q: ImportListQuery): Promise<ImportPageDto> {
    const kinds = (await this.allowedSpecs()).map((s) => s.kind);
    const limit = q.limit ?? 20;
    const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await this.db.tx.importJob.findMany({
      where: {
        kind: { in: kinds },
        ...(cur
          ? { OR: [{ createdAt: { lt: cur.at } }, { createdAt: cur.at, id: { lt: cur.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const jobs = await this.jobsOf(rows);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => toDto(r, jobs.get(r.jobId ?? ''), 0)),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ a: last.createdAt.toISOString(), i: last.id })).toString(
              'base64url',
            )
          : null,
      hasMore,
    };
  }

  @Get(':id')
  @TenantResource('import')
  @ApiOkResponse({ type: ImportDto })
  async get(@Param('id') id: string): Promise<ImportDto> {
    const imp = await this.find(id);
    return toDto(imp, (await this.jobsOf([imp])).get(imp.jobId ?? ''));
  }

  /** เปลี่ยนการจับคู่คอลัมน์/ตัวเลือก แล้วตรวจใหม่ (ขั้นที่ 2 ของ wizard) */
  @Patch(':id')
  @TenantResource('import')
  @ApiOkResponse({ type: ImportDto })
  async update(@Param('id') id: string, @Body() body: UpdateImportDto): Promise<ImportDto> {
    const tx = this.db.tx;
    const imp = await this.find(id, true);
    const spec = await this.spec(imp.kind);
    if (imp.status !== 'VALIDATED') throw new ProblemException('invalid_state_transition');
    if (imp.expiresAt.getTime() <= Date.now()) throw new ProblemException('import_expired');
    assertMode(spec, body.mode);
    const next = await tx.importJob.update({
      where: { id: imp.id },
      data: {
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.errorPolicy ? { errorPolicy: body.errorPolicy } : {}),
        ...(body.mapping ? { mapping: cleanMapping(spec, body.mapping) } : {}),
        status: 'VALIDATING',
      },
    });
    const done = await this.imports.validate(tx, next, SYNC_MAX_ROWS, actor());
    return toDto(done ?? (await this.imports.enqueue(tx, next, 'import.validate', actor())));
  }

  /**
   * ยืนยันนำเข้า — ตรวจซ้ำทั้งไฟล์ก่อนเขียน · ไฟล์ > 1,000 แถวตอบ status importing แล้วนำเข้าใน job
   * ตรวจซ้ำแล้วพบแถวผิด (all_or_nothing — ข้อมูลเปลี่ยนระหว่างรอ) = ไม่เขียนอะไร ตอบ status validated พร้อมผลตรวจใหม่
   */
  @Post(':id/commit')
  @HttpCode(200)
  @TenantResource('import')
  @ApiOkResponse({ type: ImportDto })
  async commit(@Param('id') id: string): Promise<ImportDto> {
    const tx = this.db.tx;
    const imp = await this.find(id, true);
    await this.spec(imp.kind);
    if (imp.status !== 'VALIDATED') throw new ProblemException('invalid_state_transition');
    if (imp.expiresAt.getTime() <= Date.now()) throw new ProblemException('import_expired');
    if (imp.errorRows > 0 && imp.errorPolicy === 'all_or_nothing')
      throw new ProblemException('import_has_errors');
    if (imp.totalRows > SYNC_MAX_ROWS) {
      const moved = await tx.importJob.update({
        where: { id: imp.id },
        data: { status: 'IMPORTING' },
      });
      return toDto(await this.imports.enqueue(tx, moved, 'import.commit', actor()));
    }
    return toDto(await this.imports.commit(tx, imp, actor()));
  }

  /** ยกเลิกงานที่ตรวจแล้วแต่ยังไม่นำเข้า (เหตุผลบังคับ + audit) */
  @Post(':id/cancel')
  @HttpCode(200)
  @TenantResource('import')
  @ApiOkResponse({ type: ImportDto })
  async cancel(@Param('id') id: string, @Body() body: CancelImportDto): Promise<ImportDto> {
    const imp = await this.find(id, true);
    if (imp.status !== 'VALIDATED') throw new ProblemException('invalid_state_transition');
    if (imp.expiresAt.getTime() <= Date.now()) throw new ProblemException('import_expired');
    const done = await this.db.tx.importJob.update({
      where: { id: imp.id },
      data: { status: 'CANCELLED' },
    });
    await this.audit.record({
      action: 'import.cancelled',
      entityType: 'import',
      entityId: imp.id,
      after: { kind: imp.kind, file: imp.fileName },
      reason: body.reason,
    });
    return toDto(done);
  }

  /** แถวที่ผิด + คอลัมน์ "ผลตรวจ" (.xlsx) — ตรวจใหม่ทั้งไฟล์ ได้ทุกแถวที่ผิด */
  @Get(':id/errors')
  @TenantResource('import')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ description: 'ไฟล์ .xlsx แถวที่ผิด' })
  async errors(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const imp = await this.find(id);
    if (imp.status === 'VALIDATING' || imp.fileError) throw new ProblemException('not_found');
    const buf = await this.imports.errorWorkbook(this.db.tx, imp).catch((e) => {
      if (e instanceof ImportFileError) throw new ProblemException('not_found');
      throw e;
    });
    return xlsx(res, buf, `errors-${encodeId('import', imp.id)}.xlsx`);
  }

  private spec(kind: string): Promise<ImportSpec<unknown>> {
    const ctx = requestContext.require();
    return this.imports.spec(kind, ctx.scopes ?? [], ctx.tenantId!);
  }

  private async allowedSpecs(): Promise<ImportSpec<unknown>[]> {
    const out: ImportSpec<unknown>[] = [];
    for (const s of this.imports.registry.list()) {
      try {
        out.push(await this.spec(s.kind));
      } catch {
        /* ไม่มีสิทธิ์/ไม่อยู่ในแพ็กเกจ */
      }
    }
    return out;
  }

  private async find(id: string, lock = false): Promise<ImportJob> {
    const uuid = decodeIdOr404('import', id);
    if (lock)
      await this.db.tx.$queryRaw`SELECT id FROM import_job WHERE id = ${uuid}::uuid FOR UPDATE`;
    const imp = await this.db.tx.importJob.findUnique({ where: { id: uuid } });
    if (!imp) throw new ProblemException('not_found');
    await this.spec(imp.kind); // ไม่มีสิทธิ์ของ entity นั้น → 404
    return imp;
  }

  /** สถานะ job ของงานที่ยังวิ่ง — job ล้ม = งานนำเข้าล้ม (onFinalFailure ปิดสถานะให้แล้ว; กันกรณีปิดไม่ทัน) */
  private async jobsOf(rows: ImportJob[]) {
    const ids = rows.filter((r) => r.jobId).map((r) => r.jobId!);
    const jobs = ids.length
      ? await this.db.tx.job.findMany({
          where: { id: { in: ids } },
          select: { id: true, status: true },
        })
      : [];
    return new Map(jobs.map((j) => [j.id, j.status]));
  }
}

const actor = () => {
  const a = requestContext.require().actorId;
  return a && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a) ? a : null;
};

function assertMode(spec: ImportSpec<unknown>, mode?: string) {
  const modes = spec.modes ?? ['create_only'];
  if (mode && !modes.includes(mode as never))
    throw new ProblemException('validation_failed', undefined, [
      { field: 'mode', code: 'mode_not_supported', message: `supported: ${modes.join(', ')}` },
    ]);
}

/** ตัด key ที่ไม่รู้จัก/ค่าว่าง · หัวคอลัมน์เดียวจับคู่ได้ฟิลด์เดียว (ซ้ำ → 422) */
function cleanMapping(spec: ImportSpec<unknown>, m?: Record<string, string>) {
  if (!m) return {};
  const out = Object.fromEntries(
    Object.entries(m).filter(
      ([k, v]) => typeof v === 'string' && v.trim() && spec.columns.some((c) => c.key === k),
    ),
  );
  const used = Object.values(out);
  if (new Set(used).size !== used.length)
    throw new ProblemException('validation_failed', undefined, [
      {
        field: 'mapping',
        code: 'duplicate_mapping',
        message: 'a file column can map to one field only',
      },
    ]);
  return out;
}

const ISSUES_IN_RESPONSE = 1000;

function toDto(i: ImportJob, jobStatus?: string, maxIssues = ISSUES_IN_RESPONSE): ImportDto {
  let status = i.status.toLowerCase();
  if (
    (i.status === 'VALIDATING' || i.status === 'IMPORTING') &&
    (jobStatus === 'FAILED' || jobStatus === 'SKIPPED')
  )
    status = 'failed';
  if (i.status === 'VALIDATED' && i.expiresAt.getTime() <= Date.now()) status = 'expired';
  const all = i.issues as unknown as StoredIssue[];
  return {
    id: encodeId('import', i.id),
    kind: i.kind,
    status,
    fileName: i.fileName,
    mode: i.mode,
    errorPolicy: i.errorPolicy,
    headers: i.headers as string[],
    mapping: i.mapping as Record<string, string>,
    totalRows: i.totalRows,
    okRows: i.okRows,
    errorRows: i.errorRows,
    importedRows: i.importedRows,
    issues: all.slice(0, maxIssues).map((x) => ({ ...x, severity: x.severity ?? 'error' })),
    issuesTruncated: all.length > maxIssues || (maxIssues > 0 && all.length >= 5000),
    sample: maxIssues ? (i.sample as unknown as SampleRow[]) : [],
    fileError: i.fileError,
    jobId: i.jobId ? encodeId('job', i.jobId) : null,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}

function xlsx(res: Response, buf: Buffer, name: string): StreamableFile {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w.\-]/g, '_')}"`);
  return new StreamableFile(buf);
}

function decodeCursor(c: string): { at: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { a: string; i: string };
    const at = new Date(v.a);
    if (
      Number.isNaN(at.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v.i))
    )
      throw new Error();
    return { at, id: v.i };
  } catch {
    throw new ProblemException('validation_failed', undefined, [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is invalid' },
    ]);
  }
}
