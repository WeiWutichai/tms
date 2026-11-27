import {
  type CompanyAddress,
  type CompanyRegistry,
  type RegistryCompany,
  RegistryUnavailable,
  type TinAnswer,
  type VatAnswer,
} from './types';

/**
 * RD Web Services (SOAP 1.2) ของกรมสรรพากร — research/company-verification §2.2 [FACT]:
 * - VAT Service `https://rdws.rd.go.th/serviceRD3/vatserviceRD3.asmx` operation `Service`
 *   (username/password = `anonymous`, TIN, ProvinceCode, BranchNumber, AmphurCode — 0 ถ้าไม่รู้)
 *   ผลลัพธ์: NID, BranchNumber, คำนำหน้า + ชื่อ, ที่อยู่แยกฟิลด์, BusinessFirstDate
 * - TIN Service `https://rdws.rd.go.th/serviceRD3/checktinpinservice.asmx` operation `ServiceTIN`
 * - `Content-Type: application/soap+xml; charset=utf-8`
 *
 * ชื่อ element ของผลลัพธ์ (vNID, vtitleName, vName, vBranchNumber, vHouseNumber, …, vIsExist, vmsgerr) ตามรูปที่ library
 * โอเพนซอร์ส `borisat` ใช้ — **ต้องยืนยันกับ WSDL จริงจากเครื่องในไทยก่อน go-live (research §8 ข้อ 1)**:
 * parser จึงไม่ผูก namespace/prefix และอ่านค่าใน `<anyType>` ได้ทั้งแบบห่อและไม่ห่อ
 *
 * ในสภาพแวดล้อมนี้ **ไม่เรียกปลายทางจริง** — ค่าเริ่ม `COMPANY_LOOKUP_PROVIDER` = mock (dev/test) / disabled (นอกนั้น)
 * test/E2E ชี้ URL มาที่ mock SOAP server ในเครื่อง (`test/mock-rd-soap.ts`)
 */
export const RD_VAT_URL = 'https://rdws.rd.go.th/serviceRD3/vatserviceRD3.asmx';
export const RD_TIN_URL = 'https://rdws.rd.go.th/serviceRD3/checktinpinservice.asmx';
export const RD_VAT_NS = 'https://rdws.rd.go.th/serviceRD3/vatserviceRD3';
export const RD_TIN_NS = 'https://rdws.rd.go.th/serviceRD3/checktinpinservice';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function envelope(op: string, ns: string, params: Record<string, string>): string {
  const body = Object.entries(params)
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
    `<soap12:Body><${op} xmlns="${esc(ns)}">${body}</${op}></soap12:Body></soap12:Envelope>`
  );
}

export function vatRequestXml(taxId: string, branchNumber: number, ns = RD_VAT_NS): string {
  return envelope('Service', ns, {
    username: 'anonymous',
    password: 'anonymous',
    TIN: taxId,
    ProvinceCode: '0',
    BranchNumber: String(branchNumber),
    AmphurCode: '0',
  });
}

export function tinRequestXml(taxId: string, ns = RD_TIN_NS): string {
  return envelope('ServiceTIN', ns, { username: 'anonymous', password: 'anonymous', TIN: taxId });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : ENTITIES[e.toLowerCase()]!,
  );

