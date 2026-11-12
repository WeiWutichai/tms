import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import type { RefOption } from '../master/RefPicker';
import { refetchOnStale } from '../master/problems';
import { useCursorList } from '../master/useCursorList';

export type RateCard = Schemas['RateCardDto'];
export type RateCardCreate = Schemas['CreateRateCardDto'];
export type RateCardInput = Schemas['UpdateRateCardDto'];
export type RateCardRevise = Schemas['ReviseRateCardDto'];
export type RateStatus = RateCard['status'];
export type PricingModel = NonNullable<RateCardCreate['pricingModel']>;

/** สูตรราคาเฟส 0 (docs/04 B1) — ลำดับตามต้นแบบ (เหมาเที่ยว ต่อกม. ต่อตัน) + ต่อ ลบ.ม./ต่อหน่วย (B1) · เหมาวัน = P1 */
export const PRICING_MODELS: PricingModel[] = [
  'PER_TRIP',
  'PER_KM',
  'PER_TON',
  'PER_CBM',
  'PER_UNIT',
];

const KEY = 'rate-cards';

export interface RateFilters {
  /** แท็บ/ตัวกรองสถานะ (active, draft, expired) */
  status: string;
  nearExpiry: string;
  customerId: string;
  party: string;
  /** เส้นทางจากตัวกรองคอลัมน์ (`originId>destinationId`) */
  route: string;
  vehicleTypeId: string;
  pricingModel: string;
}

export function useRateList(filters: RateFilters) {
  const { route, ...rest } = filters;
  const [originId = '', destinationId = ''] = route ? route.split('>') : [];
  return useCursorList<RateCard>(
    KEY,
    { side: 'SELL', ...rest, originId, destinationId },
    (query) => unwrap(api.GET('/v1/rate-cards', { params: { query: query as never } })),
    { persist: 'rate-cards' },
  );
}

export function useRateSummary(customerId?: string) {
  return useQuery({
    queryKey: [KEY, 'summary', customerId ?? ''],
    queryFn: () =>
      unwrap(
        api.GET('/v1/rate-cards/summary', {
          params: { query: { side: 'SELL', ...(customerId ? { customerId } : {}) } },
        }),
      ),
  });
}

/** rate ของลูกค้ารายเดียว (แท็บ Rate card ใน drawer ลูกค้า) — ไม่รวมที่ยกเลิก */
export function useCustomerRates(customerId: string) {
  return useQuery({
    queryKey: [KEY, 'customer', customerId],
    queryFn: () =>
      unwrap(
        api.GET('/v1/rate-cards', {
          params: {
            query: {
              side: 'SELL',
              customerId,
              status: 'draft,pending_approval,active,expired',
              limit: 50,
            },
          },
        }),
      ),
  });
}

/** ตัวเลือกลูกค้า (ใช้งาน) ค้นด้วย `q` ทีละ 20 */
export async function searchCustomers(q: string): Promise<RefOption[]> {
  const r = await unwrap(
    api.GET('/v1/customers', {
      params: { query: { status: 'active', limit: 20, ...(q ? { q } : {}) } },
    }),
  );
  return r.data.map((c) => ({ id: c.id, label: c.legalName, sub: c.code }));
}

/** ตัวเลือกเส้นทาง (ใช้งาน) — id = `originId>destinationId` (key ของ rate คือคู่สถานที่) */
export async function searchRoutes(q: string): Promise<RefOption[]> {
  const r = await unwrap(
    api.GET('/v1/routes', {
      params: { query: { status: 'active', limit: 20, ...(q ? { q } : {}) } },
    }),
  );
  return r.data.map((x) => ({
    id: `${x.origin.id}>${x.destination.id}`,
    label: `${x.origin.name} → ${x.destination.name}`,
    sub: x.code,
  }));
}

/** ตัวเลือกคงที่ในฟอร์ม/ตัวกรอง: ประเภทรถ หน่วยนับ ค่าบริการเสริม เส้นทาง (โหลดครั้งเดียว) */
export function useRateOptions() {
  const vt = useQuery({
    queryKey: ['vehicle-types', 'options'],
    queryFn: () =>
      unwrap(api.GET('/v1/vehicle-types', { params: { query: { status: 'active', limit: 200 } } })),
  });
  const units = useQuery({
    queryKey: ['units', 'options', 'COUNT'],
    queryFn: () =>
      unwrap(
        api.GET('/v1/units', {
          params: { query: { status: 'active', kind: 'COUNT', limit: 200 } },
        }),
      ),
  });
  const svc = useQuery({
    queryKey: ['service-items', 'options'],
    queryFn: () =>
      unwrap(api.GET('/v1/service-items', { params: { query: { status: 'active', limit: 200 } } })),
  });
  const routes = useQuery({
    queryKey: ['routes', 'options'],
    queryFn: () =>
      unwrap(api.GET('/v1/routes', { params: { query: { status: 'active', limit: 200 } } })),
  });
  return {
    vehicleTypes: vt.data?.data ?? [],
    units: units.data?.data ?? [],
    serviceItems: svc.data?.data ?? [],
    routes: routes.data?.data ?? [],
  };
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: [KEY] });
  qc.invalidateQueries({ queryKey: ['history'] });
  qc.invalidateQueries({ queryKey: ['vehicle-types'] });
};

export function useCreateRate() {
  const qc = useQueryClient();
  return useMutation({
    /** idempotencyKey ต่อการเปิดฟอร์ม 1 ครั้ง — กดซ้ำได้รายการเดียว */
    mutationFn: (v: { body: RateCardCreate; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/rate-cards', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: RateCardInput }) =>
      unwrap(
        api.PATCH('/v1/rate-cards/{id}', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => invalidate(qc),
  });
}

export function useReviseRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: RateCardRevise }) =>
      unwrap(
        api.POST('/v1/rate-cards/{id}/revise', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => invalidate(qc),
  });
}

export function useRateAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'approve' | 'cancel' | 'delete';
      reason: string;
    }): Promise<RateCard | null> => {
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
        body: { reason: v.reason },
      };
      if (v.action === 'approve') return unwrap(api.POST('/v1/rate-cards/{id}/approve', p));
      if (v.action === 'cancel') return unwrap(api.POST('/v1/rate-cards/{id}/cancel', p));
      await unwrap(api.POST('/v1/rate-cards/{id}/delete', p));
      return null;
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => invalidate(qc),
  });
}
