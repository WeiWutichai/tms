import type { Type } from '@nestjs/common';
import { encodeId, type IdKind } from '../../common/ids';
import { iEquals, likeEscape } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { assertPriceWriteAllowed } from '../../common/price-fields';
import { createValidationPipe } from '../../common/validation';
import type { Tx } from '../../db/db.service';
import { plateNorm } from '../vehicles/vehicles.service';
import {
  parseImportDate,
  type ImportColumn,
  type ImportContext,
  type ImportMode,
  type ImportSpec,
  type RowInput,
  type RowIssue,
  type RowResult,
} from './import-spec';
import { issuesFromError } from './reasons';

/**
 * นำเข้าข้อมูลหลักด้วยกฎเดียวกับ API (ST2-T23; spec/02 MD-281 "ใช้ validator เดียวกับ UI/API")
 *
 * ทุกแถว: ค่าในไฟล์ → body ของ API (อ้างอิงด้วยรหัส/ชื่อตรงตัว → id) → ValidationPipe เดียวกับ request (DTO เดียวกัน)
 * → ตรวจสิทธิ์ราคา (เหมือน PriceFieldInterceptor) → **เรียก service.create/update ตัวเดียวกับ POST/PATCH**
 * ใน SAVEPOINT แล้วย้อนกลับ (dry-run ไม่เขียนข้อมูลจริง) — กฎธุรกิจทุกข้อ (ซ้ำ, checksum, ทับช่วงวัน, สิทธิ์บัญชีธนาคาร,
 * เข้ารหัสเลขบัตร …) จึงมาจาก service ที่เดียว ไม่เขียนซ้ำในไฟล์นำเข้า
 *
 * แถวตรวจตามลำดับใน savepoint เดียวกันจนจบไฟล์ → แถวหลังเห็นแถวก่อน (รหัส/คู่เส้นทาง/ช่วงวันซ้ำในไฟล์ = ผิด — MD-283)
 * ยืนยัน = framework ตรวจใหม่ทั้งไฟล์ แล้ว `commit` เรียก service เดิมกับ DTO ที่ตรวจแล้ว ใน transaction เดียว (MD-286)
 */
export const CLEAR = '__CLEAR__';

export interface MasterColumn extends ImportColumn {
  /** path ใน DTO ที่คอลัมน์นี้ป้อน (โยง error ของ API กลับมาที่คอลัมน์) — ค่าเริ่มต้น [key] */
  fields?: string[];
}

export interface MasterValue {
  op: 'create' | 'update';
  id?: string;
  /** แถวต้นฉบับ — ตอนยืนยันประมวลผลใหม่ตามลำดับ (id ที่แถวก่อนหน้าสร้างใน dry-run ถูกย้อนทิ้งไปแล้ว) */
  input: RowInput;
}

type RefKind =
  'customer' | 'site' | 'carrier' | 'vehicleType' | 'serviceItem' | 'route' | 'unit' | 'vehicle';

const REF_LABEL: Record<RefKind, string> = {
  customer: 'ลูกค้า',
  site: 'สถานที่',
  carrier: 'ผู้รับเหมา',
  vehicleType: 'ประเภทรถ',
  serviceItem: 'ค่าบริการ',
  route: 'เส้นทาง',
  unit: 'หน่วย',
  vehicle: 'รถ',
};

type Found = { id: string; extra?: Record<string, string> } | 'none' | 'many';

/** หา id จากรหัส (ไม่สนตัวพิมพ์) ก่อน แล้วจึงชื่อที่ตรงตัว (MD-282) — cache ต่อการตรวจหนึ่งรอบ */
export class Lookup {
  private readonly cache = new Map<string, Promise<Found>>();
  private readonly misses = new Set<string>();
  constructor(private readonly tx: Tx) {}

