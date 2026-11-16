import { escapeHtml } from '../../pdf/pdf-renderer';
import { docDateShort } from '../../common/thai-date';

/**
 * แม่แบบ A4 "ใบคุมรถ / TRIP SHEET" (ST3-T20) — ตามต้นแบบ `design/prototype/TMS Print.dc.html#trip` (ค่า CSS/ข้อความจากต้นแบบ)
 * เอกสารปฏิบัติการ ไม่ใช่เอกสารภาษี: ไม่มีเลขเอกสารภาษี — เลขบนหัว = เลขเที่ยว
 * เพิ่มจากต้นแบบ (spec/12 §3 ST3-T20 DECISION): บรรทัดรองในช่อง "ประเภท / สถานที่" = เวลานัด · ผู้ติดต่อ / ที่อยู่
 * และใต้เลข DO = รายการสินค้า (docs/v1/03 #10 "ลำดับจุดส่ง สินค้า ผู้ติดต่อ"; spec/05 ใบคุมรถ "เวลานัด สถานที่ DO")
 * ใบรายวัน = หลายเที่ยวต่อไฟล์ — แต่ละเที่ยวเริ่มหน้าใหม่ แบ่งหน้าเอง (PAGINATE) + เลขหน้าต่อเที่ยว
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
  /** นิติบุคคลผู้ออก (ผู้วางบิลของ DO ในเที่ยว — ไม่มี = ชื่อบริษัทใน tenant) ต่อเที่ยว */
  companyName: string;
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
    .map((x) => `<div class="mn" style="${MINOR}">${x}</div>`)
    .join('');
  const dos = s.dos.length
    ? s.dos
        .map(
          (d) =>
            `<div class="dob"><div style="${NUM};white-space:nowrap">${e(d.doNo)}</div>${d.goods
              .map((g) => `<div style="${MINOR}">${e(g)}</div>`)
              .join('')}</div>`,
        )
        .join('')
    : '—';
  return `<tr><td style="${TD}">${s.sequence}</td><td style="${TD}"><div class="loc"><b>${TYPE_TH[s.type]}</b> · ${e(s.siteName)}</div>${minor}</td><td style="${TD}">${dos}</td><td style="${TD}"></td><td style="${TD}"></td><td style="${TD}"></td></tr>`;
}

