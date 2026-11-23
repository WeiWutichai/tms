import { Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { encodeId } from '../../common/ids';
import { DbService, type Tx } from '../../db/db.service';
import { ConnectorResolver } from './connector-resolver';

/** D-64 รหัสคำเตือน: เที่ยวที่ไม่มีชื่อคนขับ → ระบบบัญชีได้ชื่อบริษัทรถร่วมแทน */
export const ERP_DRIVER_NAME_SUBSTITUTED = 'erp_driver_name_substituted';

/** จำนวนเลข DO สูงสุดที่แสดงต่อคำเตือน */
const MAX_DO_NOS = 50;

/**
 * D-64 (ST8-T08) คำเตือนก่อนส่งเอกสารเข้าระบบบัญชี — ไม่บล็อกการออกเอกสาร · แยกจาก `status` และ `sync`
 */
export class ErpDocumentWarningDto {
  @ApiProperty({
    enum: [ERP_DRIVER_NAME_SUBSTITUTED],
    description:
      '`erp_driver_name_substituted` = ระบบบัญชีที่เชื่อมบังคับชื่อคนขับทุกรายการ และเที่ยวของ DO เหล่านี้ไม่มีชื่อคนขับ (เช่น รถร่วม) → ' +
      'ใบนี้จะส่ง**ชื่อบริษัทรถร่วมแทนชื่อคนขับ** (D-64)',
  })
  code!: string;
  @ApiProperty({ example: 'ใบนี้จะส่งชื่อบริษัทรถร่วมแทนชื่อคนขับเข้าระบบบัญชี (2 DO)' })
  message!: string;
  @ApiProperty({ example: 'con_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' }) connectorId!: string;
  @ApiProperty({
    type: [String],
    example: ['DO-00000-6911-0001'],
    description: `เลข DO ที่เกี่ยวข้อง (สูงสุด ${MAX_DO_NOS})`,
  })
  deliveryOrderNos!: string[];
}

export const ERP_WARNINGS_DOC =
  'D-64 (ST8-T08) คำเตือนก่อนส่งใบนี้เข้าระบบบัญชีที่เชื่อมต่อ (ร่าง/ออกแล้ว — ไม่บล็อกการออกเอกสาร) · ไม่เชื่อมระบบบัญชี / ไม่เปิดส่งใบแจ้งหนี้ / ยกเลิกแล้ว / วันที่ก่อนวันเริ่มซิงก์ = `[]` · ส่งสำเร็จแล้ว = ข้อความแบบอดีต · ' +
  'มีเฉพาะ `GET /{id}`';

/**
 * คำเตือนของเอกสารต่อ connector ที่ใบนี้จะถูกส่งไป (ST8-T08; D-64) — adapter ประกาศค่าแทนที่ใน `fieldSubstitutions`
 * core ไม่รู้จัก adapter ใด: ดูแค่ connector ของนิติบุคคลผู้ออก (routing เดียวกับตอนส่ง) + `pushInvoice` เปิดอยู่ + ค่าที่ adapter ประกาศ
 */
@Injectable()
export class ErpDocumentWarningsService {
  constructor(
    private readonly db: DbService,
    private readonly resolver: ConnectorResolver,
  ) {}

  async invoiceWarnings(invoiceId: string, tx: Tx = this.db.tx): Promise<ErpDocumentWarningDto[]> {
    const inv = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { status: true, issuingCompanyId: true, issuingBranchId: true, issueDate: true },
    });
    if (!inv || inv.status === 'CANCELLED') return [];
    const r = await this.resolver.forCompany(tx, inv.issuingCompanyId, inv.issuingBranchId);
    if (r.standalone || !r.connector || !r.adapter || !r.capabilities.includes('pushInvoice'))
      return [];
    const subs = r.adapter.fieldSubstitutions ?? [];
    if (!subs.includes('trip.driverName→trip.carrierName')) return [];
    // ใบที่วันที่ก่อนวันเริ่มซิงก์ไม่ถูกส่ง (ST7-T16) = ไม่มีอะไรจะเตือน
    const from = r.connector.syncFromDate?.toISOString().slice(0, 10);
    const issued = inv.issueDate?.toISOString().slice(0, 10);
    if (from && issued && issued < from) return [];
    const lines = await tx.invoiceLine.findMany({
      where: {
        invoiceId,
        active: true,
        deliveryOrder: { trip: { carrierNameSnapshot: { not: null } } },
      },
      orderBy: { lineNo: 'asc' },
      select: {
        deliveryOrder: {
          select: {
            doNo: true,
            trip: { select: { driverNameSnapshot: true, carrierNameSnapshot: true } },
          },
        },
      },
    });
    // ไม่มีชื่อคนขับ (null / ว่าง / ช่องว่างล้วน) แต่มีชื่อรถร่วม — ตรงกับเงื่อนไขใช้ค่าแทนของ adapter (review L1)
    const doNos = [
      ...new Set(
        lines
          .filter(
            (l) =>
              !l.deliveryOrder?.trip?.driverNameSnapshot?.trim() &&
              !!l.deliveryOrder?.trip?.carrierNameSnapshot?.trim(),
          )
          .map((l) => l.deliveryOrder?.doNo)
          .filter((n): n is string => !!n),
      ),
    ];
    if (!doNos.length) return [];
    // ส่งสำเร็จแล้ว = แจ้งเป็นอดีต (review L1)
    const synced = await tx.externalMapping.findFirst({
      where: {
        connectorId: r.connector.id,
        entityType: 'INVOICE',
        localId: invoiceId,
        status: 'SYNCED',
      },
      select: { id: true },
    });
    return [
      {
        code: ERP_DRIVER_NAME_SUBSTITUTED,
        message: synced
          ? `ใบนี้ส่งชื่อบริษัทรถร่วมแทนชื่อคนขับเข้าระบบบัญชีแล้ว (${doNos.length} DO)`
          : `ใบนี้จะส่งชื่อบริษัทรถร่วมแทนชื่อคนขับเข้าระบบบัญชี (${doNos.length} DO)`,
        connectorId: encodeId('connector', r.connector.id),
        deliveryOrderNos: doNos.slice(0, MAX_DO_NOS),
      },
    ];
  }
}
