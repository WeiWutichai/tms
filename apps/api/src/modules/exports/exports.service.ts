import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Job, StoredDocument } from '@prisma/client';
import { scopeAllows } from '@tms/domain';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PassThrough } from 'node:stream';
import { AuditService } from '../../audit/audit.service';
import { encodeId, tryDecodeId } from '../../common/ids';
import { redactPrices } from '../../common/price-fields';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { JobQueue, type JobContext } from '../../jobs/job-queue.service';
import { putFileLocked } from '../documents/documents.controller';
import { escapeHtml, PdfRenderer } from '../../pdf/pdf-renderer';
import { csvCell, type ExportColumn } from '../master/export';
import { EntitlementService } from '../entitlements/entitlement.service';
import { NotificationService } from '../notifications/notification.service';
import { EXPORT_RETENTION_DAYS } from '../retention/retention-policy';
import { ExportRegistry, type ExportSpec } from './export-spec';

export const EXPORT_JOB_TYPE = 'export.file';
/** [DECISION ST9-T10] เพดานต่อไฟล์ส่งออกแบบ job (เกิน = ไม่สร้างไฟล์ แจ้งให้กรองให้แคบลง) */
export const EXPORT_JOB_MAX_ROWS = 100_000;
/** [DECISION ST9-T10] ไฟล์ส่งออกดาวน์โหลดได้ 7 วันหลังสร้างเสร็จ (retention job ST9-T14 ลบไฟล์ตามค่านี้) */
export { EXPORT_RETENTION_DAYS };
/** อ่านทีละหน้า (keyset ต่อจาก id ของแถวสุดท้าย) */
export const EXPORT_BATCH = 1000;
/** transaction ของ job ส่งออก (100,000 แถว) — น้อยกว่า lease 5 นาทีของคิว */
const JOB_TIMEOUT_MS = 4 * 60_000;
/** ตัวกรองที่เกี่ยวกับการแบ่งหน้า — ไม่มีผลกับไฟล์ (ไฟล์มีทุกแถวตามตัวกรอง เรียงตามลำดับของการส่งออก) */
const PAGING_KEYS = ['limit', 'cursor', 'sort', 'fields', 'updatedAfter'] as const;

export const EXPORT_MIME = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;
/** [DECISION ST9-T05] เพดานแถวของไฟล์ PDF (ตาราง A4 — รายงานสรุปเท่านั้น) · เกิน = `too_many_rows` ให้ใช้ Excel */
export const EXPORT_PDF_MAX_ROWS = 2_000;
export type ExportFormat = keyof typeof EXPORT_MIME;

/** ข้อผิดพลาดที่ผู้ใช้แก้ได้ — `String(err)` = `ExportError: <code>` (เก็บใน job.error แล้วแปลงกลับเป็น code) */
export class ExportError extends Error {
  constructor(readonly code: 'too_many_rows' | 'permission_denied' | 'unknown_resource') {
    super(code);
    this.name = 'ExportError';
  }
}

interface ExportPayload {
  resource: string;
  format: ExportFormat;
  filter: Record<string, string>;
  actorId: string | null;
  scopes: string[];
  principalType?: string;
  actAs?: string;
}

