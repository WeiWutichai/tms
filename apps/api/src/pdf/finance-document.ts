import { escapeHtml } from './pdf-renderer';
import { docDateShort } from '../common/thai-date';
import { companyInitials } from '../modules/trip-sheets/trip-sheet.template';

/**
 * แม่แบบ A4 ของเอกสารการเงิน (ST5-T08) — ใบแจ้งหนี้ + ใบสำคัญจ่ายรถร่วม (ST6-T04 `layout: stacked` ตาม #pv) · **ใบวางบิล (ST5-T11) ใช้แม่แบบเดียวกัน** (คอลัมน์/เส้นรวม/ลายเซ็นต่างกัน)
 * ตามต้นแบบ `design/prototype/TMS Print.dc.html` #bill / #inv (ค่า CSS/ข้อความจากต้นแบบ): หัวบริษัท + กล่องตัวย่อ,
 * ชื่อเอกสารไทย/อังกฤษ มุมขวา, กล่องลูกค้า 1.4fr + กล่องข้อมูล 1fr, ตารางหัว 2 ภาษา, จำนวนเงินตัวอักษร + เส้นรวม 300 px, ลายเซ็น 2 ช่อง
 * **D-54 บัญชีเบา: ไม่ใช่เอกสารภาษี** — แม่แบบนี้ไม่มีคำว่า "ใบกำกับภาษี" (test) · แบ่งหน้าเอง (spec/05 BIL-199 หัว/ท้ายซ้ำ + "หน้า n/N")
 */
export interface FinanceParty {
  name: string;
  taxId: string | null;
  /** "00000" = สำนักงานใหญ่ · null = ไม่ระบุ (บุคคลธรรมดา/ไม่มีเลขผู้เสียภาษี) */
  branchCode: string | null;
  address: string;
}

export interface FinanceColumn {
  th: string;
  en: string;
  align?: 'left' | 'right';
  /** ความกว้าง px (ไม่ส่ง = ยืด) */
  width?: number;
}

export interface FinanceTotal {
  label: string;
  value: string;
  /** เส้นรวมทั้งสิ้น (ตัวหนา + เส้นบน) */
  grand?: boolean;
  /** บรรทัดรอง (สีเทา — หัก ณ ที่จ่าย / ยอดสุทธิ ตามต้นแบบ) */
  muted?: boolean;
}

