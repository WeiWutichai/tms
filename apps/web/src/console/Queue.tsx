import type { components } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { queryClient } from '../api';
import { useI18n, type Lang } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { ActionDialog, TENANT_STATUS } from './Tenants';
import { can, consoleApi, cunwrap, useSignupQueue, useStaff } from './session';

type Item = components['schemas']['SignupQueueItemDto'];
type Detail = components['schemas']['SignupQueueDetailDto'];

/** ลิงก์ค้นด้วยมือเมื่อเรียกข้อมูลทางการไม่สำเร็จ (spec/01 §10.3 ข้อ 8 · R-08) */
export const RD_SEARCH_URL = 'https://vsreg.rd.go.th/VATINFOWSWeb/jsp/V001.jsp';
export const DBD_SEARCH_URL = 'https://datawarehouse.dbd.go.th/';

/** soft() ของต้นแบบ Platform Console */
const SOFT = {
  ok: ['#17733F', '#E7F3EC', 'circle-check'],
  warn: ['#8F5500', '#FCF0DC', 'circle-alert'],
  err: ['#B3322A', '#FBE9E7', 'circle-x'],
  info: ['#2257C4', '#E9F0FA', 'info'],
  off: ['#59606B', '#EEF0EC', 'circle'],
} as const;
const CHECK: Record<string, keyof typeof SOFT> = {
  duplicate: 'warn',
  not_found: 'err',
  mismatch: 'warn',
  match: 'ok',
};

function Soft({ k, l }: { k: keyof typeof SOFT; l: string }) {
  const [c, bg, i] = SOFT[k];
  return (
    <span className="con-badge" style={{ background: bg, color: c }}>
      <Icon n={i} s={12} strokeWidth={1.8} />
      {l}
    </span>
  );
}

/** สถานะรายการ: รอยืนยัน (ป้าย pending_verification ของ plans.js) · ขอข้อมูลเพิ่ม (warn) */
function StatusBadge({ s }: { s: string }) {
  const { t } = useI18n();
  if (s === 'info_requested') return <Soft k="warn" l={t('con.q.st.info_requested')} />;
  const b = TENANT_STATUS.pending_verification!;
  return (
    <span className="con-badge" style={{ background: b.bg, color: b.c }}>
      <Icon n={b.i} s={12} strokeWidth={1.8} />
      {t(b.k)}
    </span>
  );
}

/** "4 พ.ย. 2569 09:12" ตามเวลาไทย (ปี พ.ศ. เมื่อภาษาไทย) */
function at(iso: string, lang: Lang): string {
  const loc = lang === 'th' ? 'th-TH-u-ca-buddhist' : lang === 'zh' ? 'zh-CN' : 'en-GB';
  return new Intl.DateTimeFormat(loc, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(iso));
}

/** ชื่อในตาราง: คำขอเข้าร่วม = "(ขอเข้าร่วม)" ต่อท้ายตามต้นแบบ Q2 · "ติดต่อเรา" = "(ติดต่อเรา)" */
function useNameOf() {
  const { t } = useI18n();
  return (x: Item) =>
    x.kind === 'join'
      ? `${x.name} ${t('con.q.joinTag')}`
      : x.kind === 'contact'
        ? `${x.name} ${t('con.q.contactTag')}`
        : x.name;
}

function useVehicles() {
  const { t } = useI18n();
  return (x: Item) =>
    x.fleetSizeOwn == null && x.fleetSizeSubcon == null
      ? '—'
      : t('con.q.veh', { own: x.fleetSizeOwn ?? 0, sub: x.fleetSizeSubcon ?? 0 });
}

