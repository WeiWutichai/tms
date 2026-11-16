import {
  Badge,
  Button,
  DataTable,
  DocNo,
  EmptyState,
  RouteChip,
  StatusTabs,
  SummaryStrip,
  Toast,
  type Column,
} from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { bangkokToday, useDateText } from '../rate-cards/rateFormat';
import { HOLD_CODES, RECHECKABLE, actionLabel, holdMeta } from './hold';
import { clearErrorText, useClearedText } from './HoldClear';
import { OrderSourceBadge } from './OrderSource';
import { dueOf, OrderDrawer, overdueDays } from './OrderDrawer';
import { OrderFormDrawer } from './OrderFormDrawer';
import { fromOrder, type Order, type OrderForm } from './orderForm';
import { useHoldList, useOrderSummary, useReevaluate } from './useOrders';

/** ป้ายเหตุค้าง (ข้อความไทยตามต้นแบบ/รายการ ord.hold.*; ไม่มีข้อความ = ชื่อจากรหัสเหตุผล) */
export function holdLabel(t: T, code: string, fallback?: string): string {
  const k = `ord.hold.${code}` as MessageKey;
  return t(k) === k ? (fallback ?? code) : t(k);
}

export function HoldBadge({ code, label }: { code: string; label: string }) {
  const m = holdMeta(code);
  return <Badge label={label} tone={m.tone} icon={m.icon} />;
}

/**
 * เหตุทั้งหมดของใบ: เหตุหลักก่อน แล้วเหตุรองของการรับงานครั้งล่าสุด (ไม่ซ้ำ)
 * ใบที่ต้นทางแก้หลังวางแผน (สถานะยัง PLANNED — ST3-T10) = SOURCE_CHANGED_AFTER_PLAN (PO 16 พ.ย. 2569)
 */
export function holdCodesOf(
  o: Pick<Order, 'holdReason' | 'holdCodes'> & { sourceChangedAfterPlan?: boolean },
): string[] {
  const out = o.sourceChangedAfterPlan ? ['SOURCE_CHANGED_AFTER_PLAN'] : [];
  if (o.holdReason && !out.includes(o.holdReason.code)) out.push(o.holdReason.code);
  for (const c of o.holdCodes) if (!out.includes(c)) out.push(c);
  return out;
}

/** แถบสรุป: เหตุของทางเข้าที่พบบ่อย (ต้นแบบ kpisX('so') สีเตือน #8F5500 / ผิดพลาด #B3322A) */
const KPI: { code: string; color: string }[] = [
  { code: 'CUSTOMER_UNMAPPED', color: '#8F5500' },
  { code: 'LOCATION_UNMAPPED', color: '#8F5500' },
  { code: 'RATE_MISSING', color: '#8F5500' },
  { code: 'SOURCE_ERROR', color: '#B3322A' },
];

/**
 * ปฏิบัติการ → ใบค้าง (ST3-T07; docs/04 C "หน้าใบค้าง + reason code ครบชุด") — ตารางเดียวของ SO ที่ ON_HOLD
 * ต้นแบบไม่มีหน้านี้ ([DECISION — ย้อนได้] spec/12 §3, PO 16 พ.ย. 2569) → ใช้โครงหน้า SO ของต้นแบบ (specSo: หัว + แถบสรุป + แท็บ + ตาราง + drawer SO)
 * ป้ายเหตุผลครบ 12 รหัส + ปุ่มเคลียร์ต่อรหัส (เปิด drawer SO ที่มีกล่อง/ปุ่มเคลียร์ตามเหตุ)
 */
