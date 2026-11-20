import {
  ActivityTimeline,
  Badge,
  Drawer,
  DrawerFooterButtons,
  EmptyState,
  Icon,
  ReasonDialog,
  statusOf,
} from '@tms/ui';
import { useState } from 'react';
import { formatDateTime, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { ApiError } from '../../api';
import { problemText } from '../master/problems';
import { money, useDateText } from '../rate-cards/rateFormat';
import {
  openIssuedPdf,
  openProforma,
  useCancelDraft,
  useCustomerTerms,
  useFinalize,
  useInvoice,
  type Invoice,
} from './useInvoices';

const ST_KEY: Record<string, MessageKey> = {
  DRAFT: 'bill.st.DRAFT',
  ISSUED: 'bill.st.ISSUED',
  PARTIALLY_PAID: 'bill.st.PARTIALLY_PAID',
  PAID: 'bill.st.PAID',
  OVERDUE: 'bill.st.OVERDUE',
  ADJUSTED: 'bill.st.ISSUED',
  VOIDED: 'bill.st.CANCELLED',
  CANCELLED: 'bill.st.CANCELLED',
};

/** ข้อความไทยของการออกเอกสารไม่สำเร็จ — 409 `invoice_not_finalizable` ต่อท้ายด้วยเหตุ (`reasons[]`) */
export function finalizeErrorText(err: unknown, t: T): string {
  const base = problemText(err, t) ?? t('bill.issueFail');
  if (!(err instanceof ApiError) || err.problem.code !== 'invoice_not_finalizable') return base;
  const reasons = ((err.problem as { reasons?: string[] }).reasons ?? []).map((r) => {
    const k = `bill.reason.${r}` as MessageKey;
    return t(k) === k ? r : t(k);
  });
  return reasons.length ? `${base}: ${reasons.join(' · ')}` : base;
}

/** สถานะใบแจ้งหนี้ → ป้ายของต้นแบบ (ร่าง · ออกแล้ว · ชำระบางส่วน · ชำระแล้ว · เกินกำหนด · ยกเลิก) */
export function invoiceStatusLabel(t: T, status: string): string {
  return t(ST_KEY[status] ?? 'bill.st.DRAFT');
}

const sum = (inv: Invoice, pick: (k: string | null) => boolean) =>
  inv.lines
    .filter((l) => l.active && pick(l.kind))
    .reduce((a, l) => a + Math.round(Number(l.sellAmount ?? '0') * 100), 0);
const fromSatang = (n: number) => (n / 100).toFixed(2);
const SEC = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingBottom: 20,
  borderBottom: '1px solid #E4E6E0',
} as const;
const SEC_T = { fontSize: 12.5, fontWeight: 600, color: '#3B424C' } as const;
const ITEM = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0,1fr) auto',
  gap: 12,
  alignItems: 'baseline',
  padding: '8px 0',
  borderBottom: '1px solid #EBEDE8',
} as const;

