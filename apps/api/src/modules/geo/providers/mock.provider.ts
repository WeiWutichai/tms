import {
  haversineKm,
  type GeoPoint,
  type GeoProvider,
  type GeocodeCandidate,
} from '../geo-provider';

/**
 * ตำแหน่งกลางโดยประมาณของอำเภอ/จังหวัด — ใช้เฉพาะ provider จำลอง (ไม่ใช่ข้อมูลแผนที่จริง)
 * ลำดับสำคัญ: ชื่อที่เจาะจงกว่า (อำเภอ, ชื่อยาว) มาก่อน — "ศรีราชา … ชลบุรี" ได้ศรีราชา
 * ชุดตั้งต้นจากต้นแบบ TMS v4 (BASE ของปุ่ม "ประมาณจากที่อยู่") + จังหวัดหลักที่ใช้ใน seed/test
 */
const PLACES: { names: string[]; at: [number, number]; district?: true }[] = [
  { names: ['ศรีราชา', 'sriracha'], at: [13.17, 100.93], district: true },
  { names: ['แหลมฉบัง', 'laem chabang'], at: [13.08, 100.89], district: true },
  { names: ['บางนา', 'bang na'], at: [13.67, 100.6], district: true },
  { names: ['วังน้อย', 'wang noi'], at: [14.23, 100.71], district: true },
  { names: ['หาดใหญ่', 'hat yai'], at: [7.01, 100.47], district: true },
  { names: ['พระนครศรีอยุธยา', 'อยุธยา', 'ayutthaya'], at: [14.35, 100.57] },
  { names: ['กรุงเทพมหานคร', 'กรุงเทพ', 'กทม', 'bangkok'], at: [13.75, 100.5] },
  { names: ['สมุทรปราการ', 'samut prakan'], at: [13.6, 100.6] },
  { names: ['สมุทรสาคร', 'samut sakhon'], at: [13.55, 100.27] },
  { names: ['นนทบุรี', 'nonthaburi'], at: [13.86, 100.51] },
  { names: ['ปทุมธานี', 'pathum thani'], at: [14.02, 100.53] },
  { names: ['นครปฐม', 'nakhon pathom'], at: [13.82, 100.06] },
  { names: ['สระบุรี', 'saraburi'], at: [14.53, 100.91] },
  { names: ['ลพบุรี', 'lopburi'], at: [14.8, 100.62] },
  { names: ['ชลบุรี', 'chonburi', 'chon buri'], at: [13.36, 100.98] },
  { names: ['ระยอง', 'rayong'], at: [12.68, 101.28] },
  { names: ['ฉะเชิงเทรา', 'chachoengsao'], at: [13.69, 101.07] },
  { names: ['ปราจีนบุรี', 'prachin buri'], at: [14.05, 101.37] },
  { names: ['นครราชสีมา', 'โคราช', 'nakhon ratchasima'], at: [14.97, 102.1] },
  { names: ['ขอนแก่น', 'khon kaen'], at: [16.44, 102.83] },
  { names: ['อุดรธานี', 'udon thani'], at: [17.41, 102.79] },
  { names: ['อุบลราชธานี', 'ubon ratchathani'], at: [15.24, 104.85] },
  { names: ['นครสวรรค์', 'nakhon sawan'], at: [15.7, 100.14] },
  { names: ['พิษณุโลก', 'phitsanulok'], at: [16.82, 100.26] },
  { names: ['เชียงใหม่', 'chiang mai'], at: [18.79, 98.98] },
  { names: ['เชียงราย', 'chiang rai'], at: [19.91, 99.83] },
  { names: ['ราชบุรี', 'ratchaburi'], at: [13.54, 99.82] },
  { names: ['กาญจนบุรี', 'kanchanaburi'], at: [14.02, 99.53] },
  { names: ['เพชรบุรี', 'phetchaburi'], at: [13.11, 99.94] },
  { names: ['สุราษฎร์ธานี', 'surat thani'], at: [9.14, 99.33] },
  { names: ['ภูเก็ต', 'phuket'], at: [7.88, 98.39] },
  { names: ['สงขลา', 'songkhla'], at: [7.19, 100.6] },
];

/** ความเร็วเฉลี่ยตั้งต้น 50 กม./ชม. (spec/03 PLN-004 [PROPOSED]) · ถนนจริงยาวกว่าเส้นตรง ~30% */
const AVG_KMH = 50;
const ROAD_FACTOR = 1.3;

/** FNV-1a 32 บิต — ให้ตำแหน่งที่ "สั่น" รอบจุดกลางเหมือนเดิมทุกครั้งสำหรับที่อยู่เดียวกัน (test ทำนายได้) */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * provider จำลองสำหรับ dev/test (ไม่ส่งข้อมูลออกนอกระบบ) — ห้ามใช้ใน production
 * - geocode: หาชื่ออำเภอ/จังหวัดในที่อยู่ → จุดกลาง + เลื่อนตามค่า hash ของที่อยู่ (±0.02°) · ไม่เจอชื่อใด = [] (ที่อยู่มั่ว)
 * - distance: ระยะเส้นตรง × 1.3 · เวลา = ระยะ ÷ 50 กม./ชม.
 */
export class MockGeoProvider implements GeoProvider {
  readonly name = 'mock';
  readonly enabled = true;

  async geocode(address: string): Promise<GeocodeCandidate[]> {
    const text = address.toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = PLACES.find((p) => p.names.some((n) => text.includes(n)));
    if (!hit) return [];
    const h = hash(text);
    const jitter = (bits: number) => (((h >>> bits) & 0xff) / 255 - 0.5) * 0.04;
    const hasPostcode = /(^|\D)\d{5}(\D|$)/.test(text);
    const confidence = round((hit.district ? 0.7 : 0.6) + (hasPostcode ? 0.2 : 0), 2);
    return [
      {
        lat: round(hit.at[0] + jitter(0), 6),
        lng: round(hit.at[1] + jitter(8), 6),
        confidence,
        label: hit.names[0]!,
      },
    ];
  }

  async distance(origin: GeoPoint, dest: GeoPoint) {
    const km = round(haversineKm(origin, dest) * ROAD_FACTOR, 1);
    return { km, minutes: Math.round((km / AVG_KMH) * 60) };
  }
}
