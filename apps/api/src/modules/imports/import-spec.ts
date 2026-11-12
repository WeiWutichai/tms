import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/db.service';

/**
 * สัญญาของ entity ที่นำเข้าได้ (ST1-T19; backlog "interface `ImportSpec` ต่อ entity")
 * framework ทำ: อ่านไฟล์, จับคู่คอลัมน์, ช่องบังคับ, รายงานรายแถว, dry-run, ยืนยัน, job, รายงาน Excel
 * spec ทำ: ตรวจค่าตามกฎของ entity (ใช้ validator เดียวกับ UI/API — MD-281), ซ้ำในไฟล์/ในฐาน, เขียนจริง
 * entity จริงลงทะเบียนใน ST2-T23 (ลูกค้า จุดส่ง carrier รถ คนขับ …) และ ST3-T04 (order)
 */
export type ImportMode = 'create_only' | 'upsert_by_code' | 'update_only';
export const IMPORT_MODES: ImportMode[] = ['create_only', 'upsert_by_code', 'update_only'];
export type ErrorPolicy = 'all_or_nothing' | 'skip_invalid_rows';
export const ERROR_POLICIES: ErrorPolicy[] = ['all_or_nothing', 'skip_invalid_rows'];

export interface ImportColumn {
  /** ชื่อฟิลด์ใน API (ใช้เป็น key ของแถว) */
  key: string;
  /** หัวคอลัมน์ใน template (ไทย) */
  header: string;
  /** หัวคอลัมน์อื่นที่จับคู่ให้อัตโนมัติ เช่น ['Tax ID', 'เลขภาษี'] */
  aliases?: string[];
  required?: boolean;
  /** ตัวอย่างค่า — แสดงใน sheet คำอธิบายของ template */
  example?: string;
  /** คำอธิบายสั้น ๆ ใน template */
  hint?: string;
  /**
   * ข้อมูลอ่อนไหว (เลขบัตรประชาชน เลขบัญชี — ST2-T23): ค่าในรายงานตรวจ/ตัวอย่าง/ไฟล์แถวผิดแสดงเฉพาะ 4 หลักท้าย
   * (ไม่เก็บค่าเต็มใน import_job และไม่เขียนลงไฟล์ที่ดาวน์โหลด)
   */
  sensitive?: boolean;
  /** ค่าที่เลือกได้ — template ใส่ data validation แบบรายการ (dropdown) ให้คอลัมน์นี้ */
  options?: string[];
  /** บังคับตามเงื่อนไข เช่น "เมื่อเจ้าของเป็นรถร่วม" — แสดงใน sheet คำอธิบาย และใช้ในเหตุผล "ต้องกรอก … เมื่อ …" */
  requiredWhen?: string;
}

/** ปัญหาของแถว — code ตาม spec/02 §11.4 (required, invalid_format, duplicate_in_file, duplicate_in_db, reference_not_found …) */
export interface RowIssue {
  column?: string;
  code: string;
  /** ข้อความไทยที่ผู้ใช้อ่านแล้วแก้ไฟล์ได้ */
  message: string;
  severity?: 'error' | 'warning';
  /** path ใน body ของ API ที่ผิด (ใช้ภายใน spec — ไม่เก็บใน import_job) */
  field?: string;
}

export interface ImportContext {
  tx: Tx;
  tenantId: string;
  actorId: string | null;
  importJobId: string;
  mode: ImportMode;
  /** scope ของผู้สั่ง (ตรวจสิทธิ์ระดับฟิลด์ เช่น บัญชีธนาคาร/ราคา — เท่ากับเรียก API ตรง) */
  scopes: string[];
  /**
   * มีเฉพาะการตรวจซ้ำตอนยืนยัน: spec ที่ตรวจด้วยการเขียนจริงใน savepoint (ข้อมูลหลัก) เก็บผลไว้ได้เลยแทนการเขียนซ้ำใน commit
   * — ต้องย้อนทิ้งทั้งหมดเมื่อ `all_or_nothing` และมีแถวผิด (รวม `rejectedRows` ที่ framework ตัดไปก่อนถึง spec)
   */
  apply?: {
    errorPolicy: ErrorPolicy;
    rejectedRows: number;
    /** spec ตั้ง true เมื่อเก็บการเขียนไว้แล้ว — framework ไม่เรียก commit (นับแถวที่ผ่านเป็นแถวที่นำเข้า) */
    written?: boolean;
  };
}

export interface RowInput {
  /** เลขแถวในไฟล์ (ตรงกับ Excel) */
  row: number;
  /** ค่าตาม key ของคอลัมน์ (ข้อความตัดช่องว่างแล้ว; ว่าง = '') — คอลัมน์ที่ไม่ได้จับคู่ไม่มี key */
  values: Record<string, string>;
}

export interface RowResult<T> {
  value?: T;
  issues: RowIssue[];
}

/** ค่าอ่อนไหวที่แสดงได้: 4 หลักท้าย (เหมือน `•••• 1234` ของ export/response) */
export function maskSensitive(v: string): string {
  const t = v.replace(/[\s-]/g, '');
  return t.length > 4 ? `•••• ${t.slice(-4)}` : '••••';
}

