import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, unwrap } from '../api';

/**
 * รถร่วมตรวจใบสำคัญจ่ายผ่านลิงก์ (ST6-T05; docs/04 F6 "รถร่วมตรวจผ่านลิงก์", `/v1/public/settlements/{token}`)
 */
export type ReviewView = Schemas['ReviewLinkViewDto'];
export type ReviewLine = Schemas['ReviewLinkLineDto'];
export type ReviewRespondBody = Schemas['ReviewLinkRespondDto'];

/** รูปที่ API รับ + เพดาน 10 MB/ไฟล์ · 6 รูปต่อคำตอบ (ต้นแบบ TMS Subcon "+ เพิ่มรูป" ถึง 6) */
export const REVIEW_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const REVIEW_FILE_MAX = 10 * 1024 * 1024;
export const REVIEW_PHOTOS_MAX = 6;

const key = (token: string) => ['settlement-link', token];

/** ใบจ่ายเงิน (PDF ใบสำคัญจ่าย — ST6-T04) ของงวดที่จ่ายแล้ว · เปิดแท็บใหม่ (token อยู่ใน path) */
export const settlementPdfUrl = (token: string) =>
  `/v1/public/settlements/${encodeURIComponent(token)}/pdf`;

export function useReviewView(token: string) {
  return useQuery({
    queryKey: key(token),
    queryFn: () =>
      unwrap(api.GET('/v1/public/settlements/{token}', { params: { path: { token } } })),
    retry: false,
  });
}

/** ตอบบรรทัด → แทนบรรทัดในข้อมูลที่โหลดไว้ด้วยผลจาก server */
export function useRespond(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { lineId: string; body: ReviewRespondBody }) =>
      unwrap(
        api.POST('/v1/public/settlements/{token}/lines/{lineId}/review', {
          params: { path: { token, lineId: v.lineId } },
          body: v.body,
        }),
      ),
    onSuccess: (r) =>
      qc.setQueryData<ReviewView>(key(token), (old) =>
        old
          ? {
              ...old,
              status: r.status,
              lines: old.lines.map((l) => (l.id === r.line.id ? r.line : l)),
            }
          : old,
      ),
  });
}

/** จองรูปผ่านลิงก์ (ผูกกับบรรทัดนี้) → PUT เนื้อไฟล์ → id · ชนิด/ขนาดผิด → Error('bad_file') */
export async function uploadReviewPhoto(token: string, lineId: string, f: File): Promise<string> {
  const mime = REVIEW_IMAGE_MIME.find((m) => m === f.type);
  if (!mime || f.size > REVIEW_FILE_MAX || f.size === 0) throw new Error('bad_file');
  const r = await unwrap(
    api.POST('/v1/public/settlements/{token}/files', {
      params: { path: { token } },
      body: { lineId, mime, bytes: f.size, filename: f.name || 'photo.jpg' },
    }),
  );
  const u = new URL(r.uploadUrl, location.origin);
  const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
  if (!up.ok) throw new ApiError((await up.json()) as never);
  return r.id;
}

/** สถานะที่แสดงของบรรทัด (ยังไม่ตอบ = PENDING · บริษัทยืนยันยอดเดิมแล้ว = RESOLVED — ST6-T06) */
export const lineState = (l: ReviewLine): 'PENDING' | 'ACCEPTED' | 'DISPUTED' | 'RESOLVED' =>
  l.resolution ? 'RESOLVED' : (l.review?.response ?? 'PENDING');
