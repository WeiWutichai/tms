import { escapeHtml } from '../../pdf/pdf-renderer';
import { docDateShort } from '../../common/thai-date';

/**
 * แม่แบบ A4 "ใบคุมรถ / TRIP SHEET" (ST3-T20) — ตามต้นแบบ `design/prototype/TMS Print.dc.html#trip` (ค่า CSS/ข้อความจากต้นแบบ)
 * เอกสารปฏิบัติการ ไม่ใช่เอกสารภาษี: ไม่มีเลขเอกสารภาษี — เลขบนหัว = เลขเที่ยว
 * เพิ่มจากต้นแบบ (spec/12 §3 ST3-T20 DECISION): บรรทัดรองในช่อง "ประเภท / สถานที่" = เวลานัด · ผู้ติดต่อ / ที่อยู่
 * และใต้เลข DO = รายการสินค้า (docs/v1/03 #10 "ลำดับจุดส่ง สินค้า ผู้ติดต่อ"; spec/05 ใบคุมรถ "เวลานัด สถานที่ DO")
 * ใบรายวัน = หลายเที่ยวต่อไฟล์ 1 เที่ยว/หน้า (เที่ยวที่จุดเยอะไหลต่อหน้าถัดไปเอง)
 */
export interface TripSheetStop {
  sequence: number;
  type: 'PICKUP' | 'DELIVERY' | 'RETURN';
  siteName: string;
  address: string;
  /** เวลานัด เช่น "08:00–10:00" (ช่วงที่ลูกค้าขอ) หรือ "08:30" (เวลาตามแผน) */
  appointment: string | null;
  contactName: string | null;
  contactPhone: string | null;
  dos: { doNo: string; goods: string[] }[];
}

export interface TripSheetPage {
  tripNo: string;
  /** YYYY-MM-DD */
  tripDate: string;
  plate: string | null;
  vehicleType: string | null;
  trailerPlate: string | null;
  driverName: string | null;
  carrierName: string | null;
  stops: TripSheetStop[];
}

export interface TripSheetDoc {
  companyName: string;
  yearStyle: 'BE' | 'CE';
  pages: TripSheetPage[];
}

const TYPE_TH: Record<TripSheetStop['type'], string> = {
  PICKUP: 'รับ',
  DELIVERY: 'ส่ง',
  RETURN: 'คืน',
};

const PREFIX = /^(บริษัท|บจก\.|หจก\.|บมจ\.)\s*/;
const LIMITED = /\s*จำกัด.*$/;
const LETTER = /[ก-ฮA-Za-z0-9]/;

