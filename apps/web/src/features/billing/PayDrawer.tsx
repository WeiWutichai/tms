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
import { useState, type ReactNode } from 'react';
import { formatDateTime, useI18n, type T } from '../../i18n';
import { fieldErrors, problemText } from '../master/problems';
import { bangkokToday, money, useDateText } from '../rate-cards/rateFormat';
import { invoiceDisplayStatus, methodLabel, overdueDays } from './billing';
import { invoiceStatusLabel } from './InvoiceDrawer';
import { openIssuedPdf, useInvoice } from './useInvoices';
import {
  useInvoicePayments,
  usePaymentAction,
  useRecordPayment,
  type Payment,
} from './usePayments';

type Method = 'TRANSFER' | 'CHEQUE' | 'CASH' | 'OFFSET';
// ต้นแบบมี "หักกลบลบหนี้" (OFFSET) — ปิดไว้จนมีเครดิตลูกค้า (BIL-058) [DECISION spec/12 §3 แถว ST5-T13 review L2]
const METHODS: Method[] = ['TRANSFER', 'CHEQUE', 'CASH'];

/** บาท "1,234.50" / "1234.5" → สตางค์ (ไม่ใช้ float) · ว่าง/ผิดรูป = 0 */
export function toSatang(v: string | null | undefined): number {
  const s = (v ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return 0;
  const [i = '0', f = ''] = s.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}
export const fromSatang = (n: number) =>
  `${Math.trunc(n / 100)}.${String(Math.abs(n) % 100).padStart(2, '0')}`;

const lbl = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' } as const;
const input = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  minWidth: 0,
} as const;
const mono = { fontVariantNumeric: 'tabular-nums', fontSize: 13 } as const;
const SEC = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingBottom: 20,
  borderBottom: '1px solid #E4E6E0',
} as const;
const SEC_T = { fontSize: 12.5, fontWeight: 600, color: '#3B424C' } as const;
const box = { border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' } as const;

function F({ label, span, children }: { label: ReactNode; span?: boolean; children: ReactNode }) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        gridColumn: span ? '1 / -1' : undefined,
        minWidth: 0,
      }}
    >
      <span style={lbl}>{label}</span>
      {children}
    </label>
  );
}

/** ช่องวันที่แบบต้นแบบ (ไอคอนปฏิทิน + ข้อความวันที่ + input date โปร่งใสทับ) */
function DateBox({
  value,
  onChange,
  text,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  text: string;
  label: string;
}) {
  return (
    <span
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 40,
        padding: '0 12px',
        border: '1px solid #CDD1C8',
        borderRadius: 8,
        background: '#FFFFFF',
        cursor: 'pointer',
        boxSizing: 'border-box',
        width: '100%',
      }}
    >
      <Icon n="calendar" s={16} style={{ color: '#59606B' }} />
      <span
        style={{
          flex: 1,
          color: '#101418',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {text}
      </span>
      <input
        type="date"
        aria-label={label}
        value={value}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          cursor: 'pointer',
          width: '100%',
          height: '100%',
          border: 0,
          padding: 0,
          margin: 0,
        }}
      />
    </span>
  );
}

/**
 * drawer "รับชำระ" (ST5-T13; ต้นแบบ TMS v4 vPanel kind 'pay' — แท็บ รับชำระ / เอกสาร / บันทึกระบบ · kv ลูกค้า/ครบกำหนด + ยอดเงิน ·
 * ประเภทการรับ (เต็มจำนวน/บางส่วน) · จำนวนเงินที่รับ / วิธีรับ / วันที่รับ / เลขอ้างอิง-เลขที่เช็ค · ลูกค้าหักภาษี ณ ที่จ่าย + เลขที่ 50 ทวิ ·
 * ตารางสรุป · ประวัติรับชำระ · footer "ตัดหนี้รวม" + ดูใบแจ้งหนี้ + บันทึกรับชำระ)
 * D-56 บัญชีเบา: **ไม่ออกใบเสร็จ** — ตัดข้อความ "ระบบออกใบเสร็จรับเงิน … ให้อัตโนมัติ" และปุ่ม "พิมพ์ใบเสร็จ"
 * D-57 + backlog ST5-T13 (ต้นแบบไม่มี — [DECISION spec/12 §3]): เช็คมีช่องธนาคาร + วันที่หน้าเช็ค · ค่าธรรมเนียม · ส่วนต่าง (+ เหตุผล) ·
 * ประวัติมีสถานะเช็ค และปุ่ม เช็คผ่าน / เช็คคืน / กลับรายการ (เหตุผล)
 */