/** ค่าข้อความของ element ตามชื่อ (ไม่สน prefix) — ค่าใน `<anyType>` ตัวแรก · "-" / ว่าง = null */
export function soapField(xml: string, name: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${name}>)`,
  );
  const m = re.exec(xml);
  if (!m || m[1] === undefined) return null;
  let inner = m[1];
  const any =
    /<(?:[A-Za-z_][\w.-]*:)?anyType\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?anyType>)/.exec(
      inner,
    );
  if (any) inner = any[1] ?? '';
  const v = decode(inner.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return v === '' || v === '-' ? null : v;
}

const s = (v: string | null) => v ?? '';
const join = (...xs: Array<string | null>) => xs.filter(Boolean).join(' ');

/** แปลงผล VAT Service → ข้อมูล normalize · ไม่พบ (ไม่มี vNID / มี vmsgerr) = null */
export function parseVatResponse(xml: string): RegistryCompany | null {
  if (/<(?:[\w.-]+:)?Fault\b/.test(xml)) throw new RegistryUnavailable('soap_fault');
  if (!/<(?:[\w.-]+:)?ServiceResult\b|<(?:[\w.-]+:)?ServiceResponse\b/.test(xml))
    throw new RegistryUnavailable('bad_response');
  const nid = soapField(xml, 'vNID');
  if (!nid || soapField(xml, 'vmsgerr')) return null;
  const title = soapField(xml, 'vtitleName');
  const name = soapField(xml, 'vName');
  const surname = soapField(xml, 'vSurname');
  if (!name) return null;
  const address: CompanyAddress = {
    houseNo: join(
      soapField(xml, 'vHouseNumber'),
      soapField(xml, 'vBuildingName') && `อาคาร${soapField(xml, 'vBuildingName')}`,
      soapField(xml, 'vRoomNumber') && `ห้อง ${soapField(xml, 'vRoomNumber')}`,
      soapField(xml, 'vFloorNumber') && `ชั้น ${soapField(xml, 'vFloorNumber')}`,
      soapField(xml, 'vVillageName') && `หมู่บ้าน${soapField(xml, 'vVillageName')}`,
    ),
    moo: s(soapField(xml, 'vMooNumber')),
    soi: s(soapField(xml, 'vSoiName')),
    street: s(soapField(xml, 'vStreetName')),
    subDistrict: s(soapField(xml, 'vThambol')),
    district: s(soapField(xml, 'vAmphur')),
    province: s(soapField(xml, 'vProvince')),
    postalCode: s(soapField(xml, 'vPostCode')),
  };
  const first = soapField(xml, 'vBusinessFirstDate');
  const d = first ? /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(first) : null;
  return {
    legalName: join(title, name, surname),
    branchNumber: Number(soapField(xml, 'vBranchNumber') ?? '0') || 0,
    branchName: soapField(xml, 'vBranchName'),
    address,
    vatRegisteredSince: d ? `${d[1]}-${d[2]!.padStart(2, '0')}-${d[3]!.padStart(2, '0')}` : null,
  };
}

/** แปลงผล TIN Service → มีเลขในฐานสรรพากรไหม */
export function parseTinResponse(xml: string): boolean {
  if (/<(?:[\w.-]+:)?Fault\b/.test(xml)) throw new RegistryUnavailable('soap_fault');
  if (!/ServiceTINResult\b|ServiceTINResponse\b/.test(xml))
    throw new RegistryUnavailable('bad_response');
  const v = soapField(xml, 'vIsExist');
  if (!v) return false;
  if (/^(true|1|y|yes)$/i.test(v)) return true;
  // ข้อความไทย เช่น "มีอยู่จริง" / "ไม่มีอยู่จริง"
  return v.includes('มี') && !v.includes('ไม่');
}

export interface RdSoapOptions {
  vatUrl: string;
  tinUrl: string;
  fetch?: typeof fetch;
}

export class RdSoapRegistry implements CompanyRegistry {
  readonly provider = 'rd' as const;
  private readonly fetch: typeof fetch;
  constructor(private readonly opt: RdSoapOptions) {
    this.fetch = opt.fetch ?? fetch;
  }

  private async post(url: string, xml: string, signal: AbortSignal) {
    let res: Response;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
        body: xml,
        signal,
        redirect: 'error',
      });
    } catch {
      throw new RegistryUnavailable(signal.aborted ? 'timeout' : 'network');
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new RegistryUnavailable(signal.aborted ? 'timeout' : 'network', res.status);
    }
    if (!res.ok) throw new RegistryUnavailable('http_error', res.status);
    return { text, status: res.status };
  }

  async vat(taxId: string, branchNumber: number, signal: AbortSignal): Promise<VatAnswer> {
    const r = await this.post(this.opt.vatUrl, vatRequestXml(taxId, branchNumber), signal);
    const company = parseVatResponse(r.text);
    return company
      ? { found: true, company, raw: r.text, httpStatus: r.status }
      : { found: false, raw: r.text, httpStatus: r.status };
  }

  async tin(taxId: string, signal: AbortSignal): Promise<TinAnswer> {
    const r = await this.post(this.opt.tinUrl, tinRequestXml(taxId), signal);
    return { exists: parseTinResponse(r.text), raw: r.text, httpStatus: r.status };
  }
}