export interface FinanceDocument {
  yearStyle: 'BE' | 'CE';
  /** "ใบแจ้งหนี้" */
  title: string;
  /** "INVOICE" */
  titleEn: string;
  /** null = ร่าง (ยังไม่มีเลข — ลายน้ำ "ร่าง") */
  docNo: string | null;
  /** "ต้นฉบับ / Original" หรือ "สำเนา / Copy" — null = ไม่แสดง */
  copyLabel: string | null;
  /**
   * ลายน้ำทุกหน้าของเอกสารที่มีเลขแล้ว (D-61: เอกสารที่ออกใน sandbox = `SANDBOX_WATERMARK`) — ไม่ส่ง/null = ไม่มีลายน้ำ
   * ร่าง (`docNo` null) ใช้ลายน้ำ "ร่าง" เสมอ (ค่านี้ไม่มีผล) · "ยกเลิก" (spec/05 BIL-195 — ST5-T10)
   */
  watermark?: string | null;
  /** แบบลายน้ำ: `void` = ยกเลิก (แดง ตัวใหญ่), `sample` = sandbox (ข้อความยาว บรรทัดเดียว), `void-sample` = ยกเลิกใน sandbox · ไม่ส่ง = `void` */
  watermarkKind?: 'void' | 'sample' | 'void-sample';
  /** YYYY-MM-DD */
  docDate: string;
  issuer: FinanceParty;
  customer: FinanceParty;
  /** กล่องขวา: [ป้าย, ค่า (ข้อความธรรมดา), ตัวเลข?] */
  info: [string, string, boolean?][];
  columns: FinanceColumn[];
  /** HTML ของเซลล์ (escape แล้ว) ต่อแถว */
  rows: string[][];
  /** จำนวนเงินตัวอักษร (ไม่มี = ไม่แสดงกล่อง) */
  amountInWords: string | null;
  /** ข้อความเล็กใต้จำนวนเงินตัวอักษร (ข้อความธรรมดา) */
  notes: string[];
  /** คำเตือนสีแดงใต้จำนวนเงินตัวอักษร (เช่น ข้อมูลภาษีที่ยังขัดกัน — ร่างเท่านั้น) */
  warnings?: string[];
  totals: FinanceTotal[];
  /** ย่อหน้าใต้เส้นรวม (ข้อความธรรมดา) เช่น หมายเหตุของเอกสาร / วันนัดรับเช็ค */
  remarks: string[];
  signatures: { label: string; dated: boolean }[];
  /** ป้ายกล่องคู่ค้า (ไม่ส่ง = "ลูกค้า / Customer") — ใบสำคัญจ่าย = "จ่ายให้ / Pay to" (ST6-T04) */
  partyLabel?: string;
  /** บรรทัดเพิ่มท้ายกล่องคู่ค้า (ข้อความธรรมดา) เช่น "คนขับ …" ของใบสำคัญจ่าย */
  partyExtra?: string[];
  /**
   * ส่วนท้ายเอกสาร: `side` (ค่าเริ่ม — ใบแจ้งหนี้/ใบวางบิล: จำนวนเงินตัวอักษรซ้าย + เส้นรวม 300 px ขวา, ลายเซ็นห่าง 40 px)
   * · `stacked` (ใบสำคัญจ่าย TMS Print #pv: เส้นรวม 320 px ชิดขวาใต้ตาราง → กล่องจำนวนเงินตัวอักษรเต็มแถว, ลายเซ็นห่าง 24 px)
   */
  layout?: 'side' | 'stacked';
}

const e = escapeHtml;

/** D-61 ลายน้ำของเอกสารที่ออกใน sandbox (tenant `mode='test'`) — ทุกหน้า ต้นฉบับและสำเนา */
export const SANDBOX_WATERMARK = 'ตัวอย่าง — ใช้ไม่ได้จริง';

/** "00000" → "สำนักงานใหญ่" · "00001" → "สาขาที่ 00001" (spec/05 BIL-191) */
export function branchText(code: string | null): string {
  if (!code) return '';
  return code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`;
}

const partyName = (p: FinanceParty) =>
  `${e(p.name)}${p.branchCode ? ` (${e(branchText(p.branchCode))})` : ''}`;

/** "1234.5" → "1,234.50" · ติดลบใช้เครื่องหมายลบ */
export function bahtFormat(v: string): string {
  const [w, f = '00'] = v.split('.') as [string, string?];
  const neg = w.startsWith('-');
  const digits = (neg ? w.slice(1) : w).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}${digits}.${(f + '00').slice(0, 2)}`;
}

const MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

/** ช่วงวันที่แบบต้นแบบ: "16–31 ต.ค. 2569" / "16 ต.ค. – 3 พ.ย. 2569" / ข้ามปีเขียนเต็มทั้งสองฝั่ง */
export function dateRangeShort(from: string, to: string, yearStyle: 'BE' | 'CE'): string {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  if (from === to) return docDateShort(from, yearStyle);
  const y = ty + (yearStyle === 'BE' ? 543 : 0);
  if (fy === ty && fm === tm) return `${fd}–${td} ${MONTHS[tm - 1]} ${y}`;
  if (fy === ty) return `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]} ${y}`;
  return `${docDateShort(from, yearStyle)} – ${docDateShort(to, yearStyle)}`;
}

