import { Badge, Button, Drawer, DrawerFooterButtons, EmptyState, Icon, statusOf } from '@tms/ui';
import { useState, type CSSProperties } from 'react';
import { formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { ApiError } from '../../api';
import { problemText } from '../master/problems';
import { money, useDateText } from '../rate-cards/rateFormat';
import { useMessageChannels, useSendLink, type ChannelKey } from '../carriers/useLinkMessages';
import {
  amountRows,
  canApproveStatus,
  canPayStatus,
  canPrintStatus,
  canRelinkStatus,
  statusLabel,
  statusTone,
} from './settle';
import {
  openVoucherPdf,
  useSettlement,
  type Settlement,
  type SettlementLink,
} from './useSettlements';

const SEC: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingBottom: 20,
  borderBottom: '1px solid #E4E6E0',
};
const SEC_T: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: '#3B424C' };
const ITEM: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0,1fr) auto',
  gap: 12,
  alignItems: 'baseline',
  padding: '8px 0',
  borderBottom: '1px solid #EBEDE8',
};
const chName = (c: ChannelKey) => (c === 'line' ? 'LINE' : 'SMS');

function Step({ title, state, at }: { title: string; state: 'done' | string; at?: string }) {
  const done = state === 'done';
  const b = statusOf(state);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 12px',
        background: '#F4F5F2',
        border: '1px solid #E4E6E0',
        borderRadius: 12,
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: '#FFFFFF',
          border: '1px solid #D9DCD4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: done ? '#2257C4' : '#59606B',
        }}
      >
        <Icon n={done ? 'circle-check' : b.icon} s={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <span style={{ fontWeight: 500 }}>{title}</span>
          {done ? (
            <Icon n="check" s={18} style={{ color: '#2257C4' }} />
          ) : (
            <Badge label={state} tone={b.tone} icon={b.icon} />
          )}
        </div>
        {at && <span style={{ fontSize: 12, color: '#3B424C' }}>{at}</span>}
      </div>
    </div>
  );
}

/**
 * กล่องลิงก์ที่เพิ่งออก (D-63 "ออกลิงก์ใหม่" — ต้นแบบไม่มี; ใช้กล่องลิงก์ + ปุ่มคัดลอก/ส่ง LINE/SMS ชุดเดียวกับแท็บเอกสารแนบของผู้รับเหมา)
 * ส่ง LINE/SMS ผ่าน `POST /v1/messages/send-link` (D-62 — ใบ APPROVED/PAID ใช้แม่แบบ "ดูสถานะการจ่าย") · ช่องที่ใช้ไม่ได้ไม่แสดงปุ่ม
 */