/** ตัวย่อ 2 ตัวจากชื่อบริษัท (กล่องโลโก้ของต้นแบบ "ศท") — กติกาเดียวกับหน้าเข้าสู่ระบบ (web `initials`) */
export function companyInitials(name: string): string {
  return [...name.replace(PREFIX, '').replace(LIMITED, '')]
    .filter((ch) => LETTER.test(ch))
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

const e = escapeHtml;
const TD = 'padding:12px 10px;border-bottom:1px solid #E4E6E0;vertical-align:top';
const TH =
  'padding:8px 10px;text-align:left;font-weight:600;border-bottom:1px solid #D9DCD4;box-sizing:border-box';
const SUB = 'font-weight:400;font-size:13px;color:#3B424C';
const BOX =
  'border:1px solid #D9DCD4;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column';
const LBL = 'font-size:14px;color:#3B424C';
const NUM = 'font-variant-numeric:tabular-nums;font-size:15px';
const MINOR = 'font-size:13px;color:#3B424C;line-height:1.45';

function stopRow(s: TripSheetStop): string {
  // บรรทัดรอง (ไม่มีในต้นแบบ — spec/12 §3): "นัด … · ติดต่อ ชื่อ เบอร์" แล้วที่อยู่ — 2 บรรทัดให้ 3–4 จุดพอดี 1 หน้า
  const contact = [
    s.contactName ? e(s.contactName) : '',
    s.contactPhone ? `<span style="white-space:nowrap">${e(s.contactPhone)}</span>` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const minor = [
    [s.appointment ? `นัด ${e(s.appointment)}` : '', contact ? `ติดต่อ ${contact}` : '']
      .filter(Boolean)
      .join(' · '),
    s.address ? e(s.address) : '',
  ]
    .filter(Boolean)
    .map((x) => `<div style="${MINOR}">${x}</div>`)
    .join('');
  const dos = s.dos.length
    ? s.dos
        .map(
          (d) =>
            `<div style="${NUM};white-space:nowrap">${e(d.doNo)}</div>${d.goods
              .map((g) => `<div style="${MINOR}">${e(g)}</div>`)
              .join('')}`,
        )
        .join('')
    : '—';
  return `<tr><td style="${TD}">${s.sequence}</td><td style="${TD}"><b>${TYPE_TH[s.type]}</b> · ${e(s.siteName)}${minor}</td><td style="${TD}">${dos}</td><td style="${TD}"></td><td style="${TD}"></td><td style="${TD}"></td></tr>`;
}

function page(doc: TripSheetDoc, p: TripSheetPage): string {
  const vt = [p.vehicleType, p.trailerPlate ? `หาง ${p.trailerPlate}` : 'ไม่มีหาง']
    .filter(Boolean)
    .join(' · ');
  const driver = p.driverName ?? (p.carrierName ? `${p.carrierName} (รถร่วม)` : '—');
  return `<section class="page"><div class="in">
<div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding-bottom:16px;border-bottom:2px solid #13213F">
<div style="display:flex;gap:12px"><div style="width:44px;height:44px;border-radius:10px;background:#13213F;color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-weight:600;flex-shrink:0">${e(companyInitials(doc.companyName))}</div><div style="display:flex;flex-direction:column"><span style="font-weight:600;font-size:17px">${e(doc.companyName)}</span><span style="font-size:14px;color:#3B424C">ฝ่ายวางแผนรถ</span></div></div>
<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0"><span style="font-size:24px;font-weight:600;color:#13213F">ใบคุมรถ</span><span style="font-size:14px;font-weight:500;color:#3B424C;">TRIP SHEET</span><span style="font-variant-numeric:tabular-nums;font-size:15px;font-weight:500">${e(p.tripNo)}</span><span style="font-size:15px">วันที่ ${e(docDateShort(p.tripDate, doc.yearStyle))}</span></div>
</div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
<div style="${BOX}"><span style="${LBL}">ทะเบียนรถ / Plate</span><span style="${NUM};font-weight:500">${e(p.plate ?? '—')}</span></div>
<div style="${BOX}"><span style="${LBL}">ประเภท / หาง / Type / trailer</span><span>${e(vt)}</span></div>
<div style="${BOX}"><span style="${LBL}">พนักงานขับรถ / Driver</span><span>${e(driver)}</span></div>
<div style="${BOX}"><span style="${LBL}">เงินเบิกล่วงหน้า / Advance</span><span style="${NUM}">—</span></div>
</div>
<table style="width:100%;border-collapse:collapse;font-size:16px;table-layout:fixed">
<thead><tr style="background:#EBEDE8"><th style="${TH};width:48px">จุด<div style="${SUB}">Stop</div></th><th style="${TH}">ประเภท / สถานที่<div style="${SUB}">Type / location</div></th><th style="${TH};width:136px">DO<div style="${SUB}">DO</div></th><th style="${TH};width:80px">ถึง<div style="${SUB}">Arrive</div></th><th style="${TH};width:80px">ออก<div style="${SUB}">Depart</div></th><th style="${TH};width:120px">ลงชื่อ<div style="${SUB}">Signature</div></th></tr></thead>
<tbody>${p.stops.map(stopRow).join('')}</tbody>
</table>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;break-inside:avoid">
<div style="border:1px solid #D9DCD4;border-radius:10px;padding:12px 14px;display:grid;grid-template-columns:auto 1fr;gap:10px 14px;align-items:end"><span>เลขไมล์ออก</span><span style="border-bottom:1px dashed #C9CDC3;height:24px"></span><span>เลขไมล์กลับ</span><span style="border-bottom:1px dashed #C9CDC3;height:24px"></span><span>รวมระยะทาง (กม.)</span><span style="border-bottom:1px dashed #C9CDC3;height:24px"></span></div>
<div style="border:1px solid #D9DCD4;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px"><span style="font-weight:600">ค่าใช้จ่ายระหว่างทาง</span><span style="color:#3B424C">แนบใบเสร็จทุกรายการเพื่อเคลียร์เงินเบิก</span><div style="height:40px;border-bottom:1px dashed #C9CDC3"></div></div>
</div>
<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:40px;margin-top:auto;padding-top:28px;break-inside:avoid">
<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:100%;height:56px;border-bottom:1px solid #101418"></div><span>ผู้จ่ายงาน / Dispatcher</span></div>
<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:100%;height:56px;border-bottom:1px solid #101418"></div><span>พนักงานขับรถ / Driver</span></div>
</div>
</div></section>`;
}

/** HTML ของใบคุมรถ (1 เที่ยว/หน้า) สำหรับ PdfRenderer */
export function tripSheetDocument(doc: TripSheetDoc) {
  const body = doc.pages.map((p) => page(doc, p)).join('');
  const css = `
.page{width:210mm;min-height:296mm;box-sizing:border-box;display:flex;flex-direction:column;break-after:page}
.page:last-child{break-after:auto}
.in{padding:44px 48px;display:flex;flex-direction:column;gap:20px;font-size:16px;line-height:1.6}
thead{display:table-header-group}tr{break-inside:avoid}`;
  const title = doc.pages.length === 1 ? `ใบคุมรถ ${doc.pages[0]!.tripNo}` : 'ใบคุมรถ';
  return { body, css, title };
}
