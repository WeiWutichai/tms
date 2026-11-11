import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import type { ImportJob, Prisma } from '@prisma/client';
import { scopeAllows } from '@tms/domain';
import { isLocalEnv } from '../../auth/tokens';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import type { Tx } from '../../db/db.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { store } from '../documents/documents.controller';
import { EntitlementService } from '../entitlements/entitlement.service';
import { NotificationService } from '../notifications/notification.service';
import {
  ImportRegistry,
  type ErrorPolicy,
  type ImportMode,
  type ImportSpec,
  type RowIssue,
} from './import-spec';
import { ImportFileError, parseImportFile, type ParsedSheet } from './parse';
import { SAMPLE_IMPORT_SPEC } from './sample.spec-import';

/** ไฟล์เล็กตรวจ/นำเข้าใน request เลย ไฟล์ใหญ่กว่านี้วิ่งเป็น job (backlog T19 "ไฟล์ใหญ่วิ่งเป็น job") */
export const SYNC_MAX_ROWS = 1000;
/** ผลตรวจรอยืนยันได้ 24 ชม. (spec/02 §11.6) */
export const VALIDATED_TTL_MS = 24 * 60 * 60 * 1000;
/** transaction ของ job นำเข้า (ไฟล์ 5,000 แถว + lookup ของ entity) */
export const JOB_TX_TIMEOUT_MS = 5 * 60_000;
/** เก็บรายการปัญหาไม่เกินนี้ใน import_job — ไฟล์แถวผิด (.xlsx) สร้างจากการตรวจใหม่จึงไม่ติดเพดานนี้ */
const MAX_ISSUES = 5000;

export interface StoredIssue extends RowIssue {
  row: number;
  value?: string;
}
export interface SampleRow {
  row: number;
  values: Record<string, string>;
  error: boolean;
}

interface Checked {
  sheet: ParsedSheet;
  mapping: Record<string, string>;
  /** ต่อแถว: ค่าที่ spec ตรวจแล้ว (ถ้าผ่าน) + ปัญหา */
  results: { row: number; value?: unknown; issues: RowIssue[] }[];
}

interface JobPayload {
  importJobId: string;
  /** ผู้สั่งงานรอบนี้ (ผู้กดยืนยันอาจไม่ใช่ผู้อัปโหลด) — ลง audit + รับแจ้งเตือน */
  actorId: string | null;
}
type ImportTemplate =
  | 'import.validated'
  | 'import.file_failed'
  | 'import.completed'
  | 'import.not_imported'
  | 'import.failed';

/**
 * เครื่องยนต์นำเข้า (ST1-T19) — ใช้ร่วมกันระหว่าง controller (ไฟล์เล็ก) และ job (ไฟล์ใหญ่)
 * ขั้นตรวจไม่เรียก `spec.commit` (dry-run, MD-281) · ขั้นยืนยันตรวจใหม่ทั้งไฟล์ก่อนเขียน (ข้อมูลอาจเปลี่ยนระหว่างรอ — §11.8)
 */
@Injectable()
export class ImportService implements OnModuleInit {
  constructor(
    readonly registry: ImportRegistry,
    private readonly queue: JobQueue,
    private readonly notifications: NotificationService,
    @Optional() private readonly entitlements?: EntitlementService,
  ) {}

