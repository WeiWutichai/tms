/**
 * ค้นข้อมูลบริษัทจากหน่วยงานภายนอก (P1-ST2-T04; spec/01 PLT-021/023; research/company-verification §2.2, §7)
 * interface กลาง — ผู้ให้บริการ: `rd` (SOAP กรมสรรพากร) · `mock` (ข้อมูลตัวอย่างในเครื่อง — dev/test/E2E) · `disabled`
 */

/** ที่อยู่แยกฟิลด์ (spec/01 §2 ขั้น 2: เลขที่ หมู่ ซอย ถนน แขวง/ตำบล เขต/อำเภอ จังหวัด รหัสไปรษณีย์) */
export interface CompanyAddress {
  houseNo: string;
  moo: string;
  soi: string;
  street: string;
  subDistrict: string;
  district: string;
  province: string;
  postalCode: string;
}

export const ADDRESS_KEYS: ReadonlyArray<keyof CompanyAddress> = [
  'houseNo',
  'moo',
  'soi',
  'street',
  'subDistrict',
  'district',
  'province',
  'postalCode',
];

/** ข้อมูลผู้จด VAT ที่ normalize แล้ว (research §7.3) */
export interface RegistryCompany {
  /** คำนำหน้า + ชื่อ เช่น "บริษัท ตัวอย่างขนส่ง จำกัด" */
  legalName: string;
  branchNumber: number;
  /** ชื่อสาขาตามทะเบียน (ถ้ามี) */
  branchName: string | null;
  address: CompanyAddress;
  /** วันที่อนุมัติเป็นผู้จด VAT (YYYY-MM-DD) ถ้ามี */
  vatRegisteredSince: string | null;
}

export type VatAnswer =
  | { found: true; company: RegistryCompany; raw: string; httpStatus: number | null }
  | { found: false; raw: string; httpStatus: number | null };

export interface TinAnswer {
  exists: boolean;
  raw: string;
  httpStatus: number | null;
}

/** ความล้มเหลวของปลายทาง (timeout / 5xx / เครือข่าย / ตอบผิดรูป) — นับใน circuit breaker */
export class RegistryUnavailable extends Error {
  constructor(
    readonly code: 'timeout' | 'http_error' | 'network' | 'bad_response' | 'soap_fault',
    readonly httpStatus: number | null = null,
  ) {
    super(code);
  }
}

export interface CompanyRegistry {
  /** ชื่อผู้ให้บริการ (ลงใน log + cache) */
  readonly provider: 'rd' | 'mock';
  /** RD VAT Service `Service` — TIN + BranchNumber */
  vat(taxId: string, branchNumber: number, signal: AbortSignal): Promise<VatAnswer>;
  /** RD TIN Service `ServiceTIN` — มีเลขในฐานสรรพากรไหม */
  tin(taxId: string, signal: AbortSignal): Promise<TinAnswer>;
}
