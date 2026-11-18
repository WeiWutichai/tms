import type { Schemas } from '@tms/contracts';
import { Badge, EmptyState, Icon, ReasonDialog, Toast, type Tone } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, unwrap } from '../../api';
import { formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { SecretDialog } from '../api-keys/SecretDialog';
import { problemText } from '../master/problems';
import { Toggle } from './Settings';

type Connector = Schemas['ConnectorDto'];
type Adapter = Schemas['ErpAdapterDto'];
type Command = Schemas['ConnectorCommandDto'];
type T = ReturnType<typeof useI18n>['t'];

/** ไอคอนการ์ดตามระบบ (ต้นแบบ this.CONN) — ระบบที่ไม่รู้จัก = database */
const ICON: Record<string, string> = { demo: 'database', krs: 'database' };

/** ป้ายสถานะ connector (ต้นแบบ badge 'เชื่อมต่อ' / 'ยังไม่เชื่อม' + สถานะที่ต้นแบบไม่มี — [DECISION spec/12 §3]) */
const STATUS_BADGE: Record<string, { k: MessageKey; tone: Tone; i: string }> = {
  ACTIVE: { k: 'cnx.b.on', tone: 'ok', i: 'plug' },
  PAUSED: { k: 'cnx.b.paused', tone: 'off', i: 'pause' },
  ERROR: { k: 'cnx.b.error', tone: 'err', i: 'circle-x' },
};
const OFF_BADGE = { k: 'cnx.b.off' as MessageKey, tone: 'off' as Tone, i: 'unplug' };

/** ผลของคำสั่ง (ต้นแบบ badge ของบันทึกการซิงก์: สำเร็จ / ล้มเหลว + สถานะคิวอื่น) */
export const COMMAND_BADGE: Record<string, { k: MessageKey; tone: Tone; i: string }> = {
  DONE: { k: 'cnx.cmd.DONE', tone: 'ok', i: 'check' },
  FAILED_FINAL: { k: 'cnx.cmd.FAILED_FINAL', tone: 'err', i: 'x' },
  FAILED_RETRYABLE: { k: 'cnx.cmd.FAILED_RETRYABLE', tone: 'warn', i: 'refresh-cw' },
  PENDING: { k: 'cnx.cmd.PENDING', tone: 'info', i: 'clock' },
  IN_FLIGHT: { k: 'cnx.cmd.IN_FLIGHT', tone: 'info', i: 'loader' },
  SKIPPED: { k: 'cnx.cmd.SKIPPED', tone: 'off', i: 'skip-forward' },
};

export function operationLabel(t: T, op: string): string {
  const k = `cnx.op.${op}` as MessageKey;
  return t(k) === k ? op : t(k);
}

/** ชื่อ connector ที่แสดง — Demo ใช้ป้ายไทย "จำลอง" (ST7-T14 ส่งต่อ: displayName อังกฤษ ป้ายไทยทำใน i18n ของ T20) */
export function adapterName(t: T, key: string, displayName?: string | null, demo?: boolean) {
  if (demo || key === 'demo') return t('cnx.demo.n');
  return displayName ?? key;
}

/** credential ไม่แสดงค่า — มีแค่ชื่อช่อง + จุดปิด (INT-003; เกณฑ์ตรวจรับ "credential ไม่แสดงเต็ม") */
export const MASK = '••••••••';

/**
 * ตั้งค่า → การเชื่อมต่อ → ระบบบัญชี (ERP) — ต้นแบบ TMS v4 `st.is.conn` (ST7-T20; docs/04 G3 "หน้าจัดการ connector", spec/07 §1)
 * - การ์ด "ไม่เชื่อม" + การ์ดระบบจาก catalog (`GET /connectors/adapters` ไม่ hard-code — INT-010) + "API ทั่วไป" (ไปหน้า Open API)
 * - การ์ด: เชื่อมต่อ (ยังไม่มี = กรอก credential แล้วทดสอบ+เปิดใช้ · มีแล้ว PAUSED/ERROR = เปิดใช้หลังทดสอบผ่าน) / ตัดการเชื่อมต่อ (เหตุผล ≥ 10) · ทดสอบ · ดู log
 * - กล่อง "ตั้งค่า {ระบบ}": วันที่เริ่มซิงก์ + ส่วนที่ต้นแบบไม่มี (credential แบบปิดค่า + เปลี่ยน key, ฟีเจอร์ที่เปิด, URL รับ webhook ขาเข้า) [DECISION spec/12 §3]
 *   แท็บ "บันทึกการซิงก์" = คำสั่งล่าสุดในคิว (ไม่มี payload — ST7-T19) · ใครออกเลขเอกสาร = ST7-T17 · ตาราง mapping = ST7-T18
 * - แพ็กเกจไม่มีการเชื่อมต่อ (403) = การ์ด "ไม่เชื่อม" อย่างเดียว + ข้อความแพ็กเกจ
 */
export function ConnectorSettingsSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const go = useNavigate();
  const qc = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'map' | 'log'>('map');
  const [connectFor, setConnectFor] = useState<Adapter | null>(null);
  const [disc, setDisc] = useState<Connector[] | null>(null);

  const list = useQuery({
    queryKey: ['connectors'],
    queryFn: () => unwrap(api.GET('/v1/connectors')),
    retry: false,
  });
  const notInPlan = list.error instanceof ApiError && list.error.problem.status === 403;
  const catalog = useQuery({
    queryKey: ['connector-adapters'],
    queryFn: () => unwrap(api.GET('/v1/connectors/adapters')),
    enabled: !notInPlan && !list.isLoading,
    retry: false,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['connectors'] });

  const conns = list.data?.data ?? [];
  const adapters = [...(catalog.data?.data ?? [])].sort((a, b) =>
    adapterName(t, a.key, a.displayName, a.demo).localeCompare(
      adapterName(t, b.key, b.displayName, b.demo),
      'th',
    ),
  );
  /** connector ของระบบนั้น — ตัว "ทุกนิติบุคคล" ก่อน (หน้าแสดง 1 ตัวต่อระบบ) */
  const connOf = (key: string) =>
    conns
      .filter((c) => c.adapterKey === key)
      .sort((a, b) => Number(!!a.companyId) - Number(!!b.companyId))[0];
  const anyConn = conns.length > 0;
  const selKey = sel ?? conns[0]?.adapterKey ?? null;
  const selAdapter = adapters.find((a) => a.key === selKey) ?? null;
  const selConn = selKey ? connOf(selKey) : undefined;

  const resume = useMutation({
    mutationFn: (c: Connector) =>
      unwrap(
        api.POST('/v1/connectors/{id}/resume', {
          params: { path: { id: c.id }, header: { 'If-Match': `"${c.version}"` } as never },
          body: {},
        }),
      ),
    onSuccess: (c) => {
      refresh();
      setToast(t('cnx.toast.connected', { n: adapterName(t, c.adapterKey, c.displayName) }));
    },
    onError: (e) => {
      refresh();
      setToast(healthFail(t, e));
    },
  });
  const health = useMutation({
    mutationFn: async (c: Connector) => {
      const t0 = performance.now();
      const r = await unwrap(
        api.POST('/v1/connectors/{id}/health', { params: { path: { id: c.id } } }),
      );
      return { r, ms: Math.max(1, Math.round(performance.now() - t0)) };
    },
    onSuccess: ({ r, ms }) => {
      refresh();
      const n = adapterName(t, r.connector.adapterKey, r.connector.displayName);
      setToast(
        r.ok
          ? t('cnx.toast.testOk', { n, ms })
          : t('cnx.toast.testFail', { n, code: r.code ?? '' }),
      );
    },
    onError: (e) => setToast(problemText(e, t)),
  });
  const disconnect = useMutation({
    mutationFn: async ({ list: cs, reason }: { list: Connector[]; reason: string }) => {
      for (const c of cs)
        await unwrap(
          api.POST('/v1/connectors/{id}/disconnect', {
            params: { path: { id: c.id }, header: { 'If-Match': `"${c.version}"` } as never },
            body: { reason },
          }),
        );
      return cs;
    },
    onSuccess: (cs) => {
      setDisc(null);
      refresh();
      setSel(null);
      setToast(
        t('cnx.toast.disconnected', {
          n: cs.map((c) => adapterName(t, c.adapterKey, c.displayName)).join(', '),
        }),
      );
    },
    onError: () => refresh(),
  });

  if (list.isLoading)
    return (
      <Shell>
        <div className="cnx-msg">{t('cnx.loading')}</div>
      </Shell>
    );
  if (list.isError && !notInPlan)
    return (
      <Shell>
        <EmptyState
          icon="triangle-alert"
          title={t('cnx.loadError')}
          action={
            <button type="button" className="set-btn2" onClick={() => void list.refetch()}>
              {t('cnx.retry')}
            </button>
          }
        />
      </Shell>
    );

  const noneOn = !anyConn;
  // ต้นแบบ/spec/07 §1: การ์ดเรียงตามตัวอักษร รวม "API ทั่วไป" (เห็นเฉพาะผู้ที่เข้าหน้า Open API ได้)
  const apiName = t('cnx.apiCard.n');
  const items: (Adapter | 'api')[] = [...adapters];
  if (canWrite) {
    const at = items.findIndex(
      (a) =>
        a !== 'api' &&
        adapterName(t, a.key, a.displayName, a.demo).localeCompare(apiName, 'th') > 0,
    );
    items.splice(at < 0 ? items.length : at, 0, 'api');
  }
  return (
    <section className="cnx" aria-label={t('cnx.title')}>
      <div className="cnx-hd">
        <h2>{t('cnx.title')}</h2>
        <span>{t('cnx.sub')}</span>
      </div>
      <div className="cnx-grid">
        <Card
          on={noneOn}
          icon="file-check"
          name={t('cnx.none.n')}
          desc={t('cnx.none.d')}
          meta={t(noneOn ? 'cnx.none.metaOn' : 'cnx.none.metaOff')}
          badge={
            noneOn ? (
              <Badge label={t('cnx.none.on')} tone="ok" icon="check" />
            ) : (
              <Badge label={t(OFF_BADGE.k)} tone={OFF_BADGE.tone} icon={OFF_BADGE.i} />
            )
          }
        >
          <button
            type="button"
            className="cnx-tog"
            disabled={noneOn || !canWrite}
            onClick={(e) => {
              e.stopPropagation();
              if (!noneOn) setDisc(conns);
            }}
          >
            <Icon n={noneOn ? 'check' : 'undo-2'} s={16} />
            {t(noneOn ? 'cnx.none.on' : 'cnx.none.use')}
          </button>
        </Card>
        {!notInPlan &&
          items.map((a) => {
            if (a === 'api') return <ApiCard key="api" onGo={() => go('/settings/api')} />;
            const c = connOf(a.key);
            const n = adapterName(t, a.key, a.displayName, a.demo);
            const b = c ? (STATUS_BADGE[c.status] ?? OFF_BADGE) : OFF_BADGE;
            const on = c?.status === 'ACTIVE';
            // เชื่อมได้ครั้งละ 1 ระบบ (ขอบเขต "ทุกนิติบุคคล") — มีระบบอื่นอยู่ = ต้องตัดก่อน
            const other = !c && conns.some((x) => !x.companyId);
            return (
              <Card
                key={a.key}
                on={on}
                icon={ICON[a.key] ?? 'database'}
                name={n}
                desc={t(a.demo ? 'cnx.demo.d' : 'cnx.adapter.d')}
                meta={<CardMeta c={c} />}
                badge={<Badge label={t(b.k)} tone={b.tone} icon={b.i} />}
                onPick={() => setSel(a.key)}
              >
                {canWrite && (
                  <button
                    type="button"
                    className="cnx-tog"
                    disabled={other || resume.isPending}
                    title={other ? t('cnx.oneAtATime') : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSel(a.key);
                      if (on && c) setDisc([c]);
                      else if (c) resume.mutate(c);
                      else setConnectFor(a);
                    }}
                  >
                    <Icon n={on ? 'unplug' : 'plug'} s={16} />
                    {t(on ? 'cnx.disconnect' : 'cnx.connect')}
                  </button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    className="cnx-ghost"
                    disabled={health.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (c) health.mutate(c);
                      else setToast(t('cnx.toast.connectFirst', { n }));
                    }}
                  >
                    {t('cnx.test')}
                  </button>
                )}
                <button
                  type="button"
                  className="cnx-ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSel(a.key);
                    setTab('log');
                  }}
                >
                  {t('cnx.viewLog')}
                </button>
              </Card>
            );
          })}
      </div>
      {notInPlan && <div className="cnx-note">{t('cnx.notInPlan')}</div>}
      {selConn && selAdapter && (
        <Detail
          key={selConn.id}
          c={selConn}
          adapter={selAdapter}
          tab={tab}
          setTab={setTab}
          canWrite={canWrite}
          onToast={setToast}
          onConnect={() => resume.mutate(selConn)}
        />
      )}
      {canWrite && (
        <div className="cnx-api">
          <span className="cnx-ico">
            <Icon n="code-xml" s={18} />
          </span>
          <div className="cnx-api__t">
            <span style={{ fontWeight: 600 }}>{t('cnx.api.t')}</span>
            <span style={{ color: '#3B424C' }}>{t('cnx.api.d')}</span>
          </div>
          <button type="button" className="cnx-tog" onClick={() => go('/settings/api')}>
            {t('cnx.api.go')}
            <Icon n="arrow-right" s={16} />
          </button>
        </div>
      )}
      {connectFor && (
        <ConnectDialog
          adapter={connectFor}
          onClose={() => setConnectFor(null)}
          onDone={(msg) => {
            setConnectFor(null);
            refresh();
            setToast(msg);
          }}
        />
      )}
      <ReasonDialog
        open={!!disc}
        title={t('cnx.dlg.discT', {
          n: (disc ?? []).map((c) => adapterName(t, c.adapterKey, c.displayName)).join(', '),
        })}
        description={t('cnx.dlg.discD')}
        label={t('cnx.reason')}
        placeholder={t('cnx.reasonPh')}
        okLabel={t('cnx.disconnect')}
        okIcon="unplug"
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={disconnect.isPending}
        error={problemText(disconnect.error, t)}
        onClose={() => {
          setDisc(null);
          disconnect.reset();
        }}
        onOk={(reason) => disc && disconnect.mutate({ list: disc, reason })}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </section>
  );
}

