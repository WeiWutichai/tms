import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../db/prisma.service';
import { store } from '../documents/documents.controller';
import { EXPORT_FILE_RETENTION_DAYS, POD_FILE_KINDS, RETENTION_MIN } from './retention-policy';

/** แถวต่อรอบ (ลบทีละชุดผ่าน index — ไม่ล็อกตารางนาน) */
const BATCH = 5000;
/** ไฟล์ต่อรอบ (ลบไฟล์จริงใน transaction เดียวกับการเปลี่ยนสถานะ) */
const FILE_BATCH = 500;
const DAY = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  /** audit log ที่ลบ (ผ่านฟังก์ชัน DB `tms_audit_retention_purge` — migration 0108) */
  auditLog: number;
  loginLog: number;
  gpsLog: number;
  /** ไฟล์ POD ที่ลบ (แถว stored_document → PURGED) */
  podFiles: number;
  /** ไฟล์ส่งออก (ST9-T10) เกิน 7 วัน */
  exportFiles: number;
}

/** ค่าตั้ง int ใน tenant_setting (jsonb) ของ key ที่ join เป็น `ts` — ไม่ใช่ตัวเลข = null */
const settingInt = Prisma.sql`CASE WHEN jsonb_typeof(ts.value) = 'number' THEN floor((ts.value #>> '{}')::numeric)::int END`;

/**
 * Retention job รายวัน (ST9-T14; docs/04 J) — worker เรียกพร้อมงานรายวันอื่น · role platform (ข้าม tenant, DM-023)
 * ระยะเก็บต่อ tenant อ่านจาก `retention.*` ใน tenant_setting และไม่ต่ำกว่าขั้นต่ำเสมอ (ค่าในฐานผิด/ต่ำ = ใช้ขั้นต่ำ)
 * ทุกการลบลง audit_log ของ tenant นั้น (action `retention.purged`, entity `retention`, id = กลุ่มข้อมูล)
 *
 * ไม่แตะ: เอกสารภาษี/บัญชี และไฟล์ PDF (ST9-T15) · integration log (integration_outbox / ledger webhook ขาเข้า) — ครบ 24 เดือน
 * "แล้ว archive" (docs/01 §3.7) แต่วิธี archive ยัง [OPEN — PO] (spec/12 §3 ST7-T22) จึงยังไม่ลบ
 * · webhook_delivery 30 วัน / payload webhook ขาเข้า 30 วัน / job 7 วัน มีงานของตัวเองแล้ว (ST7-T05/T22/T10)
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  constructor(private readonly prisma: PrismaService) {}

  async run(now = new Date()): Promise<RetentionResult> {
    // ทีละกลุ่ม (ไม่ขนาน) — งานกลางคืน ไม่แย่ง connection กับคำขอ
    const auditLog = await this.purgeAuditLog();
    const loginLog = await this.purgeLoginLog(now);
    const gpsLog = await this.purgeGpsLog(now);
    const podFiles = await this.purgeFiles(now, 'pod');
    const exportFiles = await this.purgeFiles(now, 'export');
    return { auditLog, loginLog, gpsLog, podFiles, exportFiles };
  }

  /**
   * audit log append-only — ลบได้ทางเดียวคือฟังก์ชัน SECURITY DEFINER ที่อ่านระยะเก็บของ tenant เอง (≥ 5 ปี),
   * ข้ามเหตุการณ์ของเอกสารภาษี ฯลฯ และลงบันทึกการลบเอง (migration 0108) — เวลาตัดใช้ now() ของฐาน (เลื่อนเวลาไม่ได้)
   */
  async purgeAuditLog(): Promise<number> {
    const db = this.prisma.platform;
    const tenants = await db.$queryRaw<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id::text FROM audit_log
       WHERE at < now() - make_interval(years => ${RETENTION_MIN.auditLogYears}::int)`;
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
   * ไฟล์ POD (≥ 2 ปีจากวันอัปโหลด ตามค่าตั้ง) / ไฟล์ส่งออก (7 วัน) — แถว stored_document คงอยู่เป็น PURGED (sha256 + metadata)
   * ลบไฟล์จริงเฉพาะ key ที่ไม่มีแถวอื่นอ้างแล้ว (key ผูกกับเนื้อไฟล์ — เนื้อเดียวกันใช้ไฟล์เดียวกัน) ใน transaction เดียวกับ
   * การเปลี่ยนสถานะ: ลบไฟล์ไม่สำเร็จ = rollback แถวกลับเป็น READY แล้วลองใหม่รอบหน้า
   * ชนิดอื่น (PDF เอกสาร/ใบคุมรถ, เอกสารรถ, นำเข้า ฯลฯ) ไม่แตะ
   */
  async purgeFiles(now: Date, group: 'pod' | 'export'): Promise<number> {
    const files = store();
    const cond =
      group === 'pod'
        ? Prisma.sql`d.kind = ANY(${[...POD_FILE_KINDS]}::text[])
            AND d.created_at < ${now}::timestamptz - make_interval(years => ${RETENTION_MIN.podFileYears}::int)
            AND d.created_at < ${now}::timestamptz - make_interval(years => greatest(
                  ${RETENTION_MIN.podFileYears}::int, coalesce(${settingInt}, ${RETENTION_MIN.podFileYears}::int)))`
        : Prisma.sql`d.kind = 'EXPORT'
            AND d.created_at < ${new Date(now.getTime() - EXPORT_FILE_RETENTION_DAYS * DAY)}::timestamptz`;
    const settingKey = group === 'pod' ? 'retention.podFileYears' : '';
    const entity = group === 'pod' ? 'pod_file' : 'export_file';
    return this.deleteLoop(
      entity,
      (limit) =>
        this.prisma.platform.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<{ tenant_id: string; file_key: string }[]>`
            WITH c AS (
              SELECT d.id, d.file_key FROM stored_document d
                LEFT JOIN tenant_setting ts ON ts.tenant_id = d.tenant_id AND ts.key = ${settingKey}
               WHERE d.status = 'READY' AND ${cond}
               ORDER BY d.created_at LIMIT ${limit}::int
               FOR UPDATE OF d SKIP LOCKED
            )
            UPDATE stored_document s SET status = 'PURGED', file_key = NULL, purged_at = ${now}::timestamptz
              FROM c WHERE s.id = c.id
            RETURNING s.tenant_id::text AS tenant_id, c.file_key`;
            const keys = [...new Set(rows.map((r) => r.file_key))];
            const still = keys.length
              ? await tx.$queryRaw<{ file_key: string }[]>`
                SELECT DISTINCT file_key FROM stored_document WHERE file_key = ANY(${keys}::text[])`
              : [];
            const shared = new Set(still.map((r) => r.file_key));
            for (const k of keys) if (!shared.has(k)) await files.remove(k);
            const counts = new Map<string, number>();
            for (const r of rows) counts.set(r.tenant_id, (counts.get(r.tenant_id) ?? 0) + 1);
            return [...counts].map(([tenant_id, n]) => ({ tenant_id, n }));
          },
          { timeout: 60_000 },
        ),
      FILE_BATCH,
    );
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
