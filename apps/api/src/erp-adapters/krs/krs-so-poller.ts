import { Logger } from '@nestjs/common';
import type { ExternalOrder, PullPage } from '../../modules/connectors/order-source.port';
import { ErpAdapterError, type ErpContext } from '../../modules/erp/erp-adapter';
import type { KrsHttpOptions } from './krs-push';
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
 * - หัวใบ: ลูกค้า = `cust_code` (external_mapping → alias → `customer.external_id` — ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED),
 *   PO = `cust_po`, วันรับของ = `delivery_date`, ประเภทรถ = `vehicle_type`, จุดรับ = origin, จุดส่ง = destination
 * - **ใบที่ KRS ยกเลิก** (`is_cancelled = 1`) → `ExternalOrder.cancelled` (ST8-T05): core ยกเลิกใบใน TMS ถ้ายังไม่มี DO
 *   มี DO แล้ว = ไม่ยกเลิก แจ้งเตือนผู้วางแผนครั้งเดียว · ยังไม่มีใบ = ไม่สร้าง (`OrderStateService.cancelFromSource`)
 * - ลูกค้า: `cust_code` (รหัส NSF) จับคู่ external_mapping(CUSTOMER).source_code ของ connector ก่อน (ST8-T05) แล้วจึงกติกาเดิม
 * - **view หาย (404) / key ผิด** = throw `ErpAdapterError` → core หยุด connector (ERROR) · ตอบไม่ใช่ JSON
 *   (`invalid_response` เช่นหน้า HTML จาก proxy) = TRANSIENT (ลองใหม่ — ล้มต่อเนื่อง 30 นาที = ERROR ตามกติกาเดียวกับ healthCheck)
 * - **คอลัมน์บังคับหาย** = ใบของหน้านั้น `holdOnly` (ใบใหม่ = ใบค้าง SOURCE_ERROR, ใบเดิม = ตั้งปัญหาอย่างเดียว **ไม่ทับข้อมูล**)
 *   + `problem` → core ไม่เลื่อน watermark + หยุด connector (แก้ view แล้วเปิดใช้ → ดึงหน้าเดิมซ้ำ)
 * - **ใบไม่ครบ** ([OPEN — KRS] `rowversion` ต่อแถว → view อาจส่งเฉพาะรายการที่แก้): ทุกใบส่ง `noLineShrink` — รายการน้อยกว่า
 *   ที่เก็บอยู่ = core ไม่ทับ ตั้งใบค้าง SOURCE_ERROR · `line_no` ไม่เป็น 1..n (ขาด/ซ้ำ/ไม่ใช่เลข) = `holdOnly` + เหตุ
 *   **ทั้งสองกรณีไม่หยุด connector และ watermark เดินต่อ** (ใบเดียวค้างให้คนตรวจ — เคลียร์ด้วย "แก้มือ"/รอต้นทางส่งใบครบ)
 *   ข้อจำกัด: ใบ**ใหม่**ที่ถูกตัดรายการท้ายตรวจไม่ได้ (ไม่มีจำนวนรายการ/ watermark ระดับใบจาก KRS — [OPEN — KRS])
 * - แถวที่ไม่มี company/soNo/watermark (`rejectedRows`) รวมเป็นใบไม่ได้ → `warnings` (core เก็บใน last_result + audit)
 * - healthCheck (เปิด pullOrders) อ่านแหล่ง SO 1 ใบด้วย (`probeKrsSoSource`) — view/คอลัมน์ยังเสีย = ทดสอบไม่ผ่าน
 * - ไม่เขียน/อ่านฐานข้อมูล TMS (สัญญา OrderSourcePort) · ข้อความ error ไม่มี key
 */

const logger = new Logger('KrsSoPoller');

export const KRS_EXTERNAL_PREFIX = 'KRS';

export function krsExternalId(company: string, soNo: string): string {
  return `${KRS_EXTERNAL_PREFIX}-${company}-${soNo}`;
}