export interface ImportSpec<T = unknown> {
  kind: string;
  /** ชื่อที่แสดง เช่น "ลูกค้า" (หัว wizard "นำเข้า{label}จาก Excel") */
  label: string;
  /** scope ที่ต้องมีเพื่อนำเข้า (เท่ากับสิทธิ์สร้าง entity นั้น — spec/02 §11.2) */
  scope: string;
  /** feature ในแพ็กเกจ (ถ้ามี) */
  feature?: string;
  columns: ImportColumn[];
  /** mode ที่รองรับ (ค่าเริ่มต้น create_only อย่างเดียว) */
  modes?: ImportMode[];
  /**
   * ไฟล์เกินจำนวนแถวนี้ตรวจ/นำเข้าเป็น job (ค่าเริ่มต้น SYNC_MAX_ROWS = 1,000) — spec ที่ตรวจแต่ละแถวด้วยกฎของ API
   * (หลาย query ต่อแถว) ตั้งต่ำกว่านี้ให้คำขอเสร็จทันเวลา transaction ของ request
   */
  syncMaxRows?: number;
  /**
   * โหมด upsert_by_code/update_only: ช่องบังคับใช้เฉพาะแถวที่จะสร้างใหม่ (แถวเดิม — ช่องว่าง = ไม่แก้, MD-284)
   * framework ข้ามการตรวจช่องบังคับในโหมดนั้น และ spec ตรวจเองเฉพาะแถวที่สร้าง
   */
  requiredOnCreateOnly?: boolean;
  /** ตรวจระดับไฟล์ก่อนตรวจรายแถว (เช่น โควตาจำนวนรถ — MD-289) — คืนข้อความไทย = ปฏิเสธทั้งไฟล์ */
  checkFile?(
    ctx: ImportContext,
    rows: RowInput[],
  ): Promise<string | { code: 'quota_exceeded' | 'file_rejected'; message: string } | null>;
  /** ตรวจทุกแถวโดยไม่เขียนข้อมูล (dry-run) — ต้องคืนผลยาวเท่า rows และตามลำดับเดิม */
  validate(ctx: ImportContext, rows: RowInput[]): Promise<RowResult<T>[]>;
  /** เขียนแถวที่ผ่าน (ใน transaction เดียวกับการยืนยัน) — คืนจำนวนที่เขียน */
  commit(ctx: ImportContext, rows: { row: number; value: T }[]): Promise<number>;
}

@Injectable()
export class ImportRegistry {
  private readonly specs = new Map<string, ImportSpec<any>>();

  register(spec: ImportSpec<any>): void {
    if (this.specs.has(spec.kind)) throw new Error(`import spec '${spec.kind}' already registered`);
    if (!/^[a-z][a-z0-9_]*$/.test(spec.kind)) throw new Error(`bad import kind '${spec.kind}'`);
    this.specs.set(spec.kind, spec);
  }

  get(kind: string): ImportSpec<any> | undefined {
    return this.specs.get(kind);
  }

  list(): ImportSpec<any>[] {
    return [...this.specs.values()];
  }
}

// ---------- ตัวช่วยตรวจค่าที่ spec ใช้ร่วมกัน ----------

const TH_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

/**
 * วันที่ในไฟล์ → `YYYY-MM-DD` (ค.ศ.) หรือ null ถ้าอ่านไม่ได้
 * รับ: YYYY-MM-DD, DD/MM/YYYY, D/M/YYYY, "15 พ.ย. 2569" · ปี > 2400 = พ.ศ. (spec/02 §11.4 dateFormat อัตโนมัติ)
 */
export function parseImportDate(s: string): string | null {
  const t = s.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t)))
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})\s+(\S+)\s+(\d{4})$/.exec(t))) {
    const mi = TH_MONTHS.indexOf(r[2]!);
    if (mi < 0) return null;
    [d, m, y] = [Number(r[1]), mi + 1, Number(r[3])];
  } else return null;
  if (y > 2400) y -= 543;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * เลขผู้เสียภาษี 13 หลักจาก Excel (spec/02 §11.8): 12 หลัก = Excel ตัด 0 หน้า → เติม 0 + เตือน;
 * รูปแบบวิทยาศาสตร์ (1.05E+12) → error
 */
export function normalizeTaxId(s: string): { value?: string; issue?: RowIssue } {
  const t = s.replace(/[\s-]/g, '');
  if (/e\+?\d+$/i.test(t))
    return {
      issue: {
        code: 'invalid_format',
        message:
          'เลขผู้เสียภาษีถูก Excel แปลงเป็นตัวเลขวิทยาศาสตร์ — ตั้งคอลัมน์เป็นข้อความแล้วพิมพ์ใหม่',
      },
    };
  if (/^\d{12}$/.test(t))
    return {
      value: `0${t}`,
      issue: {
        code: 'leading_zero_restored',
        severity: 'warning',
        message: 'เลขผู้เสียภาษีมี 12 หลัก เติม 0 ด้านหน้าให้ครบ 13 หลักแล้ว',
      },
    };
  if (!/^\d{13}$/.test(t))
    return { issue: { code: 'invalid_format', message: 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' } };
  return { value: t };
}
