import { Injectable, OnModuleInit } from '@nestjs/common';
import { encodeId, tryDecodeId, type IdKind } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import type { Tx } from '../../db/db.service';
import {
  ImportRegistry,
  parseImportDate,
  type ImportColumn,
  type ImportContext,
  type ImportSpec,
  type RowInput,
  type RowIssue,
  type RowResult,
} from '../imports/import-spec';
import { Lookup, RowReader, type RefKind } from '../imports/master-import';
import { issuesFromError } from '../imports/reasons';
import { cleanLine } from '../master/master-kit';
import type { UpsertOrderInput, UpsertOrderLine, UpsertOrderStop } from './order-input';
import { OrderIntakeService } from './order-intake.service';

/**
 * นำเข้าใบสั่งขนส่ง (SO) จาก Excel (ST3-T04; docs/04 C "Import Excel — template + dry-run + รายงานแถวผิด",
 * spec/03 ORD-020 "หลายแถว 1 แถวต่อจุด จัดกลุ่มด้วย order_ref")
 *
 * - 1 แถว = 1 ใบ (จุดรับ + จุดส่ง + สินค้า 1 รายการในแถวเดียว) หรือหลายแถวที่มี "เลขอ้างอิงใบสั่ง" เดียวกัน = ใบเดียว
 *   (จุด/สินค้าเรียงตามแถว: ในแถวเดียว จุดรับ → จุดส่ง → จุดคืน) — ข้อมูลหัวใบ (ลูกค้า วันรับ ประเภทรถ PO) กรอกแถวแรก
 *   แถวอื่นเว้นว่างหรือกรอกเหมือนกัน
 * - อ้างอิงด้วยรหัส (หรือชื่อที่ตรงตัว — MD-282): ลูกค้า สถานที่ ประเภทรถ สินค้า หน่วย · ไม่พบ = แถวผิด (แก้ไฟล์ได้ทันที)
 * - เขียนผ่าน **`OrderIntakeService.upsertOrder` เท่านั้น** (ที่มา EXCEL) — กฎเดียวกับ API ทุกข้อ (externalId unique ต่อบริษัท,
 *   `external_id_conflict`, ช่องที่ล็อกตามสถานะ, ใบค้าง, คิดราคาด้วย rate card, DO อัตโนมัติ) · ไม่มีคอลัมน์ราคา (คิดจาก rate card)
 * - ขั้นตรวจ: เรียก upsertOrder ใน SAVEPOINT ต่อใบแล้วย้อนทิ้ง → ไม่มี SO/DO/เลขเอกสาร/audit/event ค้าง (เลข SO ไม่ถูกใช้ —
 *   `issueNumber` เขียน document_sequence ใน transaction เดียวกัน) · ยืนยัน = ตรวจซ้ำแล้วเก็บการเขียน (เหมือน ST2-T23)
 * - ใบที่มีแถวผิดแม้แถวเดียว = ไม่นำเข้าทั้งใบ (แถวอื่นของใบแจ้ง "ใบสั่งเดียวกับแถว N ที่ผิด")
 * - นำเข้าซ้ำ (เลขอ้างอิงเดิม): โหมด upsert_by_code (ค่าเริ่มต้น) = อัปเดตใบเดิม / ข้อมูลเท่าเดิม = ไม่เปลี่ยน ·
 *   create_only = เลขที่มีในระบบแล้วเป็นแถวผิด (ตรวจใน upsertOrder หลังล็อก) · แถวไม่มีเลขอ้างอิง = ใบใหม่ทุกครั้ง (เตือน)
 */

export interface OrderImportValue {
  /** กลุ่มของแถว (เลขอ้างอิงใบสั่ง หรือ `#แถว`) */
  group: string;
  input: RowInput;
}

const STOPS = [
  { type: 'PICKUP', site: 'pickupSite', from: 'pickupFrom', to: 'pickupTo' },
  { type: 'DELIVERY', site: 'deliverySite', from: 'deliveryFrom', to: 'deliveryTo' },
  { type: 'RETURN', site: 'returnSite', from: null, to: null },
] as const;
const LINE_KEYS = ['product', 'description', 'qty', 'unit', 'weightKg', 'cbm'] as const;
const HEADER_KEYS = ['customer', 'requestedDate', 'vehicleType', 'customerRef'] as const;