/** ข้อความปัญหาบนใบ (sourceIssues — ภาษาไทย ผู้ใช้เห็นในหน้าใบค้าง) */
export const KRS_ISSUE = {
  columnsMissing: (view: string, cols: string[]) =>
    `แหล่ง SO ของ KRS (${view}) ไม่มีคอลัมน์ ${cols.join(', ')} — ข้อมูลใบนี้อาจไม่ครบ รอแก้ต้นทางแล้วดึงใหม่`,
  badLines: (why: string) =>
    `เลขรายการสินค้าจาก KRS ไม่ครบหรือผิดรูป (${why}) — ข้อมูลรายการอาจไม่ครบ ไม่ทับข้อมูลเดิม ตรวจกับ KRS`,
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
  holdOnly = false,
): ExternalOrder {
  const issues = [...extraIssues];
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
    // view ระดับรายการอาจส่งใบมาไม่ครบ → ห้ามลดรายการของใบเดิมเงียบ ๆ (core ตั้งใบค้างแทน)
    noLineShrink: true,
    ...(holdOnly ? { holdOnly: true } : {}),
    // ST8-T05 KRS ยกเลิก SO (`is_cancelled = 1`) → core ยกเลิกใน TMS ถ้ายังไม่มี DO มิฉะนั้นแจ้งเตือน (docs/01 A.4)
    ...(so.cancelled ? { cancelled: true } : {}),
  };
}

/** `pullOrders` ของ KrsAdapter */
export async function pullKrsOrders(
  ctx: ErpContext,
  since: string | null,
  limit: number,
  http: KrsHttpOptions = {},
): Promise<PullPage> {
  const mapping = loadKrsSoMapping();
  const r = await readKrsSalesOrders(ctx.config, since, limit, {
    ...http,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    mapping,
  });
  if (!r.ok) {
    if (r.problem.code === 'source_columns_missing') {
      const issue = KRS_ISSUE.columnsMissing(mapping.view, r.missingColumns ?? []);
      return {
        orders: (r.orders ?? [])
          .slice(0, limit)
          .map((so) => krsToExternalOrder(so, mapping, [issue], true)),
        nextCursor: since,
        hasMore: false,
        problem: { errorClass: 'VALIDATION', code: r.problem.code, message: r.problem.message },
      };
    }
    // ตอบไม่ใช่ JSON/ไม่มี rows (เช่น หน้า HTML จาก proxy) = ชั่วคราว — ไม่หยุด connector ทันที
    if (r.problem.code === 'invalid_response') throw new ErpAdapterError('TRANSIENT', r.problem);
    throw new ErpAdapterError(r.errorClass, r.problem);
  }
  const warnings: string[] = [];
  if (r.rejectedRows.length) {
    const w = `${r.rejectedRows.length} row(s) from ${mapping.view} without company/soNo/watermark — skipped`;
    warnings.push(w);
    logger.warn(`connector ${ctx.connectorId}: ${w}`);
  }
  const orders = r.orders.map((so) => {
    const why = krsLinesIncomplete(so);
    return why
      ? krsToExternalOrder(so, mapping, [KRS_ISSUE.badLines(why)], true)
      : krsToExternalOrder(so, mapping);
  });
  return {
    orders,
    nextCursor: r.next,
    hasMore: r.hasMore,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * healthCheck ส่วนแหล่ง SO (เมื่อ tenant เปิด pullOrders) — อ่าน 1 ใบจากต้น · view หาย/คอลัมน์หาย/key ผิด = ไม่ผ่าน
 * (connector ที่ ERROR เพราะแหล่ง SO เสีย จะไม่กลับเป็น ACTIVE จนกว่าต้นทางแก้) · null = ผ่าน
 */
export async function probeKrsSoSource(
  ctx: ErpContext,
  http: KrsHttpOptions = {},
): Promise<{
  errorClass: 'AUTH' | 'TRANSIENT' | 'VALIDATION';
  code: string;
  message: string;
} | null> {
  const r = await readKrsSalesOrders(ctx.config, null, 1, {
    ...http,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    timeoutMs: 10_000,
  });
  if (r.ok) return null;
  const errorClass = r.problem.code === 'invalid_response' ? 'TRANSIENT' : r.errorClass;
  return { errorClass, code: r.problem.code, message: r.problem.message };
}
