import {
  Button,
  DataTable,
  EmptyState,
  ReasonDialog,
  StatusDot,
  StatusTabs,
  Tag,
  Toast,
  type Column,
} from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { WebhooksTab } from '../webhooks/WebhooksTab';
import { useWebhookSummary } from '../webhooks/useWebhooks';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { PageHeader } from '../../shell/Header';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal } from '../master/useCursorList';
import { ApiKeyDrawer } from './ApiKeyDrawer';
import { ApiKeyFormDrawer } from './ApiKeyFormDrawer';
import { SecretDialog } from './SecretDialog';
import { useKeyFormat } from './format';
import { getApiMode, MODE_QUERY_KEYS, setApiMode, type ApiMode } from './mode';
import {
  STATUS_TABS,
  useApiKeyAction,
  useApiKeyList,
  useApiKeySummary,
  type ApiKey,
  type ApiKeyFilters,
  type ApiKeyWithSecret,
} from './useApiKeys';
import './api-keys.css';

const EMPTY: ApiKeyFilters = { status: '', name: '', scope: '', createdBy: '' };
type PageTab = 'keys' | 'hooks';

/** แท็บเริ่มจาก `?tab=hooks` (ลิงก์ในแจ้งเตือน webhook ปิดอัตโนมัติ) */
function initialTab(): PageTab {
  try {
    return new URLSearchParams(window.location.search).get('tab') === 'hooks' ? 'hooks' : 'keys';
  } catch {
    return 'keys';
  }
}
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;

/**
 * ตั้งค่า → นักพัฒนา / Open API (ST7-T01) — ต้นแบบ TMS v4 vApi + specApi('keys') + cfKey/cfKeyScope + rotateKey/revokeKey + vSec
 * เฟส 0 มีแท็บ "API keys" + "Webhooks" (ST7-T04) [DECISION spec/12 §3]: ภาพรวม/KPI การเรียก, Log, จับคู่ฟิลด์, MCP, ขีดจำกัด
 * ยังไม่มีข้อมูล (log การเรียก/โควตา/MCP อยู่นอก backlog เฟส 0) · เอกสาร (ST7-T12) เพิ่มแท็บเมื่อทำ ·
 * ปุ่มหัวหน้าเปลี่ยนตามแท็บ (สร้าง API key / เพิ่ม endpoint)
 * ST7-T09: สวิตช์ Production / Sandbox ขวาของแถบแท็บ + แถบ "SANDBOX" (ต้นแบบ vApi modes / api.test) — โหมด Sandbox
 * ทุกตาราง/key/webhook/ประวัติเป็นของ sandbox (API ได้ `X-Tms-Mode: test` — mode.ts) · ออกจากหน้า = กลับเป็น Production
 */
