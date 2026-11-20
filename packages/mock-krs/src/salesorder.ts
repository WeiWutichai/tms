import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ST8-T02 แหล่ง SO จำลองของ KRS (docs/01 A.4; plan/08 KRS-11 ทาง B `GET /salesorder?since=`)
 *
 * - ชื่อ view/คอลัมน์ทั้งหมดมาจาก `packages/contracts/krs/salesorder-source.json` ที่เดียว ([OPEN — KRS] ชื่อเสนอ)
 * - 1 แถว = 1 รายการของ SO (หัวเอกสารซ้ำทุกแถว — รูปเดียวกับ view SQL) · `rowVersion` เป็นของทั้งใบ (ทุกแถวของใบเดียวกันเท่ากัน)
 *   เพิ่มขึ้นทุกครั้งที่ใบเปลี่ยน (เหมือน `rowversion` ของ SQL Server: ไม่ซ้ำทั้งฐาน เรียงตามเวลาที่เขียน)
 * - ยกเลิก = แถวยังอยู่ `is_cancelled = 1` + rowVersion ใหม่ (ไม่ลบแถว — poller ต้องเห็นการยกเลิก)
 * - ข้อมูลตัวอย่างปลอมทั้งหมด (prefix `SAMPLE-` / "บริษัทตัวอย่าง") — ไม่ใช่ข้อมูลจริงของลูกค้า
 */

export type SoColumnType = 'string' | 'date' | 'datetime' | 'decimal' | 'int' | 'bigint' | 'bit';

export interface SoColumnSpec {
  column: string;
  type: SoColumnType;
  required: boolean;
}

/** ชื่อเชิงตรรกะของคอลัมน์ (คงที่ในโค้ด) → ชื่อจริงใน view อยู่ในไฟล์ mapping */
export const SO_FIELDS = [
  'company',
  'soNo',
  'soDate',
  'customerCode',
  'customerName',
  'customerPo',
  'deliveryDate',
  'vehicleType',
  'originCode',
  'originName',
  'destinationCode',
  'destinationName',
  'remark',
  'lineNo',
  'itemCode',
  'itemName',
  'qty',
  'unit',
  'cancelled',
  'updatedAt',
  'rowVersion',
] as const;
export type SoField = (typeof SO_FIELDS)[number];

export interface SalesOrderSourceMapping {
  status: string;
  view: string;
  httpPath: string;
  grain: 'line';
  watermark: SoField;
  timezone: string;
  columns: Record<SoField, SoColumnSpec>;
}

export const SALESORDER_MAPPING_FILE = 'salesorder-source.json';

/** อ่าน + ตรวจไฟล์ mapping (ผิดรูป = throw — mock ไม่ยอมเริ่ม) */
export function loadSalesOrderMapping(schemaDir: string): SalesOrderSourceMapping {
  const m = JSON.parse(
    readFileSync(join(schemaDir, SALESORDER_MAPPING_FILE), 'utf8'),
  ) as SalesOrderSourceMapping;
  if (typeof m.view !== 'string' || !m.view) throw new Error('salesorder mapping: view missing');
  if (typeof m.httpPath !== 'string' || !m.httpPath.startsWith('/'))
    throw new Error('salesorder mapping: httpPath must start with /');
  if (!SO_FIELDS.includes(m.watermark)) throw new Error('salesorder mapping: bad watermark');
  const seen = new Set<string>();
  for (const f of SO_FIELDS) {
    const c = m.columns?.[f];
    if (!c || typeof c.column !== 'string' || !c.column)
      throw new Error(`salesorder mapping: column for ${f} missing`);
    if (seen.has(c.column)) throw new Error(`salesorder mapping: duplicate column ${c.column}`);
    seen.add(c.column);
  }
  return m;
}

/** รายการของ SO (ชื่อเชิงตรรกะ) — qty เป็นสตริงทศนิยม (ไม่ใช้ float) */
export interface MockSalesOrderLine {
  lineNo: number;
  itemCode: string;
  itemName: string;
  qty: string;
  unit: string;
}

/** SO หนึ่งใบใน mock (ชื่อเชิงตรรกะ) */
export interface MockSalesOrder {
  company: string;
  soNo: string;
  /** YYYY-MM-DD */
  soDate: string;
  customerCode: string;
  customerName: string;
  customerPo: string | null;
  /** YYYY-MM-DD */
  deliveryDate: string;
  vehicleType: string | null;
  originCode: string | null;
  originName: string;
  destinationCode: string | null;
  destinationName: string;
  remark: string | null;
  lines: MockSalesOrderLine[];
  cancelled: boolean;
  /** `YYYY-MM-DDTHH:mm:ss.SSS` ไม่มี offset (รูป datetime2 ของ SQL Server — เวลาไทยตาม mapping.timezone) */
  updatedAt: string;
  /** ตำแหน่ง watermark (ทั้งใบ) */
  rowVersion: number;
}

