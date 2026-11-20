import {
  ActivityTimeline,
  Badge,
  Button,
  Drawer,
  DrawerFooterButtons,
  EmptyState,
  FormDrawer,
  FormField,
  FormSection,
  Icon,
  ReasonDialog,
  TextInput,
  statusOf,
} from '@tms/ui';
import { useMemo, useState } from 'react';
import { formatDateTime, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { ApiError } from '../../api';
import { fieldErrors, problemText } from '../master/problems';
import { bangkokToday, money, useDateText } from '../rate-cards/rateFormat';
import {
  openBillingNotePdf,
  useAcknowledgeBillingNote,
  useBillingCandidates,
  useBillingNote,
  useCancelBillingNote,
  useCollectBillingNote,
  useCreateBillingNote,
  useFinalizeBillingNote,
  useUpdateBillingNote,
  type BillingNote,
} from './useBillingNotes';

const ST_KEY: Record<string, MessageKey> = {
  DRAFT: 'bill.st.DRAFT',
  ISSUED: 'bill.st.ISSUED',
  COLLECTED: 'bn.st.COLLECTED',
  CANCELLED: 'bill.st.CANCELLED',
};

/** สถานะใบวางบิล → ป้าย (ร่าง · ออกแล้ว · ชำระแล้ว · ยกเลิก) — COLLECTED อยู่แท็บ "ชำระแล้ว" ของต้นแบบ [DECISION spec/12 §3 ST5-T11] */
export function billingNoteStatusLabel(t: T, status: string): string {
  return t(ST_KEY[status] ?? 'bill.st.DRAFT');
}

/** ข้อความไทยของ error ใบวางบิล — 409 ต่อท้ายด้วยเลขใบแจ้งหนี้ที่ติด */
export function billingNoteErrorText(err: unknown, t: T): string {
  const base = problemText(err, t) ?? t('bill.createFail');
  if (!(err instanceof ApiError)) return base;
  const p = err.problem as {
    invoices?: { invoiceNo?: string | null; billingNoteNo?: string | null }[];
  };
  if (
    err.problem.code === 'invoice_already_billed' ||
    err.problem.code === 'invoice_not_billable'
  ) {
    const nos = (p.invoices ?? []).map((x) => x.invoiceNo).filter(Boolean);
    return nos.length ? `${base}: ${nos.join(', ')}` : base;
  }
  if (err.problem.code === 'validation_failed') {
    const f = Object.values(fieldErrors(err, t));
    return f.length ? `${base}: ${f.join(' · ')}` : base;
  }
  return base;
}

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
const DOC_BTN = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  border: '1px solid #D9DCD4',
  borderRadius: 8,
  background: '#FFFFFF',
  cursor: 'pointer',
  textAlign: 'left',
} as const;

/**
 * drawer ใบวางบิล (ST5-T11) — โครงเดียวกับ drawer ใบแจ้งหนี้ (ต้นแบบ vPanel kind 'inv': แท็บ สรุป / เอกสารแนบ / กิจกรรม, kv, ยอดเงิน,
 * แถบล็อก, footer ยอด + ปุ่ม) · ต้นแบบไม่มี drawer ใบวางบิล [DECISION spec/12 §3 — ST5-T11]
 * ร่าง: แก้ไข (ฟอร์ม) · ยกเลิกร่าง · พิมพ์ตัวอย่าง · ออกเอกสาร | ออกแล้ว: ผู้รับวางบิล · รับเช็ค/โอนแล้ว · พิมพ์ PDF · ยกเลิกเอกสาร
 */
