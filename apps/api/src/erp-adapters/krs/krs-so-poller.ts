import { Logger } from '@nestjs/common';
import type {
  ExternalOrder,
  PullPage,
  PullProblem,
} from '../../modules/connectors/order-source.port';
import { ErpAdapterError, type ErpContext } from '../../modules/erp/erp-adapter';
import type { SendOptions } from '../../modules/webhooks/webhook-http';
import {
  type KrsSalesOrder,
  type KrsSoMapping,
  loadKrsSoMapping,
  readKrsSalesOrders,
} from './krs-so-source';

/**
 * ST8-T04 SO poller ของ KRS (docs/01 A.2 `pullOrders(since)`, A.4) — แปลงใบจากแหล่ง SO (`readKrsSalesOrders`, ST8-T02)
 * เป็น `ExternalOrder` ให้ core (`ConnectorIntakeService` → `OrderIntakeService.upsertOrder` ทางเดียวกับ
 * `PUT /v1/orders/external/{externalId}`) · scheduler ทุก 5 นาที + cursor/lease/idempotent อยู่ใน core (ST3-T05/ST7-T14)
 *
 * - externalId = `KRS-{company}-{soNo}` (docs/01 A.4) · แถวดิบทั้งหมดของใบเก็บใน `raw_payload` (`{view, rowVersion, rows}`)
 * - หัวใบ: ลูกค้า = `cust_code` (จับคู่ `customer.external_id` — ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED; mapping NSF↔PP = ST8-T05),
 *   PO = `cust_po`, วันรับของ = `delivery_date`, ประเภทรถ = `vehicle_type`, จุดรับ = origin, จุดส่ง = destination
 * - **ใบที่ KRS ยกเลิก** (`is_cancelled = 1`): ขั้นต่ำของ T04 = รับเข้าเป็นใบค้าง SOURCE_ERROR พร้อมเหตุ (กันไม่ให้วางแผนต่อ)
 *   — ยกเลิกใน TMS อัตโนมัติ/แจ้งเตือนเมื่อมี DO = ST8-T05
 * - **view/คอลัมน์หาย**: view หาย (404) / key ผิด = throw `ErpAdapterError` → core หยุด connector (ERROR) ·
 *   คอลัมน์บังคับหาย = ใบของหน้านั้นเข้าเป็นใบค้าง SOURCE_ERROR + `problem` → core ไม่เลื่อน watermark + หยุด connector
 * - **ใบไม่ครบ** ([OPEN — KRS] spec/12 §3 แถว ST8-T02: `rowversion` จริงเป็นค่าต่อแถว → view อาจส่งเฉพาะรายการที่แก้):
 *   สัญญาที่ใช้ = ทุกครั้งที่ใบเปลี่ยนต้นทางส่ง**ทุกรายการ**ของใบ และ `limit` นับเป็นใบ (stub ST8-T02) · ตรวจ `line_no`
 *   ต้องเป็น 1..n ไม่ซ้ำไม่ขาด — ไม่ตรง = **ไม่ส่งใบนั้นเข้า core** (upsert แทนที่รายการทั้งชุด — ห้ามลบรายการเดิมจากใบที่ได้มาบางส่วน)
 *   + `problem` `source_incomplete_order` → ไม่เลื่อน watermark + หยุด connector จนกว่าต้นทางแก้
 * - แถวที่ไม่มี company/soNo/watermark (`rejectedRows`) รวมเป็นใบไม่ได้ → log จำนวน (ไม่มีข้อมูลแถวใน log)
 * - ไม่เขียน/อ่านฐานข้อมูล TMS (สัญญา OrderSourcePort) · ข้อความ error ไม่มี key
 */

const logger = new Logger('KrsSoPoller');

export const KRS_EXTERNAL_PREFIX = 'KRS';

export function krsExternalId(company: string, soNo: string): string {
  return `${KRS_EXTERNAL_PREFIX}-${company}-${soNo}`;
}

/** ข้อความปัญหาบนใบ (sourceIssues — ภาษาไทย ผู้ใช้เห็นในหน้าใบค้าง) */
export const KRS_ISSUE = {
  cancelled: 'KRS ยกเลิก SO นี้แล้ว — ตรวจสอบและยกเลิกใบใน TMS (ยังไม่ยกเลิกอัตโนมัติ)',
  columnsMissing: (view: string, cols: string[]) =>
    `แหล่ง SO ของ KRS (${view}) ไม่มีคอลัมน์ ${cols.join(', ')} — ข้อมูลใบนี้อาจไม่ครบ รอแก้ต้นทางแล้วดึงใหม่`,
} as const;

