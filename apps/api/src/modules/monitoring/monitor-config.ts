/**
 * ST9-T19 เกณฑ์ alert (docs/04 NFR Monitoring/Availability; spec/11 NFR-1004) — ค่าเริ่มต้นเป็น DECISION ใน spec/12 §3
 * ปรับได้ด้วย env `MONITOR_RULES` (JSON บางส่วน) เช่น `{"outbox_lag":{"threshold":600},"disk_usage":{"enabled":false}}`
 *
 * hysteresis: เกินเกณฑ์ติดกัน `for` รอบ (รอบละ 1 นาที) จึงเปิด alert · กลับปกติติดกัน `clearAfter` รอบจึงปิด
 * → คิวค้างเกินเกณฑ์ (ค่าเริ่ม for = 2) ทีมได้ alert ภายใน ~2 นาที (เกณฑ์ตรวจรับ ≤ 5 นาที)
 */
export type Severity = 'critical' | 'warning';

export interface RuleConfig {
  enabled: boolean;
  /** ค่าที่ "เกิน" = value > threshold */
  threshold: number;
  for: number;
  clearAfter: number;
  severity: Severity;
  /** ช่วงเวลาที่นับ (นาที) สำหรับกฎแบบอัตรา/จำนวน */
  windowMin?: number;
  /** จำนวนขั้นต่ำก่อนคิดอัตรา (กันเตือนเพราะคำขอน้อย) */
  minCount?: number;
}

