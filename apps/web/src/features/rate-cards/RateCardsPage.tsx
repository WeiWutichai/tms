import {
  Button,
  DataTable,
  EmptyState,
  ReasonDialog,
  RouteChip,
  StatusDot,
  StatusTabs,
  SummaryStrip,
  Tag,
  Toast,
  type Column,
} from '@tms/ui';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { SegSwitch } from '../master/SegSwitch';
import { listTotal, useSessionState } from '../master/useCursorList';
import { RateCardDrawer } from './RateCardDrawer';
import { money, modelLabel, rateStatusLabel, rateUnit, routeText, useDateText } from './rateFormat';
import {
  partyOf,
  priceOf,
  PRICING_MODELS,
  PX,
  useRateAction,
  useRateList,
  useRateOptions,
  useRateSummary,
  type RateCard,
  type RateFilters,
  type RateSide,
} from './useRateCards';
import { ImportExcelButton } from '../imports/ImportExcelButton';

const EMPTY_FILTERS: RateFilters = {
  status: '',
  nearExpiry: '',
  customerId: '',
  carrierId: '',
  party: '',
  route: '',
  vehicleTypeId: '',
  pricingModel: '',
};

type Panel = { mode: 'view'; rate: RateCard } | { mode: 'new'; copyFrom: RateCard | null };
type Dialog =
  { kind: 'approve'; rates: RateCard[] } | { kind: 'cancel' | 'delete'; rates: [RateCard] };

const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;
const two = { display: 'flex', flexDirection: 'column', lineHeight: 1.4 } as const;
const num = (n: number) => n.toLocaleString('th-TH');

/**
 * ข้อมูลหลัก → Rate card (ST2-T13 ขาขาย · ST2-T14 ขาซื้อ) — ต้นแบบ TMS v4 specRate() + kpisX('rate') + vSeg rate + vPanel rate
 * หัว (นำเข้า Excel · คัดลอกจาก rate เดิม) + ปุ่มสลับ ขาขาย/ขาซื้อ + แถบสรุป + แท็บสถานะ + ตาราง + drawer
 * ขาซื้อ: คอลัมน์แรก "ผู้รับเหมา" · ราคา buy* · สิทธิ์ `prices.buy:*` · ตัวกรองแยกต่อฝั่ง (ต้นแบบ tkey rate:{side})
 * "เพิ่ม rate" ไม่มีในต้นแบบ [OPEN spec/12 §3]
 */
