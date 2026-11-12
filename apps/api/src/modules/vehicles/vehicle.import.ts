import type { Tx } from '../../db/db.service';
import { defineMasterImport, put, type RowReader } from '../imports/master-import';
import { PROVINCES } from './provinces';
import { CreateVehicleDto, UpdateVehicleDto } from './vehicle.dto';
import { plateKey, plateNorm, type VehiclesService } from './vehicles.service';

const OWN = { OWN: ['บริษัท', 'รถบริษัท'], SUBCONTRACT: ['รถร่วม'] };
const ROLE = { SINGLE: ['รถเดี่ยว'], TRACTOR: ['หัวลาก'], TRAILER: ['หาง'] };
const FUEL = {
  DIESEL: ['ดีเซล'],
  GASOLINE: ['เบนซิน'],
  NGV: ['NGV'],
  LPG: ['LPG'],
  EV: ['ไฟฟ้า'],
  HYBRID: ['ไฮบริด'],
};
const label = (m: Record<string, string[]>) => Object.values(m).map((l) => l[0]!);
const nd = (s: string) => s.replace(/[.\s]/g, '');

/** จังหวัด: รหัส TH-xx / ชื่อเต็ม / อักษรย่อบนป้าย (มีหรือไม่มีจุด) */
export function provinceOf(v: string): string | null {
  const n = nd(v);
  const p = PROVINCES.find((x) => x[0] === v.toUpperCase() || x[1] === v.trim() || nd(x[2]) === n);
  return p?.[0] ?? null;
}

/** "70-7781 กทม." (ต้นแบบ — ทะเบียนกับจังหวัดในช่องเดียว) → ทะเบียน + จังหวัด */
function splitPlate(values: Record<string, string>): { plate?: string; province?: string } {
  const raw = values.plate?.trim() ?? '';
  const prov = values.plateProvince?.trim();
  if (prov) return { plate: raw, province: prov };
  const m = /^(.*\S)\s+(\S+)$/.exec(raw);
  if (m && provinceOf(m[2]!)) return { plate: m[1]!, province: m[2]! };
  return { plate: raw };
}

function readPlate(r: RowReader) {
  const { plate, province } = splitPlate(r.values);
  let code: string | undefined;
  if (province) {
    const c = provinceOf(province);
    if (!c)
      r.bad('plateProvince', 'ไม่รู้จักจังหวัดนี้ — ใช้ชื่อจังหวัดหรืออักษรย่อบนป้าย เช่น กทม.');
    else code = c;
  }
  return { plate: plate || undefined, province: code };
}

/** รถเดิมจากทะเบียน + จังหวัด (plate key เดียวกับ API — ไม่นับคันที่ปลดระวาง) */
async function findExisting(values: Record<string, string>, tx: Tx): Promise<string | null> {
  const { plate, province } = splitPlate(values);
  const p = province ? provinceOf(province) : null;
  if (!plate || !p) return null;
  const v = await tx.vehicle.findFirst({
    where: { plateKey: plateKey(plate, p), deletedAt: null, status: { not: 'RETIRED' } },
    select: { id: true },
  });
  return v?.id ?? null;
}

/**
 * รถ (ST2-T06) — POST/PATCH /v1/vehicles · ระบุรถด้วยทะเบียน + จังหวัด (ไม่มีรหัส) — upsert/แก้ไขหาจาก plate key เดียวกับ API
 * โควตารถ (MD-289): รถใหม่ในไฟล์เกินโควตาที่เหลือ → ปฏิเสธทั้งไฟล์ (API สร้างทีละคันเป็น soft limit — PLT-080)
 */