/** ช่องรายการ 1..n ไม่ซ้ำไม่ขาด (สัญญา "ส่งทั้งใบ") — null = ครบ · อื่น ๆ = เหตุ */
export function krsLinesIncomplete(so: KrsSalesOrder): string | null {
  const nos = so.lines.map((l) => (typeof l.lineNo === 'string' ? Number(l.lineNo) : l.lineNo));
  if (!nos.length) return 'no lines';
  if (nos.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 1))
    return 'line_no is not a positive integer';
  const set = new Set(nos as number[]);
  if (set.size !== nos.length) return 'duplicate line_no';
  for (let i = 1; i <= nos.length; i++) if (!set.has(i)) return `line_no ${i} missing`;
  return null;
}

/** ใบของ KRS → ExternalOrder (ค่าส่งต่อแบบไม่เชื่อ — core ตรวจ/ทำความสะอาดเอง) */
export function krsToExternalOrder(
  so: KrsSalesOrder,
  mapping: Pick<KrsSoMapping, 'view'>,
  extraIssues: string[] = [],
): ExternalOrder {
  const issues = [...extraIssues];
  if (so.cancelled) issues.push(KRS_ISSUE.cancelled);
  const lines = [...so.lines].sort((a, b) => Number(a.lineNo) - Number(b.lineNo));
  return {
    externalId: krsExternalId(so.company, so.soNo),
    customer: { code: so.customerCode, name: so.customerName },
    customerRef: so.customerPo,
    requestedDate: so.deliveryDate,
    vehicleTypeCode: so.vehicleType,
    stops: [
      { type: 'PICKUP', siteCode: so.originCode, text: so.originName },
      { type: 'DELIVERY', siteCode: so.destinationCode, text: so.destinationName },
    ],
    lines: lines.map((l) => ({
      itemCode: l.itemCode,
      description: l.itemName,
      qty: l.qty,
      unit: l.unit,
    })),
    ...(issues.length ? { issues } : {}),
    raw: { view: mapping.view, rowVersion: so.rowVersion, rows: so.raw },
  };
}

/** `pullOrders` ของ KrsAdapter */
export async function pullKrsOrders(
  ctx: ErpContext,
  since: string | null,
  limit: number,
  http: Pick<SendOptions, 'allowPrivate' | 'resolver'> = {},
): Promise<PullPage> {
  const mapping = loadKrsSoMapping();
  const r = await readKrsSalesOrders(ctx.config, since, limit, {
    ...http,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    mapping,
  });
  if (!r.ok) {
    if (r.problem.code === 'source_columns_missing') {
      const cols = r.missingColumns ?? [];
      const issue = KRS_ISSUE.columnsMissing(mapping.view, cols);
      return {
        orders: (r.orders ?? [])
          .slice(0, limit)
          .map((so) => krsToExternalOrder(so, mapping, [issue])),
        nextCursor: since,
        hasMore: false,
        problem: { errorClass: 'VALIDATION', code: r.problem.code, message: r.problem.message },
      };
    }
    throw new ErpAdapterError(r.errorClass, r.problem);
  }
  if (r.rejectedRows.length)
    logger.warn(
      `connector ${ctx.connectorId}: ${r.rejectedRows.length} row(s) from ${mapping.view} without company/soNo/watermark — skipped`,
    );
  const orders: ExternalOrder[] = [];
  const incomplete: string[] = [];
  for (const so of r.orders) {
    const why = krsLinesIncomplete(so);
    if (why) incomplete.push(`${so.company}/${so.soNo} (${why})`);
    else orders.push(krsToExternalOrder(so, mapping));
  }
  if (incomplete.length) {
    const problem: PullProblem = {
      errorClass: 'VALIDATION',
      code: 'source_incomplete_order',
      message: `sales orders with incomplete lines in ${mapping.view}: ${incomplete
        .slice(0, 10)
        .join(', ')}${incomplete.length > 10 ? ` (+${incomplete.length - 10})` : ''}`.slice(0, 300),
    };
    return { orders, nextCursor: since, hasMore: false, problem };
  }
  return { orders, nextCursor: r.next, hasMore: r.hasMore };
}
