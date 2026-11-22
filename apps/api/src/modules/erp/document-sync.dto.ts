import { ApiProperty } from '@nestjs/swagger';
import { encodeId } from '../../common/ids';
import type { DocumentSyncView } from './external-mapping.service';

/**
 * ST7-T15 ผลการส่งเอกสารเข้าระบบบัญชี (`external_mapping` ของเอกสาร — docs/01 §3.7, §4.4 "`sync` แยกฟิลด์จาก `status`"; docs/04 G3 เลขเอกสารสองฝั่ง)
 * สถานะซิงก์แยกจากสถานะเอกสารเสมอ
 */
export class ErpDocumentSyncDto {
  @ApiProperty({ example: 'con_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' }) connectorId!: string;
  @ApiProperty({
    enum: ['SYNCED', 'PENDING', 'FAILED', 'MISMATCH'],
    description:
      'สถานะการซิงก์ (docs/01 §3.7) — `SYNCED` = ส่งถึงระบบบัญชีแล้วและตรงกับ payload ล่าสุด',
  })
  state!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'id/key ของเอกสารฝั่งระบบบัญชี (ใช้อ้างตอนเรียก API ของระบบนั้น)',
  })
  externalId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'IV-2569-000123',
    description:
      'เลขเอกสารที่ระบบบัญชีออก (แสดงคู่กับเลข TMS) — null = ระบบบัญชียังไม่ออกเลข (เช่น ยังเป็นร่าง)',
  })
  externalDocNo!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['DRAFT', 'POSTED', 'VOIDED', 'PAID'],
    description: 'สถานะเอกสารฝั่งระบบบัญชี (ถ้าระบบนั้นแจ้งกลับ) — แยกจาก `state`',
  })
  externalStatus!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastSyncedAt!: string | null;
}

export function documentSyncDto(v: DocumentSyncView | null): ErpDocumentSyncDto | null {
  if (!v) return null;
  return {
    connectorId: encodeId('connector', v.connectorId),
    state: v.state,
    externalId: v.externalId,
    externalDocNo: v.externalDocNo,
    externalStatus: v.externalStatus,
    lastSyncedAt: v.lastSyncedAt?.toISOString() ?? null,
  };
}

export const DOCUMENT_SYNC_DOC =
  'ST7-T15 ผลการส่งใบนี้เข้าระบบบัญชีที่เชื่อมต่อ (เลขเอกสารสองฝั่ง — `externalDocNo` = เลขที่ระบบบัญชีออก) · แยกจาก `status` ของเอกสาร · ' +
  'มีเฉพาะ `GET /{id}` · null = ยังไม่มีผลการส่ง (ไม่ได้เชื่อมระบบบัญชี / ยังรอคิว / ส่งไม่สำเร็จ — ดูคิวของ connector)';
