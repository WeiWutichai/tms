import { iEquals } from '../../common/ilike';
import { normalizeTaxId } from '../imports/import-spec';
import {
  byCode,
  defineMasterImport,
  group,
  mergeGroup,
  put,
  type MasterColumn,
  type RowReader,
} from '../imports/master-import';
import { CreateCustomerDto, UpdateCustomerDto } from './customer.dto';
import type { CustomersService } from './customers.service';

/** คอลัมน์ที่อยู่ร่วม (ลูกค้า/ผู้รับเหมา/สถานที่) — ตรงกับ CustomerAddressDto */
export const ADDRESS_COLUMNS = (prefix: string, line1Required = false): MasterColumn[] => [
  {
    key: 'addrLine1',
    header: 'ที่อยู่',
    aliases: ['Address', 'ที่อยู่ (บรรทัด 1)'],
    required: line1Required,
    fields: [`${prefix}.line1`],
    example: '99/1 ถ.บางนา-ตราด กม.5',
  },
  {
    key: 'addrSubdistrict',
    header: 'ตำบล/แขวง',
    aliases: ['ตำบล', 'แขวง', 'Subdistrict'],
    fields: [`${prefix}.subdistrict`],
    example: 'บางแก้ว',
  },
  {
    key: 'addrDistrict',
    header: 'อำเภอ/เขต',
    aliases: ['อำเภอ', 'เขต', 'District'],
    fields: [`${prefix}.district`],
    example: 'บางพลี',
  },
  {
    key: 'addrProvince',
    header: 'จังหวัด',
    aliases: ['Province'],
    fields: [`${prefix}.province`],
    example: 'สมุทรปราการ',
  },
  {
    key: 'addrPostcode',
    header: 'รหัสไปรษณีย์',
    aliases: ['Postcode', 'Zip'],
    fields: [`${prefix}.postcode`],
    example: '10540',
    hint: 'ตัวเลข 5 หลัก',
  },
];

export function readAddress(r: RowReader) {
  return group({
    line1: r.text('addrLine1'),
    subdistrict: r.text('addrSubdistrict'),
    district: r.text('addrDistrict'),
    province: r.text('addrProvince'),
    postcode: r.text('addrPostcode'),
  });
}

/** เลขผู้เสียภาษีจาก Excel (เติม 0 หน้าที่หาย + เตือน, ปฏิเสธรูปแบบวิทยาศาสตร์ — spec/02 §11.8) */
export function readTaxId(r: RowReader, key = 'taxId'): string | null | undefined {
  const v = r.text(key);
  if (typeof v !== 'string') return v;
  const t = normalizeTaxId(v);
  if (t.issue) {
    if (t.issue.severity === 'warning') r.warn(key, t.issue.code, t.issue.message);
    else return r.bad(key, t.issue.message);
  }
  return t.value;
}

/** รหัสสาขา 5 หลัก: "สำนักงานใหญ่" = 00000 · Excel ตัด 0 หน้า (เช่น 1) → เติมให้ครบ 5 หลัก */
export function readBranch(r: RowReader, key = 'branchCode'): string | null | undefined {
  const v = r.text(key);
  if (typeof v !== 'string') return v;
  if (/^(สำนักงานใหญ่|สนญ\.?|head ?office|ho)$/i.test(v)) return '00000';
  if (/^\d{1,4}$/.test(v)) return v.padStart(5, '0');
  return v;
}

/**
 * ผู้ติดต่อจากไฟล์ (1 คน = ผู้ติดต่อหลัก): สร้าง = รายการเดียว · แก้ = แก้เฉพาะผู้ติดต่อหลัก (ช่องว่างคงค่าเดิม)
 * ผู้ติดต่ออื่นคงไว้ (MD-284) · ล้างทุกช่อง = ลบผู้ติดต่อหลัก
 */
export function mergeContacts(
  current: unknown,
  given: Record<string, unknown> | null,
): Record<string, unknown>[] {
  const list = Array.isArray(current)
    ? (current as Record<string, unknown>[]).map((c) => ({ ...c }))
    : [];
  let i = list.findIndex((c) => c.isPrimary === true);
  if (i < 0 && list.length) i = 0;
  if (given === null) return i < 0 ? list : list.filter((_, j) => j !== i);
  if (i < 0) return [{ ...stripNull(given), isPrimary: true }];
  const merged = mergeGroup(list[i], given);
  if (!merged) return list.filter((_, j) => j !== i);
  list[i] = { ...merged, isPrimary: true };
  return list;
}
const stripNull = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

const CYCLES = {
  PER_DO: ['ต่อเที่ยว', 'ต่อ DO'],
  WEEKLY: ['รายสัปดาห์'],
  MONTHLY: ['รายเดือน'],
  MANUAL: ['กำหนดเอง'],
};
const VAT = {
  EXEMPT_TRANSPORT: ['ยกเว้น VAT', 'ยกเว้น', 'ค่าขนส่งยกเว้น VAT'],
  VAT_7: ['VAT 7%', '7%'],
};
const WHT = { '1.00': ['1%', '1'], '0.00': ['ไม่หัก', '0%', '0'] };
const label = (m: Record<string, string[]>) => Object.values(m).map((l) => l[0]!);