export function PayDrawer({
  id,
  canRecord,
  canReverse,
  onClose,
  onOpenInvoice,
  onToast,
}: {
  id: string;
  canRecord: boolean;
  canReverse: boolean;
  onClose: () => void;
  onOpenInvoice: () => void;
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const dateText = useDateText();
  const today = bangkokToday();
  const q = useInvoice(id);
  const pays = useInvoicePayments(id);
  const record = useRecordPayment();
  const act = usePaymentAction();
  const [tab, setTab] = useState('sum');
  const [ptype, setPtype] = useState<'full' | 'part'>('full');
  const [amt, setAmt] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>('TRANSFER');
  const [date, setDate] = useState(today);
  const [ref, setRef] = useState('');
  const [bank, setBank] = useState('');
  const [chqDate, setChqDate] = useState(today);
  const [whtOn, setWhtOn] = useState<boolean | null>(null);
  const [wht, setWht] = useState<string | null>(null);
  const [cert, setCert] = useState('');
  const [fee, setFee] = useState('');
  const [diff, setDiff] = useState('');
  const [diffReason, setDiffReason] = useState('');
  const [dlg, setDlg] = useState<{ p: Payment; action: 'reverse' | 'bounce' } | null>(null);
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const inv = q.data;
  if (!inv)
    return (
      <Drawer open onClose={onClose} kind={t('pay.kind')} title="…" labels={labels}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('bill.loadError')}
            description={problemText(q.error, t) ?? ''}
          />
        ) : null}
      </Drawer>
    );
  const list = pays.data?.data ?? [];
  const recorded = list.filter((p) => p.status === 'RECORDED');
  const st = invoiceDisplayStatus(inv, today);
  const stLabel = invoiceStatusLabel(t, st);
  const b = statusOf(stLabel);
  const late = overdueDays(inv, today);
  const out = toSatang(inv.sellOutstanding);
  const can = canRecord && out > 0 && (inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID');
  // WHT ที่ลูกค้าน่าจะหัก = ประมาณการของใบ − ที่หักไปแล้ว (ไม่เกินคงค้าง)
  const whtDone = recorded.reduce((a, p) => {
    const al = p.allocations.find((x) => x.invoiceId === inv.id);
    return a + toSatang(al?.sellWhtAmount);
  }, 0);
  const whtDefault = Math.min(out, Math.max(0, toSatang(inv.sellWhtExpected) - whtDone));
  const whtChecked = whtOn ?? whtDefault > 0;
  const whtV = whtChecked ? (wht !== null ? toSatang(wht) : whtDefault) : 0;
  const feeV = toSatang(fee);
  const diffV = toSatang(diff);
  const amtV =
    amt !== null ? toSatang(amt) : ptype === 'full' ? Math.max(0, out - whtV - feeV - diffV) : 0;
  const cutV = amtV + whtV + feeV + diffV;
  const rest = Math.max(0, out - cutV);
  const cheque = method === 'CHEQUE';
  const rates = [
    ...new Set(inv.lines.filter((l) => l.active).map((l) => Number(l.whtRate))),
  ].filter((r) => r > 0);
  const rateText = rates.length === 1 ? `${rates[0]}%` : '';
  const missing =
    cutV <= 0
      ? t('pay.need.amount')
      : cutV > out
        ? t('pay.over')
        : cheque && (!ref.trim() || !bank.trim() || !chqDate)
          ? t('pay.need.cheque')
          : diffV > 0 && [...diffReason.trim()].length < 10
            ? t('pay.need.diffReason')
            : '';
  const save = () => {
    if (missing) {
      onToast(missing);
      return;
    }
    record.mutate(
      {
        receivedDate: date,
        method,
        ...(cheque
          ? { chequeNo: ref.trim(), chequeBank: bank.trim(), chequeDate: chqDate }
          : ref.trim()
            ? { reference: ref.trim() }
            : {}),
        amountReceived: fromSatang(amtV),
        whtAmount: fromSatang(whtV),
        ...(whtChecked && cert.trim() ? { whtCertificateNo: cert.trim() } : {}),
        feeAmount: fromSatang(feeV),
        differenceAmount: fromSatang(diffV),
        ...(diffV > 0 ? { differenceReason: diffReason.trim() } : {}),
        allocations: [{ invoiceId: inv.id, amount: fromSatang(cutV) }],
      },
      {
        onSuccess: () => {
          onToast(
            t('pay.toast.saved', { no: inv.invoiceNo ?? '' }) +
              (rest > 0 ? t('pay.toast.rest', { n: money(fromSatang(rest)) }) : ''),
          );
          setAmt(null);
          setRef('');
          setBank('');
          setWht(null);
          setWhtOn(null);
          setCert('');
          setFee('');
          setDiff('');
          setDiffReason('');
        },
        onError: (e) =>
          onToast(Object.values(fieldErrors(e, t))[0] ?? problemText(e, t) ?? t('pay.fail')),
      },
    );
  };
  const kvI = [
    { k: t('bill.kv.cust'), v: inv.customer.legalName },
    {
      k: t('pay.kv.due'),
      v: inv.dueDate
        ? dateText(inv.dueDate) + (late > 0 ? ` ${t('pay.lateDays', { n: late })}` : '')
        : '—',
    },
  ];
  const kvM = [
    { k: t('bill.kv.net'), v: money(inv.sellTotal), strong: true },
    { k: t('bill.kv.paid'), v: money(inv.sellPaidAmount), strong: false },
    { k: t('bill.kv.out'), v: money(inv.sellOutstanding), strong: true },
  ];
  const sum = [
    { k: t('pay.sum.before'), v: out, strong: false },
    { k: t('pay.sum.amt'), v: amtV, strong: false },
    { k: t('pay.sum.wht'), v: whtV, strong: false },
    ...(feeV ? [{ k: t('pay.sum.fee'), v: feeV, strong: false }] : []),
    ...(diffV ? [{ k: t('pay.sum.diff'), v: diffV, strong: false }] : []),
    { k: t('pay.sum.cut'), v: cutV, strong: true },
    { k: t('pay.sum.rest'), v: rest, strong: false },
  ];
  const pdf = () =>
    void openIssuedPdf(inv.id, `${inv.invoiceNo ?? 'invoice'}.pdf`).catch(() =>
      onToast(t('bill.pdfFail')),
    );
  const runClear = (p: Payment) =>
    act.mutate(
      { id: p.id, version: p.version, action: 'clear' },
      {
        onSuccess: () => onToast(t('pay.toast.cleared', { no: p.chequeNo ?? '' })),
        onError: (e) => onToast(problemText(e, t) ?? t('pay.fail')),
      },
    );
  return (
    <Drawer
      open
      onClose={onClose}
      kind={`${t('pay.kind')} · ${inv.customer.legalName}`}
      title={inv.invoiceNo ?? ''}
      badge={<Badge label={stLabel} tone={b.tone} icon={b.icon} />}
      subtitle={inv.customer.legalName}
      menu={[{ label: t('bill.menu.print'), icon: 'printer', onClick: pdf }]}
      tabs={[
        { key: 'sum', label: t('pay.tab.sum') },
        { key: 'docs', label: t('pay.tab.docs') },
        { key: 'log', label: t('pay.tab.log') },
      ]}
      tab={tab}
      onTab={setTab}
      labels={labels}
      footer={
        can ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('pay.sum.cut')}</span>
              <span className="tms-num" style={{ fontSize: 20, fontWeight: 600 }}>
                {t('ord.baht', { n: money(fromSatang(cutV)) })}
              </span>
            </div>
            <span style={{ flex: 1 }} />
            <DrawerFooterButtons
              secondary={[{ label: t('pay.viewInv'), onClick: onOpenInvoice }]}
              primary={{
                label: t('pay.save'),
                icon: 'banknote',
                disabled: record.isPending,
                onClick: save,
              }}
            />
          </>
        ) : (
          <>
            <span style={{ flex: 1 }} />
            <DrawerFooterButtons
              secondary={[{ label: t('pay.viewInv'), onClick: onOpenInvoice }]}
            />
          </>
        )
      }
    >
      {tab === 'sum' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section style={SEC}>
            <span style={SEC_T}>{t('bill.kv.title')}</span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                gap: '14px 20px',
              }}
            >
              {kvI.map((x) => (
                <div
                  key={x.k}
                  style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: '#59606B' }}>{x.k}</span>
                  <span style={{ color: '#101418', wordBreak: 'break-word', ...mono }}>{x.v}</span>
                </div>
              ))}
            </div>
          </section>
          <section style={SEC}>
            <span style={SEC_T}>{t('bill.amounts')}</span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {kvM.map((x) => (
                <div
                  key={x.k}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '6px 0',
                    borderTop: x.strong ? '1px solid #CDD1C8' : '0',
                  }}
                >
                  <span style={{ color: '#3B424C', fontWeight: x.strong ? 600 : 400 }}>{x.k}</span>
                  <span
                    style={{
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: x.strong ? 600 : 400,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {x.v}
                  </span>
                </div>
              ))}
            </div>
          </section>
          {can && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={lbl}>{t('pay.ptype')}</span>
                <div style={{ display: 'flex', gap: 8 }} role="radiogroup">
                  {(['full', 'part'] as const).map((k) => {
                    const on = ptype === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          setPtype(k);
                          setAmt(null);
                        }}
                        style={{
                          flex: 1,
                          height: 36,
                          border: `1px solid ${on ? '#2257C4' : '#C9CDC3'}`,
                          background: on ? '#E9F0FA' : '#FFFFFF',
                          color: on ? '#2257C4' : '#3B424C',
                          fontWeight: on ? 600 : 500,
                          borderRadius: 999,
                          cursor: 'pointer',
                        }}
                      >
                        {t(k === 'full' ? 'pay.ptype.full' : 'pay.ptype.part')}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                  gap: '14px 16px',
                }}
              >
                <F label={t('pay.f.amt')}>
                  <input
                    value={amt ?? money(fromSatang(amtV))}
                    onChange={(e) => setAmt(e.target.value)}
                    inputMode="decimal"
                    style={{ ...input, ...mono }}
                  />
                </F>
                <F label={t('pay.f.method')}>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as Method)}
                    style={input}
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {methodLabel(t, m)}
                      </option>
                    ))}
                  </select>
                </F>
                <F label={t('pay.f.date')}>
                  <DateBox
                    value={date}
                    onChange={setDate}
                    text={dateText(date)}
                    label={t('pay.f.date')}
                  />
                </F>
                <F label={t('pay.f.ref')}>
                  <input
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    style={{ ...input, ...mono }}
                  />
                </F>
                {cheque && (
                  <>
                    <F label={t('pay.f.bank')}>
                      <input
                        value={bank}
                        onChange={(e) => setBank(e.target.value)}
                        placeholder={t('pay.f.bankPh')}
                        style={input}
                      />
                    </F>
                    <F label={t('pay.f.chqDate')}>
                      <DateBox
                        value={chqDate}
                        onChange={setChqDate}
                        text={dateText(chqDate)}
                        label={t('pay.f.chqDate')}
                      />
                    </F>
                  </>
                )}
                <F label={t('pay.f.fee')}>
                  <input
                    value={fee}
                    onChange={(e) => setFee(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.00"
                    style={{ ...input, ...mono, textAlign: 'right' }}
                  />
                </F>
                <F label={t('pay.f.diff')}>
                  <input
                    value={diff}
                    onChange={(e) => setDiff(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.00"
                    style={{ ...input, ...mono, textAlign: 'right' }}
                  />
                </F>
                {diffV > 0 && (
                  <F label={t('pay.f.diffReason')} span>
                    <textarea
                      value={diffReason}
                      onChange={(e) => setDiffReason(e.target.value)}
                      rows={3}
                      style={{
                        border: '1px solid #C9CDC3',
                        borderRadius: 8,
                        padding: '8px 10px',
                        color: '#101418',
                        resize: 'vertical',
                      }}
                    />
                  </F>
                )}
              </div>
              <div
                style={{
                  border: '1px solid #D9DCD4',
                  borderRadius: 8,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={whtChecked}
                    onChange={() => setWhtOn(!whtChecked)}
                    style={{ width: 16, height: 16, accentColor: '#2257C4', margin: 0 }}
                  />
                  <span style={{ fontWeight: 500 }}>{t('pay.wht.on', { rate: rateText })}</span>
                </label>
                {whtChecked && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                      gap: 12,
                    }}
                  >
                    <F label={t('pay.wht.amt')}>
                      <input
                        value={wht ?? money(fromSatang(whtDefault))}
                        onChange={(e) => setWht(e.target.value)}
                        inputMode="decimal"
                        style={{ ...input, ...mono, textAlign: 'right' }}
                      />
                    </F>
                    <F label={t('pay.wht.cert')}>
                      <input
                        value={cert}
                        onChange={(e) => setCert(e.target.value)}
                        placeholder={t('pay.wht.certPh')}
                        style={{ ...input, ...mono }}
                      />
                    </F>
                  </div>
                )}
              </div>
              <div style={box}>
                {sum.map((x) => (
                  <div
                    key={x.k}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '8px 12px',
                      borderBottom: '1px solid #E4E6E0',
                      background: x.strong ? '#EEF0EC' : '#FFFFFF',
                    }}
                  >
                    <span style={{ fontWeight: x.strong ? 600 : 400 }}>{x.k}</span>
                    <span style={{ ...mono, fontWeight: x.strong ? 600 : 400 }}>
                      {money(fromSatang(x.v))}
                    </span>
                  </div>
                ))}
              </div>
              {cutV > out && (
                <span style={{ color: '#B3322A' }}>
                  {t('pay.overBy', { n: money(fromSatang(cutV - out)) })}
                </span>
              )}
            </>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('pay.hist')}</h3>
            {list.length > 0 ? (
              <div style={box} data-testid="pay-history">
                {list.map((p) => (
                  <HistRow
                    key={p.id}
                    p={p}
                    invoiceId={inv.id}
                    t={t}
                    dateText={dateText}
                    canRecord={canRecord}
                    canReverse={canReverse}
                    busy={act.isPending}
                    onClear={() => runClear(p)}
                    onReverse={() => setDlg({ p, action: 'reverse' })}
                    onBounce={() => setDlg({ p, action: 'bounce' })}
                  />
                ))}
              </div>
            ) : (
              <span style={{ color: '#3B424C' }}>{t('pay.noHist')}</span>
            )}
          </div>
        </div>
      )}
      {tab === 'docs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            onClick={pdf}
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
              <span style={{ fontWeight: 500 }}>{inv.pdf?.filename ?? `${inv.invoiceNo}.pdf`}</span>
              <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('pay.doc.inv')}</span>
            </span>
          </button>
        </div>
      )}
      {tab === 'log' && (
        <ActivityTimeline
          items={[
            ...list.flatMap((p) => [
              ...(p.status === 'REVERSED' && p.reversedAt
                ? [
                    {
                      key: `${p.id}-r`,
                      title: t(
                        p.chequeStatus === 'BOUNCED' ? 'pay.log.bounced' : 'pay.log.reversed',
                        {
                          no: p.paymentNo,
                        },
                      ),
                      sub: `${formatDateTime(p.reversedAt, lang)} · ${p.reverseReason ?? ''}`,
                      badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'undo-2' },
                    },
                  ]
                : []),
              {
                key: p.id,
                title: t('pay.log.recorded', { no: p.paymentNo }),
                sub: formatDateTime(p.createdAt, lang),
                badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'banknote' },
              },
            ]),
            ...(inv.issuedAt
              ? [
                  {
                    key: 'issued',
                    title: t('pay.log.issued'),
                    sub: formatDateTime(inv.issuedAt, lang),
                    badge: { label: t('bill.step.done'), tone: 'ok' as const, icon: 'lock' },
                  },
                ]
              : []),
          ]}
        />
      )}
      <ReasonDialog
        open={!!dlg}
        title={t(dlg?.action === 'bounce' ? 'pay.bounce.title' : 'pay.reverse.title')}
        description={t(dlg?.action === 'bounce' ? 'pay.bounce.desc' : 'pay.reverse.desc', {
          no: dlg?.p.paymentNo ?? '',
        })}
        label={t('bill.cancel.reason')}
        okLabel={t(dlg?.action === 'bounce' ? 'pay.act.bounce' : 'pay.act.reverse')}
        okIcon="undo-2"
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={act.isPending}
        error={act.error ? (problemText(act.error, t) ?? null) : null}
        onClose={() => {
          setDlg(null);
          act.reset();
        }}
        onOk={(reason) =>
          dlg &&
          act.mutate(
            { id: dlg.p.id, version: dlg.p.version, action: dlg.action, reason },
            {
              onSuccess: () => {
                onToast(
                  t(dlg.action === 'bounce' ? 'pay.toast.bounced' : 'pay.toast.reversed', {
                    no: dlg.p.paymentNo,
                  }),
                );
                setDlg(null);
              },
            },
          )
        }
      />
    </Drawer>
  );
}