const TH = 'padding:8px 10px;font-weight:600;border-bottom:1px solid #D9DCD4;box-sizing:border-box';
const SUB = 'font-weight:400;font-size:13px;color:#3B424C';
const TD = 'padding:9px 10px;border-bottom:1px solid #E4E6E0;vertical-align:top';
const NUM = 'font-variant-numeric:tabular-nums;font-size:15px';

function headBlock(d: FinanceDocument): string {
  const i = d.issuer;
  const right = [
    `<span style="font-size:24px;font-weight:600;color:#13213F">${e(d.title)}</span>`,
    `<span style="font-size:14px;font-weight:500;color:#3B424C;">${e(d.titleEn)}</span>`,
    d.copyLabel ? `<span style="font-size:14px;color:#3B424C">${e(d.copyLabel)}</span>` : '',
    d.docNo
      ? `<span style="font-variant-numeric:tabular-nums;font-size:15px;font-weight:500">${e(d.docNo)}</span>`
      : `<span style="font-size:15px;font-weight:600;color:#8F5500">ร่าง · ยังไม่มีเลขที่</span>`,
    `<span style="font-size:15px">วันที่ ${e(docDateShort(d.docDate, d.yearStyle))}</span>`,
  ].join('');
  const c = d.customer;
  const extra = (d.partyExtra ?? []).map((x) => `<span>${e(x)}</span>`).join('');
  const info = d.info
    .map(
      ([l, v, num]) =>
        `<span style="color:#3B424C">${e(l)}</span><span${num ? ` style="${NUM}"` : ''}>${e(v)}</span>`,
    )
    .join('');
  return `<div class="head" style="display:flex;flex-direction:column;gap:20px">
<div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding-bottom:16px;border-bottom:2px solid #13213F">
<div style="display:flex;gap:12px"><div style="width:44px;height:44px;border-radius:10px;background:#13213F;color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-weight:600;flex-shrink:0">${e(companyInitials(i.name))}</div><div style="display:flex;flex-direction:column"><span style="font-weight:600;font-size:17px">${partyName(i)}</span>${
    i.address ? `<span style="font-size:14px;color:#3B424C">${e(i.address)}</span>` : ''
  }${i.taxId ? `<span style="font-size:14px;color:#3B424C">เลขประจำตัวผู้เสียภาษี ${e(i.taxId)}</span>` : ''}</div></div>
<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;text-align:right">${right}</div>
</div>
<div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px">
<div style="border:1px solid #D9DCD4;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px"><span style="font-size:14px;font-weight:500;color:#3B424C">${e(d.partyLabel ?? 'ลูกค้า / Customer')}</span><span style="font-weight:600">${partyName(c)}</span>${
    c.address ? `<span>${e(c.address)}</span>` : ''
  }${c.taxId ? `<span>เลขประจำตัวผู้เสียภาษี <span style="${NUM}">${e(c.taxId)}</span></span>` : ''}${extra}</div>
<div style="border:1px solid #D9DCD4;border-radius:10px;padding:12px 14px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 14px;align-content:start">${info}</div>
</div>
</div>`;
}

function contBlock(d: FinanceDocument): string {
  return `<div class="cont" style="display:flex;justify-content:space-between;gap:24px;align-items:flex-end;padding-bottom:10px;border-bottom:2px solid #13213F"><span style="font-weight:600;font-size:15px">${partyName(d.issuer)}</span><span style="font-size:15px"><b style="color:#13213F">${e(d.title)}</b> <span style="font-variant-numeric:tabular-nums;font-weight:500">${e(d.docNo ?? 'ร่าง')}</span> (ต่อ)</span></div>`;
}

