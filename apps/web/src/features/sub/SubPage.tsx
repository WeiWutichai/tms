import {
  Button,
  DataTable,
  DocNo,
  EmptyState,
  RouteChip,
  StatusDot,
  StatusTabs,
  SummaryStrip,
  Toast,
  type Column,
} from '@tms/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { PageHeader } from '../../shell/Header';
import { useMe } from '../../shell/AppShell';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import { listTotal, useSessionState } from '../master/useCursorList';
import { money, useDateText, useDateTimeText } from '../rate-cards/rateFormat';
import { margin } from '../trips/subconHire';
import { SavedViewMenu } from '../views/SavedViewMenu';
import { pick, useSavedViews } from '../views/useSavedViews';
import {
  docLabel,
  hoursLeft,
  subQueryStatus,
  subStatusKey,
  SUB_STATUSES,
  SUB_TABS,
  type SubFilter,
  type SubTab,
} from './sub';
import { SubOfferPanel } from './SubOfferPanel';
import {
  currentLink,
  resendLine,
  SUB_KEY,
  useSubOfferList,
  useSubOfferSummary,
  type SubOfferRow,
} from './useSubOffers';

const EMPTY_VIEW = { tab: 'all', no: '', route: '', sub: '', st: '' };
const NOWRAP = { whiteSpace: 'nowrap' } as const;
/** ข้อความสองบรรทัดของต้นแบบ (cW) — ยาวเกินตัด … ไม่ให้ตารางล้นจอ 1440 */
const CLIP = {
  display: 'block',
  maxWidth: 120,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;
const routeOf = (r: SubOfferRow) => `${r.origin ?? '—'} → ${r.destination ?? '—'}`;
/** ป้ายตัวเลือกในตัวกรอง (select) — ตัดยาวไม่ให้ตารางล้นจอ (ค่าที่กรองยังเป็นข้อความเต็ม) */
const short = (x: string, n = 14) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

/**
 * ปฏิบัติการ → จ่ายงานรถร่วม (`/sub` — ต้นแบบ TMS v4 `specSub` + `kpisX('sub')` + vPanel kind 'sub')
 * KPI รอตอบ · รับงานแล้ว · ปฏิเสธ / หมดเวลา · ต้นทุนรถร่วมเดือนนี้ (฿) · แท็บ ทั้งหมด/รอตอบ/รับงาน/ปฏิเสธ/หมดเวลา ·
 * คอลัมน์ เลข SO / DO · เส้นทาง · วันที่ส่ง · ผู้รับเหมา · ราคาซื้อ (฿) · Margin · ส่งข้อเสนอเมื่อ · หมดเวลาใน · สถานะ
 * ความต่างจากต้นแบบ [DECISION — lead 24 พ.ย. 2569 เพื่อ UAT, ย้อนได้ — spec/12 §3 แถว "หน้า /sub"]: ไม่มีปุ่มหัว
 * "ดูหน้ารถร่วมจากลิงก์ LINE" (ลิงก์จริงผูกงาน — คัดลอกจากเมนูแถว) / "ตั้งค่าลำดับ cascade" และ bulk "ส่งต่อผู้รับเหมาถัดไป"
 * (cascade อัตโนมัติ = P1 docs/04 D3 — ส่งต่อทีละงานจากเมนูแถว/drawer) · ไม่มีแถว "ห้ามจ่ายงาน" (กฎตรวจตอนรับงานแล้ว)
 */
export function SubPage() {
  const { t } = useI18n();
  const me = useMe();
  const qc = useQueryClient();
  const scopes = me.data?.scopes ?? [];
  const canAssign = can(scopes, 'trips:assign');
  const canHire = canAssign && can(scopes, 'prices.buy:read');
  const dateText = useDateText();
  const dtText = useDateTimeText();
  const [tab, setTab] = useSessionState<SubFilter>('sub.tab', 'all');
  const [col, setCol] = useSessionState('sub.cols', { no: '', route: '', sub: '', st: '' });
  const [hidden, setHidden] = useSessionState<string[] | null>('sub.hidden', null);
  const views = useSavedViews({
    page: 'subcon-offers',
    state: { tab, ...col },
    hidden,
    empty: EMPTY_VIEW,
    apply: (v) => {
      const x = pick(v.state, EMPTY_VIEW);
      setTab([...SUB_TABS, 'bad'].includes(x.tab) ? (x.tab as SubFilter) : 'all');
      setCol({ no: x.no, route: x.route, sub: x.sub, st: x.st });
      setHidden(v.hidden);
    },
  });
  const [open, setOpenS] = useState<{ id: string; next: boolean } | null>(null);
  const setOpen = (id: string | null, next = false) => setOpenS(id ? { id, next } : null);
  const [toast, setToast] = useState<string | null>(null);
  const kpi = useSubOfferSummary().data;
  const status = subQueryStatus(tab, col.st);
  const list = useSubOfferList(status ? { status } : {}, status !== null);
  const rows = status === null ? [] : list.rows;
  const shown = rows.filter(
    (r) =>
      (!col.no ||
        [...r.deliveryOrderNos, r.tripNo ?? ''].some((x) =>
          x.toLowerCase().includes(col.no.toLowerCase()),
        )) &&
      (!col.route || routeOf(r) === col.route) &&
      (!col.sub || r.carrierName === col.sub),
  );
  const counts: Record<SubTab, number | undefined> = kpi
    ? {
        all: kpi.offered + kpi.accepted + kpi.rejected + kpi.expired,
        OFFERED: kpi.offered,
        ACCEPTED: kpi.accepted,
        REJECTED: kpi.rejected,
        EXPIRED: kpi.expired,
      }
    : {
        all: undefined,
        OFFERED: undefined,
        ACCEPTED: undefined,
        REJECTED: undefined,
        EXPIRED: undefined,
      };
  const statusTotal = status === null ? 0 : !col.st && tab !== 'bad' ? counts[tab] : undefined;
  const shownTotal = listTotal(list, { tab, ...col }, ['tab', 'st'], statusTotal);
  const routes = useMemo(() => [...new Set(rows.map(routeOf))].sort(), [rows]);
  const subs = useMemo(() => [...new Set(rows.map((r) => r.carrierName))].sort(), [rows]);
  const pickTab = (k: SubFilter) => setTab(tab === k ? 'all' : k);
  const reload = () => void qc.invalidateQueries({ queryKey: [SUB_KEY] });

  const copyLink = (r: SubOfferRow) =>
    void currentLink(r.tripId)
      .then(async (l) => {
        if (!l.url) return setToast(t('subl.noLink'));
        await navigator.clipboard.writeText(l.url);
        setToast(t('subl.copied', { no: docLabel(r).no }));
      })
      .catch((e: unknown) => setToast(problemText(e, t) ?? t('subl.noLink')));
  const resend = async (ids: string[]) => {
    const pickRows = shown.filter((r) => ids.includes(r.id) && r.status === 'OFFERED');
    let n = 0;
    for (const r of pickRows) {
      try {
        if (await resendLine(r.tripId)) n++;
      } catch {
        /* รายการที่ส่งไม่ได้ไม่นับ */
      }
    }
    setToast(n ? t('subl.resent', { n }) : t('subl.resendNone'));
    reload();
  };

  const columns: Column<SubOfferRow>[] = [
    {
      key: 'no',
      label: t('subl.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (r) => {
        const d = docLabel(r);
        return (
          <div
            title={[...r.deliveryOrderNos].join(', ') || undefined}
            style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4, ...NOWRAP }}
          >
            <DocNo>{d.no}</DocNo>
            {d.more > 0 && (
              <span style={{ color: '#59606B' }}>{t('subl.more', { n: d.more })}</span>
            )}
          </div>
        );
      },
      csv: (r) => [...r.deliveryOrderNos].join(' ') || (r.tripNo ?? ''),
    },
    {
      key: 'route',
      label: t('subl.col.route'),
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...routes.map((x) => ({ value: x, label: short(x) })),
        ],
      },
      render: (r) => (
        <span className="tms-route-cell" title={routeOf(r)}>
          <RouteChip
            from={
              <span className="tms-ellipsis" style={{ maxWidth: 48 }}>
                {r.origin ?? '—'}
              </span>
            }
            to={
              <span className="tms-ellipsis" style={{ maxWidth: 48 }}>
                {r.destination ?? '—'}
              </span>
            }
          />
        </span>
      ),
      csv: routeOf,
    },
    {
      key: 'date',
      label: t('subl.col.date'),
      width: '1%',
      render: (r) => <span style={NOWRAP}>{dateText(r.tripDate)}</span>,
      csv: (r) => r.tripDate,
    },
    {
      key: 'sub',
      label: t('subl.col.sub'),
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...subs.map((x) => ({ value: x, label: short(x) })),
        ],
      },
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
          <span title={r.carrierName} style={{ ...CLIP, color: '#101418' }}>
            {r.carrierName}
          </span>
          {r.status === 'ACCEPTED' && (
            <span style={{ ...CLIP, color: '#3B424C' }}>
              {[r.acceptedPlate, r.acceptedDriverName].filter(Boolean).join(' · ') || '—'}
            </span>
          )}
        </div>
      ),
      csv: (r) => r.carrierName,
    },
    {
      key: 'buy',
      label: t('subl.col.buy'),
      align: 'right',
      width: '1%',
      render: (r) => <span className="tms-num">{money(r.buyAmount)}</span>,
      csv: (r) => r.buyAmount ?? '',
    },
    {
      key: 'm',
      label: t('subl.col.m'),
      align: 'right',
      width: '1%',
      render: (r) => {
        const m = margin(r.sellAmount, r.buyAmount ?? null);
        return m ? (
          <span style={{ color: Number(m.pct) >= 15 ? '#17733F' : '#8F5500', ...NOWRAP }}>
            {m.pct}%
          </span>
        ) : (
          <span style={{ color: '#3B424C' }}>—</span>
        );
      },
      csv: (r) => margin(r.sellAmount, r.buyAmount ?? null)?.pct ?? '',
    },
    {
      key: 'sent',
      label: t('subl.col.sent'),
      width: '1%',
      // วันที่/เวลาสองบรรทัด (รูปแบบ cW ของต้นแบบ) — ให้ครบ 9 คอลัมน์ในจอ 1440 ไม่ต้องเลื่อน (review M2)
      render: (r) => {
        const v = dtText(r.offeredAt);
        const i = v.lastIndexOf(' ');
        return (
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4, ...NOWRAP }}>
            <span>{i > 0 ? v.slice(0, i) : v}</span>
            {i > 0 && <span style={{ color: '#3B424C' }}>{v.slice(i + 1)}</span>}
          </div>
        );
      },
      csv: (r) => r.offeredAt,
    },
    {
      key: 'exp',
      label: t('subl.col.exp'),
      width: '1%',
      render: (r) => {
        const left = r.status === 'OFFERED' ? hoursLeft(r.expiresAt) : null;
        if (!left) return <span style={{ color: '#3B424C' }}>—</span>;
        const warn = left.unit === 'm' || left.n <= 12;
        return (
          <span style={{ color: warn ? '#8F5500' : '#101418', ...NOWRAP }}>
            {t(left.unit === 'h' ? 'subl.leftH' : 'subl.leftM', { n: left.n })}
          </span>
        );
      },
      csv: (r) => r.expiresAt ?? '',
    },
    {
      key: 'st',
      label: t('subl.col.st'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          ...SUB_STATUSES.map((v) => ({ value: v, label: t(subStatusKey(v)) })),
        ],
      },
      render: (r) => <StatusDot label={t(subStatusKey(r.status))} />,
      csv: (r) => t(subStatusKey(r.status)),
    },
  ];

  return (
    <>
      <PageHeader title={t('page.sub.title')} sub={t('page.sub.sub')} />
      {/* ต้นแบบ kpisX('sub') = แถบสรุปแบบย่อ (เหมือนหน้า do/cust/veh/rate) — ตัวเลขสีตามต้นแบบ · คลิกกรองตาราง */}
      <SummaryStrip
        items={[
          {
            value: kpi?.offered ?? '—',
            label: t('subl.kpi.offered'),
            color: '#8F5500',
            pressed: tab === 'OFFERED',
            onClick: () => pickTab('OFFERED'),
          },
          {
            value: kpi?.accepted ?? '—',
            label: t('subl.kpi.accepted'),
            color: '#17733F',
            pressed: tab === 'ACCEPTED',
            onClick: () => pickTab('ACCEPTED'),
          },
          {
            value: kpi ? kpi.rejected + kpi.expired : '—',
            label: t('subl.kpi.bad'),
            color: '#B3322A',
            pressed: tab === 'bad',
            onClick: () => pickTab('bad'),
          },
          {
            value: kpi?.buyAcceptedThisMonth !== undefined ? money(kpi.buyAcceptedThisMonth) : '—',
            label: t('subl.kpi.cost'),
          },
        ]}
      />

      <div className="tms-listbody">
        <StatusTabs
          value={tab === 'bad' ? '' : tab}
          onChange={(k) => {
            setTab(k as SubTab);
            setCol((c) => ({ ...c, st: '' }));
          }}
          items={SUB_TABS.map((k) => ({
            key: k,
            label: k === 'all' ? t('table.all') : t(`subl.tab.${k}` as MessageKey),
            ...(counts[k] !== undefined ? { count: counts[k]! } : {}),
          }))}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <SavedViewMenu b={views} onToast={setToast} />
          <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
            {shownTotal !== undefined && t('table.total', { n: shownTotal })}
          </span>
        </div>
        {list.q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('subl.loadError')}
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
            rows={shown}
            rowId={(r) => r.id}
            activeId={open ? (shown.find((r) => r.tripId === open.id)?.id ?? null) : null}
            loading={list.loading}
            labels={tableLabels(t)}
            bulkActions={
              canAssign
                ? [{ label: t('subl.bulk.resend'), icon: 'send', run: (ids) => void resend(ids) }]
                : []
            }
            filters={col}
            hiddenColumns={hidden}
            onHiddenColumnsChange={setHidden}
            onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
            onRowClick={(r) => setOpen(r.tripId)}
            rowMenu={(r) => [
              { label: t('subl.menu.open'), icon: 'eye', run: () => setOpen(r.tripId) },
              ...(canHire && (r.status === 'REJECTED' || r.status === 'EXPIRED')
                ? [
                    {
                      label: t('subl.menu.next'),
                      icon: 'forward',
                      run: () => setOpen(r.tripId, true),
                    },
                  ]
                : []),
              ...(canAssign && (r.status === 'OFFERED' || r.status === 'ACCEPTED')
                ? [{ label: t('subl.menu.copy'), icon: 'link', run: () => copyLink(r) }]
                : []),
            ]}
            empty={
              <EmptyState
                icon="handshake"
                title={t('subl.emptyTitle')}
                description={t('subl.emptyDesc')}
              />
            }
            page={{
              ...list.page,
              ...(shownTotal !== undefined ? { total: shownTotal } : {}),
            }}
            onPageSize={list.setSize}
            onNext={list.next}
            onPrev={list.prev}
            onGoto={list.goto}
          />
        )}
      </div>
      {open && (
        <SubOfferPanel
          key={open.id}
          tripId={open.id}
          next={open.next}
          onClose={() => {
            setOpen(null);
            reload();
          }}
          onDone={(m) => {
            setToast(m);
            reload();
          }}
        />
      )}
      {toast && (
        <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
      )}
    </>
  );
}
