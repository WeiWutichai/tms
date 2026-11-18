import { Injectable, Logger } from '@nestjs/common';
import type { MonitorAlert, Prisma } from '@prisma/client';
import { PrismaService } from '../../db/prisma.service';
import { EmailService } from '../email/email.service';
import { transportFromEnv, type EmailTransport } from '../email/transport';
import { renderEmail } from '../email/templates';
import { MonitorCollector, type MonitorSnapshot } from './monitor-collector';
import {
  RULE_KEYS,
  RULE_LABEL_TH,
  RULE_UNIT,
  type RuleConfig,
  type RuleKey,
} from './monitor-config';

export interface Observation {
  rule: RuleKey;
  subject: string | null;
  value: number;
}

/** worker ไม่เคยส่ง heartbeat = ถือว่าไม่ทำงาน (ค่าสูงมาก) */
const NEVER = 999_999_999;

/** แปลงภาพรวม → ค่าที่เทียบเกณฑ์ (1 ค่าต่อกฎ/ต่อ sink/ต่อ connector) */
export function observe(s: MonitorSnapshot, rules: Record<RuleKey, RuleConfig>): Observation[] {
  const o: Observation[] = [];
  const add = (rule: RuleKey, value: number, subject: string | null = null) =>
    o.push({ rule, subject, value });
  add('probe_failed', s.probe.failed);
  add(
    'http_5xx_rate',
    s.http.total >= (rules.http_5xx_rate.minCount ?? 0) && s.http.total > 0
      ? s.http.errors / s.http.total
      : 0,
  );
  add('worker_down', s.worker.newestBeatAgeSec ?? NEVER);
  for (const x of s.outbox) {
    add('outbox_lag', x.lagSec, x.sink);
    add('outbox_backlog_age', x.oldestAgeSec, x.sink);
  }
  const wAttempts = s.webhook.delivered + s.webhook.failed + s.webhook.exhausted;
  add(
    'webhook_failure_rate',
    wAttempts >= (rules.webhook_failure_rate.minCount ?? 0) && wAttempts > 0
      ? (s.webhook.failed + s.webhook.exhausted) / wAttempts
      : 0,
  );
  add('job_lag', s.jobs.lagSec);
  add('job_failed', s.jobs.failedWindow);
  add('email_lag', s.email.lagSec);
  for (const c of s.connectors) {
    if (c.pullLagSec !== null) add('connector_lag', c.pullLagSec, c.id);
    if (c.status === 'ACTIVE' || c.status === 'ERROR')
      add('connector_unhealthy', c.status === 'ERROR' || c.healthOk === false ? 1 : 0, c.id);
  }
  add('inbound_stuck', s.inbound.stuck);
  add('disk_usage', s.disk?.usedRatio ?? 0);
  return o;
}

export function formatValue(rule: RuleKey, v: number): string {
  switch (RULE_UNIT[rule]) {
    case 'seconds':
      if (v >= NEVER) return 'ไม่เคยได้รับ';
      return v >= 120 ? `${Math.round(v / 60)} นาที` : `${Math.round(v)} วินาที`;
    case 'ratio':
      return `${(v * 100).toFixed(1)}%`;
    case 'flag':
      return v > 0 ? 'ผิดปกติ' : 'ปกติ';
    default:
      return String(Math.round(v));
  }
}

const thTime = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export interface EvaluateResult {
  skipped?: 'locked' | 'recent';
  opened: string[];
  resolved: string[];
  firing: number;
}

interface Notice {
  alert: MonitorAlert;
  resolved: boolean;
}

/** ล็อกเดียวทั้งระบบ — evaluator หลาย process (worker หลายตัว + API สำรอง) ทำงานทีละตัว */
const LOCK_KEY = 0x7d5_0919;
/** รอบก่อนหน้าใหม่กว่านี้ = มี instance อื่นเพิ่งประเมิน → ข้าม (นับรอบ hysteresis ไม่เร็วเกิน 1 ครั้ง/นาที) */
const MIN_GAP_MS = 45_000;
/** alert ที่ปิดแล้วแต่แจ้งปิดไม่สำเร็จ — ลองแจ้งต่อได้ภายในช่วงนี้ */
const RESOLVE_NOTIFY_WINDOW_MS = 24 * 3600_000;

