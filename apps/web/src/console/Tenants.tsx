import type { components } from '@tms/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, queryClient } from '../api';
import { useI18n, type Lang } from '../i18n';
import { th, type MessageKey } from '../i18n/th';
import { useTenantList } from './ConsoleShell';
import { can, consoleApi, cunwrap, useStaff } from './session';

type Tenant = components['schemas']['PlatformTenantDto'];
type TenantDetail = components['schemas']['PlatformTenantDetailDto'];
type Status = Tenant['status'];

/** ป้ายสถานะ — statuses + tone ของ design/prototype/plans.js (เฉพาะสถานะที่ระบบมีในเฟสนี้) */
const STATUS: Record<Status, { k: MessageKey; c: string; bg: string; i: string }> = {
  trial: { k: 'tenantStatus.trial', c: '#2257C4', bg: '#E9F0FA', i: 'flask-conical' },
  active: { k: 'tenantStatus.active', c: '#17733F', bg: '#E7F3EC', i: 'circle-check' },
  suspended: { k: 'tenantStatus.suspended', c: '#B3322A', bg: '#FBE9E7', i: 'ban' },
  cancelled: { k: 'tenantStatus.cancelled', c: '#59606B', bg: '#EEF0EC', i: 'circle-x' },
};
const STATUSES = Object.keys(STATUS) as Status[];
const PLANS = ['start', 'std', 'ent'] as const;

function StatusBadge({ s }: { s: Status }) {
  const { t } = useI18n();
  const b = STATUS[s] ?? STATUS.cancelled;
  return (
    <span className="con-badge" style={{ background: b.bg, color: b.c }}>
      <Icon n={b.i} s={12} strokeWidth={1.8} />
      {t(b.k)}
    </span>
  );
}

const planName = (t: (k: MessageKey) => string, code: string) =>
  (PLANS as readonly string[]).includes(code) ? t(`con.plan.${code}` as MessageKey) : code;