  /** หลังเขียนแถวสำเร็จ: ลืมผล "ไม่พบ" (แถวถัดไปอ้างรายการที่เพิ่งสร้างในไฟล์เดียวกันได้ — MD-282) */
  forgetMisses(): void {
    for (const k of this.misses) this.cache.delete(k);
    this.misses.clear();
  }

  find(kind: RefKind, v: string): Promise<Found> {
    const k = `${kind}:${v.toLowerCase()}`;
    let p = this.cache.get(k);
    if (!p) {
      p = this.query(kind, v).then((f) => {
        if (f === 'none') this.misses.add(k);
        return f;
      });
      this.cache.set(k, p);
    }
    return p;
  }

  private async query(kind: RefKind, v: string): Promise<Found> {
    const tx = this.tx;
    const one = (rows: { id: string }[]): Found | null =>
      rows.length === 1 ? rows[0]! : rows.length > 1 ? 'many' : null;
    const sel = { id: true } as const;
    const live = { deletedAt: null };
    switch (kind) {
      case 'customer':
        return (
          one(await tx.customer.findMany({ where: { ...live, code: iEquals(v) }, select: sel })) ??
          one(
            await tx.customer.findMany({
              where: { ...live, legalName: iEquals(v) },
              select: sel,
              take: 2,
            }),
          ) ??
          'none'
        );
      case 'site':
        return (
          one(
            await tx.customerSite.findMany({ where: { ...live, code: iEquals(v) }, select: sel }),
          ) ??
          one(
            await tx.customerSite.findMany({
              where: { ...live, name: iEquals(v) },
              select: sel,
              take: 2,
            }),
          ) ??
          'none'
        );
      case 'carrier':
        return (
          one(await tx.carrier.findMany({ where: { ...live, code: iEquals(v) }, select: sel })) ??
          one(
            await tx.carrier.findMany({
              where: { ...live, legalName: iEquals(v) },
              select: sel,
              take: 2,
            }),
          ) ??
          'none'
        );
      case 'vehicleType':
        return (
          one(
            await tx.vehicleType.findMany({ where: { ...live, code: iEquals(v) }, select: sel }),
          ) ??
          one(
            await tx.vehicleType.findMany({
              where: { ...live, nameTh: iEquals(v) },
              select: sel,
              take: 2,
            }),
          ) ??
          'none'
        );
      case 'serviceItem':
        return (
          one(
            await tx.serviceItem.findMany({ where: { ...live, code: iEquals(v) }, select: sel }),
          ) ??
          one(
            await tx.serviceItem.findMany({
              where: { ...live, nameTh: iEquals(v) },
              select: sel,
              take: 2,
            }),
          ) ??
          'none'
        );
      case 'unit':
        return (
          one(await tx.unit.findMany({ where: { ...live, code: iEquals(v) }, select: sel })) ??
          one(
            await tx.unit.findMany({
              where: { ...live, nameTh: iEquals(v) },
              select: sel,
              take: 2,
            }),
          ) ??
          'none'
        );
      case 'route': {
        const r = await tx.route.findMany({
          where: { ...live, code: iEquals(v) },
          select: { id: true, originSiteId: true, destSiteId: true },
        });
        if (r.length !== 1) return r.length ? 'many' : 'none';
        return {
          id: r[0]!.id,
          extra: {
            originId: encodeId('site', r[0]!.originSiteId),
            destinationId: encodeId('site', r[0]!.destSiteId),
          },
        };
      }
      case 'vehicle': {
        // ทะเบียนอย่างเดียว (ไม่มีจังหวัด) — ตรงกันหลายจังหวัด = กำกวม
        const rows = await tx.vehicle.findMany({
          where: { ...live, plateKey: { startsWith: `${likeEscape(plateNorm(v))}|` } },
          select: sel,
          take: 2,
        });
        return one(rows) ?? 'none';
      }
    }
  }
}