/** หน้า "คิวอนุมัติการสมัคร" (pg === 'q' ในต้นแบบ) + drawer ที่ /console/queue/:id (P1-ST2-T06) */
export function QueuePage() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const { id } = useParams();
  const role = useStaff().data?.role;
  const q = useSignupQueue();
  const [toast, setToast] = useState('');
  const [policyDlg, setPolicyDlg] = useState(false);
  const nameOf = useNameOf();
  const veh = useVehicles();

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 3400);
    return () => clearTimeout(h);
  }, [toast]);

  const rows = q.data?.data ?? [];
  const auto = q.data?.policy !== 'manual_all';
  const owner = can.settings(role);

  return (
    <>
      <div className="con-title">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{t('con.q.title')}</h1>
          <p>
            {q.data
              ? t('con.q.policy', { p: t(auto ? 'con.q.policyAuto' : 'con.q.policyReview') })
              : ' '}
          </p>
        </div>
        {q.data && (
          <button
            type="button"
            className="con-act"
            style={{ opacity: owner ? 1 : 0.5 }}
            title={owner ? undefined : t('con.q.ownerOnly')}
            onClick={() => (owner ? setPolicyDlg(true) : setToast(t('con.q.ownerOnly')))}
          >
            <Icon n="settings-2" s={16} strokeWidth={1.8} />
            {t(auto ? 'con.q.toReview' : 'con.q.toAuto')}
          </button>
        )}
      </div>
      <section className="con-card">
        <table className="con-tbl">
          <thead>
            <tr>
              <th>{t('con.q.col.co')}</th>
              <th>{t('con.q.col.tax')}</th>
              <th>{t('con.q.col.who')}</th>
              <th>{t('con.q.col.veh')}</th>
              <th>{t('con.q.col.check')}</th>
              <th>{t('con.q.col.status')}</th>
              <th>{t('con.q.col.at')}</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading
              ? Array.from({ length: 4 }, (_, i) => (
                  <tr key={i} aria-hidden="true">
                    {[180, 110, 140, 80, 80, 70, 110].map((w, j) => (
                      <td key={j}>
                        <span className="con-skel" style={{ width: w }} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((r) => (
                  <tr
                    key={r.id}
                    aria-selected={r.id === id}
                    data-over-sla={r.overSla || undefined}
                    // เกิน SLA 1 วันทำการ = แถวสีรอ (spec/01 §10.3 ข้อ 3)
                    style={r.overSla ? { background: '#FCF0DC' } : undefined}
                    onClick={() => nav(`/console/queue/${r.id}`)}
                  >
                    <td>
                      <div className="con-cell">
                        <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{nameOf(r)}</span>
                        {r.flags.includes('no_accounting_software') && (
                          <span className="con-cell__sub" style={{ color: '#8F5500' }}>
                            {t('con.q.flag.no_accounting_software')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.taxId ?? '—'}</td>
                    <td>
                      <div className="con-cell">
                        <span style={{ whiteSpace: 'nowrap' }}>{r.applicantName ?? '—'}</span>
                        {r.applicantEmail && (
                          <span className="con-cell__sub">{r.applicantEmail}</span>
                        )}
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{veh(r)}</td>
                    <td>
                      <Soft
                        k={CHECK[r.check] ?? 'off'}
                        l={t(`con.q.check.${r.check}` as MessageKey)}
                      />
                    </td>
                    <td>
                      <StatusBadge s={r.status} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap', color: r.overSla ? '#8F5500' : undefined }}>
                      {at(r.submittedAt, lang)}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {q.isError && <div className="con-empty">{t('con.loadFailed')}</div>}
        {!q.isLoading && !q.isError && !rows.length && (
          <div className="con-empty">{t('con.q.empty')}</div>
        )}
      </section>
      {id && (
        <QueueDrawer
          id={id}
          onClose={() => nav('/console/queue')}
          onDone={(m) => {
            nav('/console/queue');
            setToast(m);
          }}
        />
      )}
      {policyDlg && (
        <ActionDialog
          title={t(auto ? 'con.q.toReview' : 'con.q.toAuto')}
          desc={t(auto ? 'con.q.toReviewD' : 'con.q.toAutoD')}
          okL={t('common.save')}
          onClose={() => setPolicyDlg(false)}
          onOk={async (_v, reason) => {
            await cunwrap(
              consoleApi.PUT('/v1/platform/settings/{key}', {
                params: { path: { key: 'signup.approvalPolicy' } },
                body: { value: auto ? 'manual_all' : 'auto_when_verified', reason },
              }),
            );
            setPolicyDlg(false);
            void queryClient.invalidateQueries({ queryKey: ['console', 'signup-queue'] });
            void queryClient.invalidateQueries({ queryKey: ['console', 'settings'] });
            setToast(t('con.q.toast.policy'));
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

type Dlg = 'approve' | 'reject' | 'info' | null;
const COMPARE_LABEL: Record<string, MessageKey> = {
  name: 'con.q.f.name',
  address: 'con.q.f.address',
  branch: 'con.q.f.branch',
  businessStatus: 'con.q.f.businessStatus',
  vatRegisteredSince: 'con.q.f.vatRegisteredSince',
  tsic: 'con.q.f.tsic',
};

function QueueDrawer({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const role = useStaff().data?.role;
  const [dlg, setDlg] = useState<Dlg>(null);
  const nameOf = useNameOf();
  const veh = useVehicles();
  const d = useQuery({
    queryKey: ['console', 'signup-queue', id],
    queryFn: () =>
      cunwrap(consoleApi.GET('/v1/platform/signup-queue/{id}', { params: { path: { id } } })),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !dlg && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dlg, onClose]);
  const x = d.data;
  const join = x?.kind === 'join' || x?.kind === 'contact';
  const notFound = x?.kind === 'signup' && x.rdStatus !== 'found';
  const warn = !x
    ? null
    : x.duplicate
      ? {
          m: t('con.q.warnDup', { tax: x.taxId ?? '', n: x.duplicate.name }),
          bg: '#FCF0DC',
          c: '#8F5500',
        }
      : notFound
        ? { m: t('con.q.warnNotFound'), bg: '#FBE9E7', c: '#B3322A' }
        : null;
  const canDecide = can.approveSignup(role);
  const rdDiffers = !!x && x.rdStatus === 'found' && x.compare.some((c) => c.differs);
  const finish = (k: 'approved' | 'rejected' | 'info') => {
    void queryClient.invalidateQueries({ queryKey: ['console', 'signup-queue'] });
    void queryClient.invalidateQueries({ queryKey: ['console', 'tenants'] });
    setDlg(null);
    onDone(t(`con.q.toast.${k}`, { n: x?.name ?? '' }));
  };
  const post = (
    path: 'approve' | 'reject' | 'request-info',
    body: { reason: string; applyOfficialData?: boolean },
  ) => {
    const opts = { params: { path: { id } }, body };
    return cunwrap(
      path === 'approve'
        ? consoleApi.POST('/v1/platform/signup-queue/{id}/approve', opts)
        : path === 'reject'
          ? consoleApi.POST('/v1/platform/signup-queue/{id}/reject', opts)
          : consoleApi.POST('/v1/platform/signup-queue/{id}/request-info', opts),
    );
  };

  async function downloadCert() {
    const r = await consoleApi.GET('/v1/platform/signup-queue/{id}/certificate', {
      params: { path: { id } },
      parseAs: 'blob',
    });
    if (!r.response.ok || !(r.data instanceof Blob)) return;
    const url = URL.createObjectURL(r.data);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <>
      <div className="con-scrim" onClick={onClose} />
      <aside className="con-drawer" role="dialog" aria-modal="true" aria-label={x?.name}>
        <div className="con-drawer__head">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', paddingBottom: 14 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="con-drawer__kind">
                {x ? t('con.q.kind', { at: at(x.submittedAt, lang) }) : '…'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="con-drawer__t">{x ? nameOf(x) : '…'}</span>
                {x && <StatusBadge s={x.status} />}
              </div>
              {x && (
                <span style={{ color: '#3B424C' }}>
                  {[x.applicantName, x.applicantEmail].filter(Boolean).join(' · ')}
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
        </div>
        <div className="con-drawer__body">
          {d.isError && <span style={{ color: '#59606B' }}>{t('con.loadFailed')}</span>}
          {warn && (
            <div className="con-warn" role="note" style={{ background: warn.bg, color: warn.c }}>
              <Icon
                n="triangle-alert"
                s={16}
                strokeWidth={1.8}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <span>
                {warn.m}
                {x?.duplicate && (
                  <>
                    {' · '}
                    <Link
                      to={`/console/tenants/${x.duplicate.tenantId}`}
                      style={{ color: 'inherit' }}
                    >
                      {t('con.q.openTenant')}
                    </Link>
                  </>
                )}
              </span>
            </div>
          )}
          {x && (
            <>
              {x.verification?.status === 'info_requested' && (
                <section className="con-sec">
                  <span className="con-sec__t">{t('con.q.sec.info')}</span>
                  <span>{x.verification.reason}</span>
                  <span style={{ fontSize: 12.5, color: '#59606B' }}>
                    {[
                      x.verification.decidedByName,
                      x.verification.decidedAt && at(x.verification.decidedAt, lang),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </section>
              )}
              <section className="con-sec">
                <span className="con-sec__t">
                  {t(join ? 'con.q.sec.company' : 'con.q.sec.compare')}
                </span>
                <div className="con-cmp" role="table" aria-label={t('con.q.sec.compare')}>
                  <div className="con-cmp__row con-cmp__row--hd" role="row">
                    <span role="columnheader" />
                    <span role="columnheader">
                      {t(join ? 'con.q.colExisting' : 'con.q.colEntered')}
                    </span>
                    <span role="columnheader">{t('con.q.colRd')}</span>
                    <span role="columnheader">{t('con.q.colDbd')}</span>
                  </div>
                  {x.compare.map((c) => (
                    <div key={c.field} className="con-cmp__row" role="row" data-field={c.field}>
                      <span role="rowheader" className="con-kv__k">
                        {t(COMPARE_LABEL[c.field] ?? 'con.q.f.name')}
                      </span>
                      <span
                        role="cell"
                        data-differs={c.differs || undefined}
                        style={{ background: c.differs ? '#FBE9E7' : 'transparent' }}
                      >
                        {c.entered ?? '—'}
                      </span>
                      <span role="cell" style={{ color: c.rd ? '#101418' : '#59606B' }}>
                        {c.rd ?? (join ? '—' : t('con.q.notFound'))}
                      </span>
                      <span role="cell" style={{ color: '#59606B' }}>
                        {c.dbd ?? t('con.q.notFound')}
                      </span>
                    </div>
                  ))}
                </div>
                <span style={{ fontSize: 12.5, color: '#59606B' }}>
                  {t('con.q.manual')}{' '}
                  <a href={RD_SEARCH_URL} target="_blank" rel="noopener noreferrer">
                    {t('con.q.colRd')}
                  </a>
                  {' · '}
                  <a href={DBD_SEARCH_URL} target="_blank" rel="noopener noreferrer">
                    {t('con.q.colDbd')}
                  </a>
                </span>
              </section>
              <section className="con-sec">
                <span className="con-sec__t">{t('con.q.sec.more')}</span>
                <div className="con-kv">
                  {(
                    [
                      ['con.q.kv.veh', veh(x)],
                      [
                        'con.q.kv.acc',
                        x.accountingSoftware
                          ? t(`con.q.acc.${x.accountingSoftware}` as MessageKey)
                          : '—',
                      ],
                      ['con.q.kv.at', at(x.submittedAt, lang)],
                      ['con.q.kv.channel', t(join ? 'con.q.channelJoin' : 'con.q.channelWeb')],
                      ...(x.flags.length
                        ? ([
                            [
                              'con.q.kv.flags',
                              x.flags.map((f) => t(`con.q.flag.${f}` as MessageKey)).join(' · '),
                            ],
                          ] as [MessageKey, string][])
                        : []),
                    ] as [MessageKey, string][]
                  ).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className="con-kv__k">{t(k)}</span>
                      <span className="con-kv__v">{v}</span>
                    </div>
                  ))}
                </div>
              </section>
              {!join && (
                <section className="con-sec">
                  <span className="con-sec__t">{t('con.q.sec.cert')}</span>
                  {x.certificate ? (
                    <div className="con-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>
                          {x.certificate.filename ?? t('con.q.certFile')}
                        </span>
                        <span style={{ fontSize: 12.5, color: '#59606B' }}>
                          {`${Math.max(1, Math.round(x.certificate.sizeBytes / 1024))} KB`}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="con-sbtn"
                        onClick={() => void downloadCert()}
                      >
                        <Icon n="file-text" s={16} strokeWidth={1.8} />
                        {t('con.q.certOpen')}
                      </button>
                    </div>
                  ) : (
                    <span style={{ color: '#59606B' }}>{t('con.q.certNone')}</span>
                  )}
                </section>
              )}
              <section className="con-sec">
                <span className="con-sec__t">{t('con.q.sec.hist')}</span>
                {x.history.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {x.history.map((h, i) => (
                      <div
                        key={i}
                        className="con-row"
                        style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <span style={{ fontWeight: 500 }}>{h.name}</span>
                          <span style={{ fontSize: 12.5, color: '#59606B' }}>
                            {t(`con.q.hist.${h.kind}` as MessageKey)} ·{' '}
                            {t(`con.q.match.${h.match}` as MessageKey)}
                          </span>
                        </div>
                        <span style={{ fontSize: 12.5, color: '#59606B', whiteSpace: 'nowrap' }}>
                          {at(h.at, lang)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: '#59606B' }}>{t('con.q.histNone')}</span>
                )}
              </section>
            </>
          )}
        </div>
        {x && canDecide && (
          <div className="con-drawer__foot">
            <button type="button" className="con-fbtn" onClick={() => setDlg('reject')}>
              <Icon n="x" s={16} strokeWidth={1.8} />
              {t('con.q.reject')}
            </button>
            <button type="button" className="con-fbtn" onClick={() => setDlg('info')}>
              <Icon n="mail" s={16} strokeWidth={1.8} />
              {t('con.q.info')}
            </button>
            <button
              type="button"
              className="con-fbtn con-fbtn--pri"
              onClick={() => setDlg('approve')}
            >
              <Icon n="check" s={16} strokeWidth={1.8} />
              {t(join ? 'con.q.approveJoin' : 'con.q.approve')}
            </button>
          </div>
        )}
      </aside>
      {x && dlg === 'approve' && (
        <ActionDialog
          title={t('con.q.approveT', { n: x.name })}
          desc={t(join ? 'con.q.approveJoinD' : 'con.q.approveD')}
          warn={join ? t('con.q.approveJoinWarn') : undefined}
          fields={
            rdDiffers
              ? [
                  {
                    k: 'official',
                    l: 'con.q.official',
                    type: 'sel',
                    opts: [
                      { v: 'keep', l: t('con.q.officialKeep') },
                      { v: 'rd', l: t('con.q.officialRd') },
                    ],
                  },
                ]
              : []
          }
          init={{ official: 'keep' }}
          okL={t(join ? 'con.q.approveJoin' : 'con.q.approve')}
          onClose={() => setDlg(null)}
          onOk={async (v, reason) => {
            await post('approve', {
              reason,
              ...(rdDiffers && v.official === 'rd' ? { applyOfficialData: true } : {}),
            });
            finish('approved');
          }}
        />
      )}
      {x && dlg === 'reject' && (
        <ActionDialog
          title={t('con.q.rejectT', { n: x.name })}
          desc={t('con.q.rejectD')}
          danger
          okL={t('con.q.reject')}
          onClose={() => setDlg(null)}
          onOk={async (_v, reason) => {
            await post('reject', { reason });
            finish('rejected');
          }}
        />
      )}
      {x && dlg === 'info' && (
        <ActionDialog
          title={t('con.q.infoT', { n: x.name })}
          desc={t('con.q.infoD')}
          okL={t('con.q.info')}
          onClose={() => setDlg(null)}
          onOk={async (_v, reason) => {
            await post('request-info', { reason });
            finish('info');
          }}
        />
      )}
    </>
  );
}

export type { Detail as SignupQueueDetail };