export function RateCardsPage() {
  const { t } = useI18n();
  const me = useMe();
  const dateText = useDateText();
  const scopes = me.data?.scopes ?? [];
  const canExport = can(scopes, 'export:run');
  const [params, setParams] = useSearchParams();
  // ลิงก์จากลูกค้า ("ดู rate card" — ต้นแบบ goRate กรองชื่อลูกค้า) / ผู้รับเหมา ("ดู rate ขาซื้อ") / ประเภทรถ
  // → ฝั่ง + ตัวกรองเริ่มต้น แล้วล้าง query
  const [side, setSide] = useSessionState<RateSide>(
    'rate-cards.side',
    params.get('side') === 'buy' ? 'BUY' : 'SELL',
  );
  const [fs, setFs] = useState<Record<RateSide, RateFilters>>(() => {
    const linked: RateFilters = {
      ...EMPTY_FILTERS,
      customerId: params.get('customer') ?? '',
      carrierId: params.get('carrier') ?? '',
      party: params.get('customer') || params.get('carrier') ? (params.get('party') ?? '') : '',
      vehicleTypeId: params.get('vehicleType') ?? '',
    };
    const buyLink = params.get('side') === 'buy';
    return { SELL: buyLink ? EMPTY_FILTERS : linked, BUY: buyLink ? linked : EMPTY_FILTERS };
  });
  useEffect(() => {
    if (params.get('side')) setSide(params.get('side') === 'buy' ? 'BUY' : 'SELL');
    else if ([...params.keys()].length) setSide('SELL');
    if ([...params.keys()].length) setParams({}, { replace: true });
  }, []);
  const f = fs[side];
  const setFilters = (fn: (x: RateFilters) => RateFilters) =>
    setFs((all) => ({ ...all, [side]: fn(all[side]) }));
  const buy = side === 'BUY';
  const canWrite = can(scopes, PX[side].write);
  const canSeePrice = can(scopes, PX[side].read);
  const list = useRateList(f, side);
  const summary = useRateSummary(undefined, side);
  const sellSum = useRateSummary(undefined, 'SELL');
  const buySum = useRateSummary(undefined, 'BUY');
  const action = useRateAction();
  const opts = useRateOptions();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const s = summary.data;
  const openRate = panel?.mode === 'view' ? panel.rate : null;
  const current = openRate ? (list.rows.find((r) => r.id === openRate.id) ?? openRate) : null;

  const setF = (k: keyof RateFilters, v: string) =>
    setFilters((x) => ({
      ...x,
      [k]: v,
      // แก้ตัวกรองชื่อลูกค้า/ผู้รับเหมาเอง = เลิกกรองจากลิงก์
      ...(k === 'party' ? { customerId: '', carrierId: '' } : {}),
    }));
  const setStatus = (status: string, nearExpiry = '') =>
    setFilters((x) => ({ ...x, status, nearExpiry }));
  const open = (r: RateCard) => setPanel({ mode: 'view', rate: r });
  const copy = (r: RateCard) => setPanel({ mode: 'new', copyFrom: r });

  const priceCell = (r: RateCard) =>
    priceOf(r, 'rate') === undefined ? (
      <span style={{ color: '#3B424C' }}>—</span>
    ) : (
      <div style={{ ...two, alignItems: 'flex-end' }}>
        <span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
          {money(priceOf(r, 'rate'))}
        </span>
        <span style={{ color: '#3B424C' }}>
          {t('rc.per', { u: rateUnit(t, r.pricingModel, r.unit?.name) })}
        </span>
      </div>
    );
  const exCell = (r: RateCard) =>
    priceOf(r, 'ex') ? (
      <div style={{ ...two, alignItems: 'flex-end' }}>
        <span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
          {money(priceOf(r, 'ex'))}
        </span>
        <span style={{ color: '#3B424C' }}>{t('rc.exAfter', { n: r.includedStops })}</span>
      </div>
    ) : (
      <span style={{ color: '#3B424C' }}>—</span>
    );

  const statusOpts = [
    { value: '', label: t('table.all') },
    { value: 'active', label: t('rc.st.active') },
    { value: 'draft', label: t('rc.st.draft') },
    { value: 'expired', label: t('rc.st.expired') },
  ];
  const columns: Column<RateCard>[] = [
    {
      key: 'party',
      label: t(buy ? 'rc.col.carrier' : 'rc.col.party'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => (
        <span
          title={partyOf(r)?.name}
          style={{
            ...cell,
            display: 'inline-block',
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            verticalAlign: 'bottom',
          }}
        >
          {partyOf(r)?.name ?? '—'}
        </span>
      ),
      csv: (r) => partyOf(r)?.name ?? '',
    },
    {
      key: 'route',
      label: t('rc.col.route'),
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...opts.routes.map((x) => ({
            value: `${x.origin.id}>${x.destination.id}`,
            label: `${x.origin.name} → ${x.destination.name}`,
          })),
        ],
      },
      render: (r) => (
        <span title={routeText(r)} className="tms-route-cell">
          <RouteChip
            from={<span className="tms-ellipsis">{r.origin.name}</span>}
            to={<span className="tms-ellipsis">{r.destination.name}</span>}
          />
        </span>
      ),
      csv: routeText,
    },
    {
      key: 'vehicleTypeId',
      label: t('rc.col.vt'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...opts.vehicleTypes.map((v) => ({ value: v.id, label: v.name })),
        ],
      },
      render: (r) => <Tag>{r.vehicleType.name}</Tag>,
      csv: (r) => r.vehicleType.name,
    },
    {
      key: 'pricingModel',
      label: t('rc.col.f'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...PRICING_MODELS.map((m) => ({ value: m, label: modelLabel(t, m) })),
        ],
      },
      render: (r) => <Tag>{modelLabel(t, r.pricingModel)}</Tag>,
      csv: (r) => modelLabel(t, r.pricingModel),
    },
    {
      key: 'price',
      label: t('rc.col.price'),
      width: '1%',
      align: 'right',
      render: priceCell,
      csv: (r) => priceOf(r, 'rate') ?? '',
    },
    {
      key: 'ex',
      label: t('rc.col.ex'),
      width: '1%',
      align: 'right',
      render: exCell,
      csv: (r) => priceOf(r, 'ex') ?? '',
    },
    {
      key: 'valid',
      label: t('rc.col.valid'),
      width: '1%',
      render: (r) => (
        <span style={cell}>
          {dateText(r.validFrom)} – {r.validTo ? dateText(r.validTo) : t('rc.noEnd')}
          {r.nearExpiry && r.daysToExpiry !== null && (
            <span style={{ marginLeft: 6, color: '#B3322A', fontWeight: 500 }}>
              {t('rc.daysLeft', { n: r.daysToExpiry })}
            </span>
          )}
        </span>
      ),
      csv: (r) => `${r.validFrom} – ${r.validTo ?? ''}`,
    },
    {
      key: 'status',
      label: t('rc.col.st'),
      width: '1%',
      filter: { type: 'select', options: statusOpts },
      render: (r) => <StatusDot label={rateStatusLabel(t, r.status)} />,
      csv: (r) => rateStatusLabel(t, r.status),
    },
  ];

  const tabKey = f.nearExpiry ? 'all' : f.status || 'all';
  const tabCount =
    f.status === 'active'
      ? s?.active
      : f.status === 'draft'
        ? s?.draft
        : f.status === 'expired'
          ? s?.expired
          : f.status === ''
            ? s?.total
            : undefined;
  const others = [
    'nearExpiry',
    'customerId',
    'carrierId',
    'party',
    'route',
    'vehicleTypeId',
    'pricingModel',
  ];
  const filtered = others.some((k) => f[k as keyof RateFilters] !== '') || f.status !== '';
  const shownTotal = listTotal(list, f, ['status'], tabCount);

  const runAction = (kind: Dialog['kind'], rates: RateCard[], reason: string) => {
    if (kind !== 'approve' || rates.length === 1) {
      const r = rates[0]!;
      return action.mutate(
        { id: r.id, version: r.version, action: kind, reason },
        {
          onSuccess: (u) => {
            setDialog(null);
            if (kind === 'delete') setPanel(null);
            else if (u && panel?.mode === 'view' && panel.rate.id === r.id)
              setPanel({ mode: 'view', rate: u });
            const label = r.revision > 1 ? `${r.code} v${r.revision}` : r.code;
            setToast(
              t(
                kind === 'approve'
                  ? 'rc.toast.approved'
                  : kind === 'cancel'
                    ? 'rc.toast.cancelled'
                    : 'rc.toast.deleted',
                { n: label },
              ),
            );
          },
        },
      );
    }
    // อนุมัติหลายรายการ (ต้นแบบ bulk "อนุมัติ") — ทีละรายการ แจ้งทุกรายการที่ไม่สำเร็จ
    void (async () => {
      const failed: string[] = [];
      for (const r of rates)
        try {
          await action.mutateAsync({ id: r.id, version: r.version, action: 'approve', reason });
        } catch (e) {
          failed.push(`${r.code}${e instanceof ApiError ? ` (${problemText(e, t)})` : ''}`);
        }
      setDialog(null);
      action.reset();
      setToast(
        failed.length
          ? t('rc.toast.approveFail', { n: failed.length, list: failed.join(', ') })
          : t('rc.toast.approvedN', { n: rates.length }),
      );
    })();
  };

  const DLG = {
    approve: { title: 'rc.dlg.approveT', desc: 'rc.dlg.approveD', ok: 'rc.btn.approve' },
    cancel: { title: 'rc.dlg.cancelT', desc: 'rc.dlg.cancelD', ok: 'rc.menu.cancel' },
    delete: { title: 'rc.dlg.deleteT', desc: 'rc.dlg.deleteD', ok: 'rc.menu.delete' },
  } as const;
  const dlgTitle = dialog
    ? dialog.rates.length > 1
      ? t('rc.dlg.approveNT', { n: dialog.rates.length })
      : t(DLG[dialog.kind].title, { n: dialog.rates[0]!.code })
    : '';
  const dlgErr =
    action.error instanceof ApiError && action.error.problem.errors?.[0]?.code === 'in_effect'
      ? t('rc.v.inEffect')
      : problemText(action.error, t);

  return (
    <>
      <PageHeader
        title={t('page.rate.title')}
        sub={t('page.rate.sub')}
        actions={
          <>
            {/* นำเข้า Excel (ST2-T23) — ชนิดตามฝั่งที่เลือก (ขาขาย/ขาซื้อ แยกสิทธิ์ prices.*:write) */}
            <ImportExcelButton
              key={side}
              kind={buy ? 'rate_card_buy' : 'rate_card_sell'}
              label={t('rc.import')}
              onDone={setToast}
            />
            {canWrite && (
              <>
                <Button
                  variant="secondary"
                  icon="copy"
                  title={current ? undefined : t('rc.copyPick')}
                  onClick={() => (current ? copy(current) : setToast(t('rc.copyPick')))}
                >
                  {t('rc.copyFrom')}
                </Button>
                <Button
                  variant="secondary"
                  icon="plus"
                  onClick={() => setPanel({ mode: 'new', copyFrom: null })}
                >
                  {t('rc.add')}
                </Button>
              </>
            )}
          </>
        }
      />
      <SegSwitch
        value={side}
        onChange={(k) => {
          setSide(k);
          setPanel(null);
        }}
        items={[
          { key: 'SELL', label: t('rc.seg.sell'), count: sellSum.data?.total },
          { key: 'BUY', label: t('rc.seg.buy'), count: buySum.data?.total },
        ]}
      />
      <SummaryStrip
        items={[
          { value: s ? num(s.total) : '—', label: t('rc.sum.total'), onClick: () => setStatus('') },
          {
            value: s ? num(s.active) : '—',
            label: t('rc.sum.active'),
            color: '#17733F',
            onClick: () => setStatus('active'),
          },
          {
            value: s ? num(s.nearExpiry) : '—',
            label: t('rc.sum.soon'),
            color: '#8F5500',
            pressed: f.nearExpiry === 'true',
            onClick: () => setStatus('', f.nearExpiry === 'true' ? '' : 'true'),
          },
          {
            value: s ? num(s.draft + s.pendingApproval) : '—',
            label: t('rc.sum.draft'),
            color: '#8F5500',
            onClick: () => setStatus('draft'),
          },
        ]}
      />
      <div className="tms-listbody">
        <StatusTabs
          value={tabKey}
          onChange={(k) => setStatus(k === 'all' ? '' : k)}
          items={[
            { key: 'all', label: t('table.all'), ...(s ? { count: s.total } : {}) },
            { key: 'active', label: t('rc.st.active'), ...(s ? { count: s.active } : {}) },
            {
              key: 'draft',
              label: t('rc.st.draft'),
              ...(s ? { count: s.draft + s.pendingApproval } : {}),
            },
            { key: 'expired', label: t('rc.st.expired'), ...(s ? { count: s.expired } : {}) },
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
            title={t('rc.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('rc.retry')}
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={list.rows}
            rowId={(r) => r.id}
            activeId={current?.id ?? null}
            loading={list.loading}
            labels={tableLabels(t)}
            filters={{
              party: f.party,
              route: f.route,
              vehicleTypeId: f.vehicleTypeId,
              pricingModel: f.pricingModel,
              status: f.status,
            }}
            onFilterChange={(k, v) => setF(k as keyof RateFilters, v)}
            onRowClick={open}
            rowMenu={(r) =>
              canWrite
                ? [
                    { label: t('rc.menu.edit'), icon: 'pencil', run: () => open(r) },
                    ...(r.status === 'draft' || r.status === 'pending_approval'
                      ? [
                          {
                            label: t('rc.menu.approve'),
                            icon: 'circle-check',
                            run: () => setDialog({ kind: 'approve', rates: [r] }),
                          },
                        ]
                      : []),
                    { label: t('rc.menu.copy'), icon: 'copy', run: () => copy(r) },
                  ]
                : [{ label: t('rc.menu.edit'), icon: 'pencil', run: () => open(r) }]
            }
            bulkActions={[
              ...(canWrite
                ? [
                    {
                      label: t('rc.bulk.approve'),
                      icon: 'circle-check',
                      run: (ids: string[]) => {
                        const rates = list.rows.filter(
                          (r) =>
                            ids.includes(r.id) &&
                            (r.status === 'draft' || r.status === 'pending_approval'),
                        );
                        if (!rates.length) return setToast(t('rc.toast.noDraft'));
                        setDialog({ kind: 'approve', rates });
                      },
                    },
                  ]
                : []),
              ...(canExport
                ? [
                    {
                      label: t('rc.bulk.export'),
                      icon: 'download',
                      run: (ids: string[]) =>
                        downloadFile('/v1/rate-cards/export', {
                          format: 'xlsx',
                          side,
                          ids: ids.join(','),
                        }).then(
                          () => setToast(t('rc.toast.exported', { n: ids.length })),
                          () => setToast(t('rc.exportFailed')),
                        ),
                    },
                  ]
                : []),
            ]}
            onExportCsv={
              canExport
                ? () => {
                    const { route, ...rest } = f;
                    const [originId = '', destinationId = ''] = route ? route.split('>') : [];
                    void downloadFile('/v1/rate-cards/export', {
                      format: 'csv',
                      side,
                      ...Object.fromEntries(
                        Object.entries({ ...rest, originId, destinationId }).filter(
                          ([, v]) => v !== '',
                        ),
                      ),
                    }).catch(() => setToast(t('rc.exportFailed')));
                  }
                : false
            }
            empty={
              filtered ? (
                <EmptyState
                  icon="search-x"
                  title={t('table.emptyTitle')}
                  description={t('table.noMatch')}
                />
              ) : (
                <EmptyState
                  icon="tags"
                  title={t(buy ? 'rc.emptyTitleBuy' : 'rc.emptyTitle')}
                  description={t(buy ? 'rc.emptyDescBuy' : 'rc.emptyDesc')}
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
      {panel && (
        <RateCardDrawer
          key={
            panel.mode === 'view' ? `v:${panel.rate.id}` : `n:${side}:${panel.copyFrom?.id ?? ''}`
          }
          side={side}
          rate={panel.mode === 'view' ? current : null}
          copyFrom={panel.mode === 'new' ? panel.copyFrom : null}
          canWrite={canWrite}
          canSeePrice={canSeePrice}
          onSaved={(r, kind) => {
            setPanel({ mode: 'view', rate: r });
            const label = r.revision > 1 ? `${r.code} v${r.revision}` : r.code;
            setToast(
              t(
                kind === 'created'
                  ? 'rc.toast.created'
                  : kind === 'revised'
                    ? 'rc.toast.submitted'
                    : 'rc.toast.saved',
                { n: label },
              ),
            );
          }}
          onApprove={(r) => setDialog({ kind: 'approve', rates: [r] })}
          onCopy={copy}
          onCancelRate={(r) => setDialog({ kind: 'cancel', rates: [r] })}
          onDelete={(r) => setDialog({ kind: 'delete', rates: [r] })}
          onClose={() => setPanel(null)}
        />
      )}
      <ReasonDialog
        open={!!dialog}
        title={dlgTitle}
        description={dialog ? t(DLG[dialog.kind].desc) : ''}
        label={t('rc.dlg.reason')}
        placeholder={t('rc.dlg.reasonPh')}
        okLabel={dialog ? t(DLG[dialog.kind].ok) : ''}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={action.isPending}
        error={dlgErr}
        onClose={() => {
          setDialog(null);
          action.reset();
        }}
        onOk={(reason) => dialog && runAction(dialog.kind, dialog.rates, reason)}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
