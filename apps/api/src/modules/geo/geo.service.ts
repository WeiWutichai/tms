import { Injectable } from '@nestjs/common';
import { isLocalEnv } from '../../auth/tokens';
import type { DistanceResult, GeoPoint, GeoProvider, GeocodeCandidate } from './geo-provider';
import { MockGeoProvider } from './providers/mock.provider';
import { NoneGeoProvider } from './providers/none.provider';

/** ความมั่นใจต่ำกว่านี้ถือว่า "หาไม่พบ" (ไม่เสนอพิกัดที่น่าจะผิดให้คนกดยืนยันง่าย ๆ) */
export const GEOCODE_MIN_CONFIDENCE = 0.5;

/**
 * เลือกผู้ให้บริการจาก `GEO_PROVIDER` — ค่าเริ่มต้น: dev/test = `mock`, อื่น ๆ = `none`
 * `mock` นอก dev/test = ล้มตอนเริ่ม (พิกัดปลอมห้ามหลุดไปใช้จริง)
 * เพิ่มผู้ให้บริการจริง (Google/Longdo/NOSTRA/HERE …) = เพิ่ม case ที่นี่ + adapter 1 ไฟล์ใน `providers/`
 */
export function providerFromEnv(env = process.env): GeoProvider {
  const kind = env.GEO_PROVIDER ?? (isLocalEnv() ? 'mock' : 'none');
  if (kind === 'none') return new NoneGeoProvider();
  if (kind === 'mock') {
    if (!isLocalEnv()) throw new Error('GEO_PROVIDER=mock is only allowed in development/test');
    return new MockGeoProvider();
  }
  throw new Error(`unknown GEO_PROVIDER '${kind}'`);
}

/** ข้อความที่อยู่สำหรับ geocode — ต่อทุกส่วน (บรรทัด 1–2, ตำบล, อำเภอ, จังหวัด, รหัสไปรษณีย์) */
export function addressText(a: unknown): string {
  if (!a || typeof a !== 'object') return '';
  const o = a as Record<string, unknown>;
  return ['line1', 'line2', 'subdistrict', 'district', 'province', 'postcode']
    .map((k) => (typeof o[k] === 'string' ? (o[k] as string).trim() : ''))
    .filter(Boolean)
    .join(' ');
}

/**
 * บริการแผนที่ของระบบ (ST2-T03) — จุดเดียวที่โมดูลอื่นเรียก: สถานที่ (geocode อัตโนมัติ/ปุ่มประมาณจากที่อยู่),
 * เส้นทาง (ST2-T09) และราคา (ST2-T15) เรียก `distance()`
 */
@Injectable()
export class GeoService {
  private provider: GeoProvider = providerFromEnv();

  /** test สลับ provider ได้ */
  use(p: GeoProvider) {
    this.provider = p;
  }

  get name(): string {
    return this.provider.name;
  }

  get enabled(): boolean {
    return this.provider.enabled;
  }

  /** ตำแหน่งที่ความมั่นใจถึงเกณฑ์ เรียงมาก → น้อย (สูงสุด 5) — ที่อยู่ว่าง = [] โดยไม่เรียกผู้ให้บริการ */
  async geocode(address: string): Promise<GeocodeCandidate[]> {
    const q = address.trim();
    if (!q || !this.provider.enabled) return [];
    const r = await this.provider.geocode(q);
    return r
      .filter(
        (c) =>
          c.confidence >= GEOCODE_MIN_CONFIDENCE && Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180,
      )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  }

  /** ระยะทาง/เวลาขับรถระหว่าง 2 จุด · ผู้ให้บริการไม่รองรับ = null (ให้ผู้ใช้กรอกระยะเอง) */
  async distance(origin: GeoPoint, dest: GeoPoint): Promise<DistanceResult | null> {
    return this.provider.distance(origin, dest);
  }
}