  onModuleInit() {
    // spec ตัวอย่างใช้เฉพาะ dev/test (ทดสอบ framework ก่อนมี entity จริงใน ST2)
    if (isLocalEnv() && !this.registry.get('sample')) this.registry.register(SAMPLE_IMPORT_SPEC);
    // งานใหญ่ให้เวลา transaction 5 นาที · ล้มครั้งสุดท้าย = ปิดงานนำเข้าเป็น FAILED + แจ้งผู้สั่ง
    const opts = {
      timeoutMs: JOB_TX_TIMEOUT_MS,
      onFinalFailure: async ({ tx, job }: { tx: Tx; job: { payload: unknown } }) => {
        const p = job.payload as unknown as JobPayload;
        const imp = await tx.importJob.findUnique({ where: { id: p.importJobId } });
        if (!imp || (imp.status !== 'VALIDATING' && imp.status !== 'IMPORTING')) return;
        const failed = await tx.importJob.update({
          where: { id: imp.id },
          data: {
            status: 'FAILED',
            fileError: 'ระบบขัดข้องระหว่างทำงาน ไม่มีข้อมูลถูกนำเข้า — ลองอัปโหลดใหม่',
          },
        });
        await this.notifyUser(tx, failed, p.actorId, 'import.failed');
      },
    };
    this.queue.register(
      'import.validate',
      async ({ tx, job }) => {
        const p = job.payload as unknown as JobPayload;
        const imp = await tx.importJob.findUnique({ where: { id: p.importJobId } });
        if (!imp || imp.status !== 'VALIDATING') return { skipped: true };
        const v = (await this.validate(tx, imp))!;
        await this.notifyUser(
          tx,
          v,
          p.actorId,
          v.status === 'FAILED' ? 'import.file_failed' : 'import.validated',
        );
        return { importJobId: encodeId('import', imp.id) };
      },
      opts,
    );
    this.queue.register(
      'import.commit',
      async ({ tx, job }) => {
        const p = job.payload as unknown as JobPayload;
        const imp = await tx.importJob.findUnique({ where: { id: p.importJobId } });
        if (!imp || imp.status !== 'IMPORTING') return { skipped: true };
        const r = await this.commit(tx, imp, p.actorId);
        await this.notifyUser(
          tx,
          r,
          p.actorId,
          r.status === 'VALIDATED'
            ? 'import.not_imported'
            : r.status === 'FAILED'
              ? 'import.file_failed'
              : 'import.completed',
        );
        return { importJobId: encodeId('import', imp.id), imported: r.importedRows };
      },
      opts,
    );
  }

  /** ส่งงานไป job (ไฟล์ > 1,000 แถว) — ผู้สั่งได้แจ้งเตือนเมื่อเสร็จ */
  async enqueue(
    tx: Tx,
    imp: ImportJob,
    type: 'import.validate' | 'import.commit',
    actorId: string | null,
  ): Promise<ImportJob> {
    const payload: JobPayload = { importJobId: imp.id, actorId };
    const job = await this.queue.enqueue(tx, {
      tenantId: imp.tenantId,
      type,
      payload,
      maxAttempts: 1,
    });
    return tx.importJob.update({ where: { id: imp.id }, data: { jobId: job.id } });
  }

  /** แจ้งผลงานนำเข้าที่วิ่งเป็น job (in-app + อีเมล) */
  private async notifyUser(
    tx: Tx,
    imp: ImportJob,
    actorId: string | null,
    template: ImportTemplate,
  ) {
    if (!actorId || !/^[0-9a-f-]{36}$/i.test(actorId)) return;
    const spec = this.registry.get(imp.kind);
    const label = `${spec?.label ?? imp.kind}${imp.fileName ? ` (${imp.fileName})` : ''}`;
    await this.notifications.notify(tx, {
      tenantId: imp.tenantId,
      to: { userIds: [actorId] },
      template,
      vars: {
        label,
        ok: imp.okRows,
        bad: imp.errorRows,
        imported: imp.importedRows,
        reason: imp.fileError ?? '',
      },
      entity: { type: 'import', id: encodeId('import', imp.id) },
    });
  }

  /** spec ที่ผู้เรียกใช้ได้: มี kind, มี scope และแพ็กเกจเปิดฟีเจอร์ (ถ้ากำหนด) — ไม่ผ่าน = 404 เหมือนไม่มี */
  async spec(kind: string, scopes: string[], tenantId: string): Promise<ImportSpec<unknown>> {
    const s = this.registry.get(kind);
    if (!s || !scopeAllows(scopes, s.scope)) throw new ProblemException('not_found');
    if (s.feature && this.entitlements && !(await this.entitlements.enabled(tenantId, s.feature)))
      throw new ProblemException('not_found');
    return s;
  }

