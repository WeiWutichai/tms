import { escapeHtml } from './pdf-renderer';
import { docDate } from './thai-date';

/**
 * เอกสารตัวอย่างสำหรับ golden test (ST0-T17) — ข้อความเลือกให้มีสระบน/ล่าง + วรรณยุกต์ซ้อน
 * (ปี่ ที่ น้ำ ปั้น ฎีกา ฐาน ญี่ปุ่น ฝั่ง เจ้าหน้าที่) ซึ่งเป็นจุดที่ฟอนต์/การ render มักทำให้ "ลอย" หรือซ้อนผิด
 * แม่แบบเอกสารจริง (ใบแจ้งหนี้/ใบกำกับภาษี/50 ทวิ) ทำใน ST5–ST6 ตาม design/prototype/TMS Print.dc.html
 */
export function sampleDocument(issued: Date, yearStyle: 'BE' | 'CE') {
  const rows = [
    ['ค่าขนส่งสินค้า กรุงเทพฯ → แหลมฉบัง (ยกเว้นภาษีมูลค่าเพิ่ม)', '6,500.00'],
    ['ค่าบริการยกขึ้น-ลง ณ ปลายทาง', '1,500.00'],
    ['ค่ารอที่คลังสินค้า ปั้นจั่นเสีย (เจ้าหน้าที่ฝั่งญี่ปุ่นยืนยัน)', '300.00'],
  ];
  const body = `
<div class="page">
  <header><div class="co">บริษัท ตัวอย่างขนส่ง จำกัด (สำนักงานใหญ่)</div><div class="ttl">ใบแจ้งหนี้ (ตัวอย่างทดสอบฟอนต์)</div></header>
  <p class="meta">วันที่ ${escapeHtml(docDate(issued, yearStyle))} · เลขประจำตัวผู้เสียภาษี 0000000000019</p>
  <p class="probe">ปี่ ที่ น้ำ ปั้น ปิ้ง ฎีกา ฐาน ญี่ปุ่น ฝั่ง กี่ ผู้ซื้อ เจ้าหน้าที่ ตรวจสอบ ฤๅษี ฦๅ ๑๒๓๔๕๖๗๘๙๐</p>
  <table>
    <thead><tr><th>รายการ</th><th class="r">จำนวนเงิน (บาท)</th></tr></thead>
    <tbody>${rows.map(([d, a]) => `<tr><td>${escapeHtml(d!)}</td><td class="r">${a}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>รวมทั้งสิ้น (แปดพันสามร้อยบาทถ้วน)</td><td class="r">8,300.00</td></tr></tfoot>
  </table>
</div>`;
  const css = `
.page{width:210mm;min-height:297mm;box-sizing:border-box;padding:16mm 16mm}
header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #13213F;padding-bottom:8px}
.co{font-weight:700;font-size:16px}.ttl{font-weight:600;font-size:20px;color:#13213F}
.meta{color:#3B424C;margin:8px 0}.probe{font-size:22px;line-height:1.7;margin:12px 0}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #CDD1C8;padding:6px 8px;text-align:left}
th{background:#EEF0EC;font-weight:600}.r{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:700}`;
  return { body, css, title: 'sample' };
}
