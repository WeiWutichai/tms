import type { SettlementPrintModel, SettlementPrintTrip } from './settlement-pdf.template';

/**
 * ใบสำคัญจ่ายตัวอย่าง 3 แบบสำหรับ golden test (ST6-T04) + ภาพเทียบ "ต้นแบบ | ของจริง"
 * ข้อมูลสมมติ (ชื่อ/ยอดตามต้นแบบ TMS Print #pv)
 * 1. จ่ายแล้ว (พ.ศ.) — 3 เที่ยว หัก ณ ที่จ่าย 1% + เงินเบิก — ยอดเท่ากับต้นแบบ #pv (15,550.00 − 155.50 − 2,000.00 = 13,394.50)
 * 2. ร่าง (ลายน้ำ ไม่มีเลข) — 1% + 3% + หักหลายชนิด · บุคคลธรรมดา (เลขผู้เสียภาษีเห็น 4 หลักท้าย) · ไม่ระบุคนขับ (หลายคน)
 * 3. หลายหน้า (ค.ศ. · อนุมัติแล้ว ยังไม่จ่าย) 40 เที่ยว
 */
const PAYER = {
  name: 'บริษัท ศรีไทยขนส่ง จำกัด',
  taxId: '0105556078912',
  branchCode: '00000',
  address: '',
};

const trip = (
  tripNo: string,
  date: string,
  route: string,
  tripFee: string,
  siteExpenses: string,
): SettlementPrintTrip => ({ tripNo, date, route, tripFee, siteExpenses });

export function sampleSettlementPaid(): SettlementPrintModel {
  return {
    yearStyle: 'BE',
    settlementNo: 'SA-2610-0008',
    docDate: '2026-10-29',
    payer: PAYER,
    payee: { name: 'ห้างหุ้นส่วนจำกัด ทรัพย์สมบูรณ์ขนส่ง', taxId: '0103556012345' },
    driver: 'ไพโรจน์ สายทอง',
    periodFrom: '2026-10-01',
    periodTo: '2026-10-15',
    paymentMethod: 'TRANSFER',
    paymentReference: 'KBANK-2610-8841',
    trips: [
      trip('TRP-2610-0300', '2026-10-04', 'กรุงเทพ → ชลบุรี', '5100.00', '180.00'),
      trip('TRP-2610-0301', '2026-10-06', 'อยุธยา → สระบุรี', '4300.00', '350.00'),
      trip('TRP-2610-0302', '2026-10-08', 'กรุงเทพ → ชลบุรี', '5100.00', '520.00'),
    ],
    gross: '15550.00',
    whtByRate: [{ rate: '1.00', amount: '155.50' }],
    whtTotal: '155.50',
    deductions: [{ type: 'CASH_ADVANCE', amount: '2000.00' }],
    net: '13394.50',
  };
}

export function sampleSettlementDraft(): SettlementPrintModel {
  // 1%: 4,200 + 6,950 = 11,150 → 111.50 · 3% (ค่าบริการยก): 1,200 → 36.00 · หัก 2,000 + 450 + 300
  return {
    yearStyle: 'BE',
    settlementNo: null,
    docDate: '2026-11-18',
    payer: PAYER,
    payee: { name: 'นายสมชาย ใจดี', taxId: 'XXXXXXXXX4521' },
    driver: null,
    periodFrom: '2026-11-01',
    periodTo: '2026-11-15',
    paymentMethod: null,
    paymentReference: null,
    trips: [
      trip('TRP-2611-0112', '2026-11-03', 'บางนา → อมตะซิตี้ ชลบุรี', '4200.00', '1200.00'),
      trip('TRP-2611-0177', '2026-11-12', 'ลาดกระบัง → สระบุรี', '6500.00', '450.00'),
    ],
    gross: '12350.00',
    whtByRate: [
      { rate: '1.00', amount: '111.50' },
      { rate: '3.00', amount: '36.00' },
    ],
    whtTotal: '147.50',
    deductions: [
      { type: 'CASH_ADVANCE', amount: '2000.00' },
      { type: 'FUEL_PROVIDED', amount: '450.00' },
      { type: 'FINE', amount: '300.00' },
    ],
    net: '9452.50',
  };
}

export function sampleSettlementLong(): SettlementPrintModel {
  const trips: SettlementPrintTrip[] = [];
  for (let i = 0; i < 40; i++) {
    const day = 1 + (i % 28);
    trips.push(
      trip(
        `TRP-2611-${String(400 + i).padStart(4, '0')}`,
        `2026-11-${String(day).padStart(2, '0')}`,
        i % 2 ? 'กรุงเทพ → ชลบุรี' : 'อยุธยา → สระบุรี',
        i % 2 ? '5100.00' : '4300.00',
        i % 3 ? '0.00' : '250.00',
      ),
    );
  }
  // Σ ค่าเที่ยว 20×5,100 + 20×4,300 = 188,000 · หน้างาน 14×250 = 3,500 → 191,500 · 1% = 1,915.00
  return {
    yearStyle: 'CE',
    settlementNo: 'SA-2611-0021',
    docDate: '2026-11-30',
    payer: PAYER,
    payee: { name: 'ห้างหุ้นส่วนจำกัด ทรัพย์สมบูรณ์ขนส่ง', taxId: '0103556012345' },
    driver: 'ไพโรจน์ สายทอง',
    periodFrom: '2026-11-01',
    periodTo: '2026-11-28',
    paymentMethod: null,
    paymentReference: null,
    trips,
    gross: '191500.00',
    whtByRate: [{ rate: '1.00', amount: '1915.00' }],
    whtTotal: '1915.00',
    deductions: [{ type: 'DAMAGE', amount: '3000.00' }],
    net: '186585.00',
  };
}
