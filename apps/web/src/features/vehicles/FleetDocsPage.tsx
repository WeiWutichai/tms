import {
  Button,
  DataTable,
  EmptyState,
  Icon,
  KpiCard,
  StatusTabs,
  Tag,
  Toast,
  type Column,
} from '@tms/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatMoney, useI18n } from '../../i18n';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { downloadFile } from '../master/download';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { docName, RenewDialog, StatusPill, typeLabel, useDocDate } from './VehicleDocsTab';
import { vehPlate } from './useVehicles';
import {
  FDOC_TABS,
  fleetDocQuery,
  useFleetDocList,
  useFleetDocSummary,
  VEHICLE_DOC_TYPES,
  type FleetDocFilters,
  type FleetDocTab,
  type VehicleDoc,
} from './useVehicleDocs';

const EMPTY_FILTERS: FleetDocFilters = { plate: '', docType: '', docNo: '', issuer: '', st: '' };
const num = (n: number) => n.toLocaleString('th-TH');
const cell = { color: '#101418', whiteSpace: 'nowrap' } as const;
const sub = { color: '#3B424C', whiteSpace: 'nowrap' } as const;
const clip = { overflow: 'hidden', textOverflow: 'ellipsis' } as const;
/** ส่งออกแถวที่เลือกได้ครั้งละไม่เกิน (ตรงกับ `ids` ของ API) */
const BULK_MAX = 200;

/**
 * รถ → เอกสารรถ (ST2-T19; docs/04 B2.2 เอกสารรถรวม) — ต้นแบบ TMS v4 specFDoc() + kpisF('fdoc') + actions fdoc + vRnw()
 * ตารางเอกสารฉบับปัจจุบันทุกคัน × ทุกประเภท เรียงวันหมด (GET /v1/vehicle-documents), การ์ด/แท็บ หมดแล้ว · ภายใน 7/30/60 วัน
 * (GET /v1/vehicle-documents/summary), คลิกแถว/เมนู "ต่ออายุ" → modal ต่ออายุเดียวกับโปรไฟล์รถ (POST /v1/vehicle-documents/{id}/renew),
 * ส่งออกให้ฝ่ายธุรการ (GET /v1/vehicle-documents/export) · "อ่านกรมธรรม์ด้วย AI" = นอกเฟส 0 แสดงแต่กดไม่ได้ [OPEN spec/12 §3]
 */