function healthFail(t: T, e: unknown): string {
  if (e instanceof ApiError && e.problem.code === 'connector_health_failed') {
    const code = (e.problem as { healthCode?: string }).healthCode ?? '';
    return t('cnx.toast.healthFailed', { code });
  }
  return problemText(e, t) ?? '';
}

function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="set-card">
      <div className="set-card__hd">
        <h2>{t('set.menu.conn')}</h2>
      </div>
      {children}
    </section>
  );
}

/** การ์ดระบบ (ต้นแบบ st.conns — 14px radius, เส้นน้ำเงิน + เงา 1px เมื่อเชื่อมอยู่) */
function Card({
  on,
  icon,
  name,
  desc,
  meta,
  badge,
  onPick,
  children,
}: {
  on: boolean;
  icon: string;
  name: string;
  desc: string;
  meta: ReactNode;
  badge: ReactNode;
  onPick?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="cnx-card"
      data-on={on || undefined}
      data-testid="connector-card"
      onClick={onPick}
      role={onPick ? 'group' : undefined}
      aria-label={name}
    >
      <div className="cnx-card__hd">
        <span className="cnx-ico">
          <Icon n={icon} s={18} />
        </span>
        <span className="cnx-card__n">{name}</span>
        {badge}
      </div>
      <span style={{ color: '#3B424C' }}>{desc}</span>
      <span className="cnx-card__meta">{meta}</span>
      <div className="cnx-card__acts">{children}</div>
    </div>
  );
}

