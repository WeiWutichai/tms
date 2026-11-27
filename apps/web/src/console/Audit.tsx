import type { components } from '@tms/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useEffect, useState } from 'react';
import { formatDateTime, useI18n } from '../i18n';
import { th, type MessageKey } from '../i18n/th';
import { ROLE_LABEL, useTenantList } from './ConsoleShell';
import { consoleApi, cunwrap, type StaffRole } from './session';
import { useTeam } from './Team';

type Entry = components['schemas']['PlatformAuditEntryDto'];
type Filter = { from: string; to: string; staffId: string; tenantId: string; action: string };
const EMPTY: Filter = { from: '', to: '', staffId: '', tenantId: '', action: '' };

/** กลุ่มการกระทำในตัวกรอง → prefix ของรหัส action (API `action` = ขึ้นต้นด้วย) */
const GROUPS: [string, MessageKey][] = [
  ['impersonation.', 'con.aud.g.impersonation'],
  ['platform.tenant_', 'con.aud.g.tenant'],
  ['connector.', 'con.aud.g.connector'],
  ['user.', 'con.aud.g.user'],
  ['platform.staff_', 'con.aud.g.staff'],
];

const query = (f: Filter) => ({
  from: f.from || undefined,
  to: f.to || undefined,
  staffId: f.staffId || undefined,
  tenantId: f.tenantId || undefined,
  action: f.action || undefined,
});

