import { afterEach, describe, expect, it } from 'vitest';
import { haversineKm } from './geo-provider';
import { addressText, GeoService, providerFromEnv } from './geo.service';
import { MockGeoProvider } from './providers/mock.provider';
import { TenantRateLimiter } from './rate-limit';

/** ST2-T03: provider จำลอง + การเลือกผู้ให้บริการจาก config */
describe('geo provider', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
  });

  it('mock: ที่อยู่จริงได้ตำแหน่งเดิมทุกครั้ง (deterministic) ใกล้จุดกลางจังหวัด', async () => {
    const p = new MockGeoProvider();
    const addr = '99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110';
    const [a] = await p.geocode(addr);
    const [b] = await p.geocode(addr);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ label: 'ศรีราชา', confidence: 0.9 });
    // อำเภอเจาะจงกว่าจังหวัด → ศรีราชา (13.17, 100.93) ±0.02°
    expect(Math.abs(a!.lat - 13.17)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(a!.lng - 100.93)).toBeLessThanOrEqual(0.02);
    // ที่อยู่ต่างกันในจังหวัดเดียวกัน → ตำแหน่งต่างกันเล็กน้อย
    const [c] = await p.geocode('1 ถ.สุขุมวิท อ.ศรีราชา จ.ชลบุรี');
    expect(c!.lat === a!.lat && c!.lng === a!.lng).toBe(false);
    expect(c!.confidence).toBe(0.7); // ไม่มีรหัสไปรษณีย์
  });

  it('mock: ที่อยู่มั่ว = ไม่พบ', async () => {
    const p = new MockGeoProvider();
    expect(await p.geocode('asdf qwer ฟหกด 123')).toEqual([]);
    expect(await p.geocode('')).toEqual([]);
  });

  it('mock: ระยะทาง = เส้นตรง × 1.3, เวลา = 50 กม./ชม.', async () => {
    const p = new MockGeoProvider();
    const bkk = { lat: 13.75, lng: 100.5 };
    const cbi = { lat: 13.36, lng: 100.98 };
    const r = (await p.distance(bkk, cbi))!;
    const straight = haversineKm(bkk, cbi);
    expect(straight).toBeGreaterThan(65);
    expect(straight).toBeLessThan(70);
    expect(r.km).toBeCloseTo(straight * 1.3, 1);
    expect(r.minutes).toBe(Math.round((r.km / 50) * 60));
    expect(await p.distance(bkk, bkk)).toEqual({ km: 0, minutes: 0 });
  });

  it('เลือกผู้ให้บริการจาก GEO_PROVIDER: dev/test = mock, production = none, mock ใน production = ล้ม', () => {
    process.env.NODE_ENV = 'test';
    expect(providerFromEnv({}).name).toBe('mock');
    expect(providerFromEnv({ GEO_PROVIDER: 'none' }).name).toBe('none');
    expect(providerFromEnv({ GEO_PROVIDER: '' }).name).toBe('mock'); // ค่าว่าง = ไม่ได้ตั้ง
    process.env.NODE_ENV = 'production';
    expect(providerFromEnv({}).name).toBe('none');
    expect(() => providerFromEnv({ GEO_PROVIDER: 'mock' })).toThrow(/only allowed/);
    expect(() => providerFromEnv({ GEO_PROVIDER: 'nope' })).toThrow(/unknown GEO_PROVIDER/);
  });

  it('GeoService: none = ไม่เรียกผู้ให้บริการ, ตัดความมั่นใจต่ำ, ระยะทาง none = null', async () => {
    const s = new GeoService();
    s.use(providerFromEnv({ GEO_PROVIDER: 'none' }));
    expect(s.enabled).toBe(false);
    expect(await s.geocode('จ.ชลบุรี')).toEqual([]);
    expect(await s.distance({ lat: 13, lng: 100 }, { lat: 14, lng: 100 })).toBeNull();
    s.use({
      name: 'low',
      enabled: true,
      geocode: async () => [
        { lat: 13, lng: 100, confidence: 0.2, label: 'x' },
        { lat: 14, lng: 101, confidence: 0.55, label: 'y' },
      ],
      distance: async () => null,
    });
    expect((await s.geocode('x')).map((c) => c.label)).toEqual(['y']);
  });

  it('addressText ต่อทุกส่วนของที่อยู่', () => {
    expect(
      addressText({
        line1: '99 ถ.ตัวอย่าง',
        district: 'อ.เมือง',
        province: 'ชลบุรี',
        postcode: '20000',
      }),
    ).toBe('99 ถ.ตัวอย่าง อ.เมือง ชลบุรี 20000');
    expect(addressText(null)).toBe('');
  });

  it('เส้นตาย: ผู้ให้บริการช้า → throw + ส่ง abort signal', async () => {
    const svc = new GeoService();
    svc.timeoutMs = 20;
    let aborted = false;
    svc.use({
      name: 'slow',
      enabled: true,
      geocode: (_a, o) =>
        new Promise((resolve) => {
          o?.signal?.addEventListener('abort', () => {
            aborted = true;
            resolve([]);
          });
        }),
      distance: async () => null,
    });
    await expect(svc.geocode('จ.ชลบุรี')).rejects.toThrow('geo provider timeout');
    expect(aborted).toBe(true);
  });

  it('TenantRateLimiter: เพดานต่อ key + เติมคืนตามเวลา', () => {
    let now = 0;
    const l = new TenantRateLimiter(60, () => now);
    for (let i = 0; i < 60; i++) expect(l.take('a')).toBe(0);
    expect(l.take('a')).toBe(1);
    expect(l.take('b')).toBe(0);
    now += 1_000;
    expect(l.take('a')).toBe(0);
  });
});