export function HoldPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const me = useMe();
  const dateText = useDateText();
  const scopes = me.data?.scopes ?? [];
  // สิทธิ์ชุดเดียวกับหน้า SO (OrdersPage) — drawer/ฟอร์มทำงานเหมือนกัน
  const canWrite = can(scopes, 'orders:write');
  const canCancel = can(scopes, 'orders:cancel');
  const canSeePrice = can(scopes, 'prices.sell:read');
  const canEditPrice = can(scopes, 'prices.sell:write');
  const canUnlock = can(scopes, 'orders:unlock');
  const [reason, setReason] = useSessionState('hold.reason', '');
  const [col, setCol] = useSessionState('hold.cols', { q: '', source: '' });
  const today = bangkokToday();
  const list = useHoldList({ holdReason: reason, q: col.q, source: col.source });
  const summary = useOrderSummary();
  const s = summary.data;
  const count = (code: string) => s?.holdReasons.find((x) => x.code === code)?.count;
  const recheck = useReevaluate();
  const cleared = useClearedText();
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ key: number; initial: OrderForm; order: Order } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const openEdit = (o: Order) => setForm({ key: Date.now(), initial: fromOrder(o), order: o });
  const reloadEdit = async (id: string) => {
    const o = (await unwrap(api.GET('/v1/orders/{id}', { params: { path: { id } } }))) as Order;
    qc.setQueryData(['orders', 'one', id], o);
    openEdit(o);
  };

  const columns: Column<Order>[] = [
    {
      key: 'q',
      label: t('ord.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => <DocNo>{r.soNo ?? t('ord.draftNo')}</DocNo>,
      csv: (r) => r.soNo ?? '',
    },
    {
      key: 'cust',
      label: t('ord.col.cust'),
      render: (r) => {
        const mapped = !!r.customer.id;
        const n = r.customer.legalName ?? r.customer.name ?? r.customer.externalId ?? '—';
        return (
          <span
            title={n}
            style={{
              color: mapped ? '#101418' : '#8F5500',
              display: 'inline-block',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              verticalAlign: 'bottom',
            }}
          >
            {n}
          </span>
        );
      },
      csv: (r) => r.customer.legalName ?? r.customer.name ?? '',
    },
    {
      key: 'route',
      label: t('ord.col.route'),
      width: '1%',
      render: (r) => {
        const a = r.stops.find((x) => x.type === 'PICKUP') ?? r.stops[0];
        const b =
          [...r.stops].reverse().find((x) => x.type === 'DELIVERY') ?? r.stops[r.stops.length - 1];
        return a && b && a !== b ? (
          <span className="tms-route-cell" title={`${a.siteText} → ${b.siteText}`}>
            <RouteChip
              from={
                <span className="tms-ellipsis" style={{ maxWidth: 72 }}>
                  {a.siteText}
                </span>
              }
              to={
                <span className="tms-ellipsis" style={{ maxWidth: 72 }}>
                  {b.siteText}
                </span>
              }
            />
          </span>
        ) : (
          (a?.siteText ?? '—')
        );
      },
      csv: (r) => r.stops.map((x) => x.siteText).join(' → '),
    },
    {
      key: 'due',
      label: t('ord.col.due'),
      width: '1%',
      render: (r) => {
        const late = overdueDays(r, today) > 0;
        return (
          <span
            className="tms-num"
            style={{ color: late ? '#B3322A' : '#101418', whiteSpace: 'nowrap' }}
          >
            {dateText(dueOf(r).date)}
            {late && <span style={{ marginLeft: 6, fontWeight: 500 }}>{t('ord.over')}</span>}
          </span>
        );
      },
      csv: (r) => dueOf(r).date,
    },
    {
      key: 'reason',
      label: t('hold.col.reason'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...HOLD_CODES.map((c) => ({ value: c, label: holdLabel(t, c) })),
        ],
      },
      render: (r) => (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
          {holdCodesOf(r).map((c) => (
            <HoldBadge
              key={c}
              code={c}
              label={holdLabel(t, c, c === r.holdReason?.code ? r.holdReason.label : undefined)}
            />
          ))}
        </span>
      ),
      csv: (r) =>
        holdCodesOf(r)
          .map((c) => holdLabel(t, c))
          .join(', '),
    },
    {
      key: 'source',
      label: t('so.src.col'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'ERP', label: 'ERP' },
          { value: 'EXCEL', label: t('so.src.IMPORT') },
          { value: 'API', label: t('so.src.API') },
          { value: 'MANUAL', label: t('so.src.MANUAL') },
        ],
      },
      render: (r) => (
        <OrderSourceBadge source={r.sourceType} connector={r.connector} externalId={r.externalId} />
      ),
      csv: (r) => r.source,
    },
    {
      key: 'act',
      label: t('hold.col.action'),
      width: '1%',
      render: (r) => {
        const a = holdMeta(holdCodesOf(r)[0] ?? '').action;
        return (
          <button
            type="button"
            className="tms-textlink"
            style={{ whiteSpace: 'nowrap' }}
            onClick={(e) => {
              e.stopPropagation();
              setOpenId(r.id);
            }}
          >
            {t(actionLabel(canWrite ? a : 'view'))}
          </button>
        );
      },
    },
  ];

  const tabCodes = HOLD_CODES.filter((c) => (count(c) ?? 0) > 0 || c === reason);
  const filtered = !!(col.q || col.source || reason);
  const shownTotal = listTotal(
    list,
    { reason, ...col },
    ['reason'],
    reason ? count(reason) : s?.heldTotal,
  );
  const err = clearErrorText(recheck.error, t);

  return (
    <>
      <PageHeader title={t('page.hold.title')} sub={t('page.hold.sub')} />
      <SummaryStrip
        items={KPI.map((k) => ({
          value: count(k.code) ?? '—',
          label: holdLabel(t, k.code),
          color: k.color,
          onClick: () => setReason((v) => (v === k.code ? '' : k.code)),
          pressed: reason === k.code,
        }))}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={reason || 'all'}
          onChange={(k) => setReason(k === 'all' ? '' : k)}
          items={[
            {
              key: 'all',
              label: t('table.all'),
              ...(s ? { count: s.heldTotal } : {}),
            },
            ...tabCodes.map((c) => ({
              key: c,
              label: holdLabel(t, c),
              ...(count(c) !== undefined ? { count: count(c)! } : {}),
            })),
          ]}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          {err && (
            <span className="tms-field-error" role="alert">
              {err}
            </span>
          )}
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('ord.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('cust.retry')}
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
            selectable={false}
            filters={{ q: col.q, source: col.source, reason }}
            onFilterChange={(k, v) =>
              k === 'reason' ? setReason(v) : setCol((c) => ({ ...c, [k]: v }))
            }
            onRowClick={(r) => setOpenId(r.id)}
            rowMenu={(r) => [
              { label: t('ord.menu.view'), icon: 'eye', run: () => setOpenId(r.id) },
              ...(canWrite && RECHECKABLE.includes(r.holdReason?.code ?? '')
                ? [
                    {
                      label: t('hold.recheck'),
                      icon: 'refresh-cw',
                      run: () =>
                        recheck.mutate(
                          { id: r.id, version: r.version },
                          { onSuccess: (x) => setToast(cleared(x)) },
                        ),
                    },
                  ]
                : []),
            ]}
            empty={
              filtered ? (
                <EmptyState
                  icon="search-x"
                  title={t('table.emptyTitle')}
                  description={t('table.noMatch')}
                />
              ) : (
                <EmptyState
                  icon="circle-check"
                  title={t('hold.emptyTitle')}
                  description={t('hold.emptyDesc')}
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
      {openId && !form && (
        <OrderDrawer
          key={openId}
          id={openId}
          canWrite={canWrite}
          canCancel={canCancel}
          canSeePrice={canSeePrice}
          canEditPrice={canEditPrice}
          canUnlock={canUnlock}
          onClose={() => setOpenId(null)}
          onEdit={openEdit}
          onDone={(m) => setToast(m)}
        />
      )}
      {form && (
        <OrderFormDrawer
          key={form.key}
          mode="edit"
          initial={form.initial}
          order={form.order}
          subtitle={t('ord.kind')}
          canSeePrice={canSeePrice}
          canUnlock={canUnlock}
          onClose={() => setForm(null)}
          onReload={() => void reloadEdit(form.order.id)}
          onSaved={(o) => {
            setForm(null);
            setOpenId(o.id);
            setToast(t('ord.toast.saved', { no: o.soNo ?? t('ord.draftNo') }));
          }}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