export interface ExportResult {
  documentId: string;
  rows: number;
  fileName: string;
  bytes: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const anyScope = (scopes: readonly string[], need: string | string[]) =>
  (Array.isArray(need) ? need : [need]).some((s) => scopeAllows(scopes, s));

/** วันเวลา Bangkok สำหรับชื่อไฟล์ เช่น 20261118-0930 */
function stamp(d = new Date()): string {
  const b = new Date(d.getTime() + 7 * 3600_000).toISOString();
  return `${b.slice(0, 10).replace(/-/g, '')}-${b.slice(11, 16).replace(':', '')}`;
}

/** ตัวเขียนไฟล์ทีละชุด — xlsx ใช้ streaming writer (ไม่ถือทั้ง workbook ในหน่วยความจำ) */
interface FileWriter<R> {
  add(rows: R[]): void;
  finish(): Promise<Buffer>;
}

function csvWriter<R>(columns: ExportColumn<R>[]): FileWriter<R> {
  const parts: Buffer[] = [
    Buffer.from('﻿' + columns.map((c) => csvCell(c.header)).join(',') + '\r\n', 'utf8'),
  ];
  return {
    add(rows) {
      const lines = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(','));
      if (lines.length) parts.push(Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'));
    },
    finish: async () => Buffer.concat(parts),
  };
}

async function xlsxWriter<R>(columns: ExportColumn<R>[], sheet: string): Promise<FileWriter<R>> {
  const ExcelJS = (await import('exceljs')).default;
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((ok, fail) => {
    out.on('end', ok);
    out.on('error', fail);
  });
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useSharedStrings: false });
  const ws = wb.addWorksheet(sheet.slice(0, 31));
  ws.columns = columns.map(() => ({ width: 20 }));
  const head = ws.addRow(columns.map((c) => c.header));
  head.font = { bold: true };
  head.commit();
  return {
    add(rows) {
      // .xlsx เก็บค่าเป็นเซลล์ชนิดข้อความ/ตัวเลข (ไม่ถูกตีความเป็นสูตร) — เหมือน sendExport ของข้อมูลหลัก
      for (const r of rows) ws.addRow(columns.map((c) => c.value(r) ?? null)).commit();
    },
    async finish() {
      ws.commit();
      await wb.commit();
      await done;
      return Buffer.concat(chunks);
    },
  };
}

/** วันเวลาไทยแบบอ่าน (หัว PDF) เช่น 22/11/2569 09:30 */
function thaiStamp(d = new Date()): string {
  const b = new Date(d.getTime() + 7 * 3600_000).toISOString();
  return `${b.slice(8, 10)}/${b.slice(5, 7)}/${Number(b.slice(0, 4)) + 543} ${b.slice(11, 16)}`;
}