export const RULE_KEYS = [
  'probe_failed',
  'http_5xx_rate',
  'worker_down',
  'outbox_lag',
  'outbox_backlog_age',
  'webhook_failure_rate',
  'job_lag',
  'job_failed',
  'email_lag',
  'connector_lag',
  'connector_unhealthy',
  'inbound_stuck',
  'disk_usage',
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

const base = { enabled: true, for: 2, clearAfter: 3 } as const;

/** ค่าเริ่มต้น — หน่วยตามชื่อกฎ (วินาที / อัตรา 0–1 / จำนวน) */
export const DEFAULT_RULES: Record<RuleKey, RuleConfig> = {
  /** self-probe /v1/readyz ล้ม ≥ 3 ครั้งใน 5 นาที */
  probe_failed: { ...base, threshold: 2, for: 1, severity: 'critical', windowMin: 5 },
  /** NFR-1004 "5xx > 1% นาน 5 นาที" (ขั้นต่ำ 100 คำขอใน 5 นาที) */
  http_5xx_rate: {
    ...base,
    threshold: 0.01,
    for: 1,
    severity: 'critical',
    windowMin: 5,
    minCount: 100,
  },
  /** heartbeat ของ worker ล่าสุดเก่ากว่า 3 นาที (API ตรวจแทนเมื่อ worker หยุด) */
  worker_down: { ...base, threshold: 180, for: 1, severity: 'critical' },
  /** NFR-1004 "queue lag > 5 นาที": คำสั่ง outbox ที่ถึงเวลาแล้วยังไม่ถูกหยิบ (ต่อ sink; ไม่นับคำสั่งที่พักเพราะบริษัทถูกระงับ) */
  outbox_lag: { ...base, threshold: 300, severity: 'warning' },
  /** คำสั่ง outbox ยังไม่จบนานกว่า 30 นาที (ลองใหม่ซ้ำ ๆ = ปลายทางล่ม) ต่อ sink */
  outbox_backlog_age: { ...base, threshold: 1800, severity: 'warning' },
  /** webhook ส่งไม่สำเร็จ > 50% ใน 15 นาที (ขั้นต่ำ 20 ครั้ง — ทั้งระบบ ไม่ใช่ต่อ endpoint ของลูกค้า) */
  webhook_failure_rate: {
    ...base,
    threshold: 0.5,
    severity: 'warning',
    windowMin: 15,
    minCount: 20,
  },
  /** NFR-1004 "queue lag > 5 นาที": job ที่ถึงเวลาแล้ว (หรือ lease หมด) ยังไม่ถูกหยิบ */
  job_lag: { ...base, threshold: 300, severity: 'warning' },
  /** job ล้มครั้งสุดท้าย > 10 ชิ้นใน 60 นาที */
  job_failed: { ...base, threshold: 10, severity: 'warning', windowMin: 60 },
  /** อีเมลที่ถึงเวลาส่งแล้วค้างเกิน 10 นาที */
  email_lag: { ...base, threshold: 600, severity: 'warning' },
  /** connector ที่เปิดดึง order (pullOrders) ไม่ดึงสำเร็จนานกว่า 30 นาที (ปกติทุก 5 นาที) ต่อ connector */
  connector_lag: { ...base, threshold: 1800, severity: 'warning' },
  /** connector ACTIVE ที่ healthCheck ล่าสุดล้ม หรือสถานะ ERROR (1 = ผิดปกติ) ต่อ connector */
  connector_unhealthy: { ...base, threshold: 0, severity: 'warning' },
  /** webhook ขาเข้าค้าง RECEIVED เกิน 15 นาที (connector ACTIVE) — จำนวนรายการ */
  inbound_stuck: { ...base, threshold: 0, severity: 'warning', windowMin: 15 },
  /** NFR-1004 "disk > 80%" ของที่เก็บไฟล์ (FILES_ROOT) */
  disk_usage: { ...base, threshold: 0.8, severity: 'warning' },
};

export const RULE_UNIT: Record<RuleKey, 'seconds' | 'ratio' | 'count' | 'flag'> = {
  probe_failed: 'count',
  http_5xx_rate: 'ratio',
  worker_down: 'seconds',
  outbox_lag: 'seconds',
  outbox_backlog_age: 'seconds',
  webhook_failure_rate: 'ratio',
  job_lag: 'seconds',
  job_failed: 'count',
  email_lag: 'seconds',
  connector_lag: 'seconds',
  connector_unhealthy: 'flag',
  inbound_stuck: 'count',
  disk_usage: 'ratio',
};

/** ชื่อกฎภาษาไทย (อีเมลถึงทีม) */
export const RULE_LABEL_TH: Record<RuleKey, string> = {
  probe_failed: 'ตรวจระบบอัตโนมัติ (self-probe) ล้มเหลว',
  http_5xx_rate: 'อัตรา error 5xx ของ API สูง',
  worker_down: 'worker หยุดทำงาน (ไม่มี heartbeat)',
  outbox_lag: 'คิว outbox ค้าง (ถึงเวลาแล้วไม่ถูกหยิบ)',
  outbox_backlog_age: 'คำสั่ง outbox ค้างนาน (ลองใหม่ไม่สำเร็จ)',
  webhook_failure_rate: 'webhook ส่งไม่สำเร็จสูง',
  job_lag: 'คิว job ค้าง',
  job_failed: 'job ล้มเหลวหลายรายการ',
  email_lag: 'คิวอีเมลค้าง',
  connector_lag: 'connector ไม่ได้ดึงข้อมูลนาน',
  connector_unhealthy: 'connector ผิดปกติ',
  inbound_stuck: 'webhook ขาเข้าค้างไม่ได้ประมวลผล',
  disk_usage: 'พื้นที่ดิสก์ที่เก็บไฟล์ใกล้เต็ม',
};

/** รวมค่าเริ่มต้นกับ `MONITOR_RULES` — key/field ที่ไม่รู้จักหรือชนิดผิด = ล้มตั้งแต่เริ่ม (ไม่เงียบ) */
export function loadRules(raw = process.env.MONITOR_RULES): Record<RuleKey, RuleConfig> {
  const out = structuredClone(DEFAULT_RULES);
  if (!raw?.trim()) return out;
  const parsed = JSON.parse(raw) as Record<string, Partial<RuleConfig>>;
  for (const [k, v] of Object.entries(parsed)) {
    if (!(RULE_KEYS as readonly string[]).includes(k))
      throw new Error(`MONITOR_RULES: unknown rule '${k}'`);
    const r = out[k as RuleKey];
    for (const [f, val] of Object.entries(v ?? {})) {
      if (f === 'enabled') {
        if (typeof val !== 'boolean') throw new Error(`MONITOR_RULES.${k}.enabled must be boolean`);
        r.enabled = val;
      } else if (f === 'severity') {
        if (val !== 'critical' && val !== 'warning')
          throw new Error(`MONITOR_RULES.${k}.severity must be critical|warning`);
        r.severity = val;
      } else if (['threshold', 'for', 'clearAfter', 'windowMin', 'minCount'].includes(f)) {
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0)
          throw new Error(`MONITOR_RULES.${k}.${f} must be a number ≥ 0`);
        if ((f === 'for' || f === 'clearAfter') && (!Number.isInteger(val) || val < 1))
          throw new Error(`MONITOR_RULES.${k}.${f} must be an integer ≥ 1`);
        (r as unknown as Record<string, number>)[f] = val;
      } else throw new Error(`MONITOR_RULES.${k}: unknown field '${f}'`);
    }
  }
  return out;
}

/** เป้า availability รายเดือน (docs/04 NFR Availability — เฟสแรก) */
export const AVAILABILITY_TARGET_PCT = 99.5;
/** heartbeat เก่ากว่านี้ = worker ไม่ทำงาน (/readyz `worker: stale`, API ทำหน้าที่ตรวจแทน) */
export const WORKER_STALE_SEC = 180;
export const HEARTBEAT_EVERY_MS = 30_000;
export const MONITOR_TICK_MS = 60_000;
