/**
 * Design tokens — ค่าทุกค่าคัดลอกจากต้นแบบ design/prototype/TMS v4.dc.html (export 10 พ.ย. 2569)
 * ห้ามแก้ค่าเพื่อ "ให้สวยขึ้น" — ถ้าต้นแบบเปลี่ยน ให้ export ใหม่แล้วแก้ที่นี่พร้อมอ้างตำแหน่งในต้นแบบ
 */
export const color = {
  // พื้นและเส้น (ds.pal 'พื้นและเส้น' + shell)
  appBg: '#EEF0EC', // พื้นหลังแอป (shell div)
  pageBg: '#F4F5F2', // body / แถบค้นหาใน sidebar / หัวตารางรอง
  surface: '#FFFFFF',
  chip: '#EBEDE8', // หัวตาราง / route chip / segmented
  line: '#D9DCD4',
  lineSoft: '#E4E6E0', // เส้นแบ่งในการ์ด/ตาราง
  cardBorder: '#CDD1C8',
  inputBorder: '#C9CDC3',
  hover: '#EEF0EC',
  // accent
  accent: '#2257C4',
  accentHover: '#1B479F',
  accentSoft: '#E9F0FA',
  accentFocus: '#9DB6E3',
  navy: '#13213F', // โลโก้ / tenant / ชื่อหน้า
  // ข้อความ
  text: '#101418',
  text2: '#3B424C',
  text3: '#59606B',
  // สถานะ
  ok: '#17733F',
  warn: '#8F5500',
  err: '#B3322A',
  info: '#2257C4',
  off: '#3B424C',
  okSoft: '#E6F4EC',
  warnSoft: '#FCF0DC',
  errSoft: '#FBE9E7',
  infoSoft: '#E9F0FA',
  offSoft: '#ECEDEA',
} as const;

export const shadow = {
  card: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
  sidebar: '0 1px 2px rgba(16,20,24,.06),0 8px 24px rgba(16,20,24,.06)',
  navActive: '0 1px 2px rgba(34,87,196,.12),0 2px 8px rgba(34,87,196,.10)',
  menu: '0 8px 24px rgba(16,20,24,.12)',
  popover: '0 12px 32px rgba(16,24,40,.12)',
  drawer: '-18px 0 44px rgba(10,23,52,.10)',
  inset: 'inset 0 1px 2px rgba(16,20,24,.08)',
  focusRing: '0 0 0 2px #FFFFFF,0 0 0 4px #2257C4',
  kpiActive: '0 0 0 1px #9DB6E3',
  segOn: '0 1px 2px rgba(10,23,52,.10)',
} as const;

export const font = {
  family: "'IBM Plex Sans Thai Looped','IBM Plex Sans',system-ui,sans-serif",
  /** Google Fonts URL ตามต้นแบบ (helmet ของ TMS v4) */
  href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Thai+Looped:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
} as const;

/** โทนของ badge สถานะ (ฟังก์ชัน badge() ในต้นแบบ) */
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'off';
export const tone: Record<Tone, { c: string; bg: string }> = {
  ok: { c: color.ok, bg: color.okSoft },
  warn: { c: color.warn, bg: color.warnSoft },
  err: { c: color.err, bg: color.errSoft },
  info: { c: color.info, bg: color.infoSoft },
  off: { c: color.off, bg: color.offSoft },
};
