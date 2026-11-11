import type { GeoProvider } from '../geo-provider';

/** ไม่มีผู้ให้บริการ (ค่าเริ่มต้นนอก dev/test จนกว่าจะเลือกตาม Q-D3) — ผู้ใช้ปักหมุด/กรอกระยะเอง */
export class NoneGeoProvider implements GeoProvider {
  readonly name = 'none';
  readonly enabled = false;
  async geocode() {
    return [];
  }
  async distance() {
    return null;
  }
}