function table(d: FinanceDocument): string {
  const align = (c: FinanceColumn) => `text-align:${c.align ?? 'left'}`;
  const head = d.columns
    .map(
      (c) =>
        `<th style="${TH};${align(c)}${c.width ? `;width:${c.width}px` : ''}">${e(c.th)}<div style="${SUB}">${e(c.en)}</div></th>`,
    )
    .join('');
  const body = d.rows
    .map(
      (r) =>
        `<tr>${r.map((cell, i) => `<td style="${TD};${align(d.columns[i]!)}">${cell}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:16px;table-layout:fixed"><thead><tr style="background:#EBEDE8">${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function endBlock(d: FinanceDocument): string {
  const totals = d.totals
    .map((t) => {
      const lbl = t.grand
        ? 'font-weight:600;padding-top:6px;border-top:1px solid #101418'
        : t.muted
          ? 'color:#3B424C'
          : '';
      const val = t.grand
        ? 'font-variant-numeric:tabular-nums;font-size:16px;font-weight:600;text-align:right;padding-top:6px;border-top:1px solid #101418'
        : `${NUM};text-align:right`;
      return `<span${lbl ? ` style="${lbl}"` : ''}>${e(t.label)}</span><span style="${val}">${e(t.value)}</span>`;
    })
    .join('');
  const words = d.amountInWords
    ? `<div style="background:#EBEDE8;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px"><span style="font-size:14px;color:#3B424C">จำนวนเงินตัวอักษร / Amount in words</span><span style="font-weight:600">${e(d.amountInWords)}</span></div>`
    : '';
  const left = [
    words,
    ...d.notes.map((n) => `<span style="font-size:14px;color:#3B424C">${e(n)}</span>`),
    ...(d.warnings ?? []).map(
      (w) =>
        `<span class="warn" style="font-size:14px;font-weight:600;color:#B3322A">${e(w)}</span>`,
    ),
  ].join('');
  const sig = d.signatures
    .map(
      (s) =>
        `<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:100%;height:56px;border-bottom:1px solid #101418"></div><span>${e(s.label)}</span>${
          s.dated
            ? `<span style="font-size:14px;color:#3B424C">วันที่ ...... / ...... / ......</span>`
            : ''
        }</div>`,
    )
    .join('');
  if (d.layout === 'stacked') {
    // TMS Print #pv: เส้นรวม 320 px ชิดขวา → จำนวนเงินตัวอักษรเต็มแถว → หมายเหตุ · ลายเซ็น gap 24
    const small = left.slice(words.length);
    return `<div class="end" style="display:flex;flex-direction:column;gap:20px">
<div style="display:flex;justify-content:flex-end"><div style="width:320px;display:grid;grid-template-columns:1fr auto;gap:4px 16px">${totals}</div></div>
${words}${small ? `<div style="display:flex;flex-direction:column;gap:4px">${small}</div>` : ''}
${d.remarks.map((r) => `<p style="margin:0;color:#3B424C">${e(r)}</p>`).join('')}
</div>
<div class="sig" style="display:grid;grid-template-columns:repeat(${d.signatures.length},1fr);gap:24px;padding-top:28px">${sig}</div>`;
  }
  return `<div class="end" style="display:flex;flex-direction:column;gap:20px">
<div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start">
<div style="flex:1;display:flex;flex-direction:column;gap:10px">${left}</div>
<div style="width:300px;display:grid;grid-template-columns:1fr auto;gap:4px 16px">${totals}</div>
</div>
${d.remarks.map((r) => `<p style="margin:0;color:#3B424C">${e(r)}</p>`).join('')}
</div>
<div class="sig" style="display:grid;grid-template-columns:repeat(${d.signatures.length},1fr);gap:40px;padding-top:28px">${sig}</div>`;
}

/**
 * ตัวแบ่งหน้า (รันใน Chromium หลังฟอนต์โหลด — PdfRenderer รอ `data-paged`) แบบเดียวกับใบคุมรถ (ST3-T20):
 * หน้า A4 สูงคงที่ · หน้าแรก = หัวเต็ม · หน้าต่อ = หัวย่อ "{ผู้ออก} · {ชื่อเอกสาร} {เลข} (ต่อ)" + หัวตาราง
 * แถวที่สูงเกินที่เหลือ → แยกตามหน่วยย่อย `.dob` (เช่น รายการ DO) ส่วนที่เหลือไปหน้าถัดไปเป็นแถว "(ต่อ)" (เฉพาะช่องที่มี `.desc`; `.mn` อยู่แถวแรก)
 * ไม่วางแถวอื่นซ้อนบนหน้าที่ยืด (review M1) — เลขหน้า x/y = จำนวนหน้า PDF จริง
 * เส้นรวม/ลายเซ็นอยู่หน้าสุดท้าย (ลายเซ็นชิดล่างตามต้นแบบ `margin-top:auto`) · ท้ายทุกหน้า "{เลข} · หน้า x/y"
 * เส้นรวม + ลายเซ็นไม่พอหน้าสุดท้าย → ย้ายแถวสุดท้าย 1 แถวไปหน้าใหม่พร้อมเส้นรวม/ลายเซ็น (ทุก layout — ใบสำคัญจ่าย/ใบแจ้งหนี้/ใบวางบิล):
 *   ไม่มีหน้าที่มีแต่เส้นรวม/ลายเซ็นโดยไม่มีรายการ และลายเซ็นไม่แยกจากยอดเงิน (UAT 24 พ.ย. 2569 + review L6 —
 *   [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้] spec/12 §3) · หน้านั้นมีแถวเดียว (แถวสูงผิดปกติ) = แบบเดิม (เส้นรวมขึ้นหน้าใหม่)
 *   · layout เท่านั้น ไม่แตะยอดเงิน/เลขเอกสาร/เนื้อหาภาษี
 */
const PAGINATE = `(function(){
function run(){
var FOOT=48;
var doc=document.querySelector('.fdoc');
var no=doc.getAttribute('data-no'),draft=doc.hasAttribute('data-draft'),wmText=draft?'ร่าง':doc.getAttribute('data-wm'),wmKind=doc.getAttribute('data-wm-kind')||'void';
var head=doc.querySelector('.head'),cont=doc.querySelector('.cont'),table=doc.querySelector('table'),end=doc.querySelector('.end'),sig=doc.querySelector('.sig');
var rows=[].slice.call(table.tBodies[0].rows);
var host=document.createElement('div');doc.parentNode.insertBefore(host,doc);doc.remove();
var pages=[],pg,inner,tbody;
function fits(){var last=inner.lastElementChild;if(!last)return true;var r=pg.getBoundingClientRect();return last.getBoundingClientRect().bottom<=r.top+pg.clientHeight-FOOT;}
function newPage(withTable){
  pg=document.createElement('section');pg.className='page';
  if(wmText){var w=document.createElement('div');w.className=draft?'wm':'wm wm--'+wmKind;w.textContent=wmText;pg.appendChild(w);}
  inner=document.createElement('div');inner.className='in';pg.appendChild(inner);
  var f=document.createElement('div');f.className='foot';pg.appendChild(f);host.appendChild(pg);pages.push(pg);
  inner.appendChild(pages.length===1?head:cont.cloneNode(true));
  tbody=null;
  if(withTable){var t=table.cloneNode(false);t.appendChild(table.tHead.cloneNode(true));tbody=document.createElement('tbody');t.appendChild(tbody);inner.appendChild(t);}
}
function pieces(row){return row.querySelectorAll('.dob').length;}
function cut(row,keep){
  var a=row.cloneNode(true);[].slice.call(a.querySelectorAll('.dob')).slice(keep).forEach(function(x){x.remove();});
  var b=row.cloneNode(true);[].slice.call(b.querySelectorAll('.dob')).slice(0,keep).forEach(function(x){x.remove();});
  [].slice.call(b.querySelectorAll('.mn')).forEach(function(x){x.remove();});
  [].slice.call(b.cells).forEach(function(td){if(!td.querySelector('.desc'))td.innerHTML='';});
  var d=b.querySelector('.desc');if(d&&!d.hasAttribute('data-cont')){d.setAttribute('data-cont','');d.insertAdjacentHTML('beforeend',' (ต่อ)');}
  return [a,b];
}
function place(row){
  tbody.appendChild(row);if(fits())return;row.remove();
  var n=pieces(row);
  if(n>1){
    var lo=0,hi=n-1,best=null;
    while(lo<hi){var mid=Math.ceil((lo+hi)/2);var ab=cut(row,mid);tbody.appendChild(ab[0]);var ok=fits();ab[0].remove();if(ok){lo=mid;best=ab;}else hi=mid-1;}
    if(best&&lo>=1){tbody.appendChild(best[0]);newPage(true);place(best[1]);return;}
  }
  if(tbody.rows.length===0){
    if(n>1){var c=cut(row,1);tbody.appendChild(c[0]);newPage(true);place(c[1]);return;}
    tbody.appendChild(row);pg.classList.add('grow');newPage(true);return;
  }
  newPage(true);place(row);
}
newPage(true);
rows.forEach(place);
if(tbody&&tbody.rows.length===0&&pages.length>1){pages.pop().remove();pg=pages[pages.length-1];inner=pg.querySelector('.in');}
inner.appendChild(end);inner.appendChild(sig);
if(!fits()){end.remove();sig.remove();if(tbody&&tbody.rows.length>1){var last=tbody.rows[tbody.rows.length-1];last.remove();newPage(true);tbody.appendChild(last);}else{newPage(false);}inner.appendChild(end);inner.appendChild(sig);}
pages.forEach(function(p,i){p.querySelector('.foot').textContent=no+' · หน้า '+(i+1)+'/'+pages.length;});
document.documentElement.setAttribute('data-paged','1');
}
document.fonts.ready.then(run);
})();`;

const CSS = `
.page{width:210mm;height:296mm;box-sizing:border-box;position:relative;overflow:hidden;break-after:page;display:flex;flex-direction:column}
.page.grow{height:auto;min-height:296mm;overflow:visible}
.page:last-child{break-after:auto}
.in{flex:1;min-width:0;overflow-wrap:break-word;padding:44px 48px 48px;display:flex;flex-direction:column;gap:20px;font-size:16px;line-height:1.6}
.in .sig{margin-top:auto}
.foot{position:absolute;left:48px;right:48px;bottom:18px;font-size:12px;color:#59606B;text-align:right;font-variant-numeric:tabular-nums}
.wm{position:absolute;top:38%;left:0;right:0;text-align:center;font-size:120px;font-weight:700;color:rgba(143,85,0,.08);transform:rotate(-24deg);letter-spacing:8px;pointer-events:none}.wm--void{color:rgba(179,50,42,.14)}
.wm--sample,.wm--void-sample{font-size:52px;letter-spacing:2px;white-space:nowrap;color:rgba(143,85,0,.14)}.wm--void-sample{color:rgba(179,50,42,.14)}
.in *{min-width:0}
.dob{display:inline-block;max-width:100%;margin-right:5px}.dob:not(:last-child)::after{content:','}
.fdoc .cont{display:none!important}.page .cont{display:flex!important}`;

/** HTML ของเอกสารการเงิน (แบ่งหน้าเอง) สำหรับ PdfRenderer */
export function financeDocument(d: FinanceDocument) {
  const no = d.docNo ?? 'ร่าง';
  const wm =
    d.docNo && d.watermark
      ? ` data-wm="${e(d.watermark)}"${d.watermarkKind && d.watermarkKind !== 'void' ? ` data-wm-kind="${d.watermarkKind}"` : ''}`
      : '';
  const body = `<div data-paginate><div class="fdoc" data-no="${e(no)}"${d.docNo ? '' : ' data-draft'}${wm}>${headBlock(d)}${contBlock(d)}${table(d)}${endBlock(d)}</div></div><script>${PAGINATE}</script>`;
  return { body, css: CSS, title: d.docNo ? `${d.title} ${d.docNo}` : `${d.title} (ร่าง)` };
}