const ID_KIND: Record<RefKind, IdKind> = {
  customer: 'customer',
  site: 'site',
  carrier: 'carrier',
  vehicleType: 'vehicleType',
  serviceItem: 'serviceItem',
  route: 'route',
  unit: 'unit',
  vehicle: 'vehicle',
};

const TRUE = new Set(['ใช่', 'มี', 'true', 'yes', 'y', '1', '✓', 'x']);
const FALSE = new Set(['ไม่', 'ไม่ใช่', 'ไม่มี', 'false', 'no', 'n', '0', '-']);
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/**
 * อ่านค่าหนึ่งแถว → ค่าของ API · ว่าง = ไม่ส่ง (undefined) · `__CLEAR__` = ล้างค่า (null) เฉพาะโหมดแก้ (MD-284)
 * อ่านไม่ได้ → เก็บปัญหา (ไทย) แล้วคืน undefined
 */
export class RowReader {
  readonly issues: RowIssue[] = [];
  constructor(
    readonly values: Record<string, string>,
    readonly update: boolean,
    private readonly lookup: Lookup,
  ) {}

  bad(column: string, message: string, code = 'invalid_format'): undefined {
    this.issues.push({ column, code, message });
    return undefined;
  }

  warn(column: string, code: string, message: string): void {
    this.issues.push({ column, code, message, severity: 'warning' });
  }

  /** ข้อความ (ตัดช่องว่างแล้ว) */
  text(key: string): string | null | undefined {
    const v = this.values[key];
    if (v === undefined || v === '') return undefined;
    if (v.toUpperCase() === CLEAR) return this.update ? null : undefined;
    return v;
  }

  private numeric(key: string): string | null | undefined {
    const v = this.text(key);
    if (typeof v !== 'string') return v;
    return v.replace(/[,\s฿]/g, '');
  }

  int(key: string): number | null | undefined {
    const v = this.numeric(key);
    if (typeof v !== 'string') return v;
    if (!/^-?\d+(\.0+)?$/.test(v)) return this.bad(key, 'ต้องเป็นจำนวนเต็ม');
    return Number.parseInt(v, 10);
  }

  num(key: string): number | null | undefined {
    const v = this.numeric(key);
    if (typeof v !== 'string') return v;
    if (!/^-?\d+(\.\d+)?$/.test(v)) return this.bad(key, 'ต้องเป็นตัวเลข');
    return Number(v);
  }

  /** เงิน/ทศนิยมแบบข้อความ (ไม่ผ่าน float) — ตรวจจำนวนทศนิยมที่ DTO */
  decimal(key: string): string | null | undefined {
    const v = this.numeric(key);
    if (typeof v !== 'string') return v;
    if (!/^\d+(\.\d+)?$/.test(v)) return this.bad(key, 'ต้องเป็นตัวเลขไม่ติดลบ');
    return v;
  }

  bool(key: string): boolean | null | undefined {
    const v = this.text(key);
    if (typeof v !== 'string') return v;
    if (TRUE.has(norm(v))) return true;
    if (FALSE.has(norm(v))) return false;
    return this.bad(key, 'ต้องเป็น ใช่ หรือ ไม่');
  }

  date(key: string): string | null | undefined {
    const v = this.text(key);
    if (typeof v !== 'string') return v;
    return (
      parseImportDate(v) ?? this.bad(key, 'วันที่อ่านไม่ได้ — ใช้ DD/MM/YYYY (พ.ศ. หรือ ค.ศ.)')
    );
  }

  /** ค่าในรายการ: รับรหัสของ API หรือชื่อภาษาไทยที่กำหนด (ไม่สนช่องว่าง/ตัวพิมพ์) */
  pick<T extends string>(key: string, options: Record<T, string[]>): T | null | undefined {
    const v = this.text(key);
    if (typeof v !== 'string') return v;
    const n = norm(v);
    for (const [code, labels] of Object.entries(options) as [T, string[]][])
      if (norm(code) === n || labels.some((l) => norm(l) === n)) return code;
    return this.bad(
      key,
      `ค่าไม่อยู่ในรายการ — ใช้ ${Object.values<string[]>(options)
        .map((l) => l[0])
        .join(' / ')}`,
    );
  }

