import { Button, DataTable, EmptyState, StatusDot, StatusTabs, type Column } from '@tms/ui';
import { useState } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { tableLabels } from '../companies/CompanySample';
import { SecretDialog } from '../api-keys/SecretDialog';
import { problemText } from '../master/problems';
import { listTotal } from '../master/useCursorList';
import { useHookFormat } from './format';
import {
  HOOK_TABS,
  useTestWebhook,
  useWebhookAction,
  useWebhookList,
  useWebhookSummary,
  type HookTab,
  type Webhook,
  type WebhookFilters,
} from './useWebhooks';
import { WebhookDrawer } from './WebhookDrawer';
import { WebhookFormDrawer } from './WebhookFormDrawer';
import './webhooks.css';

const EMPTY: WebhookFilters = { status: '', url: '' };
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;

/**
 * แท็บ Webhooks ของหน้า นักพัฒนา / Open API (ST7-T04) — ต้นแบบ TMS v4 specApi('hooks') + cfHook + testHook + togHook + vPanelApi hook
 * ตาราง: Endpoint URL (+ จำนวน event) · Event ที่สมัคร · สถานะ · สำเร็จ 7 วัน · ส่งล่าสุด
 * เมนูแถว: ดูประวัติการส่ง · ส่ง event ทดสอบ · ปิด/เปิดใช้งาน · bulk: ส่ง event ทดสอบ
 */
