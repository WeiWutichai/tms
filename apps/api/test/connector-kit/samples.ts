import { randomUUID } from 'node:crypto';
import {
  type CanonicalInvoicePayload,
  type CanonicalSettlementPayload,
  withSyncHash,
} from '../../src/modules/erp/canonical';
import type { ErpContext } from '../../src/modules/erp/erp-adapter';

/**
 * P1-ST5-T01 canonical ตัวอย่างที่ชุด conformance และ test ของ adapter ใช้ร่วมกัน (ย้ายมาจาก test ของ adapter แต่ละตัว)
 * ข้อมูลสมมติทั้งหมด — ไม่ใช่ลูกค้า/บุคคลจริง
 */

// ---------- AccountSystem (ST8-T16) ----------

export const sampleInvoice = (n = 1): CanonicalInvoicePayload =>
  withSyncHash({
    kind: 'invoice',
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    number: `INV-00000-2611-${String(n).padStart(4, '0')}`,
    issueDate: '2026-11-21',
    dueDate: '2026-12-21',
    issuer: {
      companyId: 'c',
      branchId: 'b',
      branchCode: '00000',
      legalName: 'บริษัท ผู้ออกบิล จำกัด',
      taxId: '0105555000009',
      address: '9 ถนนตัวอย่าง กรุงเทพฯ 10110',
    },
    customer: {
      id: 'cus',
      code: 'C-0001',
      legalName: 'บริษัท ลูกค้า จำกัด',
      taxId: '0105555000001',
      branchCode: '00000',
      externalId: null,
      billingAddress: '1 ถนนตัวอย่าง ชลบุรี 20000',
      paymentTermDays: 30,
    },
    customerPoNo: null,
    references: { customerRef: [] },
    totals: {
      subtotalVatable: '350.00',
      subtotalExempt: '1750.00',
      subtotalZeroRated: '0.00',
      vatAmount: '24.50',
      total: '2124.50',
      whtExpected: '21.00',
    },
    taxEstimated: true,
    lines: [
      {
        lineNo: 1,
        deliveryOrder: { id: 'do1', number: 'DO-2611-0001', date: '2026-11-20' },
        salesOrder: { number: 'SO-2611-0001', externalId: null },
        trip: {
          number: 'TR-2611-0001',
          vehiclePlate: '70-1234',
          driverName: 'สมชาย ตัวอย่าง',
          carrierName: null,
        },
        route: { originName: 'ชลบุรี', destinationName: 'ระยอง' },
        serviceItem: { id: 'si1', code: 'FREIGHT', externalId: 'FRT' },
        description: 'ค่าขนส่ง ชลบุรี → ระยอง',
        quantity: '5.000',
        unitLabel: 'ตัน',
        unitPrice: '350.0000',
        discount: '0.00',
        amount: '1750.00',
        vatType: 'EXEMPT_TRANSPORT',
        vatAmount: '0.00',
        whtRate: '1.00',
        accountCode: null,
      },
      {
        lineNo: 2,
        deliveryOrder: null,
        salesOrder: null,
        trip: null,
        route: null,
        serviceItem: { id: 'si2', code: 'LIFT', externalId: null },
        description: 'ค่ายกขน',
        quantity: '1',
        unitLabel: 'งาน',
        unitPrice: '400.123456',
        discount: '50.00',
        amount: '350.00',
        vatType: 'VAT_7',
        vatAmount: '24.50',
        whtRate: '3.00',
        accountCode: null,
      },
    ],
  });

export const sampleSettlement = (n = 1): CanonicalSettlementPayload =>
  withSyncHash({
    kind: 'settlement',
    id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    number: `SA-2026-${String(n).padStart(4, '0')}`,
    paidDate: '2026-11-21',
    payingCompanyId: null,
    period: { from: '2026-11-01', to: '2026-11-15' },
    carrierInvoiceNumber: 'CV-889',
    carrier: {
      id: 'car',
      code: 'SUB-0001',
      legalName: 'นายรถร่วม ใจดี',
      taxId: null,
      branchCode: null,
      entityType: 'INDIVIDUAL',
    },
    payment: { method: 'TRANSFER', reference: 'KBANK-1', bank: 'กสิกรไทย' },
    totals: {
      gross: '9000.00',
      deduction: '2000.00',
      net: '7000.00',
      wht: '90.00',
      netAfterWht: '6910.00',
    },
    whtEstimate: {
      pndForm: 'PND3',
      byRate: [{ whtRate: '1.00', base: '9000.00', amount: '90.00' }],
      reviewedByAccountant: false,
    },
    taxEstimated: true,
    lines: [
      {
        lineNo: 1,
        lineType: 'FREIGHT',
        trip: { number: 'TRP-0001' },
        deliveryOrders: [{ number: 'DO-0001' }, { number: 'DO-0002' }],
        description: 'ค่าจ้างรถ',
        amount: '9000.00',
        vatType: 'EXEMPT_TRANSPORT',
        whtRate: '1.00',
        whtAmount: '90.00',
      },
      {
        lineNo: 2,
        lineType: 'DEDUCTION',
        trip: null,
        deliveryOrders: [],
        description: 'เงินเบิกล่วงหน้า',
        amount: '-2000.00',
        vatType: null,
        whtRate: null,
        whtAmount: null,
      },
    ],
  });

// ---------- KRS (ST8-T08) ----------

/** ST8-T08 ใบตัวอย่าง (canonical) สำหรับ contract — รายการผูก DO ครบตามสัญญา KRS */
export function krsContractInvoice() {
  const id = randomUUID();
  return {
    id,
    number: `INV-CONTRACT-${id.slice(0, 8)}`,
    issueDate: '2026-11-19',
    dueDate: '2026-12-19',
    customer: {
      externalId: 'C001',
      legalName: 'ลูกค้า ทดสอบ',
      paymentTermDays: 30,
      billingAddress: 'กรุงเทพฯ',
    },
    lines: [
      {
        lineNo: 1,
        deliveryOrder: { number: 'DO-0001', date: '2026-11-19' },
        trip: { vehiclePlate: '70-1234', driverName: 'คนขับ', carrierName: null },
        route: { originName: 'ต้นทาง', destinationName: 'ปลายทาง' },
        serviceItem: { externalId: null },
        quantity: '1',
        unitLabel: 'เที่ยว',
        unitPrice: '1000',
        discount: '0.00',
        amount: '1000.00',
        vatType: 'EXEMPT_TRANSPORT',
      },
    ],
  };
}

/** ผังรหัสที่ core ตรวจแล้ว (ST8-T06) สำหรับ contract */
export function krsContractContext(): Pick<ErpContext, 'masterCodes'> {
  return {
    masterCodes: {
      CUSTOMER: new Map([['c001', { code: 'C001', name: null }]]),
      UNIT: new Map([['เที่ยว', { code: 'เที่ยว', name: 'เที่ยว', fromCatalogue: true }]]),
      SALESPERSON: new Map([['s001', { code: 'S001', name: 'พนักงานขาย', fromCatalogue: true }]]),
    },
  };
}
