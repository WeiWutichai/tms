import { iEquals } from '../../common/ilike';
import { byCode, defineMasterImport, put } from '../imports/master-import';
import { CreateDriverDto, UpdateDriverDto } from './driver.dto';
import type { DriversService } from './drivers.service';

const TYPES = {
  EMPLOYEE_SALARIED: ['พขร.มีเงินเดือน', 'พนักงานประจำ', 'มีเงินเดือน'],
  EMPLOYEE_PER_TRIP: ['พขร.ไม่มีเงินเดือน', 'รายเที่ยว', 'ไม่มีเงินเดือน'],
  CARRIER_DRIVER: ['รถร่วม', 'คนขับรถร่วม'],
};
const LICENCE = {
  PERSONAL: ['ส่วนบุคคล'],
  T1: ['ท.1', 'ท1'],
  T2: ['ท.2', 'ท2'],
  T3: ['ท.3', 'ท3'],
  T4: ['ท.4', 'ท4'],
};
const label = (m: Record<string, string[]>) => Object.values(m).map((l) => l[0]!);

/**
 * คนขับ (ST2-T08) — POST/PATCH /v1/drivers · เลขบัตรประชาชน: service เข้ารหัส + blind index (ซ้ำ = 409 เหมือน API)
 * รายงานตรวจ/ไฟล์แถวผิดแสดง 4 หลักท้ายเท่านั้น
 */
export function driverImportSpec(svc: DriversService) {
  return defineMasterImport({
    kind: 'driver',
    label: 'คนขับ',
    scope: 'master:write',
    modes: ['create_only', 'upsert_by_code', 'update_only'],
    createDto: CreateDriverDto,
    updateDto: UpdateDriverDto,
    identity: 'code',
    // ต้นแบบ vWiz: ชื่อ · เบอร์ · ประเภท · ใบขับขี่ · หมดอายุ
    columns: [
      {
        key: 'name',
        header: 'ชื่อ',
        aliases: ['Name', 'ชื่อ-นามสกุล'],
        required: true,
        example: 'นายทดลอง ขับดี',
      },
      {
        key: 'phone',
        header: 'เบอร์',
        aliases: ['Mobile', 'Phone', 'เบอร์โทร'],
        required: true,
        example: '0891234567',
      },
      {
        key: 'employmentType',
        header: 'ประเภท',
        aliases: ['Type'],
        required: true,
        example: 'พขร.มีเงินเดือน',
        options: label(TYPES),
      },
      {
        key: 'licenceClass',
        header: 'ใบขับขี่',
        aliases: ['License', 'ประเภทใบขับขี่'],
        required: true,
        example: 'ท.2',
        options: label(LICENCE),
      },
      {
        key: 'licenceExpiresOn',
        header: 'หมดอายุ',
        aliases: ['Exp', 'ใบขับขี่หมดอายุ'],
        required: true,
        example: '31/12/2570',
        hint: 'DD/MM/YYYY (พ.ศ. หรือ ค.ศ.)',
      },
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code', 'รหัสคนขับ'],
        example: 'DRV-0101',
        hint: 'ว่าง = ระบบออกเลขถัดไป',
      },
      { key: 'licenceNo', header: 'เลขที่ใบขับขี่', aliases: ['License no'], example: '12345678' },
      {
        key: 'nationalId',
        header: 'เลขบัตรประชาชน',
        aliases: ['National ID'],
        sensitive: true,
        example: '1050000003024',
        hint: '13 หลัก (เก็บแบบเข้ารหัส)',
      },
      {
        key: 'carrier',
        header: 'ผู้รับเหมา',
        aliases: ['Carrier', 'Vendor'],
        fields: ['carrierId'],
        hint: 'คนขับรถร่วมต้องระบุ (รหัสหรือชื่อผู้รับเหมา)',
      },
      {
        key: 'defaultVehicle',
        header: 'รถประจำ',
        aliases: ['Vehicle'],
        fields: ['defaultVehicleId'],
        hint: 'ทะเบียนรถ',
      },
      { key: 'externalId', header: 'รหัสในระบบอื่น', aliases: ['External ID', 'externalId'] },
    ],
    uniqueInFile: [
      { column: 'code', label: 'รหัส', key: (v) => v.code?.toUpperCase() || null },
      {
        column: 'phone',
        label: 'เบอร์',
        key: (v) => v.phone?.replace(/[\s-]/g, '').replace(/^\+66/, '0') || null,
      },
    ],
    findExisting: byCode((tx, code) =>
      tx.driver.findFirst({
        where: { code: iEquals(code), deletedAt: null },
        select: { id: true },
      }),
    ),
    async build(r, op) {
      const b: Record<string, unknown> = {};
      if (op === 'create') put(b, 'code', r.text('code') ?? undefined);
      put(b, 'name', r.text('name'));
      put(b, 'phone', r.text('phone'));
      put(b, 'employmentType', r.pick('employmentType', TYPES));
      put(b, 'licenceClass', r.pick('licenceClass', LICENCE));
      put(b, 'licenceExpiresOn', r.date('licenceExpiresOn'));
      put(b, 'licenceNo', r.text('licenceNo'));
      put(b, 'nationalId', r.text('nationalId'));
      put(b, 'carrierId', await r.ref('carrier', 'carrier'));
      put(b, 'defaultVehicleId', await r.ref('defaultVehicle', 'vehicle'));
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    create: (dto) => svc.create(dto as CreateDriverDto),
    update: (id, dto) => svc.update(id, dto as UpdateDriverDto),
  });
}
