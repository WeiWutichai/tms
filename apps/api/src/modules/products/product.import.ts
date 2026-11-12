import { iEquals } from '../../common/ilike';
import { byCode, defineMasterImport, put } from '../imports/master-import';
import { CreateProductDto, HAZARD_CLASSES, UpdateProductDto } from './product.dto';
import type { ProductsService } from './products.service';

/** สินค้า (ST2-T10) — POST/PATCH /v1/products · หน่วยอ้างด้วยรหัส/ชื่อหน่วย (หน่วยแปลงเพิ่มเติมแก้ในหน้าจอ) */
export function productImportSpec(svc: ProductsService) {
  return defineMasterImport({
    kind: 'product',
    label: 'สินค้า',
    scope: 'master:write',
    modes: ['create_only', 'upsert_by_code', 'update_only'],
    createDto: CreateProductDto,
    updateDto: UpdateProductDto,
    identity: 'code',
    columns: [
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code', 'รหัสสินค้า', 'SKU'],
        example: 'P-0101',
        hint: 'ว่าง = ระบบออกเลขถัดไป',
      },
      {
        key: 'name',
        header: 'ชื่อสินค้า',
        aliases: ['Name', 'ชื่อ'],
        required: true,
        example: 'เม็ดพลาสติก PP (ตัวอย่าง)',
      },
      {
        key: 'unit',
        header: 'หน่วยหลัก',
        aliases: ['Unit', 'หน่วย'],
        required: true,
        fields: ['unitId'],
        example: 'BAG',
        hint: 'รหัสหรือชื่อหน่วย เช่น BAG / ถุง',
      },
      {
        key: 'customer',
        header: 'ลูกค้า',
        aliases: ['Customer'],
        fields: ['customerId'],
        example: 'CUS-0101',
        hint: 'ว่าง = ใช้ได้ทุกลูกค้า',
      },
      {
        key: 'weightPerUnitKg',
        header: 'น้ำหนักต่อหน่วย (กก.)',
        aliases: ['Weight'],
        example: '25',
        hint: 'บังคับเมื่อหน่วยเป็นชนิดนับ',
      },
      {
        key: 'volumePerUnitCbm',
        header: 'ปริมาตรต่อหน่วย (ลบ.ม.)',
        aliases: ['Volume'],
        example: '0.04',
      },
      {
        key: 'fragile',
        header: 'แตกง่าย',
        aliases: ['Fragile'],
        example: 'ไม่',
        options: ['ใช่', 'ไม่'],
      },
      {
        key: 'hazardous',
        header: 'สินค้าอันตราย',
        aliases: ['Hazardous'],
        example: 'ไม่',
        options: ['ใช่', 'ไม่'],
      },
      { key: 'unNumber', header: 'เลข UN', aliases: ['UN'], hint: '4 หลัก (สินค้าอันตราย)' },
      {
        key: 'hazardClass',
        header: 'ประเภทอันตราย',
        aliases: ['Hazard class'],
        options: [...HAZARD_CLASSES],
      },
      {
        key: 'tempControlled',
        header: 'ควบคุมอุณหภูมิ',
        aliases: ['Temp controlled'],
        example: 'ไม่',
        options: ['ใช่', 'ไม่'],
      },
      { key: 'tempMinC', header: 'อุณหภูมิต่ำสุด (°C)', aliases: ['Temp min'] },
      { key: 'tempMaxC', header: 'อุณหภูมิสูงสุด (°C)', aliases: ['Temp max'] },
      {
        key: 'stackable',
        header: 'วางซ้อนได้',
        aliases: ['Stackable'],
        example: 'ใช่',
        options: ['ใช่', 'ไม่'],
      },
      { key: 'barcode', header: 'บาร์โค้ด', aliases: ['Barcode'] },
      { key: 'externalId', header: 'รหัสในระบบอื่น', aliases: ['External ID', 'externalId'] },
    ],
    uniqueInFile: [{ column: 'code', label: 'รหัส', key: (v) => v.code?.toUpperCase() || null }],
    findExisting: byCode((tx, code) =>
      tx.product.findFirst({
        where: { code: iEquals(code), deletedAt: null },
        select: { id: true },
      }),
    ),
    async build(r, op) {
      const b: Record<string, unknown> = {};
      if (op === 'create') put(b, 'code', r.text('code') ?? undefined);
      put(b, 'name', r.text('name'));
      put(b, 'unitId', await r.ref('unit', 'unit'));
      put(b, 'customerId', await r.ref('customer', 'customer'));
      put(b, 'weightPerUnitKg', r.num('weightPerUnitKg'));
      put(b, 'volumePerUnitCbm', r.num('volumePerUnitCbm'));
      put(b, 'fragile', r.bool('fragile'));
      put(b, 'hazardous', r.bool('hazardous'));
      put(b, 'unNumber', r.text('unNumber'));
      put(b, 'hazardClass', r.text('hazardClass'));
      put(b, 'tempControlled', r.bool('tempControlled'));
      put(b, 'tempMinC', r.num('tempMinC'));
      put(b, 'tempMaxC', r.num('tempMaxC'));
      put(b, 'stackable', r.bool('stackable'));
      put(b, 'barcode', r.text('barcode'));
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    create: (dto) => svc.create(dto as CreateProductDto),
    update: (id, dto) => svc.update(id, dto as UpdateProductDto),
  });
}
