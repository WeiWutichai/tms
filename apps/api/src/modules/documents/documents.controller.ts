import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { StoredDocument } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { join } from 'node:path';
import { Public, RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { LocalFileStore } from '../../pdf/file-store';
import { ALLOWED_MIME, EXT, sniffMime, type AllowedMime } from './mime';
import { DOWNLOAD_TTL_S, signDocumentUrl, UPLOAD_TTL_S, verifyDocumentUrl } from './signed-url';

/** docs/04 I "10 MB/ไฟล์" (POD ของแอปคนขับมีเพดานเล็กกว่า — กำหนดตอน ST4) */
export const MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_KINDS = [
  'POD_PHOTO',
  'POD_SIGNATURE',
  'SIGNATURE',
  'LOGO',
  'PDF',
  'VEHICLE_DOC',
  'RECEIPT',
  'WHT_CERT',
  'CONTRACT',
  'OTHER',
] as const;

export class CreateDocumentDto {
  @ApiProperty({ enum: DOCUMENT_KINDS }) @IsIn([...DOCUMENT_KINDS]) kind!: string;
  @ApiProperty({
    enum: ALLOWED_MIME,
    description: 'ชนิดที่จะอัปโหลด — server ตรวจกับเนื้อไฟล์จริง',
  })
  @IsIn([...ALLOWED_MIME])
  mime!: AllowedMime;
  @ApiProperty({ example: 182044, description: `ขนาดไฟล์ (byte) ไม่เกิน ${MAX_BYTES}` })
  @IsInt()
  @Min(1)
  @Max(MAX_BYTES)
  bytes!: number;
  @ApiPropertyOptional({ example: 'pod-SO-2611-0001.jpg' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  filename?: string;
  @ApiPropertyOptional({
    description: 'id ฝั่ง client (อุปกรณ์) — ส่งซ้ำได้ ไม่สร้างแถวใหม่ (docs/01 §5.5)',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9._:-]{8,100}$/)
  clientDocumentId?: string;
  @ApiPropertyOptional({ example: 'trip_stop' })
  @IsOptional()
  @Matches(/^[a-z_]{1,40}$/)
  entityType?: string;
}

export class DocumentDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty({ enum: ['pending', 'ready'] }) status!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() mime!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty({ nullable: true, type: String }) sha256!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ description: 'สถานะ pending: PUT เนื้อไฟล์ไปที่นี่ (หมดอายุ 15 นาที)' })
  uploadUrl?: string;
  @ApiPropertyOptional({ description: 'สถานะ ready: ลิงก์ดาวน์โหลด (หมดอายุ 5 นาที)' })
  downloadUrl?: string;
  @ApiPropertyOptional({ format: 'date-time' }) urlExpiresAt?: string;
}

const store = () =>
  new LocalFileStore(process.env.FILES_ROOT ?? join(process.cwd(), '.data', 'files'));
const enc = (id: string) => encodeId('document', id);

