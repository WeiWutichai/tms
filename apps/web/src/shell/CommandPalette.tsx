import type { Schemas } from '@tms/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Icon, useEscapeLayer, useModalFocus } from '@tms/ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, unwrap } from '../api';
import { invoiceDisplayStatus } from '../features/billing/billing';
import { billingNoteStatusLabel } from '../features/billing/BillingNoteDrawer';
import { invoiceStatusLabel } from '../features/billing/InvoiceDrawer';
import { problemText } from '../features/master/problems';
import { useI18n, type T } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { can, canAny, navFor, permOf } from '../nav';

export type SearchHit = Schemas['SearchHitDto'];

/** ไอคอนของหน้าตามรายการหน้าใน vCmd() ของต้นแบบ TMS v4 (ลำดับเดียวกัน) — หน้าที่ต้นแบบไม่มีต่อท้าย ใช้ไอคอนกลุ่มเมนู */
const PAGE_ICON: [string, string][] = [
  ['dash', 'layout-dashboard'],
  ['plan', 'calendar-range'],
  ['fveh', 'truck'],
  ['fdoc', 'file-badge'],
  ['so', 'clipboard-list'],
  ['bill', 'receipt'],
  ['settle', 'wallet'],
  ['pay', 'banknote'],
  ['trips', 'route'],
  ['report', 'chart-column'],
  ['do', 'package'],
  ['sub', 'handshake'],
  ['cust', 'building-2'],
  ['veh', 'truck'],
  ['rate', 'tags'],
  ['settings', 'settings'],
  ['exc', 'siren'],
  ['api', 'code-xml'],
  ['loc', 'map-pin'],
  ['prod', 'package'],
  ['vtype', 'truck'],
  ['accsr', 'receipt'],
  ['ds', 'palette'],
];
/** ไอคอนเอกสารตามต้นแบบ: SO file-text · ใบแจ้งหนี้ receipt · DO (dno) map-pin */
const DOC_ICON: Record<string, string> = {
  order: 'file-text',
  deliveryOrder: 'map-pin',
  trip: 'route',
  invoice: 'receipt',
  billingNote: 'receipt',
};
const DOC_TYPES = ['order', 'deliveryOrder', 'trip', 'invoice', 'billingNote'];

/** อันดับความตรง (ตรงทั้งคำ → ขึ้นต้น → มีอยู่) — ใช้เรียงเอกสารหลายชนิดรวมกันในกลุ่ม "เอกสาร" */
export function rankOf(h: SearchHit, q: string): number {
  const n = q.toLowerCase();
  let best = 9;
  for (const v of [h.label, h.customerRef]) {
    if (!v) continue;
    const x = v.toLowerCase();
    best = Math.min(best, x === n ? 0 : x.startsWith(n) ? 1 : x.includes(n) ? 2 : 9);
  }
  return best;
}

/** ปลายทางของผลค้นหา — หน้า/drawer ที่มีอยู่แล้ว (deep link) · DO ที่อยู่ในเที่ยว → drawer เที่ยว (ต้นแบบ open('track','trip')) */
export function hitPath(h: SearchHit, scopes: readonly string[]): string {
  switch (h.type) {
    case 'order':
      return `/so?open=${h.id}`;
    case 'deliveryOrder':
      return h.tripId && can(scopes, 'trips:read')
        ? `/plan?trip=${h.tripId}`
        : `/so?open=${h.orderId}`;
    case 'trip':
      return `/plan?trip=${h.id}`;
    case 'invoice':
      return `/bill?invoice=${h.id}`;
    case 'billingNote':
      return `/bill?bn=${h.id}`;
    case 'customer':
      return `/master/customers?open=${h.id}`;
    case 'vehicle':
      return `/fleet/vehicles/${h.id}`;
  }
}