/** "ต.ค. 2569" — เดือน/ปีแบบต้นแบบ (ปี พ.ศ. เมื่อภาษาไทย) */
function monthYear(iso: string, lang: Lang): string {
  const loc = lang === 'th' ? 'th-TH-u-ca-buddhist' : lang === 'zh' ? 'zh-CN' : 'en-GB';
  return new Intl.DateTimeFormat(loc, {
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(iso));
}

/** ข้อความ error จาก problem+json (field error ที่รู้จัก → ข้อความของ field) */
function useProblemText() {
  const { t } = useI18n();
  return (e: unknown) => {
    const p = e instanceof ApiError ? e.problem : undefined;
    const f = p?.errors?.[0]?.code;
    if (f && `field.${f}` in th) return t(`field.${f}` as MessageKey);
    const c = p?.code ?? 'internal_error';
    return t((`problem.${c}` in th ? `problem.${c}` : 'problem.internal_error') as MessageKey);
  };
}

/** หน้า "ลูกค้า" (pg === 'ten' ในต้นแบบ) + drawer รายละเอียดที่ /console/tenants/:id */
export function TenantsPage() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const loc = useLocation();
  const { id } = useParams();
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const staff = useStaff();
  const role = staff.data?.role;
  const list = useTenantList(q);
  const [tab, setTab] = useState<'all' | Status>('all');
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 3400);
    return () => clearTimeout(h);
  }, [toast]);

  const rows = list.data ?? [];
  const shown = rows.filter((r) => tab === 'all' || r.status === tab);
  const tabs: ['all' | Status, string, number][] = [
    ['all', t('con.ten.all'), rows.length],
    ...STATUSES.map(
      (s) =>
        [s, t(STATUS[s].k), rows.filter((r) => r.status === s).length] as [Status, string, number],
    ),
  ];

  return (
    <>
      <div className="con-title">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{t('con.ten.title')}</h1>
          <p>{t('con.ten.sub')}</p>
        </div>
        {can.create(role) && (
          <button type="button" className="con-act" onClick={() => setCreating(true)}>
            <Icon n="plus" s={16} strokeWidth={1.8} />
            {t('con.ten.create')}
          </button>
        )}
      </div>
      <div className="con-tabs" role="tablist">
        {tabs.map(([k, l, n]) => (
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
        <table className="con-tbl">
          <thead>
            <tr>
              <th>{t('con.ten.col.co')}</th>
              <th>{t('con.ten.col.plan')}</th>
              <th>{t('con.ten.col.status')}</th>
              <th>{t('con.ten.col.veh')}</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} aria-hidden="true">
                    {[180, 80, 70, 90].map((w, j) => (
                      <td key={j}>
                        <span className="con-skel" style={{ width: w }} />
                      </td>
                    ))}
                  </tr>
                ))
              : shown.map((r) => (
                  <tr
                    key={r.id}
                    aria-selected={r.id === id}
                    onClick={() => nav(`/console/tenants/${r.id}${loc.search}`)}
                  >
                    <td>
                      <div className="con-cell">
                        <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{r.name}</span>
                        <span className="con-cell__sub">
                          {t('con.ten.since', { d: monthYear(r.createdAt, lang) })}
                        </span>
                      </div>
                    </td>
                    <td>{planName(t, r.planCode)}</td>
                    <td>
                      <StatusBadge s={r.status} />
                    </td>
                    <td style={{ color: '#3B424C', fontVariantNumeric: 'tabular-nums' }}>
                      {t('con.ten.vehOf', {
                        q: r.vehicleQuota ?? t('con.unlimited'),
                      })}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {list.isError && <div className="con-empty">{t('con.loadFailed')}</div>}
        {!list.isLoading && !list.isError && !shown.length && (
          <div className="con-empty">{q ? t('con.ten.noMatch') : t('con.ten.empty')}</div>
        )}
      </section>
      {id && (
        <TenantDrawer
          id={id}
          onClose={() => nav(`/console/tenants${loc.search}`)}
          onToast={setToast}
        />
      )}
      {creating && (
        <CreateTenantDialog
          onClose={() => setCreating(false)}
          onDone={(tn) => {
            setCreating(false);
            setToast(t('con.toast.created', { n: tn.name }));
            nav(`/console/tenants/${tn.id}`);
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

type Dlg = 'plan' | 'suspend' | 'reactivate' | 'imp' | null;

function TenantDrawer({
  id,
  onClose,
  onToast,
}: {
  id: string;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const role = useStaff().data?.role;
  const [tab, setTab] = useState<'ov' | 'usr'>('ov');
  const [dlg, setDlg] = useState<Dlg>(null);
  const d = useQuery({
    queryKey: ['console', 'tenant', id],
    queryFn: () =>
      cunwrap(consoleApi.GET('/v1/platform/tenants/{id}', { params: { path: { id } } })),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !dlg && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dlg, onClose]);
  const x = d.data;
  const refresh = (next?: Tenant) => {
    if (next) queryClient.setQueryData(['console', 'tenant', id], { ...x, ...next });
    void queryClient.invalidateQueries({ queryKey: ['console', 'tenants'] });
    void queryClient.invalidateQueries({ queryKey: ['console', 'tenant', id] });
  };

  const actions: { l: MessageKey; i: string; fn: () => void; danger?: boolean }[] = [];
  if (x && can.plan(role))
    actions.push({ l: 'con.act.plan', i: 'repeat', fn: () => setDlg('plan') });
  if (x && can.suspend(role) && x.status === 'suspended')
    actions.push({ l: 'con.act.reactivate', i: 'ban', fn: () => setDlg('reactivate') });
  if (x && can.suspend(role) && x.status !== 'suspended' && x.status !== 'cancelled')
    actions.push({ l: 'con.act.suspend', i: 'ban', fn: () => setDlg('suspend'), danger: true });
  const canImp = !!x && can.impersonate(role) && x.status !== 'cancelled';

  return (
    <>
      <div className="con-scrim" onClick={onClose} />
      <aside className="con-drawer" role="dialog" aria-modal="true" aria-label={x?.name}>
        <div className="con-drawer__head">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="con-drawer__kind">{t('con.ten.kind', { id })}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="con-drawer__t">{x?.name ?? '…'}</span>
                {x && <StatusBadge s={x.status} />}
              </div>
              {x && (
                <span style={{ color: '#3B424C' }}>
                  {t('con.ten.dsub', { plan: planName(t, x.planCode), n: x.users })}
                </span>
              )}
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
          <div className="con-dtabs" role="tablist">
            {(
              [
                ['ov', 'con.dtab.ov'],
                ['usr', 'con.dtab.usr'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="tab"
                className="con-dtab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
              >
                {t(l)}
              </button>
            ))}
          </div>
        </div>
        <div className="con-drawer__body">
          {d.isError && <span style={{ color: '#59606B' }}>{t('con.loadFailed')}</span>}
          {x && tab === 'ov' && (
            <>
              <section className="con-sec">
                <span className="con-sec__t">{t('drawer.info')}</span>
                <div className="con-kv">
                  {(
                    [
                      ['con.kv.plan', planName(t, x.planCode)],
                      [
                        'con.kv.veh',
                        t('con.ten.vehOf', { q: x.vehicleQuota ?? t('con.unlimited') }),
                      ],
                      ['con.kv.since', monthYear(x.createdAt, lang)],
                      ['con.kv.users', String(x.users)],
                    ] as [MessageKey, string][]
                  ).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className="con-kv__k">{t(k)}</span>
                      <span className="con-kv__v">{v}</span>
                    </div>
                  ))}
                </div>
              </section>
              {actions.length > 0 && (
                <section className="con-sec">
                  <span className="con-sec__t">{t('con.sec.actions')}</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {actions.map((a) => (
                      <button
                        key={a.l}
                        type="button"
                        className={`con-sbtn${a.danger ? ' con-sbtn--danger' : ''}`}
                        onClick={a.fn}
                      >
                        <Icon n={a.i} s={16} strokeWidth={1.8} />
                        {t(a.l)}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          {x && tab === 'usr' && <Members x={x} />}
        </div>
        {x && (canImp || can.plan(role)) && (
          <div className="con-drawer__foot">
            {canImp && (
              <button type="button" className="con-fbtn" onClick={() => setDlg('imp')}>
                <Icon n="user-cog" s={16} strokeWidth={1.8} />
                {t('con.act.imp')}
              </button>
            )}
            {can.plan(role) && (
              <button
                type="button"
                className="con-fbtn con-fbtn--pri"
                onClick={() => setDlg('plan')}
              >
                <Icon n="repeat" s={16} strokeWidth={1.8} />
                {t('con.act.plan')}
              </button>
            )}
          </div>
        )}
      </aside>
      {x && dlg === 'plan' && (
        <PlanDialog
          x={x}
          onClose={() => setDlg(null)}
          onDone={(n) => {
            setDlg(null);
            refresh(n);
            onToast(t('con.toast.plan', { n: x.name, plan: planName(t, n.planCode) }));
          }}
        />
      )}
      {x && (dlg === 'suspend' || dlg === 'reactivate') && (
        <StatusDialog
          x={x}
          kind={dlg}
          onClose={() => setDlg(null)}
          onDone={(n) => {
            setDlg(null);
            refresh(n);
            onToast(
              t(dlg === 'suspend' ? 'con.toast.suspended' : 'con.toast.reactivated', {
                n: x.name,
              }),
            );
          }}
        />
      )}
      {x && dlg === 'imp' && <ImpersonateDialog x={x} onClose={() => setDlg(null)} />}
    </>
  );
}

const ROLE_CODES = [
  'owner',
  'admin',
  'manager',
  'planner',
  'dispatcher',
  'invoicer',
  'accounting',
  'approver',
  'viewer',
] as const;

function Members({ x }: { x: TenantDetail }) {
  const { t } = useI18n();
  const roleName = (c: string) =>
    (ROLE_CODES as readonly string[]).includes(c) ? t(`con.trole.${c}` as MessageKey) : c;
  return (
    <section className="con-sec">
      <span className="con-sec__t">{t('con.usr.title', { n: x.members.length })}</span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {x.members.map((m) => (
          <div key={m.id} className="con-row">
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{m.name}</span>
              <span style={{ fontSize: 12.5, color: '#59606B' }}>
                {m.roles.map(roleName).join(', ') || '—'}
              </span>
            </div>
            <span style={{ color: '#3B424C', whiteSpace: 'nowrap' }}>{m.email}</span>
            {m.status !== 'active' ? (
              <span className="con-badge" style={{ background: '#FCF0DC', color: '#8F5500' }}>
                {t(m.status === 'invited' ? 'users.invited' : 'con.usr.disabled')}
              </span>
            ) : (
              <span />
            )}
          </div>
        ))}
        {!x.members.length && <span style={{ color: '#59606B' }}>{t('con.usr.empty')}</span>}
      </div>
    </section>
  );
}

interface Field {
  k: string;
  l: MessageKey;
  type: 'sel' | 'in';
  opts?: { v: string; l: string }[];
  hint?: string;
  im?: 'numeric' | 'email' | 'text';
}

/** dialog การกระทำ (vAct ในต้นแบบ): สรุปผลกระทบ + ช่องเหตุผล ≥ 10 ตัว (PLT-101) */
function ActionDialog({
  title,
  desc,
  warn,
  fields = [],
  init = {},
  okL,
  danger,
  check,
  onOk,
  onClose,
}: {
  title: string;
  desc: string;
  warn?: string;
  fields?: Field[];
  init?: Record<string, string>;
  okL: string;
  danger?: boolean;
  check?: (v: Record<string, string>) => string;
  onOk: (v: Record<string, string>, reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const text = useProblemText();
  const [v, setV] = useState(init);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const r = reason.trim();
  const ce = check ? check(v) : '';
  const ok = r.length >= 10 && !ce && !busy;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function submit() {
    if (!ok) return;
    setBusy(true);
    setErr('');
    try {
      await onOk(v, r);
    } catch (e) {
      setErr(text(e));
      setBusy(false);
    }
  }
  return (
    <div className="con-modal" onClick={onClose}>
      <div
        className="con-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '20px 24px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h2>{title}</h2>
          <p className="con-dialog__desc">{desc}</p>
        </div>
        <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {warn && (
            <div className="con-warn" style={{ background: '#FCF0DC', color: '#8F5500' }}>
              <Icon
                n="triangle-alert"
                s={16}
                strokeWidth={1.8}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <span>{warn}</span>
            </div>
          )}
          {fields.map((f) => (
            <label key={f.k} className="con-field">
              <span className="con-field__l">{t(f.l)}</span>
              {f.type === 'sel' ? (
                <select
                  aria-label={t(f.l)}
                  value={v[f.k] ?? ''}
                  onChange={(e) => setV({ ...v, [f.k]: e.target.value })}
                >
                  {f.opts?.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.l}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={t(f.l)}
                  value={v[f.k] ?? ''}
                  inputMode={f.im === 'email' ? 'email' : f.im}
                  type={f.im === 'email' ? 'email' : 'text'}
                  onChange={(e) => setV({ ...v, [f.k]: e.target.value })}
                />
              )}
              {f.hint && <span className="con-field__hint">{f.hint}</span>}
            </label>
          ))}
          <label className="con-field">
            <span className="con-field__l">
              {t('con.reason')} <span style={{ color: '#B3322A' }}>*</span>
            </span>
            <textarea
              aria-label={t('con.reason')}
              rows={3}
              value={reason}
              placeholder={t('con.reasonPh')}
              style={{ borderColor: r && r.length < 10 ? '#B3322A' : '#CDD1C8' }}
              onChange={(e) => setReason(e.target.value)}
            />
            <span
              className="con-field__hint"
              style={{ color: ce || (r && r.length < 10) ? '#B3322A' : '#59606B' }}
            >
              {ce ||
                (r.length < 10 ? t('con.reasonLeft', { n: 10 - r.length }) : t('con.reasonOk'))}
            </span>
          </label>
          {err && (
            <div
              className="con-warn"
              role="alert"
              style={{ background: '#FBE9E7', color: '#B3322A' }}
            >
              <Icon
                n="circle-alert"
                s={16}
                strokeWidth={1.8}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <span>{err}</span>
            </div>
          )}
        </div>
        <div className="con-dialog__foot">
          <button type="button" className="con-dialog__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`con-dialog__ok${danger ? ' con-dialog__ok--danger' : ''}`}
            disabled={!ok}
            onClick={() => void submit()}
          >
            {okL}
          </button>
        </div>
      </div>
    </div>
  );
}

/** โควตารถ: ว่าง = ไม่จำกัด (null) · จำนวนเต็ม 1–100000 */
function quotaOf(s: string): number | null | 'bad' {
  const v = s.trim();
  if (!v) return null;
  if (!/^\d+$/.test(v)) return 'bad';
  const n = Number(v);
  return n >= 1 && n <= 100000 ? n : 'bad';
}

function usePlanFields(): Field[] {
  const { t } = useI18n();
  return [
    {
      k: 'plan',
      l: 'con.f.plan',
      type: 'sel',
      opts: PLANS.map((p) => ({ v: p, l: t(`con.plan.${p}` as MessageKey) })),
    },
    { k: 'quota', l: 'con.f.quota', type: 'in', im: 'numeric', hint: t('con.f.quotaHint') },
  ];
}

function PlanDialog({
  x,
  onClose,
  onDone,
}: {
  x: TenantDetail;
  onClose: () => void;
  onDone: (n: Tenant) => void;
}) {
  const { t } = useI18n();
  const fields = usePlanFields();
  return (
    <ActionDialog
      title={t('con.dlg.planT', { n: x.name })}
      desc={t('con.dlg.planD')}
      fields={fields}
      init={{ plan: x.planCode, quota: x.vehicleQuota == null ? '' : String(x.vehicleQuota) }}
      okL={t('con.act.plan')}
      check={(v) => (quotaOf(v.quota ?? '') === 'bad' ? t('con.f.quotaBad') : '')}
      onClose={onClose}
      onOk={async (v, reason) => {
        const n = await cunwrap(
          consoleApi.PATCH('/v1/platform/tenants/{id}/plan', {
            params: { path: { id: x.id } },
            body: {
              planCode: v.plan,
              vehicleQuota: quotaOf(v.quota ?? '') as number | null,
              reason,
            },
          }),
        );
        onDone(n);
      }}
    />
  );
}

function StatusDialog({
  x,
  kind,
  onClose,
  onDone,
}: {
  x: TenantDetail;
  kind: 'suspend' | 'reactivate';
  onClose: () => void;
  onDone: (n: Tenant) => void;
}) {
  const { t } = useI18n();
  const susp = kind === 'suspend';
  return (
    <ActionDialog
      title={t(susp ? 'con.dlg.suspT' : 'con.dlg.reactT', { n: x.name })}
      desc={t(susp ? 'con.dlg.suspD' : 'con.dlg.reactD')}
      okL={t(susp ? 'con.act.suspend' : 'con.act.reactivate')}
      danger={susp}
      onClose={onClose}
      onOk={async (_v, reason) => {
        const opts = { params: { path: { id: x.id } }, body: { reason } };
        const n = await cunwrap(
          susp
            ? consoleApi.POST('/v1/platform/tenants/{id}/suspend', opts)
            : consoleApi.POST('/v1/platform/tenants/{id}/reactivate', opts),
        );
        onDone(n);
      }}
    />
  );
}

/** เข้าใช้งานแทน (PLT-120): เลือกผู้ใช้ที่จะสวม + เหตุผล + ticket → เปิดแอปลูกค้าแท็บใหม่ (อ่านอย่างเดียว) */
function ImpersonateDialog({ x, onClose }: { x: TenantDetail; onClose: () => void }) {
  const { t } = useI18n();
  const roleName = (c: string) =>
    (ROLE_CODES as readonly string[]).includes(c) ? t(`con.trole.${c}` as MessageKey) : c;
  const active = x.members.filter((m) => m.status === 'active');
  const owner = active.find((m) => m.roles.includes('owner')) ?? active[0];
  return (
    <ActionDialog
      title={t('con.dlg.impT', { n: x.name })}
      desc={t('con.dlg.impD')}
      warn={active.length ? t('con.dlg.impW') : t('con.dlg.impNoUser')}
      fields={[
        {
          k: 'as',
          l: 'con.f.as',
          type: 'sel',
          opts: active.map((m) => ({
            v: m.id,
            l: `${m.name} · ${m.roles.map(roleName).join(', ')}`,
          })),
          hint: t('con.f.asHint'),
        },
        { k: 'ticket', l: 'con.f.ticket', type: 'in' },
      ]}
      init={{ as: owner?.id ?? '', ticket: '' }}
      okL={t('con.act.imp')}
      check={() => (active.length ? '' : t('con.dlg.impNoUser'))}
      onClose={onClose}
      onOk={async (v, reason) => {
        // เปิดแท็บเปล่าทันทีตอนกด (ยังอยู่ใน user gesture — กัน popup blocker) แล้วค่อยใส่ URL เมื่อได้ token
        const w = window.open('about:blank', '_blank');
        try {
          const r = await cunwrap(
            consoleApi.POST('/v1/platform/tenants/{id}/impersonate', {
              params: { path: { id: x.id } },
              body: {
                reason,
                ...(v.as ? { asUserId: v.as } : {}),
                ...(v.ticket?.trim() ? { ticketRef: v.ticket.trim() } : {}),
              },
            }),
          );
          if (w) {
            w.opener = null;
            w.location.replace(r.url);
          } else window.open(r.url, '_blank', 'noopener');
          onClose();
        } catch (e) {
          w?.close();
          throw e;
        }
      }}
    />
  );
}

function CreateTenantDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (n: Tenant) => void;
}) {
  const { t } = useI18n();
  const planFields = usePlanFields();
  const create = useMutation({
    mutationFn: (body: components['schemas']['CreatePlatformTenantDto']) =>
      cunwrap(consoleApi.POST('/v1/platform/tenants', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['console', 'tenants'] }),
  });
  return (
    <ActionDialog
      title={t('con.dlg.createT')}
      desc={t('con.dlg.createD')}
      fields={[
        { k: 'name', l: 'con.f.name', type: 'in' },
        { k: 'ownerName', l: 'con.f.ownerName', type: 'in' },
        { k: 'ownerEmail', l: 'con.f.ownerEmail', type: 'in', im: 'email' },
        ...planFields,
      ]}
      init={{ name: '', ownerName: '', ownerEmail: '', plan: 'std', quota: '' }}
      okL={t('con.ten.create')}
      check={(v) =>
        v.name?.trim().length && v.ownerName?.trim() && v.ownerEmail?.trim()
          ? quotaOf(v.quota ?? '') === 'bad'
            ? t('con.f.quotaBad')
            : ''
          : t('con.f.required')
      }
      onClose={onClose}
      onOk={async (v, reason) => {
        const q = quotaOf(v.quota ?? '');
        const n = await create.mutateAsync({
          name: v.name!.trim(),
          ownerName: v.ownerName!.trim(),
          ownerEmail: v.ownerEmail!.trim(),
          planCode: v.plan,
          ...(q !== null ? { vehicleQuota: q as number } : {}),
          reason,
        });
        onDone(n);
      }}
    />
  );
}
