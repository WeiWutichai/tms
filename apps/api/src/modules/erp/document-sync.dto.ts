import { ApiProperty } from '@nestjs/swagger';
import { encodeId } from '../../common/ids';
import type { DocumentSyncView } from './external-mapping.service';

/**
 * ST7-T15 ผลการส่งเอกสารเข้าระบบบัญชี (`external_mapping` ของเอกสาร — docs/01 §3.7, §4.4 "`sync` แยกฟิลด์จาก `status`"; docs/04 G3 เลขเอกสารสองฝั่ง)
 * สถานะซิงก์แยกจากสถานะเอกสารเสมอ
 */
/** ST8-T08 เอกสาร 1 ใบฝั่งระบบบัญชี เมื่อใบ TMS ถูกแยกเป็นหลายใบ */
export class ErpExternalDocumentDto {
  @ApiProperty({
    example: 'INV-00000-6911-0001-V7',
    description: 'เลขอ้างอิงที่ TMS ส่ง (เช่น `tmsVoucherNo` ของ KRS)',
  })
  ref!: string;
  @ApiProperty({ example: '100002' }) externalId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'SA-S6911-0002' })
  externalDocNo!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'VAT_7',
    description:
      'กลุ่มที่แยก (เช่น `vat_type` ของรายการในใบนี้) — แบ่งเพราะขนาดอย่างเดียว = กลุ่มเดียวกัน · ไม่แยกตามกลุ่ม = null',
  })
  group!: string | null;
}

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
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['SENT', 'ACCEPTED', 'MISMATCH'],
    description:
      'ST8-T11 ผลกระทบยอดเนื้อหากับระบบบัญชี (docs/01 §4.4): `SENT` ส่งแล้วยังไม่ได้อ่านกลับมาเทียบ · `ACCEPTED` อ่านกลับแล้วตรง (หรือคนยอมรับส่วนต่างนั้นแล้ว) · ' +
      '`MISMATCH` ไม่ตรง (ดู `GET /reconcile-results?invoiceId=`) · null = ยังไม่อยู่ในระบบบัญชี',
  })
  reconcileState!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'ST8-T11 เวลาที่เทียบเนื้อหาล่าสุด',
  })
  reconciledAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'ST8-T13 เวลาที่ฝ่ายบัญชีกด "ลงบัญชีแล้ว" (ระบบบัญชีที่บอกสถานะลงบัญชีไม่ได้ เช่น KRS) — มีค่า = แทนที่เอกสารในระบบบัญชีต้องมีผู้อนุมัติ',
  })
  postedAt!: string | null;
  @ApiProperty({
    type: [ErpExternalDocumentDto],
    description:
      'ST8-T08 เอกสารฝั่งระบบบัญชีทุกใบ เมื่อระบบบัญชีรับใบนี้เป็นหลายเอกสาร (เช่น KRS แยกใบตาม `vat_type` เพราะสัญญาไม่มี VAT ต่อรายการ — docs/01 A.6) · ' +
      'ใบแรก = `externalId` / `externalDocNo` · เอกสารเดียว = `[]`',
  })
  externalDocuments!: ErpExternalDocumentDto[];
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
    reconcileState: v.reconcileState,
    reconciledAt: v.reconciledAt?.toISOString() ?? null,
    postedAt: v.postedAt?.toISOString() ?? null,
    externalDocuments: v.externalDocuments.map((d) => ({ ...d })),
  };
}

export const DOCUMENT_SYNC_DOC =
  'ST7-T15 ผลการส่งใบนี้เข้าระบบบัญชีที่เชื่อมต่อ (เลขเอกสารสองฝั่ง — `externalDocNo` = เลขที่ระบบบัญชีออก) · แยกจาก `status` ของเอกสาร · ' +
  'มีเฉพาะ `GET /{id}` · null = ยังไม่มีผลการส่ง (ไม่ได้เชื่อมระบบบัญชี / ยังรอคิว / ส่งไม่สำเร็จ — ดูคิวของ connector)';