function page(doc: TripSheetDoc, p: TripSheetPage): string {
  const vt = [p.vehicleType, p.trailerPlate ? `หาง ${p.trailerPlate}` : 'ไม่มีหาง']
    .filter(Boolean)
    .join(' · ');
  const driver = p.driverName ?? (p.carrierName ? `${p.carrierName} (รถร่วม)` : '—');
  const co = e(p.companyName);
  // แหล่งของตัวแบ่งหน้า (PAGINATE): .head = หัวหน้าแรก · .cont = หัวหน้าต่อ · ตาราง · .end = เลขไมล์/ค่าใช้จ่าย/ลายเซ็น
  return `<div class="trip" data-no="${e(p.tripNo)}">
<div class="head" style="display:flex;flex-direction:column;gap:20px">
<div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding-bottom:16px;border-bottom:2px solid #13213F">
<div style="display:flex;gap:12px"><div style="width:44px;height:44px;border-radius:10px;background:#13213F;color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-weight:600;flex-shrink:0">${e(companyInitials(p.companyName))}</div><div style="display:flex;flex-direction:column"><span style="font-weight:600;font-size:17px">${co}</span><span style="font-size:14px;color:#3B424C">ฝ่ายวางแผนรถ</span></div></div>
<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0"><span style="font-size:24px;font-weight:600;color:#13213F">ใบคุมรถ</span><span style="font-size:14px;font-weight:500;color:#3B424C;">TRIP SHEET</span><span style="font-variant-numeric:tabular-nums;font-size:15px;font-weight:500">${e(p.tripNo)}</span><span style="font-size:15px">วันที่ ${e(docDateShort(p.tripDate, doc.yearStyle))}</span></div>
</div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
<div style="${BOX}"><span style="${LBL}">ทะเบียนรถ / Plate</span><span style="${NUM};font-weight:500">${e(p.plate ?? '—')}</span></div>
<div style="${BOX}"><span style="${LBL}">ประเภท / หาง / Type / trailer</span><span>${e(vt)}</span></div>
<div style="${BOX}"><span style="${LBL}">พนักงานขับรถ / Driver</span><span>${e(driver)}</span></div>
<div style="${BOX}"><span style="${LBL}">เงินเบิกล่วงหน้า / Advance</span><span style="${NUM}">—</span></div>
</div>
</div>
<div class="cont" style="display:flex;justify-content:space-between;gap:24px;align-items:flex-end;padding-bottom:10px;border-bottom:2px solid #13213F"><span style="font-weight:600;font-size:15px">${co}</span><span style="font-size:15px"><b style="color:#13213F">ใบคุมรถ</b> <span style="font-variant-numeric:tabular-nums;font-weight:500">${e(p.tripNo)}</span> (ต่อ)</span></div>
<table style="width:100%;border-collapse:collapse;font-size:16px;table-layout:fixed">
<thead><tr style="background:#EBEDE8"><th style="${TH};width:48px">จุด<div style="${SUB}">Stop</div></th><th style="${TH}">ประเภท / สถานที่<div style="${SUB}">Type / location</div></th><th style="${TH};width:136px">DO<div style="${SUB}">DO</div></th><th style="${TH};width:80px">ถึง<div style="${SUB}">Arrive</div></th><th style="${TH};width:80px">ออก<div style="${SUB}">Depart</div></th><th style="${TH};width:120px">ลงชื่อ<div style="${SUB}">Signature</div></th></tr></thead>
<tbody>${p.stops.map(stopRow).join('')}</tbody>
</table>
<div class="end" style="display:flex;flex-direction:column;gap:20px">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
<div style="border:1px solid #D9DCD4;border-radius:10px;padding:12px 14px;display:grid;grid-template-columns:auto 1fr;gap:10px 14px;align-items:end"><span>เลขไมล์ออก</span><span style="border-bottom:1px dashed #C9CDC3;height:24px"></span><span>เลขไมล์กลับ</span><span style="border-bottom:1px dashed #C9CDC3;height:24px"></span><span>รวมระยะทาง (กม.)</span><span style="border-bottom:1px dashed #C9CDC3;height:24px"></span></div>
<div style="border:1px solid #D9DCD4;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px"><span style="font-weight:600">ค่าใช้จ่ายระหว่างทาง</span><span style="color:#3B424C">แนบใบเสร็จทุกรายการเพื่อเคลียร์เงินเบิก</span><div style="height:40px;border-bottom:1px dashed #C9CDC3"></div></div>
</div>
<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:40px;padding-top:28px">
<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:100%;height:56px;border-bottom:1px solid #101418"></div><span>ผู้จ่ายงาน / Dispatcher</span></div>
<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:100%;height:56px;border-bottom:1px solid #101418"></div><span>พนักงานขับรถ / Driver</span></div>
</div>
</div>
</div>`;
}

/**
 * ตัวแบ่งหน้า (รันใน Chromium หลังฟอนต์โหลด — PdfRenderer รอ `data-paged`) — ST3-T20 QA L1/L2:
 * - หน้า A4 สูงคงที่ · หน้าแรก = หัวเต็ม + กล่อง 4 ช่อง · หน้าต่อ = หัวย่อ "ใบคุมรถ TRP-… (ต่อ)" + หัวตาราง
 * - แถวจุดที่สูงเกินที่เหลือ → แยกตามบล็อก DO (เลข DO ติดกับสินค้าของมัน) ส่วนที่เหลือไปหน้าถัดไป "(ต่อ)" — ตารางเริ่มในหน้าแรกเสมอ
 * - ท้ายหน้าทุกหน้า "TRP-… · หน้า x/y" นับต่อเที่ยว (ใบรายวันหลายเที่ยวนับแยกกัน)
 */