export function ApiKeysPage() {
  const { t } = useI18n();
  const me = useMe();
  const fm = useKeyFormat();
  const canWrite = can(me.data?.scopes ?? [], 'settings:write');
  const [pageTab, setPageTab] = useState<PageTab>(initialTab);
  const qc = useQueryClient();
  const [mode, setMode] = useState<ApiMode>(getApiMode);
  // ออกจากหน้า → คำขอที่อื่นกลับเป็น live (ข้อมูล sandbox ที่ cache ไว้ทิ้ง)
  useEffect(
    () => () => {
      if (getApiMode() === 'live') return;
      setApiMode('live');
      for (const k of MODE_QUERY_KEYS) qc.removeQueries({ queryKey: k });
    },
    [qc],
  );
  const [hookForm, setHookForm] = useState(false);
  const hookSum = useWebhookSummary();
  const switchTab = (k: PageTab) => {
    setPageTab(k);
    try {
      const u = new URL(window.location.href);
      if (k === 'hooks') u.searchParams.set('tab', 'hooks');
      else u.searchParams.delete('tab');
      window.history.replaceState(window.history.state, '', u.toString());
    } catch {
      /* ไม่มี history (test) */
    }
  };
  const [filters, setFilters] = useState<ApiKeyFilters>(EMPTY);
  const list = useApiKeyList(filters);
  const summary = useApiKeySummary();
  const action = useApiKeyAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ApiKey | null>(null);
  const [form, setForm] = useState<{ edit: ApiKey | null } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'rotate' | 'revoke'; k: ApiKey } | null>(null);
  const [secret, setSecret] = useState<{ k: ApiKeyWithSecret; rotated: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** สลับโหมด (ต้นแบบ: ปิด panel + toast) — ตั้งโหมดก่อน render ถัดไปเพื่อให้คำขอใหม่ได้ header ถูก + ล้าง cache ของโหมดเดิม */
  const switchMode = (m: ApiMode, announce = true) => {
    if (m === getApiMode()) return;
    for (const k of MODE_QUERY_KEYS) void qc.cancelQueries({ queryKey: k });
    setApiMode(m);
    // reset = ล้างข้อมูลของโหมดเดิมทันที + ดึงใหม่ (ด้วย header ของโหมดใหม่) เฉพาะที่หน้าจอใช้อยู่
    for (const k of MODE_QUERY_KEYS) void qc.resetQueries({ queryKey: k });
    setMode(m);
    setOpenId(null);
    setSelected(null);
    setFilters(EMPTY);
    if (announce) setToast(t(m === 'test' ? 'akey.toast.toTest' : 'akey.toast.toLive'));
  };
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof ApiKeyFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (k: ApiKey) => {
    setOpenId(k.id);
    setSelected(k);
  };
  const showSecret = (k: ApiKeyWithSecret, rotated: boolean) => {
    setCopied(false);
    setSecret({ k, rotated });
  };
  const menuFor = (r: ApiKey) => [
    { label: t('akey.menu.view'), icon: 'eye', run: () => open(r) },
    ...(canWrite && r.status !== 'revoked'
      ? [
          { label: t('akey.menu.scope'), icon: 'list-checks', run: () => setForm({ edit: r }) },
          ...(r.status !== 'rotating'
            ? [
                {
                  label: t('akey.menu.rotate'),
                  icon: 'refresh-cw',
                  run: () => setDialog({ kind: 'rotate', k: r }),
                },
              ]
            : []),
          {
            label: t('akey.menu.revoke'),
            icon: 'ban',
            run: () => setDialog({ kind: 'revoke', k: r }),
          },
        ]
      : []),
  ];

  const statusOpts = [
    { value: '', label: t('table.all') },
    ...STATUS_TABS.map((s) => ({ value: s, label: t(`akey.st.${s}` as MessageKey) })),
  ];
  const columns: Column<ApiKey>[] = [
    {
      key: 'name',
      label: t('akey.col.name'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <div className="akey-two">
          <span>{r.name}</span>
          <span>{t('akey.nScope', { n: r.scopes.length })}</span>
        </div>
      ),
      csv: (r) => r.name,
    },
    {
      key: 'prefix',
      label: t('akey.col.prefix'),
      width: '1%',
      render: (r) => <span style={cell}>{`${r.prefix}…`}</span>,
      csv: (r) => r.prefix,
    },
    {
      key: 'mode',
      label: t('akey.col.mode'),
      width: '1%',
      render: (r) => <Tag>{fm.mode(r)}</Tag>,
      csv: (r) => fm.mode(r),
    },
    {
      key: 'scope',
      label: t('akey.col.scope'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => <span style={cell}>{fm.scopes(r)}</span>,
      csv: (r) => r.scopes.join(' '),
    },
    {
      key: 'ip',
      label: t('akey.col.ip'),
      width: '1%',
      render: (r) => (
        <span style={{ ...cell, color: r.ipAllowlist.length ? '#101418' : '#59606B' }}>
          {fm.ip(r)}
        </span>
      ),
      csv: (r) => fm.ip(r),
    },
    {
      key: 'createdBy',
      label: t('akey.col.by'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      // INT-076: ผู้สร้างถูกระงับ/ลบ → ป้ายใต้ชื่อ (key ยังทำงาน)
      render: (r) =>
        r.creatorInactive ? (
          <div className="akey-two">
            <span>{fm.by(r)}</span>
            <span style={{ color: '#8F5500' }}>{t('akey.creatorOff')}</span>
          </div>
        ) : (
          <span style={cell}>{fm.by(r)}</span>
        ),
      csv: (r) => fm.by(r),
    },
    {
      key: 'created',
      label: t('akey.col.created'),
      width: '1%',
      render: (r) => <span style={cell}>{fm.date(r.createdAt)}</span>,
      csv: (r) => fm.date(r.createdAt),
    },
    {
      key: 'last',
      label: t('akey.col.last'),
      width: '1%',
      render: (r) => <span style={cell}>{fm.last(r)}</span>,
      csv: (r) => fm.last(r),
    },
    {
      key: 'exp',
      label: t('akey.col.exp'),
      width: '1%',
      render: (r) => (
        <span style={{ ...cell, color: r.status === 'expiring' ? '#8F5500' : '#101418' }}>
          {fm.exp(r)}
        </span>
      ),
      csv: (r) => fm.exp(r),
    },
    {
      key: 'status',
      label: t('akey.col.st'),
      width: '1%',
      filter: { type: 'select', options: statusOpts },
      render: (r) => <StatusDot label={fm.status(r)} />,
      csv: (r) => fm.status(r),
    },
  ];

  const filtered = Object.values(filters).some((v) => v !== '');
  const tabCount = (s: string) =>
    sum ? (s === '' ? sum.all : (sum as unknown as Record<string, number>)[s]) : undefined;
  const shownTotal = listTotal(list, filters, ['status'], tabCount(filters.status));
  const liveCount = sum ? sum.all - sum.revoked : undefined;

  return (
    <>
      <PageHeader
        title={t('page.api.title')}
        sub={t('page.api.sub')}
        actions={
          canWrite &&
          (pageTab === 'hooks' ? (
            <Button variant="primary" icon="plus" onClick={() => setHookForm(true)}>
              {t('whk.add')}
            </Button>
          ) : (
            <Button variant="primary" icon="plus" onClick={() => setForm({ edit: null })}>
              {t('akey.add')}
            </Button>
          ))
        }
      />
      {mode === 'test' && (
        <div className="akey-sbx">
          <span className="akey-sbx__tag">{t('akey.sandbox.tag')}</span>
          <span className="akey-sbx__txt">{t('akey.sandbox.banner')}</span>
        </div>
      )}
      <div className="akey-tabs">
        <div className="akey-tabs__list" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === 'keys'}
            className="akey-tabs__tab"
            onClick={() => switchTab('keys')}
          >
            {t('akey.tab.keys')}
            {liveCount !== undefined && <span className="akey-tabs__n">{liveCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === 'hooks'}
            className="akey-tabs__tab"
            onClick={() => switchTab('hooks')}
          >
            {t('whk.tab')}
            {hookSum.data && <span className="akey-tabs__n">{hookSum.data.all}</span>}
          </button>
        </div>
        <div className="akey-modes" role="group" aria-label={t('akey.f.mode')}>
          {(['live', 'test'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              className={`akey-modes__btn akey-modes__btn--${m}`}
              onClick={() => switchMode(m)}
            >
              {t(m === 'test' ? 'akey.mode.test' : 'akey.mode.live')}
            </button>
          ))}
        </div>
      </div>
      {pageTab === 'hooks' ? (
        <WebhooksTab
          canWrite={canWrite}
          formOpen={hookForm}
          onFormClose={() => setHookForm(false)}
          toast={setToast}
          mode={mode}
          onModeChange={(m) => switchMode(m, false)}
        />
      ) : (
        <>
          <div className="tms-listbody">
            <StatusTabs
              value={filters.status || 'all'}
              onChange={(k) => setF('status', k === 'all' ? '' : k)}
              items={[
                { key: 'all', label: t('akey.tab.all'), ...(sum ? { count: sum.all } : {}) },
                ...STATUS_TABS.map((s) => ({
                  key: s,
                  label: t(`akey.st.${s}` as MessageKey),
                  ...(sum ? { count: tabCount(s) } : {}),
                })),
              ]}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
              <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
                {shownTotal !== undefined && t('table.total', { n: shownTotal })}
              </span>
            </div>
            {list.q.isError ? (
              <EmptyState
                icon="circle-alert"
                title={t('akey.loadError')}
                description={problemText(list.q.error, t) ?? ''}
                action={
                  <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                    {t('akey.retry')}
                  </Button>
                }
              />
            ) : (
              <DataTable
                columns={columns}
                rows={list.rows}
                rowId={(r) => r.id}
                activeId={openId}
                loading={list.loading}
                labels={tableLabels(t)}
                filters={{ ...filters }}
                onFilterChange={(k, v) => setF(k as keyof ApiKeyFilters, v)}
                onRowClick={open}
                // ต้นแบบมีช่องเลือกแถวแต่ไม่มี bulk action ของ key (bulk: []) และ "มุมมอง" ที่บันทึกไว้ยังไม่มีในระบบ
                // → ไม่แสดงทั้งคู่ [DECISION spec/12 §3]
                selectable={false}
                rowMenu={menuFor}
                empty={
                  filtered ? (
                    <EmptyState
                      icon="search-x"
                      title={t('table.emptyTitle')}
                      description={t('table.noMatch')}
                    />
                  ) : (
                    <EmptyState
                      icon="key-round"
                      title={t('akey.emptyTitle')}
                      description={t('akey.emptyDesc')}
                    />
                  )
                }
                page={{ ...list.page, ...(shownTotal !== undefined ? { total: shownTotal } : {}) }}
                onPageSize={list.setSize}
                onNext={list.next}
                onPrev={list.prev}
                onGoto={list.goto}
              />
            )}
          </div>
          {current && (
            <ApiKeyDrawer
              key={current.id}
              k={current}
              canWrite={canWrite}
              onScope={() => setForm({ edit: current })}
              onRotate={() => setDialog({ kind: 'rotate', k: current })}
              onRevoke={() => setDialog({ kind: 'revoke', k: current })}
              onClose={() => {
                setOpenId(null);
                setSelected(null);
              }}
            />
          )}
          <ApiKeyFormDrawer
            open={!!form}
            edit={form?.edit ?? null}
            mode={mode}
            onClose={() => setForm(null)}
            onCreated={(k) => {
              setForm(null);
              // สร้าง key ของอีกโหมด → หน้าสลับไปโหมดนั้น (ต้นแบบ cfKey `apiMode: mode`)
              if (k.mode !== mode) switchMode(k.mode, false);
              showSecret(k, false);
            }}
            onSaved={(k) => {
              setForm(null);
              if (openId === k.id) setSelected(k);
              setToast(t('akey.toast.scope', { n: k.name }));
            }}
          />
          <ReasonDialog
            open={!!dialog}
            title={
              dialog
                ? t(dialog.kind === 'rotate' ? 'akey.rotate.title' : 'akey.revoke.title', {
                    n: dialog.k.name,
                  })
                : ''
            }
            description={
              dialog ? t(dialog.kind === 'rotate' ? 'akey.rotate.desc' : 'akey.revoke.desc') : ''
            }
            {...(dialog
              ? {
                  diff: {
                    labels: [t('ord.dlg.field'), t('ord.dlg.before'), t('ord.dlg.after')],
                    rows:
                      dialog.kind === 'rotate'
                        ? [
                            {
                              f: t('akey.col.prefix'),
                              b: `${dialog.k.prefix}…`,
                              a: t('akey.rotate.new', { mode: `tk_${dialog.k.mode}` }),
                            },
                          ]
                        : [
                            {
                              f: t('akey.dlg.status'),
                              b: fm.status(dialog.k),
                              a: t('akey.st.revoked'),
                            },
                          ],
                  },
                }
              : {})}
            label={t('ord.dlg.reason')}
            placeholder={t('ord.dlg.reasonPh')}
            hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
            okLabel={dialog?.kind === 'rotate' ? t('akey.menu.rotate') : t('akey.revoke.ok')}
            cancelLabel={t('common.cancel')}
            closeLabel={t('drawer.close')}
            busy={action.isPending}
            error={problemText(action.error, t)}
            onClose={() => {
              setDialog(null);
              action.reset();
            }}
            onOk={(reason) => {
              if (!dialog) return;
              const { k, kind } = dialog;
              action.mutate(
                { id: k.id, version: k.version, action: kind, reason },
                {
                  onSuccess: (r) => {
                    setDialog(null);
                    if (kind === 'rotate' && r.secret) {
                      setOpenId(null);
                      setSelected(null);
                      showSecret(r.secret, true);
                    } else {
                      if (openId === k.id) setSelected({ ...k, ...r.key });
                      setToast(t('akey.toast.revoked', { n: k.name }));
                    }
                  },
                },
              );
            }}
          />
          {secret && (
            <SecretDialog
              title={t(secret.rotated ? 'akey.secret.rotated' : 'akey.secret.created')}
              sub={t('akey.secret.sub', {
                n: secret.k.name,
                mode: fm.mode(secret.k),
                scopes: secret.k.scopes.join(', '),
              })}
              warn={t(secret.rotated ? 'akey.secret.warnRotate' : 'akey.secret.warn')}
              value={secret.k.secret}
              copied={copied}
              onCopy={() => {
                void navigator.clipboard?.writeText(secret.k.secret).catch(() => undefined);
                setCopied(true);
                setToast(t('akey.toast.copied'));
              }}
              onClose={() => {
                if (!copied) setToast(t('akey.toast.closed'));
                setSecret(null);
              }}
            />
          )}
        </>
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
