/**
 * ตัวช่วยแปลงค่าของฟอร์มสถานที่ (ST2-T02) — แยกไว้ทดสอบได้
 * พิกัด: รับ "lat, lng" หรือลิงก์ Google Maps (`@lat,lng` / `q=lat,lng` / `!3dlat!4dlng`) — spec/02 §2.3
 * กรอบประเทศไทย + เพื่อนบ้าน (lat 5–21, lng 97–106) ใช้เตือน ไม่บล็อก (spec/02 §2.4)
 */
export interface LatLng {
  lat: number;
  lng: number;
}

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';

export function parseLatLng(text: string): LatLng | null {
  const s = text.trim();
  if (!s) return null;
  const pats = [
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`@${NUM},${NUM}`),
    new RegExp(`[?&](?:q|query|ll|destination)=${NUM},\\s*${NUM}`),
    new RegExp(`^${NUM}\\s*[,\\s]\\s*${NUM}$`),
  ];
  for (const p of pats) {
    const m = p.exec(s.replace(/%2C/gi, ','));
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      // ยอมค่า lat เกิน 90 ไว้ก่อน — ฟอร์มเตือน "พิกัดอาจสลับกัน" พร้อมปุ่มสลับ (spec/02 §2.8)
      if (Math.abs(lat) <= 180 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

export const inThaiBox = (p: LatLng) => p.lat >= 5 && p.lat <= 21 && p.lng >= 97 && p.lng <= 106;

export function formatLatLng(lat: number | null, lng: number | null, digits = 5): string {
  if (lat === null || lng === null) return '';
  return `${lat.toFixed(digits)}, ${lng.toFixed(digits)}`;
}

/** "ชื่อ · เบอร์โทร" ↔ {name, phone} (ช่องเดียวตามต้นแบบ) — ไม่มี · ให้หาเบอร์ท้ายข้อความ */
export function parseContact(text: string): { name: string; phone?: string } | null {
  const s = text.trim();
  if (!s) return null;
  const parts = s.split(/\s*[·•|]\s*/);
  if (parts.length >= 2) {
    const phone = parts.slice(1).join(' ').trim();
    return { name: parts[0]!.trim(), ...(phone ? { phone } : {}) };
  }
  const m = /^(.*?)[\s,]+(\+?\d[\d\s-]{5,24})$/.exec(s);
  if (m && m[1]!.trim()) return { name: m[1]!.trim(), phone: m[2]!.trim() };
  return { name: s };
}

export function formatContact(c: { name: string; phone?: string } | null | undefined): string {
  if (!c) return '';
  return c.phone ? `${c.name} · ${c.phone}` : c.name;
}

/** ชื่อเรียกอื่น — บรรทัดละ 1 ชื่อ (ตัดว่าง/ซ้ำแบบไม่สนตัวพิมพ์) */
export function parseAliases(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const a = raw.trim();
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}
