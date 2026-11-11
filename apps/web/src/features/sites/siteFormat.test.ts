import { describe, expect, it } from 'vitest';
import { inThaiBox, parseAliases, parseContact, parseLatLng } from './siteFormat';

describe('siteFormat (ST2-T02)', () => {
  it('พิกัด: "lat, lng" และลิงก์ Google Maps', () => {
    expect(parseLatLng('13.6416, 100.6911')).toEqual({ lat: 13.6416, lng: 100.6911 });
    expect(parseLatLng('13.6416 100.6911')).toEqual({ lat: 13.6416, lng: 100.6911 });
    expect(
      parseLatLng(
        'https://www.google.com/maps/place/x/@13.7563,100.5018,17z/data=!3d13.7563!4d100.5018',
      ),
    ).toEqual({ lat: 13.7563, lng: 100.5018 });
    expect(parseLatLng('https://maps.google.com/?q=13.5,100.9')).toEqual({ lat: 13.5, lng: 100.9 });
    expect(parseLatLng('ไม่ใช่พิกัด')).toBeNull();
    // สลับกัน → อ่านได้ แต่ไม่อยู่ในกรอบไทย (ฟอร์มเตือน + ปุ่มสลับ)
    const sw = parseLatLng('100.6911, 13.6416')!;
    expect(inThaiBox(sw)).toBe(false);
    expect(inThaiBox({ lat: sw.lng, lng: sw.lat })).toBe(true);
  });

  it('ผู้ติดต่อ "ชื่อ · เบอร์" และ alias บรรทัดละชื่อ (ตัดซ้ำไม่สนตัวพิมพ์)', () => {
    expect(parseContact('คุณวิไล · 02-300-4100')).toEqual({
      name: 'คุณวิไล',
      phone: '02-300-4100',
    });
    expect(parseContact('คุณวิไล 0812345678')).toEqual({ name: 'คุณวิไล', phone: '0812345678' });
    expect(parseContact('คุณวิไล')).toEqual({ name: 'คุณวิไล' });
    expect(parseContact('  ')).toBeNull();
    expect(parseAliases('SPC ชลบุรี\n spc ชลบุรี \n\nโรง 2')).toEqual(['SPC ชลบุรี', 'โรง 2']);
  });
});