function CardMeta({ c }: { c?: Connector }) {
  const { t, lang } = useI18n();
  const last = useQuery({
    queryKey: ['connector-commands', c?.id, 'DONE1'],
    queryFn: () =>
      unwrap(
        api.GET('/v1/connectors/{id}/commands', {
          params: { path: { id: c!.id }, query: { status: 'DONE', limit: 1 } },
        }),
      ),
    enabled: c?.status === 'ACTIVE',
    retry: false,
  });
  if (!c) return <>{t('cnx.meta.off')}</>;
  if (c.status === 'ERROR')
    return (
      <>
        {t('cnx.meta.error', {
          code: String(
            (c.lastHealthError as { code?: string } | null)?.code ?? c.statusReason ?? '',
          ),
        })}
      </>
    );
  if (c.status === 'PAUSED') return <>{t('cnx.meta.paused')}</>;
  const done = last.data?.data[0];
  return (
    <>
      {done
        ? t('cnx.meta.synced', { d: formatDateTime(done.doneAt ?? done.updatedAt, lang) })
        : t('cnx.meta.noSync')}
    </>
  );
}

/** การ์ด "API ทั่วไป" (ต้นแบบ: ป้าย Open API + จำนวน key/webhook + "ไปหน้า Open API") */
function ApiCard({ onGo }: { onGo: () => void }) {
  const { t } = useI18n();
  const keys = useQuery({
    queryKey: ['cnx-api-keys'],
    queryFn: () => unwrap(api.GET('/v1/api-keys')),
    retry: false,
  });
  const hooks = useQuery({
    queryKey: ['cnx-webhooks'],
    queryFn: () => unwrap(api.GET('/v1/webhooks')),
    retry: false,
  });
  // ต้นแบบ: key สถานะ "ใช้งาน" · webhook ที่ไม่ "ปิด"
  const nk = (keys.data?.data ?? []).filter((k) =>
    ['active', 'expiring', 'rotating'].includes(k.status),
  ).length;
  const nh = (hooks.data?.data ?? []).filter((h) => h.status !== 'disabled').length;
  return (
    <Card
      on={false}
      icon="webhook"
      name={t('cnx.apiCard.n')}
      desc={t('cnx.apiCard.d')}
      meta={t('cnx.apiCard.meta', { k: nk, h: nh })}
      badge={<Badge label="Open API" tone="info" icon="code-xml" />}
    >
      <button
        type="button"
        className="cnx-tog"
        onClick={(e) => {
          e.stopPropagation();
          onGo();
        }}
      >
        <Icon n="arrow-right" s={16} />
        {t('cnx.api.go')}
      </button>
    </Card>
  );
}

