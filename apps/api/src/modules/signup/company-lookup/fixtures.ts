import { parseTinResponse, parseVatResponse } from './rd-soap';
import { type CompanyRegistry, RegistryUnavailable, type TinAnswer, type VatAnswer } from './types';

/**
 * ข้อมูลตัวอย่างของผู้ให้บริการ `mock` และ mock SOAP server (`test/mock-rd-soap.ts`) — **ไม่ใช่ข้อมูลจริงของบริษัทใด**
 * เลขทุกตัว checksum ถูก (PLT-020) · 0105567153766 = เลขในเกณฑ์ตรวจรับ spec/01 §2 ข้อ 9 (ชื่อ/ที่อยู่เป็นตัวอย่างจาก research §7.3)
 */
export interface VatFixture {
  title: string;
  name: string;
  branchNumber: number;
  branchName?: string;
  houseNo: string;
  moo?: string;
  soi?: string;
  street?: string;
  thambol: string;
  amphur: string;
  province: string;
  postCode: string;
  businessFirstDate: string;
}

export const RD_FIXTURE_VAT: Record<string, VatFixture[]> = {
  '0105567153766': [
    {
      title: 'บริษัท',
      name: 'ตัวอย่างขนส่ง จำกัด',
      branchNumber: 0,
      branchName: 'สำนักงานใหญ่',
      houseNo: '99/1',
      moo: '4',
      street: 'พระราม 2',
      thambol: 'แสมดำ',
      amphur: 'บางขุนเทียน',
      province: 'กรุงเทพมหานคร',
      postCode: '10150',
      businessFirstDate: '2024-05-02',
    },
    {
      title: 'บริษัท',
      name: 'ตัวอย่างขนส่ง จำกัด',
      branchNumber: 1,
      branchName: 'สาขาบางนา',
      houseNo: '12',
      soi: 'บางนา-ตราด 25',
      street: 'บางนา-ตราด',
      thambol: 'บางนา',
      amphur: 'บางนา',
      province: 'กรุงเทพมหานคร',
      postCode: '10260',
      businessFirstDate: '2025-01-15',
    },
  ],
};
/** มีในฐาน TIN แต่ไม่จด VAT → กรอกเอง + หนังสือรับรอง (pending_manual) */
export const RD_FIXTURE_TIN_ONLY = new Set(['0105569000011']);
/** เลขที่ mock ตอบ 503 เสมอ (ทดลอง RD ล่ม / circuit breaker ในเครื่อง) */
export const RD_FIXTURE_DOWN = new Set(['0105569000037']);

const x = (tag: string, v: string | number | undefined) =>
  `<${tag}><anyType xsi:type="xsd:string">${v === undefined || v === '' ? '-' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</anyType></${tag}>`;

/** XML ผลลัพธ์ VAT Service ตามรูปที่คาด (rd-soap.ts) */
export function vatResponseXml(taxId: string, f: VatFixture | null): string {
  const inner = f
    ? x('vNID', taxId) +
      x('vtitleName', f.title) +
      x('vName', f.name) +
      x('vSurname', '-') +
      x('vBranchTitleName', f.branchName) +
      x('vBranchName', f.branchName) +
      x('vBranchNumber', f.branchNumber) +
      x('vBuildingName', '-') +
      x('vFloorNumber', '-') +
      x('vVillageName', '-') +
      x('vRoomNumber', '-') +
      x('vHouseNumber', f.houseNo) +
      x('vMooNumber', f.moo) +
      x('vSoiName', f.soi) +
      x('vStreetName', f.street) +
      x('vThambol', f.thambol) +
      x('vAmphur', f.amphur) +
      x('vProvince', f.province) +
      x('vPostCode', f.postCode) +
      x('vBusinessFirstDate', f.businessFirstDate.replace(/-/g, '/')) +
      '<vmsgerr xsi:nil="true" />'
    : x('vmsgerr', 'ไม่พบข้อมูล');
  return soap(
    `<ServiceResponse xmlns="https://rdws.rd.go.th/serviceRD3/vatserviceRD3"><ServiceResult>${inner}</ServiceResult></ServiceResponse>`,
  );
}

export function tinResponseXml(taxId: string, exists: boolean): string {
  return soap(
    `<ServiceTINResponse xmlns="https://rdws.rd.go.th/serviceRD3/checktinpinservice"><ServiceTINResult>${x('vNID', taxId)}${x('vDigitOk', 'true')}${x('vIsExist', exists ? 'true' : 'false')}<vmsgerr xsi:nil="true" /></ServiceTINResult></ServiceTINResponse>`,
  );
}

const soap = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body>${body}</soap:Body></soap:Envelope>`;

export const fixtureVat = (taxId: string, branchNumber: number): VatFixture | null =>
  RD_FIXTURE_VAT[taxId]?.find((f) => f.branchNumber === branchNumber) ?? null;
export const fixtureTinExists = (taxId: string): boolean =>
  !!RD_FIXTURE_VAT[taxId] || RD_FIXTURE_TIN_ONLY.has(taxId);

/** ผู้ให้บริการ `mock` (ในเครื่อง ไม่มีเครือข่าย) — สร้าง XML รูปเดียวกับ RD แล้ว parse ด้วยตัวเดียวกับ `rd` */
export class MockRegistry implements CompanyRegistry {
  readonly provider = 'mock' as const;
  async vat(taxId: string, branchNumber: number): Promise<VatAnswer> {
    if (RD_FIXTURE_DOWN.has(taxId)) throw new RegistryUnavailable('http_error', 503);
    const raw = vatResponseXml(taxId, fixtureVat(taxId, branchNumber));
    const company = parseVatResponse(raw);
    return company
      ? { found: true, company, raw, httpStatus: 200 }
      : { found: false, raw, httpStatus: 200 };
  }
  async tin(taxId: string): Promise<TinAnswer> {
    if (RD_FIXTURE_DOWN.has(taxId)) throw new RegistryUnavailable('http_error', 503);
    const raw = tinResponseXml(taxId, fixtureTinExists(taxId));
    return { exists: parseTinResponse(raw), raw, httpStatus: 200 };
  }
}