export function FleetDocsPage() {
  const { t } = useI18n();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canWrite = can(scopes, 'master:write');
  const canExport = can(scopes, 'export:run');
  const navigate = useNavigate();
  const dt = useDocDate();
  const [filters, setFilters] = useSessionState<FleetDocFilters>('tms.fdoc.filters', EMPTY_FILTERS);
  const [tab, setTab] = useSessionState<FleetDocTab>('tms.fdoc.tab', 'all');
  const query = fleetDocQuery(tab, filters);
  const list = useFleetDocList(query, 'tms.fdoc.page');
  const summary = useFleetDocSummary();
  const sum = summary.data;
  const [renewing, setRenewing] = useState<VehicleDoc | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const setF = (k: keyof FleetDocFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const vehicle = (d: VehicleDoc) => navigate(`/fleet/vehicles/${d.vehicle.id}?tab=docs`);
  const open = (d: VehicleDoc) => (canWrite ? setRenewing(d) : vehicle(d));

  const columns: Column<VehicleDoc>[] = [
    {
      key: 'plate',
      label: t('fdoc.col.plate'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      // ต้นแบบ cM(ทะเบียน) — ทะเบียนแสดงสีดำหนา 500
      render: (d) => (
        <span className="tms-num" style={{ ...cell, fontWeight: 500 }}>
          {vehPlate(t, d.vehicle)}
        </span>
      ),
    },
    {
      key: 'docType',
      label: t('fdoc.col.type'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...VEHICLE_DOC_TYPES.map((k) => ({ value: k, label: typeLabel(t, k) })),
        ],
      },
      render: (d) => <Tag>{docName(t, d)}</Tag>,
    },
    {
      key: 'docNo',
      label: t('fdoc.col.no'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (d) => (
        <span
          className="tms-num"
          title={d.docNo ?? undefined}
          style={{ ...cell, ...clip, display: 'block', maxWidth: 200 }}
        >
          {d.docNo ?? '—'}
        </span>
      ),
    },
    {
      key: 'issuer',
      label: t('fdoc.col.co'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (d) => (
        <span
          title={d.issuer ?? undefined}
          style={{ ...(d.issuer ? cell : sub), ...clip, display: 'block', maxWidth: 220 }}
        >
          {d.issuer ?? '—'}
        </span>
      ),
    },
    {
      key: 'per',
      label: t('fdoc.col.per'),
      width: '1%',
      render: (d) => (
        <span style={cell}>{t('vdoc.period', { from: dt(d.startsOn), to: dt(d.expiresOn) })}</span>
      ),
    },
    {
      key: 'cost',
      label: t('fdoc.col.cost'),
      width: '1%',
      align: 'right',
      render: (d) => {
        const c = d.costAmount ?? d.premiumAmount;
        return (
          <span className="tms-num" style={c ? cell : sub}>
            {c ? formatMoney(c) : '—'}
          </span>
        );
      },
    },
    {
      key: 'file',
      label: t('fdoc.col.file'),
      render: (d) => {
        const f = d.files[0];
        if (!f) return <span style={sub}>—</span>;
        const name = f.filename ?? f.id;
        return (
          <span className="tms-icocell" style={{ color: '#2257C4' }} title={name}>
            <span className="tms-icocell__i" style={{ background: '#E9F0FA' }}>
              <Icon n="paperclip" s={16} />
            </span>
            {name}
          </span>
        );
      },
    },
    {
      key: 'st',
      label: t('fdoc.col.st'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'expired', label: t('fdoc.st.expired') },
          { value: 'soon', label: t('fdoc.st.soon') },
          { value: 'ok', label: t('fdoc.st.ok') },
        ],
      },
      render: (d) => <StatusPill d={d} t={t} />,
    },
  ];

  const filtered = Object.values(filters).some((v) => v !== '');
  const tabCount = (k: FleetDocTab): number | undefined =>
    !sum
      ? undefined
      : k === 'all'
        ? sum.total
        : k === 'exp'
          ? sum.expired
          : k === 'd7'
            ? sum.within7
            : k === 'd30'
              ? sum.within30
              : sum.within60;
  const shownTotal = listTotal(list, filters, [], tabCount(tab));
  const toggleTab = (k: FleetDocTab) => setTab((x) => (x === k ? 'all' : k));
  const tabLabel = (k: FleetDocTab) =>
    k === 'all' ? t('table.all') : t(`fdoc.kpi.${k}` as 'fdoc.kpi.exp');
  const kpi = (k: Exclude<FleetDocTab, 'all'>, tone: 'err' | 'warn' | 'neutral') => (
    <KpiCard
      key={k}
      label={tabLabel(k)}
      tone={tone}
      value={sum ? num(tabCount(k)!) : '—'}
      sub={tab === k ? t('fdoc.kpi.clear') : t('fdoc.kpi.click')}
      active={tab === k}
      activeLabel={t('fdoc.kpi.on')}
      onClick={() => toggleTab(k)}
    />
  );
  const exportFile = (q: Record<string, string>, done: (n: number | undefined) => string) =>
    downloadFile('/v1/vehicle-documents/export', q).then(
      (n) => setToast(done(n)),
      () => setToast(t('fdoc.exportFailed')),
    );

  return (
    <>
      <PageHeader
        title={t('page.fdoc.title')}
        sub={t('page.fdoc.sub')}
        actions={
          <>
            {/* อ่านเอกสารด้วย AI (OCR) = นอกเฟส 0 — แสดงตามต้นแบบแต่กดไม่ได้ [OPEN spec/12 §3] */}
            <Button variant="secondary" icon="scan-text" disabled title={t('fdoc.ocrSoon')}>
              {t('fdoc.ocr')}
            </Button>
            {canExport && (
              <Button
                variant="secondary"
                icon="file-down"
                onClick={() =>
                  void exportFile({ format: 'xlsx', dueWithinDays: '30' }, () =>
                    t('fdoc.exported30'),
                  )
                }
              >
                {t('fdoc.export')}
              </Button>
            )}
          </>
        }
      />
      <div className="tms-kpis">
        {kpi('exp', 'err')}
        {kpi('d7', 'warn')}
        {kpi('d30', 'warn')}
        {kpi('d60', 'neutral')}
      </div>
      <div className="tms-listbody">
        <StatusTabs
          value={tab}
          onChange={(k) => setTab(k as FleetDocTab)}
          items={FDOC_TABS.map((k) => {
            const n = tabCount(k);
            return { key: k, label: tabLabel(k), ...(n !== undefined ? { count: n } : {}) };
          })}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('fdoc.loadError')}
            description={problemText(list.q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
                {t('fdoc.retry')}
              </Button>
            }
          />
        ) : (
          <DataTable
            // เปลี่ยนแท็บ/ตัวกรอง → ล้างแถวที่เลือก (ไม่ส่งออกแถวที่มองไม่เห็นแล้ว)
            key={JSON.stringify(query)}
            columns={columns}
            // เปลี่ยนแท็บ/ตัวกรอง/หน้า: ไม่แสดงแถวชุดเดิมระหว่างโหลด → "กำลังโหลด…" (QA ST2-T19)
            rows={list.loading ? [] : list.rows}
            selectable={canExport}
            rowId={(d) => d.id}
            activeId={renewing?.id ?? null}
            loading={list.loading}
            labels={tableLabels(t)}
            filters={{ ...filters }}
            onFilterChange={(k, v) => setF(k as keyof FleetDocFilters, v)}
            onRowClick={open}
            rowMenu={(d) => [
              ...(canWrite
                ? [{ label: t('fdoc.menu.renew'), icon: 'refresh-cw', run: () => setRenewing(d) }]
                : []),
              { label: t('fdoc.menu.vehicle'), icon: 'truck', run: () => vehicle(d) },
            ]}
            {...(canExport
              ? {
                  bulkActions: [
                    {
                      label: t('fdoc.export'),
                      icon: 'file-down',
                      run: (ids: string[]) => {
                        // API รับ ids ≤ 200 ต่อครั้ง — เลือกเกินแจ้งให้แบ่งส่งออก
                        if (ids.length > BULK_MAX) {
                          setToast(t('fdoc.bulkMax', { max: BULK_MAX, n: ids.length }));
                          return;
                        }
                        void exportFile({ format: 'xlsx', ids: ids.join(',') }, (n) =>
                          t('fdoc.exportedN', { n: n ?? ids.length }),
                        );
                      },
                    },
                  ],
                }
              : {})}
            onExportCsv={
              canExport && query
                ? () =>
                    void downloadFile('/v1/vehicle-documents/export', {
                      format: 'csv',
                      ...query,
                    }).catch(() => setToast(t('fdoc.exportFailed')))
                : false
            }
            empty={
              filtered || tab !== 'all' ? (
                <EmptyState
                  icon="search-x"
                  title={t('table.emptyTitle')}
                  description={t('table.noMatch')}
                />
              ) : (
                <EmptyState
                  icon="file-badge"
                  title={t('fdoc.emptyTitle')}
                  description={t('fdoc.emptyDesc')}
                />
              )
            }
            page={{
              ...list.page,
              ...(list.loading ? { rowsOnPage: 0 } : {}),
              ...(shownTotal !== undefined ? { total: shownTotal } : {}),
            }}
            onPageSize={list.setSize}
            onNext={list.next}
            onPrev={list.prev}
            onGoto={list.goto}
          />
        )}
      </div>
      {renewing && (
        <RenewDialog
          d={renewing}
          plate={vehPlate(t, renewing.vehicle)}
          onClose={() => setRenewing(null)}
          onDone={(n) => {
            setRenewing(null);
            setToast(
              t('vdoc.rnw.done', {
                t: docName(t, n),
                p: vehPlate(t, n.vehicle),
                d: dt(n.expiresOn),
              }),
            );
          }}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
