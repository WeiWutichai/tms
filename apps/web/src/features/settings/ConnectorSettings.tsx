import type { Schemas } from '@tms/contracts';
import { Badge, EmptyState, Icon, ReasonDialog, Toast, type Tone } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, unwrap } from '../../api';
import { formatDate, formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { SecretDialog } from '../api-keys/SecretDialog';
import { HistoryTab } from '../master/HistoryTab';
import { problemText } from '../master/problems';
import { MappingTable } from './Connectors';
import { Radio } from './OrgSections';
import { Toggle } from './Settings';

type Connector = Schemas['ConnectorDto'];
type Adapter = Schemas['ErpAdapterDto'];
type Command = Schemas['ConnectorCommandDto'];
type T = ReturnType<typeof useI18n>['t'];
type Tab = 'map' | 'log' | 'hist';

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

/** เอกสารในบันทึกการซิงก์: ชนิดเอกสาร + ท้าย id 6 ตัว (ยังไม่มีเลขเอกสาร — invoice = ST5) แทน uuid ทั้งยาว */
export function docLabel(t: T, r: { entityType: string; localId: string }): string {
  const k = `cnx.ent.${r.entityType}` as MessageKey;
  return `${t(k) === k ? r.entityType : t(k)} …${r.localId.slice(-6)}`;
}

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
 *   แท็บ "บันทึกการซิงก์" = คำสั่งล่าสุดในคิว (ไม่มี payload — ST7-T19) · ตาราง mapping = ST7-T18
 *   "ใครออกเลขเอกสาร" = `taxDocumentOwner` ของ system-of-record (ST7-T17; D-27 TMS ออกเลขของตัวเองเสมอ) — เปลี่ยนต้องมีเหตุผล
 * - แพ็กเกจไม่มีการเชื่อมต่อ (403) = การ์ด "ไม่เชื่อม" อย่างเดียว + ข้อความแพ็กเกจ
 */
export function ConnectorSettingsSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const go = useNavigate();
  const qc = useQueryClient();
  const [toastMsg, setToastMsg] = useState<{ m: string; err: boolean } | null>(null);
  /** `err` = ผลล้มเหลว (toast สีแดง) */
  const setToast = (m: string | null | undefined, err = false) =>
    setToastMsg(m ? { m, err } : null);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('map');
  const [params] = useSearchParams();
  // ลิงก์จากคำสั่งที่ถูกกัน (ST7-T18) / แจ้งเตือน: `?connector=con_…` เปิดกล่องตั้งค่าของ connector นั้น
  const want = params.get('connector');
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
  const wanted = want ? conns.find((c) => c.id === want) : undefined;
  const selKey = sel ?? wanted?.adapterKey ?? conns[0]?.adapterKey ?? null;
  const selAdapter = adapters.find((a) => a.key === selKey) ?? null;
  const selConn = !sel && wanted ? wanted : selKey ? connOf(selKey) : undefined;

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
      setToast(healthFail(t, e), true);
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
          : t('cnx.toast.testFail', { n, code: healthText(t, r.code) }),
        !r.ok,
      );
    },
    onError: (e) => setToast(problemText(e, t), true),
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

  // catalog โหลด/ล้ม = ห้ามตกไปเป็น "ไม่เชื่อม" ที่กดได้ (QA ST7-T20)
  if (!notInPlan && catalog.isLoading)
    return (
      <Shell>
        <div className="cnx-msg">{t('cnx.loading')}</div>
      </Shell>
    );
  if (!notInPlan && catalog.isError)
    return (
      <Shell>
        <EmptyState
          icon="triangle-alert"
          title={t('cnx.loadError')}
          action={
            <button type="button" className="set-btn2" onClick={() => void catalog.refetch()}>
              {t('cnx.retry')}
            </button>
          }
        />
      </Shell>
    );
  if (want && !wanted && !notInPlan)
    return (
      <Shell>
        <EmptyState icon="unplug" title={t('conn.gone.title')} description={t('conn.gone.desc')} />
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
                on={!!c}
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
          onDone={(msg, err) => {
            setConnectFor(null);
            refresh();
            setToast(msg, err);
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
      <Toast
        message={toastMsg?.m ?? null}
        tone={toastMsg?.err ? 'err' : 'ok'}
        onClose={() => setToast(null)}
        closeLabel={t('drawer.close')}
      />
    </section>
  );
}

function healthFail(t: T, e: unknown): string {
  if (e instanceof ApiError && e.problem.code === 'connector_health_failed') {
    const code = (e.problem as { healthCode?: string }).healthCode ?? '';
    return t('cnx.toast.healthFailed', { code: healthText(t, code) });
  }
  return problemText(e, t) ?? '';
}

/** ST8-T03 รหัสผลทดสอบการเชื่อมต่อ → ข้อความไทย (ไม่รู้จัก = รหัสเดิม) */
const HEALTH_CODES: Record<string, MessageKey> = {
  unreachable: 'cnx.hc.unreachable',
  timeout: 'cnx.hc.timeout',
  service_unavailable: 'cnx.hc.service_unavailable',
  unauthorized: 'cnx.hc.unauthorized',
  credentials_missing: 'cnx.hc.credentials_missing',
  config_missing: 'cnx.hc.config_missing',
  url_not_allowed: 'cnx.hc.url_not_allowed',
  // ST8-T04 รอบดึง SO หยุด connector เพราะแหล่งข้อมูลผิดโครงสร้าง
  source_not_found: 'cnx.hc.source_not_found',
  source_columns_missing: 'cnx.hc.source_columns_missing',
};
export function healthText(t: T, code: string | null | undefined): string {
  const k = code ? HEALTH_CODES[code] : undefined;
  return k ? t(k) : (code ?? '');
}

/** ERROR เพราะปลายทางไม่ตอบ (TRANSIENT — ระบบกู้คืนเอง) หรือ key (AUTH — คนต้องแก้) */
function errorOf(c: Connector): { code: string; down: boolean } {
  const e = (c.lastHealthError ?? null) as { code?: string; errorClass?: string } | null;
  return { code: String(e?.code ?? c.statusReason ?? ''), down: e?.errorClass === 'TRANSIENT' };
}

/** ST8-T03 ชื่อช่องค่าตั้งของ adapter เป็นภาษาไทย (ไม่รู้จัก = ชื่อช่อง) */
const FIELD_LABELS: Record<string, MessageKey> = {
  apiKey: 'cnx.fl.apiKey',
  baseUrl: 'cnx.fl.baseUrl',
  healthTransactionNo: 'cnx.fl.healthTransactionNo',
  salePerson: 'cnx.fl.salePerson',
  sqlServer: 'cnx.fl.sqlServer',
  sqlDatabase: 'cnx.fl.sqlDatabase',
  sqlUser: 'cnx.fl.sqlUser',
  sqlPassword: 'cnx.fl.sqlPassword',
  inboundSecret: 'cnx.fl.inboundSecret',
};
export function fieldLabel(t: T, key: string): string {
  const k = FIELD_LABELS[key];
  return k ? t(k) : key;
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
        {errorOf(c).down
          ? t('cnx.meta.errorDown', { code: healthText(t, errorOf(c).code) })
          : t('cnx.meta.error', { code: healthText(t, errorOf(c).code) })}
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
  tab: Tab;
  setTab: (t: Tab) => void;
  canWrite: boolean;
  onToast: (m: string, err?: boolean) => void;
  onConnect: () => void;
}) {
  const { t } = useI18n();
  const n = adapterName(t, c.adapterKey, c.displayName, adapter.demo);
  return (
    <div className="cnx-cd" data-testid="connector-detail">
      <div className="set-tabs-hd">
        <div className="cnx-cd__t">
          <h3>{t('cnx.cd.title', { n })}</h3>
          {c.status !== 'ACTIVE' && (
            <span>
              {c.status === 'ERROR'
                ? errorOf(c).down
                  ? t('cnx.cd.errorDown', { code: healthText(t, errorOf(c).code) })
                  : t('cnx.cd.error', { code: healthText(t, errorOf(c).code) })
                : c.activatedAt
                  ? t('cnx.cd.paused')
                  : t('cnx.cd.off')}
            </span>
          )}
        </div>
        <div className="set-tabs" role="tablist">
          {(
            [
              ['map', 'cnx.tab.map'],
              ['log', 'cnx.tab.log'],
              ['hist', 'cnx.tab.hist'],
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
      {tab === 'map' && (
        <MapTab c={c} n={n} adapter={adapter} canWrite={canWrite} onToast={onToast} />
      )}
      {tab === 'log' && <LogTab c={c} n={n} canWrite={canWrite} onConnect={onConnect} />}
      {tab === 'hist' && (
        <div className="cnx-map">
          <HistoryTab
            path="/v1/connectors/{id}/history"
            id={c.id}
            fieldLabel={(k) => {
              const key = `cnx.hf.${k}` as MessageKey;
              return t(key) === key ? k : t(key);
            }}
            describe={(r) => {
              const key = `cnx.ha.${r.action}` as MessageKey;
              if (t(key) === key) return undefined;
              const bad = /error|disconnected|revoked|abandoned|skipped/.test(r.action);
              return {
                title: t(key),
                tone: bad ? 'warn' : 'ok',
                icon: bad ? 'triangle-alert' : 'check',
              };
            }}
          />
        </div>
      )}
    </div>
  );
}

/** วันที่แบบต้นแบบ "1 พ.ย. 2569" จาก YYYY-MM-DD */
export const thDate = (d: string, lang: Parameters<typeof formatDate>[1]) =>
  formatDate(new Date(`${d}T00:00:00`), lang);

const todayTh = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

function MapTab({
  c,
  n,
  adapter,
  canWrite,
  onToast,
}: {
  c: Connector;
  n: string;
  adapter: Adapter;
  canWrite: boolean;
  onToast: (m: string, err?: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const id = useId();
  const [from, setFrom] = useState(c.syncFromDate ?? '');
  const [rotOpen, setRotOpen] = useState(false);
  const [inb, setInb] = useState<'rotate' | 'revoke' | null>(null);
  const [secret, setSecret] = useState<{ url: string; copied: boolean } | null>(null);
  const [numTo, setNumTo] = useState<'TMS' | 'ERP' | null>(null);
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
      onToast(problemText(e, t) ?? '', true);
    },
  });
  // ST7-T17 ผู้ออกเลขเอกสาร = เจ้าของเอกสารภาษี (PUT system-of-record — เหตุผลบังคับ)
  const sor = useMutation({
    mutationFn: (body: Schemas['UpdateSystemOfRecordDto']) =>
      unwrap(
        api.PUT('/v1/connectors/{id}/system-of-record', {
          params: { path: { id: c.id }, header: ifMatch },
          body,
        }),
      ),
    onSuccess: () => {
      setNumTo(null);
      done();
      onToast(t('cnx.toast.saved'));
    },
    onError: () => done(),
  });
  const owner = c.systemOfRecord.taxDocumentOwner;
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
          {badDate
            ? t('cnx.f.syncFromFuture')
            : from
              ? t('cnx.f.syncFromOn', { d: thDate(from, lang) })
              : t('cnx.f.syncFromHint')}
        </span>
      </label>

      <div className="cnx-f" data-testid="numbering-owner">
        <Radio
          label={t('cnx.f.numOwner')}
          options={[
            { v: 'TMS', l: t('cnx.num.tms', { n }) },
            { v: 'ERP', l: t('cnx.num.erp', { n }) },
          ]}
          value={owner}
          disabled={!canWrite || sor.isPending}
          onChange={(v) => v !== owner && setNumTo(v as 'TMS' | 'ERP')}
        />
        <span className="cnx-f__h">
          {t(
            owner === 'ERP'
              ? 'cnx.num.erpHint'
              : owner === 'TMS'
                ? 'cnx.num.tmsHint'
                : 'cnx.num.noneHint',
            { n },
          )}
        </span>
      </div>

      <MappingTable c={c} name={n} canWrite={canWrite} />

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
          {/* ST8-T03 ที่ระบบนี้ประกาศแต่ยังไม่ได้ทำ — เปิดไม่ได้ */}
          {(c.capabilitiesPending ?? []).map((k) => (
            <div key={k} className="cnx-row" data-testid="capability-pending">
              <span style={{ flex: 1 }}>{t(`cnx.cap.${k}` as MessageKey)}</span>
              <Badge label={t('cnx.cap.pending')} tone={OFF_BADGE.tone} icon="clock" />
            </div>
          ))}
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
        open={!!numTo}
        title={t('cnx.dlg.numT')}
        description={`${numTo ? t(numTo === 'ERP' ? 'cnx.num.erp' : 'cnx.num.tms', { n }) : ''} · ${t('cnx.dlg.numD', { n })}`}
        label={t('cnx.reason')}
        placeholder={t('cnx.reasonPh')}
        okLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={sor.isPending}
        error={problemText(sor.error, t)}
        onClose={() => {
          setNumTo(null);
          sor.reset();
        }}
        onOk={(reason) => numTo && sor.mutate({ taxDocumentOwner: numTo, reason })}
      />
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
                <td className="cnx-tbl__doc">{docLabel(t, r)}</td>
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
  onDone: (msg: string, err?: boolean) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const qc = useQueryClient();
  const n = adapterName(t, adapter.key, adapter.displayName, adapter.demo);
  // เชื่อมต่อใหม่ = ทุกช่อง (ช่องลับ + ค่าตั้ง เช่น base URL ของ KRS — ST8-T03) · เปลี่ยน key = ช่องลับเท่านั้น
  const fields = adapter.configFields.filter((f) => f.secret || !rotate);
  const [v, setV] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = fields.some((f) => f.required && !v[f.key]?.trim());
  const ok = !missing && !busy && (!rotate || reason.trim().length >= 10);

  async function submit() {
    if (!ok) return;
    setBusy(true);
    setErr(null);
    const pick = (secret: boolean) =>
      Object.fromEntries(
        adapter.configFields
          .filter((f) => f.secret === secret && (secret ? v[f.key] : v[f.key]?.trim()))
          .map((f) => [f.key, secret ? v[f.key]! : v[f.key]!.trim()]),
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
        onDone(healthFail(t, e), true);
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
                {fieldLabel(t, f.key)} {f.required && <span style={{ color: '#B3322A' }}>*</span>}
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
                  type={f.secret ? 'password' : f.kind === 'url' ? 'url' : 'text'}
                  autoComplete={f.secret ? 'new-password' : 'off'}
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