  /** อ้างอิงด้วยรหัสหรือชื่อตรงตัว → id ของ API (`cus_…`) */
  async ref(key: string, kind: RefKind): Promise<string | null | undefined> {
    const r = await this.refFull(key, kind);
    return r && typeof r === 'object' ? r.id : r;
  }

  async refFull(
    key: string,
    kind: RefKind,
  ): Promise<{ id: string; extra?: Record<string, string> } | null | undefined> {
    const v = this.text(key);
    if (typeof v !== 'string') return v;
    const f = await this.lookup.find(kind, v);
    if (f === 'none')
      return this.bad(
        key,
        `ไม่พบ${REF_LABEL[kind]} "${v.slice(0, 60)}" ในข้อมูลหลัก`,
        'reference_not_found',
      );
    if (f === 'many')
      return this.bad(
        key,
        `พบ${REF_LABEL[kind]}ชื่อนี้มากกว่า 1 รายการ — ใช้รหัสแทน`,
        'ambiguous_reference',
      );
    return { id: encodeId(ID_KIND[kind], f.id), ...(f.extra ? { extra: f.extra } : {}) };
  }
}

/** ใส่ค่าใน body เฉพาะที่มี (undefined = ไม่ส่ง) */
export function put(body: Record<string, unknown>, key: string, v: unknown): void {
  if (v !== undefined) body[key] = v;
}

/** object ย่อย (ที่อยู่ ผู้ติดต่อ บัญชี): ไม่มีค่าเลย = ไม่ส่ง · ล้างทุกช่อง = null */
export function group(parts: Record<string, unknown>): Record<string, unknown> | null | undefined {
  const given = Object.entries(parts).filter(([, v]) => v !== undefined);
  if (!given.length) return undefined;
  if (given.every(([, v]) => v === null)) return null;
  return Object.fromEntries(given.filter(([, v]) => v !== null));
}

export interface MasterImportDef {
  kind: string;
  label: string;
  scope: string;
  feature?: string;
  columns: MasterColumn[];
  /** ค่าเริ่มต้น create_only (spec/02 §11.4) · upsert_by_code/update_only ต้องมี findExisting + update */
  modes?: ImportMode[];
  syncMaxRows?: number;
  createDto: Type<object>;
  updateDto?: Type<object>;
  /** คอลัมน์ที่ใช้หาแถวเดิม (รายงานเมื่อไม่พบในโหมด update_only) */
  identity?: string;
  /** แถวเดิมในระบบ (โหมด upsert_by_code/update_only) — คืน uuid */
  findExisting?(values: Record<string, string>, tx: Tx): Promise<string | null>;
  /** ค่าซ้ำในไฟล์ (MD-283) — key ว่าง = ไม่ตรวจ */
  uniqueInFile?: {
    column: string;
    label: string;
    key(values: Record<string, string>): string | null;
  }[];
  /** แถว → body ของ API (create = POST, update = PATCH) */
  build(r: RowReader, op: 'create' | 'update'): Promise<Record<string, unknown>>;
  create(dto: object): Promise<unknown>;
  update?(id: string, dto: object): Promise<unknown>;
  /** คำเตือนหลังผ่าน (ไม่ขวางการนำเข้า) */
  warnings?(r: RowReader, body: Record<string, unknown>, op: 'create' | 'update'): void;
  checkFile?: ImportSpec['checkFile'];
}

const isError = (x: RowIssue) => (x.severity ?? 'error') === 'error';

