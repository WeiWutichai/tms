import type { DoStatus } from '@tms/domain';
import { encodeId } from '../../common/ids';
import type { DeliveryOrderDto } from './delivery-order.dto';
import type { DeliveryOrderRecord, RejectionLine } from './delivery-order.service';

/** DTO ของ DO (ย้ายจาก controller — ST7-T06): `GET /v1/delivery-orders/{id}` และ `data.object` ของ `delivery_order.status_changed` */
const dec = (v: { toFixed: (n: number) => string } | null) =>
  v === null ? null : v.toFixed(3).replace(/\.?0+$/, '') || '0';

/**
 * DTO ของ DO — `balance` (ST4-T11) = ยอดปฏิเสธรับที่ส่งซ้ำ/คืนคลัง/คงเหลือต่อบรรทัด (`DeliveryOrderService.rejectionBalance`)
 * ไม่ส่ง = ส่งซ้ำ 0 (ใช้เฉพาะที่ไม่มีใบลูก เช่น ใบเพิ่งสร้าง)
 */
export function toDeliveryOrderDto(
  d: DeliveryOrderRecord,
  balance?: RejectionLine[],
): DeliveryOrderDto {
  const bal = new Map((balance ?? []).map((b) => [b.line.id, b]));
  return {
    id: encodeId('deliveryOrder', d.id),
    doNo: d.doNo!,
    status: d.status as DoStatus,
    orderId: encodeId('salesOrder', d.salesOrderId),
    customerId: encodeId('customer', d.customerId),
    doDate: d.doDate.toISOString().slice(0, 10),
    originSiteId: encodeId('site', d.originSiteId),
    destSiteId: encodeId('site', d.destSiteId),
    originStopSeq: d.originStopSeq,
    destStopSeq: d.destStopSeq,
    tripId: d.tripId ? encodeId('trip', d.tripId) : null,
    // ST9-T01 ชื่อสำหรับแสดงในรายการ (ลูกค้า/จุด/เที่ยว — รถ คนขับ รถร่วมเป็น snapshot ของเที่ยว)
    customerName: d.customer.legalName,
    originSiteName: d.originSite.name,
    destSiteName: d.destSite.name,
    tripNo: d.trip?.tripNo ?? null,
    vehiclePlate: d.trip?.vehiclePlateSnapshot ?? null,
    driverName: d.trip?.driverNameSnapshot ?? null,
    carrierName: d.trip?.carrierNameSnapshot ?? null,
    weightKg: dec(d.weightKg),
    cbm: dec(d.cbm),
    customerRef: d.customerRef,
    splitFromId: d.splitFromId ? encodeId('deliveryOrder', d.splitFromId) : null,
    splitIndex: d.splitIndex,
    redeliveryOfId: d.redeliveryOfId ? encodeId('deliveryOrder', d.redeliveryOfId) : null,
    rescheduleCount: d.rescheduleCount,
    redeliveryManual: d.redeliveryManual,
    rejectedFromId: d.rejectedFromId ? encodeId('deliveryOrder', d.rejectedFromId) : null,
    podStatus: d.podStatus,
    releasedAt: d.releasedAt?.toISOString() ?? null,
    lines: d.lines.map((l) => ({
      lineNo: l.lineNo,
      soLineNo: l.soLineNo,
      description: l.description,
      qtyPlanned: dec(l.qtyPlanned)!,
      qtyActual: dec(l.qtyActual),
      rejectQty: dec(l.rejectQty),
      rejectReasonCodeId: l.rejectReasonCodeId
        ? encodeId('reasonCode', l.rejectReasonCodeId)
        : null,
      redeliveredQty: dec(bal.get(l.id)?.redelivered ?? null) ?? '0',
      returnedQty: dec(l.returnedQty)!,
      openRejectQty:
        dec(bal.get(l.id)?.open ?? (l.rejectQty ? l.rejectQty.sub(l.returnedQty) : null)) ?? '0',
      unit: l.unit,
      weightKg: dec(l.weightKg),
      cbm: dec(l.cbm),
    })),
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}
