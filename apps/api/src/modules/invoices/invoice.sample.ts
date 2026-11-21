import { taxOptionsFromSettings } from '@tms/domain';
import { invoiceTotals, type InvoicePrintLine, type InvoicePrintModel } from './invoice.template';

/**
 * ใบแจ้งหนี้ตัวอย่าง 3 แบบสำหรับ golden test (ST5-T08) + ภาพเทียบ "ต้นแบบ | ของจริง"
 * ข้อมูลสมมติ (ชื่อตามต้นแบบ TMS Print) · ยอดภาษีจาก computeDocumentTax (ขั้นต่ำ WHT ค่าเริ่ม 0)
 * 1. ยกเว้นล้วน — ออกแล้ว (เลข + ต้นฉบับ) พ.ศ. ลูกค้าสำนักงานใหญ่
 * 2. ปน (ยกเว้น + 7% + ส่วนลด) — ร่าง (ลายน้ำ ไม่มีเลข) ลูกค้า "สาขาที่ 00001" + PO + หมายเหตุ — ยอดเท่ากับต้นแบบ #inv
 * 3. หลายหน้า — ออกแล้ว ค.ศ. 36 บรรทัด
 */
const OPTS = taxOptionsFromSettings({ whtMinimumAmount: 0 });

const ISSUER = {
  name: 'บริษัท ศรีไทยขนส่ง จำกัด',
  taxId: '0105556078912',
  branchCode: '00000',
  address: '88/12 ถนนบางนา-ตราด กม. 12 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540',
  vatRegistered: true,
};

function model(
  base: Omit<InvoicePrintModel, 'totals' | 'issuer'>,
  whtPercent: (l: InvoicePrintLine) => string,
): InvoicePrintModel {
  return {
    ...base,
    issuer: ISSUER,
    totals: invoiceTotals(
      base.lines.map((l) => ({ amount: l.amount, vatType: l.vatType, whtRate: whtPercent(l) })),
      OPTS,
    ),
  };
}

const freight = (
  no: number,
  doNo: string,
  route: string,
  plate: string,
  amount: string,
): InvoicePrintLine => ({
  no,
  description: `ค่าขนส่งสินค้า ${route}`,
  deliveryOrders: [{ doNo, plate }],
  quantity: '1',
  unitLabel: 'เที่ยว',
  unitPrice: amount,
  discount: '0.00',
  amount,
  vatType: 'EXEMPT_TRANSPORT',
});

export function sampleInvoiceExempt(): InvoicePrintModel {
  return model(
    {
      yearStyle: 'BE',
      invoiceNo: 'INV-2611-0013',
      copy: 'ORIGINAL',
      issueDate: '2026-11-03',
      dueDate: '2026-12-03',
      customer: {
        name: 'บริษัท สยามพลาสติก จำกัด',
        taxId: '0105536012345',
        branchCode: '00000',
        address: '11 หมู่ 2 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540',
      },
      periodFrom: '2026-10-16',
      periodTo: '2026-11-03',
      creditTermDays: 30,
      customerPoNo: null,
      note: null,
      lines: [
        freight(1, 'DO-2611-00020', 'กรุงเทพ → ชลบุรี', '70-1234 กทม.', '6500.00'),
        freight(2, 'DO-2611-00023', 'กรุงเทพ → ชลบุรี', '70-1234 กทม.', '6500.00'),
        freight(3, 'DO-2611-00026', 'บางปู → แหลมฉบัง', '71-5678 กทม.', '4800.00'),
        freight(4, 'DO-2611-00029', 'กรุงเทพ → ชลบุรี', '70-1234 กทม.', '6500.00'),
      ],
    },
    () => '1.00',
  );
}

