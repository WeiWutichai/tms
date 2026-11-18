import type { components } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { queryClient } from '../api';
import { formatDateTime, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import {
  adapterName,
  COMMAND_BADGE,
  MASK,
  operationLabel,
} from '../features/settings/ConnectorSettings';
import { useTenantList } from './ConsoleShell';
import { can, consoleApi, cunwrap, useStaff } from './session';
import { ActionDialog, type Field, useProblemText } from './Tenants';

type Conn = components['schemas']['PlatformConnectorDto'];
type Adapter = components['schemas']['ErpAdapterDto'];

const TONE = {
  ok: { c: '#17733F', bg: '#E6F4EC' },
  warn: { c: '#8F5500', bg: '#FCF0DC' },
  err: { c: '#B3322A', bg: '#FBE9E7' },
  info: { c: '#2257C4', bg: '#E9F0FA' },
  off: { c: '#3B424C', bg: '#ECEDEA' },
} as const;
const STATUS: Record<string, { k: MessageKey; tone: keyof typeof TONE; i: string }> = {
  ACTIVE: { k: 'cnx.b.on', tone: 'ok', i: 'plug' },
  PAUSED: { k: 'cnx.b.paused', tone: 'off', i: 'pause' },
  ERROR: { k: 'cnx.b.error', tone: 'err', i: 'circle-x' },
  DISCONNECTED: { k: 'cnx.b.disconnected', tone: 'off', i: 'unplug' },
};

function Pill({ l, tone, i }: { l: string; tone: keyof typeof TONE; i: string }) {
  return (
    <span className="con-badge" style={{ background: TONE[tone].bg, color: TONE[tone].c }}>
      <Icon n={i} s={12} strokeWidth={1.8} />
      {l}
    </span>
  );
}

function StatusPill({ s }: { s: string }) {
  const { t } = useI18n();
  const b = STATUS[s] ?? STATUS.PAUSED!;
  return <Pill l={t(b.k)} tone={b.tone} i={b.i} />;
}

/** สิทธิ์ (docs/04 A6): ดู = ทุก role · เปิด/หมุน key/ทดสอบ/เปิด-หยุด = SUPER_ADMIN (ตรงกับ @PlatformAuth ของ API) */
const canManage = can.create;

function useAdapters() {
  return useQuery({
    queryKey: ['console', 'connector-adapters'],
    queryFn: () => cunwrap(consoleApi.GET('/v1/platform/connectors/adapters')),
    staleTime: 300_000,
  });
}

/**
 * Connectors ใน Platform Console (ST7-T20; docs/02 §5 "Connectors") — ต้นแบบ Platform Console ไม่มีหน้านี้
 * [DECISION spec/12 §3]: ใช้แบบหน้า "การใช้งาน API และ AI" (หัวเรื่อง + แท็บ + ตารางข้าม tenant) และ drawer/dialog ของหน้า "ลูกค้า"
 * แท็บ Connector (เปิด/หมุน key/ทดสอบ/เปิด-หยุด) · คิวส่งข้อมูล (outbox sink `erp` ข้าม tenant — ไม่มี payload, request/response = ST7-T19)
 */
export function ConnectorsPage() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const { id } = useParams();
  const role = useStaff().data?.role;
  const [tab, setTab] = useState<'con' | 'q'>('con');
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState('');
  const list = useQuery({
    queryKey: ['console', 'connectors'],
    queryFn: () => cunwrap(consoleApi.GET('/v1/platform/connectors')),
  });
  const cmds = useQuery({
    queryKey: ['console', 'connector-commands'],
    queryFn: () =>
      cunwrap(
        consoleApi.GET('/v1/platform/connectors/commands', { params: { query: { limit: 100 } } }),
      ),
    enabled: tab === 'q',
  });
  const adapters = useAdapters();
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 3400);
    return () => clearTimeout(h);
  }, [toast]);
  const rows = list.data?.data ?? [];
  const ad = (k: string) => adapters.data?.data.find((a) => a.key === k);
  const name = (c: { adapterKey: string; displayName?: string | null }) =>
    adapterName(t, c.adapterKey, c.displayName, ad(c.adapterKey)?.demo);
  const sel = rows.find((r) => r.id === id);

  return (
    <>
      <div className="con-title">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{t('con.conn.title')}</h1>
          <p>{t('con.conn.sub')}</p>
        </div>
        {canManage(role) && (
          <button type="button" className="con-act" onClick={() => setCreating(true)}>
            <Icon n="plug" s={16} strokeWidth={1.8} />
            {t('con.conn.create')}
          </button>
        )}
      </div>
      <div className="con-tabs" role="tablist">
        {(
          [
            ['con', t('con.conn.tab.con'), rows.length],
            ['q', t('con.conn.tab.q'), rows.reduce((n, r) => n + r.queue.open + r.queue.failed, 0)],
          ] as const
        ).map(([k, l, n]) => (
          <button
            key={k}
            type="button"
            role="tab"
            className="con-tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {l}
            {n ? <span className="con-tab__n">{n}</span> : null}
          </button>
        ))}
      </div>
      <section className="con-card">
        {tab === 'con' ? (
          <table className="con-tbl">
            <thead>
              <tr>
                <th>{t('con.conn.col.co')}</th>
                <th>{t('con.conn.col.sys')}</th>
                <th>{t('con.conn.col.status')}</th>
                <th>{t('con.conn.col.cred')}</th>
                <th>{t('con.conn.col.health')}</th>
                <th style={{ textAlign: 'right' }}>{t('con.conn.col.queue')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  aria-selected={r.id === id}
                  onClick={() => nav(`/console/connectors/${r.id}`)}
                >
                  <td>
                    <div className="con-cell">
                      <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{r.tenantName}</span>
                      <span className="con-cell__sub">
                        {r.companyId ? t('con.conn.scopeCo') : t('con.conn.scopeAll')}
                      </span>
                    </div>
                  </td>
                  <td>{name(r)}</td>
                  <td>
                    <StatusPill s={r.status} />
                  </td>
                  <td style={{ color: '#3B424C', fontVariantNumeric: 'tabular-nums' }}>
                    {r.credentialKeys.length
                      ? r.credentialKeys.map((k) => `${k} ${MASK}`).join(', ')
                      : '—'}
                  </td>
                  <td style={{ color: '#3B424C' }}>
                    {r.lastHealthAt ? (
                      <div className="con-cell">
                        <span>{t(r.lastHealthOk ? 'con.conn.hOk' : 'con.conn.hFail')}</span>
                        <span className="con-cell__sub">
                          {formatDateTime(r.lastHealthAt, lang)}
                        </span>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {t('con.conn.queueOf', { o: r.queue.open, f: r.queue.failed })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="con-tbl">
            <thead>
              <tr>
                <th>{t('cnx.log.time')}</th>
                <th>{t('con.conn.col.co')}</th>
                <th>{t('con.conn.col.sys')}</th>
                <th>{t('cnx.log.action')}</th>
                <th>{t('cnx.log.doc')}</th>
                <th>{t('cnx.log.result')}</th>
              </tr>
            </thead>
            <tbody>
              {(cmds.data?.data ?? []).map((r) => {
                const b = COMMAND_BADGE[r.status] ?? COMMAND_BADGE.PENDING!;
                return (
                  <tr key={r.id} onClick={() => nav(`/console/connectors/${r.connectorId}`)}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.createdAt, lang)}</td>
                    <td>{r.tenantName}</td>
                    <td>{adapterName(t, r.adapterKey, ad(r.adapterKey)?.displayName)}</td>
                    <td>{operationLabel(t, r.operation)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                      {r.localId}
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        <Pill l={t(b.k)} tone={b.tone} i={b.i} />
                        {r.errorCode && (
                          <span style={{ fontSize: 12.5, color: '#59606B' }}>{r.errorCode}</span>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {(tab === 'con' ? list : cmds).isError && (
          <div className="con-empty">{t('con.loadFailed')}</div>
        )}
        {tab === 'con' && !list.isLoading && !list.isError && !rows.length && (
          <div className="con-empty">{t('con.conn.empty')}</div>
        )}
        {tab === 'q' && !cmds.isLoading && !cmds.isError && !cmds.data?.data.length && (
          <div className="con-empty">{t('con.conn.qEmpty')}</div>
        )}
      </section>
      {id && (
        <ConnectorDrawer
          c={sel}
          loading={list.isLoading}
          adapter={sel ? ad(sel.adapterKey) : undefined}
          onClose={() => nav('/console/connectors')}
          onToast={setToast}
        />
      )}
      {creating && (
        <CreateDialog
          adapters={adapters.data?.data ?? []}
          onClose={() => setCreating(false)}
          onDone={(c, msg) => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['console', 'connectors'] });
            setToast(msg);
            nav(`/console/connectors/${c.id}`);
          }}
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

type Dlg = 'rotate' | 'resume' | 'pause' | null;

function ConnectorDrawer({
  c,
  loading,
  adapter,
  onClose,
  onToast,
}: {
  c?: Conn;
  loading: boolean;
  adapter?: Adapter;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const role = useStaff().data?.role;
  const text = useProblemText();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [testing, setTesting] = useState(false);
  const cmds = useQuery({
    queryKey: ['console', 'connector-commands', c?.id],
    queryFn: () =>
      cunwrap(
        consoleApi.GET('/v1/platform/connectors/commands', {
          params: { query: { connectorId: c!.id, limit: 10 } },
        }),
      ),
    enabled: !!c,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !dlg && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dlg, onClose]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['console', 'connectors'] });
    void queryClient.invalidateQueries({ queryKey: ['console', 'connector-commands'] });
  };
  const n = c ? adapterName(t, c.adapterKey, c.displayName, adapter?.demo) : '…';
  async function test() {
    if (!c) return;
    setTesting(true);
    try {
      const r = await cunwrap(
        consoleApi.POST('/v1/platform/connectors/{id}/health', { params: { path: { id: c.id } } }),
      );
      refresh();
      onToast(
        r.ok
          ? t('con.conn.toast.testOk', { n, co: c.tenantName })
          : t('cnx.toast.testFail', { n, code: r.code ?? '' }),
      );
    } catch (e) {
      onToast(text(e));
    } finally {
      setTesting(false);
    }
  }
  const manage = canManage(role) && c && c.status !== 'DISCONNECTED';
  const err = (c?.lastHealthError ?? null) as { code?: string } | null;

  return (
    <>
      <div className="con-scrim" onClick={onClose} />
      <aside className="con-drawer" role="dialog" aria-modal="true" aria-label={n}>
        <div className="con-drawer__head">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="con-drawer__kind">
                {t('con.conn.kind', { co: c?.tenantName ?? '…' })}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="con-drawer__t">{n}</span>
                {c && <StatusPill s={c.status} />}
              </div>
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
          {!c && !loading && <span style={{ color: '#59606B' }}>{t('con.loadFailed')}</span>}
          {c && (
            <>
              <section className="con-sec">
                <span className="con-sec__t">{t('drawer.info')}</span>
                <div className="con-kv">
                  {(
                    [
                      ['con.conn.kv.co', c.tenantName],
                      [
                        'con.conn.kv.scope',
                        t(c.companyId ? 'con.conn.scopeCo' : 'con.conn.scopeAll'),
                      ],
                      [
                        'con.conn.kv.active',
                        c.activatedAt ? formatDateTime(c.activatedAt, lang) : '—',
                      ],
                      ['con.conn.kv.from', c.syncFromDate ?? '—'],
                      [
                        'con.conn.kv.cred',
                        c.credentialKeys.length
                          ? c.credentialKeys.map((k) => `${k} ${MASK}`).join(', ')
                          : '—',
                      ],
                      [
                        'con.conn.kv.credAt',
                        c.credentialsUpdatedAt ? formatDateTime(c.credentialsUpdatedAt, lang) : '—',
                      ],
                      [
                        'con.conn.kv.health',
                        c.lastHealthAt
                          ? `${t(c.lastHealthOk ? 'con.conn.hOk' : 'con.conn.hFail')}${
                              err?.code ? ` · ${err.code}` : ''
                            } · ${formatDateTime(c.lastHealthAt, lang)}`
                          : '—',
                      ],
                      [
                        'con.conn.kv.queue',
                        t('con.conn.queueOf', { o: c.queue.open, f: c.queue.failed }),
                      ],
                    ] as [MessageKey, string][]
                  ).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className="con-kv__k">{t(k)}</span>
                      <span className="con-kv__v">{v}</span>
                    </div>
                  ))}
                </div>
              </section>
              {manage && (
                <section className="con-sec">
                  <span className="con-sec__t">{t('con.sec.actions')}</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <button
                      type="button"
                      className="con-sbtn"
                      disabled={testing}
                      onClick={() => void test()}
                    >
                      <Icon n="activity" s={16} strokeWidth={1.8} />
                      {t('con.conn.act.test')}
                    </button>
                    <button type="button" className="con-sbtn" onClick={() => setDlg('rotate')}>
                      <Icon n="key-round" s={16} strokeWidth={1.8} />
                      {t('con.conn.act.rotate')}
                    </button>
                    {c.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        className="con-sbtn con-sbtn--danger"
                        onClick={() => setDlg('pause')}
                      >
                        <Icon n="pause" s={16} strokeWidth={1.8} />
                        {t('con.conn.act.pause')}
                      </button>
                    ) : (
                      <button type="button" className="con-sbtn" onClick={() => setDlg('resume')}>
                        <Icon n="plug" s={16} strokeWidth={1.8} />
                        {t('con.conn.act.resume')}
                      </button>
                    )}
                  </div>
                </section>
              )}
              <section className="con-sec">
                <span className="con-sec__t">{t('con.conn.recent')}</span>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {(cmds.data?.data ?? []).map((r) => {
                    const b = COMMAND_BADGE[r.status] ?? COMMAND_BADGE.PENDING!;
                    return (
                      <div key={r.id} className="con-row">
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <span style={{ fontWeight: 500 }}>{operationLabel(t, r.operation)}</span>
                          <span style={{ fontSize: 12.5, color: '#59606B' }}>
                            {formatDateTime(r.createdAt, lang)}
                            {r.errorCode ? ` · ${r.errorCode}` : ''}
                          </span>
                        </div>
                        <span style={{ color: '#3B424C', fontSize: 13 }}>{r.localId}</span>
                        <Pill l={t(b.k)} tone={b.tone} i={b.i} />
                      </div>
                    );
                  })}
                  {cmds.data && !cmds.data.data.length && (
                    <span style={{ color: '#59606B' }}>{t('con.conn.qEmpty')}</span>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
      {c && dlg === 'rotate' && (
        <ActionDialog
          title={t('con.conn.dlg.rotT', { n, co: c.tenantName })}
          desc={t('con.conn.dlg.rotD')}
          fields={secretFields(adapter)}
          okL={t('con.conn.act.rotate')}
          check={(v) => (missingSecret(adapter, v) ? t('con.conn.f.required') : '')}
          onClose={() => setDlg(null)}
          onOk={async (v, reason) => {
            await cunwrap(
              consoleApi.PUT('/v1/platform/connectors/{id}/credentials', {
                params: { path: { id: c.id } },
                body: { credentials: pickSecrets(adapter, v), reason },
              }),
            );
            setDlg(null);
            refresh();
            onToast(t('con.conn.toast.rotated', { n, co: c.tenantName }));
          }}
        />
      )}
      {c && (dlg === 'resume' || dlg === 'pause') && (
        <ActionDialog
          title={t(dlg === 'pause' ? 'con.conn.dlg.pauseT' : 'con.conn.dlg.resumeT', {
            n,
            co: c.tenantName,
          })}
          desc={t(dlg === 'pause' ? 'con.conn.dlg.pauseD' : 'con.conn.dlg.resumeD')}
          okL={t(dlg === 'pause' ? 'con.conn.act.pause' : 'con.conn.act.resume')}
          danger={dlg === 'pause'}
          onClose={() => setDlg(null)}
          onOk={async (_v, reason) => {
            const opts = { params: { path: { id: c.id } }, body: { reason } };
            await cunwrap(
              dlg === 'pause'
                ? consoleApi.POST('/v1/platform/connectors/{id}/pause', opts)
                : consoleApi.POST('/v1/platform/connectors/{id}/resume', opts),
            );
            setDlg(null);
            refresh();
            onToast(
              t(dlg === 'pause' ? 'con.conn.toast.paused' : 'con.conn.toast.resumed', {
                n,
                co: c.tenantName,
              }),
            );
          }}
        />
      )}
    </>
  );
}

function secretFields(a?: Adapter): Field[] {
  return (a?.configFields ?? [])
    .filter((f) => f.secret)
    .map((f) => ({ k: `cred.${f.key}`, l: 'con.conn.f.cred', label: f.key, type: 'pw' as const }));
}
function pickSecrets(a: Adapter | undefined, v: Record<string, string>) {
  return Object.fromEntries(
    (a?.configFields ?? [])
      .filter((f) => f.secret && v[`cred.${f.key}`])
      .map((f) => [f.key, v[`cred.${f.key}`]!]),
  );
}
function missingSecret(a: Adapter | undefined, v: Record<string, string>) {
  return (a?.configFields ?? []).some((f) => f.secret && f.required && !v[`cred.${f.key}`]);
}

/** เปิด connector ให้ลูกค้า: เลือกบริษัท + ระบบ + credential → สร้างแล้วทดสอบ+เปิดใช้ (ไม่ผ่าน = คงหยุดชั่วคราว) */
function CreateDialog({
  adapters,
  onClose,
  onDone,
}: {
  adapters: Adapter[];
  onClose: () => void;
  onDone: (c: Conn, msg: string) => void;
}) {
  const { t } = useI18n();
  const tenants = useTenantList('');
  const opts = (tenants.data ?? []).filter((x) => x.status !== 'cancelled');
  const first = adapters[0]?.key ?? '';
  return (
    <ActionDialog
      title={t('con.conn.create')}
      desc={t('con.conn.dlg.createD')}
      fields={(v) => [
        {
          k: 'tenant',
          l: 'con.conn.f.tenant',
          type: 'sel',
          opts: [{ v: '', l: t('con.conn.f.pick') }, ...opts.map((x) => ({ v: x.id, l: x.name }))],
        },
        {
          k: 'adapter',
          l: 'con.conn.f.adapter',
          type: 'sel',
          opts: adapters.map((a) => ({
            v: a.key,
            l: adapterName(t, a.key, a.displayName, a.demo),
          })),
        },
        ...secretFields(adapters.find((a) => a.key === (v.adapter || first))),
      ]}
      init={{ tenant: '', adapter: first }}
      okL={t('con.conn.create')}
      check={(v) =>
        !v.tenant
          ? t('con.conn.f.pickTenant')
          : missingSecret(
                adapters.find((a) => a.key === v.adapter),
                v,
              )
            ? t('con.conn.f.required')
            : ''
      }
      onClose={onClose}
      onOk={async (v, reason) => {
        const a = adapters.find((x) => x.key === v.adapter);
        const c = await cunwrap(
          consoleApi.POST('/v1/platform/tenants/{id}/connectors', {
            params: { path: { id: v.tenant! } },
            body: {
              adapterKey: v.adapter!,
              credentials: pickSecrets(a, v),
              reason,
              activate: true,
            },
          }),
        );
        const n = adapterName(t, c.adapterKey, c.displayName, a?.demo);
        onDone(
          c,
          c.activation?.ok
            ? t('con.conn.toast.created', { n, co: c.tenantName })
            : t('con.conn.toast.createdPaused', {
                n,
                co: c.tenantName,
                code: c.activation?.code ?? '',
              }),
        );
      }}
    />
  );
}
