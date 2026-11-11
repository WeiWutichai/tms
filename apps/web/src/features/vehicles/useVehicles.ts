import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, idempotent, unwrap } from '../../api';
import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { refetchOnStale } from '../master/problems';
import type { RefOption } from '../master/RefPicker';
import { useCursorList } from '../master/useCursorList';

export type Vehicle = Schemas['VehicleDto'];
export type VehicleInput = Schemas['UpdateVehicleDto'];
export type VehicleCreate = Schemas['CreateVehicleDto'];
export type VehicleStatus = Vehicle['status'];
export type UnitRole = Vehicle['unitRole'];
export type FuelType = NonNullable<Vehicle['fuelType']>;
export type Province = VehicleCreate['plateProvince'];

export const VEHICLE_STATUSES: VehicleStatus[] = ['ready', 'maintenance', 'parked', 'retired'];
export const UNIT_ROLES: UnitRole[] = ['SINGLE', 'TRACTOR', 'TRAILER'];
export const FUEL_TYPES: FuelType[] = ['DIESEL', 'GASOLINE', 'NGV', 'LPG', 'EV', 'HYBRID'];
/** ค่าย GPS ตามต้นแบบ (select ในฟอร์มรถ) — API รับข้อความใดก็ได้ */
export const GPS_PROVIDERS = ['Cartrack', 'DTC', 'DRIVER_APP'] as const;
/** จังหวัด (ISO 3166-2:TH) — ชื่อ/อักษรย่อใน i18n `prov.*` / `provAbbr.*` (ตรงกับ apps/api/src/modules/vehicles/provinces.ts) */
export const PROVINCES: Province[] = [
  'TH-10',
  'TH-11',
  'TH-12',
  'TH-13',
  'TH-14',
  'TH-15',
  'TH-16',
  'TH-17',
  'TH-18',
  'TH-19',
  'TH-20',
  'TH-21',
  'TH-22',
  'TH-23',
  'TH-24',
  'TH-25',
  'TH-26',
  'TH-27',
  'TH-30',
  'TH-31',
  'TH-32',
  'TH-33',
  'TH-34',
  'TH-35',
  'TH-36',
  'TH-37',
  'TH-38',
  'TH-39',
  'TH-40',
  'TH-41',
  'TH-42',
  'TH-43',
  'TH-44',
  'TH-45',
  'TH-46',
  'TH-47',
  'TH-48',
  'TH-49',
  'TH-50',
  'TH-51',
  'TH-52',
  'TH-53',
  'TH-54',
  'TH-55',
  'TH-56',
  'TH-57',
  'TH-58',
  'TH-60',
  'TH-61',
  'TH-62',
  'TH-63',
  'TH-64',
  'TH-65',
  'TH-66',
  'TH-67',
  'TH-70',
  'TH-71',
  'TH-72',
  'TH-73',
  'TH-74',
  'TH-75',
  'TH-76',
  'TH-77',
  'TH-80',
  'TH-81',
  'TH-82',
  'TH-83',
  'TH-84',
  'TH-85',
  'TH-86',
  'TH-90',
  'TH-91',
  'TH-92',
  'TH-93',
  'TH-94',
  'TH-95',
  'TH-96',
] as Province[];

/** "70-1234 กทม." (ต้นแบบ) */
export const plateText = (t: T, plate: string, province: string) =>
  `${plate} ${t(`provAbbr.${province}` as MessageKey)}`;
export const vehPlate = (t: T, v: { plate: string; plateProvince: string }) =>
  plateText(t, v.plate, v.plateProvince);

const KEY = 'vehicles';

export interface VehicleFilters {
  plate: string;
  vehicleTypeId: string;
  ownership: string;
  status: string;
  /** '' | 'true' (มีเอกสารใกล้หมด) | 'false' (ปกติ) */
  docAlert: string;
}

