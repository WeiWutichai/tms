import type { ErpMasterCodeKind, ErpOperation } from '@tms/domain';
import type {
  CanonicalDocument,
  ErpContext,
  ErpMasterCodeEntry,
  MasterCodeReadiness,
  MasterCodeRef,
} from '../../modules/erp/erp-adapter';

/**
 * รหัส master ของ KRS → `erp_master_code` (ST8-T06; docs/01 A.3 "Validation เฉพาะ KRS ก่อนเข้า outbox"; docs/04 B ผังรหัส ERP)
 *
 * KRS ไม่มี endpoint ผังรหัส (plan/11 #8 — ไม่มี getMasters) → ผังรหัสเข้าทาง **นำเข้าไฟล์** `erp_master_code` (ST7-T18)
 * จากรายการที่ KRS ให้ · ช่องใน payload ของ KRS ที่ต้องเป็นรหัสใน master (A.3):
 *
 * | ช่อง KRS | ชนิดผังรหัส | มาจาก canonical | บังคับ |
 * | --- | --- | --- | --- |
 * | `mainUnits` (ทุกรายการ) | UNIT | `lines[].unitLabel` (เที่ยว/ตัน/กม.) | ใช่ — ต้องอยู่ในผัง |
 * | `custOrSuppCode` (หัวเอกสาร) | CUSTOMER | `customer.externalId` (external_mapping CUSTOMER — docs/01 §7.1) | ใช่ — ต้องมีค่า |
 * | `salePerson` (หัวเอกสาร) | SALESPERSON | ค่าตั้ง connector `salePerson` | ใช่ — ต้องอยู่ในผัง (ตรงรหัสเท่านั้น) |
 * | `saleName` (หัวเอกสาร) | — | **ชื่อ**ของรหัส SALESPERSON ที่หาได้ (`resolvedMasterCodeName(ctx, 'SALESPERSON', …)`) | — |
 * | `itemCode` (รายการ) | ITEM | `lines[].serviceItem.externalId` (mapping ST7-T18) | ไม่ — ตรวจเมื่อมีผัง ITEM |
 * | `accountCode` (รายการ) | ACCOUNT | `lines[].accountCode` | ไม่ — ตรวจเมื่อมีผัง ACCOUNT |
 *
 * - หน่วยหาได้ทั้ง "ตรงรหัส" หรือ "ตรงชื่อของรหัสเดียว" (`matchByName` — TMS เก็บหน่วยเป็นข้อความ) — ใช้ได้ทั้งเมื่อ KRS ใช้รหัส `เที่ยว`
 *   หรือรหัสอื่นที่ชื่อ "เที่ยว" · ชนิดอื่นตรงรหัสเท่านั้น · payload builder (ST8-T07 `krs-invoice-payload.ts`) ส่งรหัสที่หาได้ (`resolvedMasterCode(ctx, 'UNIT', unitLabel)`)
 * - `custOrSuppCode`: docs/01 A.3 ขัดกันเอง (ตาราง = external_mapping(CUSTOMER), บรรทัด "Validation เฉพาะ KRS" = อยู่ใน erp_master_code)
 *   → **[OPEN PO] plan/00b RB-22** · ระหว่างรอ: บังคับว่าต้องมีรหัสลูกค้าฝั่ง ERP (ไม่มี = กัน MISSING) ไม่ตรวจกับผังรหัส
 * - พนักงานขายต่อลูกค้า (docs/01 A.3 "ต่อลูกค้า") ยังไม่มีที่เก็บ → ใช้ค่าตั้งของ connector ตัวเดียว (หรือ `salePerson` ใน canonical
 *   ถ้า ST7-T15 ใส่มา) **[OPEN — KRS ยืนยันว่าต้องต่อลูกค้าไหม]**
 * - `entryBy` ยังไม่ตรวจ (A.6: ถาม KRS ว่าต้องเป็น user ใน ERP ไหม)
 */

/** ชนิดผังรหัสที่ KRS ใช้ (ไม่มี VAT_RATE — สัญญา KRS ไม่มีฟิลด์ VAT ต่อรายการ A.6) */
export const KRS_MASTER_CODE_KINDS: readonly ErpMasterCodeKind[] = Object.freeze([
  'UNIT',
  'SALESPERSON',
  'ITEM',
  'ACCOUNT',
]);

/** หน่วยที่ docs/01 A.3 ระบุว่าต้องตรง master KRS */
export const KRS_REQUIRED_UNITS: readonly string[] = Object.freeze(['เที่ยว', 'ตัน', 'กม.']);

