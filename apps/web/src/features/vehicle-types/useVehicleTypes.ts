import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { refetchOnStale } from '../master/problems';
import { useCursorList } from '../master/useCursorList';

export type VehicleType = Schemas['VehicleTypeDto'];
export type VehicleTypeInput = Schemas['UpdateVehicleTypeDto'];
export type VehicleTypeCreate = Schemas['CreateVehicleTypeDto'];
export type VehicleClass = VehicleType['vehicleClass'];
export type LicenceClass = NonNullable<VehicleType['minLicenceClass']>;
export type Capability = VehicleType['capabilityTags'][number];

export const VEHICLE_CLASSES: VehicleClass[] = ['4W', '6W', '10W', 'TRAILER', 'SEMI_TRAILER'];
/** ตัวกรองคอลัมน์ใบขับขี่ตามต้นแบบ (ท.1–ท.4) + ส่วนบุคคล (spec/02 §4) */
export const LICENCE_CLASSES: LicenceClass[] = ['PERSONAL', 'T1', 'T2', 'T3', 'T4'];
export const CAPABILITIES: Capability[] = ['REFRIGERATED', 'CRANE', 'CONTAINER', 'HAZMAT'];

const KEY = 'vehicle-types';

export interface VehicleTypeFilters {
  name: string;
  minLicenceClass: string;
}

export function useVehicleTypeList(filters: VehicleTypeFilters) {
  return useCursorList<VehicleType>(KEY, { ...filters }, (query) =>
    unwrap(api.GET('/v1/vehicle-types', { params: { query: query as never } })),
  );
}

export function useVehicleTypeSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/vehicle-types/summary')),
  });
}

export function useCreateVehicleType() {
  const qc = useQueryClient();
  return useMutation({
    /** idempotencyKey ต่อการเปิดฟอร์ม 1 ครั้ง — กดซ้ำ/ส่งซ้ำได้รายการเดียว (ST0-T07) */
    mutationFn: (v: { body: VehicleTypeCreate; idempotencyKey: string }) =>
      unwrap(
        api.POST('/v1/vehicle-types', {
          body: v.body,
          headers: { 'Idempotency-Key': v.idempotencyKey },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateVehicleType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: VehicleTypeInput }) =>
      unwrap(
        api.PATCH('/v1/vehicle-types/{id}', {
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

export function useVehicleTypeAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      version: number;
      action: 'activate' | 'deactivate' | 'delete';
      reason?: string;
    }): Promise<VehicleType | null> => {
      // If-Match: กันเปลี่ยนสถานะ/ลบรายการที่ผู้อื่นเพิ่งแก้ (412 → แจ้งให้โหลดใหม่)
      const p = {
        params: { path: { id: v.id }, header: { 'If-Match': `"${v.version}"` } as never },
      };
      if (v.action === 'activate')
        return unwrap(api.POST('/v1/vehicle-types/{id}/activate', { ...p, body: {} }));
      if (v.action === 'deactivate')
        return unwrap(
          api.POST('/v1/vehicle-types/{id}/deactivate', {
            ...p,
            body: { reason: v.reason ?? '' },
          }),
        );
      await unwrap(
        api.POST('/v1/vehicle-types/{id}/delete', { ...p, body: { reason: v.reason ?? '' } }),
      );
      return null;
    },
    onError: refetchOnStale(qc, KEY),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