export function defineMasterImport(def: MasterImportDef): ImportSpec<MasterValue> {
  const pipe = createValidationPipe();
  const fieldsOf = (c: MasterColumn) => (c.fields ?? [c.key]).map((f) => f.replace(/\.\d+/g, ''));
  /** path ใน DTO (`contacts.0.phone`) → key คอลัมน์ */
  const columnOf = (field: string): string | undefined => {
    const f = field.replace(/\.\d+/g, '');
    return (
      def.columns.find((c) => fieldsOf(c).includes(f))?.key ??
      def.columns.find((c) => fieldsOf(c).some((x) => x.startsWith(`${f}.`)))?.key ??
      def.columns.find((c) => fieldsOf(c).some((x) => f.startsWith(`${x}.`)))?.key
    );
  };
  const modes = def.modes ?? ['create_only'];
  /** งานนำเข้าที่ validate (ตอนยืนยัน) เขียนจริงแล้ว — commit ไม่ต้องเขียนซ้ำ */
  const applied = new Set<string>();

  async function one(
    ctx: ImportContext,
    lookup: Lookup,
    seen: Map<string, number>[],
    r: RowInput,
  ): Promise<RowResult<MasterValue>> {
    const issues: RowIssue[] = [];
    let op: 'create' | 'update' = 'create';
    let id: string | undefined;
    if (ctx.mode !== 'create_only' && def.findExisting) {
      const ex = await def.findExisting(r.values, ctx.tx);
      if (ex) {
        op = 'update';
        id = ex;
      } else if (ctx.mode === 'update_only')
        return {
          issues: [
            {
              ...(def.identity ? { column: def.identity } : {}),
              code: 'reference_not_found',
              message: 'ไม่พบรายการนี้ในระบบ (โหมดแก้ไขอย่างเดียวไม่สร้างรายการใหม่)',
            },
          ],
        };
    }
    // ช่องบังคับของแถวที่จะสร้าง (โหมด upsert/update — framework ข้ามให้ เพราะแถวเดิมเว้นว่างได้)
    if (op === 'create' && ctx.mode !== 'create_only')
      for (const c of def.columns)
        if (c.required && !r.values[c.key])
          issues.push({ column: c.key, code: 'required', message: `ต้องกรอก "${c.header}"` });
    def.uniqueInFile?.forEach((u, i) => {
      const k = u.key(r.values);
      if (!k) return;
      const first = seen[i]!.get(k);
      if (first !== undefined)
        issues.push({
          column: u.column,
          code: 'duplicate_in_file',
          message: `${u.label}ซ้ำกับแถว ${first} ในไฟล์เดียวกัน`,
        });
      else seen[i]!.set(k, r.row);
    });
    const reader = new RowReader(r.values, op === 'update', lookup);
    const body = await def.build(reader, op);
    issues.push(...reader.issues);
    if (issues.some(isError)) return { issues };
    // DTO + ValidationPipe เดียวกับ request (whitelist, field แปลกปลอม = ผิด, CleanText/NormalizeCode)
    let dto: object;
    try {
      dto = (await pipe.transform(body, {
        type: 'body',
        metatype: op === 'update' ? def.updateDto : def.createDto,
      })) as object;
      assertPriceWriteAllowed(body);
    } catch (e) {
      const x = issuesFromError(e, columnOf);
      if (!x) throw e;
      return { issues: [...issues, ...x] };
    }
    // กฎธุรกิจ: service ตัวเดียวกับ API ใน savepoint (ผ่าน = คงไว้จนจบไฟล์ให้แถวถัดไปเห็น · ผิด = ย้อนเฉพาะแถวนี้)
    await ctx.tx.$executeRawUnsafe('SAVEPOINT tms_import_row');
    try {
      if (op === 'update') await def.update!(id!, dto);
      else await def.create(dto);
      await ctx.tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_import_row');
      lookup.forgetMisses();
    } catch (e) {
      await ctx.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_import_row');
      await ctx.tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_import_row');
      const x = issuesFromError(e, columnOf);
      if (!x) throw e;
      return { issues: [...issues, ...x] };
    }
    const w = new RowReader(r.values, op === 'update', lookup);
    def.warnings?.(w, body, op);
    return { issues: [...issues, ...w.issues], value: { op, ...(id ? { id } : {}), input: r } };
  }

  return {
    kind: def.kind,
    label: def.label,
    scope: def.scope,
    ...(def.feature ? { feature: def.feature } : {}),
    columns: def.columns,
    modes,
    syncMaxRows: def.syncMaxRows ?? MASTER_SYNC_MAX_ROWS,
    requiredOnCreateOnly: true,
    ...(def.checkFile ? { checkFile: def.checkFile } : {}),
    async validate(ctx, rows) {
      const lookup = new Lookup(ctx.tx);
      const seen = (def.uniqueInFile ?? []).map(() => new Map<string, number>());
      const out: RowResult<MasterValue>[] = [];
      // dry-run: ทุกการเขียนของ service อยู่ใน savepoint นี้แล้วย้อนทิ้งทั้งหมด (MD-281)
      await ctx.tx.$executeRawUnsafe('SAVEPOINT tms_import_dry');
      try {
        for (const r of rows) out.push(await one(ctx, lookup, seen, r));
      } catch (e) {
        await ctx.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_import_dry');
        await ctx.tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_import_dry');
        throw e;
      }
      // ตรวจซ้ำตอนยืนยัน: เก็บการเขียนไว้เลย (แถวผิดถูกย้อนทีละแถวแล้ว) — ยกเว้นทั้งหมดหรือไม่เลยที่มีแถวผิด
      const keep =
        !!ctx.apply &&
        !(
          ctx.apply.errorPolicy === 'all_or_nothing' &&
          (ctx.apply.rejectedRows > 0 || out.some((x) => !x.value))
        );
      if (!keep) await ctx.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_import_dry');
      await ctx.tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_import_dry');
      if (keep) applied.add(ctx.importJobId);
      return out;
    },
    /**
     * เขียนจริง: ประมวลผลแถวที่ผ่านใหม่ตามลำดับด้วยขั้นตอนเดียวกับ dry-run (ไม่ย้อนทิ้ง) — อ้างอิงถึงแถวก่อนหน้าในไฟล์
     * ได้ id จริง · แถวที่ผ่านตอนตรวจแต่ล้มตอนเขียน (ข้อมูลถูกแก้พร้อมกัน) = ยกเลิกทั้งการนำเข้า (transaction เดียว)
     */
    async commit(ctx, rows) {
      // เขียนไปแล้วตอนตรวจซ้ำใน transaction เดียวกัน (ctx.apply)
      if (applied.delete(ctx.importJobId)) return rows.length;
      const lookup = new Lookup(ctx.tx);
      const seen = (def.uniqueInFile ?? []).map(() => new Map<string, number>());
      for (const { value } of rows) {
        const res = await one(ctx, lookup, seen, value.input);
        if (!res.value)
          throw new ProblemException(
            'conflict',
            `row ${value.input.row} no longer passes validation — data changed during import, validate again`,
          );
      }
      return rows.length;
    },
  };
}

/**
 * ไฟล์ข้อมูลหลักเกินกี่แถววิ่งเป็น job — ตรวจแต่ละแถวด้วย service จริง (หลาย query/แถว) และยืนยันตรวจซ้ำอีกรอบ
 * ต้องเสร็จใน transaction ของ request (15 วินาที)
 */
export const MASTER_SYNC_MAX_ROWS = 200;

/** หาแถวเดิมด้วยรหัส (ไม่สนตัวพิมพ์, ไม่นับที่ลบ) */
export const byCode =
  (find: (tx: Tx, code: string) => Promise<{ id: string } | null>) =>
  async (values: Record<string, string>, tx: Tx): Promise<string | null> => {
    const code = values.code?.trim();
    if (!code) return null;
    return (await find(tx, code))?.id ?? null;
  };
