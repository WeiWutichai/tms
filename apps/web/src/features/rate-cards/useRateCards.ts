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
export type RateSide = RateCard['side'];
export type RecentPrice = Schemas['CarrierRecentPriceDto'];

/**
 * ชื่อ field ราคาตามฝั่ง (API: ขาขาย `sell*` / ขาซื้อ `buy*` — ตัดตามสิทธิ์ `prices.{sell|buy}:read`)
 * ใช้ทั้งอ่านจาก response และสร้าง body
 */
export const PX = {
  SELL: {
    rate: 'sellRate',
    min: 'sellMinCharge',
    ex: 'sellExtraStopRate',
    acc: 'sellPrice',
    read: 'prices.sell:read',
    write: 'prices.sell:write',
  },
  BUY: {
    rate: 'buyRate',
    min: 'buyMinCharge',
    ex: 'buyExtraStopRate',
    acc: 'buyPrice',
    read: 'prices.buy:read',
    write: 'prices.buy:write',
  },
} as const;

type Priced = Record<string, unknown> & { side: RateSide };
/** ราคาต่อหน่วย / ขั้นต่ำ / ค่าจุดเพิ่มของ rate ตามฝั่ง (undefined = ไม่มีสิทธิ์เห็น) */
export const priceOf = (r: RateCard, k: 'rate' | 'min' | 'ex') =>
  (r as unknown as Priced)[PX[r.side][k]] as string | null | undefined;
export const accPriceOf = (side: RateSide, a: RateCard['accessorials'][number]) =>
  (a as unknown as Record<string, string | undefined>)[PX[side].acc];
/** คู่สัญญา: ลูกค้า (ขาขาย) / ผู้รับเหมา (ขาซื้อ) */
export const partyOf = (r: RateCard) => r.customer ?? r.carrier;

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
  /** ขาซื้อ: ผู้รับเหมาจากลิงก์ "ดู rate ขาซื้อ" */
  carrierId: string;
  party: string;
  /** เส้นทางจากตัวกรองคอลัมน์ (`originId>destinationId`) */
  route: string;
  vehicleTypeId: string;
  pricingModel: string;
}

export function useRateList(filters: RateFilters, side: RateSide = 'SELL') {
  const { route, customerId, carrierId, ...rest } = filters;
  const [originId = '', destinationId = ''] = route ? route.split('>') : [];
  return useCursorList<RateCard>(
    KEY,
    {
      side,
      ...rest,
      ...(side === 'SELL' ? { customerId } : { carrierId }),
      originId,
      destinationId,
    },
    (query) => unwrap(api.GET('/v1/rate-cards', { params: { query: query as never } })),
    { persist: side === 'SELL' ? 'rate-cards' : 'rate-cards-buy' },
  );
}

export function useRateSummary(customerId?: string, side: RateSide = 'SELL') {
  return useQuery({
    queryKey: [KEY, 'summary', side, customerId ?? ''],
    queryFn: () =>
      unwrap(
        api.GET('/v1/rate-cards/summary', {
          params: { query: { side, ...(customerId ? { customerId } : {}) } },
        }),
      ),
  });
}

/** ราคา 5 ครั้งล่าสุดที่จ้างผู้รับเหมารายนี้ (ต้องมี `prices.buy:read`) — ยังไม่เคยจ้าง = [] */
export function useRecentPrices(carrierId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, 'recent', carrierId ?? ''],
    enabled: enabled && !!carrierId,
    queryFn: () =>
      unwrap(api.GET('/v1/carriers/{id}/recent-prices', { params: { path: { id: carrierId! } } })),
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

/** ตัวเลือกผู้รับเหมา (ใช้งาน) ค้นด้วย `q` ทีละ 20 — rate ขาซื้อ */
export async function searchCarriers(q: string): Promise<RefOption[]> {
  const r = await unwrap(
    api.GET('/v1/carriers', {
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