const PAGINATE = `(function(){
function run(){
var FOOT=40;
document.querySelectorAll('.trip').forEach(function(trip){
  var no=trip.getAttribute('data-no');
  var head=trip.querySelector('.head'),cont=trip.querySelector('.cont'),table=trip.querySelector('table'),end=trip.querySelector('.end');
  var rows=[].slice.call(table.tBodies[0].rows);
  var host=document.createElement('div');trip.parentNode.insertBefore(host,trip);trip.remove();
  var pages=[],pg,inner,tbody;
  function fits(){var last=inner.lastElementChild;if(!last)return true;var r=pg.getBoundingClientRect();return last.getBoundingClientRect().bottom<=r.top+pg.clientHeight-FOOT;}
  function newPage(withTable){
    pg=document.createElement('section');pg.className='page';inner=document.createElement('div');inner.className='in';pg.appendChild(inner);
    var f=document.createElement('div');f.className='foot';pg.appendChild(f);host.appendChild(pg);pages.push(pg);
    inner.appendChild(pages.length===1?head:cont.cloneNode(true));
    tbody=null;
    if(withTable){var t=table.cloneNode(false);t.appendChild(table.tHead.cloneNode(true));tbody=document.createElement('tbody');t.appendChild(tbody);inner.appendChild(t);}
  }
  function cut(row,keep){
    var a=row.cloneNode(true);[].slice.call(a.querySelectorAll('.dob')).slice(keep).forEach(function(x){x.remove();});
    var b=row.cloneNode(true);[].slice.call(b.querySelectorAll('.dob')).slice(0,keep).forEach(function(x){x.remove();});
    var m=b.querySelectorAll('.mn');for(var i=0;i<m.length;i++)m[i].remove();
    var l=b.querySelector('.loc');if(l)l.insertAdjacentHTML('beforeend',' (ต่อ)');
    return [a,b];
  }
  function place(row){
    tbody.appendChild(row);if(fits())return;row.remove();
    var n=row.querySelectorAll('.dob').length;
    for(var k=n-1;k>=1;k--){var ab=cut(row,k);tbody.appendChild(ab[0]);if(fits()){newPage(true);place(ab[1]);return;}ab[0].remove();}
    if(tbody.rows.length===0&&pages.length>1){tbody.appendChild(row);pg.classList.add('grow');return;}
    if(tbody.rows.length===0&&n>1){var c=cut(row,1);tbody.appendChild(c[0]);newPage(true);place(c[1]);return;}
    if(tbody.rows.length===0){tbody.appendChild(row);pg.classList.add('grow');return;}
    newPage(true);place(row);
  }
  newPage(true);
  rows.forEach(place);
  inner.appendChild(end);
  if(!fits()){end.remove();newPage(false);inner.appendChild(end);}
  pages.forEach(function(p,i){p.querySelector('.foot').textContent=no+' · หน้า '+(i+1)+'/'+pages.length;});
});
document.documentElement.setAttribute('data-paged','1');
}
document.fonts.ready.then(run);
})();`;

/** HTML ของใบคุมรถ (1 เที่ยวเริ่มหน้าใหม่ แบ่งหน้าเองต่อเที่ยว) สำหรับ PdfRenderer */
export function tripSheetDocument(doc: TripSheetDoc) {
  const body = `<div data-paginate>${doc.pages.map((p) => page(doc, p)).join('')}</div><script>${PAGINATE}</script>`;
  const css = `
.page{width:210mm;height:296mm;box-sizing:border-box;position:relative;overflow:hidden;break-after:page}
.page.grow{height:auto;min-height:296mm;overflow:visible}
[data-paginate]>div:last-child>.page:last-child{break-after:auto}
.in{padding:44px 48px 0;display:flex;flex-direction:column;gap:20px;font-size:16px;line-height:1.6}
.foot{position:absolute;left:48px;right:48px;bottom:18px;font-size:12px;color:#59606B;text-align:right;font-variant-numeric:tabular-nums}
.trip .cont{display:none!important}.page .cont{display:flex!important}`;
  const title = doc.pages.length === 1 ? `ใบคุมรถ ${doc.pages[0]!.tripNo}` : 'ใบคุมรถ';
  return { body, css, title };
}
