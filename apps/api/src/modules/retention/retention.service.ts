import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../db/prisma.service';
import { FILE_KEY_LOCK_NS, store } from '../documents/documents.controller';
import {
  EXPORT_RETENTION_DAYS,
  POD_FILE_KINDS,
  POD_FILE_PURGE_HELD,
  RETENTION_MIN,
} from './retention-policy';

/** แถวต่อรอบ (ลบทีละชุดผ่าน index — ไม่ล็อกตารางนาน) */
const BATCH = 5000;
/** แถวไฟล์ต่อรอบ (เปลี่ยนเป็น PURGED) */
const FILE_BATCH = 500;
/** key ไฟล์ที่ลบจริงต่อการเรียก (ที่เหลือ/ที่ลบไม่สำเร็จทำรอบหน้า) */
const FILE_REMOVE_BATCH = 5000;
/** advisory lock ของทั้งรอบ — worker หลายตัวไม่รันซ้อน */
const RUN_LOCK_NS = 0x7e7e;
/** เวลาสูงสุดของ 1 รอบ (transaction ที่ถือล็อกค้างไว้) */
const RUN_TIMEOUT_MS = 60 * 60_000;
const DAY = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  /** audit log ที่ลบ (ผ่านฟังก์ชัน DB `tms_audit_retention_purge` — migration 0108) */
  auditLog: number;
  loginLog: number;
  gpsLog: number;
  /** ไฟล์ POD ที่ลบ — ตอนนี้ 0 เสมอ (`POD_FILE_PURGE_HELD`: รอตรวจข้อกฎหมาย ม.87/3) */
  podFiles: number;
  /** ไฟล์ส่งออก (ST9-T10) เกิน 7 วัน (แถว stored_document → PURGED) */
  exportFiles: number;
  /** กลุ่มที่ error (กลุ่มอื่นยังทำต่อ) */
  failed: string[];
}

const GROUPS = ['auditLog', 'loginLog', 'gpsLog', 'podFiles', 'exportFiles'] as const;

/** ค่าตั้ง int ใน tenant_setting (jsonb) ของ key ที่ join เป็น `ts` — ไม่ใช่ตัวเลข = null */
const settingInt = Prisma.sql`CASE WHEN jsonb_typeof(ts.value) = 'number' THEN floor((ts.value #>> '{}')::numeric)::int END`;

