import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Icon } from '@tms/ui';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, unwrap } from '../../api';
import { formatDateTime, useI18n } from '../../i18n';
import { can } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { adapterName } from '../settings/ConnectorSettings';

type Metrics = Schemas['ConnectorMetricsDto'];

const card: CSSProperties = {
  background: '#FFFFFF',
  border: '1px solid #CDD1C8',
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};
const h2: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };
/** ช่องตัวเลขของต้นแบบ `dash.krs` (div ไม่ใช่ปุ่ม: border #D9DCD4 r8 padding 12px 14px · ตัวเลข 24/600 tabular · ป้าย 12.5/500) */
const tile: CSSProperties = { border: '1px solid #D9DCD4', borderRadius: 8, padding: '12px 14px' };
const tileN = (color: string): CSSProperties => ({
  fontSize: 24,
  fontWeight: 600,
  color,
  fontVariantNumeric: 'tabular-nums',
});
const tileL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const num = (n: number) => n.toLocaleString('th-TH');

/** สีจุด + ข้อความสถานะ — ต้นแบบมีเฉพาะ "เชื่อมต่อ" (เขียว) · แดง/เทา ตามแบบท้าย sidebar (ST7-T20) [DECISION spec/12 §3 ST9-T04] */
function dotOf(m: Metrics): {
  color: string;
  key: 'dash.conn.on' | 'dash.conn.err' | 'dash.conn.paused';
} {
  const s = m.health.state;
  if (s === 'DOWN' || s === 'DEGRADED') return { color: '#B3322A', key: 'dash.conn.err' };
  if (s === 'PAUSED') return { color: '#59606B', key: 'dash.conn.paused' };
  return { color: '#17733F', key: 'dash.conn.on' };
}

/**
 * connector ที่การ์ดแสดง (แบบท้าย sidebar: ACTIVE ก่อน → ERROR → ตัวแรก) — null = ไม่ได้เชื่อม / ไม่มีสิทธิ์ / แพ็กเกจไม่มี `conn`
 * ผู้ไม่มี `integrations:read` / `settings:read` รู้ไม่ได้ว่าเชื่อมอยู่ไหม → ไม่เรียก API (การ์ดลูกหนี้ตามเดิม)
 */
export function useConnectorMetrics(): { data: Metrics | null; enabled: boolean } {
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const enabled =
    !!me.data &&
    (can(scopes, 'integrations:read') || can(scopes, 'settings:read')) &&
    !!me.data.features?.includes('conn');
  const q = useQuery({
    queryKey: ['connector-metrics'],
    queryFn: () => unwrap(api.GET('/v1/connectors/metrics')),
    enabled,
    retry: false,
    refetchInterval: 60_000,
  });
  const cs = enabled ? (q.data?.data ?? []) : [];
  const c =
    cs.find((x) => x.status === 'ACTIVE') ?? cs.find((x) => x.status === 'ERROR') ?? cs[0] ?? null;
  return { data: c, enabled };
}

/**
 * ST9-T04 การ์ด "การเชื่อมต่อ {ระบบ}" บนหน้าภาพรวม — ต้นแบบ is.dash `dash.conn` (แทนที่การ์ดลูกหนี้เมื่อเชื่อมระบบบัญชี):
 * หัว + จุดสถานะ · คิวรอส่ง (outbox) · ส่งไม่สำเร็จ · ซิงก์ล่าสุด · ปุ่ม "ส่งซ้ำ" + "ดูคิวเชื่อมระบบบัญชี →"
 * ตัวเลข = `GET /v1/connectors/metrics` (คิว/ล้มเหลว = แท็บของหน้าคิว ST7-T19) · lag / poller / error rate อยู่ใน API แล้ว แต่ต้นแบบไม่มีที่แสดง
 * [OPEN — PO] ส่ง Claude Design
 */
export function ConnectorCard({ m, onDone }: { m: Metrics; onDone: (msg: string) => void }) {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const me = useMe();
  const qc = useQueryClient();
  const scopes = me.data?.scopes ?? [];
  const canRetry = can(scopes, 'integrations:retry') || can(scopes, 'settings:write');
  const canQueue = can(scopes, 'integrations:read');
  const dot = dotOf(m);
  const name = adapterName(t, m.adapterKey, m.displayName);
  const failed = m.queue.failed;
  const retry = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/connectors/{id}/queue/retry', { params: { path: { id: m.id } }, body: {} }),
      ),
    onSuccess: (r) => {
      onDone(
        r.notRetryable
          ? t('dash.conn.retriedSome', { n: num(r.retried), m: num(r.notRetryable) })
          : t('dash.conn.retried', { n: num(r.retried) }),
      );
      void qc.invalidateQueries({ queryKey: ['connector-metrics'] });
    },
    onError: (e) => onDone(problemText(e, t) ?? t('dash.kpi.err')),
  });
  return (
    <section style={card} data-testid="dash-conn">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={h2}>{t('dash.conn.title', { n: name })}</h2>
        <span
          data-testid="dash-conn-state"
          data-state={m.health.state}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: dot.color,
            fontWeight: 500,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot.color }} />
          {t(dot.key)}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={tile}>
          <div style={tileN('#2257C4')} data-testid="dash-conn-queued">
            {num(m.queue.queued)}
          </div>
          <div style={tileL}>{t('dash.conn.queued')}</div>
        </div>
        <div style={tile}>
          <div style={tileN(failed ? '#B3322A' : '#101418')} data-testid="dash-conn-failed">
            {num(failed)}
          </div>
          <div style={tileL}>{t('dash.conn.failed')}</div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#3B424C' }}>
        <span style={{ color: '#3B424C' }}>{t('dash.conn.last')}</span>
        <span data-testid="dash-conn-last">
          {m.lastSyncAt ? formatDateTime(m.lastSyncAt, lang) : '—'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        {canRetry && (
          <Button
            variant="secondary"
            icon="refresh-cw"
            style={{ opacity: failed ? 1 : 0.5 }}
            aria-disabled={!failed || retry.isPending}
            onClick={() => {
              if (failed && !retry.isPending) retry.mutate();
            }}
          >
            {t('dash.conn.retry')}
          </Button>
        )}
        {canQueue && (
          <Button variant="ghost" onClick={() => nav('/erp')}>
            {t('dash.conn.go')}
            <Icon n="arrow-right" s={16} />
          </Button>
        )}
      </div>
    </section>
  );
}
