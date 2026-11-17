import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import type { DeliveryOrder, ReturnAction } from './returnForm';

const key = (id: string) => ['delivery-order', id] as const;

/** ใบส่งของ (ยอดปฏิเสธรับ/ส่งซ้ำ/คืนคลัง + version สำหรับ If-Match) — GET /v1/delivery-orders/{id} */
export function useDeliveryOrder(id: string, enabled: boolean) {
  return useQuery({
    queryKey: key(id),
    enabled,
    staleTime: 0,
    queryFn: () =>
      unwrap(
        api.GET('/v1/delivery-orders/{id}', { params: { path: { id } } }),
      ) as Promise<DeliveryOrder>,
  });
}

/** ส่งซ้ำ / คืนคลัง (ST4-T11) — If-Match = version ที่เห็น → โหลดเที่ยว/หลักฐาน/DO/กระดานใหม่ */
export function useResolveRejection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: ReturnAction;
      body: {
        reasonCodeId: string;
        note: string | null;
        lines?: { lineNo: number; qty: string }[];
      };
    }) => {
      const opts = {
        params: { path: { id: v.id } },
        headers: { 'If-Match': `"${v.version}"` },
        body: v.body,
      };
      if (v.action === 'redeliver') {
        const r = await unwrap(api.POST('/v1/delivery-orders/{id}/redeliver', opts));
        return { source: r.source, redelivery: r.redelivery as DeliveryOrder | null };
      }
      const r = await unwrap(api.POST('/v1/delivery-orders/{id}/return', opts));
      return { source: r, redelivery: null };
    },
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: key(v.id) });
      void qc.invalidateQueries({ queryKey: ['trip'] });
      void qc.invalidateQueries({ queryKey: ['delivery-orders'] });
      void qc.invalidateQueries({ queryKey: ['planning-board'] });
    },
  });
}
