import { iEquals } from '../../common/ilike';
import { byCode, defineMasterImport, put } from '../imports/master-import';
import { CreateServiceItemDto, UpdateServiceItemDto } from './service-item.dto';
import type { ServiceItemsService } from './service-items.service';

const UNITS = {
  PER_TRIP: ['ต่อเที่ยว', 'เที่ยว'],
  PER_HOUR: ['ต่อชั่วโมง', 'ชั่วโมง'],
  PER_NIGHT: ['ต่อคืน', 'คืน'],
  PER_STOP: ['ต่อจุด', 'จุด'],
  PERCENT_OF_FREIGHT: ['% ของค่าขนส่ง', '%'],
  ACTUAL: ['ตามจริง'],
};
const VAT = {
  EXEMPT_TRANSPORT: ['ยกเว้น VAT', 'ยกเว้น'],
  VAT_7: ['VAT 7%', '7%'],
  ZERO_RATED: ['VAT 0%', '0%'],
};
const WHT = { '0.00': ['ไม่หัก', '0%', '0'], '1.00': ['1%', '1'], '3.00': ['3%', '3'] };
const SIDES = {
  BOTH: ['ทั้งสองฝั่ง', 'ทั้งคู่'],
  SELL: ['ฝั่งขาย', 'ขาขาย', 'ลูกค้า'],
  BUY: ['ฝั่งซื้อ', 'ขาซื้อ', 'รถร่วม'],
};
const label = (m: Record<string, string[]>) => Object.values(m).map((l) => l[0]!);

/**
 * ค่าบริการเสริม (ST2-T11) — POST/PATCH /v1/service-items · รหัสสงวนของระบบ (FREIGHT …) → 422 reserved_code จาก service
 * vat_type / wht_rate ตั้งต้นของบรรทัด (ค่าจริงอยู่ที่บรรทัดเอกสาร) — ห้ามแต่งกฎภาษีเอง: ค่าที่รับ = enum เดียวกับ API
 */
export function serviceItemImportSpec(svc: ServiceItemsService) {
  return defineMasterImport({
    kind: 'service_item',
    label: 'ค่าบริการเสริม',
    scope: 'master:write',
    modes: ['create_only', 'upsert_by_code', 'update_only'],
    createDto: CreateServiceItemDto,
    updateDto: UpdateServiceItemDto,
    identity: 'code',
    columns: [
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code'],
        example: 'AX-0101',
        hint: 'ว่าง = ระบบออกเลขถัดไป',
      },
      {
        key: 'name',
        header: 'ชื่อรายการ',
        aliases: ['Name', 'ชื่อ'],
        required: true,
        example: 'ค่ายกสินค้าขึ้นชั้น (ตัวอย่าง)',
      },
      {
        key: 'calcUnit',
        header: 'หน่วยคิด',
        aliases: ['Unit'],
        required: true,
        example: 'ต่อเที่ยว',
        options: label(UNITS),
      },
      {
        key: 'vatType',
        header: 'VAT',
        aliases: ['VAT type'],
        required: true,
        example: 'VAT 7%',
        options: label(VAT),
      },
      {
        key: 'whtRate',
        header: 'หัก ณ ที่จ่าย',
        aliases: ['WHT'],
        required: true,
        example: '3%',
        options: label(WHT),
      },
      {
        key: 'defaultPrice',
        header: 'ราคาตั้งต้น',
        aliases: ['Price', 'ราคา (฿)'],
        example: '300',
        hint: 'บาท ก่อน VAT · % ของค่าขนส่ง = เปอร์เซ็นต์ · ตามจริงเว้นว่าง',
      },
      {
        key: 'side',
        header: 'ใช้กับ',
        aliases: ['Side'],
        example: 'ทั้งสองฝั่ง',
        options: label(SIDES),
      },
      {
        key: 'isSurcharge',
        header: 'ค่าใช้จ่ายเพิ่ม',
        aliases: ['Surcharge'],
        example: 'ใช่',
        options: ['ใช่', 'ไม่'],
      },
      { key: 'condition', header: 'เงื่อนไข', aliases: ['Condition'] },
      { key: 'nameEn', header: 'ชื่อภาษาอังกฤษ', aliases: ['Name (EN)'] },
      { key: 'defaultAccountCode', header: 'รหัสบัญชี', aliases: ['Account code'] },
      { key: 'externalId', header: 'รหัสในระบบอื่น', aliases: ['External ID', 'externalId'] },
    ],
    uniqueInFile: [
      { column: 'code', label: 'รหัส', key: (v) => v.code?.toUpperCase() || null },
      { column: 'name', label: 'ชื่อรายการ', key: (v) => v.name?.toLowerCase() || null },
    ],
    findExisting: byCode((tx, code) =>
      tx.serviceItem.findFirst({
        where: { code: iEquals(code), deletedAt: null },
        select: { id: true },
      }),
    ),
    async build(r, op) {
      const b: Record<string, unknown> = {};
      if (op === 'create') put(b, 'code', r.text('code') ?? undefined);
      put(b, 'name', r.text('name'));
      put(b, 'calcUnit', r.pick('calcUnit', UNITS));
      put(b, 'vatType', r.pick('vatType', VAT));
      put(b, 'whtRate', r.pick('whtRate', WHT));
      put(b, 'defaultPrice', r.decimal('defaultPrice'));
      put(b, 'side', r.pick('side', SIDES));
      put(b, 'isSurcharge', r.bool('isSurcharge'));
      put(b, 'condition', r.text('condition'));
      put(b, 'nameEn', r.text('nameEn'));
      put(b, 'defaultAccountCode', r.text('defaultAccountCode'));
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    create: (dto) => svc.create(dto as CreateServiceItemDto),
    update: (id, dto) => svc.update(id, dto as UpdateServiceItemDto),
  });
}