  /** จับคู่อัตโนมัติ: หัวคอลัมน์ตรงกับ header/key/aliases (ไม่สนตัวพิมพ์และช่องว่าง) */
  autoMap(spec: ImportSpec<unknown>, headers: string[]): Record<string, string> {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    const out: Record<string, string> = {};
    const used = new Set<string>();
    for (const c of spec.columns) {
      const names = [c.header, c.key, ...(c.aliases ?? [])].map(norm);
      const h = headers.find((x) => !used.has(x) && names.includes(norm(x)));
      if (h) {
        out[c.key] = h;
        used.add(h);
      }
    }
    return out;
  }

  async load(imp: ImportJob, tx: Tx): Promise<ParsedSheet> {
    const doc = await tx.storedDocument.findUnique({ where: { id: imp.documentId } });
    if (!doc?.fileKey) throw new ImportFileError('unreadable', 'ไม่พบไฟล์');
    return parseImportFile(await store().get(doc.fileKey), doc.mimeType);
  }

  /** อ่านไฟล์ + ตรวจตาม mapping (ไม่เขียนข้อมูล) — maxRows: ไฟล์ใหญ่กว่านี้คืน 'too_big' */
  private async check(
    tx: Tx,
    imp: ImportJob,
    actorId: string | null,
    maxRows = Infinity,
  ): Promise<Checked | 'too_big'> {
    const spec = this.registry.get(imp.kind);
    if (!spec) throw new ImportFileError('unreadable', `ไม่รู้จักชนิดข้อมูล ${imp.kind}`);
    const sheet = await this.load(imp, tx);
    if (sheet.rows.length > maxRows) return 'too_big';
    let mapping = imp.mapping as Record<string, string>;
    // จับคู่อัตโนมัติเฉพาะการตรวจครั้งแรก (ยังไม่เคยอ่านหัวคอลัมน์) และผู้เรียกไม่ได้ส่ง mapping มา
    if (!(imp.headers as string[]).length && !Object.keys(mapping).length)
      mapping = this.autoMap(spec, sheet.headers);
    // ทิ้ง mapping ที่ชี้หัวคอลัมน์ที่ไม่มีในไฟล์
    mapping = Object.fromEntries(
      Object.entries(mapping).filter(
        ([k, h]) => sheet.headers.includes(h) && spec.columns.some((c) => c.key === k),
      ),
    );
    const idx = Object.fromEntries(
      Object.entries(mapping).map(([k, h]) => [k, sheet.headers.indexOf(h)]),
    );
    const inputs = sheet.rows.map((cells, i) => ({
      row: sheet.rowNumbers[i]!,
      values: Object.fromEntries(Object.entries(idx).map(([k, j]) => [k, cells[j] ?? ''])),
    }));
    // ช่องบังคับ (framework ตรวจให้ทุก spec) — แถวที่ขาดไม่ส่งให้ spec ตรวจต่อ
    const required = spec.columns.filter((c) => c.required);
    const pre = inputs.map((r) =>
      required
        .filter((c) => !r.values[c.key])
        .map<RowIssue>((c) => ({
          column: c.header,
          code: 'required',
          message: mapping[c.key]
            ? `ต้องกรอก "${c.header}"`
            : `ไม่ได้จับคู่คอลัมน์ "${c.header}" ซึ่งต้องกรอก`,
        })),
    );
    const toCheck = inputs.filter((_, i) => !pre[i]!.length);
    const ctx = {
      tx,
      tenantId: imp.tenantId,
      actorId,
      importJobId: imp.id,
      mode: imp.mode as ImportMode,
    };
    // ตรวจระดับไฟล์ (เช่น โควตา MD-289) ก่อนตรวจรายแถว
    const fileIssue = spec.checkFile ? await spec.checkFile(ctx, inputs) : null;
    if (fileIssue) throw new ImportFileError('file_rejected', fileIssue);
    const checked = toCheck.length ? await spec.validate(ctx, toCheck) : [];
    if (checked.length !== toCheck.length)
      throw new Error(`import spec ${spec.kind} returned wrong row count`);
    let k = 0;
    const results = inputs.map((r, i) => {
      if (pre[i]!.length) return { row: r.row, issues: pre[i]! };
      const c = checked[k++]!;
      return { row: r.row, value: c.value, issues: c.issues };
    });
    return { sheet, mapping, results };
  }