/** กล่อง "ตั้งค่า {ระบบ}" (ต้นแบบ st.cd) — แท็บ การจับคู่และเลขเอกสาร / บันทึกการซิงก์ */
function Detail({
  c,
  adapter,
  tab,
  setTab,
  canWrite,
  onToast,
  onConnect,
}: {
  c: Connector;
  adapter: Adapter;
  tab: 'map' | 'log';
  setTab: (t: 'map' | 'log') => void;
  canWrite: boolean;
  onToast: (m: string) => void;
  onConnect: () => void;
}) {
  const { t } = useI18n();
  const n = adapterName(t, c.adapterKey, c.displayName, adapter.demo);
  return (
    <div className="cnx-cd" data-testid="connector-detail">
      <div className="set-tabs-hd">
        <div className="cnx-cd__t">
          <h3>{t('cnx.cd.title', { n })}</h3>
          {c.status !== 'ACTIVE' && <span>{t('cnx.cd.off')}</span>}
        </div>
        <div className="set-tabs" role="tablist">
          {(
            [
              ['map', 'cnx.tab.map'],
              ['log', 'cnx.tab.log'],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
            >
              {t(l)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'map' ? (
        <MapTab c={c} adapter={adapter} canWrite={canWrite} onToast={onToast} />
      ) : (
        <LogTab c={c} n={n} canWrite={canWrite} onConnect={onConnect} />
      )}
    </div>
  );
}

const todayTh = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

function MapTab({
  c,
  adapter,
  canWrite,
  onToast,
}: {
  c: Connector;
  adapter: Adapter;
  canWrite: boolean;
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const id = useId();
  const [from, setFrom] = useState(c.syncFromDate ?? '');
  const [rotOpen, setRotOpen] = useState(false);
  const [inb, setInb] = useState<'rotate' | 'revoke' | null>(null);
  const [secret, setSecret] = useState<{ url: string; copied: boolean } | null>(null);
  useEffect(() => setFrom(c.syncFromDate ?? ''), [c.syncFromDate]);
  const ifMatch = { 'If-Match': `"${c.version}"` } as never;
  const done = () => void qc.invalidateQueries({ queryKey: ['connectors'] });
  const patch = useMutation({
    mutationFn: (body: Schemas['UpdateConnectorDto']) =>
      unwrap(
        api.PATCH('/v1/connectors/{id}', {
          params: { path: { id: c.id }, header: ifMatch },
          body,
        }),
      ),
    onSuccess: () => {
      done();
      onToast(t('cnx.toast.saved'));
    },
    onError: (e) => {
      done();
      onToast(problemText(e, t) ?? '');
    },
  });
  const inbound = useMutation({
    mutationFn: async ({ kind, reason }: { kind: 'rotate' | 'revoke'; reason: string }) => {
      if (kind === 'rotate') {
        const r = await unwrap(
          api.POST('/v1/connectors/{id}/inbound-token/rotate', {
            params: { path: { id: c.id }, header: ifMatch },
            body: { reason },
          }),
        );
        return r.url;
      }
      await unwrap(
        api.POST('/v1/connectors/{id}/inbound-token/revoke', {
          params: { path: { id: c.id }, header: ifMatch },
          body: { reason },
        }),
      );
      return null;
    },
    onSuccess: (url) => {
      setInb(null);
      done();
      if (url) setSecret({ url, copied: false });
      else onToast(t('cnx.toast.inboundRevoked'));
    },
    onError: () => done(),
  });

  const secrets = adapter.configFields.filter((f) => f.secret);
  const caps = c.capabilitiesSupported;
  const badDate = !!from && from > todayTh();
  return (
    <div className="cnx-map">
      <label className="cnx-f" htmlFor={`${id}-from`} style={{ maxWidth: 280 }}>
        <span className="cnx-f__l">{t('cnx.f.syncFrom')}</span>
        <input
          id={`${id}-from`}
          type="date"
          className="cnx-in"
          value={from}
          max={todayTh()}
          disabled={!canWrite || patch.isPending}
          onChange={(e) => setFrom(e.target.value)}
          onBlur={() => {
            if (badDate || from === (c.syncFromDate ?? '')) return;
            patch.mutate({ syncFromDate: from || null });
          }}
        />
        <span className="cnx-f__h" style={badDate ? { color: '#B3322A' } : undefined}>
          {badDate ? t('cnx.f.syncFromFuture') : t('cnx.f.syncFromHint')}
        </span>
      </label>

      <div className="cnx-f">
        <span className="cnx-f__l">{t('cnx.f.cred')}</span>
        <div className="cnx-box">
          {secrets.map((f) => {
            const set = c.credentialKeys.includes(f.key);
            return (
              <div key={f.key} className="cnx-row" data-testid="credential-row">
                <span className="cnx-row__k">{f.key}</span>
                <span className="cnx-row__v">
                  {set ? MASK : t('cnx.cred.unset')}
                  {set && c.credentialsUpdatedAt && (
                    <span className="cnx-row__s">
                      {t('cnx.cred.updated', { d: formatDateTime(c.credentialsUpdatedAt, lang) })}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {canWrite && (
          <div>
            <button type="button" className="set-btn2" onClick={() => setRotOpen(true)}>
              <Icon n="key-round" s={16} />
              {t('cnx.cred.rotate')}
            </button>
          </div>
        )}
      </div>

      <div className="cnx-f">
        <span className="cnx-f__l">{t('cnx.f.caps')}</span>
        <div className="cnx-box">
          {caps.map((k) => {
            const on = c.capabilitiesEnabled.includes(k);
            return (
              <div key={k} className="cnx-row">
                <span style={{ flex: 1 }}>{t(`cnx.cap.${k}` as MessageKey)}</span>
                <Toggle
                  on={on}
                  label={t(`cnx.cap.${k}` as MessageKey)}
                  disabled={!canWrite || patch.isPending}
                  onChange={() =>
                    patch.mutate({
                      capabilitiesEnabled: on
                        ? c.capabilitiesEnabled.filter((x) => x !== k)
                        : [...c.capabilitiesEnabled, k],
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      </div>

      {c.inbound.supported && (
        <div className="cnx-f">
          <span className="cnx-f__l">{t('cnx.f.inbound')}</span>
          <div className="cnx-box">
            <div className="cnx-row">
              <span className="cnx-row__v" style={{ flex: 1 }}>
                {c.inbound.tokenPrefix
                  ? `/v1/inbound/${c.adapterKey}/${c.inbound.tokenPrefix}${MASK}`
                  : t('cnx.inbound.none')}
                {c.inbound.tokenRotatedAt && c.inbound.tokenPrefix && (
                  <span className="cnx-row__s">
                    {t('cnx.inbound.rotated', {
                      d: formatDateTime(c.inbound.tokenRotatedAt, lang),
                    })}
                  </span>
                )}
              </span>
              {canWrite && (
                <span style={{ display: 'flex', gap: 4 }}>
                  <button type="button" className="set-btn2" onClick={() => setInb('rotate')}>
                    <Icon n="refresh-cw" s={16} />
                    {t(c.inbound.tokenPrefix ? 'cnx.inbound.rotate' : 'cnx.inbound.issue')}
                  </button>
                  {c.inbound.tokenPrefix && (
                    <button type="button" className="cnx-ghost" onClick={() => setInb('revoke')}>
                      {t('cnx.inbound.revoke')}
                    </button>
                  )}
                </span>
              )}
            </div>
          </div>
          <span className="cnx-f__h">{t('cnx.inbound.hint')}</span>
        </div>
      )}

      {rotOpen && (
        <ConnectDialog
          adapter={adapter}
          rotate={c}
          onClose={() => setRotOpen(false)}
          onDone={(msg) => {
            setRotOpen(false);
            done();
            onToast(msg);
          }}
        />
      )}
      <ReasonDialog
        open={!!inb}
        title={t(inb === 'revoke' ? 'cnx.dlg.inRevokeT' : 'cnx.dlg.inRotateT')}
        description={t(inb === 'revoke' ? 'cnx.dlg.inRevokeD' : 'cnx.dlg.inRotateD')}
        label={t('cnx.reason')}
        placeholder={t('cnx.reasonPh')}
        okLabel={t(inb === 'revoke' ? 'cnx.inbound.revoke' : 'cnx.inbound.rotate')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={inbound.isPending}
        error={problemText(inbound.error, t)}
        onClose={() => {
          setInb(null);
          inbound.reset();
        }}
        onOk={(reason) => inb && inbound.mutate({ kind: inb, reason })}
      />
      {secret && (
        <SecretDialog
          title={t('cnx.secret.title')}
          sub={t('cnx.secret.sub')}
          warn={t('cnx.secret.warn')}
          label={t('cnx.secret.label')}
          value={secret.url}
          copied={secret.copied}
          onCopy={() => {
            void navigator.clipboard?.writeText(secret.url).catch(() => undefined);
            setSecret({ ...secret, copied: true });
          }}
          onClose={() => setSecret(null)}
        />
      )}
    </div>
  );
}

function LogTab({
  c,
  n,
  canWrite,
  onConnect,
}: {
  c: Connector;
  n: string;
  canWrite: boolean;
  onConnect: () => void;
}) {
  const { t, lang } = useI18n();
  const q = useQuery({
    queryKey: ['connector-commands', c.id],
    queryFn: () =>
      unwrap(api.GET('/v1/connectors/{id}/commands', { params: { path: { id: c.id } } })),
  });
  const rows: Command[] = q.data?.data ?? [];
  if (q.isLoading) return <div className="cnx-msg">{t('cnx.loading')}</div>;
  if (q.isError) return <div className="cnx-msg">{t('cnx.loadError')}</div>;
  if (!rows.length)
    return (
      <div className="cnx-empty">
        <Icon n="unplug" s={40} style={{ color: '#C9CDC3' }} />
        <div className="cnx-empty__t">{t('cnx.log.empty')}</div>
        <div style={{ color: '#3B424C' }}>{t('cnx.log.emptyD', { n })}</div>
        {canWrite && c.status !== 'ACTIVE' && (
          <button type="button" className="cnx-tog cnx-tog--lg" onClick={onConnect}>
            <Icon n="plug" s={16} />
            {t('cnx.connect')}
          </button>
        )}
      </div>
    );
  return (
    <div className="set-scroll">
      <table className="cnx-tbl">
        <thead>
          <tr>
            <th>{t('cnx.log.time')}</th>
            <th>{t('cnx.log.doc')}</th>
            <th>{t('cnx.log.action')}</th>
            <th>{t('cnx.log.result')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const b = COMMAND_BADGE[r.status] ?? COMMAND_BADGE.PENDING!;
            return (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.createdAt, lang)}</td>
                <td className="cnx-tbl__doc">{r.localId}</td>
                <td>{operationLabel(t, r.operation)}</td>
                <td>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <Badge label={t(b.k)} tone={b.tone} icon={b.i} />
                    {r.errorCode && <span className="cnx-row__s">{r.errorCode}</span>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * กรอก credential + ค่าตั้งของระบบ (ต้นแบบไม่มีหน้าจอนี้ — [DECISION spec/12 §3] ใช้ dialog + ช่องแบบหน้าตั้งค่า)
 * - เชื่อมต่อใหม่: สร้าง connector แล้วทดสอบ+เปิดใช้ทันที (ไม่ผ่าน = คงหยุดชั่วคราว แจ้งรหัสผล)
 * - `rotate`: เปลี่ยน key (แทนทั้งชุด) ต้องมีเหตุผล ≥ 10 ตัว — ค่าเดิมไม่แสดง
 */
function ConnectDialog({
  adapter,
  rotate,
  onClose,
  onDone,
}: {
  adapter: Adapter;
  rotate?: Connector;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const qc = useQueryClient();
  const n = adapterName(t, adapter.key, adapter.displayName, adapter.demo);
  const fields = adapter.configFields.filter((f) => f.secret || (!rotate && f.options?.length));
  const [v, setV] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = fields.some((f) => f.secret && f.required && !v[f.key]);
  const ok = !missing && !busy && (!rotate || reason.trim().length >= 10);

  async function submit() {
    if (!ok) return;
    setBusy(true);
    setErr(null);
    const pick = (secret: boolean) =>
      Object.fromEntries(
        adapter.configFields
          .filter((f) => f.secret === secret && v[f.key])
          .map((f) => [f.key, v[f.key]!]),
      );
    try {
      if (rotate) {
        await unwrap(
          api.PUT('/v1/connectors/{id}/credentials', {
            params: {
              path: { id: rotate.id },
              header: { 'If-Match': `"${rotate.version}"` } as never,
            },
            body: { credentials: pick(true), reason: reason.trim() },
          }),
        );
        onDone(t('cnx.toast.rotated', { n }));
        return;
      }
      const c = await unwrap(
        api.POST('/v1/connectors', {
          body: { adapterKey: adapter.key, credentials: pick(true), settings: pick(false) },
        }),
      );
      void qc.invalidateQueries({ queryKey: ['connectors'] });
      try {
        await unwrap(
          api.POST('/v1/connectors/{id}/resume', {
            params: { path: { id: c.id }, header: { 'If-Match': `"${c.version}"` } as never },
            body: {},
          }),
        );
        onDone(t('cnx.toast.connected', { n }));
      } catch (e) {
        onDone(healthFail(t, e));
      }
    } catch (e) {
      setErr(problemText(e, t));
      setBusy(false);
    }
  }

  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 id={`${id}-t`} className="tms-dialog__title">
              {t(rotate ? 'cnx.dlg.rotT' : 'cnx.dlg.conT', { n })}
            </h2>
            <p className="tms-dialog__desc">{t(rotate ? 'cnx.dlg.rotD' : 'cnx.dlg.conD')}</p>
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            aria-label={t('drawer.close')}
            title={t('drawer.close')}
            onClick={onClose}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-dialog__body">
          {fields.map((f) => (
            <label key={f.key} className="tms-field" htmlFor={`${id}-${f.key}`}>
              <span className="tms-label">
                {f.key} {f.secret && f.required && <span style={{ color: '#B3322A' }}>*</span>}
              </span>
              {f.options?.length ? (
                <select
                  id={`${id}-${f.key}`}
                  className="tms-input"
                  value={v[f.key] ?? ''}
                  onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
                >
                  <option value="">{t('cnx.f.default')}</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${id}-${f.key}`}
                  className="tms-input"
                  type="password"
                  autoComplete="new-password"
                  value={v[f.key] ?? ''}
                  maxLength={f.maxLength ?? undefined}
                  onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          {rotate && (
            <label className="tms-field" htmlFor={`${id}-reason`}>
              <span className="tms-label">
                {t('cnx.reason')} <span style={{ color: '#B3322A' }}>*</span>
              </span>
              <textarea
                id={`${id}-reason`}
                className="tms-textarea"
                rows={3}
                value={reason}
                placeholder={t('cnx.reasonPh')}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          <span className="tms-field-hint">{t('cnx.dlg.secretHint')}</span>
          {err && <span className="tms-field-error">{err}</span>}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={!ok}
            aria-busy={busy}
            onClick={() => void submit()}
          >
            <Icon n={rotate ? 'key-round' : 'plug'} s={16} />
            {t(rotate ? 'cnx.cred.rotate' : 'cnx.connect')}
          </button>
        </div>
      </div>
    </div>
  );
}