function LinkBox({
  s,
  link: issued,
  onToast,
}: {
  s: Settlement;
  link: { link: SettlementLink; viewOnly: boolean };
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const link = issued.link;
  const channels = useMessageChannels();
  const send = useSendLink(s.carrier.id);
  const usable = (['line', 'sms'] as const).filter((c) => channels.data?.has(c));
  const copy = () => {
    void navigator.clipboard?.writeText(link.url).catch(() => undefined);
    onToast(t('cdoc.link.copied'));
  };
  const doSend = (channel: ChannelKey) =>
    send.mutate(
      { channel, url: link.url, idempotencyKey: crypto.randomUUID() },
      {
        onSuccess: () => onToast(t('cdoc.send.queued', { ch: chName(channel) })),
        onError: (e) => {
          const code =
            e instanceof ApiError
              ? (e.problem as { errors?: { code: string }[] }).errors?.[0]?.code
              : undefined;
          onToast(
            e instanceof ApiError && e.problem.code === 'channel_unavailable'
              ? t('cdoc.send.unavailable', { ch: chName(channel) })
              : code === 'recipient_missing' || code === 'recipient_invalid'
                ? t('cdoc.send.noRecipient', { ch: chName(channel) })
                : e instanceof ApiError && e.problem.code === 'rate_limited'
                  ? t('cdoc.send.limit')
                  : (problemText(e, t) ?? ''),
          );
        },
      },
    );
  return (
    <section style={SEC} data-testid="settle-link">
      <span style={SEC_T}>{t('settle.link.title')}</span>
      <div className="tms-vdoc__file">
        <Icon n="link" s={16} style={{ color: '#2257C4' }} />
        <span className="tms-num tms-ellipsis" style={{ flex: 1, fontSize: 13 }} title={link.url}>
          {link.url}
        </span>
        <button type="button" className="tms-vdoc__renew" onClick={copy}>
          <Icon n="copy" s={14} />
          {t('cdoc.link.copy')}
        </button>
        {usable.map((c) => (
          <button
            key={c}
            type="button"
            className={c === 'line' ? 'tms-vdoc__renew tms-vdoc__renew--pri' : 'tms-vdoc__renew'}
            disabled={send.isPending}
            onClick={() => doSend(c)}
          >
            <Icon n="send" s={14} />
            {t(c === 'line' ? 'cdoc.send.line' : 'cdoc.send.sms')}
          </button>
        ))}
      </div>
      <span className="tms-vdoc__sub">
        {t(issued.viewOnly ? 'settle.link.view' : 'settle.link.review', {
          d: formatDateTime(link.expiresAt, lang),
        })}{' '}
        · {t('cdoc.link.once')}
      </span>
    </section>
  );
}

/**
 * drawer ใบสำคัญจ่ายรถร่วม (ต้นแบบ vPanel kind 'sa' — แท็บ สรุป / เอกสารแนบ / กิจกรรม · kv ข้อมูล · รายการเที่ยว · ยอดเงิน · สถานะเอกสาร · footer ยอด + ปุ่ม)
 * ความต่างจากต้นแบบ [DECISION spec/12 §3 แถวหน้า settle]: การ์ดตรวจบิล 5 ข้อ + "การแก้ไขหลังส่งงาน" ยังไม่ทำ (ไม่มีข้อมูล — [OPEN Claude Design]) →
 * ปุ่ม "อนุมัติ" อยู่ที่ footer (ปุ่มหลักแบบ "บันทึกจ่าย") · "หนังสือรับรอง 50 ทวิ" ตัด (D-54/D-58) · "ตีกลับ" ยังไม่ทำ (เรียกกลับ = API) ·
 * เมนู ⋯ "ออกลิงก์ใหม่" (D-63) + "พิมพ์ใบสำคัญจ่าย"
 */
export function SettlementDrawer({
  id,
  link,
  canApprove,
  canPay,
  canRelink,
  onApprove,
  onPay,
  onRelink,
  onClose,
  onToast,
}: {
  id: string;
  /** ลิงก์ที่เพิ่งออกให้ใบนี้ (D-63) + ดูอย่างเดียวหรือไม่ ณ ตอนออก */
  link: { link: SettlementLink; viewOnly: boolean } | null;
  canApprove: boolean;
  canPay: boolean;
  canRelink: boolean;
  onApprove: (s: Settlement) => void;
  onPay: (s: Settlement) => void;
  onRelink: (s: Settlement) => void;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const dateText = useDateText();
  const q = useSettlement(id);
  const [tab, setTab] = useState('sum');
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const s = q.data;
  if (!s)
    return (
      <Drawer open onClose={onClose} kind={t('settle.kind')} title="…" labels={labels}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('settle.loadError')}
            description={problemText(q.error, t) ?? ''}
            action={
              <Button variant="secondary" icon="refresh-cw" onClick={() => q.refetch()}>
                {t('cust.retry')}
              </Button>
            }
          />
        ) : (
          <div className="tms-skel" style={{ height: 240 }} />
        )}
      </Drawer>
    );
  const st = statusLabel(t, s.status);
  const b = statusOf(st);
  const per =
    s.periodFrom && s.periodTo
      ? t('settle.per', { a: dateText(s.periodFrom), b: dateText(s.periodTo) })
      : '—';
  const print = () => {
    openVoucherPdf(s.id, s.settlementNo).catch((e: unknown) => onToast(problemText(e, t) ?? ''));
  };
  const trips = s.lines.filter((l) => l.active && l.lineType !== 'DEDUCTION');
  const info = [
    { k: t('settle.kv.carrier'), v: s.carrier.legalName },
    { k: t('settle.kv.per'), v: per },
    { k: t('settle.kv.trips'), v: t('settle.kv.tripsN', { n: s.tripCount }) },
    ...(s.paidDate
      ? [
          { k: t('settle.kv.paidAt'), v: dateText(s.paidDate) },
          {
            k: t('settle.kv.method'),
            v: [t(`settle.pay.m.${s.paymentMethod}` as MessageKey), s.paymentReference ?? '']
              .filter(Boolean)
              .join(' · '),
          },
        ]
      : []),
    ...(s.status === 'CANCELLED' && s.cancelReason
      ? [{ k: t('settle.kv.cancel'), v: s.cancelReason }]
      : []),
  ];
  const priced = s.buyGrossAmount !== undefined;
  const amounts = priced ? amountRows(t, s) : [];
  const total = priced ? t('ord.baht', { n: money(s.buyNetAfterWht) }) : '—';
  const approvable = canApprove && canApproveStatus(s.status);
  const payable = canPay && canPayStatus(s.status);
  const done = (k: 'collect' | 'check' | 'approve' | 'pay') => {
    const after = ['SENT_TO_CARRIER', 'APPROVED', 'PAID'];
    if (k === 'collect') return 'done';
    if (k === 'check') return after.includes(s.status) ? 'done' : t('bill.step.pending');
    // ยังไม่อนุมัติ = รอดำเนินการ (รวมร่าง/โต้แย้ง — review L4) · ยกเลิก = ข้าม
    if (k === 'approve')
      return s.approvedAt
        ? 'done'
        : s.status === 'CANCELLED'
          ? t('bill.step.skip')
          : t('bill.step.pending');
    return s.paidDate
      ? 'done'
      : s.status === 'APPROVED'
        ? t('bill.step.pending')
        : t('bill.step.skip');
  };
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('settle.kind')}
      title={s.settlementNo ?? t('settle.draftNo')}
      badge={<Badge label={st} tone={statusTone(s.status) ?? b.tone} icon={b.icon} />}
      subtitle={[s.carrier.legalName, per].join(' · ')}
      menu={[
        ...(canPrintStatus(s.status)
          ? [{ label: t('settle.menu.print'), icon: 'printer', onClick: print }]
          : []),
        ...(canRelink && canRelinkStatus(s.status)
          ? [{ label: t('settle.menu.relink'), icon: 'link', onClick: () => onRelink(s) }]
          : []),
      ]}
      tabs={[
        { key: 'sum', label: t('bill.tab.sum') },
        { key: 'docs', label: t('bill.tab.docs') },
        { key: 'log', label: t('bill.tab.log') },
      ]}
      tab={tab}
      onTab={setTab}
      labels={labels}
      footer={
        <>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>
              {t(['APPROVED', 'PAID'].includes(s.status) ? 'settle.ft.pay' : 'settle.ft.net')}
            </span>
            <span className="tms-num" style={{ fontSize: 20, fontWeight: 600 }}>
              {total}
            </span>
          </div>
          <span style={{ flex: 1 }} />
          <DrawerFooterButtons
            secondary={
              canPrintStatus(s.status) && ['APPROVED', 'PAID'].includes(s.status)
                ? [{ label: t('settle.menu.print'), onClick: print }]
                : []
            }
            {...(approvable
              ? {
                  primary: {
                    label: t('settle.menu.approve'),
                    icon: 'circle-check',
                    onClick: () => onApprove(s),
                  },
                }
              : payable
                ? {
                    primary: {
                      label: t('settle.menu.pay'),
                      icon: 'banknote',
                      onClick: () => onPay(s),
                    },
                  }
                : {})}
          />
        </>
      }
    >
      {tab === 'sum' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {link && <LinkBox s={s} link={link} onToast={onToast} />}
          <section style={SEC}>
            <span style={SEC_T}>{t('settle.kv.title')}</span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                gap: '14px 20px',
              }}
            >
              {info.map((x) => (
                <div
                  key={x.k}
                  style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>{x.k}</span>
                  <span
                    style={{
                      color: '#101418',
                      wordBreak: 'break-word',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {x.v}
                  </span>
                </div>
              ))}
            </div>
          </section>
          {trips.length > 0 && (
            <section style={SEC}>
              <span style={SEC_T}>{t('settle.items', { n: s.tripCount })}</span>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {trips.map((l) => (
                  <div key={l.id} style={ITEM}>
                    <span
                      style={{
                        color: '#2257C4',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {l.tripNo ?? ''}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      {l.lineType === 'SURCHARGE'
                        ? [t('settle.items.surcharge'), l.description].filter(Boolean).join(' · ')
                        : (l.description ?? '')}
                    </span>
                    <span
                      style={{
                        color: '#3B424C',
                        whiteSpace: 'nowrap',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {l.buyAmount !== undefined ? money(l.buyAmount) : ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {priced && (
            <section style={SEC}>
              <span style={SEC_T}>{t('settle.amounts')}</span>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {/* ต้นแบบ kvM: ยอดรวม / หัก ณ ที่จ่าย = ตัวหนา + เส้นบน (กฎป้าย "รวม|จ่าย") · ค่าไม่มีเครื่องหมายลบ */}
                {amounts.map((r) => {
                  const x = { k: r.k, v: r.amount };
                  const strong = r.strong;
                  return (
                    <div
                      key={x.k}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '6px 0',
                        borderTop: strong ? '1px solid #CDD1C8' : '0',
                      }}
                    >
                      <span style={{ color: '#3B424C', fontWeight: strong ? 600 : 400 }}>
                        {x.k}
                      </span>
                      <span
                        style={{
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: strong ? 600 : 400,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {x.v}
                      </span>
                    </div>
                  );
                })}
                {s.whtEstimate && (
                  <span style={{ fontSize: 12.5, color: '#59606B', paddingTop: 6 }}>
                    {t('settle.amt.note', {
                      f: t(`settle.form.${s.whtEstimate.form}` as MessageKey),
                    })}
                  </span>
                )}
              </div>
            </section>
          )}
        </div>
      )}
      {tab === 'docs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {canPrintStatus(s.status) ? (
            <button
              type="button"
              onClick={print}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                border: '1px solid #D9DCD4',
                borderRadius: 8,
                background: '#FFFFFF',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Icon n="file-text" s={18} style={{ color: '#2257C4' }} />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span
                  style={{ fontWeight: 500 }}
                >{`${s.settlementNo ?? t('settle.draftNo')}.pdf`}</span>
                <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('settle.doc.pdf')}</span>
              </span>
            </button>
          ) : (
            <EmptyState icon="paperclip" title={t('settle.doc.none')} />
          )}
        </div>
      )}
      {tab === 'log' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{t('settle.steps')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Step
              title={t('settle.step.collect')}
              state={done('collect')}
              at={formatDateTime(s.createdAt, lang)}
            />
            <Step
              title={t('settle.step.check')}
              state={done('check')}
              {...(s.sentAt ? { at: formatDateTime(s.sentAt, lang) } : {})}
            />
            <Step
              title={t('settle.step.approve')}
              state={done('approve')}
              {...(s.approvedAt ? { at: formatDateTime(s.approvedAt, lang) } : {})}
            />
            <Step
              title={t('settle.step.pay')}
              state={done('pay')}
              {...(s.paidAt ? { at: formatDateTime(s.paidAt, lang) } : {})}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
}