function toDto(d: StoredDocument): DocumentDto {
  return {
    id: enc(d.id),
    status: d.status.toLowerCase(),
    kind: d.kind,
    mime: d.mimeType,
    bytes: d.sizeBytes,
    filename: d.filename,
    sha256: d.sha256,
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * ไฟล์แนบ (ST1-T08; docs/01 §5.2 #5) — จอง → อัปโหลดเนื้อไฟล์ผ่าน URL ที่มีลายเซ็น → ตรวจขนาด + MIME จริง → ready
 * ไฟล์เก็บแบบเขียนครั้งเดียว (key = sha256) ไม่มี API ลบ/แก้
 */
@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly db: DbService) {}

  @Post()
  @ApiBearerAuth()
  @RequireScope('documents:write')
  @ApiCreatedResponse({ type: DocumentDto })
  async create(@Body() body: CreateDocumentDto, @Req() req: Request): Promise<DocumentDto> {
    const ctx = requestContext.require();
    const tx = this.db.tx;
    const existing = body.clientDocumentId
      ? await tx.storedDocument.findFirst({ where: { clientDocumentId: body.clientDocumentId } })
      : null;
    const doc =
      existing ??
      (await tx.storedDocument.create({
        data: {
          tenantId: ctx.tenantId!,
          status: 'PENDING',
          kind: body.kind,
          mimeType: body.mime,
          sizeBytes: body.bytes,
          filename: body.filename ?? null,
          clientDocumentId: body.clientDocumentId ?? null,
          entityType: body.entityType ?? null,
          createdBy: ctx.actorId ?? null,
        },
      }));
    return this.withUrl(doc, req);
  }

  @Get(':id')
  @ApiBearerAuth()
  @TenantResource('document')
  @RequireScope('documents:read')
  @ApiOkResponse({ type: DocumentDto })
  async get(@Param('id') id: string, @Req() req: Request): Promise<DocumentDto> {
    const doc = await this.db.tx.storedDocument.findUnique({
      where: { id: decodeIdOr404('document', id) },
    });
    if (!doc) throw new ProblemException('not_found');
    return this.withUrl(doc, req);
  }

  /** อัปโหลดเนื้อไฟล์ (raw body) — ไม่ใช้ token: สิทธิ์มาจากลายเซ็นของ URL ที่ได้จาก POST /documents */
  @Public()
  @Put(':id/content')
  @HttpCode(200)
  @ApiOkResponse({ type: DocumentDto })
  async upload(
    @Param('id') id: string,
    @Query() q: { t?: string; exp?: string; sig?: string },
    @Req() req: Request,
  ): Promise<DocumentDto> {
    const docId = tryDecodeId('document', id);
    const tenantId = docId ? verifyDocumentUrl('upload', docId, q) : null;
    if (!docId || !tenantId) throw new ProblemException('not_found');
    const data = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    return this.db.withTenant(tenantId, async (tx) => {
      // ล็อกแถว — อัปโหลดซ้ำพร้อมกันได้ผลเดียว
      await tx.$queryRaw`SELECT id FROM stored_document WHERE id = ${docId}::uuid FOR UPDATE`;
      const doc = await tx.storedDocument.findUnique({ where: { id: docId } });
      if (!doc) throw new ProblemException('not_found');
      if (doc.status !== 'PENDING') throw new ProblemException('invalid_state_transition');
      const fail = (code: string, message: string) =>
        new ProblemException('validation_failed', undefined, [{ field: 'content', code, message }]);
      if (data.length === 0) throw fail('empty_file', 'file is empty');
      if (data.length > Math.min(doc.sizeBytes, MAX_BYTES))
        throw fail('file_too_large', `file is larger than declared ${doc.sizeBytes} bytes`);
      const real = sniffMime(data);
      if (real !== doc.mimeType)
        throw fail(
          'mime_mismatch',
          `file content is ${real ?? 'unknown'}, declared ${doc.mimeType}`,
        );
      const f = await store().put(tenantId, data, EXT[real]);
      const ready = await tx.storedDocument.update({
        where: { id: docId },
        data: { status: 'READY', fileKey: f.key, sha256: f.sha256, sizeBytes: f.size },
      });
      return toDto(ready);
    });
  }

  @Public()
  @Get(':id/content')
  async download(
    @Param('id') id: string,
    @Query() q: { t?: string; exp?: string; sig?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const docId = tryDecodeId('document', id);
    const tenantId = docId ? verifyDocumentUrl('download', docId, q) : null;
    if (!docId || !tenantId) throw new ProblemException('not_found');
    const doc = await this.db.withTenant(tenantId, (tx: Tx) =>
      tx.storedDocument.findUnique({ where: { id: docId } }),
    );
    if (!doc || doc.status !== 'READY' || !doc.fileKey) throw new ProblemException('not_found');
    const data = await store().get(doc.fileKey);
    const name = (
      doc.filename ?? `${enc(doc.id)}.${EXT[doc.mimeType as AllowedMime] ?? 'bin'}`
    ).replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(data);
  }

  private withUrl(doc: StoredDocument, req: Request): DocumentDto {
    const base = `${req.protocol}://${req.get('host')}/v1/documents/${enc(doc.id)}/content`;
    const dto = toDto(doc);
    if (doc.status === 'PENDING') {
      const s = signDocumentUrl('upload', doc.tenantId, doc.id, UPLOAD_TTL_S);
      dto.uploadUrl = `${base}?${s.query}`;
      dto.urlExpiresAt = s.expiresAt.toISOString();
    } else {
      const s = signDocumentUrl('download', doc.tenantId, doc.id, DOWNLOAD_TTL_S);
      dto.downloadUrl = `${base}?${s.query}`;
      dto.urlExpiresAt = s.expiresAt.toISOString();
    }
    return dto;
  }
}
