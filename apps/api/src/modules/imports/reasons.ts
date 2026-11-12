import { Prisma } from '@prisma/client';
import { InvalidTransitionError } from '@tms/domain';
import { PROBLEMS, ProblemException, type FieldError } from '../../common/problem';
import type { RowIssue } from './import-spec';

/**
 * แปลง error ของ API (ProblemException จาก validator/service เดียวกับ POST/PATCH) เป็นเหตุผลภาษาไทยรายแถว (ST2-T23)
 * ข้อความ API เป็นอังกฤษ (ลูกค้าเชื่อมระบบ) — รายงานนำเข้าให้คนอ่านแล้วแก้ไฟล์ได้ จึงแปลจาก `code` (+ ตัวเลขใน constraint)
 * ห้ามใส่ค่าที่ผู้ใช้กรอกลงข้อความ (ค่าอ่อนไหวอย่างเลขบัตร/เลขบัญชีจะหลุดลง import_job)
 */
const FIELD_TH: Record<string, string> = {
  // class-validator
  isNotEmpty: 'ต้องกรอก',
  required: 'ต้องกรอก',
  isDefined: 'ต้องกรอก',
  isString: 'ต้องเป็นข้อความ',
  isInt: 'ต้องเป็นจำนวนเต็ม',
  isNumber: 'ต้องเป็นตัวเลข (ทศนิยมไม่เกินที่กำหนด)',
  isBoolean: 'ต้องเป็น ใช่ หรือ ไม่ใช่',
  isIn: 'ค่าไม่อยู่ในรายการที่เลือกได้ (ดู sheet คำอธิบายใน template)',
  isEnum: 'ค่าไม่อยู่ในรายการที่เลือกได้ (ดู sheet คำอธิบายใน template)',
  matches: 'รูปแบบไม่ถูกต้อง',
  isEmail: 'รูปแบบอีเมลไม่ถูกต้อง',
  isISO8601: 'วันที่ไม่ถูกต้อง',
  isArray: 'รูปแบบรายการไม่ถูกต้อง',
  arrayMaxSize: 'จำนวนรายการเกินกำหนด',
  whitelistValidation: 'คอลัมน์นี้ใช้กับข้อมูลชนิดนี้ไม่ได้',
  thai_tax_id:
    'เลขผู้เสียภาษี/เลขบัตรประชาชนไม่ถูกต้อง (ต้องเป็นตัวเลข 13 หลักและเลขตรวจสอบหลักสุดท้ายถูกต้อง)',
  // กฎของ service (ข้อความเดียวกับหน้าจอ — apps/web/src/i18n/th.ts field.*)
  duplicate: 'ซ้ำกับข้อมูลที่มีอยู่ในระบบแล้ว',
  not_found: 'ไม่พบข้อมูลที่อ้างถึงในระบบ',
  reference_not_found: 'ไม่พบข้อมูลที่อ้างถึงในระบบ',
  inactive: 'รายการที่อ้างถึงถูกปิดใช้/ระงับอยู่',
  site_inactive: 'สถานที่นี้ปิดใช้แล้ว',
  customer_inactive: 'ลูกค้านี้ปิดใช้แล้ว',
  unit_inactive: 'หน่วยนี้ปิดใช้แล้ว',
  same_site: 'ต้นทางและปลายทางต้องเป็นคนละจุด',
  one_primary: 'ผู้ติดต่อหลักมีได้คนเดียว',
  pair_required: 'ต้องกรอกคู่กัน',
  same_time: 'เวลาปิดต้องไม่เท่ากับเวลาเปิด',
  juristic_prefix: 'นิติบุคคลต้องใช้เลขผู้เสียภาษีที่ขึ้นต้นด้วย 0',
  individual: 'บุคคลธรรมดาไม่มีรหัสสาขา',
  parent_depth: 'สายสังกัดยาวเกินไปหรือข้อมูลวน',
  parent_cycle: 'ผู้รับเหมาหลักวนกลับมาที่รายนี้',
  plate_format: 'รูปแบบทะเบียนไม่ถูกต้อง เช่น 70-1234',
  plate_has_province: 'ช่องทะเบียนมีชื่อจังหวัดปนอยู่ — แยกจังหวัดไปคอลัมน์จังหวัด',
  payload_over_gvw: 'น้ำหนักบรรทุกต้องไม่เกิน น้ำหนักรวม − น้ำหนักรถเปล่า',
  tare_over_gross: 'น้ำหนักรถเปล่าต้องน้อยกว่าน้ำหนักรวม',
  pair_role: 'จับคู่ได้เฉพาะหัวลากกับหาง',
  pair_self: 'จับคู่กับตัวเองไม่ได้',
  already_paired: 'คันนี้พ่วงกับคันอื่นอยู่',
  retired: 'รถที่ปลดระวางแล้วใช้ไม่ได้',
  vehicle_retired: 'รถปลดระวางแล้ว',
  not_allowed: 'รถบริษัท/คนขับบริษัทไม่มีผู้รับเหมา',
  carrier_required: 'รถร่วม/คนขับรถร่วมต้องระบุผู้รับเหมา',
  carrier_not_allowed: 'คนขับบริษัทไม่มีผู้รับเหมา',
  year_range: 'ปีผลิตต้องไม่เกินปีหน้า',
  future: 'วันที่ต้องไม่เป็นวันในอนาคต',
  salvage_over_cost: 'มูลค่าซากต้องไม่เกินราคาซื้อ',
  odometer_backwards: 'เลขไมล์น้อยกว่าค่าปัจจุบันไม่ได้',
  driver_inactive: 'คนขับนี้ปิดใช้แล้ว',
  not_hazardous: 'ใช้ได้เฉพาะสินค้าอันตราย',
  not_temp_controlled: 'ใช้ได้เฉพาะสินค้าควบคุมอุณหภูมิ',
  temp_range: 'อุณหภูมิต่ำสุดต้องไม่มากกว่าอุณหภูมิสูงสุด',
  fixed_by_unit: 'ค่านี้กำหนดตามหน่วยที่เลือก',
  same_as_base: 'ซ้ำกับหน่วยหลัก',
  reserved_field: 'รายการของระบบแก้ช่องนี้ไม่ได้',
  reserved_tax: 'ค่าขนส่งของระบบต้องยกเว้น VAT',
  reserved_code: 'รหัสนี้สงวนไว้สำหรับรายการของระบบ',
  reserved_item: 'รายการของระบบแก้ไขด้วยการนำเข้าไม่ได้',
  actual_no_price: 'รายการตามจริงไม่มีราคาตั้งต้น (คิดตามใบเสร็จ)',
  percent_max: 'เปอร์เซ็นต์ต้องไม่เกิน 100',
  not_percent: 'ใช้ได้เฉพาะหน่วยคิด % ของค่าขนส่ง',
  overlap: 'ช่วงวันที่ทับกับ rate อื่นของลูกค้า/ผู้รับเหมา เส้นทาง และประเภทรถเดียวกัน',
  before_start: 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม',
  wrong_side: 'ใช้กับฝั่งนี้ไม่ได้ (ขาขายใช้ลูกค้า · ขาซื้อใช้ผู้รับเหมา)',
  side_locked: 'เปลี่ยนฝั่งของ rate ไม่ได้',
  not_editable: 'แก้ไขได้เฉพาะฉบับร่าง',
  not_applicable: 'ใช้กับรายการนี้ไม่ได้',
  warehouse_only: 'ใช้ได้เฉพาะสถานที่ประเภทคลัง',
  site_other_customer: 'สถานที่นี้เป็นของลูกค้ารายอื่น',
  service_item_inactive: 'ค่าบริการนี้ปิดใช้แล้ว',
  service_item_not_found: 'ไม่พบค่าบริการที่อ้างถึง',
  not_volume: 'หน่วยนี้ไม่ใช่หน่วยปริมาตร',
  not_weight: 'หน่วยนี้ไม่ใช่หน่วยน้ำหนัก',
  duplicate_route: 'คู่ต้นทาง–ปลายทางนี้มีเส้นทางอยู่แล้ว',
  invalid_date: 'วันที่ไม่ถูกต้องหรืออยู่นอกช่วงที่รับได้',
  key_locked: 'แก้ลูกค้า/เส้นทาง/ประเภทรถของ rate นี้ไม่ได้',
  draft_exists: 'มีฉบับร่างค้างอยู่แล้ว',
  system_unit: 'หน่วยมาตรฐานของระบบแก้ได้เฉพาะชื่อ',
  unit_in_use: 'มีสินค้าใช้หน่วยนี้อยู่',
  trip_running: 'มีเที่ยววิ่งอยู่ แก้ช่องนี้ไม่ได้',
  odometer_after_later: 'เลขไมล์มากกว่าค่าที่บันทึกภายหลังไม่ได้',
  min: 'ค่าน้อยเกินกำหนด',
  max: 'ค่ามากเกินกำหนด',
  minLength: 'ข้อความสั้นเกินกำหนด',
  maxLength: 'ข้อความยาวเกินกำหนด',
  secret_unreadable: 'อ่านเลขเดิมไม่ได้ — กรอกเลขใหม่',
  required_on_type_change: 'เปลี่ยนประเภทต้องกรอกเลขผู้เสียภาษี / เลขบัตรใหม่',
};

