import { Injectable } from '@nestjs/common';
import {
  checkVehicleCompatibility,
  hasCompatibilityWarnings,
  type CompatibilityWarning,
  type CompatJob,
  type VehicleCapability,
  type VehicleClass,
} from '@tms/domain';
import { encodeId } from '../../common/ids';
import { notFound, ProblemException, type FieldError } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';

/**
 * ST2-T16 Vehicle-type compatibility — ตัวห่อ `checkVehicleCompatibility()` (@tms/domain) ที่อ่านข้อมูลหลักจากฐาน
 * ผู้เรียก: ST3-T14 (constraint ตอนจัดรถ: เตือน + override พร้อมเหตุผล + audit) — ฟังก์ชันนี้ **ไม่บล็อก ไม่เขียนอะไร**
 *
 * - รับ uuid ภายใน (เหมือน `RoutesService.getRouteDistance`) + `tx` ที่ตั้ง tenant แล้ว → RLS กันข้าม tenant
 * - ประเภทรถ/รถไม่พบ (รวมของ tenant อื่น หรือ id ไม่ใช่ uuid) → 404
 * - สินค้า/จุด/ประเภทรถที่ SO ขอ ไม่พบ → 422 `validation_failed` + `reference_not_found` ต่อช่อง (ไม่ข้ามเงียบ — กันผลว่า "เข้ากันได้" ทั้งที่ไม่ได้ตรวจ)
 * - ประเภทรถที่ SO ขอมีป้ายความสามารถ (เช่น ห้องเย็น) → นับเป็นความสามารถที่งานต้องการด้วย
 * - สินค้า/จุดที่ปิดใช้หรือลบแล้วยังถูกนำมาเทียบ (SO เก่าอ้างได้ — ความเข้ากันได้เป็นคุณสมบัติของข้อมูล ไม่ใช่สถานะ)
 * - คืน id แบบ public (`prd_…`, `loc_…`) + ข้อความไทยพร้อมแสดง (API-first: ลูกค้า API เห็นข้อความเดียวกับ UI)
 */
export interface CompatibilityCheckInput {
  /** ประเภทรถที่จะใช้ — ส่งอย่างใดอย่างหนึ่ง: vehicleTypeId หรือ vehicleId (ใช้ประเภทของรถคันนั้น) */
  vehicleTypeId?: string;
  vehicleId?: string;
  productIds?: readonly string[];
  /** จุดรับ/ส่งทุกจุดในงาน (PLN-085 ใช้ข้อจำกัดของทุกจุด) */
  siteIds?: readonly string[];
  job?: {
    /** ประเภทรถที่ SO ขอ (MD-093) */
    requestedVehicleTypeId?: string | null;
    requiredCapabilities?: readonly VehicleCapability[];
  } | null;
}

export interface CompatibilityWarningView extends CompatibilityWarning {
  /** ข้อความไทยพร้อมแสดง (สำหรับลูกค้า API) — เว็บ (ST3-T14) แสดงจาก `messageKey` + `params` ผ่าน th.ts */
  message: string;
}

export interface CompatibilityResult {
  vehicleType: { id: string; code: string; name: string };
  /** ว่าง = เข้ากันได้ */
  warnings: CompatibilityWarningView[];
  /** มีคำเตือนระดับ warning (ต้องระบุเหตุผลถ้าจะใช้ต่อ — ST3-T14) */
  requiresOverride: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLASS_TH: Record<VehicleClass, string> = {
  '4W': '4 ล้อ',
  '6W': '6 ล้อ',
  '10W': '10 ล้อ',
  TRAILER: 'พ่วง',
  SEMI_TRAILER: 'เทรลเลอร์',
};
const CAP_TH: Record<VehicleCapability, string> = {
  REFRIGERATED: 'ห้องเย็น',
  CRANE: 'ติดเครน',
  CONTAINER: 'ลากตู้',
  HAZMAT: 'สินค้าอันตราย',
};

const cls = (v: unknown) => CLASS_TH[v as VehicleClass] ?? String(v ?? '');
const deg = (v: unknown) => (v === null || v === undefined ? '?' : `${v as number}`);
const range = (a: unknown, b: unknown) => `${deg(a)}…${deg(b)} °C`;

/** ข้อความไทยของแต่ละ messageKey */
export function compatibilityMessageTh(w: CompatibilityWarning, sourceLabel?: string): string {
  const p = w.params;
  const of = sourceLabel ? ` (${sourceLabel})` : '';
  switch (w.messageKey) {
    case 'compat.capabilityMissing':
      return `งานนี้ต้องใช้รถ${CAP_TH[p.capability as VehicleCapability] ?? String(p.capability)} แต่ประเภทรถที่เลือกไม่มี`;
    case 'compat.smallerThanRequested':
      return `รถ ${cls(p.vehicleClass)} เล็กกว่าที่ SO ขอ (${cls(p.requestedClass)})`;
    case 'compat.largerThanRequested':
      return `ใช้รถใหญ่กว่า: ${cls(p.vehicleClass)} แทน ${cls(p.requestedClass)} — ราคาขายยังตามประเภทที่ขอ`;
    case 'compat.tempNotRefrigerated':
      return `สินค้าควบคุมอุณหภูมิ${of} ต้องใช้รถห้องเย็น แต่ประเภทรถที่เลือกไม่ใช่ห้องเย็น`;
    case 'compat.tempRangeNotCovered':
      return `ช่วงอุณหภูมิรถ ${range(p.vehicleTempMinC, p.vehicleTempMaxC)} ไม่ครอบคลุมสินค้า${of} ${range(p.productTempMinC, p.productTempMaxC)}`;
    case 'compat.hazmatNotAllowed':
      return `สินค้าอันตราย${of} แต่ประเภทรถที่เลือกไม่มีป้าย "สินค้าอันตราย"`;
    case 'compat.locationVehicleLimit':
      return `สถานที่${of} รับรถได้สูงสุด ${cls(p.maxVehicleClass)} — รถ ${cls(p.vehicleClass)} เข้าไม่ได้`;
    default:
      return w.code;
  }
}

@Injectable()
export class CompatibilityService {
  constructor(private readonly db: DbService) {}