export function vehicleImportSpec(svc: VehiclesService) {
  return defineMasterImport({
    kind: 'vehicle',
    label: 'รถ',
    scope: 'master:write',
    modes: ['create_only', 'upsert_by_code', 'update_only'],
    createDto: CreateVehicleDto,
    updateDto: UpdateVehicleDto,
    identity: 'plate',
    // ต้นแบบ vWiz: ทะเบียน · ประเภทรถ · เจ้าของ · น้ำหนักบรรทุก · (ประกันหมดอายุ = เอกสารรถ ST2-T07 — ไม่นำเข้าที่นี่)
    columns: [
      {
        key: 'plate',
        header: 'ทะเบียน',
        aliases: ['Plate No', 'Plate', 'เลขทะเบียน'],
        required: true,
        example: '70-7781',
        hint: 'ใส่จังหวัดท้ายทะเบียนได้ เช่น "70-7781 กทม." ถ้าไม่มีคอลัมน์จังหวัด',
      },
      {
        key: 'vehicleType',
        header: 'ประเภทรถ',
        aliases: ['Type', 'Truck type'],
        required: true,
        fields: ['vehicleTypeId'],
        example: '6W',
        hint: 'รหัสหรือชื่อประเภทรถที่ตรงตัว',
      },
      {
        key: 'ownership',
        header: 'เจ้าของ',
        aliases: ['Owner', 'Ownership'],
        required: true,
        example: 'บริษัท',
        options: label(OWN),
      },
      {
        key: 'payloadKg',
        header: 'น้ำหนักบรรทุก',
        aliases: ['Payload', 'น้ำหนักบรรทุก (กก.)'],
        example: '6000',
        hint: 'กก. · ว่าง = ค่าของประเภทรถ',
      },
      {
        key: 'plateProvince',
        header: 'จังหวัด',
        aliases: ['Province', 'จังหวัดทะเบียน'],
        example: 'กทม.',
      },
      {
        key: 'carrier',
        header: 'ผู้รับเหมา',
        aliases: ['Carrier', 'Vendor'],
        fields: ['carrierId'],
        example: '',
        hint: 'รถร่วมต้องระบุ (รหัสหรือชื่อผู้รับเหมา)',
      },
      {
        key: 'unitRole',
        header: 'ลักษณะรถ',
        aliases: ['Role'],
        example: 'รถเดี่ยว',
        options: label(ROLE),
      },
      { key: 'brand', header: 'ยี่ห้อ', aliases: ['Brand'], example: 'ISUZU' },
      { key: 'model', header: 'รุ่น', aliases: ['Model'], example: 'FRR 210' },
      {
        key: 'year',
        header: 'ปีผลิต',
        aliases: ['Year'],
        example: '2565',
        hint: 'พ.ศ. หรือ ค.ศ.',
      },
      { key: 'color', header: 'สี', aliases: ['Color'], example: 'ขาว' },
      {
        key: 'fuelType',
        header: 'เชื้อเพลิง',
        aliases: ['Fuel'],
        example: 'ดีเซล',
        options: label(FUEL),
      },
      { key: 'chassisNo', header: 'เลขตัวถัง', aliases: ['Chassis'], example: 'MPATFR00000000001' },
      { key: 'engineNo', header: 'เลขเครื่อง', aliases: ['Engine'] },
      { key: 'tareWeightKg', header: 'น้ำหนักรถเปล่า (กก.)', aliases: ['Tare'] },
      { key: 'grossWeightKg', header: 'น้ำหนักรวม (กก.)', aliases: ['GVW'] },
      { key: 'volumeCbm', header: 'ปริมาตร (ลบ.ม.)', aliases: ['Volume'] },
      { key: 'gpsProvider', header: 'ผู้ให้บริการ GPS', aliases: ['GPS'] },
      { key: 'gpsDeviceId', header: 'เลขอุปกรณ์ GPS', aliases: ['GPS ID'] },
      {
        key: 'odometerKm',
        header: 'เลขไมล์',
        aliases: ['Odometer'],
        example: '125000',
        hint: 'ใช้ตอนเพิ่มรถใหม่เท่านั้น',
      },
      { key: 'externalId', header: 'รหัสในระบบอื่น', aliases: ['External ID', 'externalId'] },
    ],
    uniqueInFile: [
      {
        column: 'plate',
        label: 'ทะเบียน',
        key: (v) => {
          const { plate, province } = splitPlate(v);
          const p = province ? provinceOf(province) : null;
          return plate ? `${plateNorm(plate)}|${p ?? ''}` : null;
        },
      },
    ],
    findExisting,
    async checkFile(ctx, rows) {
      const limit = await svc.quotaLimit();
      if (limit === null) return null;
      const used = await ctx.tx.vehicle.count({
        where: { deletedAt: null, status: { not: 'RETIRED' } },
      });
      let adding = rows.length;
      if (ctx.mode !== 'create_only') {
        adding = 0;
        for (const r of rows) if (!(await findExisting(r.values, ctx.tx))) adding++;
      }
      if (used + adding <= limit) return null;
      return `เกินโควตารถตามแพ็กเกจ: ใช้อยู่ ${used} จาก ${limit} คัน ไฟล์นี้เพิ่มรถใหม่ ${adding} คัน (เหลือได้อีก ${Math.max(0, limit - used)} คัน) — ซื้อ add-on หรือแบ่งไฟล์`;
    },
    async build(r, op) {
      const b: Record<string, unknown> = {};
      const { plate, province } = readPlate(r);
      if (op === 'create' || r.values.plate) {
        put(b, 'plate', plate);
        put(b, 'plateProvince', province);
      }
      put(b, 'vehicleTypeId', await r.ref('vehicleType', 'vehicleType'));
      put(b, 'ownership', r.pick('ownership', OWN));
      put(b, 'payloadKg', r.num('payloadKg'));
      put(b, 'carrierId', await r.ref('carrier', 'carrier'));
      put(b, 'unitRole', r.pick('unitRole', ROLE));
      put(b, 'brand', r.text('brand'));
      put(b, 'model', r.text('model'));
      const y = r.int('year');
      put(b, 'year', typeof y === 'number' && y > 2400 ? y - 543 : y);
      put(b, 'color', r.text('color'));
      put(b, 'fuelType', r.pick('fuelType', FUEL));
      put(b, 'chassisNo', r.text('chassisNo'));
      put(b, 'engineNo', r.text('engineNo'));
      put(b, 'tareWeightKg', r.num('tareWeightKg'));
      put(b, 'grossWeightKg', r.num('grossWeightKg'));
      put(b, 'volumeCbm', r.num('volumeCbm'));
      put(b, 'gpsProvider', r.text('gpsProvider'));
      put(b, 'gpsDeviceId', r.text('gpsDeviceId'));
      // เลขไมล์ = ค่าเริ่มต้นตอนเพิ่มรถ (แก้ภายหลังผ่านการบันทึกเลขไมล์ — นำเข้าซ้ำไม่สร้างรายการเลขไมล์ใหม่)
      if (op === 'create') put(b, 'odometerKm', r.num('odometerKm'));
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    create: (dto) => svc.create(dto as CreateVehicleDto),
    update: (id, dto) => svc.update(id, dto as UpdateVehicleDto),
  });
}
