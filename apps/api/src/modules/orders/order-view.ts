import type { SalesOrder, SalesOrderStop } from '@prisma/client';
import { formatOrderSource, type OrderSource } from '@tms/domain';
import { encodeId } from '../../common/ids';

/**
 * มุมมองของ SO สำหรับ audit / domain_event (ใช้เป็น webhook payload ภายหลัง — ST7) — id เป็น public id
 * **ไม่มีราคา** (เหมือน rate card `eventView`): ผู้รับ webhook/ประวัติอาจไม่มีสิทธิ์ราคาขาย — ราคาอยู่ใน response ของ API (T03)
 */
export function orderEventView(
  o: SalesOrder & {
    stops?: SalesOrderStop[];
    holdReasonCode?: { code: string } | null;
  },
): Record<string, unknown> {
  return {
    id: encodeId('salesOrder', o.id),
    soNo: o.soNo,
    source: formatOrderSource({ source: o.source as OrderSource, connector: o.sourceConnector }),
    externalId: o.externalId,
    status: o.status,
    holdReason: o.holdReasonCode?.code ?? null,
    customerId: o.customerId ? encodeId('customer', o.customerId) : null,
    customerExternalId: o.customerExternalId,
    customerText: o.customerText,
    billingCompanyId: encodeId('company', o.billingCompanyId),
    customerRef: o.customerRef,
    requestedDate: o.requestedDate.toISOString().slice(0, 10),
    vehicleTypeId: o.vehicleTypeId ? encodeId('vehicleType', o.vehicleTypeId) : null,
    pricingStatus: o.pricingStatus,
    stops: (o.stops ?? []).map((s) => ({
      sequence: s.sequence,
      type: s.type,
      siteId: s.siteId ? encodeId('site', s.siteId) : null,
      siteText: s.siteText,
      windowStart: s.windowStart?.toISOString() ?? null,
      windowEnd: s.windowEnd?.toISOString() ?? null,
    })),
    version: o.version,
  };
}
