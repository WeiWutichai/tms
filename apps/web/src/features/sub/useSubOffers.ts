import type { Schemas } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';

export type SubOfferRow = Schemas['SubconOfferRowDto'];
export type SubOfferSummary = Schemas['SubconOfferSummaryDto'];

/** key ร่วมกับ drawer เที่ยว (`trip`) ไม่ได้ — แยก key แล้ว invalidate เมื่อ drawer ปิด */
export const SUB_KEY = 'subcon-offers';

export function useSubOfferList(filters: Record<string, string>, enabled = true) {
  return useCursorList<SubOfferRow>(
    SUB_KEY,
    filters,
    (query) => unwrap(api.GET('/v1/subcon-offers', { params: { query: query as never } })),
    { sort: '-updatedAt', enabled },
  );
}

export function useSubOfferSummary() {
  return useQuery({
    queryKey: [SUB_KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/subcon-offers/summary')),
  });
}

/** ลิงก์ที่ใช้ได้ของการจ้างปัจจุบันของเที่ยว — รับงานแล้ว = ลิงก์งาน (ST4-T08) · ไม่มี = null */
export async function currentLink(tripId: string) {
  const l = await unwrap(
    api.GET('/v1/trips/{id}/offer-link', { params: { path: { id: tripId } } }),
  );
  return { url: l.podLink?.url ?? l.link?.url ?? null, line: !!l.channels.line };
}

/** ส่งลิงก์ข้อเสนอซ้ำทาง LINE (ST3-T21 `/messages/send-link`) — คืน false เมื่อส่งทาง LINE ไม่ได้ */
export async function resendLine(tripId: string): Promise<boolean> {
  const l = await currentLink(tripId);
  if (!l.url || !l.line) return false;
  await idempotent(() =>
    api.POST('/v1/messages/send-link', {
      body: { channel: 'line', url: l.url! },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    }),
  );
  return true;
}