/**
 * Retention job รายวัน (ST9-T14; docs/04 J) — worker เรียกพร้อมงานรายวันอื่น · role platform (ข้าม tenant, DM-023)
 * ระยะเก็บต่อ tenant อ่านจาก `retention.*` ใน tenant_setting และไม่ต่ำกว่าขั้นต่ำเสมอ (ค่าในฐานผิด/ต่ำ = ใช้ขั้นต่ำ)
 * ทุกการลบลง audit_log ของ tenant นั้น (action `retention.purged`, entity `retention`, id = กลุ่มข้อมูล)
 *
 * ไม่แตะ: เอกสารภาษี/บัญชี และไฟล์ PDF (ST9-T15) · ไฟล์ POD (พักไว้ — รอตรวจ ม.87/3) · integration log (integration_outbox / ledger webhook ขาเข้า) — ครบ 24 เดือน
 * "แล้ว archive" (docs/01 §3.7) แต่วิธี archive ยัง [OPEN — PO] (spec/12 §3 ST7-T22) จึงยังไม่ลบ
 * · webhook_delivery 30 วัน / payload webhook ขาเข้า 30 วัน / job 7 วัน มีงานของตัวเองแล้ว (ST7-T05/T22/T10)
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 1 รอบ — คืน null เมื่อ worker อื่นกำลังรันอยู่ (advisory xact lock บน transaction ที่ค้างไว้ตลอดรอบ ส่วนงานลบใช้ connection อื่น)
   * ทีละกลุ่ม (ไม่ขนาน — งานกลางคืน ไม่แย่ง connection กับคำขอ) · กลุ่มหนึ่ง error ไม่หยุดกลุ่มอื่น
   */
  async run(now = new Date()): Promise<RetentionResult | null> {
    return this.prisma.platform.$transaction(
      async (tx) => {
        const [l] = await tx.$queryRaw<{ ok: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${RUN_LOCK_NS}::int, 0) AS ok`;
        if (!l?.ok) {
          this.logger.log('retention: another worker is running — skipped');
          return null;
        }
        const out: RetentionResult = {
          auditLog: 0,
          loginLog: 0,
          gpsLog: 0,
          podFiles: 0,
          exportFiles: 0,
          failed: [],
        };
        const jobs: Record<(typeof GROUPS)[number], () => Promise<number>> = {
          auditLog: () => this.purgeAuditLog(),
          loginLog: () => this.purgeLoginLog(now),
          gpsLog: () => this.purgeGpsLog(now),
          podFiles: () => this.purgeFiles(now, 'pod'),
          exportFiles: () => this.purgeFiles(now, 'export'),
        };
        for (const g of GROUPS) {
          try {
            out[g] = await jobs[g]();
          } catch (e) {
            out.failed.push(g);
            this.logger.error(`retention ${g} failed: ${String(e)}`);
          }
        }
        return out;
      },
      { timeout: RUN_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  /**
   * audit log append-only — ลบได้ทางเดียวคือฟังก์ชัน SECURITY DEFINER ที่อ่านระยะเก็บของ tenant เอง (≥ 5 ปี),
   * ข้ามเหตุการณ์ของเอกสารภาษี ฯลฯ และลงบันทึกการลบเอง (migration 0108) — เวลาตัดใช้ now() ของฐาน (เลื่อนเวลาไม่ได้)
   */
  async purgeAuditLog(): Promise<number> {
    const db = this.prisma.platform;
    // ต่อ tenant (ฟังก์ชันใช้ index (tenant_id, at)) — ไม่สแกน audit_log ทั้งตารางหา tenant
    const tenants = await db.$queryRaw<
      { tenant_id: string }[]
    >`SELECT id::text AS tenant_id FROM tenant`;
    let total = 0;
    for (const { tenant_id } of tenants) {
      for (;;) {
        const [r] = await db.$queryRaw<{ n: number }[]>`
          SELECT tms_audit_retention_purge(${tenant_id}::uuid, ${BATCH}::int) AS n`;
        total += r?.n ?? 0;
        if ((r?.n ?? 0) < BATCH) break;
      }
    }
    return total;
  }

  /** ประวัติ login (ตาราง platform) — แถวที่ไม่รู้ tenant (อีเมลไม่มีในระบบ) ใช้ขั้นต่ำ 12 เดือน */
  async purgeLoginLog(now = new Date()): Promise<number> {
    const min = RETENTION_MIN.loginLogMonths;
    return this.deleteLoop(
      'login_log',
      (limit) => this.prisma.platform.$queryRaw<Counted[]>`
      WITH d AS (
        DELETE FROM login_attempt WHERE id IN (
          SELECT la.id FROM login_attempt la
            LEFT JOIN tenant_setting ts ON ts.tenant_id = la.tenant_id AND ts.key = 'retention.loginLogMonths'
           WHERE la.created_at < ${now}::timestamptz - make_interval(months => ${min}::int)
             AND la.created_at < ${now}::timestamptz
                 - make_interval(months => greatest(${min}::int, coalesce(${settingInt}, ${min}::int)))
           LIMIT ${limit}::int)
        RETURNING tenant_id
      )
      SELECT tenant_id::text, count(*)::int AS n FROM d GROUP BY tenant_id`,
    );
  }

  /** จุด GPS ดิบ — นับจาก received_at (นาฬิกาอุปกรณ์ผิดไม่ทำให้ลบเร็วกว่าขั้นต่ำ) */
  async purgeGpsLog(now = new Date()): Promise<number> {
    const min = RETENTION_MIN.gpsLogDays;
    return this.deleteLoop(
      'gps_log',
      (limit) => this.prisma.platform.$queryRaw<Counted[]>`
      WITH d AS (
        DELETE FROM vehicle_position WHERE id IN (
          SELECT p.id FROM vehicle_position p
            LEFT JOIN tenant_setting ts ON ts.tenant_id = p.tenant_id AND ts.key = 'retention.gpsLogDays'
           WHERE p.received_at < ${now}::timestamptz - make_interval(days => ${min}::int)
             AND p.received_at < ${now}::timestamptz
                 - make_interval(days => greatest(${min}::int, coalesce(${settingInt}, ${min}::int)))
           LIMIT ${limit}::int)
        RETURNING tenant_id
      )
      SELECT tenant_id::text, count(*)::int AS n FROM d GROUP BY tenant_id`,
    );
  }

  /**
   * ไฟล์ POD (≥ 2 ปีจากวันอัปโหลด ตามค่าตั้ง) / ไฟล์ส่งออก (7 วัน)
   * ขั้น 1: แถว READY ที่หมดอายุ → PURGED (ดาวน์โหลดไม่ได้ทันที; sha256 + metadata + file_key คงไว้เป็นหลักฐาน) — commit แยก
   * ขั้น 2: `removePurgedFiles` ลบไฟล์จริง
   * ไฟล์ POD: **พักไว้** (`POD_FILE_PURGE_HELD` — [OPEN — PO/นักบัญชี] เอกสารประกอบใบกำกับ ≥ 5 ปี ม.87/3?) ไม่แตะเลย
   * ชนิดอื่น (PDF เอกสาร/ใบคุมรถ, เอกสารรถ, นำเข้า ฯลฯ) ไม่แตะ
   */
  async purgeFiles(now: Date, group: 'pod' | 'export'): Promise<number> {
    if (group === 'pod' && POD_FILE_PURGE_HELD) {
      this.logger.warn('retention pod_file held: legal review (ม.87/3) — no POD file is deleted');
      return 0;
    }
    const kinds = group === 'pod' ? [...POD_FILE_KINDS] : ['EXPORT'];
    const cond =
      group === 'pod'
        ? Prisma.sql`d.created_at < ${now}::timestamptz - make_interval(years => ${RETENTION_MIN.podFileYears}::int)
            AND d.created_at < ${now}::timestamptz - make_interval(years => greatest(
                  ${RETENTION_MIN.podFileYears}::int, coalesce(${settingInt}, ${RETENTION_MIN.podFileYears}::int)))`
        : Prisma.sql`d.created_at < ${new Date(now.getTime() - EXPORT_RETENTION_DAYS * DAY)}::timestamptz`;
    const settingKey = group === 'pod' ? 'retention.podFileYears' : '';
    const marked = await this.deleteLoop(
      group === 'pod' ? 'pod_file' : 'export_file',
      (limit) => this.prisma.platform.$queryRaw<Counted[]>`
        WITH c AS (
          SELECT d.id FROM stored_document d
            LEFT JOIN tenant_setting ts ON ts.tenant_id = d.tenant_id AND ts.key = ${settingKey}
           WHERE d.status = 'READY' AND d.kind = ANY(${kinds}::text[]) AND ${cond}
           ORDER BY d.created_at LIMIT ${limit}::int
           FOR UPDATE OF d SKIP LOCKED
        ), u AS (
          UPDATE stored_document s SET status = 'PURGED', purged_at = ${now}::timestamptz
            FROM c WHERE s.id = c.id
          RETURNING s.tenant_id
        )
        SELECT tenant_id::text, count(*)::int AS n FROM u GROUP BY tenant_id`,
      FILE_BATCH,
    );
    await this.removePurgedFiles(kinds);
    return marked;
  }

  /**
   * ขั้น 2 ของการลบไฟล์: ต่อ key ใน transaction ของตัวเอง ภายใต้ advisory lock ของ key (ตัวเขียนไฟล์ `putFileLocked`
   * ล็อกเดียวกันก่อนเขียน+สร้างแถว) → ลบไฟล์เฉพาะเมื่อไม่มีแถวที่ยังไม่ PURGED อ้าง key นี้ (key ผูกกับเนื้อไฟล์ — เนื้อเดียวกัน
   * ใช้ไฟล์เดียวกัน) → `file_removed_at` · ลบไม่สำเร็จ = rollback ค้างไว้ทำรอบหน้า
   */
  async removePurgedFiles(kinds: string[]): Promise<number> {
    const db = this.prisma.platform;
    const files = store();
    const keys = await db.$queryRaw<{ file_key: string }[]>`
      SELECT DISTINCT file_key FROM stored_document
       WHERE status = 'PURGED' AND file_removed_at IS NULL AND file_key IS NOT NULL
         AND kind = ANY(${kinds}::text[])
       LIMIT ${FILE_REMOVE_BATCH}::int`;
    let removed = 0;
    for (const { file_key: key } of keys) {
      try {
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${FILE_KEY_LOCK_NS}::int, hashtext(${key}))::text`;
          const [r] = await tx.$queryRaw<{ used: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM stored_document WHERE file_key = ${key} AND status <> 'PURGED') AS used`;
          if (!r?.used) {
            await files.remove(key);
            removed++;
          }
          await tx.$executeRaw`
            UPDATE stored_document SET file_removed_at = now()
             WHERE file_key = ${key} AND status = 'PURGED' AND file_removed_at IS NULL`;
        });
      } catch (e) {
        this.logger.warn(`retention: remove file failed (retry next run): ${String(e)}`);
      }
    }
    return removed;
  }

  /** วนลบทีละชุดจนหมด + ลง audit ต่อ tenant ต่อกลุ่ม (แถวที่ไม่มี tenant = log อย่างเดียว) */
  private async deleteLoop(
    entity: string,
    step: (limit: number) => Promise<Counted[]>,
    limit = BATCH,
  ): Promise<number> {
    const perTenant = new Map<string | null, number>();
    let total = 0;
    for (;;) {
      const rows = await step(limit);
      const n = rows.reduce((a, r) => a + r.n, 0);
      for (const r of rows) perTenant.set(r.tenant_id, (perTenant.get(r.tenant_id) ?? 0) + r.n);
      total += n;
      if (n < limit) break;
    }
    const audited = [...perTenant].filter((e): e is [string, number] => e[0] !== null);
    if (audited.length)
      await this.prisma.platform.auditLog.createMany({
        data: audited.map(([tenantId, count]) => ({
          tenantId,
          actorId: 'system:retention',
          action: 'retention.purged',
          entityType: 'retention',
          entityId: entity,
          after: { count },
          reason: 'ลบตามระยะเก็บ (ST9-T14)',
        })),
      });
    const orphan = perTenant.get(null);
    if (orphan) this.logger.log(JSON.stringify({ msg: 'retention purged', entity, n: orphan }));
    return total;
  }
}

interface Counted {
  tenant_id: string | null;
  n: number;
}