/** ข้อมูลที่แก้ได้ผ่าน control (ห้ามแก้ company/soNo/rowVersion เอง) */
export type MockSalesOrderInput = Omit<MockSalesOrder, 'rowVersion' | 'updatedAt' | 'cancelled'> & {
  cancelled?: boolean;
  updatedAt?: string;
};
export type MockSalesOrderPatch = Partial<
  Omit<MockSalesOrder, 'company' | 'soNo' | 'rowVersion' | 'updatedAt'>
> & { updatedAt?: string };

export const SAMPLE_COMPANY = 'SAMPLE';

const line = (lineNo: number, itemCode: string, itemName: string, qty: string, unit: string) => ({
  lineNo,
  itemCode,
  itemName,
  qty,
  unit,
});

/**
 * ข้อมูลตัวอย่าง (ปลอม) — เรียงตาม rowVersion:
 * 0001 ปกติ 1 รายการ · 0002 ปกติ 2 รายการ · 0003 ลูกค้าที่ยังไม่ได้จับคู่ (SAMPLE-C999) ·
 * 0004 **ถูกแก้** (จำนวน/วันส่งเปลี่ยน — updated_at หลังวันที่ SO) · 0005 **ถูกยกเลิก** (is_cancelled = 1)
 */
export function sampleSalesOrders(): MockSalesOrder[] {
  const base = {
    company: SAMPLE_COMPANY,
    customerPo: null,
    vehicleType: null,
    remark: null,
    cancelled: false,
  };
  return [
    {
      ...base,
      soNo: 'SAMPLE-SO-6911-0001',
      soDate: '2026-11-02',
      customerCode: 'SAMPLE-C001',
      customerName: 'บริษัทตัวอย่าง ก จำกัด',
      customerPo: 'SAMPLE-PO-1001',
      deliveryDate: '2026-11-04',
      vehicleType: '6W',
      originCode: 'SAMPLE-WH01',
      originName: 'คลังตัวอย่าง บางนา',
      destinationCode: 'SAMPLE-S001',
      destinationName: 'ร้านตัวอย่าง สาขา 1',
      lines: [line(1, 'SAMPLE-ITEM-01', 'ค่าขนส่ง (ตัวอย่าง)', '1', 'เที่ยว')],
      updatedAt: '2026-11-02T08:15:00.000',
      rowVersion: 1001,
    },
    {
      ...base,
      soNo: 'SAMPLE-SO-6911-0002',
      soDate: '2026-11-02',
      customerCode: 'SAMPLE-C002',
      customerName: 'บริษัทตัวอย่าง ข จำกัด',
      deliveryDate: '2026-11-05',
      vehicleType: '10W',
      originCode: 'SAMPLE-WH01',
      originName: 'คลังตัวอย่าง บางนา',
      destinationCode: null,
      destinationName: 'โรงงานตัวอย่าง นิคมฯ ตัวอย่าง',
      remark: 'ข้อมูลตัวอย่าง — ไม่ใช่งานจริง',
      lines: [
        line(1, 'SAMPLE-ITEM-02', 'สินค้าตัวอย่าง ถุง 50 กก.', '12.500', 'ตัน'),
        line(2, 'SAMPLE-ITEM-03', 'สินค้าตัวอย่าง พาเลท', '8', 'พาเลท'),
      ],
      updatedAt: '2026-11-02T09:40:00.000',
      rowVersion: 1002,
    },
    {
      ...base,
      soNo: 'SAMPLE-SO-6911-0003',
      soDate: '2026-11-03',
      customerCode: 'SAMPLE-C999',
      customerName: 'บริษัทตัวอย่าง ใหม่ จำกัด',
      deliveryDate: '2026-11-06',
      originCode: null,
      originName: 'คลังตัวอย่าง ลาดกระบัง',
      destinationCode: null,
      destinationName: 'ร้านตัวอย่าง สาขา 9',
      lines: [line(1, 'SAMPLE-ITEM-01', 'ค่าขนส่ง (ตัวอย่าง)', '1', 'เที่ยว')],
      updatedAt: '2026-11-03T10:05:00.000',
      rowVersion: 1003,
    },
    {
      ...base,
      soNo: 'SAMPLE-SO-6911-0004',
      soDate: '2026-11-01',
      customerCode: 'SAMPLE-C001',
      customerName: 'บริษัทตัวอย่าง ก จำกัด',
      deliveryDate: '2026-11-07',
      vehicleType: '6W',
      originCode: 'SAMPLE-WH01',
      originName: 'คลังตัวอย่าง บางนา',
      destinationCode: 'SAMPLE-S002',
      destinationName: 'ร้านตัวอย่าง สาขา 2',
      remark: 'แก้จำนวนและวันส่ง (ตัวอย่าง)',
      lines: [line(1, 'SAMPLE-ITEM-02', 'สินค้าตัวอย่าง ถุง 50 กก.', '15.000', 'ตัน')],
      updatedAt: '2026-11-03T14:30:00.000',
      rowVersion: 1004,
    },
    {
      ...base,
      soNo: 'SAMPLE-SO-6911-0005',
      soDate: '2026-11-01',
      customerCode: 'SAMPLE-C002',
      customerName: 'บริษัทตัวอย่าง ข จำกัด',
      deliveryDate: '2026-11-04',
      originCode: 'SAMPLE-WH01',
      originName: 'คลังตัวอย่าง บางนา',
      destinationCode: null,
      destinationName: 'โรงงานตัวอย่าง นิคมฯ ตัวอย่าง',
      remark: 'ลูกค้ายกเลิก (ตัวอย่าง)',
      lines: [line(1, 'SAMPLE-ITEM-01', 'ค่าขนส่ง (ตัวอย่าง)', '1', 'เที่ยว')],
      cancelled: true,
      updatedAt: '2026-11-03T16:00:00.000',
      rowVersion: 1005,
    },
  ];
}