export const ORDER_IMPORT_COLUMNS: ImportColumn[] = [
  {
    key: 'externalId',
    header: 'เลขอ้างอิงใบสั่ง',
    aliases: [
      'order_ref',
      'externalId',
      'External ID',
      'Order Ref',
      'เลขที่ใบสั่ง',
      'รหัสในระบบอื่น',
    ],
    example: 'ORD-0001',
    hint: 'เลขของใบสั่งตามระบบ/ไฟล์ของคุณ — แถวที่เลขเดียวกัน = ใบเดียว (หลายจุด/หลายสินค้า) · นำเข้าซ้ำ = อัปเดตใบเดิม ไม่เกิดใบซ้ำ',
  },
  {
    key: 'customer',
    header: 'ลูกค้า',
    aliases: ['รหัสลูกค้า', 'Customer', 'Customer Code'],
    requiredWhen: 'ในแถวแรกของแต่ละใบ',
    example: 'C-0001',
    hint: 'รหัสลูกค้า (หรือชื่อที่ตรงตัว)',
  },
  {
    key: 'requestedDate',
    header: 'วันรับสินค้า',
    aliases: ['วันที่รับ', 'วันที่', 'Date', 'Pickup Date', 'Requested Date'],
    requiredWhen: 'ในแถวแรกของแต่ละใบ',
    example: '15/11/2569',
    hint: 'DD/MM/YYYY (พ.ศ. หรือ ค.ศ.) — ใช้หา rate card',
  },
  {
    key: 'vehicleType',
    header: 'ประเภทรถ',
    aliases: ['Vehicle Type'],
    example: '6W',
    hint: 'รหัสหรือชื่อประเภทรถ — ไม่กรอก = ใบค้างรอกำหนดราคา',
  },
  {
    key: 'customerRef',
    header: 'เลข PO ลูกค้า',
    aliases: ['PO', 'เลขที่ PO', 'Customer Ref', 'Customer PO'],
    example: 'PO-2569-0105',
  },
  {
    key: 'pickupSite',
    header: 'จุดรับ',
    aliases: ['ต้นทาง', 'รหัสจุดรับ', 'Pickup', 'Origin'],
    example: 'L-0001',
    hint: 'รหัสสถานที่ (หรือชื่อที่ตรงตัว) — สถานที่ของลูกค้ารายนี้หรือของบริษัท',
  },
  {
    key: 'pickupFrom',
    header: 'เวลารับ ตั้งแต่',
    aliases: ['Pickup From'],
    example: '08:00',
    hint: 'HH:mm (= วันรับสินค้า) หรือ DD/MM/YYYY HH:mm · เวลาประเทศไทย',
  },
  {
    key: 'pickupTo',
    header: 'เวลารับ ถึง',
    aliases: ['Pickup To'],
    example: '10:00',
  },
  {
    key: 'deliverySite',
    header: 'จุดส่ง',
    aliases: ['ปลายทาง', 'รหัสจุดส่ง', 'Delivery', 'Destination', 'Ship To'],
    example: 'L-0002',
    hint: 'รหัสสถานที่ (หรือชื่อที่ตรงตัว) — ส่งหลายจุด: เพิ่มแถวเลขอ้างอิงเดียวกัน',
  },
  {
    key: 'deliveryFrom',
    header: 'เวลาส่ง ตั้งแต่',
    aliases: ['Delivery From'],
    example: '13:00',
    hint: 'HH:mm (= วันรับสินค้า) หรือ DD/MM/YYYY HH:mm · เวลาประเทศไทย',
  },
  {
    key: 'deliveryTo',
    header: 'เวลาส่ง ถึง',
    aliases: ['Delivery To'],
    example: '17:00',
  },
  {
    key: 'returnSite',
    header: 'จุดคืนสินค้า',
    aliases: ['Return'],
    hint: 'ถ้ามีการคืนสินค้า/ตู้เปล่า',
  },
  {
    key: 'product',
    header: 'รหัสสินค้า',
    aliases: ['สินค้า', 'Product', 'Item Code'],
    example: 'P-0001',
    hint: 'สินค้าในข้อมูลหลัก — ไม่กรอกรายละเอียด/หน่วย = ใช้ชื่อและหน่วยหลักของสินค้า',
  },
  {
    key: 'description',
    header: 'รายละเอียดสินค้า',
    aliases: ['ชื่อสินค้า', 'Description'],
    requiredWhen: 'เมื่อมีสินค้าแต่ไม่กรอกรหัสสินค้า',
    example: 'ปูนซีเมนต์ถุง 50 กก.',
  },
  {
    key: 'qty',
    header: 'จำนวน',
    aliases: ['Qty', 'Quantity'],
    requiredWhen: 'เมื่อมีสินค้า',
    example: '400',
    hint: 'มากกว่า 0 ทศนิยมไม่เกิน 3 ตำแหน่ง',
  },
  {
    key: 'unit',
    header: 'หน่วย',
    aliases: ['Unit'],
    requiredWhen: 'เมื่อมีสินค้าแต่ไม่กรอกรหัสสินค้า',
    example: 'BAG',
    hint: 'รหัสหรือชื่อหน่วย (ถุง พาเลท ตัน …)',
  },
  {
    key: 'weightKg',
    header: 'น้ำหนัก (กก.)',
    aliases: ['น้ำหนัก', 'Weight', 'Weight (kg)'],
    example: '20000',
  },
  {
    key: 'cbm',
    header: 'ปริมาตร (คิว)',
    aliases: ['ปริมาตร', 'CBM'],
  },
];