/** คำสั่งที่ส่งใบแจ้งหนี้เข้า KRS (`POST /invoice`, `PUT /invoice/{transactionNo}`) */
const KRS_PUSH_OPERATIONS: ReadonlySet<ErpOperation> = new Set<ErpOperation>([
  'PUSH_INVOICE',
  'REPLACE_DOCUMENT',
]);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * ค่าในใบแจ้งหนี้ที่ต้องอยู่ในผังรหัสของ connector KRS (docs/01 A.3) — ฟังก์ชันบริสุทธิ์ (KrsAdapter.masterCodeRefs)
 * คำสั่งอื่นนอกจาก PUSH_INVOICE / REPLACE_DOCUMENT = ไม่มี
 */
export function krsMasterCodeRefs(
  ctx: Pick<ErpContext, 'config'>,
  operation: ErpOperation,
  doc: CanonicalDocument,
): MasterCodeRef[] {
  if (!KRS_PUSH_OPERATIONS.has(operation)) return [];
  const refs: MasterCodeRef[] = [];
  const header = doc as { salePerson?: unknown; customer?: { externalId?: unknown } | null };
  refs.push({
    kind: 'CUSTOMER',
    value: str(header.customer?.externalId),
    field: 'custOrSuppCode',
    strict: true,
  });
  refs.push({
    kind: 'SALESPERSON',
    value: str(header.salePerson) ?? str(ctx.config.salePerson),
    field: 'salePerson',
    strict: true,
  });
  const raw = (doc as { lines?: unknown }).lines;
  const lines: unknown[] = Array.isArray(raw) ? raw : [];
  lines.forEach((l, i) => {
    const line = (l ?? {}) as {
      unitLabel?: unknown;
      accountCode?: unknown;
      serviceItem?: { externalId?: unknown } | null;
    };
    refs.push({
      kind: 'UNIT',
      value: str(line.unitLabel),
      field: `lines[${i}].unitLabel`,
      strict: true,
      matchByName: true,
    });
    refs.push({
      kind: 'ITEM',
      value: str(line.serviceItem?.externalId),
      field: `lines[${i}].serviceItem.externalId`,
      strict: false,
    });
    refs.push({
      kind: 'ACCOUNT',
      value: str(line.accountCode),
      field: `lines[${i}].accountCode`,
      strict: false,
    });
  });
  return refs;
}

/**
 * ความพร้อมก่อนเปิดส่งใบเข้า KRS (ตรวจตอนเปิด capability ส่งเอกสาร + แสดงในผลทดสอบการเชื่อมต่อ — ไม่กันการบันทึกค่าตั้ง)
 * ต้องมีพนักงานขายที่อยู่ในผัง และนำเข้าผังหน่วยแล้ว
 */
export function krsPushReadiness(ctx: Pick<ErpContext, 'config'>): MasterCodeReadiness {
  return {
    refs: [
      { kind: 'SALESPERSON', value: str(ctx.config.salePerson), field: 'salePerson', strict: true },
    ],
    catalogues: ['UNIT'],
  };
}

/**
 * **ข้อมูลตัวอย่าง — ไม่ใช่รหัสจริงของ KRS** [OPEN — KRS ให้รายการจริง] (plan/08 "Master codes"; ST0-T18)
 * ใช้ทดสอบ/สาธิตการนำเข้าเท่านั้น: หน่วยเป็นข้อความตาม docs/01 A.3 (เที่ยว/ตัน/กม.) · รหัสอื่นขึ้นต้น `SAMPLE-` ให้เห็นชัดว่าเป็นตัวอย่าง
 * ไฟล์ CSV ชุดเดียวกัน (นำเข้าได้ทันทีทางหน้า "นำเข้าข้อมูล" ชนิด "ผังรหัสระบบบัญชี"): `krs-master-codes.sample.csv`
 */
export const KRS_SAMPLE_MASTER_CODES: Readonly<
  Partial<Record<ErpMasterCodeKind, readonly ErpMasterCodeEntry[]>>
> = Object.freeze({
  UNIT: [
    { code: 'เที่ยว', name: 'เที่ยว' },
    { code: 'ตัน', name: 'ตัน' },
    { code: 'กม.', name: 'กม.' },
  ],
  SALESPERSON: [{ code: 'SAMPLE-S01', name: 'ตัวอย่าง — รอรายการจริงจาก KRS' }],
  ITEM: [{ code: 'SAMPLE-ITEM-01', name: 'ตัวอย่าง ค่าขนส่ง — รอรายการจริงจาก KRS' }],
  ACCOUNT: [{ code: 'SAMPLE-ACC-01', name: 'ตัวอย่าง บัญชีรายได้ — รอรายการจริงจาก KRS' }],
});