  private summarize(spec: ImportSpec<unknown>, c: Checked) {
    const bad = (r: Checked['results'][number]) =>
      r.issues.some((x) => (x.severity ?? 'error') === 'error') || r.value === undefined;
    const issues: StoredIssue[] = [];
    c.results.forEach((r, i) => {
      for (const x of r.issues) {
        if (issues.length >= MAX_ISSUES) return;
        const col = spec.columns.find((cc) => cc.header === x.column || cc.key === x.column);
        const h = col ? c.mapping[col.key] : undefined;
        const cell = h ? c.sheet.rows[i]?.[c.sheet.headers.indexOf(h)] : undefined;
        issues.push({
          row: r.row,
          ...(col ? { column: col.header } : x.column ? { column: x.column } : {}),
          ...(cell ? { value: cell.slice(0, 200) } : {}),
          code: x.code,
          message: x.message,
          severity: x.severity ?? 'error',
        });
      }
    });
    const errorRows = c.results.filter(bad).length;
    const sample: SampleRow[] = c.results.slice(0, 3).map((r, i) => ({
      row: r.row,
      values: Object.fromEntries(
        spec.columns.map((col) => [
          col.key,
          c.mapping[col.key]
            ? (c.sheet.rows[i]![c.sheet.headers.indexOf(c.mapping[col.key]!)] ?? '')
            : '',
        ]),
      ),
      error: bad(r),
    }));
    return { bad, issues, errorRows, sample };
  }

  /** dry-run: อ่าน ตรวจ เก็บผล — VALIDATED (หรือ FAILED ถ้าไฟล์ใช้ไม่ได้) · ไฟล์ > maxRows คืน null (ไปทำเป็น job) */
  async validate(
    tx: Tx,
    imp: ImportJob,
    maxRows = Infinity,
    actorId: string | null = imp.createdBy,
  ): Promise<ImportJob | null> {
    const spec = this.registry.get(imp.kind)!;
    try {
      const c = await this.check(tx, imp, actorId, maxRows);
      if (c === 'too_big') return null;
      const s = this.summarize(spec, c);
      return tx.importJob.update({
        where: { id: imp.id },
        data: {
          status: 'VALIDATED',
          headers: c.sheet.headers,
          mapping: c.mapping,
          totalRows: c.results.length,
          okRows: c.results.length - s.errorRows,
          errorRows: s.errorRows,
          issues: s.issues as unknown as Prisma.InputJsonValue,
          sample: s.sample as unknown as Prisma.InputJsonValue,
          fileError: null,
          expiresAt: new Date(Date.now() + VALIDATED_TTL_MS),
        },
      });
    } catch (e) {
      if (!(e instanceof ImportFileError)) throw e;
      return tx.importJob.update({
        where: { id: imp.id },
        data: { status: 'FAILED', fileError: e.message, totalRows: 0, okRows: 0, errorRows: 0 },
      });
    }
  }

