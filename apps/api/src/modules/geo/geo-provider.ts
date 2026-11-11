/**
 * ผู้ให้บริการแผนที่ / geocode / ระยะทาง (ST2-T03; docs/04 G4 "Google / Longdo / NOSTRA Map เลือกผ่าน config")
 * ยังไม่เลือกผู้ให้บริการจริง (ADR ST0-T01 / spec/12 Q-D3) → มีแค่ `mock` (dev/test) และ `none`
 * เพิ่มผู้ให้บริการจริง = เขียน adapter 1 ไฟล์ใน `providers/` ที่ implement `GeoProvider` แล้วเพิ่มใน `providerFromEnv()`
 * — ผู้เรียก (สถานที่, เส้นทาง ST2-T09, ราคา ST2-T15) ไม่ต้องแก้
 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeocodeCandidate extends GeoPoint {
  /** ความมั่นใจ 0–1 (ผู้ให้บริการแต่ละเจ้าแปลงมาเป็นสเกลเดียวกัน) */
  confidence: number;
  /** ข้อความที่ผู้ให้บริการจับคู่ได้ (เช่น ชื่อจังหวัด/ถนน) — แสดงให้คนยืนยัน */
  label: string;
}

export interface DistanceResult {
  /** ระยะทางตามถนน (กม.) ทศนิยม 1 ตำแหน่ง */
  km: number;
  /** เวลาเดินทางโดยประมาณ (นาที) */
  minutes: number;
}

/** ทุกการเรียกผู้ให้บริการมีเส้นตาย — adapter ต้องส่ง `signal` ต่อให้ HTTP client (fetch) เพื่อยกเลิกจริง */
export interface GeoCallOptions {
  signal?: AbortSignal;
}

export interface GeoProvider {
  /** ชื่อผู้ให้บริการ — เก็บคู่กับพิกัดที่เสนอ (ตรวจย้อนหลังได้ว่ามาจากไหน) */
  readonly name: string;
  /** ใช้ geocode ได้ไหม (`none` = ไม่ได้ → ไม่สั่งงาน geocode อัตโนมัติ) */
  readonly enabled: boolean;
  /** ที่อยู่ → ตำแหน่งที่เป็นไปได้ เรียงความมั่นใจมาก → น้อย · หาไม่พบ = [] · ผู้ให้บริการล่ม = throw */
  geocode(address: string, opts?: GeoCallOptions): Promise<GeocodeCandidate[]>;
  /** ระยะทาง/เวลาขับรถ · ไม่รองรับ = null (ผู้ใช้กรอกระยะเอง — backlog ST2-T03 "กรอกพิกัด/ระยะมือได้") */
  distance(origin: GeoPoint, dest: GeoPoint, opts?: GeoCallOptions): Promise<DistanceResult | null>;
}

/** ระยะเส้นตรงบนผิวโลก (กม.) — ใช้ใน provider จำลอง และตรวจจุดซ้ำ (MD-050) ภายหลัง */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