export function BillingNoteDrawer({
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
  const q = useBillingNote(id);
  const finalize = useFinalizeBillingNote();
  const cancel = useCancelBillingNote();
  const collect = useCollectBillingNote();
  const [tab, setTab] = useState('sum');
  const [dlg, setDlg] = useState<null | 'cancel' | 'collect' | 'ack' | 'edit'>(null);
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const bn = q.data;
  if (!bn)
    return (
      <Drawer open onClose={onClose} kind={t('bn.kind')} title="…" labels={labels}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('bn.loadError')}
            description={problemText(q.error, t) ?? ''}
          />
        ) : null}
      </Drawer>
    );
  const draft = bn.status === 'DRAFT';
  const issued = bn.status === 'ISSUED';
  const collected = bn.status === 'COLLECTED';
  const cancelled = bn.status === 'CANCELLED';
  const no = bn.billingNoteNo ?? t('bill.draftNo');
  const st = billingNoteStatusLabel(t, bn.status);
  const b = statusOf(st);
  const items = bn.invoices.filter((i) => i.active);
  const print = () => void openBillingNotePdf(bn).catch(() => onToast(t('bill.pdfFail')));
  const issue = () =>
    finalize.mutate(
      { id: bn.id, version: bn.version },
      {
        onSuccess: (x) => onToast(t('bill.toast.issued', { no: x.billingNoteNo ?? '' })),
        onError: (e) => onToast(billingNoteErrorText(e, t)),
      },
    );
  const info = [
    { k: t('bill.kv.cust'), v: bn.customer.legalName },
    { k: t('bill.kv.code'), v: bn.customer.code },
    { k: t('bill.kv.tax'), v: bn.customer.taxId ?? '—' },
    { k: t('bn.kv.n'), v: t('bn.kv.nInv', { n: bn.invoiceCount }) },
    ...(draft
      ? []
      : [{ k: t('bn.kv.billedOn'), v: bn.billingDate ? dateText(bn.billingDate) : '—' }]),
    { k: t('bn.kv.collect'), v: bn.collectionDate ? dateText(bn.collectionDate) : '—' },
    ...(bn.acknowledgement
      ? [
          {
            k: t('bn.kv.ack'),
            v: `${bn.acknowledgement.name} · ${dateText(bn.acknowledgement.receivedOn)}`,
          },
        ]
      : []),
    ...(bn.note ? [{ k: t('bn.kv.note'), v: bn.note }] : []),
  ];
  const amounts = [
    { k: t('bn.kv.total'), v: money(bn.sellTotal), total: true },
    ...(bn.sellWhtExpected && bn.sellWhtExpected !== '0.00'
      ? [
          { k: t('bn.kv.wht'), v: money(bn.sellWhtExpected) },
          { k: t('bn.kv.netExp'), v: money(bn.sellNetExpected) },
        ]
      : []),
  ];
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('bn.kind')}
      title={no}
      badge={<Badge label={st} tone={b.tone} icon={b.icon} />}
      subtitle={[bn.customer.legalName, t('bn.kv.nInv', { n: bn.invoiceCount })].join(' · ')}
      menu={[
        ...(draft && canDraft
          ? [{ label: t('bn.menu.edit'), icon: 'pencil', onClick: () => setDlg('edit') }]
          : []),
        ...(!cancelled ? [{ label: t('bill.menu.print'), icon: 'printer', onClick: print }] : []),
        ...((draft && canDraft) || (issued && canFinalize)
          ? [
              {
                label: t('bill.menu.cancel'),
                icon: 'ban',
                danger: true,
                onClick: () => setDlg('cancel'),
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
        <>
          {!cancelled && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('bn.kv.total')}</span>
              <span className="tms-num" style={{ fontSize: 20, fontWeight: 600 }}>
                {t('ord.baht', { n: money(bn.sellTotal) })}
              </span>
            </div>
          )}
          <span style={{ flex: 1 }} />
          {draft ? (
            <DrawerFooterButtons
              secondary={[
                ...(canDraft ? [{ label: t('bn.menu.edit'), onClick: () => setDlg('edit') }] : []),
                { label: t('bill.print'), onClick: print },
              ]}
              primary={{
                label: t('bill.create'),
                icon: 'lock',
                disabled: !canFinalize || finalize.isPending,
                onClick: issue,
              }}
            />
          ) : issued ? (
            <DrawerFooterButtons
              secondary={[
                ...(canFinalize ? [{ label: t('bn.ack'), onClick: () => setDlg('ack') }] : []),
                { label: t('bill.menu.pdf'), onClick: print },
              ]}
              {...(canFinalize
                ? {
                    primary: {
                      label: t('bn.collect'),
                      icon: 'banknote',
                      disabled: collect.isPending,
                      onClick: () => setDlg('collect'),
                    },
                  }
                : {})}
            />
          ) : collected ? (
            <DrawerFooterButtons
              secondary={[
                ...(canFinalize ? [{ label: t('bn.ack'), onClick: () => setDlg('ack') }] : []),
                { label: t('bill.menu.pdf'), onClick: print },
              ]}
            />
          ) : (
            <DrawerFooterButtons secondary={[]} />
          )}
        </>
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
          <section style={SEC}>
            <span style={SEC_T}>{t('bn.items', { n: items.length })}</span>
            <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="bn-items">
              {items.map((d) => (
                <div key={d.invoiceId} style={ITEM}>
                  <span
                    style={{
                      color: '#2257C4',
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {d.invoiceNo}
                  </span>
                  <span style={{ minWidth: 0, color: '#3B424C' }}>
                    {t('bn.item.due', { d: dateText(d.dueDate) })}
                  </span>
                  <span
                    style={{
                      color: '#3B424C',
                      whiteSpace: 'nowrap',
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {money(d.sellOutstanding)}
                  </span>
                </div>
              ))}
            </div>
          </section>
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
                {t('bn.noTax')}
              </span>
            </div>
          </section>
          {!draft && (
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
              <span>
                {cancelled
                  ? `${t('bill.lock.cancelled')}${bn.cancelReason ? ` · ${bn.cancelReason}` : ''}`
                  : t('bill.lock.issued')}
              </span>
            </div>
          )}
        </div>
      )}
      {tab === 'docs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cancelled && !bn.billingNoteNo ? (
            <EmptyState icon="paperclip" title={t('bill.doc.none')} />
          ) : (
            <button type="button" onClick={print} style={DOC_BTN}>
              <Icon n="file-text" s={18} style={{ color: '#2257C4' }} />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 500 }}>
                  {draft ? t('bn.doc.proforma') : (bn.pdf?.filename ?? `${bn.billingNoteNo}.pdf`)}
                </span>
                <span style={{ fontSize: 12.5, color: '#59606B' }}>
                  {draft
                    ? 'PDF'
                    : bn.pdf
                      ? t('bill.doc.pdf', { kb: Math.max(1, Math.round(bn.pdf.sizeBytes / 1024)) })
                      : t('bill.doc.pdfPending')}
                </span>
              </span>
            </button>
          )}
        </div>
      )}
      {tab === 'log' && (
        <ActivityTimeline
          items={[
            ...(cancelled && bn.cancelledAt
              ? [
                  {
                    key: 'x',
                    title: t('bn.act.cancelled'),
                    sub: `${formatDateTime(bn.cancelledAt, lang)}${bn.cancelReason ? ` · ${bn.cancelReason}` : ''}`,
                    badge: { label: st, tone: b.tone, icon: 'ban' },
                  },
                ]
              : []),
            ...(bn.collectedAt
              ? [
                  {
                    key: 'k',
                    title: t('bn.act.collected'),
                    sub: `${formatDateTime(bn.collectedAt, lang)}${bn.collectNote ? ` · ${bn.collectNote}` : ''}`,
                    badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'banknote' },
                  },
                ]
              : []),
            ...(bn.acknowledgement
              ? [
                  {
                    key: 'a',
                    title: t('bn.act.ack', { name: bn.acknowledgement.name }),
                    sub: formatDateTime(bn.acknowledgement.recordedAt, lang),
                    badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'user-check' },
                  },
                ]
              : []),
            ...(bn.issuedAt
              ? [
                  {
                    key: 'i',
                    title: t('bill.step.issue'),
                    sub: formatDateTime(bn.issuedAt, lang),
                    badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'lock' },
                  },
                ]
              : []),
            {
              key: 'c',
              title: t('bn.act.created'),
              sub: formatDateTime(bn.createdAt, lang),
              badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'file-plus' },
            },
          ]}
        />
      )}
      <ReasonDialog
        open={dlg === 'cancel'}
        title={t('bn.cancel.title')}
        description={t('bn.cancel.desc')}
        label={t('bill.cancel.reason')}
        okLabel={t('bill.menu.cancel')}
        okIcon="ban"
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={cancel.isPending}
        error={cancel.error ? billingNoteErrorText(cancel.error, t) : null}
        onClose={() => setDlg(null)}
        onOk={(reason) =>
          cancel.mutate(
            { id: bn.id, version: bn.version, reason },
            {
              onSuccess: () => {
                setDlg(null);
                onToast(t('bn.toast.cancelled'));
              },
            },
          )
        }
      />
      <ReasonDialog
        open={dlg === 'collect'}
        title={t('bn.collect.title')}
        description={t('bn.collect.desc', { amt: money(bn.sellTotal) })}
        label={t('bn.collect.note')}
        okLabel={t('bn.collect')}
        okIcon="banknote"
        minLength={0}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={collect.isPending}
        error={collect.error ? billingNoteErrorText(collect.error, t) : null}
        onClose={() => setDlg(null)}
        onOk={(note) =>
          collect.mutate(
            { id: bn.id, version: bn.version, note: note.trim() },
            {
              onSuccess: () => {
                setDlg(null);
                onToast(t('bn.toast.collected', { no: bn.billingNoteNo ?? '' }));
              },
            },
          )
        }
      />
      {dlg === 'ack' && <AckForm bn={bn} onClose={() => setDlg(null)} onToast={onToast} />}
      {dlg === 'edit' && (
        <BillingNoteForm
          customerId={bn.customer.id}
          customerName={bn.customer.legalName}
          note={bn}
          onClose={() => setDlg(null)}
          onSaved={() => {
            setDlg(null);
            onToast(t('bn.toast.saved'));
          }}
        />
      )}
    </Drawer>
  );
}