  async check(input: CompatibilityCheckInput, tx: Tx = this.db.tx): Promise<CompatibilityResult> {
    const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
    const vtSelect = {
      id: true,
      code: true,
      nameTh: true,
      vehicleClass: true,
      capabilityTags: true,
      tempMinC: true,
      tempMaxC: true,
    } as const;
    let vt;
    if (input.vehicleTypeId !== undefined) {
      if (!isUuid(input.vehicleTypeId)) throw notFound();
      vt = await tx.vehicleType.findFirst({ where: { id: input.vehicleTypeId }, select: vtSelect });
    } else if (input.vehicleId !== undefined) {
      if (!isUuid(input.vehicleId)) throw notFound();
      vt = (
        await tx.vehicle.findFirst({
          where: { id: input.vehicleId },
          select: { vehicleType: { select: vtSelect } },
        })
      )?.vehicleType;
    }
    if (!vt) throw notFound();

    const productIds = [...new Set(input.productIds ?? [])];
    const siteIds = [...new Set(input.siteIds ?? [])];
    const requestedId = input.job?.requestedVehicleTypeId ?? null;
    const okProductIds = productIds.filter(isUuid);
    const okSiteIds = siteIds.filter(isUuid);
    const [products, sites, requested] = await Promise.all([
      okProductIds.length
        ? tx.product.findMany({
            where: { id: { in: okProductIds } },
            select: {
              id: true,
              code: true,
              nameTh: true,
              tempControlled: true,
              tempMinC: true,
              tempMaxC: true,
              hazardous: true,
            },
          })
        : [],
      okSiteIds.length
        ? tx.customerSite.findMany({
            where: { id: { in: okSiteIds } },
            select: { id: true, code: true, name: true, maxVehicleClass: true },
          })
        : [],
      requestedId !== null && isUuid(requestedId)
        ? tx.vehicleType.findFirst({
            where: { id: requestedId },
            select: { vehicleClass: true, capabilityTags: true },
          })
        : null,
    ]);
    // คงลำดับตามที่ผู้เรียกส่ง (ผลแน่นอน)
    const pById = new Map(products.map((p) => [p.id, p]));
    const sById = new Map(sites.map((s) => [s.id, s]));
    const orderedProducts = productIds.flatMap((id) => (pById.has(id) ? [pById.get(id)!] : []));
    const orderedSites = siteIds.flatMap((id) => (sById.has(id) ? [sById.get(id)!] : []));

    // id ที่หาไม่พบ (ไม่มี / ของ tenant อื่น / ผิดรูปแบบ) → 422 รายช่อง
    const errors: FieldError[] = [];
    (input.productIds ?? []).forEach((id, i) => {
      if (!pById.has(id))
        errors.push({
          field: `productIds[${i}]`,
          code: 'reference_not_found',
          message: 'product not found',
        });
    });
    (input.siteIds ?? []).forEach((id, i) => {
      if (!sById.has(id))
        errors.push({
          field: `siteIds[${i}]`,
          code: 'reference_not_found',
          message: 'site not found',
        });
    });
    if (requestedId !== null && !requested)
      errors.push({
        field: 'job.requestedVehicleTypeId',
        code: 'reference_not_found',
        message: 'vehicle type not found',
      });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);

    const job: CompatJob | null = input.job
      ? {
          requestedVehicleClass: requested?.vehicleClass ?? null,
          // ประเภทรถที่ SO ขอ = ความต้องการของงาน: ขอ "6 ล้อ ห้องเย็น" → ต้องมีป้าย REFRIGERATED ด้วย (domain ตัดซ้ำ)
          requiredCapabilities: [
            ...(input.job.requiredCapabilities ?? []),
            ...((requested?.capabilityTags ?? []) as VehicleCapability[]),
          ],
        }
      : null;

    const raw = checkVehicleCompatibility({
      vehicleType: {
        vehicleClass: vt.vehicleClass,
        capabilityTags: vt.capabilityTags,
        tempMinC: vt.tempMinC?.toString() ?? null,
        tempMaxC: vt.tempMaxC?.toString() ?? null,
      },
      products: orderedProducts.map((p) => ({
        id: p.id,
        code: p.code,
        tempControlled: p.tempControlled,
        tempMinC: p.tempMinC?.toString() ?? null,
        tempMaxC: p.tempMaxC?.toString() ?? null,
        hazardous: p.hazardous,
      })),
      sites: orderedSites.map((s) => ({
        id: s.id,
        code: s.code,
        maxVehicleClass: s.maxVehicleClass,
      })),
      job,
    });

    const warnings = raw.map((w): CompatibilityWarningView => {
      let label: string | undefined;
      const source = { ...w.source };
      if (w.source.kind === 'product' && w.source.id) {
        const p = pById.get(w.source.id)!;
        label = `${p.code} ${p.nameTh}`;
        source.id = encodeId('product', p.id);
      } else if (w.source.kind === 'site' && w.source.id) {
        const s = sById.get(w.source.id)!;
        label = `${s.code} ${s.name}`;
        source.id = encodeId('site', s.id);
      }
      return { ...w, source, message: compatibilityMessageTh(w, label) };
    });

    return {
      vehicleType: { id: encodeId('vehicleType', vt.id), code: vt.code, name: vt.nameTh },
      warnings,
      requiresOverride: hasCompatibilityWarnings(warnings),
    };
  }
}
