import {
  ActivityTimeline,
  Badge,
  Drawer,
  DrawerFooterButtons,
  EmptyState,
  Icon,
} from '@tms/ui';
import { useState, type ReactNode } from 'react';
import { formatDateTime, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { bangkokToday, money, useDateText } from '../rate-cards/rateFormat';
import { orderSourceText } from './OrderSource';
import { STOP_COLOR } from './OrderFormDrawer';
import { editableOf, toBangkok, totalWeightKg, type Order } from './orderForm';
import { useOrder, useUpdateOrder, useVehicleTypeOptions } from './useOrders';

/** ป้ายสถานะของใบ: ค้าง = เหตุค้าง (ต้นแบบคอลัมน์ "เหตุผล / สถานะ") · อื่น ๆ = ชื่อสถานะไทย */
export function orderStatusLabel(t: T, o: Pick<Order, 'status' | 'holdReason'>): string {
  if (o.status === 'on_hold' && o.holdReason) return o.holdReason.label;
  return t(`ord.st.${o.status}` as MessageKey);
}
export const statusTone = (o: Pick<Order, 'status'>) =>
  o.status === 'on_hold'
    ? ('warn' as const)
    : o.status === 'cancelled' || o.status === 'draft'
      ? ('off' as const)
      : o.status === 'received' || o.status === 'in_transit'
        ? ('info' as const)
        : ('ok' as const);

/** กำหนดส่ง = ปลายช่วงเวลาของจุดส่งสุดท้าย (ไม่มี = วันรับของ) — เวลาไทย */
export function dueOf(o: Order): { date: string; time: string | null } {
  const last = [...o.stops].reverse().find((s) => s.type === 'DELIVERY');
  const iso = last?.windowEnd ?? last?.windowStart;
  if (!iso) return { date: o.requestedDate, time: null };
  return toBangkok(iso);
}

/** เกินกำหนด (วัน) — เฉพาะใบที่ยังไม่ออกรถ */
export function overdueDays(o: Order, today = bangkokToday()): number {
  if (!['received', 'on_hold', 'planned'].includes(o.status)) return 0;
  const d = dueOf(o).date;
  return d < today ? Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000) : 0;
}

function Sec({ title, action, last, children }: { title: ReactNode; action?: ReactNode; last?: boolean; children: ReactNode }) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingBottom: last ? 0 : 20,
        borderBottom: last ? 0 : '1px solid #E4E6E0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3B424C' }}>{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function Kv({ k, v, late }: { k: ReactNode; v: ReactNode; late?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>{k}</span>
      <span
        className="tms-num"
        style={{ color: late ? '#B3322A' : '#101418', fontWeight: 500, overflowWrap: 'anywhere' }}
      >
        {v}
        {late && <span style={{ marginLeft: 8, fontSize: 12.5, fontWeight: 600 }}>{late}</span>}
      </span>
    </div>
  );
}

const grid2 = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
  gap: '14px 20px',
} as const;

/**
 * Drawer ใบสั่งขนส่ง (ST3-T02) — ต้นแบบ TMS v4 vPanel kind 'so' (spec/03 §2 "Drawer SO")
 * หัว: "ใบสั่งขนส่ง" / เลข SO + ป้ายสถานะ / ลูกค้า · PO · ⋯ (แก้ไข · คัดลอกเป็นใบใหม่ · บันทึกเป็นเทมเพลต)
 * แท็บ สรุป · สินค้า · เอกสารแนบ · กิจกรรม · footer ยอดรวม (ต้องมีสิทธิ์ราคาขาย — ORD-049) + ปุ่มตามสถานะ (ร่าง → ยืนยัน SO)
 */
