import type { Schemas } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../api';

/**
 * ลิงก์ "ค่าเที่ยวของฉัน" ของรถร่วม (ST6-T11; docs/04 F7, `/v1/public/carrier-pay/{token}`) — ดูอย่างเดียว
 */
export type PayView = Schemas['CarrierPayLinkViewDto'];
export type PaySettlement = Schemas['CarrierPaySettlementDto'];
export type PayTrip = Schemas['CarrierPayTripDto'];

export function usePayView(token: string) {
  return useQuery({
    queryKey: ['carrier-pay-link', token],
    queryFn: () =>
      unwrap(api.GET('/v1/public/carrier-pay/{token}', { params: { path: { token } } })),
    retry: false,
  });
}

/** ใบจ่ายเงิน (PDF ใบสำคัญจ่าย — ST6-T04) ของงวดที่จ่ายแล้ว · เปิดแท็บใหม่ (token อยู่ใน path) */
export const payVoucherUrl = (token: string, settlementId: string) =>
  `/v1/public/carrier-pay/${encodeURIComponent(token)}/settlements/${encodeURIComponent(settlementId)}/pdf`;
