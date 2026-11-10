import { Body, Controller, Get, Patch, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { AppUser } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import type { Request, Response } from 'express';
import { expectedVersion, setEtag } from '../../common/etag';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { DOWNLOAD_TTL_S, signDocumentUrl } from '../documents/signed-url';

export const LOCALES = ['th', 'en', 'zh'] as const;
/** เขตเวลาที่รองรับ (ลูกค้าในไทย — เพิ่มได้เมื่อมีลูกค้าต่างประเทศ) */
export const TIMEZONES = ['Asia/Bangkok'] as const;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'สมชาย ใจดี' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    example: '0812345678',
    nullable: true,
    description: 'เบอร์ไทย 0xxxxxxxxx หรือ +66… · null = ลบ',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Matches(/^(0\d{8,9}|\+66\d{8,9})$/)
  phone?: string | null;

  @ApiPropertyOptional({ enum: LOCALES })
  @IsOptional()
  @IsIn([...LOCALES])
  locale?: (typeof LOCALES)[number];

  @ApiPropertyOptional({ enum: TIMEZONES })
  @IsOptional()
  @IsIn([...TIMEZONES])
  timezone?: string;

  @ApiPropertyOptional({
    example: 'doc_…',
    nullable: true,
    description:
      'ลายเซ็น: เอกสาร kind SIGNATURE (PNG/JPEG/WebP) ที่ผู้ใช้อัปโหลดเองและ ready แล้ว · null = ลบ',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  signatureDocumentId?: string | null;
}

export class ProfileSignatureDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty() mime!: string;
  @ApiProperty({ description: 'ลิงก์ดาวน์โหลด (หมดอายุ 5 นาที)' }) downloadUrl!: string;
}
export class ProfileDto {
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ enum: LOCALES }) locale!: string;
  @ApiProperty({ enum: TIMEZONES }) timezone!: string;
  @ApiProperty({ type: ProfileSignatureDto, nullable: true })
  signature!: ProfileSignatureDto | null;
}

/** โปรไฟล์ของผู้ใช้ที่ login (ST1-T09; docs/04 A2) — แก้ได้เฉพาะของตัวเอง; อีเมลแก้ไม่ได้ (เป็นตัวตน login) */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('me/profile')
export class ProfileController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOkResponse({ type: ProfileDto })
  async get(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ProfileDto> {
    const u = await this.me();
    setEtag(res, u.version);
    return this.toDto(u, req);
  }

  @Patch()
  @ApiHeader({ name: 'If-Match', required: false, description: 'ETag จาก GET — ไม่ตรง → 412' })
  @ApiOkResponse({ type: ProfileDto })
  async update(
    @Body() body: UpdateProfileDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProfileDto> {
    const tx = this.db.tx;
    const user = await this.me();
    const expected = expectedVersion(req);
    if (expected !== undefined && expected !== user.version)
      throw new ProblemException('precondition_failed');
    let signatureId: string | null | undefined = undefined;
    if (body.signatureDocumentId === null) signatureId = null;
    else if (body.signatureDocumentId !== undefined) {
      const id = tryDecodeId('document', body.signatureDocumentId);
      const doc = id ? await tx.storedDocument.findUnique({ where: { id } }) : null;
      const ok =
        !!doc &&
        doc.status === 'READY' &&
        doc.kind === 'SIGNATURE' &&
        doc.createdBy === user.id &&
        doc.mimeType.startsWith('image/');
      if (!ok)
        throw new ProblemException('validation_failed', undefined, [
          {
            field: 'signatureDocumentId',
            code: 'invalid_signature',
            message: 'must be your own ready SIGNATURE image document',
          },
        ]);
      signatureId = doc!.id;
    }
    const data = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.locale !== undefined ? { locale: body.locale } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(signatureId !== undefined ? { signatureDocumentId: signatureId } : {}),
    };
    const r = await tx.appUser.updateMany({
      where: { id: user.id, version: user.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    const updated = (await tx.appUser.findUnique({ where: { id: user.id } }))!;
    setEtag(res, updated.version);
    await this.audit.changed(
      'user.profile_updated',
      'user',
      user.id,
      {
        name: user.name,
        phone: user.phone,
        locale: user.locale,
        timezone: user.timezone,
        signatureDocumentId: user.signatureDocumentId,
      },
      {
        name: updated.name,
        phone: updated.phone,
        locale: updated.locale,
        timezone: updated.timezone,
        signatureDocumentId: updated.signatureDocumentId,
      },
    );
    return this.toDto(updated, req);
  }

  private async me(): Promise<AppUser> {
    const ctx = requestContext.require();
    const u =
      ctx.actorId && /^[0-9a-f-]{36}$/i.test(ctx.actorId)
        ? await this.db.tx.appUser.findFirst({ where: { id: ctx.actorId, status: 'ACTIVE' } })
        : null;
    if (!u) throw new ProblemException('not_found');
    return u;
  }

  private async toDto(u: AppUser, req: Request): Promise<ProfileDto> {
    let signature: ProfileSignatureDto | null = null;
    if (u.signatureDocumentId) {
      const doc = await this.db.tx.storedDocument.findUnique({
        where: { id: u.signatureDocumentId },
      });
      if (doc?.status === 'READY') {
        const s = signDocumentUrl('download', doc.tenantId, doc.id, DOWNLOAD_TTL_S);
        const origin = process.env.PUBLIC_API_BASE_URL ?? `${req.protocol}://${req.get('host')}`;
        signature = {
          id: encodeId('document', doc.id),
          mime: doc.mimeType,
          downloadUrl: `${origin.replace(/\/+$/, '')}/v1/documents/${encodeId('document', doc.id)}/content?${s.query}`,
        };
      }
    }
    return {
      name: u.name,
      email: u.email,
      phone: u.phone,
      locale: u.locale,
      timezone: u.timezone,
      signature,
    };
  }
}