export function sampleInvoiceMixed(): InvoicePrintModel {
  return model(
    {
      yearStyle: 'BE',
      invoiceNo: null,
      copy: null,
      issueDate: '2026-11-03',
      dueDate: '2026-12-03',
      customer: {
        name: 'บริษัท เอ็นเอสเอฟ อินดัสทรี จำกัด',
        taxId: '0105548076543',
        branchCode: '00001',
        address: '33 หมู่ 4 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540',
      },
      periodFrom: '2026-10-16',
      periodTo: '2026-10-31',
      creditTermDays: 30,
      customerPoNo: 'PO-NSF-26-0458',
      note: 'โอนเข้าบัญชีบริษัทตามที่แจ้งไว้ แล้วส่งหลักฐานการโอนทางอีเมลฝ่ายบัญชี',
      lines: [
        {
          no: 1,
          description: 'ค่าขนส่งสินค้า บางปู → แหลมฉบัง',
          deliveryOrders: [
            { doNo: 'DO-2610-00101', plate: '70-1234 กทม.' },
            { doNo: 'DO-2610-00104', plate: '70-1234 กทม.' },
            { doNo: 'DO-2610-00109', plate: '71-5678 กทม.' },
          ],
          quantity: '8',
          unitLabel: 'เที่ยว',
          unitPrice: '7250.00',
          discount: '400.00',
          amount: '57600.00',
          vatType: 'EXEMPT_TRANSPORT',
        },
        {
          no: 2,
          description: 'ค่าแรงลงสินค้า',
          deliveryOrders: [{ doNo: 'DO-2610-00104', plate: null }],
          quantity: '4',
          unitLabel: 'ครั้ง',
          unitPrice: '500.00',
          discount: '0.00',
          amount: '2000.00',
          vatType: 'VAT_7',
        },
      ],
    },
    () => '1.00',
  );
}

export function sampleInvoiceLong(): InvoicePrintModel {
  const routes = [
    'กรุงเทพ → ชลบุรี',
    'บางปู → แหลมฉบัง',
    'ลาดกระบัง → ระยอง',
    'สมุทรสาคร → นครปฐม',
  ];
  const lines: InvoicePrintLine[] = [];
  for (let i = 0; i < 36; i++) {
    const no = i + 1;
    if (i % 6 === 5)
      lines.push({
        no,
        description: 'ค่าบริการยกขึ้น-ลง ณ ปลายทาง',
        deliveryOrders: [{ doNo: `DO-2611-${String(200 + i).padStart(5, '0')}`, plate: null }],
        quantity: '2',
        unitLabel: 'ครั้ง',
        unitPrice: '350.00',
        discount: '0.00',
        amount: '700.00',
        vatType: 'VAT_7',
      });
    else
      lines.push(
        freight(
          no,
          `DO-2611-${String(200 + i).padStart(5, '0')}`,
          routes[i % routes.length]!,
          i % 2 ? '70-1234 กทม.' : '71-5678 กทม.',
          (4800 + (i % 4) * 850).toFixed(2),
        ),
      );
  }
  return model(
    {
      yearStyle: 'CE',
      invoiceNo: 'INV-2611-0027',
      copy: 'COPY',
      issueDate: '2026-11-30',
      dueDate: '2026-12-30',
      customer: {
        name: 'บริษัท สยามพลาสติก จำกัด',
        taxId: '0105536012345',
        branchCode: '00000',
        address: '11 หมู่ 2 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540',
      },
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
      creditTermDays: 30,
      customerPoNo: 'PO-2611-778',
      note: null,
      lines,
    },
    (l) => (l.vatType === 'VAT_7' ? '3.00' : '1.00'),
  );
}

/** D-61: ใบที่ออกใน sandbox — เลข `TEST-` + ลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" (หลายหน้า: ลายน้ำทุกหน้า) */
export function sampleInvoiceSandbox(): InvoicePrintModel {
  return {
    ...sampleInvoiceLong(),
    invoiceNo: 'TEST-INV-00000-2611-0001',
    copy: 'ORIGINAL',
    sandbox: true,
  };
}