/** แถวตัวอย่าง: ใบ 1 แถว + ใบส่ง 2 จุด (2 แถวเลขเดียวกัน) */
const SAMPLE_ROWS: Record<string, string>[] = [
  Object.fromEntries(ORDER_IMPORT_COLUMNS.map((c) => [c.key, c.example ?? ''])),
  {
    externalId: 'ORD-0002',
    customer: 'C-0001',
    requestedDate: '16/11/2569',
    vehicleType: '10W',
    pickupSite: 'L-0001',
    pickupFrom: '07:00',
    deliverySite: 'L-0003',
    deliveryTo: '12:00',
    product: 'P-0001',
    qty: '200',
  },
  {
    externalId: 'ORD-0002',
    deliverySite: 'L-0004',
    deliveryTo: '16/11/2569 17:00',
    description: 'เหล็กเส้น',
    qty: '5',
    unit: 'TON',
    weightKg: '5000',
  },
];

const HELP_NOTES = [
  'วิธีกรอก: 1 แถว = 1 ใบสั่ง (จุดรับ จุดส่ง สินค้า 1 รายการ) — ใบที่มีหลายจุดส่ง/หลายสินค้า ให้เพิ่มแถวที่ "เลขอ้างอิงใบสั่ง" เดียวกัน',
  'แถวของใบเดียวกัน: ข้อมูลหัวใบ (ลูกค้า วันรับสินค้า ประเภทรถ เลข PO) กรอกในแถวแรก แถวถัดไปเว้นว่างได้ · ลำดับจุด = ลำดับแถว (ในแถวเดียว จุดรับ → จุดส่ง → จุดคืน)',
  'ใบที่มีแถวผิดแม้แถวเดียว จะไม่ถูกนำเข้าทั้งใบ — แก้ไฟล์แล้วนำเข้าใหม่ได้ (ใบที่นำเข้าแล้วไม่ซ้ำ เพราะใช้เลขอ้างอิงเดิม)',
  'ราคาไม่ต้องกรอก — ระบบคิดจาก rate card ของลูกค้า (ไม่พบ rate = ใบค้าง "รอกำหนดราคา")',
  'เวลา: HH:mm = วันรับสินค้า · ช่วงเวลาข้ามวัน (เช่น ส่งถึงวันถัดไป) ให้ใส่วันที่ด้วย DD/MM/YYYY HH:mm · เวลาประเทศไทย',
  'ไฟล์ละไม่เกิน 500 แถว — มากกว่านี้ให้แบ่งเป็นหลายไฟล์',
];

/** ข้อความของรายงานนำเข้าที่ต่างจากเหตุผลทั่วไป (แนะวิธีแก้ในไฟล์) */
const IMPORT_MESSAGE: Record<string, string> = {
  window_order:
    'เวลาสิ้นสุดต้องไม่ก่อนเวลาเริ่ม — ช่วงเวลาข้ามวันให้ใส่วันที่ด้วย (DD/MM/YYYY HH:mm)',
  duplicate_in_db:
    'มีใบสั่งเลขอ้างอิงนี้ในระบบแล้ว (โหมดเพิ่มใหม่อย่างเดียว) — ใช้โหมดเพิ่มใหม่และแก้ไขของเดิมเพื่ออัปเดต',
};

