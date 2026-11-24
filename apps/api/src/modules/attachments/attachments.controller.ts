import { Body, Controller, Get, HttpCode, Injectable, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { RequireScope, TenantResource } from '../../common/decorators';
import { decodeIdOr404, encodeId, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { ApiProblems } from '../../common/problem.dto';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { CleanText } from '../master/master-kit';
import { T403, T404, T422 } from '../trips/trip-problems';

/**
 * ไฟล์แนบของคนขับ / ผู้รับเหมา (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ — แท็บ "เอกสารแนบ" ของ drawer คนขับ/ผู้รับเหมา;
 * docs/04 B คนขับ "รูปใบขับขี่/บัตร", ผู้รับเหมา "ภ.พ.20 / สัญญาจ้าง")
 * - ใช้ไฟล์ของ `/v1/documents` เดิม (อัปโหลดแล้ว READY) → ผูกด้วย `stored_document.entity_type/entity_id` + `metadata.attachType`
 *   ไม่เพิ่มตาราง/ไม่มี migration
 * - ผูกได้เฉพาะไฟล์ที่ยังไม่ผูกกับอะไร (entity_id ว่าง) ของบริษัทนี้ (RLS) และ `entityType` ว่างหรือตรงชนิด
 * - เอาออก = เหตุผล ≥ 10 + audit · ไม่ลบไฟล์/แถว (ไม่มี hard delete) — `metadata.removed` ซ่อนจากรายการ
 */
export const DRIVER_ATTACH_TYPES = ['LICENCE', 'ID_CARD', 'OTHER'] as const;
export const CARRIER_ATTACH_TYPES = [
  'VAT_REG',
  'CONTRACT',
  'ID_CARD',
  'BANK_BOOK',
  'OTHER',
] as const;
const ENTITY = { driver: 'driver', carrier: 'carrier' } as const;
type Owner = keyof typeof ENTITY;

export class AttachmentDto {
  @ApiProperty({ example: 'doc_…' }) id!: string;
  @ApiProperty({ example: 'LICENCE' }) attachType!: string;
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty() mime!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) createdBy!: string | null;
}
export class AttachmentListDto {
  @ApiProperty({ type: [AttachmentDto] }) data!: AttachmentDto[];
}

export class AddDriverAttachmentDto {
  @ApiProperty({
    example: 'doc_…',
    description: 'ไฟล์จาก `POST /v1/documents` ที่อัปโหลดเสร็จแล้ว',
  })
  @IsString()
  @Matches(/^doc_[0-9a-f]{32}$/i)
  documentId!: string;
  @ApiProperty({ enum: DRIVER_ATTACH_TYPES })
  @IsIn(DRIVER_ATTACH_TYPES)
  attachType!: string;
}
export class AddCarrierAttachmentDto {
  @ApiProperty({
    example: 'doc_…',
    description: 'ไฟล์จาก `POST /v1/documents` ที่อัปโหลดเสร็จแล้ว',
  })
  @IsString()
  @Matches(/^doc_[0-9a-f]{32}$/i)
  documentId!: string;
  @ApiProperty({
    enum: CARRIER_ATTACH_TYPES,
    description: 'VAT_REG = ภ.พ.20 · CONTRACT = สัญญาจ้าง',
  })
  @IsIn(CARRIER_ATTACH_TYPES)
  attachType!: string;
}
export class RemoveAttachmentDto {
  @ApiProperty({ example: 'doc_…' })
  @IsString()
  @Matches(/^doc_[0-9a-f]{32}$/i)
  documentId!: string;
  @ApiProperty({ minLength: 10, maxLength: 500, example: 'อัปโหลดผิดไฟล์ ใช้ฉบับใหม่แทน' })
  @CleanText()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private async owner(kind: Owner, id: string): Promise<string> {
    const tx = this.db.tx;
    const uuid = decodeIdOr404(kind, id);
    const row =
      kind === 'driver'
        ? await tx.driver.findFirst({ where: { id: uuid, deletedAt: null }, select: { id: true } })
        : await tx.carrier.findFirst({
            where: { id: uuid, deletedAt: null },
            select: { id: true },
          });
    if (!row) throw new ProblemException('not_found');
    return row.id;
  }

  async list(kind: Owner, id: string): Promise<AttachmentListDto> {
    const entityId = await this.owner(kind, id);
    const rows = await this.db.tx.storedDocument.findMany({
      where: { entityType: ENTITY[kind], entityId, status: 'READY' },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return {
      data: rows
        .filter((r) => !(r.metadata as { removed?: unknown } | null)?.removed)
        .map((r) => ({
          id: encodeId('document', r.id),
          attachType: String((r.metadata as { attachType?: string } | null)?.attachType ?? 'OTHER'),
          filename: r.filename,
          mime: r.mimeType,
          bytes: r.sizeBytes,
          createdAt: r.createdAt.toISOString(),
          createdBy: r.createdBy,
        })),
    };
  }

  async add(kind: Owner, id: string, documentId: string, attachType: string) {
    const tx = this.db.tx;
    const entityId = await this.owner(kind, id);
    const docId = tryDecodeId('document', documentId);
    const doc = docId ? await tx.storedDocument.findFirst({ where: { id: docId } }) : null;
    if (!doc) throw field422('documentId', 'not_found', 'document not found');
    if (doc.status !== 'READY')
      throw field422('documentId', 'not_ready', 'document upload is not complete');
    if (doc.entityId && !(doc.entityType === ENTITY[kind] && doc.entityId === entityId))
      throw field422('documentId', 'already_linked', 'document is attached to something else');
    if (doc.entityType && doc.entityType !== ENTITY[kind])
      throw field422('documentId', 'wrong_entity', `document was uploaded for ${doc.entityType}`);
    const meta = { ...((doc.metadata as Record<string, unknown> | null) ?? {}), attachType };
    await tx.storedDocument.update({
      where: { id: doc.id },
      data: { entityType: ENTITY[kind], entityId, metadata: meta },
    });
    await this.audit.record({
      action: `${kind}.attachment_added`,
      entityType: kind,
      entityId,
      after: { documentId: encodeId('document', doc.id), attachType, filename: doc.filename },
    });
    return this.list(kind, id);
  }

  async remove(kind: Owner, id: string, documentId: string, reason: string) {
    const tx = this.db.tx;
    const entityId = await this.owner(kind, id);
    const docId = tryDecodeId('document', documentId);
    const doc = docId
      ? await tx.storedDocument.findFirst({
          where: { id: docId, entityType: ENTITY[kind], entityId },
        })
      : null;
    const meta = (doc?.metadata as Record<string, unknown> | null) ?? {};
    if (!doc || meta.removed) throw field422('documentId', 'not_found', 'attachment not found');
    const ctx = requestContext.require();
    await tx.storedDocument.update({
      where: { id: doc.id },
      data: {
        metadata: {
          ...meta,
          removed: { at: new Date().toISOString(), by: ctx.actorId ?? null, reason },
        },
      },
    });
    await this.audit.record({
      action: `${kind}.attachment_removed`,
      entityType: kind,
      entityId,
      before: { documentId: encodeId('document', doc.id), attachType: meta.attachType ?? null },
      reason,
    });
    return this.list(kind, id);
  }
}

@ApiTags('drivers')
@ApiBearerAuth()
@Controller('drivers')
export class DriverAttachmentsController {
  constructor(private readonly svc: AttachmentsService) {}

  @Get(':id/attachments')
  @TenantResource('driver')
  @RequireScope('master:read')
  @ApiProblems(T403('master:read'), T404)
  @ApiOkResponse({
    type: AttachmentListDto,
    description: 'ไฟล์แนบของคนขับ (รูปใบขับขี่ / บัตร / อื่น ๆ)',
  })
  list(@Param('id') id: string): Promise<AttachmentListDto> {
    return this.svc.list('driver', id);
  }

  @Post(':id/attachments')
  @HttpCode(200)
  @TenantResource('driver')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404, T422)
  @ApiOkResponse({ type: AttachmentListDto, description: 'ผูกไฟล์ที่อัปโหลดแล้วกับคนขับ (audit)' })
  add(@Param('id') id: string, @Body() body: AddDriverAttachmentDto): Promise<AttachmentListDto> {
    return this.svc.add('driver', id, body.documentId, body.attachType);
  }

  @Post(':id/attachments/remove')
  @HttpCode(200)
  @TenantResource('driver')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404, T422)
  @ApiOkResponse({
    type: AttachmentListDto,
    description: 'เอาไฟล์ออก (เหตุผล ≥ 10 + audit — ไม่ลบไฟล์)',
  })
  remove(@Param('id') id: string, @Body() body: RemoveAttachmentDto): Promise<AttachmentListDto> {
    return this.svc.remove('driver', id, body.documentId, body.reason);
  }
}

@ApiTags('carriers')
@ApiBearerAuth()
@Controller('carriers')
export class CarrierAttachmentsController {
  constructor(private readonly svc: AttachmentsService) {}

  @Get(':id/attachments')
  @TenantResource('carrier')
  @RequireScope('master:read')
  @ApiProblems(T403('master:read'), T404)
  @ApiOkResponse({
    type: AttachmentListDto,
    description: 'ไฟล์แนบของผู้รับเหมา (ภ.พ.20 / สัญญาจ้าง / อื่น ๆ)',
  })
  list(@Param('id') id: string): Promise<AttachmentListDto> {
    return this.svc.list('carrier', id);
  }

  @Post(':id/attachments')
  @HttpCode(200)
  @TenantResource('carrier')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404, T422)
  @ApiOkResponse({
    type: AttachmentListDto,
    description: 'ผูกไฟล์ที่อัปโหลดแล้วกับผู้รับเหมา (audit)',
  })
  add(@Param('id') id: string, @Body() body: AddCarrierAttachmentDto): Promise<AttachmentListDto> {
    return this.svc.add('carrier', id, body.documentId, body.attachType);
  }

  @Post(':id/attachments/remove')
  @HttpCode(200)
  @TenantResource('carrier')
  @RequireScope('master:write')
  @ApiProblems(T403('master:write'), T404, T422)
  @ApiOkResponse({
    type: AttachmentListDto,
    description: 'เอาไฟล์ออก (เหตุผล ≥ 10 + audit — ไม่ลบไฟล์)',
  })
  remove(@Param('id') id: string, @Body() body: RemoveAttachmentDto): Promise<AttachmentListDto> {
    return this.svc.remove('carrier', id, body.documentId, body.reason);
  }
}