/** PDF ตาราง A4 แนวนอน (ST9-T05) — แถว id `total` = แถวรวม (ตัวหนา) — เก็บแถวในหน่วยความจำ (≤ EXPORT_PDF_MAX_ROWS) แล้ว render ครั้งเดียวด้วย PdfRenderer (ฟอนต์ Sarabun ฝัง) */
function pdfWriter<R>(
  columns: ExportColumn<R>[],
  pdf: PdfRenderer,
  head: { title: string; subtitle?: string },
): FileWriter<R> {
  const body: string[] = [];
  const isNum = (v: unknown) => typeof v === 'number';
  const cell = (v: string | number | null | undefined) =>
    v === null || v === undefined
      ? ''
      : typeof v === 'number' && !Number.isInteger(v)
        ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : escapeHtml(typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
  return {
    add(rows) {
      if (body.length + rows.length > EXPORT_PDF_MAX_ROWS) throw new ExportError('too_many_rows');
      for (const r of rows)
        body.push(
          `<tr${(r as { id?: unknown }).id === 'total' ? ' class="t"' : ''}>${columns
            .map((c) => {
              const v = c.value(r);
              return `<td${isNum(v) ? ' class="r"' : ''}>${cell(v)}</td>`;
            })
            .join('')}</tr>`,
        );
    },
    async finish() {
      const html = `<div class="page"><h1>${escapeHtml(head.title)}</h1>
<p class="sub">${head.subtitle ? `${escapeHtml(head.subtitle)} · ` : ''}พิมพ์เมื่อ ${escapeHtml(thaiStamp())}</p>
<table><thead><tr>${columns.map((c) => `<th>${escapeHtml(c.header)}</th>`).join('')}</tr></thead>
<tbody>${body.join('')}</tbody></table></div>`;
      const css = `@page{size:A4 landscape;margin:12mm}.page{font-size:12px}h1{font-size:18px;margin:0 0 4px}
.sub{color:#3B424C;margin:0 0 10px}table{width:100%;border-collapse:collapse}
th,td{border:1px solid #CDD1C8;padding:4px 6px;text-align:left;vertical-align:top}th{background:#EEF0EC;font-weight:600}
thead{display:table-header-group}tr{break-inside:avoid}.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.t td{font-weight:700;background:#F4F5F2}`;
      return pdf.pdf({ body: html, css, title: head.title });
    },
  };
}

/**
 * ส่งออกตามตัวกรองของหน้ารายการเป็นงานเบื้องหลัง (ST9-T10; docs/04 I, docs/01 §5.1 Bulk/async)
 * - `POST /v1/exports` ตรวจตัวกรองด้วย class ตัวกรองของรายการ + ลองอ่าน 1 แถว (ตัวกรองผิดตอบ 422 ทันที) → 202 + job
 * - job อ่านผ่าน service ของรายการ (where-builder/RLS/DTO เดียวกัน) ภายใต้ context ของผู้สั่ง (scope ปัจจุบัน ∩ ตอนสั่ง)
 *   เขียนไฟล์ .xlsx/.csv (UTF-8 BOM) เก็บเป็นเอกสาร kind EXPORT → แจ้งเตือนผู้สั่ง (in-app + อีเมล) พร้อมลิงก์ `/exports/{jobId}`
 * - ดาวน์โหลด: `GET /v1/exports/{id}` (เฉพาะผู้สั่ง) คืน URL ลายเซ็นอายุ 5 นาที · ไฟล์ใช้ได้ 7 วัน
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  /** เพดานแถวต่อไฟล์ (test ปรับให้เล็กลงได้) */
  maxRows = EXPORT_JOB_MAX_ROWS;

  constructor(
    private readonly registry: ExportRegistry,
    private readonly queue: JobQueue,
    private readonly db: DbService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly pdf: PdfRenderer,
    private readonly entitlements: EntitlementService,
  ) {}

  onModuleInit() {
    this.queue.register(EXPORT_JOB_TYPE, (ctx) => this.run(ctx), {
      timeoutMs: JOB_TIMEOUT_MS,
      onFinalFailure: ({ tx, job, error }) => this.notifyFailed(tx, job, error),
    });
  }

  spec(resource: string): ExportSpec {
    const spec = this.registry.get(resource);
    if (!spec)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'resource', code: 'isIn', message: `unknown resource ${resource}` },
      ]);
    return spec;
  }

  /** ตัวกรองจากผู้ใช้ → instance ของ class ตัวกรองรายการ (กติกาเดียวกับ ValidationPipe: field แปลก = 422) */
  async parseFilter(spec: ExportSpec, filter: Record<string, string>): Promise<object> {
    const plain: Record<string, string> = {};
    for (const [k, v] of Object.entries(filter ?? {})) {
      if ((PAGING_KEYS as readonly string[]).includes(k)) continue;
      if (typeof v !== 'string')
        throw new ProblemException('validation_failed', undefined, [
          { field: `filter.${k}`, code: 'isString', message: `filter.${k} must be a string` },
        ]);
      if (v !== '') plain[k] = v;
    }
    const q = plainToInstance(spec.query, plain, { enableImplicitConversion: false }) as object;
    const errors = await validate(q, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      const fields: FieldError[] = errors.flatMap((e) =>
        Object.entries(e.constraints ?? {}).map(([code, message]) => ({
          field: `filter.${e.property}`,
          code,
          message,
        })),
      );
      throw new ProblemException('validation_failed', undefined, fields);
    }
    return q;
  }

  async create(input: {
    resource: string;
    format: ExportFormat;
    filter: Record<string, string>;
  }): Promise<Job> {
    const ctx = requestContext.require();
    const spec = this.spec(input.resource);
    const scopes = ctx.scopes ?? [];
    if (!anyScope(scopes, spec.scope)) {
      const need = Array.isArray(spec.scope) ? spec.scope : [spec.scope];
      const [module, action] = need[0]!.split(':');
      throw new ProblemException('permission_denied', undefined, undefined, {
        module,
        action,
        required: need,
      });
    }
    if (spec.feature && !(await this.entitlements.enabled(ctx.tenantId!, spec.feature)))
      throw new ProblemException('feature_not_in_plan', undefined, undefined, {
        featureKey: spec.feature,
      });
    if (input.format === 'pdf' && !spec.pdf)
      throw new ProblemException('validation_failed', undefined, [
        { field: 'format', code: 'isIn', message: `pdf is not available for ${spec.resource}` },
      ]);
    const q = await this.parseFilter(spec, input.filter);
    // ลองอ่าน 1 แถว: ค่าตัวกรองที่ where-builder ปฏิเสธ (เช่น วันที่ผิด) ตอบ 422 ตอนสั่ง ไม่ใช่ตอน job ล้ม
    await spec.fetch(q, { after: null, take: 1 });
    const filter = Object.fromEntries(
      Object.entries(q as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    const payload: ExportPayload = {
      resource: spec.resource,
      format: input.format,
      filter,
      actorId: ctx.actorId ?? null,
      scopes,
      ...(ctx.principalType ? { principalType: ctx.principalType } : {}),
      ...(ctx.actAs ? { actAs: ctx.actAs } : {}),
    };
    const job = await this.queue.enqueue(this.db.tx, {
      tenantId: ctx.tenantId!,
      type: EXPORT_JOB_TYPE,
      payload,
      // ล้มแล้วไม่ลองซ้ำ (เกินเพดาน/ไม่มีสิทธิ์ ลองใหม่ก็ไม่ผ่าน) — ผู้ใช้กดส่งออกใหม่ได้
      maxAttempts: 1,
    });
    await this.audit.record({
      action: 'export.requested',
      entityType: 'job',
      entityId: job.id,
      after: { resource: spec.resource, format: input.format, filter },
    });
    return job;
  }

  /**
   * scope ที่ใช้ตอนรัน = ตอนสั่ง ∩ สิทธิ์ปัจจุบันของผู้ใช้ (ถูกถอดสิทธิ์/ระงับระหว่างรอ = ไม่ได้สิทธิ์นั้นแล้ว)
   * principal ที่ไม่ใช่ผู้ใช้ (token dev / API client) ใช้ scope ตอนสั่ง — แบบเดียวกับงานนำเข้า (ST2-T23)
   */
  private async effectiveScopes(tx: Tx, p: ExportPayload): Promise<string[]> {
    let scopes = Array.isArray(p.scopes) ? p.scopes.filter((s) => typeof s === 'string') : [];
    if ((p.principalType ?? 'user') === 'user' || p.principalType === 'imp') {
      if (!p.actorId || !UUID_RE.test(p.actorId)) return [];
      const user = await tx.appUser.findFirst({
        where: { id: p.actorId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      const links = user ? await tx.userRole.findMany({ where: { userId: p.actorId } }) : [];
      const roles = links.length
        ? await tx.role.findMany({ where: { id: { in: links.map((l) => l.roleId) } } })
        : [];
      const current = roles.flatMap((r) => r.permissions);
      scopes = scopes.filter((x) => scopeAllows(current, x));
    }
    return scopes;
  }

  /** handler ของ job — อ่านผ่าน service ของรายการภายใต้ context ของผู้สั่ง แล้วเก็บไฟล์ + แจ้งเตือน */
  async run(ctx: JobContext): Promise<ExportResult> {
    const p = ctx.job.payload as unknown as ExportPayload;
    const spec = this.registry.get(p.resource);
    if (!spec) throw new ExportError('unknown_resource');
    const scopes = await this.effectiveScopes(ctx.tx, p);
    if (!scopeAllows(scopes, 'export:run') || !anyScope(scopes, spec.scope))
      throw new ExportError('permission_denied');
    const jobRef = encodeId('job', ctx.job.id);
    return requestContext.run(
      {
        requestId: `export:${jobRef}`,
        locale: 'th',
        tenantId: ctx.tenantId,
        ...(p.actorId ? { actorId: p.actorId } : {}),
        scopes,
        principalType: p.principalType ?? 'user',
        ...(p.actAs ? { actAs: p.actAs } : {}),
        tx: ctx.tx,
      },
      async () => {
        const q = await this.parseFilter(spec, p.filter);
        const columns = spec.columns(scopes, q);
        const format: ExportFormat =
          p.format === 'csv' ? 'csv' : p.format === 'pdf' && spec.pdf ? 'pdf' : 'xlsx';
        const w =
          format === 'csv'
            ? csvWriter(columns)
            : format === 'pdf'
              ? pdfWriter(columns, this.pdf, {
                  title: spec.pdf!.title(q),
                  ...(spec.pdf!.subtitle ? { subtitle: spec.pdf!.subtitle(q) } : {}),
                })
              : await xlsxWriter(columns, spec.fileBase);
        let after: string | null = null;
        let rows = 0;
        if (spec.single) {
          // รายงานสรุป: อ่านครั้งเดียวทั้งชุด (ST9-T05)
          const batch = await spec.fetch(q, { after: null, take: this.maxRows + 1 });
          rows = batch.length;
          if (rows > this.maxRows) throw new ExportError('too_many_rows');
          w.add(redactPrices(batch, scopes, p.principalType ?? 'user') as typeof batch);
        }
        for (; !spec.single;) {
          const batch = await spec.fetch(q, { after, take: EXPORT_BATCH });
          if (!batch.length) break;
          rows += batch.length;
          if (rows > this.maxRows) throw new ExportError('too_many_rows');
          // ชั้นที่สอง: ตัด field ราคาที่ผู้สั่งไม่มีสิทธิ์ (กติกาเดียวกับ response JSON — price-fields.ts ข้อ 3)
          w.add(redactPrices(batch, scopes, p.principalType ?? 'user') as typeof batch);
          after = tryDecodeId(spec.idKind, batch[batch.length - 1]!.id);
          if (!after) throw new Error(`export ${spec.resource}: cannot decode row id`);
          if (batch.length < EXPORT_BATCH) break;
          await ctx.progress(Math.min(95, (rows / this.maxRows) * 100));
        }
        const data = await w.finish();
        const f = await putFileLocked(ctx.tx, ctx.tenantId, data, format);
        const fileName = `${spec.fileBase}-${stamp()}.${format}`;
        const doc = await ctx.tx.storedDocument.create({
          data: {
            tenantId: ctx.tenantId,
            status: 'READY',
            kind: 'EXPORT',
            mimeType: EXPORT_MIME[format],
            sizeBytes: f.size,
            fileKey: f.key,
            sha256: f.sha256,
            filename: fileName,
            entityType: 'job',
            entityId: ctx.job.id,
            createdBy: p.actorId,
          },
        });
        if (p.actorId && UUID_RE.test(p.actorId))
          await this.notifications.notify(ctx.tx, {
            tenantId: ctx.tenantId,
            to: { userIds: [p.actorId] },
            template: 'export.ready',
            vars: { label: spec.label, rows, days: EXPORT_RETENTION_DAYS },
            link: `/exports/${jobRef}`,
            entity: { type: 'job', id: jobRef },
          });
        return { documentId: encodeId('document', doc.id), rows, fileName, bytes: f.size };
      },
    );
  }

  private async notifyFailed(tx: Tx, job: Job, error: unknown): Promise<void> {
    const p = job.payload as unknown as ExportPayload;
    if (!p?.actorId || !UUID_RE.test(p.actorId)) return;
    const spec = this.registry.get(p.resource);
    await this.notifications.notify(tx, {
      tenantId: job.tenantId,
      to: { userIds: [p.actorId] },
      template: 'export.failed',
      vars: {
        label: spec?.label ?? p.resource,
        reason: errorCode(error) ?? 'failed',
        max: this.maxRows,
      },
      entity: { type: 'job', id: encodeId('job', job.id) },
    });
  }

  /** งานส่งออกของผู้เรียก (ผู้อื่น/ชนิดงานอื่น = 404) */
  async get(id: string): Promise<{ job: Job; payload: ExportPayload; doc: StoredDocument | null }> {
    const ctx = requestContext.require();
    const job = await this.db.tx.job.findUnique({ where: { id } });
    const payload = job?.payload as unknown as ExportPayload | undefined;
    if (
      !job ||
      job.type !== EXPORT_JOB_TYPE ||
      !payload ||
      payload.actorId !== (ctx.actorId ?? null)
    )
      throw new ProblemException('not_found');
    const docId = (job.result as { documentId?: string } | null)?.documentId;
    const raw = docId ? tryDecodeId('document', docId) : null;
    const doc = raw ? await this.db.tx.storedDocument.findUnique({ where: { id: raw } }) : null;
    return { job, payload, doc };
  }
}

/** `ExportError: too_many_rows` → `too_many_rows` */
export function errorCode(e: unknown): string | null {
  const m = /ExportError: ([a-z_]+)/.exec(
    typeof e === 'string' ? e : e instanceof Error ? `${e.name}: ${e.message}` : '',
  );
  return m?.[1] ?? null;
}