/** แท็บของทะเบียนรถ (ต้นแบบ specFVeh tabs): ทั้งหมด · สถานะ 4 แบบ · รถร่วม */
export type VehTabKey = 'all' | VehicleStatus | 'sub';
const NOT_RETIRED = 'ready,maintenance,parked';

/**
 * query ของรายการ = แท็บ ∩ ตัวกรองคอลัมน์ — ขัดกันเอง (แท็บ "ซ่อม" + คอลัมน์สถานะ "จอด") → null = ไม่มีแถว
 * แท็บรถร่วม = SUBCONTRACT ที่ไม่ปลดระวาง (ตรงกับตัวนับ summary.subcontract)
 */
export function vehicleQuery(tab: VehTabKey, f: VehicleFilters): Record<string, string> | null {
  const q: Record<string, string> = { ...f };
  if (tab === 'sub') {
    if ((f.ownership && f.ownership !== 'SUBCONTRACT') || f.status === 'retired') return null;
    q.ownership = 'SUBCONTRACT';
    q.status = f.status || NOT_RETIRED;
  } else if (tab !== 'all') {
    if (f.status && f.status !== tab) return null;
    q.status = tab;
  }
  return q;
}

export function useVehicleList(query: Record<string, string> | null) {
  return useCursorList<Vehicle>(
    KEY,
    query ?? {},
    (q) => unwrap(api.GET('/v1/vehicles', { params: { query: q as never } })),
    { sort: 'plate', enabled: query !== null },
  );
}

/** รถคันเดียว (โปรไฟล์รถ ST2-T07) — key ใต้ 'vehicles' จึงโหลดใหม่เมื่อแก้/เปลี่ยนสถานะ */
export function useVehicle(id: string) {
  return useQuery({
    queryKey: [KEY, 'one', id],
    queryFn: () => unwrap(api.GET('/v1/vehicles/{id}', { params: { path: { id } } })),
    retry: (n, e) => !(e instanceof ApiError && e.problem.status === 404) && n < 2,
  });
}

export function useVehicleSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/vehicles/summary')),
  });
}

/** ประเภทรถที่ใช้งาน (ตัวกรองคอลัมน์ + ช่องในฟอร์ม — ต้นแบบเป็น select) */
export function useVehicleTypeOptions() {
  return useQuery({
    queryKey: ['vehicle-types', 'options'],
    queryFn: () =>
      unwrap(api.GET('/v1/vehicle-types', { params: { query: { limit: 200, status: 'active' } } })),
    select: (p) => p.data,
  });
}

/** หัวลาก/หางที่จับคู่ได้ (บทบาทตรงข้าม ยังไม่จับคู่ ไม่ปลดระวาง) สำหรับ RefPicker */
export function searchPairable(q: string, role: UnitRole, t: T, exceptId?: string) {
  const want = role === 'TRACTOR' ? 'TRAILER' : 'TRACTOR';
  return unwrap(
    api.GET('/v1/vehicles', {
      params: {
        query: {
          limit: 20,
          unitRole: want,
          unpaired: 'true',
          status: 'ready,maintenance,parked',
          ...(q ? { q } : {}),
        } as never,
      },
    }),
  ).then((p) =>
    p.data
      .filter((v) => v.id !== exceptId)
      .map((v): RefOption => ({ id: v.id, label: vehPlate(t, v), sub: v.vehicleType.name })),
  );
}

export function useCreateVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: VehicleCreate; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/vehicles', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: VehicleInput }) =>
      unwrap(
        api.PATCH('/v1/vehicles/{id}', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

export function useVehicleAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'status' | 'delete';
      status?: VehicleStatus;
      reason: string;
    }): Promise<Vehicle | null> => {
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'status')
        return unwrap(
          api.POST('/v1/vehicles/{id}/status', {
            ...p,
            body: { status: v.status!, reason: v.reason },
          }),
        );
      await unwrap(api.POST('/v1/vehicles/{id}/delete', { ...p, body: { reason: v.reason } }));
      return null;
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