function HistRow({
  p,
  invoiceId,
  t,
  dateText,
  canRecord,
  canReverse,
  busy,
  onClear,
  onReverse,
  onBounce,
}: {
  p: Payment;
  invoiceId: string;
  t: T;
  dateText: (iso: string) => string;
  canRecord: boolean;
  canReverse: boolean;
  busy: boolean;
  onClear: () => void;
  onReverse: () => void;
  onBounce: () => void;
}) {
  const al = p.allocations.find((x) => x.invoiceId === invoiceId);
  const reversed = p.status === 'REVERSED';
  const ref = p.method === 'CHEQUE' ? `${p.chequeNo} · ${p.chequeBank}` : p.reference;
  const live = !reversed;
  const chq = p.method === 'CHEQUE';
  const acts = [
    ...(live && chq && p.chequeStatus === 'PENDING' && canRecord
      ? [{ k: 'clear', l: t('pay.act.clear'), fn: onClear }]
      : []),
    ...(live && chq && canReverse ? [{ k: 'bounce', l: t('pay.act.bounce'), fn: onBounce }] : []),
    ...(live && canReverse ? [{ k: 'reverse', l: t('pay.act.reverse'), fn: onReverse }] : []),
  ];
  const badge = reversed
    ? {
        label: t(p.chequeStatus === 'BOUNCED' ? 'pay.chq.BOUNCED' : 'pay.reversed'),
        tone: 'err' as const,
        icon: 'undo-2',
      }
    : chq
      ? p.chequeStatus === 'PENDING'
        ? { label: t('pay.chq.PENDING'), tone: 'warn' as const, icon: 'clock' }
        : { label: t('pay.chq.CLEARED'), tone: 'ok' as const, icon: 'circle-check' }
      : null;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        gap: '2px 12px',
        padding: '10px 12px',
        borderBottom: '1px solid #E4E6E0',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ ...mono, color: '#2257C4', fontWeight: 500 }}>{p.paymentNo}</span>
        {badge && <Badge {...badge} />}
      </span>
      <span
        style={{
          ...mono,
          fontWeight: 500,
          textAlign: 'right',
          textDecoration: reversed ? 'line-through' : undefined,
          color: reversed ? '#59606B' : undefined,
        }}
      >
        {money(al?.sellAmount)}
      </span>
      <span style={{ color: '#3B424C' }}>
        {dateText(p.receivedDate)} · {methodLabel(t, p.method)}
        {ref ? ` · ${ref}` : ''}
      </span>
      <span style={{ fontSize: 13, color: '#3B424C', textAlign: 'right' }}>
        {al && toSatang(al.sellWhtAmount) > 0
          ? t('pay.histWht', { n: money(al.sellWhtAmount) })
          : ''}
      </span>
      {reversed && p.reverseReason && (
        <span style={{ gridColumn: '1 / -1', fontSize: 12.5, color: '#59606B' }}>
          {p.reverseReason}
        </span>
      )}
      {acts.length > 0 && (
        <span style={{ gridColumn: '1 / -1', display: 'flex', gap: 16, paddingTop: 4 }}>
          {acts.map((a) => (
            <button
              key={a.k}
              type="button"
              disabled={busy}
              onClick={a.fn}
              style={{
                border: 0,
                background: 'transparent',
                padding: 0,
                color: a.k === 'clear' ? '#2257C4' : '#B3322A',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {a.l}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
