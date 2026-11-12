import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';

export type MessageDelivery = Schemas['MessageDeliveryDto'];
export type ChannelKey = MessageDelivery['channel'];

const CHANNELS = 'message-channels';

/**
 * เบอร์มือถือไทยที่ส่ง SMS ได้ — สูตรเดียวกับ API (`phoneNorm` + มือถือ 06/08/09 สิบหลัก)
 * ตัดทุกอย่างที่ไม่ใช่ตัวเลข, +66 → 0 (+66 ตามด้วย 0 ซ้ำ → ตัด 0 ที่เกิน)
 */
export function isSmsMobile(phone: string | null | undefined): boolean {
  let d = (phone ?? '').replace(/\D/g, '');
  if (d.startsWith('66') && d.length >= 10)
    d = d.slice(2).startsWith('0') ? d.slice(2) : `0${d.slice(2)}`;
  return /^0[689]\d{8}$/.test(d);
}
const LOG = 'message-log';

/** ช่องทางที่ส่งได้ตอนนี้ (ST3-T21) — ใช้ไม่ได้ = ซ่อนปุ่มส่ง เหลือคัดลอกลิงก์ */
export function useMessageChannels() {
  return useQuery({
    queryKey: [CHANNELS],
    queryFn: () => unwrap(api.GET('/v1/messages/channels')),
    select: (r) => new Set(r.data.filter((c) => c.available).map((c) => c.channel)),
    staleTime: 60_000,
  });
}

/** บันทึกการส่งถึงผู้รับเหมา (ใหม่ก่อน) — มีรายการรอส่งอยู่ = โหลดซ้ำทุก 3 วิ จนจบ */
export function useCarrierMessages(carrierId: string) {
  return useQuery({
    queryKey: [LOG, carrierId],
    queryFn: () => unwrap(api.GET('/v1/messages', { params: { query: { carrierId, limit: 5 } } })),
    select: (r) => r.data,
    refetchInterval: (q) =>
      q.state.data?.data.some((m) => m.status === 'queued' || m.status === 'sending')
        ? 3000
        : false,
  });
}

export function useSendLink(carrierId: string) {
  const qc = useQueryClient();
  return useMutation({
    /** key ต่อการกด 1 ครั้ง — เน็ตช้าแล้วส่งซ้ำด้วย key เดิมได้ข้อความเดียว */
    mutationFn: (v: { channel: ChannelKey; url: string; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/messages/send-link', {
          body: { channel: v.channel, url: v.url },
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [LOG, carrierId] }),
  });
}