/** problem ทั้งแถว (ไม่มี errors[]) */
const PROBLEM_TH: Record<string, string> = {
  duplicate: 'ซ้ำกับข้อมูลที่มีอยู่ในระบบแล้ว',
  forbidden: 'ไม่มีสิทธิ์บันทึกข้อมูลในแถวนี้',
  permission_denied: 'ไม่มีสิทธิ์บันทึกข้อมูลในแถวนี้',
  not_found: 'ไม่พบข้อมูลที่อ้างถึงในระบบ',
  invalid_state_transition: 'รายการในระบบอยู่ในสถานะที่แก้ไขด้วยการนำเข้าไม่ได้',
  in_use: 'รายการนี้มีข้อมูลอื่นอ้างถึงแล้ว แก้ช่องนี้ไม่ได้',
  in_use_active: 'รายการนี้ยังมีข้อมูลที่ใช้งานอยู่อ้างถึง',
};

/** code ของรายงานนำเข้า (spec/02 §11.4) จาก code ของ API */
const ISSUE_CODE: Record<string, string> = {
  duplicate: 'duplicate_in_db',
  not_found: 'reference_not_found',
  reference_not_found: 'reference_not_found',
  isNotEmpty: 'required',
  required: 'required',
  permission_denied: 'permission_denied',
  forbidden: 'permission_denied',
};

