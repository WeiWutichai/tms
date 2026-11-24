import { Badge, Icon, ReasonDialog } from '@tms/ui';
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { can } from '../../nav';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { useDateTimeText } from '../rate-cards/rateFormat';
import type { TripDetail } from './useTrips';
import {
  counts,
  FIELD_CHARGE_TRIP,
  fmtMoney,
  itemAllows,
  moneyInput,
  sumMoney,
  uploadReceipt,
  useCreateFieldCharge,
  useDecideFieldCharge,
  useFieldChargeItems,
  useFieldCharges,
  type FieldCharge,
  type FieldChargeAction,
  type FieldChargeBody,
  type FieldChargeSide,
} from './useFieldCharges';

/* ค่าจากต้นแบบ TMS v4 drawer DO แท็บ "ค่าใช้จ่ายหน้างาน" (isExp) */
const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0,1fr) 140px 32px',
  gap: 8,
  alignItems: 'center',
};
const SELECT: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  minWidth: 0,
};
const AMOUNT: CSSProperties = {
  ...SELECT,
  fontVariantNumeric: 'tabular-nums',
  fontSize: 13,
  textAlign: 'right',
  width: '100%',
};
const PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 32,
  padding: '0 12px',
  border: '1px solid #9DB6E3',
  borderRadius: 999,
  background: '#FFFFFF',
  color: '#2257C4',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const TRASH: CSSProperties = {
  width: 32,
  height: 32,
  border: 0,
  borderRadius: 999,
  background: 'transparent',
  color: '#3B424C',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const LINK: CSSProperties = {
  border: 0,
  background: 'transparent',
  padding: 0,
  color: '#2257C4',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontSize: 13,
};
const DISABLED: CSSProperties = { opacity: 0.45, cursor: 'not-allowed' };
const LABEL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const META: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  fontSize: 12.5,
  color: '#59606B',
};

const STATUS: Record<
  FieldCharge['status'],
  { key: MessageKey; tone: 'warn' | 'ok' | 'err' | 'off'; icon: string }
> = {
  PENDING_CONFIRM: { key: 'fc.st.PENDING_CONFIRM', tone: 'warn', icon: 'hourglass' },
  CONFIRMED: { key: 'fc.st.CONFIRMED', tone: 'ok', icon: 'circle-check' },
  REJECTED: { key: 'fc.st.REJECTED', tone: 'err', icon: 'x' },
  CANCELLED: { key: 'fc.st.CANCELLED', tone: 'off', icon: 'ban' },
};

interface Draft {
  side: FieldChargeSide;
  itemId: string;
  amount: string;
  buyAmount: string;
  doId: string;
  docId: string | null;
  docName: string | null;
}

/**
 * แท็บ "ค่าใช้จ่ายหน้างาน" ของ drawer เที่ยว (ST4-T13; docs/04 E2) — หน้าตาตามต้นแบบ TMS v4 drawer DO แท็บ isExp
 * (แถว select รายการ | ยอด | ถังขยะ, "เพิ่มรายการ", ข้อความว่าง, "รวมค่าใช้จ่ายหน้างาน") — ระบบยังไม่มี drawer DO จึงวางที่เที่ยว
 * (เหมือน ST4-T07) · ส่วนที่ต้นแบบไม่มี (ฝั่ง เก็บลูกค้า/ต้นทุน, DO, รูปใบเสร็จ, ป้ายสถานะ, ยืนยัน/ปฏิเสธ) = spec/12 §3 DECISION
 * บรรทัดที่บันทึกแล้วแก้ไม่ได้ (รอผู้วางบิลยืนยัน) — ผิด = ยกเลิก (ถังขยะ + เหตุผล) แล้วเพิ่มใหม่
 */
