import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, idempotent, unwrap } from '../../api';
import type { T } from '../../i18n';
import { refetchOnStale } from '../master/problems';
import type { RefOption } from '../master/RefPicker';
import { useCursorList } from '../master/useCursorList';
import { vehPlate } from '../vehicles/useVehicles';

export type Driver = Schemas['DriverDto'];
export type DriverInput = Schemas['UpdateDriverDto'];
export type DriverCreate = Schemas['CreateDriverDto'];
export type DriverStatus = Driver['status'];
export type EmploymentType = Driver['employmentType'];
export type LicenceClass = NonNullable<Driver['licenceClass']>;

export const DRIVER_STATUSES: DriverStatus[] = ['active', 'on_leave', 'inactive'];
export const EMPLOYMENT_TYPES: EmploymentType[] = [
  'EMPLOYEE_SALARIED',
  'EMPLOYEE_PER_TRIP',
  'CARRIER_DRIVER',
];
export const LICENCE_CLASSES: LicenceClass[] = ['PERSONAL', 'T1', 'T2', 'T3', 'T4'];
/** ป้าย "ใกล้หมดอายุ" ในตาราง/การ์ด = 30 วันตามต้นแบบ (สถานะ API expiring = 60 วัน) */
export const LICENCE_ALERT_DAYS = 30;

const KEY = 'drivers';

export interface DriverFilters {
  name: string;
  employmentType: string;
  licenceClass: string;
  affiliation: string;
  status: string;
  /** '' | 'true' (ใบขับขี่หมด/ใกล้หมดภายใน 30 วัน) */
  licenceAlert: string;
}

/** แท็บสถานะของตาราง (ต้นแบบ: ทั้งหมด · พร้อมใช้ · ระหว่างงาน · ลาพัก — "ระหว่างงาน" ต้องมีเที่ยว ST3) */
export type DrvTabKey = 'all' | DriverStatus;

/** query = แท็บ ∩ ตัวกรองคอลัมน์ — ขัดกันเอง (แท็บ "ลาพัก" + คอลัมน์ "พร้อมใช้") → null = ไม่มีแถว */
export function driverQuery(tab: DrvTabKey, f: DriverFilters): Record<string, string> | null {
  const q: Record<string, string> = { ...f };
  if (tab !== 'all') {
    if (f.status && f.status !== tab) return null;
    q.status = tab;
  }
  return q;
}

export function useDriverList(query: Record<string, string> | null) {
  return useCursorList<Driver>(
    KEY,
    query ?? {},
    (q) => unwrap(api.GET('/v1/drivers', { params: { query: q as never } })),
    { enabled: query !== null, persist: 'tms.drv.page' },
  );
}

export function useDriverSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/drivers/summary')),
  });
}

/** รถที่เป็นรถประจำได้: ไม่ปลดระวาง ไม่ใช่หาง · คนขับรถร่วม = รถของผู้รับเหมานั้น · คนขับบริษัท = รถบริษัท */
export function searchDefaultVehicles(
  q: string,
  t: T,
  type: EmploymentType,
  carrierId: string | null,
) {
  return unwrap(
    api.GET('/v1/vehicles', {
      params: {
        query: {
          limit: 20,
          status: 'ready,maintenance,parked',
          ...(type === 'CARRIER_DRIVER'
            ? { ownership: 'SUBCONTRACT', ...(carrierId ? { carrierId } : {}) }
            : { ownership: 'OWN' }),
          ...(q ? { q } : {}),
        } as never,
      },
    }),
  ).then((p) =>
    p.data
      .filter((v) => v.unitRole !== 'TRAILER')
      .map((v): RefOption => ({ id: v.id, label: vehPlate(t, v), sub: v.vehicleType.name })),
  );
}

export function useCreateDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: DriverCreate; idempotencyKey: string }) =>
      idempotent(() =>
        api.POST('/v1/drivers', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['carriers'] });
    },
  });
}

export function useUpdateDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: DriverInput }) =>
      unwrap(
        api.PATCH('/v1/drivers/{id}', {
          params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['carriers'] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

export function useDriverAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'status' | 'delete';
      status?: DriverStatus;
      reason: string;
    }): Promise<Driver | null> => {
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'status')
        return unwrap(
          api.POST('/v1/drivers/{id}/status', {
            ...p,
            body: { status: v.status!, reason: v.reason },
          }),
        );
      await unwrap(api.POST('/v1/drivers/{id}/delete', { ...p, body: { reason: v.reason } }));
      return null;
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['carriers'] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