/** ตัวเลขใน constraint ของ class-validator (เช่น "must not be greater than 365") */
function detail(e: FieldError): string {
  const n = /(-?\d+(?:\.\d+)?)/.exec(e.message ?? '')?.[1];
  switch (e.code) {
    case 'maxLength':
      return n ? `ยาวเกิน ${n} ตัวอักษร` : FIELD_TH.maxLength!;
    case 'minLength':
      return n ? `ต้องยาวอย่างน้อย ${n} ตัวอักษร` : FIELD_TH.minLength!;
    case 'min':
      return n ? `ต้องไม่น้อยกว่า ${n}` : FIELD_TH.min!;
    case 'max':
      return n ? `ต้องไม่เกิน ${n}` : FIELD_TH.max!;
    case 'isNumber':
      return n ? `ต้องเป็นตัวเลข ทศนิยมไม่เกิน ${n} ตำแหน่ง` : FIELD_TH.isNumber!;
    default:
      return FIELD_TH[e.code] ?? 'ค่าไม่ถูกต้อง';
  }
}

/**
 * error → ปัญหารายแถว · `columnOf(field)` แปลง path ของ DTO (เช่น `address.postcode`) เป็น key คอลัมน์
 * คืน null = ไม่ใช่ error ของข้อมูล (บั๊ก/ระบบล่ม) — ผู้เรียก throw ต่อ
 */
export function issuesFromError(
  e: unknown,
  columnOf: (field: string) => string | undefined,
): RowIssue[] | null {
  if (e instanceof ProblemException) {
    if (e.errors?.length)
      return e.errors.map((x) => {
        const column = columnOf(x.field);
        return {
          ...(column ? { column } : {}),
          code: ISSUE_CODE[x.code] ?? (e.code === 'duplicate' ? 'duplicate_in_db' : x.code),
          message: detail(x),
        };
      });
    if (e.code === 'internal_error' || e.code === 'concurrent_update') return null;
    // สิทธิ์ระดับฟิลด์ (ราคา: extra.required/fields · บัญชีธนาคาร: "changing bankAccount requires settlements:pay")
    const scope =
      (e.extra?.required as string[] | undefined)?.[0] ??
      /requires ([a-z.]+:[a-z]+)/.exec(e.detail ?? '')?.[1];
    const field =
      (e.extra?.fields as string[] | undefined)?.[0] ?? /^changing (\w+)/.exec(e.detail ?? '')?.[1];
    const column = field ? columnOf(field.replace(/\[\d+\]/g, '')) : undefined;
    const base = PROBLEM_TH[e.code] ?? PROBLEMS[e.code]?.th ?? 'ตรวจไม่ผ่าน';
    return [
      {
        ...(column ? { column } : {}),
        code: ISSUE_CODE[e.code] ?? e.code,
        message:
          scope && ISSUE_CODE[e.code] === 'permission_denied'
            ? `${base} (ต้องมีสิทธิ์ ${scope})`
            : base,
      },
    ];
  }
  if (e instanceof InvalidTransitionError)
    return [{ code: 'invalid_state_transition', message: PROBLEM_TH.invalid_state_transition! }];
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
    return [{ code: 'duplicate_in_db', message: PROBLEM_TH.duplicate! }];
  return null;
}