const ID_OF: Partial<Record<RefKind, IdKind>> = {
  customer: 'customer',
  site: 'site',
  vehicleType: 'vehicleType',
  unit: 'unit',
  product: 'product',
};

/** วันเวลาในไฟล์ → ISO (+07:00) · รับ `HH:mm` / `HH.mm` (= วันรับสินค้า) หรือ วันที่ + เวลา · null = อ่านไม่ได้ */
export function parseWindow(v: string, baseDate: string | undefined): string | null | 'no_base' {
  const t = v.trim();
  // เซลล์ตัวเลข (รูปแบบ General) ที่เป็นเวลา/วันเวลาของ Excel: เศษของวัน (0.5, 0.75, 0.3333…) หรือ serial (46341.5)
  // ระบบวันที่ 1900 · ค่า < 1 ที่มีทศนิยม 2 ตำแหน่งและอ่านเป็น ชม.นาที ได้ (0.25 = 00:25) = ชั่วโมง.นาที (กำกวม — #52)
  const frac = /^0?\.(\d+)$/.exec(t);
  if (
    (frac && (frac[1]!.length !== 2 || Number(frac[1]) > 59)) ||
    /^\d*\.\d{3,}$/.test(t) ||
    /^\d{5}(\.\d+)?$/.test(t)
  ) {
    const n = Number(t);
    const days = Math.floor(n);
    let minutes = Math.round((n - days) * 1440);
    let d = days;
    if (minutes === 1440) [d, minutes] = [d + 1, 0];
    const date = d
      ? new Date(Date.UTC(1899, 11, 30) + d * 86_400_000).toISOString().slice(0, 10)
      : baseDate;
    if (!date) return 'no_base';
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    return `${date}T${hh}:${String(minutes % 60).padStart(2, '0')}:00+07:00`;
  }
  const m = /^(?:(.+?)[ T])?(\d{1,2})[:.](\d{2})(?::\d{2})?$/.exec(t);
  if (!m) return null;
  const [hh, mm] = [Number(m[2]), Number(m[3])];
  if (hh > 23 || mm > 59) return null;
  let date: string | null | undefined = baseDate;
  if (m[1]) date = parseImportDate(m[1]);
  else if (!baseDate) return 'no_base';
  if (!date) return null;
  return `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`;
}

interface StopProv {
  row: number;
  site: string;
  from: string | null;
  to: string | null;
}

interface GroupState {
  lookup: Lookup;
}