export function WebhooksTab({
  canWrite,
  formOpen,
  onFormClose,
  toast,
}: {
  canWrite: boolean;
  formOpen: boolean;
  onFormClose: () => void;
  toast: (s: string) => void;
}) {
  const { t } = useI18n();
  const fm = useHookFormat();
  const [filters, setFilters] = useState<WebhookFilters>(EMPTY);
  const list = useWebhookList(filters);
  const summary = useWebhookSummary();
  const action = useWebhookAction();
  const tester = useTestWebhook();
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Webhook | null>(null);
  const [secret, setSecret] = useState<{
    title: string;
    sub: string;
    warn: string;
    value: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const sum = summary.data;

  const setF = (k: keyof WebhookFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const open = (h: Webhook) => {
    setOpenId(h.id);
    setSelected(h);
  };
  const showSecret = (s: { title: string; sub: string; warn: string; value: string }) => {
    setCopied(false);
    setSecret(s);
  };

  /** ต้นแบบ testHook: ปิดอยู่ = แจ้งให้เปิดก่อน · ผล "endpoint ตอบ 200 ใน 140 ms" / "endpoint ตอบ 503" */
  const test = (h: Webhook) => {
    if (fm.off(h)) return toast(t('whk.toast.enableFirst'));
    tester.mutate(h.id, {
      onSuccess: (r) =>
        toast(
          r.delivered
            ? t('whk.toast.testOk', { code: r.status ?? 0, ms: r.durationMs })
            : r.status
              ? t('whk.toast.testCode', { code: r.status })
              : t(r.errorCode === 'timeout' ? 'whk.toast.testTimeout' : 'whk.toast.testFail'),
        ),
      onError: (e) =>
        toast(
          e instanceof ApiError && e.problem.code === 'invalid_state_transition'
            ? t('whk.toast.enableFirst')
            : (problemText(e, t) ?? t('whk.toast.testFail')),
        ),
    });
  };
  const toggle = (h: Webhook) => {
    const on = fm.off(h);
    action.mutate(
      { id: h.id, version: h.version, action: on ? 'enable' : 'disable' },
      {
        onSuccess: (r) => {
          if (openId === h.id) setSelected(r.hook);
          toast(t(on ? 'whk.toast.on' : 'whk.toast.off'));
        },
        onError: (e) => toast(problemText(e, t) ?? ''),
      },
    );
  };
  const rotate = (h: Webhook) =>
    action.mutate(
      { id: h.id, version: h.version, action: 'rotate' },
      {
        onSuccess: (r) => {
          if (openId === h.id) setSelected(r.hook);
          if (r.secret)
            showSecret({
              title: t('whk.secret.rotated'),
              sub: h.url,
              warn: t('whk.secret.warnRotate'),
              value: r.secret,
            });
        },
        onError: (e) => toast(problemText(e, t) ?? ''),
      },
    );

  const menuFor = (r: Webhook) => [
    { label: t('whk.menu.view'), icon: 'eye', run: () => open(r) },
    ...(canWrite
      ? [
          { label: t('whk.menu.test'), icon: 'send', run: () => test(r) },
          {
            label: t(fm.off(r) ? 'whk.menu.on' : 'whk.menu.off'),
            icon: 'power',
            run: () => toggle(r),
          },
        ]
      : []),
  ];

  const statusOpts = [
    { value: '', label: t('table.all') },
    ...HOOK_TABS.map((s) => ({ value: s, label: t(`whk.st.${s}`) })),
  ];
  const columns: Column<Webhook>[] = [
    {
      key: 'url',
      label: t('whk.col.url'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <div className="akey-two">
          <span>{r.url}</span>
          <span>{t('whk.nEvent', { n: r.events.length })}</span>
        </div>
      ),
      csv: (r) => r.url,
    },
    {
      key: 'ev',
      label: t('whk.col.ev'),
      render: (r) => <span style={cell}>{fm.events(r)}</span>,
      csv: (r) => r.events.join(' '),
    },
    {
      key: 'status',
      label: t('akey.col.st'),
      width: '1%',
      filter: { type: 'select', options: statusOpts },
      render: (r) => <StatusDot label={fm.status(r)} />,
      csv: (r) => fm.status(r),
    },
    {
      key: 'ok',
      label: t('whk.col.ok'),
      width: '1%',
      align: 'right',
      render: (r) => {
        const x = fm.rate(r);
        return <span style={{ ...cell, color: x.color }}>{x.text}</span>;
      },
      csv: (r) => fm.rate(r).text,
    },
    {
      key: 'last',
      label: t('whk.col.last'),
      width: '1%',
      render: (r) => <span style={cell}>{fm.last(r)}</span>,
      csv: (r) => fm.last(r),
    },
  ];

  const filtered = Object.values(filters).some((v) => v !== '');
  const tabCount = (s: string) =>
    sum ? (s === '' ? sum.all : (sum as unknown as Record<string, number>)[s]) : undefined;
  const shownTotal = listTotal(list, filters, ['status'], tabCount(filters.status));

  return (
    <>
      <div className="tms-listbody">
        <StatusTabs
          value={filters.status || 'all'}
          onChange={(k) => setF('status', k === 'all' ? '' : k)}
          items={[
            { key: 'all', label: t('akey.tab.all'), ...(sum ? { count: sum.all } : {}) },
            ...HOOK_TABS.map((s: HookTab) => ({
              key: s,
              label: t(`whk.st.${s}`),
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
            title={t('whk.loadError')}
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
            onFilterChange={(k, v) => setF(k as keyof WebhookFilters, v)}
            onRowClick={open}
            selectable={canWrite}
            bulkActions={[
              {
                label: t('whk.menu.test'),
                icon: 'send',
                run: (ids) => list.rows.filter((r) => ids.includes(r.id)).forEach((r) => test(r)),
              },
            ]}
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
                  title={t('whk.emptyTitle')}
                  description={t('whk.emptyDesc')}
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
        <WebhookDrawer
          key={current.id}
          h={current}
          canWrite={canWrite}
          onToggle={() => toggle(current)}
          onRotate={() => rotate(current)}
          onTest={() => test(current)}
          onCopied={() => toast(t('whk.toast.copied'))}
          onClose={() => {
            setOpenId(null);
            setSelected(null);
          }}
        />
      )}
      <WebhookFormDrawer
        open={formOpen}
        onClose={onFormClose}
        onCreated={(h) => {
          onFormClose();
          showSecret({
            title: t('whk.secret.created'),
            sub: t('whk.secret.sub', { url: h.url, n: h.events.length }),
            warn: t('whk.secret.warn'),
            value: h.secret,
          });
        }}
      />
      {secret && (
        <SecretDialog
          title={secret.title}
          sub={secret.sub}
          warn={secret.warn}
          label={t('whk.secret.label')}
          value={secret.value}
          copied={copied}
          onCopy={() => {
            void navigator.clipboard?.writeText(secret.value).catch(() => undefined);
            setCopied(true);
            toast(t('whk.toast.secretCopied'));
          }}
          onClose={() => {
            if (!copied) toast(t('akey.toast.closed'));
            setSecret(null);
          }}
        />
      )}
    </>
  );
}