export function OrderDrawer({
  id,
  canWrite,
  canSeePrice,
  onClose,
  onEdit,
  onCopy,
  onSaveTemplate,
  onDone,
}: {
  id: string;
  canWrite: boolean;
  canSeePrice: boolean;
  onClose: () => void;
  onEdit: (o: Order) => void;
  onCopy: (o: Order) => void;
  onSaveTemplate: (o: Order) => void;
  onDone: (msg: string) => void;
}) {
  const { t, lang } = useI18n();
  const dateText = useDateText();
  const q = useOrder(id);
  const vts = useVehicleTypeOptions();
  const confirm = useUpdateOrder();
  const [tab, setTab] = useState('sum');
  const o = q.data;
  const labels = { close: t('drawer.close'), more: t('drawer.more') };

  if (!o)
    return (
      <Drawer open onClose={onClose} kind={t('ord.kind')} title="…" labels={labels}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('ord.loadError')}
            description={problemText(q.error, t) ?? ''}
          />
        ) : (
          <span style={{ color: '#59606B' }}>{t('table.loading')}</span>
        )}
      </Drawer>
    );

  const ed = editableOf(o);
  const vt = vts.data?.data.find((v) => v.id === o.vehicleTypeId);
  const weight = totalWeightKg(o.lines);
  const cbm = totalWeightKg(o.lines.map((l) => ({ weightKg: l.cbm })));
  const due = dueOf(o);
  const late = overdueDays(o);
  const custName = o.customer.legalName ?? o.customer.name ?? o.customer.externalId ?? '—';
  const win = (s: Order['stops'][number]) => {
    const a = s.windowStart ? toBangkok(s.windowStart) : null;
    const b = s.windowEnd ? toBangkok(s.windowEnd) : null;
    if (!a && !b) return t('ord.noWindow');
    const d = dateText((a ?? b)!.date);
    return `${d} ${a?.time ?? ''}${a && b ? '–' : ''}${b ? (a && b.date !== a.date ? `${dateText(b.date)} ${b.time}` : b.time) : ''}`;
  };
  const menu = canWrite
    ? [
        ...(ed.any ? [{ label: t('ord.menu.edit'), icon: 'pencil', onClick: () => onEdit(o) }] : []),
        { label: t('ord.menu.copy'), icon: 'copy', onClick: () => onCopy(o) },
        { label: t('ord.menu.template'), icon: 'bookmark-plus', onClick: () => onSaveTemplate(o) },
      ]
    : [];
  const submit = () =>
    confirm.mutate(
      { id: o.id, version: o.version, body: { draft: false } },
      { onSuccess: (x) => onDone(t('ord.toast.confirmed', { no: x.soNo ?? '' })) },
    );

  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('ord.kind')}
      title={o.soNo ?? t('ord.draftNo')}
      badge={<Badge label={orderStatusLabel(t, o)} tone={statusTone(o)} />}
      subtitle={[custName, o.customerRef].filter(Boolean).join(' · ')}
      menu={menu}
      tabs={[
        { key: 'sum', label: t('ord.tab.sum') },
        { key: 'items', label: t('ord.tab.items') },
        { key: 'docs', label: t('ord.tab.docs') },
        { key: 'act', label: t('ord.tab.act') },
      ]}
      tab={tab}
      onTab={setTab}
      labels={labels}
      footer={
        <>
          {canSeePrice && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('ord.footTotal')}</span>
              <span className="tms-num" style={{ fontSize: 20, fontWeight: 600 }}>
                {o.sellTotal ? `฿${money(o.sellTotal)}` : '—'}
              </span>
            </div>
          )}
          <span style={{ flex: 1 }} />
          {confirm.error && (
            <span className="tms-field-error" role="alert">
              {problemText(confirm.error, t)}
            </span>
          )}
          {canWrite && o.status === 'draft' && (
            <DrawerFooterButtons
              primary={{
                label: t('ord.confirm'),
                icon: 'circle-check',
                onClick: submit,
                disabled: confirm.isPending,
              }}
            />
          )}
        </>
      }
    >
      {tab === 'sum' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {o.status === 'on_hold' && o.holdReason && (
            <div
              role="note"
              style={{ background: '#FCF0DC', borderRadius: 8, padding: '12px 14px', display: 'flex', gap: 8 }}
            >
              <Icon n="triangle-alert" s={16} style={{ color: '#8F5500', marginTop: 3, flexShrink: 0 }} />
              <span>
                {t('ord.hold', { r: o.holdReason.label })}
                {o.holdReason.note ? ` — ${o.holdReason.note}` : ''}
              </span>
            </div>
          )}
          <Sec title={t('ord.sec.job')}>
            <div style={grid2}>
              <Kv k={t('ord.f.customer')} v={custName} />
              <Kv k={t('ord.kv.code')} v={o.customer.code ?? '—'} />
              <Kv k={t('ord.kv.vt')} v={vt?.name ?? (o.vehicleTypeId ? '…' : '—')} />
              <Kv
                k={t('ord.kv.weight')}
                v={`${weight ? t('ord.kg', { n: Number(weight).toLocaleString('th-TH') }) : '—'}${cbm ? ` · ${t('ord.cbm', { n: cbm })}` : ''}`}
              />
              <Kv
                k={t('ord.kv.due')}
                v={`${dateText(due.date)}${due.time ? ` ${due.time}` : ''}`}
                {...(late ? { late: t('ord.late', { n: late }) } : {})}
              />
              <Kv k={t('so.src.col')} v={orderSourceText(t, { source: o.sourceType })} />
            </div>
          </Sec>
          <Sec
            title={t('ord.sec.extra')}
            action={
              canWrite && ed.customerRef ? (
                <button type="button" className="tms-textlink" onClick={() => onEdit(o)}>
                  {t('ord.menu.edit')}
                </button>
              ) : undefined
            }
          >
            <div style={grid2}>
              <Kv k={t('ord.f.po')} v={o.customerRef ?? '—'} />
              {o.externalId && <Kv k={t('ord.kv.ext')} v={o.externalId} />}
            </div>
          </Sec>
          <Sec title={t('ord.sec.stops')}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {o.stops.map((s, i) => {
                const c = STOP_COLOR[s.type] ?? '#2257C4';
                return (
                  <div key={s.sequence} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 12 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <span
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: '50%',
                          background: '#FFFFFF',
                          border: `1.5px solid ${c}`,
                          color: c,
                          fontSize: 12,
                          fontWeight: 600,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {i + 1}
                      </span>
                      {i < o.stops.length - 1 && (
                        <span style={{ flex: 1, width: 1, background: '#CDD1C8', minHeight: 16 }} />
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 14, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: c }}>
                        {t('ord.stopN', { n: i + 1, k: t(`ord.stop.${s.type}` as MessageKey) })}
                      </span>
                      <span style={{ fontWeight: 500 }}>{s.siteText}</span>
                      <span className="tms-num" style={{ color: '#3B424C' }}>{win(s)}</span>
                      {!s.siteId && (
                        <span style={{ display: 'flex', gap: 6, color: '#B3322A', fontWeight: 500 }}>
                          <Icon n="triangle-alert" s={16} style={{ marginTop: 3, flexShrink: 0 }} />
                          {t('ord.siteUnmapped')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Sec>
          <Sec title={t('ord.sec.vehicle')}>
            <span style={{ color: '#3B424C' }}>{t('ord.notAssigned')}</span>
          </Sec>
          <Sec title={t('ord.sec.price')} last>
            {!canSeePrice ? (
              <span style={{ color: '#3B424C' }}>—</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {o.pricingStatus !== 'AVAILABLE' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#8F5500', paddingBottom: 6 }}>
                    <Icon n="triangle-alert" s={16} />
                    <span style={{ flex: 1 }}>{t('ord.noRate')}</span>
                  </div>
                )}
                {(o.sellCharges ?? []).map((c) => (
                  <div key={c.lineNo} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '6px 0' }}>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span>{c.description}</span>
                      {c.rateCardCode && (
                        <span style={{ fontSize: 12.5, color: '#59606B' }}>
                          {t('ord.rateRef', { code: c.rateCardCode, v: c.rateCardRevision ?? 1 })}
                        </span>
                      )}
                    </div>
                    <span className="tms-num">{money(c.sellAmount)}</span>
                  </div>
                ))}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '8px 0 0',
                    borderTop: '1px solid #CDD1C8',
                    marginTop: 4,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{t('ord.subtotal')}</span>
                  <span className="tms-num" style={{ fontWeight: 600 }}>
                    {o.sellTotal ? money(o.sellTotal) : '—'}
                  </span>
                </div>
                <span style={{ fontSize: 12.5, color: '#59606B', paddingTop: 6 }}>{t('ord.vatNote')}</span>
              </div>
            )}
          </Sec>
        </div>
      )}
      {tab === 'items' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) 110px 110px',
              gap: 12,
              padding: '0 0 8px',
              borderBottom: '1px solid #CDD1C8',
              fontSize: 12.5,
              fontWeight: 500,
              color: '#59606B',
            }}
          >
            <span>{t('ord.it.name')}</span>
            <span style={{ textAlign: 'right' }}>{t('ord.it.qty')}</span>
            <span style={{ textAlign: 'right' }}>{t('ord.it.weight')}</span>
          </div>
          {o.lines.map((l) => (
            <div
              key={l.lineNo}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) 110px 110px',
                gap: 12,
                padding: '10px 0',
                borderBottom: '1px solid #E4E6E0',
              }}
            >
              <span>{l.description}</span>
              <span className="tms-num" style={{ textAlign: 'right' }}>
                {`${l.qty} ${l.unit}`}
              </span>
              <span className="tms-num" style={{ textAlign: 'right' }}>
                {l.weightKg ? t('ord.kg', { n: Number(l.weightKg).toLocaleString('th-TH') }) : '—'}
              </span>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 110px', gap: 12, padding: '10px 0' }}>
            <span style={{ fontWeight: 600 }}>{t('ord.it.total')}</span>
            <span className="tms-num" style={{ textAlign: 'right', fontWeight: 600 }}>
              {weight ? t('ord.kg', { n: Number(weight).toLocaleString('th-TH') }) : '—'}
            </span>
          </div>
        </div>
      )}
      {tab === 'docs' && (
        <EmptyState icon="paperclip" title={t('ord.docs.empty')} description={t('ord.docs.desc')} />
      )}
      {tab === 'act' && (
        <ActivityTimeline
          items={[
            ...(o.updatedAt !== o.createdAt
              ? [
                  {
                    key: 'u',
                    title: t('ord.act.updated', { v: o.version }),
                    sub: formatDateTime(o.updatedAt, lang),
                    badge: { label: orderStatusLabel(t, o), tone: statusTone(o), icon: 'pencil' },
                  },
                ]
              : []),
            {
              key: 'c',
              title: t('ord.act.created', { src: orderSourceText(t, { source: o.sourceType }) }),
              sub: formatDateTime(o.createdAt, lang),
              badge: { label: t('ord.act.new'), tone: 'info' as const, icon: 'file-plus' },
            },
          ]}
        />
      )}
    </Drawer>
  );
}