export class SoHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;
const DECIMAL_RE = /^-?\d{1,12}(\.\d{1,6})?$/;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** เวลาไทย (UTC+7 ไม่มี DST) ในรูป datetime2 ไม่มี offset */
function bangkokStamp(d: Date): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 23);
}

export const SO_PAGE_LIMIT_DEFAULT = 100;
export const SO_PAGE_LIMIT_MAX = 500;

export interface SalesOrderPage {
  /** แถวตามชื่อคอลัมน์จริงใน mapping (1 แถว = 1 รายการ) */
  rows: Array<Record<string, string | number | null>>;
  /** watermark ของใบสุดท้ายในหน้านี้ (ไม่มีแถว = ค่า since เดิม) */
  next: string | null;
  hasMore: boolean;
}

/** ที่เก็บ SO ของ mock — ใช้ทั้งใน route `GET /salesorder` และ control `/__mock/salesorders` */
export class MockSalesOrderStore {
  private orders = new Map<string, MockSalesOrder>();
  private nextRowVersion = 1;

  constructor(
    readonly mapping: SalesOrderSourceMapping,
    private readonly sample: boolean,
    private readonly now: () => Date,
  ) {
    this.reset();
  }

  reset(): void {
    this.orders = new Map();
    this.nextRowVersion = 1;
    if (this.sample) for (const so of sampleSalesOrders()) this.put(so);
  }

  list(): MockSalesOrder[] {
    return [...this.orders.values()].sort((a, b) => a.rowVersion - b.rowVersion).map(clone);
  }

  get(company: string, soNo: string): MockSalesOrder | undefined {
    const so = this.orders.get(key(company, soNo));
    return so ? clone(so) : undefined;
  }

  /** เพิ่มหรือแทนที่ทั้งใบ (rowVersion ใหม่เสมอ) */
  upsert(input: MockSalesOrderInput): MockSalesOrder {
    const so: MockSalesOrder = {
      ...clone(input),
      cancelled: input.cancelled ?? false,
      updatedAt: input.updatedAt ?? bangkokStamp(this.now()),
      rowVersion: this.nextRowVersion,
    };
    this.assertValid(so);
    this.put(so);
    return clone(so);
  }

  /** แก้บางช่อง (เหมือนผู้ใช้แก้ SO ใน ERP) → rowVersion + updated_at ใหม่ */
  edit(company: string, soNo: string, patch: MockSalesOrderPatch): MockSalesOrder {
    const cur = this.orders.get(key(company, soNo));
    if (!cur) throw new SoHttpError(404, 'sales order not found');
    const p = clone(patch) as Record<string, unknown>;
    for (const k of ['company', 'soNo', 'rowVersion']) {
      if (k in p) throw new SoHttpError(400, `${k} cannot be changed`);
    }
    const so: MockSalesOrder = {
      ...cur,
      ...(p as MockSalesOrderPatch),
      updatedAt: patch.updatedAt ?? bangkokStamp(this.now()),
      rowVersion: this.nextRowVersion,
    };
    this.assertValid(so);
    this.put(so);
    return clone(so);
  }

