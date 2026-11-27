import { ipKey, RateLimitService, slidingWindow } from '../../http/rate-limit/rate-limit.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Optional,
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
import { scopeAllows } from '@tms/domain';
import { Public, RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { PROBLEMS, ProblemException, type ProblemCode } from '../../common/problem';
import { assertAttachmentAccess } from '../attachments/attachment-access';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { defaultFileStore, FILE_KEY_LOCK_NS, putFileLocked } from '../../pdf/file-store';
import { EntitlementService } from '../entitlements/entitlement.service';
import { ImportRegistry, importSpecAllowed } from '../imports/import-spec';
import { POD_LINK_PURPOSE, podLinkUsable } from '../trips/offer-links';
import {
  ALLOWED_MIME,
  EXT,
  IMPORT_MIME,
  LOGO_MAX_BYTES,
  LOGO_SVG_MAX_BYTES,
  LOGO_MIME,
  sniffMime,
  type AllowedMime,
} from './mime';
import { sanitizeSvg } from './svg-sanitize';
import {
  DOWNLOAD_TTL_S,
  IMPORT_DOWNLOAD_TTL_S,
  signDocumentUrl,
  UPLOAD_TTL_S,
  verifyDocumentUrl,
} from './signed-url';

/** docs/04 I "10 MB/ไฟล์" (POD ของแอปคนขับมีเพดานเล็กกว่า — กำหนดตอน ST4) */
export const MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_KINDS = [
  'POD_PHOTO',
  'POD_SIGNATURE',
  /** ไฟล์อื่นของหลักฐานส่ง เช่น ใบส่งของที่เซ็นแล้ว ใบชั่ง (ST4-T07) */
  'POD_FILE',
  'SIGNATURE',
  'LOGO',
  'PDF',
  'VEHICLE_DOC',
  'RECEIPT',
  'WHT_CERT',
  'CONTRACT',
  'IMPORT',
  'OTHER',
] as const;

export class CreateDocumentDto {
  @ApiProperty({ enum: DOCUMENT_KINDS }) @IsIn([...DOCUMENT_KINDS]) kind!: string;
  @ApiProperty({
    enum: ALLOWED_MIME,
    description:
      'ชนิดที่จะอัปโหลด — server ตรวจกับเนื้อไฟล์จริง · kind `LOGO` (โลโก้องค์กร P1-ST6-T04) = `image/png` ≤ 2 MB หรือ `image/svg+xml` ≤ 512 KB ' +
      '(SVG ใช้ได้กับ LOGO เท่านั้น และถูกล้าง script/event handler/อ้างของภายนอก/foreignObject ก่อนเก็บ)',
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
  @ApiProperty({
    enum: ['pending', 'ready', 'purged'],
    description:
      'purged = ไฟล์ถูกลบตามระยะเก็บ (ST9-T14: POD ≥ 2 ปี, ไฟล์ส่งออก 7 วัน) — ดาวน์โหลดไม่ได้ (404)',
  })
  status!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() mime!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty({ nullable: true, type: String }) sha256!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ description: 'สถานะ pending: PUT เนื้อไฟล์ไปที่นี่ (หมดอายุ 15 นาที)' })
  uploadUrl?: string;
  @ApiPropertyOptional({
    description: 'สถานะ ready: ลิงก์ดาวน์โหลด (หมดอายุ 5 นาที · ไฟล์นำเข้า IMPORT 60 วินาที)',
  })
  downloadUrl?: string;
  @ApiPropertyOptional({ format: 'date-time' }) urlExpiresAt?: string;
}

export const store = defaultFileStore;
const enc = (id: string) => encodeId('document', id);

/** ย้ายไป `pdf/file-store.ts` (ST5-T21 review — ใช้ร่วมนอก controller) — re-export เพื่อผู้เรียกเดิม */
export { FILE_KEY_LOCK_NS, putFileLocked };
/** ST7-T08: URL ลายเซ็นผิดต่อ IP ต่อนาที ก่อนตอบ 429 */
export const BAD_SIGNATURE_PER_MIN = 30;

/** DTO + ลิงก์ดาวน์โหลดอายุสั้น (READY) — ใช้ร่วมกับเอกสารที่ระบบสร้างเอง เช่น ใบคุมรถ ST3-T20 */
export function readyDocumentDto(doc: StoredDocument, origin: string): DocumentDto {
  const dto = toDto(doc);
  if (doc.status !== 'READY') return dto; // PURGED (ST9-T14) ไม่มีลิงก์
  const s = signDocumentUrl('download', doc.tenantId, doc.id, DOWNLOAD_TTL_S);
  dto.downloadUrl = `${origin.replace(/\/+$/, '')}/v1/documents/${enc(doc.id)}/content?${s.query}`;
  dto.urlExpiresAt = s.expiresAt.toISOString();
  return dto;
}

/** ฐาน URL ของ API จากค่าตั้ง (ไม่เชื่อ Host / X-Forwarded-* ของ request) — dev ใช้ค่าจาก request */
export const apiOrigin = (req: Request) =>
  process.env.PUBLIC_API_BASE_URL ?? `${req.protocol}://${req.get('host')}`;

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

/** ตัวอย่าง problem+json ของ `/v1/documents` (OpenAPI — ST7-T11) */
const DP = (code: ProblemCode, instance: string, extra: Record<string, unknown> = {}) => ({
  type: `https://docs.tms.example/problems/${code}`,
  title: PROBLEMS[code].th,
  status: PROBLEMS[code].status,
  code,
  instance,
  requestId: 'b6a1c2d3-…',
  ...extra,
});
const D_CREATE_409 = {
  status: 409,
  description: '`clientDocumentId` นี้ถูกใช้แล้ว (คนอื่น/ชนิดอื่น/ขนาดอื่น)',
  examples: { duplicate: DP('duplicate', '/v1/documents') },
};
const D_CREATE_422 = {
  status: 422,
  description: 'ชนิด/ขนาดไม่ถูกต้อง — `errors[]` รายช่อง',
  examples: {
    validation_failed: DP('validation_failed', '/v1/documents', {
      errors: [
        { field: 'mime', code: 'mime_not_allowed', message: 'mime is not allowed for this kind' },
      ],
    }),
  },
};
const D_SIG_404 = {
  status: 404,
  description: 'ลายเซ็นของ URL ผิด/หมดอายุ หรือไม่พบไฟล์ (ผิดเกิน 30 ครั้ง/นาที/IP → 429)',
  examples: { not_found: DP('not_found', '/v1/documents/doc_3f2a…/content') },
};
const D_UPLOAD_409 = {
  status: 409,
  description: 'อัปโหลดแล้ว (ไฟล์เขียนครั้งเดียว)',
  examples: {
    invalid_state_transition: DP('invalid_state_transition', '/v1/documents/doc_3f2a…/content'),
  },
};
const D_UPLOAD_422 = {
  status: 422,
  description:
    'ไฟล์ว่าง / ใหญ่กว่าที่จองไว้ / เนื้อไฟล์ไม่ตรงชนิดที่ประกาศ · `svg_unsafe` = SVG ของโลโก้ล้างไม่ได้ (ไม่ใช่ SVG)',
  examples: {
    validation_failed: DP('validation_failed', '/v1/documents/doc_3f2a…/content', {
      errors: [
        {
          field: 'content',
          code: 'mime_mismatch',
          message: 'file content is image/png, declared image/jpeg',
        },
      ],
    }),
  },
};

/** metadata ของไฟล์ (ไม่มี URL) — ใช้กับรายการไฟล์ของ resource อื่น (ST7-T11 `GET /v1/orders/{id}/documents`) */
export const toDocumentDto = (d: StoredDocument): DocumentDto => toDto(d);

/**
 * ไฟล์แนบ (ST1-T08; docs/01 §5.2 #5) — จอง → อัปโหลดเนื้อไฟล์ผ่าน URL ที่มีลายเซ็น → ตรวจขนาด + MIME จริง → ready
 * ไฟล์เก็บแบบเขียนครั้งเดียว (key = sha256) ไม่มี API ลบ/แก้
 */
@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly db: DbService,
    private readonly limiter: RateLimitService,
    private readonly importSpecs: ImportRegistry,
    @Optional() private readonly entitlements?: EntitlementService,
  ) {}

  /**
   * ไฟล์ต้นฉบับที่นำเข้า (kind IMPORT) อาจมีข้อมูลส่วนบุคคลเต็ม (เลขบัตรคนขับ เบอร์โทร ฯลฯ — ST9-T16 R-1)
   * เห็นได้เฉพาะ:
   * - ผู้อัปโหลดเอง — เห็นเสมอ แม้ภายหลังถูกลดสิทธิ์ (เป็นไฟล์ที่เขาถืออยู่แล้ว) · API key ก็เห็นเฉพาะไฟล์ที่ key นั้นอัปโหลด
   * - ผู้ใช้ (pt user/dev) ที่มีสิทธิ์จัดการการนำเข้า **ทุกชนิด** ที่อ้างไฟล์นี้ (scope ของ ImportSpec + แพ็กเกจ)
   *   — ไฟล์เดียวถูกใช้กับหลายชนิดได้ ผ่านชนิดเดียวไม่พอ · ยังไม่มีงานนำเข้าอ้างถึง = ไม่เห็น
   * การเข้าใช้งานแทน (ทีม Innovera) ไม่เห็นเลย แม้สวมผู้อัปโหลด
   */
  private async canSeeImportFile(doc: StoredDocument): Promise<boolean> {
    const ctx = requestContext.require();
    if (ctx.principalType === 'imp') return false;
    if (doc.createdBy !== null && doc.createdBy === (ctx.actorId ?? null)) return true;
    if (ctx.principalType !== 'user' && ctx.principalType !== 'dev') return false;
    const jobs = await this.db.tx.importJob.findMany({
      where: { documentId: doc.id },
      select: { kind: true },
      distinct: ['kind'],
    });
    if (!jobs.length) return false;
    for (const j of jobs) {
      const spec = this.importSpecs.get(j.kind);
      if (!(await importSpecAllowed(spec, ctx.scopes ?? [], ctx.tenantId!, this.entitlements)))
        return false;
    }
    return true;
  }

  /**
   * ST7-T08 (review L1): URL ลายเซ็นผิด/หมดอายุ → นับต่อ IP (30 ครั้ง/นาที) เกินแล้วตอบ 429 แทน 404 — กันสแกน id/ลายเซ็น
   * (นับเฉพาะครั้งที่ผิด — คำขอที่ลายเซ็นถูกไม่ถูกจำกัด)
   */
  private async badSignature(req: Request): Promise<never> {
    await this.limiter.assert([
      slidingWindow(`docsig:${ipKey(req.ip)}`, BAD_SIGNATURE_PER_MIN, 60_000, 'ip'),
    ]);
    throw new ProblemException('not_found');
  }

  @Post()
  @ApiBearerAuth()
  @RequireScope('documents:write')
  @ApiProblems(D_CREATE_409, D_CREATE_422)
  @ApiCreatedResponse({ type: DocumentDto })
  async create(@Body() body: CreateDocumentDto, @Req() req: Request): Promise<DocumentDto> {
    const ctx = requestContext.require();
    const tx = this.db.tx;
    // ไฟล์ตาราง (.xlsx/.csv) ใช้ได้กับ kind IMPORT เท่านั้น และ IMPORT รับแค่ไฟล์ตาราง (ST1-T19)
    if ((body.kind === 'IMPORT') !== IMPORT_MIME.includes(body.mime))
      throw new ProblemException('validation_failed', undefined, [
        { field: 'mime', code: 'mime_not_allowed', message: 'mime is not allowed for this kind' },
      ]);
    // P1-ST6-T04 โลโก้องค์กร: PNG/SVG ≤ 2 MB · SVG ใช้ได้กับ LOGO เท่านั้น (ล้างก่อนเก็บ — svg-sanitize.ts)
    if (body.kind === 'LOGO' ? !LOGO_MIME.includes(body.mime) : body.mime === 'image/svg+xml')
      throw new ProblemException('validation_failed', undefined, [
        { field: 'mime', code: 'mime_not_allowed', message: 'mime is not allowed for this kind' },
      ]);
    const logoMax = body.mime === 'image/svg+xml' ? LOGO_SVG_MAX_BYTES : LOGO_MAX_BYTES;
    if (body.kind === 'LOGO' && body.bytes > logoMax)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'bytes',
          code: 'file_too_large',
          message: `logo must be at most ${logoMax} bytes`,
        },
      ]);
    const existing = body.clientDocumentId
      ? await tx.storedDocument.findFirst({ where: { clientDocumentId: body.clientDocumentId } })
      : null;
    // ส่งซ้ำได้เฉพาะคนเดิมและข้อมูลเดิม (เหมือน Idempotency-Key) — กันคนอื่นเอา id มาขอ URL อัปโหลดของเขา
    if (
      existing &&
      (existing.createdBy !== (ctx.actorId ?? null) ||
        existing.kind !== body.kind ||
        existing.mimeType !== body.mime ||
        (existing.status === 'PENDING' && existing.sizeBytes !== body.bytes))
    )
      throw new ProblemException('duplicate', undefined, [
        { field: 'clientDocumentId', code: 'duplicate', message: 'clientDocumentId already used' },
      ]);
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
  @ApiOkResponse({
    type: DocumentDto,
    description:
      'ไฟล์ส่งออก (EXPORT) เห็นเฉพาะผู้สั่ง · ไฟล์นำเข้า (IMPORT) เห็นเฉพาะผู้อัปโหลด (API key เห็นเฉพาะไฟล์ที่ key นั้นอัปโหลด) หรือผู้ใช้ที่มีสิทธิ์จัดการการนำเข้าทุกชนิดที่ใช้ไฟล์นั้น; การเข้าใช้งานแทนไม่เห็น; `downloadUrl` ของไฟล์นำเข้าหมดอายุ 60 วินาที — ไม่มีสิทธิ์ = 404',
  })
  async get(@Param('id') id: string, @Req() req: Request): Promise<DocumentDto> {
    const doc = await this.db.tx.storedDocument.findUnique({
      where: { id: decodeIdOr404('document', id) },
    });
    if (!doc) throw new ProblemException('not_found');
    // ไฟล์ส่งออก (ST9-T10) มีข้อมูลตามสิทธิ์ของผู้สั่ง — เฉพาะผู้สั่งเท่านั้น (ดาวน์โหลดผ่าน GET /v1/exports/{id})
    if (doc.kind === 'EXPORT' && doc.createdBy !== (requestContext.require().actorId ?? null))
      throw new ProblemException('not_found');
    // ไฟล์นำเข้า (ST9-T16 R-1) — ไม่มีสิทธิ์ตอบ 404 เหมือนไม่มี (ไม่บอกใบ้ว่ามีอยู่) แบบเดียวกับไฟล์ส่งออก
    if (doc.kind === 'IMPORT' && !(await this.canSeeImportFile(doc)))
      throw new ProblemException('not_found');
    // ไฟล์แนบที่เป็นข้อมูลส่วนบุคคล (คนขับ/ผู้รับเหมา — PO 24 พ.ย. 2569): ต้องผ่านด่านเดียวกับการดูค่าเต็ม
    assertAttachmentAccess(doc);
    return this.withUrl(doc, req);
  }

  /** อัปโหลดเนื้อไฟล์ (raw body) — ไม่ใช้ token: สิทธิ์มาจากลายเซ็นของ URL ที่ได้จาก POST /documents */
  @Public()
  @Put(':id/content')
  @HttpCode(200)
  @ApiProblems(D_SIG_404, D_UPLOAD_409, D_UPLOAD_422)
  @ApiOkResponse({ type: DocumentDto })
  async upload(
    @Param('id') id: string,
    @Query() q: { t?: string; exp?: string; sig?: string },
    @Req() req: Request,
  ): Promise<DocumentDto> {
    const docId = tryDecodeId('document', id);
    const tenantId = docId ? verifyDocumentUrl('upload', docId, q) : null;
    if (!docId || !tenantId) return this.badSignature(req);
    const data = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    return this.db.withTenant(tenantId, async (tx) => {
      // ล็อกแถว — อัปโหลดซ้ำพร้อมกันได้ผลเดียว
      await tx.$queryRaw`SELECT id FROM stored_document WHERE id = ${docId}::uuid FOR UPDATE`;
      const doc = await tx.storedDocument.findUnique({ where: { id: docId } });
      if (!doc) throw new ProblemException('not_found');
      if (doc.status !== 'PENDING') throw new ProblemException('invalid_state_transition');
      // ไฟล์ที่จองผ่าน magic link (ST2-T21): ลิงก์ถูกเพิกถอน/หมดอายุแล้ว → อัปโหลดไม่ได้ (ไม่รอ URL หมด 15 นาที)
      if (doc.createdBy?.startsWith('link:')) {
        const link = await tx.magicLink.findUnique({ where: { id: doc.createdBy.slice(5) } });
        if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now())
          throw new ProblemException('not_found');
        // ST4-T09 ลิงก์งานรถร่วม: ใช้ได้ตามเที่ยว (เที่ยวจบเกิน 7 วัน / การจ้างไม่ ACCEPTED แล้ว → 404) เหมือน /public/pod
        if (link.purpose === POD_LINK_PURPOSE) {
          const offer = await tx.subconOffer.findUnique({
            where: { id: link.entityId },
            select: { status: true, carrierId: true, tripId: true },
          });
          const trip = offer
            ? await tx.trip.findUnique({
                where: { id: offer.tripId },
                select: { status: true, carrierId: true, completedAt: true },
              })
            : null;
          if (!offer || !trip || !podLinkUsable(offer, trip, new Date()))
            throw new ProblemException('not_found');
        }
      }
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
      let content = data;
      if (real === 'image/svg+xml') {
        // P1-ST6-T04 เก็บเฉพาะ SVG ที่ล้างแล้ว (script / event handler / อ้างของภายนอก / foreignObject ถูกตัด)
        const clean = sanitizeSvg(data.toString('utf8'));
        if (!clean) throw fail('svg_unsafe', 'SVG could not be sanitized');
        content = Buffer.from(clean, 'utf8');
      }
      const f = await putFileLocked(tx, tenantId, content, EXT[real]);
      const ready = await tx.storedDocument.update({
        where: { id: docId },
        data: { status: 'READY', fileKey: f.key, sha256: f.sha256, sizeBytes: f.size },
      });
      return toDto(ready);
    });
  }

  @Public()
  @Get(':id/content')
  @ApiOkResponse({ description: 'เนื้อไฟล์ (Content-Type ตามไฟล์, attachment, no-store)' })
  @ApiProblems(D_SIG_404)
  async download(
    @Param('id') id: string,
    @Query() q: { t?: string; exp?: string; sig?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const docId = tryDecodeId('document', id);
    const tenantId = docId ? verifyDocumentUrl('download', docId, q) : null;
    if (!docId || !tenantId) return this.badSignature(req);
    const doc = await this.db.withTenant(tenantId, (tx: Tx) =>
      tx.storedDocument.findUnique({ where: { id: docId } }),
    );
    if (!doc || doc.status !== 'READY' || !doc.fileKey) throw new ProblemException('not_found');
    const data = await store().get(doc.fileKey);
    const name = (
      doc.filename ?? `${enc(doc.id)}.${EXT[doc.mimeType as AllowedMime] ?? 'bin'}`
    ).replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Type', doc.mimeType);
    const utf8 = encodeURIComponent(doc.filename ?? name).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${name}"; filename*=UTF-8''${utf8}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    // SVG (โลโก้ — ล้างแล้ว) เปิดตรงในเบราว์เซอร์ต้องไม่รันอะไร
    if (doc.mimeType === 'image/svg+xml')
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    return new StreamableFile(data);
  }

  private withUrl(doc: StoredDocument, req: Request): DocumentDto {
    // ฐาน URL จากค่าตั้ง (ไม่เชื่อ Host / X-Forwarded-* ของ request) — dev ใช้ค่าจาก request
    const origin = apiOrigin(req);
    const base = `${origin.replace(/\/+$/, '')}/v1/documents/${enc(doc.id)}/content`;
    const dto = toDto(doc);
    const ctx = requestContext.require();
    // เข้าใช้งานแทน (อ่านอย่างเดียว — ST1-T24) ไม่ได้ URL อัปโหลด: PUT content เป็น @Public จึงไม่ผ่านด่าน read-only
    const canUpload =
      ctx.principalType !== 'imp' &&
      doc.createdBy === (ctx.actorId ?? null) &&
      scopeAllows(ctx.scopes ?? [], 'documents:write');
    if (doc.status === 'PENDING') {
      // URL อัปโหลดให้เฉพาะผู้จองที่มีสิทธิ์เขียน (review T08 B1 — Viewer/คนอื่นอ่านได้แต่เขียนทับไม่ได้)
      if (!canUpload) return dto;
      const s = signDocumentUrl('upload', doc.tenantId, doc.id, UPLOAD_TTL_S);
      dto.uploadUrl = `${base}?${s.query}`;
      dto.urlExpiresAt = s.expiresAt.toISOString();
    } else if (doc.status === 'READY') {
      // PURGED (ST9-T14) = ไฟล์ถูกลบตามระยะเก็บ — ไม่มีลิงก์ดาวน์โหลด
      // ไฟล์นำเข้า (มีข้อมูลส่วนบุคคลเต็ม — ST9-T16 R-1) ลิงก์อายุสั้นกว่า: หน้าเว็บไม่ดาวน์โหลดไฟล์นี้ ใช้แค่ผ่าน API
      const ttl = doc.kind === 'IMPORT' ? IMPORT_DOWNLOAD_TTL_S : DOWNLOAD_TTL_S;
      const s = signDocumentUrl('download', doc.tenantId, doc.id, ttl);
      dto.downloadUrl = `${base}?${s.query}`;
      dto.urlExpiresAt = s.expiresAt.toISOString();
    }
    return dto;
  }
}
