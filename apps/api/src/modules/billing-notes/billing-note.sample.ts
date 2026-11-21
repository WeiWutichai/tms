import type { BillingNotePrintModel } from './billing-note.template';

/**
 * ใบวางบิลตัวอย่างสำหรับ golden test (ST5-T11) + ภาพเทียบ "ต้นแบบ | ของจริง" — ข้อมูลสมมติ (ชื่อตามต้นแบบ TMS Print #bill)
 * 1. ออกแล้ว (เลข + ต้นฉบับ) พ.ศ. — 3 ใบแจ้งหนี้ (เกณฑ์ตรวจรับ "รวม 3 ใบแจ้งหนี้เป็นใบวางบิล 1 ใบ ยอดรวมตรง")
 * 2. ร่าง ค.ศ. 40 ใบแจ้งหนี้ — หลายหน้า (หัวย่อ "(ต่อ)" + หัวตารางซ้ำ + "หน้า x/y")
 */
const ISSUER = {
  name: 'บริษัท ศรีไทยขนส่ง จำกัด',
  taxId: '0105556078912',
  branchCode: '00000',
  address: '88/12 ถนนบางนา-ตราด กม. 12 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540',
};
const CUSTOMER = {
  name: 'บริษัท สยามพลาสติก จำกัด',
  taxId: '0105536012345',
  branchCode: '00000',
  address: '11 หมู่ 2 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540',
};

export function sampleBillingNote(): BillingNotePrintModel {
  return {
    yearStyle: 'BE',
    billingNoteNo: 'BN-2611-0013',
    copy: 'ORIGINAL',
    billingDate: '2026-11-03',
    collectionDate: '2026-12-03',
    issuer: ISSUER,
    customer: CUSTOMER,
    invoices: [
      {
        invoiceNo: 'INV-00000-2610-0041',
        issueDate: '2026-10-16',
        dueDate: '2026-11-15',
        total: '7000.00',
        outstanding: '7000.00',
      },
      {
        invoiceNo: 'INV-00000-2610-0047',
        issueDate: '2026-10-25',
        dueDate: '2026-11-24',
        total: '12194.50',
        outstanding: '12194.50',
      },
      {
        invoiceNo: 'INV-00000-2611-0002',
        issueDate: '2026-11-01',
        dueDate: '2026-12-01',
        total: '6550.00',
        outstanding: '6550.00',
      },
    ],
    total: '25744.50',
    whtExpected: '256.50',
    netExpected: '25488.00',
    note: null,
  };
}

export function sampleBillingNoteLong(): BillingNotePrintModel {
  const invoices = Array.from({ length: 40 }, (_, i) => {
    const d = String(1 + (i % 28)).padStart(2, '0');
    const amt = (4800 + i * 125).toFixed(2);
    return {
      invoiceNo: `INV-00001-2611-${String(i + 1).padStart(4, '0')}`,
      issueDate: `2026-11-${d}`,
      dueDate: `2026-12-${d}`,
      total: amt,
      outstanding: amt,
    };
  });
  const cents = invoices.reduce((a, i) => a + Math.round(Number(i.total) * 100), 0);
  return {
    yearStyle: 'CE',
    billingNoteNo: null,
    copy: null,
    billingDate: '2026-11-30',
    collectionDate: '2026-12-15',
    issuer: { ...ISSUER, branchCode: '00001' },
    customer: { ...CUSTOMER, branchCode: '00001' },
    invoices,
    total: (cents / 100).toFixed(2),
    whtExpected: '0.00',
    netExpected: (cents / 100).toFixed(2),
    note: 'กรุณาโอนเข้าบัญชีบริษัท และส่งหลักฐานการโอนพร้อมหนังสือรับรองการหักภาษี ณ ที่จ่ายทางอีเมล',
  };
}

/** D-61: ใบวางบิลที่ออกใน sandbox (รวมใบแจ้งหนี้ `TEST-`) — ลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" */
export function sampleBillingNoteSandbox(): BillingNotePrintModel {
  const m = sampleBillingNote();
  return {
    ...m,
    sandbox: true,
    invoices: m.invoices.map((i) => ({ ...i, invoiceNo: `TEST-${i.invoiceNo}` })),
  };
}