function Step({ title, state, at }: { title: string; state: string; at?: string }) {
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
 * drawer ใบแจ้งหนี้ (ST5-T07; ต้นแบบ vPanel kind 'inv' — แท็บ สรุป / เอกสารแนบ / กิจกรรม, kv, "สถานะเอกสาร", footer ร่าง)
 * D-54: หัว "ใบแจ้งหนี้" เสมอ · ตัด kv "ใบกำกับภาษี" · ร่างไม่มีเลข ("ร่าง")
 * ST5-T09 ปุ่ม "ออกเอกสาร" (ต้นแบบ issueInv — กดแล้วออกทันที ไม่มีกล่องยืนยัน) → ออกเลข + ล็อก · ใบที่ออกแล้ว: kv รับแล้ว/คงค้าง/ออกเมื่อ/ครบกำหนดชำระ,
 * แถบล็อก, footer "คงค้าง" + "พิมพ์ PDF" (ไฟล์ต้นฉบับที่เก็บ) — ปุ่มใบลด/เพิ่มหนี้ (D-54 ไม่ทำใน TMS) / ส่งเข้าระบบบัญชี (ST8-T16) / บันทึกรับชำระ (ST5-T13) ยังไม่แสดง
 * แก้บรรทัด/ส่วนลด/รวม-แยก/ย้าย DO: ต้นแบบไม่มีหน้าจอ → ทำผ่าน API (`/v1/invoices/{id}/…`) [OPEN — Claude Design, spec/12 §3]
 */
export function InvoiceDrawer({
  id,
  canDraft,
  canFinalize,
  onClose,
  onToast,
}: {
  id: string;
  canDraft: boolean;
  canFinalize: boolean;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const dateText = useDateText();
  const q = useInvoice(id);
  const terms = useCustomerTerms(q.data?.customer.id);
  const cancel = useCancelDraft();
  const finalize = useFinalize();
  const [tab, setTab] = useState('sum');
  const [dlg, setDlg] = useState(false);
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const inv = q.data;
  if (!inv)
    return (
      <Drawer open onClose={onClose} kind={t('bill.kind')} title="…" labels={labels}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('bill.loadError')}
            description={problemText(q.error, t) ?? ''}
          />
        ) : null}
      </Drawer>
    );
  const draft = inv.status === 'DRAFT';
  const cancelled = inv.status === 'CANCELLED' || inv.status === 'VOIDED';
  const issued = !draft && !cancelled;
  const no = inv.invoiceNo ?? t('bill.draftNo');
  const st = invoiceStatusLabel(t, inv.status);
  const b = statusOf(st);
  const fr = sum(inv, (k) => k === 'FREIGHT');
  const svc = sum(inv, (k) => k !== 'FREIGHT');
  const pdfName = `${inv.invoiceNo ?? 'invoice'}.pdf`;
  const print = () =>
    void (draft ? openProforma(inv.id) : openIssuedPdf(inv.id, pdfName)).catch(() =>
      onToast(t('bill.pdfFail')),
    );
  const issue = () =>
    finalize.mutate(
      { id: inv.id, version: inv.version },
      {
        onSuccess: (x) => onToast(t('bill.toast.issued', { no: x.invoiceNo ?? '' })),
        onError: (e) => onToast(finalizeErrorText(e, t)),
      },
    );
  const per =
    inv.periodFrom && inv.periodTo
      ? `${dateText(inv.periodFrom)} – ${dateText(inv.periodTo)}`
      : '—';
  const info = [
    { k: t('bill.kv.cust'), v: inv.customer.legalName },
    { k: t('bill.kv.code'), v: inv.customer.code },
    { k: t('bill.kv.tax'), v: inv.customer.taxId ?? '—' },
    { k: t('bill.kv.per'), v: per },
    { k: t('bill.kv.n'), v: t('bill.kv.nDo', { n: inv.deliveryOrderCount }) },
    ...(issued
      ? [
          { k: t('bill.kv.issuedOn'), v: inv.issueDate ? dateText(inv.issueDate) : '—' },
          { k: t('bill.kv.due'), v: inv.dueDate ? dateText(inv.dueDate) : '—' },
        ]
      : []),
  ];
  const amounts = [
    { k: t('bill.kv.fr'), v: money(fromSatang(fr)) },
    { k: t('bill.kv.svc'), v: money(fromSatang(svc)) },
    { k: t('bill.kv.ex'), v: money(inv.sellSubtotalExempt) },
    { k: t('bill.kv.base'), v: money(inv.sellSubtotalVatable) },
    { k: t('bill.kv.vat'), v: money(inv.sellVatAmount) },
    { k: t('bill.kv.net'), v: money(inv.sellTotal), total: true },
    // ยังไม่มีการรับชำระ (ST5-T13) — คงค้าง = ยอดสุทธิ
    ...(issued
      ? [
          { k: t('bill.kv.paid'), v: money('0.00') },
          { k: t('bill.kv.out'), v: money(inv.sellTotal) },
        ]
      : []),
  ];
  const dos = inv.deliveryOrders.slice(0, 6);
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('bill.kind')}
      title={no}
      badge={<Badge label={st} tone={b.tone} icon={b.icon} />}
      subtitle={[inv.customer.legalName, inv.periodFrom ? per : ''].filter(Boolean).join(' · ')}
      // ต้นแบบ ⋯: แก้ไข · คัดลอกเป็นใบใหม่ · พิมพ์ · ยกเลิกเอกสาร — แก้ไข/คัดลอกยังไม่มีหน้าจอ [OPEN — Claude Design spec/12 §3]
      menu={[
        ...(draft || issued
          ? [{ label: t('bill.menu.print'), icon: 'printer', onClick: print }]
          : []),
        ...(draft && canDraft
          ? [
              {
                label: t('bill.menu.cancel'),
                icon: 'ban',
                danger: true,
                onClick: () => setDlg(true),
              },
            ]
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
        draft ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('bill.kv.net')}</span>
              <span className="tms-num" style={{ fontSize: 20, fontWeight: 600 }}>
                {t('ord.baht', { n: money(inv.sellTotal) })}
              </span>
            </div>
            <span style={{ flex: 1 }} />
            <DrawerFooterButtons
              secondary={[
                ...(canDraft
                  ? [{ label: t('bill.cancelDraft'), onClick: () => setDlg(true) }]
                  : []),
                { label: t('bill.print'), onClick: print },
              ]}
              primary={{
                label: t('bill.create'),
                icon: 'lock',
                disabled: !canFinalize || finalize.isPending,
                onClick: issue,
              }}
            />
          </>
        ) : issued ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('bill.kv.out')}</span>
              <span className="tms-num" style={{ fontSize: 20, fontWeight: 600 }}>
                {t('ord.baht', { n: money(inv.sellTotal) })}
              </span>
            </div>
            <span style={{ flex: 1 }} />
            <DrawerFooterButtons secondary={[{ label: t('bill.menu.pdf'), onClick: print }]} />
          </>
        ) : (
          <>
            <span style={{ flex: 1 }} />
            <DrawerFooterButtons secondary={[]} />
          </>
        )
      }
    >
      {tab === 'sum' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <section style={SEC}>
            <span style={SEC_T}>{t('bill.kv.title')}</span>
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
          {dos.length > 0 && (
            <section style={SEC}>
              <span style={SEC_T}>{t('bill.items', { n: inv.deliveryOrderCount })}</span>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {dos.map((d) => (
                  <div key={d.id} style={ITEM}>
                    <span
                      style={{
                        color: '#2257C4',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {d.doNo}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      {d.originSiteName} → {d.destSiteName}
                    </span>
                    <span
                      style={{
                        color: '#3B424C',
                        whiteSpace: 'nowrap',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {money(d.sellAmount)}
                    </span>
                  </div>
                ))}
                {inv.deliveryOrderCount > dos.length && (
                  <div style={ITEM}>
                    <span />
                    <span>{t('bill.itemsMore', { n: inv.deliveryOrderCount - dos.length })}</span>
                    <span />
                  </div>
                )}
              </div>
            </section>
          )}
          <section style={SEC}>
            <span style={SEC_T}>{t('bill.amounts')}</span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {amounts.map((x) => (
                <div
                  key={x.k}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '6px 0',
                    borderTop: x.total ? '1px solid #CDD1C8' : '0',
                  }}
                >
                  <span style={{ color: '#3B424C', fontWeight: x.total ? 600 : 400 }}>{x.k}</span>
                  <span
                    style={{
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: x.total ? 600 : 400,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {x.v}
                  </span>
                </div>
              ))}
              <span style={{ fontSize: 12.5, color: '#59606B', paddingTop: 6 }}>
                {t('bill.estimated', {
                  vat: t(
                    terms.data?.defaultVatType === 'VAT_7' ? 'bill.vat.all' : 'bill.vat.split',
                  ),
                })}
              </span>
            </div>
          </section>
          {/* ต้นแบบ vPanel inv: แถบล็อก (P.inv.locked) อยู่ท้ายแท็บสรุป ต่อจากยอดเงิน */}
          {(cancelled || issued) && (
            <div
              style={{
                background: '#EEF0EC',
                border: '1px solid #E9F0FA',
                borderRadius: 8,
                padding: '10px 14px',
                display: 'flex',
                gap: 8,
              }}
            >
              <Icon n="lock" s={16} style={{ color: '#2257C4', marginTop: 4, flexShrink: 0 }} />
              <span>{t(cancelled ? 'bill.lock.cancelled' : 'bill.lock.issued')}</span>
            </div>
          )}
        </div>
      )}
      {tab === 'docs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draft ? (
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
                <span style={{ fontWeight: 500 }}>{t('bill.doc.proforma')}</span>
                <span style={{ fontSize: 12.5, color: '#59606B' }}>PDF</span>
              </span>
            </button>
          ) : issued ? (
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
                <span style={{ fontWeight: 500 }}>{inv.pdf?.filename ?? pdfName}</span>
                <span style={{ fontSize: 12.5, color: '#59606B' }}>
                  {inv.pdf
                    ? t('bill.doc.pdf', { kb: Math.max(1, Math.round(inv.pdf.sizeBytes / 1024)) })
                    : t('bill.doc.pdfPending')}
                </span>
              </span>
            </button>
          ) : (
            <EmptyState icon="paperclip" title={t('bill.doc.none')} />
          )}
        </div>
      )}
      {tab === 'log' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{t('bill.steps')}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Step
                title={t('bill.step.draft')}
                state="done"
                at={formatDateTime(inv.createdAt, lang)}
              />
              <Step
                title={t('bill.step.issue')}
                state={
                  issued ? 'done' : cancelled ? t('bill.st.CANCELLED') : t('bill.step.pending')
                }
                {...(issued && inv.issuedAt ? { at: formatDateTime(inv.issuedAt, lang) } : {})}
              />
              <Step title={t('bill.step.pay')} state={issued ? st : t('bill.step.skip')} />
            </div>
          </div>
          <ActivityTimeline
            items={[
              ...(issued && inv.issuedAt
                ? [
                    {
                      key: 'i',
                      title: t('bill.step.issue'),
                      sub: formatDateTime(inv.issuedAt, lang),
                      badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'lock' },
                    },
                  ]
                : []),
              ...(draft && inv.updatedAt !== inv.createdAt
                ? [
                    {
                      key: 'u',
                      title: t('bill.act.updated', { v: inv.version }),
                      sub: formatDateTime(inv.updatedAt, lang),
                      badge: { label: st, tone: b.tone, icon: 'pencil' },
                    },
                  ]
                : []),
              {
                key: 'c',
                title: t('bill.act.created'),
                sub: formatDateTime(inv.createdAt, lang),
                badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'file-plus' },
              },
            ]}
          />
        </div>
      )}
      <ReasonDialog
        open={dlg}
        title={t('bill.cancel.title')}
        description={t('bill.cancel.desc')}
        label={t('bill.cancel.reason')}
        okLabel={t('bill.cancelDraft')}
        okIcon="ban"
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={cancel.isPending}
        error={cancel.error ? (problemText(cancel.error, t) ?? null) : null}
        onClose={() => setDlg(false)}
        onOk={(reason) =>
          cancel.mutate(
            { id: inv.id, version: inv.version, reason },
            {
              onSuccess: () => {
                setDlg(false);
                onToast(t('bill.toast.cancelled'));
              },
            },
          )
        }
      />
    </Drawer>
  );
}