/** spec นำเข้า `order` — ลงทะเบียนตอนเริ่มระบบ */
export function orderImportSpec(intake: OrderIntakeService): ImportSpec<OrderImportValue> {
  async function product(tx: Tx, id: string) {
    return tx.product.findUnique({
      where: { id },
      select: { nameTh: true, baseUnitId: true },
    });
  }

  /**
   * ตรวจ/เขียน 1 ใบ (ทุกแถวของกลุ่ม) — keep=false: เรียก upsertOrder ใน savepoint แล้วย้อนทิ้ง
   * คืนปัญหาต่อแถว (ทุกแถวของกลุ่ม) และ true เมื่อใบผ่าน
   */
  async function processGroup(
    ctx: ImportContext,
    st: GroupState,
    rows: RowInput[],
    keyed: boolean,
    keep: boolean,
  ): Promise<{ ok: boolean; issues: Map<number, RowIssue[]> }> {
    const issues = new Map<number, RowIssue[]>(rows.map((r) => [r.row, []]));
    const add = (row: number, x: RowIssue) => issues.get(row)!.push(x);
    const readers = new Map(rows.map((r) => [r.row, new RowReader(r.values, false, st.lookup)]));
    const first = rows[0]!;
    const ref = async (r: RowInput, key: string, kind: RefKind) => {
      const pub = await readers.get(r.row)!.ref(key, kind);
      return typeof pub === 'string' ? tryDecodeId(ID_OF[kind]!, pub) : null;
    };

    // หัวใบ: แถวแรกที่มีค่า · แถวอื่นของใบเดียวกันต้องว่างหรือเท่ากัน — เทียบค่าหลังแปลง (id ที่อ้าง/วันที่)
    // เช่น "C-0001" กับชื่อลูกค้าเดียวกัน หรือ "15/11/2569" กับ "2026-11-15" = เท่ากัน
    const resolve = async (r: RowInput, k: (typeof HEADER_KEYS)[number]) => {
      switch (k) {
        case 'customer':
          return ref(r, 'customer', 'customer');
        case 'vehicleType':
          return ref(r, 'vehicleType', 'vehicleType');
        case 'requestedDate': {
          const d = readers.get(r.row)!.date('requestedDate');
          return typeof d === 'string' ? d : null;
        }
        case 'customerRef':
          return cleanLine(r.values.customerRef!);
      }
    };
    const lead: Partial<Record<(typeof HEADER_KEYS)[number], RowInput>> = {};
    const val: Partial<Record<(typeof HEADER_KEYS)[number], string | null>> = {};
    for (const k of HEADER_KEYS)
      for (const r of rows) {
        if (!r.values[k]) continue;
        const v = await resolve(r, k);
        const l = lead[k];
        if (!l) {
          lead[k] = r;
          val[k] = v;
        } else if (v !== null && val[k] !== null && v !== val[k])
          add(r.row, {
            column: k,
            code: 'group_mismatch',
            message: `ไม่ตรงกับแถว ${l.row} ของใบสั่งเดียวกัน — กรอกเฉพาะแถวแรก หรือกรอกให้เหมือนกัน`,
          });
      }
    if (!lead.customer)
      add(first.row, { column: 'customer', code: 'required', message: 'ต้องกรอก "ลูกค้า"' });
    if (!lead.requestedDate)
      add(first.row, {
        column: 'requestedDate',
        code: 'required',
        message: 'ต้องกรอก "วันรับสินค้า"',
      });
    const customerId = val.customer ?? null;
    const requestedDate = val.requestedDate ?? undefined;
    const vehicleTypeId = val.vehicleType ?? null;
    const customerRef = lead.customerRef?.values.customerRef ?? null;

    // จุด + สินค้า ตามลำดับแถว
    const stops: UpsertOrderStop[] = [];
    const stopProv: StopProv[] = [];
    const lines: UpsertOrderLine[] = [];
    const lineProv: number[] = [];
    for (const r of rows) {
      const rd = readers.get(r.row)!;
      let contributes = false;
      for (const s of STOPS) {
        const siteRaw = r.values[s.site];
        const win = (k: string | null) => {
          if (!k || !r.values[k]) return null;
          const w = parseWindow(r.values[k]!, requestedDate);
          if (w === 'no_base') {
            // วันรับสินค้าผิด/ไม่มี — แจ้งที่คอลัมน์วันแล้ว
            if (lead.requestedDate) return null;
            rd.bad(k, 'ระบุวันที่ด้วย (DD/MM/YYYY HH:mm) หรือกรอก "วันรับสินค้า"');
            return null;
          }
          if (!w) rd.bad(k, 'เวลาอ่านไม่ได้ — ใช้ HH:mm หรือ DD/MM/YYYY HH:mm');
          return w;
        };
        if (!siteRaw) {
          for (const k of [s.from, s.to])
            if (k && r.values[k]) rd.bad(k, 'กรอกเวลาแต่ไม่มีสถานที่ของจุดนี้', 'required');
          continue;
        }
        contributes = true;
        const siteId = await ref(r, s.site, 'site');
        const windowStart = win(s.from);
        const windowEnd = win(s.to);
        stops.push({
          type: s.type,
          siteId,
          ...(windowStart ? { windowStart } : {}),
          ...(windowEnd ? { windowEnd } : {}),
        });
        stopProv.push({ row: r.row, site: s.site, from: s.from, to: s.to });
      }
      if (LINE_KEYS.some((k) => r.values[k])) {
        contributes = true;
        const productId = r.values.product ? await ref(r, 'product', 'product') : null;
        const p = productId ? await product(ctx.tx, productId) : null;
        const description = rd.text('description') ?? p?.nameTh;
        if (!description && !r.values.product)
          rd.bad('description', 'ต้องกรอก "รายละเอียดสินค้า" (หรือ "รหัสสินค้า")', 'required');
        const qty = rd.decimal('qty', 3);
        if (!r.values.qty) rd.bad('qty', 'ต้องกรอก "จำนวน"', 'required');
        else if (typeof qty === 'string' && !/[1-9]/.test(qty))
          rd.bad('qty', 'ต้องมากกว่า 0', 'must_be_positive');
        const unitId = r.values.unit ? await ref(r, 'unit', 'unit') : (p?.baseUnitId ?? null);
        if (!r.values.unit && !r.values.product)
          rd.bad('unit', 'ต้องกรอก "หน่วย" (หรือ "รหัสสินค้า")', 'required');
        const weightKg = rd.decimal('weightKg', 3);
        const cbm = rd.decimal('cbm', 3);
        lines.push({
          description: description ?? '',
          qty: typeof qty === 'string' ? qty : '0',
          unitId,
          productId,
          ...(typeof weightKg === 'string' ? { weightKg } : {}),
          ...(typeof cbm === 'string' ? { cbm } : {}),
        });
        lineProv.push(r.row);
      }
      if (!contributes && r !== first)
        rd.bad(
          'pickupSite',
          'แถวนี้ไม่มีจุดรับ-ส่งหรือสินค้า — แถวต่อของใบสั่งต้องมีจุดหรือสินค้าอย่างน้อย 1 อย่าง',
          'required',
        );
    }
    for (const r of rows) for (const x of readers.get(r.row)!.issues) add(r.row, x);

    const externalId = keyed ? cleanLine(first.values.externalId!) : null;
    const isErr = (x: RowIssue) => (x.severity ?? 'error') === 'error';
    const failed = () => [...issues.values()].some((xs) => xs.some(isErr));

    // ORD-026: เวลาเริ่มของจุดส่งต้องไม่ก่อนเวลาเริ่มของจุดรับแรก — คำเตือน (API ยังไม่ตรวจ — #52)
    // มักเกิดจากส่งข้ามวันแต่กรอกแค่ HH:mm (ตีความเป็นวันรับสินค้า)
    const pickIdx = stops.findIndex((x) => x.type === 'PICKUP');
    const pickAt = pickIdx >= 0 ? (stops[pickIdx]!.windowStart ?? stops[pickIdx]!.windowEnd) : null;
    if (pickAt)
      stops.forEach((x, i) => {
        const at = x.windowStart ?? x.windowEnd;
        if (x.type !== 'DELIVERY' || !at || Date.parse(at) >= Date.parse(pickAt)) return;
        const p = stopProv[i]!;
        add(p.row, {
          column: (x.windowStart ? p.from : p.to) ?? p.site,
          code: 'window_before_pickup',
          severity: 'warning',
          message:
            'เวลาส่งอยู่ก่อนเวลารับของจุดรับแรก — ถ้าส่งวันถัดไปให้ใส่วันที่ด้วย (DD/MM/YYYY HH:mm)',
        });
      });

    if (!failed()) {
      const input: UpsertOrderInput = {
        source: 'EXCEL',
        externalId,
        // create_only: ตรวจ "มีเลขนี้แล้ว" ใน upsertOrder หลังล็อก externalId (กันสองงานนำเข้าพร้อมกัน)
        ...(ctx.mode === 'create_only' ? { createOnly: true } : {}),
        customer: { id: customerId },
        customerRef,
        requestedDate: requestedDate!,
        vehicleTypeId,
        stops,
        lines,
        rawPayload: {
          importId: encodeId('import', ctx.importJobId),
          rows: rows.map((r) => ({ row: r.row, values: r.values })),
        },
      };
      // savepoint ต่อใบ: ตรวจแล้วย้อนทิ้งทันที (ไม่มี SO/DO/เลข/audit/event ค้าง) — ยกเว้นตอนยืนยัน
      await ctx.tx.$executeRawUnsafe('SAVEPOINT tms_import_order');
      try {
        const res = await intake.upsertOrder(input, ctx.tx);
        if (!keep) await ctx.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_import_order');
        await ctx.tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_import_order');
        if (res.order.status === 'ON_HOLD')
          add(first.row, {
            code: 'order_on_hold',
            severity: 'warning',
            message: `ใบสั่งจะเข้าระบบเป็นใบค้าง${res.order.holdNote ? ` — ${res.order.holdNote}` : ''}`,
          });
        if (!res.created)
          add(first.row, {
            column: 'externalId',
            code: res.changed ? 'order_updated' : 'order_unchanged',
            severity: 'warning',
            message: res.changed
              ? `อัปเดตใบสั่งเดิม${res.order.soNo ? ` ${res.order.soNo}` : ''}`
              : `มีใบสั่งนี้แล้ว${res.order.soNo ? ` (${res.order.soNo})` : ''} ข้อมูลเหมือนเดิม — ไม่เปลี่ยนแปลง`,
          });
        if (!externalId)
          add(first.row, {
            column: 'externalId',
            code: 'no_external_id',
            severity: 'warning',
            message: 'ไม่มีเลขอ้างอิงใบสั่ง — นำเข้าไฟล์นี้ซ้ำจะได้ใบใหม่ซ้ำ',
          });
      } catch (e) {
        await ctx.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_import_order');
        await ctx.tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_import_order');
        const raw = issuesFromError(e, () => undefined);
        if (!raw) throw e;
        // หลาย path ลงคอลัมน์เดียวกัน (lines[0].unitId + lines[0].unit → "หน่วย") = เหตุผลเดียว
        const seen = new Set<string>();
        for (const x of raw) {
          const { field, ...rest } = x;
          const at = place(field, x.code);
          const k = `${at.row}|${at.column ?? ''}|${x.code}`;
          if (seen.has(k)) continue;
          seen.add(k);
          add(at.row, {
            ...rest,
            ...(at.column ? { column: at.column } : {}),
            ...(IMPORT_MESSAGE[x.code] ? { message: IMPORT_MESSAGE[x.code] } : {}),
          });
        }
      }
    }

    /** path ของ API (`stops[1].windowEnd`, `lines[0].qty`, `customer.id`) → แถว + คอลัมน์ */
    function place(field: string | undefined, code: string): { row: number; column?: string } {
      const top = (k: (typeof HEADER_KEYS)[number]) => ({
        row: lead[k]?.row ?? first.row,
        column: k,
      });
      if (!field)
        return code === 'external_id_conflict' || code === 'order_locked_for_update'
          ? { row: first.row, column: 'externalId' }
          : { row: first.row };
      let m = /^stops\[(\d+)\]\.?(\w*)/.exec(field);
      if (m) {
        const p = stopProv[Number(m[1])];
        if (!p) return { row: first.row, column: 'pickupSite' };
        const col = m[2] === 'windowStart' ? p.from : m[2] === 'windowEnd' ? p.to : p.site;
        return { row: p.row, column: col ?? p.site };
      }
      m = /^lines\[(\d+)\]\.?(\w*)/.exec(field);
      if (m) {
        const row = lineProv[Number(m[1])] ?? first.row;
        const col: Record<string, string> = {
          qty: 'qty',
          unitId: 'unit',
          unit: 'unit',
          productId: 'product',
          itemCode: 'product',
          description: 'description',
          weightKg: 'weightKg',
          cbm: 'cbm',
        };
        return { row, ...(col[m[2]!] ? { column: col[m[2]!] } : {}) };
      }
      if (field === 'stops') return { row: first.row, column: 'pickupSite' };
      if (field === 'lines') return { row: first.row, column: 'qty' };
      if (field.startsWith('customer.') || field === 'customer') return top('customer');
      if (field === 'requestedDate') return top('requestedDate');
      if (field === 'vehicleTypeId') return top('vehicleType');
      if (field === 'customerRef') return top('customerRef');
      if (field === 'externalId') return { row: first.row, column: 'externalId' };
      return { row: first.row };
    }

    // ใบที่มีแถวผิด = ไม่นำเข้าทั้งใบ — แถวอื่นของใบแจ้งเหตุ
    const badRows = rows.filter((r) => issues.get(r.row)!.some(isErr)).map((r) => r.row);
    if (badRows.length)
      for (const r of rows)
        if (!badRows.includes(r.row))
          add(r.row, {
            column: 'externalId',
            code: 'group_has_errors',
            message: `ใบสั่งเดียวกับแถว ${badRows.join(', ')} ที่ผิด — ไม่นำเข้าทั้งใบ`,
          });
    return { ok: !badRows.length, issues };
  }

  /** กลุ่มตามเลขอ้างอิง (ตรงตัวหลังล้างช่องว่าง/อักขระควบคุม) — ไม่มีเลข = ใบละแถว */
  const groupKey = (r: RowInput) => {
    const v = r.values.externalId ? cleanLine(r.values.externalId) : '';
    return v ? `ext:${v}` : `#${r.row}`;
  };
  function groups(rows: RowInput[]): Map<string, RowInput[]> {
    const out = new Map<string, RowInput[]>();
    for (const r of rows) {
      const k = groupKey(r);
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    return out;
  }

  return {
    kind: 'order',
    label: 'ใบสั่งขนส่ง',
    scope: 'orders:write',
    columns: ORDER_IMPORT_COLUMNS,
    // ค่าเริ่มต้น = upsert ตามเลขอ้างอิง (กติกาเดียวกับ API `POST /orders` ที่มี externalId)
    modes: ['upsert_by_code', 'create_only'],
    defaultMode: 'upsert_by_code',
    maxRows: ORDER_MAX_ROWS,
    countEntities: (values) => new Set(values.map((v) => v.group)).size,
    // ตรวจทุกใบด้วย upsertOrder จริง (คิดราคา + DO) — ไฟล์ใหญ่กว่านี้เป็น job (ST2-T23)
    syncMaxRows: ORDER_SYNC_MAX_ROWS,
    sampleRows: SAMPLE_ROWS,
    helpNotes: HELP_NOTES,
    async validate(ctx, rows) {
      const st: GroupState = { lookup: new Lookup(ctx.tx) };
      const apply = !!ctx.apply;
      const out = new Map<number, RowResult<OrderImportValue>>();
      await ctx.tx.$executeRawUnsafe('SAVEPOINT tms_import_dry');
      const discard = async () => {
        await ctx.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_import_dry');
        await ctx.tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_import_dry');
      };
      try {
        for (const [key, g] of groups(rows)) {
          const r = await processGroup(ctx, st, g, key.startsWith('ext:'), apply);
          for (const x of g)
            out.set(x.row, {
              issues: r.issues.get(x.row)!,
              ...(r.ok ? { value: { group: key, input: x } } : {}),
            });
        }
      } catch (e) {
        await discard();
        throw e;
      }
      const results = rows.map((r) => out.get(r.row)!);
      const keepAll =
        apply &&
        !(
          ctx.apply!.errorPolicy === 'all_or_nothing' &&
          (ctx.apply!.rejectedRows > 0 || results.some((x) => !x.value))
        );
      if (keepAll) {
        await ctx.tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_import_dry');
        ctx.apply!.written = true;
      } else await discard();
      return results;
    },
    /** เขียนจริงเมื่อ framework ไม่ได้ตรวจแบบ apply — ประมวลผลใบที่ผ่านใหม่ (ล้ม = ข้อมูลเปลี่ยนระหว่างนำเข้า → ยกเลิกทั้งหมด) */
    async commit(ctx, rows) {
      const st: GroupState = { lookup: new Lookup(ctx.tx) };
      const byGroup = new Map<string, RowInput[]>();
      for (const { value } of rows)
        byGroup.set(value.group, [...(byGroup.get(value.group) ?? []), value.input]);
      for (const [key, g] of byGroup) {
        const r = await processGroup(ctx, st, g, key.startsWith('ext:'), true);
        if (!r.ok)
          throw new ProblemException(
            'conflict',
            `row ${g[0]!.row} no longer passes validation — data changed during import, validate again`,
          );
      }
      return rows.length;
    },
  };
}

/**
 * ไฟล์ order เกินกี่แถววิ่งเป็น job (transaction 5 นาที + แจ้งเตือนเมื่อเสร็จ) — แต่ละใบเรียก upsertOrder จริง
 * (คิดราคา + ประเมินใบค้าง + DO ≈ 80–300 ms/ใบ ตามภาระเครื่อง — วัดใน test/order-import.test.ts) ต้องเสร็จใน
 * transaction ของ request (15 วินาที) ทั้งขั้นตรวจและขั้นยืนยัน — 30 ใบ ≈ 9 วินาทีในกรณีช้า
 */
export const ORDER_SYNC_MAX_ROWS = 30;

/**
 * เพดานแถวต่อไฟล์ order — ยืนยันเขียนทุกใบใน transaction เดียวของ job (MD-286 all-or-nothing; timeout 5 นาที)
 * วัด ≈ 80–300 ms/ใบ (ตรวจซ้ำ + เขียน) → 500 ใบ ≈ 40–150 วินาที · ระหว่างนั้นถือ lock แถว `document_sequence` ของ SO/DO
 * (การสร้าง SO/DO ทางอื่นของบริษัทเดียวกันต้องรอ — spec/12 §3, #52)
 */
export const ORDER_MAX_ROWS = 500;

/** ลงทะเบียน spec `order` (ST3-T04) — แยกจาก MasterImports (ข้อมูลหลัก) */
@Injectable()
export class OrderImports implements OnModuleInit {
  constructor(
    private readonly registry: ImportRegistry,
    private readonly intake: OrderIntakeService,
  ) {}

  onModuleInit() {
    if (!this.registry.get('order')) this.registry.register(orderImportSpec(this.intake));
  }
}
