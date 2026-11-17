import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, unwrap } from '../../api';

export type FieldCharge = Schemas['FieldChargeDto'];
export type FieldChargeBody = Schemas['CreateFieldChargeDto'];
export type FieldChargeSide = FieldChargeBody['side'];
export type FieldChargeAction = 'confirm' | 'reject' | 'cancel';
export type ServiceItemOption = Schemas['ServiceItemDto'];

/** ไฟล์ใบเสร็จที่ API รับ (POST /v1/documents kind RECEIPT) — 10 MB/ไฟล์ (docs/04 I) */
export const RECEIPT_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
/** เที่ยวที่บันทึกค่าใช้จ่ายหน้างานได้ (ตรงกับ API FIELD_CHARGE_TRIP_STATUSES) */
export const FIELD_CHARGE_TRIP = new Set(['DISPATCHED', 'IN_PROGRESS', 'COMPLETED']);

const key = (tripId: string) => ['trip', tripId, 'field-charges'] as const;

/** ค่าใช้จ่ายหน้างานของเที่ยว (ST4-T13 — GET /v1/trips/{id}/field-charges) */
export function useFieldCharges(tripId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(tripId),
    enabled,
    staleTime: 0,
    queryFn: async () =>
      (await unwrap(api.GET('/v1/trips/{id}/field-charges', { params: { path: { id: tripId } } })))
        .data,
  });
}

/** ตัวเลือก "รายการ" = ค่าบริการเสริมที่ใช้งานอยู่ คิดเป็นบาท (ไม่ใช่ % ของค่าขนส่ง) — API ตรวจซ้ำ */
export function useFieldChargeItems(enabled: boolean) {
  const q = useQuery({
    queryKey: ['service-items', 'options'],
    enabled,
    queryFn: () =>
      unwrap(api.GET('/v1/service-items', { params: { query: { status: 'active', limit: 200 } } })),
  });
  return (q.data?.data ?? []).filter((s) => s.isSurcharge && s.calcUnit !== 'PERCENT_OF_FREIGHT');
}

/** รายการใช้กับฝั่งไหนได้ (SELL/BUY/BOTH ของ catalog) */
export function itemAllows(item: Pick<ServiceItemOption, 'side'>, side: FieldChargeSide): boolean {
  if (item.side === 'BOTH') return true;
  return side !== 'BOTH' && item.side === side;
}

export function useCreateFieldCharge(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FieldChargeBody) =>
      unwrap(api.POST('/v1/trips/{id}/field-charges', { params: { path: { id: tripId } }, body })),
    onSettled: () => void qc.invalidateQueries({ queryKey: key(tripId) }),
  });
}

/** ยืนยัน / ปฏิเสธ / ยกเลิก (เหตุผล ≥ 10) — If-Match = version ที่เห็น */
export function useDecideFieldCharge(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { line: FieldCharge; action: FieldChargeAction; reason: string }) => {
      const opts = {
        params: { path: { id: v.line.id } },
        headers: { 'If-Match': `"${v.line.version}"` },
        body: { reason: v.reason },
      };
      if (v.line.side === 'SELL') {
        if (v.action === 'confirm') return unwrap(api.POST('/v1/do-surcharges/{id}/confirm', opts));
        if (v.action === 'reject') return unwrap(api.POST('/v1/do-surcharges/{id}/reject', opts));
        return unwrap(api.POST('/v1/do-surcharges/{id}/cancel', opts));
      }
      if (v.action === 'confirm') return unwrap(api.POST('/v1/trip-costs/{id}/confirm', opts));
      if (v.action === 'reject') return unwrap(api.POST('/v1/trip-costs/{id}/reject', opts));
      return unwrap(api.POST('/v1/trip-costs/{id}/cancel', opts));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key(tripId) }),
  });
}

/** อัปโหลดใบเสร็จ 1 ไฟล์ (จอง → PUT เนื้อไฟล์) คืน doc id — ชนิด/ขนาดผิด → Error('bad_file') */
export async function uploadReceipt(f: Blob, name: string): Promise<string> {
  const mime = RECEIPT_MIME.find((m) => m === f.type);
  if (!mime || f.size === 0 || f.size > RECEIPT_MAX_BYTES) throw new Error('bad_file');
  const doc = await unwrap(
    api.POST('/v1/documents', { body: { kind: 'RECEIPT', mime, bytes: f.size, filename: name } }),
  );
  const u = new URL(doc.uploadUrl!, location.origin);
  const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
  if (!up.ok) throw new ApiError((await up.json()) as never);
  return doc.id;
}

/** "1,234.50" / "1234.5" → "1234.50" (สตริงเงิน 2 ตำแหน่ง) · ผิดรูป/ติดลบ → null — ไม่ใช้ float */
export function moneyInput(raw: string): string | null {
  const s = raw.replace(/,/g, '').trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return `${BigInt(i!).toString()}.${(f + '00').slice(0, 2)}`;
}

/** ผลรวมสตริงเงิน (สตางค์ bigint) → "1,234.50" */
export function sumMoney(values: (string | null | undefined)[]): string {
  let total = 0n;
  for (const v of values) {
    if (!v) continue;
    const [i, f = ''] = v.split('.');
    total += BigInt(i!) * 100n + BigInt((f + '00').slice(0, 2));
  }
  return fmtSatang(total);
}

export function fmtMoney(v: string): string {
  const [i, f = ''] = v.split('.');
  return fmtSatang(BigInt(i!) * 100n + BigInt((f + '00').slice(0, 2)));
}

function fmtSatang(s: bigint): string {
  const whole = (s / 100n).toLocaleString('en-US');
  return `${whole}.${(s % 100n).toString().padStart(2, '0')}`;
}

/** บรรทัดที่นับในยอดรวม (ยังรอ/ยืนยันแล้ว) */
export const counts = (l: Pick<FieldCharge, 'status'>) =>
  l.status === 'PENDING_CONFIRM' || l.status === 'CONFIRMED';