/** บันทึกผู้รับวางบิล (ชื่อฝั่งลูกค้า + วันที่รับ) */
function AckForm({
  bn,
  onClose,
  onToast,
}: {
  bn: BillingNote;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const { t } = useI18n();
  const ack = useAcknowledgeBillingNote();
  const [name, setName] = useState(bn.acknowledgement?.name ?? '');
  const [on, setOn] = useState(bn.acknowledgement?.receivedOn ?? bangkokToday());
  const errs = ack.error ? fieldErrors(ack.error, t) : {};
  const save = () => {
    if (!name.trim()) return;
    ack.mutate(
      { id: bn.id, version: bn.version, receivedBy: name.trim(), receivedOn: on },
      {
        onSuccess: () => {
          onClose();
          onToast(t('bn.toast.ack'));
        },
      },
    );
  };
  return (
    <FormDrawer
      open
      title={t('bn.ack.title')}
      subtitle={bn.billingNoteNo ?? ''}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      onSubmit={save}
      alert={
        ack.error && !Object.keys(errs).length ? billingNoteErrorText(ack.error, t) : undefined
      }
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            icon="check"
            disabled={!name.trim() || ack.isPending}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FormSection title={t('bn.ack.title')}>
        <FormField label={t('bn.ack.name')} required span={2} error={errs.receivedBy}>
          {(p) => (
            <TextInput
              {...p}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('bn.ack.namePh')}
            />
          )}
        </FormField>
        <FormField label={t('bn.ack.on')} required error={errs.receivedOn}>
          {(p) => (
            <input
              {...p}
              type="date"
              className="tms-input"
              value={on}
              max={bangkokToday()}
              onChange={(e) => setOn(e.target.value)}
            />
          )}
        </FormField>
      </FormSection>
    </FormDrawer>
  );
}