/** หน้า "Audit log" (pg === 'aud' ในต้นแบบ Platform Console) — ทุกการกระทำของทีม Innovera ข้ามลูกค้า */
export function AuditPage() {
  const { t, lang } = useI18n();
  const [f, setF] = useState<Filter>(EMPTY);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Entry | null>(null);
  const team = useTeam();
  const tenants = useTenantList('');
  const list = useInfiniteQuery({
    queryKey: ['console', 'audit', f],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      cunwrap(
        consoleApi.GET('/v1/platform/audit-logs', {
          params: { query: { ...query(f), limit: 50, cursor: pageParam } },
        }),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 3400);
    return () => clearTimeout(h);
  }, [toast]);

  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const filtered = Object.values(f).some(Boolean);
  const label = (a: string) => {
    const k = `con.aud.a.${a}`;
    return k in th ? t(k as MessageKey) : a;
  };
  const who = (e: Entry) =>
    e.staff
      ? t('con.aud.by', {
          n: e.staff.name ?? e.staff.id,
          r: e.staff.role ? t(ROLE_LABEL[e.staff.role as StaffRole]) : '—',
        })
      : t('con.aud.system');
  const detail = (e: Entry) => {
    const a = (e.after ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    if (e.onBehalfOf) parts.push(t('con.aud.as', { n: e.onBehalfOf.name ?? e.onBehalfOf.id }));
    if (typeof a.ticketRef === 'string' && a.ticketRef)
      parts.push(t('con.aud.ticket', { t: a.ticketRef }));
    if (e.action === 'impersonation.write_blocked' && typeof a.method === 'string')
      parts.push(`${a.method} ${String(a.path ?? '')}`);
    if (e.action === 'platform.plan_changed' && typeof a.planCode === 'string')
      parts.push(a.planCode);
    if (e.entityType === 'platform_user' && typeof a.email === 'string') parts.push(a.email);
    if (e.entityType === 'platform_user' && typeof a.role === 'string')
      parts.push(t(ROLE_LABEL[a.role as StaffRole] ?? 'con.aud.system'));
    if (e.action === 'platform.audit_exported' && typeof a.rows === 'number')
      parts.push(t('con.aud.rows', { n: a.rows }));
    return parts.join(' · ') || '—';
  };

  async function exportCsv() {
    setBusy(true);
    try {
      const r = await consoleApi.GET('/v1/platform/audit-logs/export', {
        params: { query: query(f) },
        parseAs: 'blob',
      });
      if (!r.response.ok || !r.data) throw new Error(String(r.response.status));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data as Blob);
      a.download = 'platform-audit-log.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setToast(t('con.aud.exported'));
    } catch {
      setToast(t('con.aud.exportFailed'));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof Filter) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  return (
    <>
      <div className="con-title">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{t('con.aud.title')}</h1>
          <p>{t('con.aud.sub')}</p>
        </div>
        <button type="button" className="con-act" disabled={busy} onClick={() => void exportCsv()}>
          <Icon n="download" s={16} strokeWidth={1.8} />
          {t('con.aud.export')}
        </button>
      </div>
      <div className="con-filters">
        <label className="con-field">
          <span className="con-field__l">{t('con.aud.f.from')}</span>
          <input
            type="date"
            value={f.from}
            max={f.to || undefined}
            onChange={(e) => set('from')(e.target.value)}
          />
        </label>
        <label className="con-field">
          <span className="con-field__l">{t('con.aud.f.to')}</span>
          <input
            type="date"
            value={f.to}
            min={f.from || undefined}
            onChange={(e) => set('to')(e.target.value)}
          />
        </label>
        <label className="con-field">
          <span className="con-field__l">{t('con.aud.f.staff')}</span>
          <select value={f.staffId} onChange={(e) => set('staffId')(e.target.value)}>
            <option value="">{t('con.aud.f.all')}</option>
            {(team.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="con-field">
          <span className="con-field__l">{t('con.aud.f.tenant')}</span>
          <select value={f.tenantId} onChange={(e) => set('tenantId')(e.target.value)}>
            <option value="">{t('con.aud.f.all')}</option>
            {(tenants.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="con-field">
          <span className="con-field__l">{t('con.aud.f.action')}</span>
          <select value={f.action} onChange={(e) => set('action')(e.target.value)}>
            <option value="">{t('con.aud.f.all')}</option>
            {GROUPS.map(([v, k]) => (
              <option key={v} value={v}>
                {t(k)}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <button type="button" className="con-rowbtn" onClick={() => setF(EMPTY)}>
            {t('con.aud.f.clear')}
          </button>
        )}
      </div>
      <section className="con-card">
        <table className="con-tbl">
          <thead>
            <tr>
              <th>{t('con.aud.col.at')}</th>
              <th>{t('con.aud.col.by')}</th>
              <th>{t('con.aud.col.act')}</th>
              <th>{t('con.aud.col.co')}</th>
              <th>{t('con.aud.col.det')}</th>
              <th>{t('con.aud.col.why')}</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} aria-hidden="true">
                    {[110, 120, 140, 140, 140, 200].map((w, j) => (
                      <td key={j}>
                        <span className="con-skel" style={{ width: w }} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((e) => (
                  <tr key={e.id} aria-selected={open?.id === e.id} onClick={() => setOpen(e)}>
                    <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                      {formatDateTime(e.at, lang)}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{who(e)}</td>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{label(e.action)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {e.tenant ? (e.tenant.name ?? e.tenant.id) : t('con.aud.platform')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{detail(e)}</td>
                    <td style={{ whiteSpace: 'normal' }}>{e.reason ?? '—'}</td>
                  </tr>
                ))}
          </tbody>
        </table>
        {list.isError && <div className="con-empty">{t('con.loadFailed')}</div>}
        {!list.isLoading && !list.isError && !rows.length && (
          <div className="con-empty">{filtered ? t('con.aud.noMatch') : t('con.aud.empty')}</div>
        )}
        {list.hasNextPage && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 14 }}>
            <button
              type="button"
              className="con-rowbtn"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {t('con.aud.more')}
            </button>
          </div>
        )}
      </section>
      {open && (
        <AuditDrawer
          e={open}
          label={label(open.action)}
          who={who(open)}
          onClose={() => setOpen(null)}
        />
      )}
      {toast && (
        <div className="con-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

/** ค่าใน diff — ข้อความตรง ๆ / ตัวเลข / JSON ย่อของ object */
const show = (v: unknown) =>
  v === undefined ? '' : v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

/**
 * drawer แถว audit (spec/01 §11.5 "drawer แสดง before/after (diff)") — ต้นแบบ `aud` ไม่มี drawer:
 * ประกอบจาก drawer ลูกค้าของต้นแบบ (หัว kind/ชื่อ + ปุ่มปิด, ส่วน `con-sec` + `con-kv`, แถว `con-row`) [DECISION spec/12 §3]
 */
function AuditDrawer({
  e,
  label,
  who,
  onClose,
}: {
  e: Entry;
  label: string;
  who: string;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => k.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const before = (e.before ?? {}) as Record<string, unknown>;
  const after = (e.after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const kv: [MessageKey, string][] = [
    ['con.aud.kv.by', who],
    ['con.aud.kv.as', e.onBehalfOf ? (e.onBehalfOf.name ?? e.onBehalfOf.id) : '—'],
    ['con.aud.kv.co', e.tenant ? (e.tenant.name ?? e.tenant.id) : t('con.aud.platform')],
    ['con.aud.kv.obj', [e.entityType, e.entityId].filter(Boolean).join(' · ')],
    ['con.aud.kv.ip', e.ip ?? '—'],
    ['con.aud.kv.sid', e.impersonationSessionId ?? '—'],
  ];
  return (
    <>
      <div className="con-scrim" onClick={onClose} />
      <aside className="con-drawer" role="dialog" aria-modal="true" aria-label={label}>
        <div className="con-drawer__head">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="con-drawer__kind">{t('con.aud.kind', { id: e.id })}</span>
              <span className="con-drawer__t">{label}</span>
              <span style={{ color: '#3B424C' }}>{formatDateTime(e.at, lang)}</span>
            </div>
            <button
              type="button"
              className="con-iconbtn"
              title={t('drawer.close')}
              aria-label={t('drawer.close')}
              onClick={onClose}
            >
              <Icon n="x" s={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div className="con-drawer__body">
          <section className="con-sec">
            <span className="con-sec__t">{t('con.aud.sec.info')}</span>
            <div className="con-kv">
              {kv.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="con-kv__k">{t(k)}</span>
                  <span className="con-kv__v" style={{ wordBreak: 'break-all' }}>
                    {v}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="con-kv__k">{t('con.aud.kv.why')}</span>
              <span className="con-kv__v">{e.reason ?? '—'}</span>
            </div>
          </section>
          <section className="con-sec">
            <span className="con-sec__t">{t('con.aud.sec.diff')}</span>
            {keys.length ? (
              <div role="table" aria-label={t('con.aud.sec.diff')}>
                <div
                  role="row"
                  className="con-row"
                  style={{ gridTemplateColumns: '140px minmax(0,1fr) minmax(0,1fr)' }}
                >
                  {(
                    ['con.aud.diff.field', 'con.aud.diff.before', 'con.aud.diff.after'] as const
                  ).map((k) => (
                    <span key={k} role="columnheader" className="con-kv__k">
                      {t(k)}
                    </span>
                  ))}
                </div>
                {keys.map((k) => {
                  const b = show(before[k]);
                  const a = show(after[k]);
                  return (
                    <div
                      key={k}
                      role="row"
                      className="con-row"
                      style={{ gridTemplateColumns: '140px minmax(0,1fr) minmax(0,1fr)' }}
                    >
                      <span role="cell" style={{ fontWeight: 500, wordBreak: 'break-all' }}>
                        {k}
                      </span>
                      <span
                        role="cell"
                        style={{
                          color: b && b !== a ? '#B3322A' : '#3B424C',
                          wordBreak: 'break-all',
                        }}
                      >
                        {b || '—'}
                      </span>
                      <span
                        role="cell"
                        style={{
                          color: a && b !== a ? '#17733F' : '#3B424C',
                          wordBreak: 'break-all',
                        }}
                      >
                        {a || '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <span style={{ color: '#59606B' }}>{t('con.aud.diff.none')}</span>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
