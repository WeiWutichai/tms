import type { Schemas } from '@tms/contracts';
import { useMutation, useQueryClient, useQueries } from '@tanstack/react-query';
import { api, ApiError, unwrap } from '../../api';

export type DoPod = Schemas['DeliveryOrderPodDto'];
export type PodBody = Schemas['SubmitPodDto'];
export type PodDoc = Schemas['PodDocumentDto'];
export type PodMissing = Schemas['PodMissingDto'];
export type PodChecklistField = DoPod['checklist']['fields'][number];

/** ชนิดไฟล์ที่ API รับต่อช่อง (ST4-T07 — ตรงกับ PodService) */
export const POD_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const POD_FILE_MIME = ['application/pdf', ...POD_IMAGE_MIME] as const;
/** docs/04 I 10 MB/ไฟล์ (ขนาดเดียวกับ /v1/documents) · เพดานจำนวนต่อฉบับตาม API */
export const POD_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const POD_PHOTOS_MAX = 20;
export const POD_FILES_MAX = 10;
export const POD_REASON_MIN = 10;

const key = (doId: string) => ['delivery-order', doId, 'pod'] as const;

/** หลักฐานส่งของหลาย DO (ทุก DO ในเที่ยว) — GET /v1/delivery-orders/{id}/pod */
export function useDoPods(doIds: string[], enabled: boolean) {
  return useQueries({
    queries: doIds.map((id) => ({
      queryKey: key(id),
      enabled,
      staleTime: 0,
      queryFn: () => unwrap(api.GET('/v1/delivery-orders/{id}/pod', { params: { path: { id } } })),
    })),
  });
}

/** บันทึกฉบับใหม่ (If-Match = เลขฉบับที่เห็น) → โหลดเที่ยว/DO ใหม่ (สถานะ DO เปลี่ยน) */
export function useSavePod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { doId: string; version: number; body: PodBody }) =>
      unwrap(
        api.PUT('/v1/delivery-orders/{id}/pod', {
          params: { path: { id: v.doId } },
          headers: { 'If-Match': `"${v.version}"` },
          body: v.body,
        }),
      ),
    onSuccess: (data, v) => {
      qc.setQueryData(key(v.doId), data);
      void qc.invalidateQueries({ queryKey: ['trip'] });
      void qc.invalidateQueries({ queryKey: ['delivery-orders'] });
    },
    onError: (_e, v) => void qc.invalidateQueries({ queryKey: key(v.doId) }),
  });
}

export type PodUploadKind = 'POD_PHOTO' | 'POD_SIGNATURE' | 'POD_FILE';

/** อัปโหลดไฟล์ 1 ไฟล์ (จอง → PUT เนื้อไฟล์) คืนข้อมูลเอกสาร — ชนิด/ขนาดผิด → Error('bad_file') */
export async function uploadPodFile(f: Blob, kind: PodUploadKind, name: string): Promise<PodDoc> {
  const allowed: readonly string[] = kind === 'POD_FILE' ? POD_FILE_MIME : POD_IMAGE_MIME;
  const mime = allowed.find((m) => m === f.type) as (typeof POD_FILE_MIME)[number] | undefined;
  if (!mime || f.size > POD_FILE_MAX_BYTES || f.size === 0) throw new Error('bad_file');
  const doc = await unwrap(
    api.POST('/v1/documents', { body: { kind, mime, bytes: f.size, filename: name } }),
  );
  const u = new URL(doc.uploadUrl!, location.origin);
  const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
  if (!up.ok) throw new ApiError((await up.json()) as never);
  return {
    id: doc.id,
    kind,
    mime,
    bytes: f.size,
    filename: name,
    createdAt: doc.createdAt,
  };
}

/** body ทั้งฉบับจากฉบับปัจจุบัน (ช่องที่ไม่ได้แก้คงเดิม) — PIN เดิมอ่านไม่ได้ (ปิดบัง) จึงต้องกรอกใหม่ถ้าต้องการ */
export function bodyFromCurrent(cur: DoPod['current']): PodBody {
  if (!cur) return {};
  return {
    receiverName: cur.receiverName,
    receiverRelation: cur.receiverRelation as PodBody['receiverRelation'],
    signatureDocumentId: cur.signature?.id ?? null,
    photoDocumentIds: cur.photos.map((p) => p.id),
    fileDocumentIds: cur.files.map((p) => p.id),
    weighedKg: cur.weighedKg,
    customerRef: cur.customerRef,
    note: cur.note,
    checks: cur.checks,
    choices: cur.choices,
    barcodes: cur.barcodes,
    rating: cur.rating,
  };
}

/** น้ำหนักชั่ง − น้ำหนักตามใบสั่ง (กก.) — ทศนิยม 3 ตำแหน่งแบบจำนวนเต็มหน่วยพัน (ไม่ใช้ float สะสม) */
export function weightDiff(weighed: string, planned: string | null): string | null {
  const re = /^\d{1,11}(\.\d{1,3})?$/;
  if (!planned || !re.test(weighed) || !re.test(planned)) return null;
  const milli = (s: string) => {
    const [i, f = ''] = s.split('.');
    return BigInt(i!) * 1000n + BigInt(f.padEnd(3, '0'));
  };
  const d = milli(weighed) - milli(planned);
  const neg = d < 0n;
  const a = neg ? -d : d;
  const int = (a / 1000n).toLocaleString('en-US');
  const frac = (a % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}
