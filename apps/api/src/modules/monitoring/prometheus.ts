import { LATENCY_BUCKETS, type HttpMetrics } from './http-metrics';
import type { MonitorSnapshot } from './monitor-collector';

/**
 * ST9-T19 Prometheus text exposition format 0.0.4 — label มีเฉพาะค่าที่มีขอบเขต (route แม่แบบ, sink, รหัส connector)
 * ไม่มีชื่อบริษัท/ผู้ใช้/อีเมล/IP
 */
type Labels = Record<string, string>;

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const fmt = (l?: Labels) =>
  l && Object.keys(l).length
    ? `{${Object.entries(l)
        .map(([k, v]) => `${k}="${esc(v)}"`)
        .join(',')}}`
    : '';
const num = (v: number) => (Number.isFinite(v) ? String(v) : v > 0 ? '+Inf' : '-Inf');

class Out {
  readonly lines: string[] = [];
  family(name: string, type: 'gauge' | 'counter' | 'histogram', help: string) {
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    return (v: number, l?: Labels) => this.lines.push(`${name}${fmt(l)} ${num(v)}`);
  }
}

export interface ExtraMetrics {
  availabilityRatio: number | null;
  month: string;
  alerts: { rule: string; subject: string | null; severity: string }[];
}

export function renderPrometheus(
  s: MonitorSnapshot,
  http: HttpMetrics,
  extra: ExtraMetrics,
): string {
  const o = new Out();

  const up = o.family('tms_up', 'gauge', 'API instance ตอบคำขอ (1)');
  up(1);

  const req = o.family(
    'tms_http_requests_total',
    'counter',
    'จำนวนคำขอ HTTP ของ instance นี้ ตาม method/route แม่แบบ/กลุ่มสถานะ',
  );
  for (const [k, v] of [...http.requests.entries()].sort()) {
    const [method, route, status_class] = k.split('\u0000') as [string, string, string];
    req(v, { method, route, status_class });
  }
  o.lines.push(
    '# HELP tms_http_request_duration_seconds เวลาตอบคำขอ HTTP ตามกลุ่ม route',
    '# TYPE tms_http_request_duration_seconds histogram',
  );
  for (const [cls, h] of [...http.latency.entries()].sort()) {
    LATENCY_BUCKETS.forEach((b, i) =>
      o.lines.push(
        `tms_http_request_duration_seconds_bucket${fmt({ route_class: cls, le: String(b) })} ${h.buckets[i]}`,
      ),
    );
    o.lines.push(
      `tms_http_request_duration_seconds_bucket${fmt({ route_class: cls, le: '+Inf' })} ${h.count}`,
    );
    o.lines.push(`tms_http_request_duration_seconds_sum${fmt({ route_class: cls })} ${h.sum}`);
    o.lines.push(`tms_http_request_duration_seconds_count${fmt({ route_class: cls })} ${h.count}`);
  }
  const httpWin = o.family(
    'tms_http_requests_window',
    'gauge',
    'คำขอ HTTP ทุก instance ในช่วงกฎ 5xx (5 นาที) ตามผล',
  );
  httpWin(s.http.total, { result: 'total' });
  httpWin(s.http.errors, { result: '5xx' });

  const ob = o.family(
    'tms_outbox_commands',
    'gauge',
    'คำสั่งใน integration outbox ต่อ sink ตามสถานะ (parked = พักเพราะบริษัทถูกระงับ · failed_final_24h = dead-letter ใน 24 ชม.)',
  );
  const lag = o.family(
    'tms_outbox_lag_seconds',
    'gauge',
    'คำสั่งที่ถึงเวลาแล้วยังไม่ถูกหยิบ — รอนานสุด (วินาที) ต่อ sink',
  );
  const age = o.family(
    'tms_outbox_oldest_age_seconds',
    'gauge',
    'คำสั่งที่ยังไม่จบ — อายุนานสุดนับจากสร้าง (วินาที) ต่อ sink',
  );
  for (const x of s.outbox) {
    ob(x.pending, { sink: x.sink, state: 'pending' });
    ob(x.retrying, { sink: x.sink, state: 'retrying' });
    ob(x.inFlight, { sink: x.sink, state: 'in_flight' });
    ob(x.parked, { sink: x.sink, state: 'parked' });
    ob(x.failedFinal, { sink: x.sink, state: 'failed_final_24h' });
  }
  for (const x of s.outbox) lag(x.lagSec, { sink: x.sink });
  for (const x of s.outbox) age(x.oldestAgeSec, { sink: x.sink });

  const wh = o.family(
    'tms_webhook_deliveries_window',
    'gauge',
    'การส่ง webhook (ไม่รวม test) ในช่วง 15 นาที ตามผล',
  );
  wh(s.webhook.delivered, { result: 'delivered' });
  wh(s.webhook.failed, { result: 'failed' });
  wh(s.webhook.exhausted, { result: 'exhausted' });
  o.family(
    'tms_webhook_endpoints_auto_disabled',
    'gauge',
    'endpoint ที่ระบบปิดเอง (ล้มเหลวติดกัน 50 ครั้ง)',
  )(s.webhook.autoDisabled);

  const jq = o.family('tms_job_queue', 'gauge', 'job ในคิวตามสถานะ');
  jq(s.jobs.pending, { state: 'pending' });
  jq(s.jobs.running, { state: 'running' });
  o.family(
    'tms_job_lag_seconds',
    'gauge',
    'job ที่ถึงเวลา/lease หมดแล้วยังไม่ถูกหยิบ — รอนานสุด (วินาที)',
  )(s.jobs.lagSec);
  o.family(
    'tms_job_failed_window',
    'gauge',
    'job ล้มครั้งสุดท้ายในช่วงกฎ job_failed (60 นาที)',
  )(s.jobs.failedWindow);

  o.family('tms_email_queue', 'gauge', 'อีเมลรอส่ง/กำลังส่ง')(s.email.pending);
  o.family(
    'tms_email_lag_seconds',
    'gauge',
    'อีเมลที่ถึงเวลาส่งแล้ว — รอนานสุด (วินาที)',
  )(s.email.lagSec);
  o.family('tms_email_failed_1h', 'gauge', 'อีเมลที่เลิกส่งใน 1 ชั่วโมง')(s.email.failedWindow);

  const cu = o.family(
    'tms_connector_healthy',
    'gauge',
    'connector (ไม่รวมที่ยกเลิก) 1 = ปกติ, 0 = ERROR/healthCheck ล้ม — label เป็นรหัส connector ไม่ใช่ชื่อบริษัท',
  );
  for (const c of s.connectors)
    cu(c.status === 'ERROR' || c.healthOk === false ? 0 : 1, {
      connector: c.id,
      adapter: c.adapter,
      status: c.status.toLowerCase(),
    });
  const cl = o.family(
    'tms_connector_pull_lag_seconds',
    'gauge',
    'connector ที่เปิดดึง order: วินาทีนับจากดึงสำเร็จล่าสุด',
  );
  for (const c of s.connectors)
    if (c.pullLagSec !== null) cl(c.pullLagSec, { connector: c.id, adapter: c.adapter });
  o.family(
    'tms_inbound_webhook_stuck',
    'gauge',
    'webhook ขาเข้าค้าง RECEIVED เกิน 15 นาที (connector ACTIVE)',
  )(s.inbound.stuck);

  if (s.disk) {
    o.family(
      'tms_disk_free_bytes',
      'gauge',
      'พื้นที่ว่างของ filesystem ที่เก็บไฟล์ (FILES_ROOT)',
    )(s.disk.freeBytes, { volume: 'files' });
    o.family(
      'tms_disk_total_bytes',
      'gauge',
      'ขนาด filesystem ที่เก็บไฟล์',
    )(s.disk.totalBytes, { volume: 'files' });
    o.family(
      'tms_disk_used_ratio',
      'gauge',
      'สัดส่วนที่ใช้แล้ว 0–1',
    )(Math.round(s.disk.usedRatio * 10_000) / 10_000, { volume: 'files' });
  }

  o.family(
    'tms_worker_heartbeat_age_seconds',
    'gauge',
    'อายุ heartbeat ล่าสุดของ worker (-1 = ไม่เคยมี)',
  )(s.worker.newestBeatAgeSec ?? -1);
  o.family(
    'tms_worker_instances',
    'gauge',
    'worker ที่ส่ง heartbeat ใน 3 นาที',
  )(s.worker.instances);

  const pr = o.family('tms_probe_window', 'gauge', 'ผล self-probe ใน 5 นาที');
  pr(s.probe.total, { result: 'total' });
  pr(s.probe.failed, { result: 'failed' });
  if (extra.availabilityRatio !== null)
    o.family(
      'tms_availability_ratio',
      'gauge',
      'availability เดือนปัจจุบัน (เวลาไทย) 0–1 — เป้า 0.995',
    )(extra.availabilityRatio, { month: extra.month });

  const al = o.family('tms_alert_firing', 'gauge', 'alert ที่เปิดอยู่ (1 ต่อ rule/subject)');
  for (const a of extra.alerts)
    al(1, { rule: a.rule, subject: a.subject ?? '', severity: a.severity });

  return o.lines.join('\n') + '\n';
}