/**
 * ST9-T19 ตัวประเมิน alert — รันทุก 1 นาทีใน worker (API ทำแทนเมื่อ worker หยุด)
 * เกินเกณฑ์ติดกัน `for` รอบ → เปิด alert (OPEN ได้แถวเดียวต่อ key) + อีเมลทีม · ปกติติดกัน `clearAfter` รอบ → ปิด + อีเมล
 * ผู้รับ: `MONITOR_ALERT_EMAILS` (คั่นด้วย ,) — ไม่ตั้ง = ทีม Platform Console ที่ ACTIVE บทบาท SUPER_ADMIN/SUPPORT
 */
@Injectable()
export class AlertEvaluator {
  private readonly logger = new Logger('Monitoring');
  private transport?: EmailTransport;

  constructor(
    private readonly prisma: PrismaService,
    private readonly collector: MonitorCollector,
    private readonly email: EmailService,
  ) {}

  /** test ใส่ transport ของโหมดส่งตรงได้ */
  useTransport(t: EmailTransport) {
    this.transport = t;
  }

  /**
   * @param direct true = ส่งอีเมลตรงผ่าน transport (ใช้เมื่อ worker ไม่ทำงาน — outbox ไม่มีใครส่ง) · false = เข้าคิว email_outbox
   */
  async evaluate(now: Date, opts: { direct?: boolean } = {}): Promise<EvaluateResult> {
    const rules = this.collector.rules;
    const snap = await this.collector.collect(now);
    const obs = observe(snap, rules);
    const notices: Notice[] = [];
    /** alert ที่ต้องแจ้งรอบนี้ (ใหม่ + ค้างแจ้งจากรอบก่อน) */
    const deliver: Notice[] = [];
    const result: EvaluateResult = { opened: [], resolved: [], firing: 0 };
    const recipients = await this.recipients();
    await this.prisma.platform.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<
          { ok: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`;
        if (!lock?.ok) return void (result.skipped = 'locked');
        const [last] = await tx.$queryRaw<
          { at: Date | null }[]
        >`SELECT max(last_eval_at) AS at FROM monitor_check`;
        if (last?.at && now.getTime() - last.at.getTime() < MIN_GAP_MS)
          return void (result.skipped = 'recent');
        const checks = new Map((await tx.monitorCheck.findMany()).map((c) => [c.key, c]));
        // subject ที่หายไป (sink ไม่มีคำสั่งค้างแล้ว / connector ถูกยกเลิก) = ค่า 0 → ปิดได้ตามรอบปกติ
        const seen = new Set(obs.map((x) => keyOf(x)));
        for (const c of checks.values())
          if (
            !seen.has(c.key) &&
            (RULE_KEYS as readonly string[]).includes(c.rule) &&
            c.state !== 'OK'
          )
            obs.push({ rule: c.rule as RuleKey, subject: c.subject, value: 0 });

        for (const ob of obs) {
          const cfg = rules[ob.rule];
          const key = keyOf(ob);
          const prev = checks.get(key);
          const breach = cfg.enabled && ob.value > cfg.threshold;
          let state = prev?.state ?? 'OK';
          let breachCount = prev?.breachCount ?? 0;
          let okCount = prev?.okCount ?? 0;
          let pendingSince = prev?.pendingSince ?? null;
          let alertId = prev?.alertId ?? null;
          if (breach) {
            breachCount++;
            okCount = 0;
            pendingSince ??= now;
            if (state === 'FIRING' && alertId) {
              await tx.monitorAlert.updateMany({
                where: { id: alertId, status: 'OPEN' },
                data: { lastValue: ob.value, lastSeenAt: now },
              });
            } else if (breachCount >= cfg.for) {
              const opened = await this.open(tx, ob, cfg, key, now);
              alertId = opened.alert.id;
              state = 'FIRING';
              if (opened.created) {
                notices.push({ alert: opened.alert, resolved: false });
                result.opened.push(key);
              }
            } else state = 'PENDING';
          } else {
            okCount++;
            breachCount = 0;
            if (state === 'FIRING' && alertId) {
              if (okCount >= cfg.clearAfter) {
                const r = await tx.monitorAlert.updateMany({
                  where: { id: alertId, status: 'OPEN' },
                  data: {
                    status: 'RESOLVED',
                    resolvedAt: now,
                    lastValue: ob.value,
                    lastSeenAt: now,
                  },
                });
                if (r.count) {
                  const alert = await tx.monitorAlert.findUniqueOrThrow({ where: { id: alertId } });
                  notices.push({ alert, resolved: true });
                  result.resolved.push(key);
                }
                state = 'OK';
                alertId = null;
                pendingSince = null;
              } else
                await tx.monitorAlert.updateMany({
                  where: { id: alertId, status: 'OPEN' },
                  data: { lastValue: ob.value },
                });
            } else {
              state = 'OK';
              alertId = null;
              pendingSince = null;
            }
          }
          if (state === 'FIRING') result.firing++;
          const data = {
            rule: ob.rule,
            subject: ob.subject,
            state,
            breachCount,
            okCount,
            lastValue: ob.value,
            threshold: cfg.threshold,
            lastEvalAt: now,
            pendingSince,
            alertId,
          };
          await tx.monitorCheck.upsert({ where: { key }, create: { key, ...data }, update: data });
        }
        // check ที่ subject หายไปและกลับเป็นปกติแล้ว (sink/connector ที่ไม่มีแล้ว) — ลบทิ้ง ไม่สะสม
        const stale = [...checks.values()]
          .filter((c) => !seen.has(c.key) && c.state === 'OK')
          .map((c) => c.key);
        if (stale.length)
          await tx.monitorCheck.deleteMany({ where: { key: { in: stale }, state: 'OK' } });
        // แจ้งทุก alert ที่ยังไม่ได้แจ้ง — รวมรอบก่อนที่ส่งไม่สำเร็จ/ยังไม่มีผู้รับ (ลองใหม่ทุกรอบ)
        // ปิดแล้วแต่ยังไม่แจ้งปิด: ลองได้ภายใน 24 ชม. หลังปิด
        if (recipients.length) {
          const opens = await tx.monitorAlert.findMany({
            where: { status: 'OPEN', notifiedAt: null },
            orderBy: { openedAt: 'asc' },
          });
          const closes = await tx.monitorAlert.findMany({
            where: {
              status: 'RESOLVED',
              resolveNotifiedAt: null,
              resolvedAt: { gt: new Date(now.getTime() - RESOLVE_NOTIFY_WINDOW_MS) },
            },
            orderBy: { resolvedAt: 'asc' },
          });
          deliver.push(
            ...opens.map((alert) => ({ alert, resolved: false })),
            ...closes.map((alert) => ({ alert, resolved: true })),
          );
        }
        // เข้าคิวอีเมลใน transaction เดียวกับการเปิด/ปิด (rollback = ไม่ส่ง) — โหมดส่งตรงส่งหลัง commit
        if (!opts.direct && deliver.length) {
          await this.email.enqueueMany(
            tx,
            deliver.flatMap((n) =>
              recipients.map((to) => ({
                tenantId: null,
                to,
                template: 'monitor_alert' as const,
                locale: 'th',
                vars: this.vars(n),
              })),
            ),
          );
          await this.markNotified(tx, deliver, now);
        }
      },
      { timeout: 30_000 },
    );
    for (const n of notices) {
      const msg = `alert ${n.resolved ? 'resolved' : 'FIRING'} ${n.alert.key} value=${n.alert.lastValue} threshold=${n.alert.threshold}`;
      if (n.resolved) this.logger.log(msg);
      else this.logger.error(msg);
    }
    if (!recipients.length && notices.length)
      this.logger.warn(
        'ไม่มีผู้รับ alert (MONITOR_ALERT_EMAILS / ทีม Platform Console) — บันทึก alert อย่างเดียว',
      );
    if (opts.direct && deliver.length) await this.sendDirect(deliver, recipients, now);
    return result;
  }

  private async open(
    tx: Prisma.TransactionClient,
    ob: Observation,
    cfg: RuleConfig,
    key: string,
    now: Date,
  ): Promise<{ alert: MonitorAlert; created: boolean }> {
    // partial unique (key WHERE OPEN): มี OPEN อยู่แล้ว = ไม่สร้างซ้ำ ไม่แจ้งซ้ำ
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO monitor_alert (id, key, rule, subject, severity, status, threshold, open_value, last_value, opened_at, last_seen_at)
      VALUES (gen_random_uuid(), ${key}, ${ob.rule}, ${ob.subject}, ${cfg.severity}, 'OPEN', ${cfg.threshold},
              ${ob.value}, ${ob.value}, ${now}::timestamptz, ${now}::timestamptz)
      ON CONFLICT (key) WHERE status = 'OPEN' DO NOTHING
      RETURNING id`;
    if (rows[0]) {
      const alert = await tx.monitorAlert.findUniqueOrThrow({ where: { id: rows[0].id } });
      return { alert, created: true };
    }
    const alert = await tx.monitorAlert.findFirstOrThrow({ where: { key, status: 'OPEN' } });
    await tx.monitorAlert.update({
      where: { id: alert.id },
      data: { lastValue: ob.value, lastSeenAt: now },
    });
    return { alert, created: false };
  }

  private vars(n: Notice) {
    const a = n.alert;
    const rule = a.rule as RuleKey;
    return {
      resolved: n.resolved,
      severity: a.severity as 'critical' | 'warning',
      rule,
      label: RULE_LABEL_TH[rule] ?? rule,
      subject: a.subject,
      value: formatValue(rule, n.resolved ? a.lastValue : a.openValue),
      threshold: formatValue(rule, a.threshold),
      openedAt: thTime.format(a.openedAt),
      ...(a.resolvedAt ? { resolvedAt: thTime.format(a.resolvedAt) } : {}),
    };
  }

  private async markNotified(
    db: Pick<Prisma.TransactionClient, 'monitorAlert'>,
    notices: Notice[],
    now: Date,
  ) {
    const opened = notices.filter((n) => !n.resolved).map((n) => n.alert.id);
    const resolved = notices.filter((n) => n.resolved).map((n) => n.alert.id);
    if (opened.length)
      await db.monitorAlert.updateMany({
        where: { id: { in: opened } },
        data: { notifiedAt: now },
      });
    if (resolved.length)
      await db.monitorAlert.updateMany({
        where: { id: { in: resolved } },
        data: { resolveNotifiedAt: now },
      });
  }

  /** โหมดสำรอง (worker ไม่ทำงาน): ส่งตรง — ล้มรายฉบับ = log แล้วไปต่อ (alert ยังอยู่ในฐาน/API) */
  private async sendDirect(notices: Notice[], recipients: string[], now: Date) {
    try {
      this.transport ??= transportFromEnv();
    } catch (e) {
      this.logger.error(`ส่ง alert ตรงไม่ได้: ${(e as Error).message}`);
      return;
    }
    const sent: Notice[] = [];
    for (const n of notices) {
      let ok = false;
      for (const to of recipients) {
        const r = renderEmail('monitor_alert', 'th', this.vars(n));
        try {
          await this.transport.send({ to, subject: r.subject, text: r.text, html: r.html });
          ok = true;
        } catch (e) {
          this.logger.error(`ส่ง alert ${n.alert.key} ไม่สำเร็จ: ${(e as Error).message}`);
        }
      }
      if (ok) sent.push(n);
    }
    if (sent.length) await this.markNotified(this.prisma.platform, sent, now);
  }

  async recipients(): Promise<string[]> {
    const env = process.env.MONITOR_ALERT_EMAILS?.trim();
    if (env)
      return [
        ...new Set(
          env
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
    const staff = await this.prisma.platform.platformUser.findMany({
      where: { status: 'ACTIVE', role: { in: ['SUPER_ADMIN', 'SUPPORT'] } },
      select: { email: true },
      orderBy: { email: 'asc' },
    });
    return staff.map((s) => s.email);
  }
}

export const keyOf = (o: { rule: string; subject: string | null }) =>
  o.subject ? `${o.rule}:${o.subject}` : o.rule;