/**
 * ฟอร์มสร้าง/แก้ร่างใบวางบิล (spec/05 §3 ข้อ 3 "เลือกลูกค้า → ติ๊ก INV ค้าง → วันนัดรับเช็ค") — FormDrawer มาตรฐานของต้นแบบ
 * ใบแจ้งหนี้ = ที่ออกแล้วค้างชำระของลูกค้านี้ (candidates) + ใบที่อยู่ในร่างนี้อยู่แล้ว
 */
export function BillingNoteForm({
  customerId,
  customerName,
  preselected,
  note,
  onClose,
  onSaved,
}: {
  customerId: string;
  customerName: string;
  preselected?: string[];
  note?: BillingNote;
  onClose: () => void;
  onSaved: (bn: BillingNote) => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const cand = useBillingCandidates(customerId);
  const create = useCreateBillingNote();
  const update = useUpdateBillingNote();
  const busy = create.isPending || update.isPending;
  const err = create.error ?? update.error;
  const rows = useMemo(() => {
    const own = (note?.invoices ?? [])
      .filter((i) => i.active)
      .map((i) => ({
        invoiceId: i.invoiceId,
        invoiceNo: i.invoiceNo,
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        sellOutstanding: i.sellOutstanding,
      }));
    const others = (cand.data?.data ?? []).filter(
      (c) => !own.some((o) => o.invoiceId === c.invoiceId),
    );
    return [...own, ...others];
  }, [note, cand.data]);
  const [picked, setPicked] = useState<string[]>(
    note ? note.invoices.filter((i) => i.active).map((i) => i.invoiceId) : (preselected ?? []),
  );
  const [collectOn, setCollectOn] = useState(note?.collectionDate ?? '');
  const [memo, setMemo] = useState(note?.note ?? '');
  const total = rows
    .filter((r) => picked.includes(r.invoiceId))
    .reduce((a, r) => a + Math.round(Number(r.sellOutstanding ?? '0') * 100), 0);
  const errs = err ? fieldErrors(err, t) : {};
  const save = () => {
    if (!picked.length) return;
    const done = { onSuccess: (bn: BillingNote) => onSaved(bn) };
    if (note)
      update.mutate(
        {
          id: note.id,
          version: note.version,
          invoiceIds: picked,
          collectionDate: collectOn || null,
          note: memo.trim() || null,
        },
        done,
      );
    else
      create.mutate(
        {
          customerId,
          invoiceIds: picked,
          ...(collectOn ? { collectionDate: collectOn } : {}),
          ...(memo.trim() ? { note: memo.trim() } : {}),
        },
        done,
      );
  };
  return (
    <FormDrawer
      open
      title={note ? t('bn.form.edit') : t('bill.title')}
      subtitle={customerName}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      onSubmit={save}
      alert={
        !picked.length
          ? t('bn.form.pickOne')
          : err && !errs.collectionDate
            ? billingNoteErrorText(err, t)
            : undefined
      }
      footer={
        <>
          <span style={{ color: '#3B424C', marginRight: 8 }}>
            {t('bn.form.sum', { n: picked.length })}{' '}
            <b className="tms-num">{t('ord.baht', { n: money((total / 100).toFixed(2)) })}</b>
          </span>
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" icon="check" disabled={!picked.length || busy}>
            {t('bn.form.save')}
          </Button>
        </>
      }
    >
      <FormSection title={t('bill.kv.title')}>
        <FormField label={t('bill.f.cust')} span={2}>
          {(p) => <TextInput {...p} value={customerName} readOnly />}
        </FormField>
        <FormField
          label={t('bn.kv.collect')}
          error={errs.collectionDate}
          hint={t('bn.form.collectHint')}
        >
          {(p) => (
            <input
              {...p}
              type="date"
              className="tms-input"
              value={collectOn}
              min={bangkokToday()}
              onChange={(e) => setCollectOn(e.target.value)}
            />
          )}
        </FormField>
        <FormField label={t('bn.kv.note')} span={2} error={errs.note}>
          {(p) => (
            <textarea
              {...p}
              className="tms-textarea"
              rows={2}
              maxLength={2000}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          )}
        </FormField>
      </FormSection>
      <FormSection title={t('bn.form.invoices', { n: rows.length })}>
        <div
          style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column' }}
          data-testid="bn-form-invoices"
        >
          {cand.isLoading && <span style={{ color: '#59606B' }}>…</span>}
          {!cand.isLoading && rows.length === 0 && (
            <EmptyState
              icon="receipt"
              title={t('bn.form.none')}
              description={t('bn.form.noneDesc')}
            />
          )}
          {rows.map((r) => {
            const on = picked.includes(r.invoiceId);
            return (
              <label
                key={r.invoiceId}
                style={{
                  ...ITEM,
                  gridTemplateColumns: 'auto auto minmax(0,1fr) auto',
                  cursor: 'pointer',
                  background: on ? '#E9F0FA' : undefined,
                  padding: '8px 8px',
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  aria-label={r.invoiceNo}
                  onChange={() =>
                    setPicked((p) =>
                      on ? p.filter((x) => x !== r.invoiceId) : [...p, r.invoiceId],
                    )
                  }
                  style={{ width: 16, height: 16, accentColor: '#2257C4', margin: 0 }}
                />
                <span
                  style={{ color: '#2257C4', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}
                >
                  {r.invoiceNo}
                </span>
                <span style={{ color: '#3B424C' }}>
                  {dateText(r.issueDate)} · {t('bn.item.due', { d: dateText(r.dueDate) })}
                </span>
                <span className="tms-num" style={{ textAlign: 'right' }}>
                  {money(r.sellOutstanding)}
                </span>
              </label>
            );
          })}
        </div>
      </FormSection>
    </FormDrawer>
  );
}