  /**
   * ยืนยัน: ตรวจใหม่ทั้งไฟล์ → all_or_nothing มีแถวผิด = ไม่เขียนอะไร คืน VALIDATED พร้อมผลตรวจใหม่ /
   * skip_invalid_rows เขียนเฉพาะแถวผ่าน · เขียนใน transaction ของผู้เรียก — ล้มกลางทาง = ไม่มีอะไรถูกเขียน (MD-286)
   */
  async commit(tx: Tx, imp: ImportJob, actorId: string | null): Promise<ImportJob> {
    const spec = this.registry.get(imp.kind)!;
    let c: Checked;
    try {
      c = (await this.check(tx, imp, actorId)) as Checked;
    } catch (e) {
      if (!(e instanceof ImportFileError)) throw e;
      return tx.importJob.update({
        where: { id: imp.id },
        data: { status: 'FAILED', fileError: e.message },
      });
    }
    const s = this.summarize(spec, c);
    const ok = c.results.filter((r) => !s.bad(r));
    const counts = {
      totalRows: c.results.length,
      okRows: ok.length,
      errorRows: s.errorRows,
      issues: s.issues as unknown as Prisma.InputJsonValue,
      sample: s.sample as unknown as Prisma.InputJsonValue,
    };
    // ข้อมูลเปลี่ยนระหว่างรอจนมีแถวผิด (all_or_nothing) → ไม่เขียนอะไร เก็บผลตรวจใหม่ให้ผู้ใช้แก้แล้วยืนยันอีกครั้ง
    if (s.errorRows && (imp.errorPolicy as ErrorPolicy) === 'all_or_nothing')
      return tx.importJob.update({
        where: { id: imp.id },
        data: {
          status: 'VALIDATED',
          ...counts,
          expiresAt: new Date(Date.now() + VALIDATED_TTL_MS),
        },
      });
    const n = ok.length
      ? await spec.commit(
          {
            tx,
            tenantId: imp.tenantId,
            actorId,
            importJobId: imp.id,
            mode: imp.mode as ImportMode,
          },
          ok.map((r) => ({ row: r.row, value: r.value })),
        )
      : 0;
    // MD-287: 1 audit ต่อการนำเข้า (รายการที่สร้างอ้าง importJobId ได้) — ผู้ทำ = ผู้กดยืนยัน
    await tx.auditLog.create({
      data: {
        tenantId: imp.tenantId,
        actorId,
        action: 'import.completed',
        entityType: 'import',
        entityId: imp.id,
        after: { kind: imp.kind, file: imp.fileName, imported: n, skipped: s.errorRows },
      },
    });
    return tx.importJob.update({
      where: { id: imp.id },
      data: {
        status: s.errorRows ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
        importedRows: n,
        ...counts,
      },
    });
  }

  /** แถวผิดพร้อมค่าต้นฉบับ + คอลัมน์ "ผลตรวจ" (spec/02 §11.4) — ตรวจใหม่ทั้งไฟล์ ได้ทุกแถวที่ผิด */
  async errorWorkbook(tx: Tx, imp: ImportJob): Promise<Buffer> {
    const ExcelJS = (await import('exceljs')).default;
    const spec = this.registry.get(imp.kind)!;
    const c = (await this.check(tx, imp, null)) as Checked;
    const s = this.summarize(spec, c);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('แถวที่ผิด');
    ws.addRow([...c.sheet.headers, 'ผลตรวจ']).font = { bold: true };
    c.results.forEach((r, i) => {
      if (!s.bad(r)) return;
      const msg = r.issues
        .filter((x) => (x.severity ?? 'error') === 'error')
        .map((x) => {
          const col = spec.columns.find((cc) => cc.key === x.column || cc.header === x.column);
          const name = col?.header ?? x.column;
          return name ? `${name}: ${x.message}` : x.message;
        });
      ws.addRow([...c.sheet.rows[i]!, msg.join(' · ') || 'ตรวจไม่ผ่าน']);
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** template .xlsx: sheet แรก = หัวคอลัมน์, sheet "คำอธิบาย" = ช่องบังคับ/ตัวอย่าง */
  async template(spec: ImportSpec<unknown>): Promise<Buffer> {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(spec.label);
    const head = ws.addRow(spec.columns.map((c) => c.header));
    head.font = { bold: true };
    spec.columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = Math.max(14, c.header.length + 4);
      ws.getColumn(i + 1).numFmt = '@'; // ข้อความ — กัน Excel ตัด 0 หน้าเลขผู้เสียภาษี/เบอร์โทร
    });
    const help = wb.addWorksheet('คำอธิบาย');
    help.addRow(['คอลัมน์', 'ต้องกรอก', 'ตัวอย่าง', 'คำอธิบาย']).font = { bold: true };
    for (const c of spec.columns)
      help.addRow([c.header, c.required ? 'ต้องกรอก' : '', c.example ?? '', c.hint ?? '']);
    help.getColumn(1).width = 24;
    help.getColumn(3).width = 24;
    help.getColumn(4).width = 48;
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

export type { ErrorPolicy, ImportMode };