/** ลูกค้า (ST2-T01) — POST/PATCH /v1/customers */
export function customerImportSpec(svc: CustomersService) {
  return defineMasterImport({
    kind: 'customer',
    label: 'ลูกค้า',
    scope: 'master:write',
    modes: ['create_only', 'upsert_by_code', 'update_only'],
    createDto: CreateCustomerDto,
    updateDto: UpdateCustomerDto,
    identity: 'code',
    // ต้นแบบ vWiz: รหัส · ชื่อ · เลขผู้เสียภาษี · สาขา · เครดิต แล้วจึงคอลัมน์เพิ่ม
    columns: [
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code', 'รหัสลูกค้า'],
        example: 'CUS-0101',
        hint: 'ว่าง = ระบบออกเลขถัดไป · โหมดแก้ไขใช้หารายการเดิม',
      },
      {
        key: 'legalName',
        header: 'ชื่อ',
        aliases: ['Name', 'ชื่อลูกค้า', 'ชื่อตามจดทะเบียน'],
        required: true,
        example: 'บจก. ตัวอย่างพลาสติก',
      },
      {
        key: 'taxId',
        header: 'เลขผู้เสียภาษี',
        aliases: ['Tax ID', 'เลขประจำตัวผู้เสียภาษี'],
        example: '0105561000013',
        hint: 'ตัวเลข 13 หลัก (ตั้งคอลัมน์เป็นข้อความ)',
      },
      {
        key: 'branchCode',
        header: 'สาขา',
        aliases: ['Branch', 'รหัสสาขา'],
        example: '00000',
        hint: '00000 = สำนักงานใหญ่',
      },
      {
        key: 'creditTermDays',
        header: 'เครดิต',
        aliases: ['Credit', 'เครดิต (วัน)'],
        fields: ['creditTermDays'],
        example: '30',
        hint: 'จำนวนวัน 0–365',
      },
      {
        key: 'billingCycle',
        header: 'รอบวางบิล',
        aliases: ['Billing cycle'],
        example: 'รายเดือน',
        options: label(CYCLES),
      },
      {
        key: 'creditLimit',
        header: 'วงเงินเครดิต',
        aliases: ['Credit limit'],
        example: '500000',
        hint: 'บาท',
      },
      {
        key: 'defaultVatType',
        header: 'VAT ตั้งต้น',
        aliases: ['VAT'],
        example: 'ยกเว้น VAT',
        options: label(VAT),
      },
      {
        key: 'whtExpectedRate',
        header: 'หัก ณ ที่จ่าย',
        aliases: ['WHT'],
        example: '1%',
        options: label(WHT),
      },
      {
        key: 'vatRegistered',
        header: 'จดทะเบียน VAT',
        aliases: ['VAT registered'],
        example: 'ใช่',
        options: ['ใช่', 'ไม่'],
      },
      ...ADDRESS_COLUMNS('billingAddress'),
      {
        key: 'contactName',
        header: 'ผู้ติดต่อ',
        aliases: ['Contact'],
        fields: ['contacts.name'],
        example: 'คุณสมชาย',
      },
      {
        key: 'contactPhone',
        header: 'เบอร์ผู้ติดต่อ',
        aliases: ['Phone', 'เบอร์โทร'],
        fields: ['contacts.phone'],
        example: '0812345678',
      },
      {
        key: 'contactEmail',
        header: 'อีเมลผู้ติดต่อ',
        aliases: ['Email', 'อีเมล'],
        fields: ['contacts.email'],
        example: 'ap@example.co.th',
      },
      {
        key: 'externalId',
        header: 'รหัสในระบบอื่น',
        aliases: ['External ID', 'externalId'],
        example: 'ERP-C-0101',
      },
    ],
    uniqueInFile: [
      { column: 'code', label: 'รหัส', key: (v) => v.code?.toUpperCase() || null },
      {
        column: 'taxId',
        label: 'เลขผู้เสียภาษี + สาขา',
        key: (v) =>
          v.taxId
            ? `${normalizeTaxId(v.taxId).value ?? v.taxId}:${v.branchCode?.padStart(5, '0') || '00000'}`
            : null,
      },
    ],
    findExisting: byCode((tx, code) =>
      tx.customer.findFirst({
        where: { code: iEquals(code), deletedAt: null },
        select: { id: true },
      }),
    ),
    current: (id, tx) => tx.customer.findUnique({ where: { id } }),
    async build(r, op, cur) {
      const b: Record<string, unknown> = {};
      if (op === 'create') put(b, 'code', r.text('code') ?? undefined);
      put(b, 'legalName', r.text('legalName'));
      put(b, 'taxId', readTaxId(r));
      put(b, 'branchCode', readBranch(r));
      put(b, 'creditTermDays', r.int('creditTermDays'));
      put(b, 'billingCycle', r.pick('billingCycle', CYCLES));
      put(b, 'creditLimit', r.decimal('creditLimit'));
      put(b, 'defaultVatType', r.pick('defaultVatType', VAT));
      put(b, 'whtExpectedRate', r.pick('whtExpectedRate', WHT));
      put(b, 'vatRegistered', r.bool('vatRegistered'));
      put(
        b,
        'billingAddress',
        op === 'update' ? mergeGroup(cur?.billingAddress, readAddress(r)) : readAddress(r),
      );
      const contact = group({
        name: r.text('contactName'),
        phone: r.text('contactPhone'),
        email: r.text('contactEmail'),
      });
      if (contact !== undefined)
        b.contacts = mergeContacts(op === 'update' ? cur?.contacts : [], contact);
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    create: (dto) => svc.create(dto as CreateCustomerDto),
    update: (id, dto) => svc.update(id, dto as UpdateCustomerDto),
  });
}