/** บรรทัดรอง (ขวา) — ตามต้นแบบ: เอกสาร "ลูกค้า · สถานะ" · รถ "ประเภท · คนขับ" · ลูกค้า "ลูกค้า" · เจอจากเลข PO = "เลข PO ลูกค้า: …" */
export function hitSub(h: SearchHit, t: T): string {
  const st = (k: string) => (t(k as MessageKey) === k ? (h.status ?? '') : t(k as MessageKey));
  const po = h.matchedOn === 'po' && h.customerRef ? `${t('ord.f.po')}: ${h.customerRef}` : null;
  switch (h.type) {
    case 'order':
      return [h.customerName, po ?? st(`ord.st.${h.status}`)].filter(Boolean).join(' · ');
    case 'deliveryOrder':
      return [h.customerName, po ?? st(`do.st.${h.status}`)].filter(Boolean).join(' · ');
    case 'trip':
      return [h.plate, st(`trip.st.${h.status}`)].filter(Boolean).join(' · ');
    case 'invoice':
      return [
        h.customerName,
        po ??
          invoiceStatusLabel(
            t,
            invoiceDisplayStatus({ status: h.status ?? '', overdue: h.overdue }),
          ),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'billingNote':
      return [h.customerName, billingNoteStatusLabel(t, h.status ?? '')]
        .filter(Boolean)
        .join(' · ');
    case 'vehicle':
      return [h.vehicleType, h.driverName ?? t('cmdk.noDriver')].filter(Boolean).join(' · ');
    case 'customer':
      return t('cmdk.sub.cust');
  }
}

interface Item {
  key: string;
  l: string;
  sub: string;
  i: string;
  mono?: boolean;
  run: () => void;
}

/** ค้นหาผ่าน API เดียวกับลูกค้า (`GET /v1/search`) — หน่วง 200 ms หลังหยุดพิมพ์ · ≥ 2 ตัวอักษร */
function useSearch(q: string) {
  const [dq, setDq] = useState(q);
  useEffect(() => {
    const id = setTimeout(() => setDq(q), 200);
    return () => clearTimeout(id);
  }, [q]);
  const enabled = dq.length >= 2;
  const r = useQuery({
    queryKey: ['search', dq],
    enabled,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    queryFn: () => unwrap(api.GET('/v1/search', { params: { query: { q: dq, limit: 6 } } })),
  });
  return { ...r, enabled, settled: enabled && dq === q && !r.isFetching };
}

/**
 * ค้นหา ⌘K (ST9-T09) — markup/ค่าจาก `<sc-if value="{{ K.open }}">` + vCmd() ของต้นแบบ TMS v4
 * กลุ่มตามต้นแบบ: คำสั่ง · หน้า · เอกสาร · ลูกค้า · รถ (ต่างจากต้นแบบ: spec/12 §3 แถว ST9-T09)
 */
export function CommandPalette({
  open,
  onClose,
  scopes,
}: {
  open: boolean;
  onClose: () => void;
  scopes: readonly string[];
}) {
  if (!open) return null;
  return <Palette onClose={onClose} scopes={scopes} />;
}

function Palette({ onClose, scopes }: { onClose: () => void; scopes: readonly string[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [raw, setRaw] = useState('');
  const [qi, setQi] = useState(0);
  const q = raw.trim();
  const ql = q.toLowerCase();
  const search = useSearch(q);
  useEscapeLayer(true, onClose);
  useModalFocus(true, box);
  const input = useRef<HTMLInputElement>(null);
  // ต้นแบบ componentDidUpdate: เปิดแล้ว focus ช่องค้นหาหลัง 30 ms (เผื่อคีย์ลัดเปิดระหว่างที่ element อื่นถือ focus)
  useEffect(() => {
    const id = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(id);
  }, []);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  const groups = useMemo(() => {
    const m = (it: Item) => !ql || `${it.l} ${it.sub}`.toLowerCase().includes(ql);
    const cmds: Item[] = [
      ...(can(scopes, 'orders:write')
        ? [
            {
              key: 'c:so',
              l: t('cmdk.cmd.newSo'),
              sub: t('cmdk.sub.cmd'),
              i: 'plus',
              run: () => go('/so?new=1'),
            },
          ]
        : []),
      ...(canAny(scopes, permOf('/bill'))
        ? [
            {
              key: 'c:bill',
              l: t('cmdk.cmd.newBill'),
              sub: t('cmdk.sub.cmd'),
              i: 'receipt',
              run: () => go('/bill'),
            },
          ]
        : []),
    ];
    const order = new Map(PAGE_ICON.map(([k], i) => [k, i]));
    const pages: Item[] = navFor(scopes)
      .filter((g) => g.key !== 'fav')
      .flatMap((g) =>
        g.kids
          ? g.kids.map((k) => ({ page: k.page, label: k.label, path: k.path, icon: g.icon }))
          : g.path && g.page
            ? [{ page: g.page, label: g.label, path: g.path, icon: g.icon }]
            : [],
      )
      .sort((a, b) => (order.get(a.page) ?? 99) - (order.get(b.page) ?? 99))
      .map((p) => ({
        key: `p:${p.path}`,
        l: t(p.label),
        sub: t('cmdk.sub.page'),
        i: PAGE_ICON.find(([k]) => k === p.page)?.[1] ?? p.icon,
        run: () => go(p.path),
      }));
    const hits = search.enabled && q.length >= 2 ? (search.data?.data ?? []) : [];
    const toItem = (h: SearchHit, i: string, mono: boolean): Item => ({
      key: `${h.type}:${h.id}`,
      l: h.label ?? t('ord.draftNo'),
      sub: hitSub(h, t),
      i,
      mono,
      run: () => go(hitPath(h, scopes)),
    });
    const docs = hits
      .filter((h) => DOC_TYPES.includes(h.type))
      .map((h, i) => ({ h, i, r: rankOf(h, q) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map(({ h }) => toItem(h, DOC_ICON[h.type]!, true));
    const custs = hits
      .filter((h) => h.type === 'customer')
      .map((h) => toItem(h, 'building-2', false));
    const vehs = hits.filter((h) => h.type === 'vehicle').map((h) => toItem(h, 'truck', true));
    const G: [MessageKey, Item[], number][] = [
      ['cmdk.g.cmd', cmds.filter(m), 4],
      ['cmdk.g.page', pages.filter(m), q ? 5 : 4],
      ['cmdk.g.doc', docs, q ? 6 : 3],
      ['cmdk.g.cust', custs, q ? 4 : 0],
      ['cmdk.g.veh', vehs, q ? 4 : 0],
    ];
    return G.map(([k, list, lim]) => ({ k, t: t(k), items: list.slice(0, lim) })).filter(
      (g) => g.items.length,
    );
    // go/navigate คงที่ต่อการเปิด palette
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopes, t, ql, q, search.data, search.enabled]);

  const flat = groups.flatMap((g) => g.items);
  const cur = Math.min(qi, Math.max(0, flat.length - 1));
  const err = search.isError && q.length >= 2 ? problemText(search.error, t) : null;
  // ว่างจริงเมื่อผลของคำค้นนี้กลับมาแล้วเท่านั้น (กันกระพริบ "ไม่พบผลลัพธ์" ระหว่างพิมพ์)
  const empty = flat.length === 0 && (q.length < 2 || search.settled || !!err);
  const optId = (i: number) => `${listId}-o${i}`;

  // เลื่อนแถวที่เลือกให้อยู่ในกรอบ
  useEffect(() => {
    document.getElementById(optId(cur))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setQi(Math.min(flat.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setQi(Math.max(0, cur - 1));
    } else if (e.key === 'Enter' && flat[cur]) {
      e.preventDefault();
      flat[cur].run();
    }
  };

  let idx = 0;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(10,23,52,.32)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '12vh',
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.search')}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640,
          maxWidth: 'calc(100% - 32px)',
          background: '#FFFFFF',
          border: '1px solid #D9DCD4',
          borderRadius: 20,
          boxShadow: '0 18px 44px rgba(10,23,52,.10)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 16px',
            borderBottom: '1px solid #E4E6E0',
          }}
        >
          <Icon n="search" s={18} style={{ color: '#59606B' }} />
          <input
            ref={input}
            autoFocus
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setQi(0);
            }}
            onKeyDown={onKey}
            placeholder={t('cmdk.ph')}
            role="combobox"
            aria-label={t('cmdk.ph')}
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? optId(cur) : undefined}
            maxLength={64}
            style={{
              flex: 1,
              height: 40,
              border: 0,
              outline: 'none',
              color: '#101418',
              background: 'transparent',
              font: 'inherit',
              fontSize: 16,
            }}
          />
          <span
            style={{
              fontVariantNumeric: 'tabular-nums',
              fontSize: 12,
              border: '1px solid #D9DCD4',
              borderRadius: 4,
              padding: '0 6px',
              color: '#3B424C',
              background: '#EBEDE8',
            }}
          >
            Esc
          </span>
        </div>
        {/* แท็บโหมดของต้นแบบ — "ถาม AI" อยู่นอกเฟส 0 (spec/08) จึงเหลือ "ค้นหา" แท็บเดียว */}
        <div
          style={{
            display: 'flex',
            gap: 20,
            padding: '0 16px',
            borderBottom: '1px solid #E4E6E0',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 40,
              marginBottom: -1,
              borderBottom: '2px solid #2257C4',
              color: '#2257C4',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              boxSizing: 'border-box',
            }}
          >
            {t('cmdk.tab.find')}
          </span>
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label={t('shell.search')}
          style={{ maxHeight: 420, overflowY: 'auto', padding: '6px 8px' }}
        >
          {groups.map((g) => (
            <div
              key={g.k}
              role="group"
              aria-labelledby={`${listId}-${g.k}`}
              style={{ display: 'flex', flexDirection: 'column', padding: '4px 0' }}
            >
              <div
                id={`${listId}-${g.k}`}
                role="presentation"
                style={{ padding: '6px 10px', fontSize: 12.5, fontWeight: 500, color: '#3B424C' }}
              >
                {g.t}
              </div>
              {g.items.map((it) => {
                const my = idx++;
                const act = my === cur;
                return (
                  <div
                    key={it.key}
                    id={optId(my)}
                    role="option"
                    aria-selected={act}
                    onClick={it.run}
                    onMouseEnter={() => my !== cur && setQi(my)}
                    style={{
                      height: 40,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '0 10px',
                      border: 0,
                      borderRadius: 999,
                      background: act ? '#EEF0EC' : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      width: '100%',
                      boxSizing: 'border-box',
                      color: '#101418',
                      flexShrink: 0,
                    }}
                  >
                    <Icon n={it.i} s={16} style={{ color: '#59606B', flexShrink: 0 }} />
                    <span
                      className={it.mono ? 'tms-num' : undefined}
                      style={{ fontSize: it.mono ? 13 : 14, whiteSpace: 'nowrap' }}
                    >
                      {it.l}
                    </span>
                    <span
                      style={{
                        color: '#3B424C',
                        marginLeft: 'auto',
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: 320,
                      }}
                    >
                      {it.sub}
                    </span>
                    {act && (
                      <Icon
                        n="corner-down-left"
                        s={14}
                        style={{ color: '#59606B', flexShrink: 0 }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {empty && (
            <div
              role="status"
              style={{
                padding: '32px 16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                textAlign: 'center',
              }}
            >
              <Icon n="search-x" s={40} style={{ color: '#C9CDC3' }} />
              <span style={{ fontWeight: 600 }}>{err ?? t('cmdk.empty.t')}</span>
              {!err && <span style={{ color: '#3B424C' }}>{t('cmdk.empty.d')}</span>}
            </div>
          )}
        </div>
        <div
          aria-hidden="true"
          style={{
            height: 40,
            borderTop: '1px solid #D9DCD4',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 16px',
            fontSize: 12,
            color: '#3B424C',
          }}
        >
          <span>{t('cmdk.k.move')}</span>
          <span>{t('cmdk.k.open')}</span>
          <span>{t('cmdk.k.close')}</span>
        </div>
      </div>
    </div>
  );
}