export function FieldChargesTab({
  trip,
  doId,
  onToast,
}: {
  trip: TripDetail;
  /** drawer DO: แสดง/เพิ่มเฉพาะรายการของ DO นี้ (ฝั่งซื้อล้วนไม่ผูก DO → อยู่ที่ drawer เที่ยว) */
  doId?: string;
  onToast: (m: string) => void;
}) {
  const { t } = useI18n();
  const dt = useDateTimeText();
  const me = useMe();
  const scopes = me.data?.scopes ?? [];
  const canSell = can(scopes, 'prices.sell:write');
  // ฝั่งซื้อ: แก้ราคาซื้อ หรือผู้จ่ายงานที่เห็นราคาซื้อ (ตรงกับ API — ยืนยันโดยผู้อื่น)
  const canBuy =
    can(scopes, 'prices.buy:write') ||
    (can(scopes, 'trips:dispatch') && can(scopes, 'prices.buy:read'));
  const seeSell = can(scopes, 'prices.sell:read');
  const seeBuy = can(scopes, 'prices.buy:read');
  /** ยืนยัน/ปฏิเสธ: ฝั่งขาย ผู้วางบิล · ฝั่งซื้อ ผู้อนุมัติ settlement (docs/04 A3) */
  const canDecide = (l: FieldCharge) =>
    can(scopes, l.side === 'SELL' ? 'invoices:draft' : 'settlements:approve');
  const me_ = me.data?.actorId ?? null;
  /** maker-checker: ผู้บันทึกยืนยัน/ปฏิเสธของตัวเองไม่ได้ */
  const own = (l: FieldCharge) => !!me_ && l.createdBy === me_;
  const dos = trip.deliveryOrders.filter(
    (d) => d.status !== 'CANCELLED' && d.status !== 'BILLED' && (!doId || d.id === doId),
  );
  const open = FIELD_CHARGE_TRIP.has(trip.status);
  const sides: FieldChargeSide[] = [
    ...(canSell && dos.length ? (['SELL'] as const) : []),
    ...(canBuy && !doId ? (['BUY'] as const) : []),
    ...(canSell && canBuy && dos.length ? (['BOTH'] as const) : []),
  ];
  const canAdd = open && sides.length > 0;

  const q = useFieldCharges(trip.id, true);
  const items = useFieldChargeItems(canAdd);
  const create = useCreateFieldCharge(trip.id);
  const decide = useDecideFieldCharge(trip.id);
  const lines = (q.data ?? []).filter((l) => !doId || l.deliveryOrderId === doId);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyUp, setBusyUp] = useState(false);
  const [ask, setAsk] = useState<{ line: FieldCharge; action: FieldChargeAction } | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const options = useMemo(
    () => (draft ? items.filter((i) => itemAllows(i, draft.side)) : []),
    [items, draft],
  );

  const start = () => {
    const side = sides[0]!;
    const first = items.find((i) => itemAllows(i, side));
    setErr(null);
    setDraft({
      side,
      itemId: first?.id ?? '',
      amount: '',
      buyAmount: '',
      doId: dos[0]?.id ?? '',
      docId: null,
      docName: null,
    });
  };
  const setSide = (side: FieldChargeSide) =>
    setDraft((d) => {
      if (!d) return d;
      const keep = items.find((i) => i.id === d.itemId && itemAllows(i, side));
      return {
        ...d,
        side,
        itemId: keep?.id ?? items.find((i) => itemAllows(i, side))?.id ?? '',
      };
    });

  const upload = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f || !draft) return;
    setBusyUp(true);
    setErr(null);
    try {
      const id = await uploadReceipt(f, f.name);
      setDraft((d) => (d ? { ...d, docId: id, docName: f.name } : d));
    } catch (e) {
      setErr(
        e instanceof Error && e.message === 'bad_file'
          ? t('fc.err.file')
          : (problemText(e, t) ?? t('fc.err.save')),
      );
    } finally {
      setBusyUp(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = () => {
    if (!draft) return;
    const sell = draft.side !== 'BUY';
    const buy = draft.side !== 'SELL';
    const main = moneyInput(draft.amount);
    const cost = buy ? moneyInput(draft.side === 'BOTH' ? draft.buyAmount : draft.amount) : null;
    if (!draft.itemId) return setErr(t('fc.err.item'));
    if (!main || (buy && !cost) || main === '0.00' || cost === '0.00')
      return setErr(t('fc.err.amount'));
    if (!draft.docId) return setErr(t('fc.err.receipt'));
    const body: FieldChargeBody = {
      side: draft.side,
      serviceItemId: draft.itemId,
      ...(sell ? { deliveryOrderId: draft.doId, sellUnitPrice: main } : {}),
      ...(buy ? { costAmount: cost! } : {}),
      evidenceDocumentId: draft.docId,
    };
    setErr(null);
    create.mutate(body, {
      onSuccess: () => {
        setDraft(null);
        onToast(t('fc.toast.saved'));
      },
      onError: (e) => setErr(problemText(e, t) ?? t('fc.err.save')),
    });
  };

  const amountOf = (l: FieldCharge) =>
    l.side === 'SELL' ? (seeSell ? l.sellAmount : undefined) : seeBuy ? l.buyAmount : undefined;
  const live = lines.filter(counts);
  const sellLines = live.filter((l) => l.side === 'SELL');
  const buyLines = live.filter((l) => l.side === 'BUY');
  const canCancel = (l: FieldCharge) =>
    l.status === 'PENDING_CONFIRM' && (l.side === 'SELL' ? canSell : canBuy);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="field-charges">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('fc.title')}</h3>
        {canAdd && !draft && (
          <button type="button" style={PILL} onClick={start}>
            <Icon n="plus" s={16} />
            {t('fc.add')}
          </button>
        )}
      </div>

      {q.isError && (
        <span className="tms-field-error" role="alert">
          {problemText(q.error, t) ?? t('fc.err.load')}
        </span>
      )}

      {lines.map((l) => {
        const amt = amountOf(l);
        const st = STATUS[l.status];
        return (
          <div
            key={l.id}
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            data-testid="fc-line"
          >
            <div style={ROW}>
              <select value={l.id} disabled style={SELECT} aria-label={t('fc.item')}>
                <option value={l.id}>{l.description}</option>
              </select>
              <input
                value={amt ? fmtMoney(amt) : '—'}
                disabled
                aria-label={t('fc.amount')}
                style={AMOUNT}
              />
              {canCancel(l) ? (
                <button
                  type="button"
                  title={t('fc.remove')}
                  aria-label={t('fc.remove')}
                  style={TRASH}
                  onClick={() => {
                    setAskErr(null);
                    setAsk({ line: l, action: 'cancel' });
                  }}
                >
                  <Icon n="trash-2" s={16} />
                </button>
              ) : (
                <span />
              )}
            </div>
            <div style={META}>
              <Badge label={t(st.key)} tone={st.tone} icon={st.icon} />
              <span>
                {l.side === 'SELL' ? t('fc.meta.sell', { no: l.doNo ?? '—' }) : t('fc.meta.buy')}
                {l.pairedId ? ` · ${t('fc.meta.paired')}` : ''}
              </span>
              {l.evidence ? (
                <a
                  href={l.evidence.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...LINK, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Icon n="image" s={14} />
                  {t('fc.meta.receipt')}
                </a>
              ) : (
                <span>{t('fc.meta.noReceipt')}</span>
              )}
              <span>
                {t('fc.meta.by', {
                  who: l.createdByName ?? l.createdBy ?? '—',
                  at: dt(l.createdAt),
                })}
              </span>
              {l.status === 'PENDING_CONFIRM' && canDecide(l) && (
                <span
                  style={{ display: 'inline-flex', gap: 12, marginLeft: 'auto' }}
                  title={own(l) ? t('fc.ownLine') : undefined}
                >
                  <button
                    type="button"
                    disabled={own(l)}
                    style={{ ...LINK, ...(own(l) ? DISABLED : {}) }}
                    onClick={() => {
                      setAskErr(null);
                      setAsk({ line: l, action: 'confirm' });
                    }}
                  >
                    {t('fc.confirm')}
                  </button>
                  <button
                    type="button"
                    disabled={own(l)}
                    style={{ ...LINK, color: '#B3322A', ...(own(l) ? DISABLED : {}) }}
                    onClick={() => {
                      setAskErr(null);
                      setAsk({ line: l, action: 'reject' });
                    }}
                  >
                    {t('fc.reject')}
                  </button>
                </span>
              )}
            </div>
            {l.decisionReason && l.status !== 'PENDING_CONFIRM' && (
              <span style={{ ...META, display: 'block' }}>
                {t('fc.meta.decided', {
                  who: l.decidedByName ?? l.decidedBy ?? '—',
                  at: l.decidedAt ? dt(l.decidedAt) : '',
                  reason: l.decisionReason,
                })}
              </span>
            )}
          </div>
        );
      })}

      {draft && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: 12,
            border: '1px solid #E4E6E0',
            borderRadius: 12,
            background: '#F7F8F5',
          }}
          data-testid="fc-draft"
        >
          {sides.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={LABEL}>{t('fc.side')}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                {sides.map((s) => {
                  const on = draft.side === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setSide(s)}
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
                      {t(`fc.side.${s}` as MessageKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div style={ROW}>
            <select
              value={draft.itemId}
              aria-label={t('fc.item')}
              onChange={(e) => setDraft({ ...draft, itemId: e.target.value })}
              style={SELECT}
            >
              {!options.length && <option value="">{t('fc.noItems')}</option>}
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <input
              value={draft.amount}
              inputMode="decimal"
              placeholder="0.00"
              aria-label={draft.side === 'BUY' ? t('fc.buyAmount') : t('fc.amount')}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
              style={AMOUNT}
            />
            <button
              type="button"
              title={t('fc.remove')}
              aria-label={t('fc.discard')}
              style={TRASH}
              onClick={() => {
                setDraft(null);
                setErr(null);
              }}
            >
              <Icon n="trash-2" s={16} />
            </button>
          </div>
          {draft.side === 'BOTH' && (
            <div style={ROW}>
              <span style={LABEL}>{t('fc.buyAmount')}</span>
              <input
                value={draft.buyAmount}
                inputMode="decimal"
                placeholder="0.00"
                aria-label={t('fc.buyAmount')}
                onChange={(e) => setDraft({ ...draft, buyAmount: e.target.value })}
                style={AMOUNT}
              />
              <span />
            </div>
          )}
          {draft.side !== 'BUY' && dos.length > 1 && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={LABEL}>{t('fc.do')}</span>
              <select
                value={draft.doId}
                onChange={(e) => setDraft({ ...draft, doId: e.target.value })}
                style={SELECT}
              >
                {dos.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.doNo}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={PILL}
              disabled={busyUp}
              onClick={() => fileRef.current?.click()}
            >
              <Icon n="upload" s={16} />
              {draft.docId ? t('fc.receiptChange') : t('fc.receipt')}
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp,application/pdf"
              aria-label={t('fc.receipt')}
              onChange={(e) => void upload(e.target.files)}
            />
            <span style={{ fontSize: 12.5, color: '#59606B', minWidth: 0 }}>
              {busyUp ? t('fc.uploading') : (draft.docName ?? t('fc.receiptHint'))}
            </span>
            <button
              type="button"
              style={{ ...PILL, marginLeft: 'auto' }}
              disabled={create.isPending || busyUp}
              onClick={save}
            >
              <Icon n="check" s={16} />
              {t('fc.save')}
            </button>
          </div>
          <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('fc.pendingNote')}</span>
        </div>
      )}

      {err && (
        <span className="tms-field-error" role="alert">
          {err}
        </span>
      )}

      {!lines.length && !draft && !q.isLoading && (
        <span style={{ color: '#3B424C' }}>{t('fc.empty')}</span>
      )}
      {!open && (
        <span style={{ fontSize: 12.5, color: '#59606B' }}>
          {t(
            trip.status === 'PLANNING' || trip.status === 'ASSIGNED' || trip.status === 'OFFERED'
              ? 'fc.closed.before'
              : 'fc.closed.after',
          )}
        </span>
      )}

      {(sellLines.length > 0 || !buyLines.length) && seeSell && (
        <Total
          label={t('fc.total')}
          value={t('fc.baht', { v: sumMoney(sellLines.map((l) => l.sellAmount)) })}
        />
      )}
      {buyLines.length > 0 && seeBuy && (
        <Total
          label={t('fc.totalBuy')}
          value={t('fc.baht', { v: sumMoney(buyLines.map((l) => l.buyAmount)) })}
        />
      )}

      {ask && (
        <ReasonDialog
          open
          title={t(`fc.dlg.${ask.action}.title` as MessageKey)}
          description={
            t('fc.dlg.desc', {
              item: ask.line.description,
              amount: amountOf(ask.line) ? t('fc.baht', { v: fmtMoney(amountOf(ask.line)!) }) : '',
            }) + (ask.action === 'cancel' && ask.line.pairedId ? ` · ${t('fc.dlg.pairNote')}` : '')
          }
          label={t('ord.dlg.reason')}
          placeholder={t(`fc.dlg.${ask.action}.ph` as MessageKey)}
          okLabel={t(`fc.dlg.${ask.action}.ok` as MessageKey)}
          cancelLabel={t('common.cancel')}
          closeLabel={t('drawer.close')}
          minLength={10}
          hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
          busy={decide.isPending}
          error={askErr}
          onClose={() => setAsk(null)}
          onOk={(reason) =>
            decide.mutate(
              { line: ask.line, action: ask.action, reason },
              {
                onSuccess: () => {
                  onToast(t(`fc.toast.${ask.action}` as MessageKey));
                  setAsk(null);
                },
                onError: (e) => setAskErr(problemText(e, t) ?? t('fc.err.save')),
              },
            )
          }
        />
      )}
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        borderTop: '1px solid #D9DCD4',
        paddingTop: 10,
        marginTop: 4,
      }}
    >
      <span style={LABEL}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, fontWeight: 600 }}>
        {value}
      </span>
    </div>
  );
}
