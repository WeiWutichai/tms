import { iEquals } from '../../common/ilike';
import { ADDRESS_COLUMNS, readAddress } from '../customers/customer.import';
import { byCode, defineMasterImport, group, mergeGroup, put } from '../imports/master-import';
import { CreateSiteDto, UpdateSiteDto } from './site.dto';
import type { SitesService } from './sites.service';

const KINDS = {
  PICKUP: ['ต้นทาง', 'จุดรับ'],
  DROPOFF: ['ปลายทาง', 'จุดส่ง'],
  WAREHOUSE: ['คลัง / ศูนย์กระจาย', 'คลัง', 'ศูนย์กระจาย'],
};
const CLASSES = {
  '6W': ['6 ล้อ'],
  '10W': ['10 ล้อ'],
  TRAILER: ['พ่วง'],
  SEMI_TRAILER: ['เทรลเลอร์'],
};
const label = (m: Record<string, string[]>) => Object.values(m).map((l) => l[0]!);

/** สถานที่ / จุดรับส่ง (ST2-T02) — POST/PATCH /v1/customer-sites */
export function siteImportSpec(svc: SitesService) {
  return defineMasterImport({
    kind: 'customer_site',
    label: 'สถานที่',
    scope: 'master:write',
    modes: ['create_only', 'upsert_by_code', 'update_only'],
    createDto: CreateSiteDto,
    updateDto: UpdateSiteDto,
    identity: 'code',
    columns: [
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code', 'รหัสสถานที่'],
        example: 'LOC-0101',
        hint: 'ว่าง = ระบบออกเลขถัดไป',
      },
      {
        key: 'name',
        header: 'ชื่อสถานที่',
        aliases: ['ชื่อ', 'Name', 'Site'],
        required: true,
        example: 'คลังบางนา (ตัวอย่าง)',
      },
      {
        key: 'kind',
        header: 'ประเภท',
        aliases: ['Kind', 'Type'],
        example: 'ปลายทาง',
        options: label(KINDS),
      },
      {
        key: 'customer',
        header: 'ลูกค้า',
        aliases: ['Customer', 'รหัสลูกค้า'],
        fields: ['customerId'],
        example: 'CUS-0101',
        hint: 'รหัสหรือชื่อลูกค้าที่ตรงตัว · ว่าง = จุดของบริษัทเอง',
      },
      ...ADDRESS_COLUMNS('address', true),
      { key: 'lat', header: 'ละติจูด', aliases: ['Lat', 'Latitude'], example: '13.6447' },
      { key: 'lng', header: 'ลองจิจูด', aliases: ['Lng', 'Longitude'], example: '100.6800' },
      {
        key: 'openTime',
        header: 'เวลาเปิด',
        aliases: ['Open'],
        example: '08:00',
        hint: 'HH:MM',
      },
      { key: 'closeTime', header: 'เวลาปิด', aliases: ['Close'], example: '17:00' },
      {
        key: 'maxVehicleClass',
        header: 'รถใหญ่สุดที่เข้าได้',
        aliases: ['Max vehicle'],
        example: '10 ล้อ',
        options: label(CLASSES),
        hint: 'ว่าง = ไม่จำกัด',
      },
      {
        key: 'serviceTimeMin',
        header: 'เวลาขึ้น/ลงของ (นาที)',
        aliases: ['Service time'],
        example: '45',
      },
      { key: 'dockCount', header: 'ช่องโหลด', aliases: ['Docks'], example: '4' },
      {
        key: 'contactName',
        header: 'ผู้ติดต่อ',
        aliases: ['Contact'],
        fields: ['contact.name'],
        example: 'คุณวิชัย',
      },
      {
        key: 'contactPhone',
        header: 'เบอร์ผู้ติดต่อ',
        aliases: ['Phone', 'เบอร์โทร'],
        fields: ['contact.phone'],
        example: '0898765432',
      },
      {
        key: 'aliases',
        header: 'ชื่อเรียกอื่น',
        aliases: ['Aliases'],
        example: 'คลัง BN, บางนา',
        hint: 'คั่นด้วย , (ใช้จับคู่ข้อความปลายทาง)',
      },
      { key: 'notes', header: 'หมายเหตุ', aliases: ['Notes'] },
      { key: 'externalId', header: 'รหัสในระบบอื่น', aliases: ['External ID', 'externalId'] },
    ],
    uniqueInFile: [{ column: 'code', label: 'รหัส', key: (v) => v.code?.toUpperCase() || null }],
    findExisting: byCode((tx, code) =>
      tx.customerSite.findFirst({
        where: { code: iEquals(code), deletedAt: null },
        select: { id: true },
      }),
    ),
    current: (id, tx) => tx.customerSite.findUnique({ where: { id } }),
    async build(r, op, cur) {
      const b: Record<string, unknown> = {};
      const upd = op === 'update';
      if (op === 'create') put(b, 'code', r.text('code') ?? undefined);
      put(b, 'name', r.text('name'));
      put(b, 'kind', r.pick('kind', KINDS));
      put(b, 'customerId', await r.ref('customer', 'customer'));
      put(b, 'address', upd ? mergeGroup(cur?.address, readAddress(r)) : readAddress(r));
      put(b, 'lat', r.num('lat'));
      put(b, 'lng', r.num('lng'));
      put(b, 'openTime', r.text('openTime'));
      put(b, 'closeTime', r.text('closeTime'));
      put(b, 'maxVehicleClass', r.pick('maxVehicleClass', CLASSES));
      put(b, 'serviceTimeMin', r.int('serviceTimeMin'));
      put(b, 'dockCount', r.int('dockCount'));
      const contact = group({ name: r.text('contactName'), phone: r.text('contactPhone') });
      put(b, 'contact', upd ? mergeGroup(cur?.contact, contact) : contact);
      const aliases = r.text('aliases');
      if (aliases !== undefined)
        b.aliases = aliases === null ? [] : aliases.split(/[,;\n]/).map((x) => x.trim());
      put(b, 'notes', r.text('notes'));
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    // MD-288: ไม่มีพิกัด → ระบบหาพิกัดจากที่อยู่หลังนำเข้า (job site.geocode เดียวกับสร้างทางหน้าจอ) ให้ตรวจบนแผนที่ภายหลัง
    warnings(r, body, op) {
      if (op === 'create' && body.lat === undefined && body.lng === undefined)
        r.warn(
          'lat',
          'geocode_pending',
          'ไม่มีพิกัด — ระบบจะหาพิกัดจากที่อยู่หลังนำเข้า ตรวจตำแหน่งบนแผนที่ภายหลัง',
        );
    },
    create: (dto) => svc.create(dto as CreateSiteDto),
    update: (id, dto) => svc.update(id, dto as UpdateSiteDto),
  });
}