  /** ยกเลิก SO ใน ERP — แถวยังอยู่ `is_cancelled = 1` */
  cancel(company: string, soNo: string): MockSalesOrder {
    return this.edit(company, soNo, { cancelled: true });
  }

  /** แถวที่ `watermark > since` เรียงตาม watermark แล้ว lineNo · `limit` นับเป็นจำนวนใบ (ไม่ตัดกลางใบ) */
  page(since: string | null, limit: number): SalesOrderPage {
    const after = since === null ? 0 : Number(since);
    const all = this.list().filter((so) => so.rowVersion > after);
    const taken = all.slice(0, limit);
    const rows = taken.flatMap((so) => this.toRows(so));
    const last = taken[taken.length - 1];
    return {
      rows,
      next: last ? String(last.rowVersion) : since,
      hasMore: all.length > taken.length,
    };
  }

  /** แปลงใบเป็นแถวของ view (ชื่อคอลัมน์จริงตาม mapping) */
  toRows(so: MockSalesOrder): Array<Record<string, string | number | null>> {
    const c = this.mapping.columns;
    return [...so.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => {
        const logical: Record<SoField, string | number | null> = {
          company: so.company,
          soNo: so.soNo,
          soDate: so.soDate,
          customerCode: so.customerCode,
          customerName: so.customerName,
          customerPo: so.customerPo,
          deliveryDate: so.deliveryDate,
          vehicleType: so.vehicleType,
          originCode: so.originCode,
          originName: so.originName,
          destinationCode: so.destinationCode,
          destinationName: so.destinationName,
          remark: so.remark,
          lineNo: l.lineNo,
          itemCode: l.itemCode,
          itemName: l.itemName,
          qty: l.qty,
          unit: l.unit,
          cancelled: so.cancelled ? 1 : 0,
          updatedAt: so.updatedAt,
          rowVersion: String(so.rowVersion),
        };
        const row: Record<string, string | number | null> = {};
        for (const f of SO_FIELDS) row[c[f].column] = logical[f];
        return row;
      });
  }

  private put(so: MockSalesOrder): void {
    this.orders.set(key(so.company, so.soNo), so);
    this.nextRowVersion = Math.max(this.nextRowVersion, so.rowVersion + 1);
  }

  private assertValid(so: MockSalesOrder): void {
    const str = (v: unknown, name: string, required: boolean) => {
      if (v === null && !required) return;
      if (typeof v !== 'string' || !v.trim())
        throw new SoHttpError(400, `${name} must be a string`);
    };
    str(so.company, 'company', true);
    str(so.soNo, 'soNo', true);
    str(so.customerCode, 'customerCode', true);
    str(so.customerName, 'customerName', true);
    str(so.originName, 'originName', true);
    str(so.destinationName, 'destinationName', true);
    for (const f of [
      'customerPo',
      'vehicleType',
      'originCode',
      'destinationCode',
      'remark',
    ] as const)
      str(so[f] ?? null, f, false);
    if (!DATE_RE.test(String(so.soDate))) throw new SoHttpError(400, 'soDate must be YYYY-MM-DD');
    if (!DATE_RE.test(String(so.deliveryDate)))
      throw new SoHttpError(400, 'deliveryDate must be YYYY-MM-DD');
    if (!DATETIME_RE.test(String(so.updatedAt)))
      throw new SoHttpError(400, 'updatedAt must be YYYY-MM-DDTHH:mm:ss.SSS');
    if (typeof so.cancelled !== 'boolean') throw new SoHttpError(400, 'cancelled must be boolean');
    if (!Array.isArray(so.lines) || so.lines.length === 0)
      throw new SoHttpError(400, 'lines must be a non-empty array');
    const nos = new Set<number>();
    for (const l of so.lines) {
      if (!l || !Number.isInteger(l.lineNo) || l.lineNo < 1 || nos.has(l.lineNo))
        throw new SoHttpError(400, 'lineNo must be a unique int >= 1');
      nos.add(l.lineNo);
      str(l.itemCode, 'itemCode', true);
      str(l.itemName, 'itemName', true);
      str(l.unit, 'unit', true);
      if (typeof l.qty !== 'string' || !DECIMAL_RE.test(l.qty))
        throw new SoHttpError(400, 'qty must be a decimal string');
    }
  }
}

function key(company: string, soNo: string): string {
  return `${company}\u0000${soNo}`;
}
