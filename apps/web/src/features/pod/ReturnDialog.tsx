import { Icon, useEscapeLayer } from '@tms/ui';
import { useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { useReasonCodes } from '../settings/useReasonCodes';
import {
  bodyOf,
  fmtQty,
  qtyOk,
  openLines,
  problems,
  type DeliveryOrder,
  type ReturnDraft,
  type ReturnMode,
} from './returnForm';
import { useResolveRejection } from './useReturn';
import type { DoPod } from './usePod';

/* ค่าสไตล์จากต้นแบบ TMS v4 dialog "ตีกลับบางส่วน" (RT / vRt) */
const LABEL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const FIELD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const BOX: CSSProperties = { border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' };
const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  borderBottom: '1px solid #E4E6E0',
  cursor: 'pointer',
};
const CHECK: CSSProperties = { width: 16, height: 16, accentColor: '#2257C4', margin: 0 };
const SELECT: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
};
const OK_BTN: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  height: 36,
  padding: '0 16px',
  border: '1px solid #2257C4',
  borderRadius: 999,
  background: '#2257C4',
  color: '#FFFFFF',
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

/**
 * ST4-T11 dialog "ตีกลับบางส่วน" (ต้นแบบ TMS v4 vRt — หัว/คำอธิบาย/รายการติ๊ก/เหตุผล (บังคับ) / รูป / โน้ต/ข้อความแนะนำ/บันทึกตีกลับ)
 * ต่างจากต้นแบบ [DECISION spec/12 §3]: (1) เพิ่ม "การจัดการ" ส่งซ้ำ / คืนคลัง (ต้นแบบไม่มี — docs/04 E2 ให้เลือก)
 * (2) รายการ = บรรทัดที่หลักฐานส่งบันทึกปฏิเสธรับไว้แล้ว (ST4-T10) จำนวน = คงเหลือที่ยังไม่จัดการ (ไม่มีช่องจำนวนตามต้นแบบ)
 * (3) รูป = รูปของหลักฐานส่ง (ไม่มีปุ่มแนบรูปแยก — เหมือน ST4-T10) (4) ข้อความแนะนำบอกผลจริง (ไม่ "แจ้งลูกค้า" — ไม่มีระบบแจ้ง)
 * DO ส่งไม่สำเร็จ: หัว "ส่งไม่สำเร็จ" รายการทั้งใบติ๊กไว้และแก้ไม่ได้ เหตุผลหมวดส่งไม่สำเร็จ
 */
export function ReturnDialog({
  d,
  pod,
  mode,
  onClose,
  onDone,
}: {
  d: DeliveryOrder;
  pod: DoPod;
  mode: ReturnMode;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  useEscapeLayer(true, onClose);
  const reasons = useReasonCodes();
  const save = useResolveRejection();
  const category = mode === 'failed' ? 'DELIVERY_FAILED' : 'REJECTED_BY_RECEIVER';
  const opts = (reasons.data ?? []).filter((r) => r.category === category && r.status === 'active');
  const lines = mode === 'failed' ? d.lines : openLines(d);
  // เหตุผลเริ่มต้น = เหตุผลปฏิเสธรับที่หลักฐานบันทึก (บรรทัดแรก) หรือรายการแรกของ master
  const recorded = lines.find((l) => l.rejectReasonCodeId)?.rejectReasonCodeId ?? '';
  const [draft, setDraft] = useState<ReturnDraft>({
    items: mode === 'failed' ? d.lines.map((l) => l.lineNo) : [],
    action: 'redeliver',
    reasonId: '',
    note: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const reasonId =
    draft.reasonId || (opts.some((o) => o.id === recorded) ? recorded : (opts[0]?.id ?? ''));
  const cur = opts.find((o) => o.id === reasonId);
  const photos = pod.current?.photos.length ?? 0;
  const flags = cur
    ? { label: cur.label, requiresPhoto: cur.requiresPhoto, requiresNote: cur.requiresNote }
    : undefined;
  const miss = problems(mode, { ...draft, reasonId }, flags, photos, lines);
  const ok = miss.length === 0 && !save.isPending;
  const set = (p: Partial<ReturnDraft>) => setDraft((x) => ({ ...x, ...p }));
  const unitOf = (lineNo: number) => pod.lines.find((l) => l.lineNo === lineNo)?.unit ?? '';
  const n = mode === 'failed' ? d.lines.length : draft.items.length;

  const hint = ok
    ? t(
        (draft.action === 'redeliver'
          ? mode === 'failed'
            ? 'prt.hintRedeliverFailed'
            : 'prt.hintRedeliver'
          : mode === 'failed'
            ? 'prt.hintReturnFailed'
            : 'prt.hintReturn') as MessageKey,
        { n },
      )
    : miss.includes('qty')
      ? t('prt.hintQty')
      : miss.includes('short') && miss.length === 1
        ? t('prt.hintShort')
        : `${mode === 'rejected' ? t('prt.hintPick') : ''}${flags?.requiresPhoto ? t('prt.hintPhoto') : ''}${flags?.requiresNote ? t('prt.hintNote') : ''}`.replace(
            /^ · /,
            '',
          );

  const submit = () => {
    if (!ok) return;
    setErr(null);
    save.mutate(
      {
        id: d.id,
        version: d.version,
        action: draft.action,
        body: bodyOf(mode, d, { ...draft, reasonId }),
      },
      {
        onSuccess: (r) => {
          onDone(
            r.redelivery
              ? t('prt.savedRedeliver', { no: r.redelivery.doNo, from: d.doNo })
              : t('prt.savedReturn', { no: d.doNo }),
          );
        },
        onError: (e) => {
          if (!(e instanceof ApiError)) return setErr(t('prt.e.save'));
          if (e.problem.status === 412) return setErr(t('prt.e.stale'));
          const codes = (e.problem.errors ?? []).map((x) => (x as { code: string }).code);
          if (codes.includes('nothing_open') || codes.includes('exceeds_open'))
            return setErr(t('prt.e.nothing'));
          if (codes.includes('photo_required')) return setErr(t('prt.e.photo'));
          setErr(problemText(e, t) ?? t('prt.e.save'));
        },
      },
    );
  };

  const title = mode === 'failed' ? t('prt.titleFailed') : t('prt.title');
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} ${d.doNo}`}
        onClick={(e) => e.stopPropagation()}
        data-testid="return-dialog"
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">
              {title}{' '}
              <span style={{ fontVariantNumeric: 'tabular-nums', color: '#2257C4' }}>{d.doNo}</span>
            </h2>
            <p className="tms-dialog__desc">
              {mode === 'failed' ? t('prt.descFailed') : t('prt.desc')}
            </p>
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            aria-label={t('drawer.close')}
            title={t('drawer.close')}
            onClick={onClose}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-dialog__body" style={{ gap: 16 }}>
          <div style={FIELD}>
            <span style={LABEL}>{t('prt.items')}</span>
            <div style={BOX}>
              {lines.map((l) => (
                <label
                  key={l.lineNo}
                  style={{ ...ROW, cursor: mode === 'failed' ? 'default' : 'pointer' }}
                >
                  <input
                    type="checkbox"
                    style={CHECK}
                    checked={draft.items.includes(l.lineNo)}
                    disabled={mode === 'failed'}
                    onChange={() =>
                      set({
                        items: draft.items.includes(l.lineNo)
                          ? draft.items.filter((x) => x !== l.lineNo)
                          : [...draft.items, l.lineNo],
                      })
                    }
                  />
                  <span style={{ flex: 1 }}>{l.description}</span>
                  {mode === 'rejected' && draft.items.includes(l.lineNo) ? (
                    // จำนวนบางส่วน (เริ่ม = คงเหลือ) — ช่องตัวเลขแบบช่องยอดส่งจริงของหลักฐานส่ง
                    <span
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      onClick={(e) => e.preventDefault()}
                    >
                      <input
                        inputMode="decimal"
                        aria-label={t('prt.qtyInput', { d: l.description })}
                        aria-invalid={!qtyOk(l.openRejectQty, draft.qty?.[l.lineNo]) || undefined}
                        value={draft.qty?.[l.lineNo] ?? l.openRejectQty}
                        onChange={(e) =>
                          set({ qty: { ...(draft.qty ?? {}), [l.lineNo]: e.target.value } })
                        }
                        style={{
                          width: 84,
                          height: 30,
                          padding: '0 8px',
                          border: `1px solid ${qtyOk(l.openRejectQty, draft.qty?.[l.lineNo]) ? '#CDD1C8' : '#B3322A'}`,
                          borderRadius: 8,
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          font: 'inherit',
                        }}
                      />
                      <span style={{ color: '#3B424C', fontVariantNumeric: 'tabular-nums' }}>
                        {t('prt.qtyOf', { n: fmtQty(l.openRejectQty), u: unitOf(l.lineNo) })}
                      </span>
                    </span>
                  ) : (
                    <span style={{ color: '#3B424C', fontVariantNumeric: 'tabular-nums' }}>
                      {t('prt.qty', {
                        n: fmtQty(mode === 'failed' ? l.qtyPlanned : l.openRejectQty),
                        u: unitOf(l.lineNo),
                      })}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>
          <div style={FIELD} role="radiogroup" aria-label={t('prt.action')}>
            <span style={LABEL}>{t('prt.action')}</span>
            <div style={BOX}>
              {(['redeliver', 'return'] as const).map((a) => (
                <label key={a} style={ROW}>
                  <input
                    type="radio"
                    name="rt-action"
                    style={CHECK}
                    checked={draft.action === a}
                    onChange={() => set({ action: a })}
                  />
                  <span style={{ flex: 1 }}>
                    {t(a === 'redeliver' ? 'prt.redeliver' : 'prt.return')}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <label style={FIELD}>
            <span style={LABEL}>
              {t('prt.reason')} <span style={{ color: '#B3322A' }}>*</span>
            </span>
            <select
              value={reasonId}
              onChange={(e) => set({ reasonId: e.target.value })}
              style={SELECT}
            >
              {opts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div style={FIELD}>
            <span style={LABEL}>
              {flags?.requiresPhoto ? t('prt.photoReq') : t('prt.photoOpt')}
            </span>
            {photos > 0 ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  border: '1px solid #D9DCD4',
                  borderRadius: 8,
                }}
              >
                <span
                  style={{
                    width: 48,
                    height: 36,
                    borderRadius: 999,
                    background: '#EBEDE8',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#3B424C',
                  }}
                >
                  <Icon n="image" s={16} />
                </span>
                <span>{t('prt.photoHave', { n: photos })}</span>
                <Icon n="check" s={16} style={{ color: '#17733F', marginLeft: 'auto' }} />
              </div>
            ) : (
              <span style={{ fontSize: 13, color: '#3B424C' }}>{t('prt.photoNone')}</span>
            )}
          </div>
          <label style={FIELD}>
            <span style={LABEL}>{flags?.requiresNote ? t('prt.noteReq') : t('prt.noteOpt')}</span>
            <textarea
              value={draft.note}
              onChange={(e) => set({ note: e.target.value })}
              rows={2}
              maxLength={500}
              placeholder={t('prt.notePh')}
              style={{
                border: '1px solid #C9CDC3',
                borderRadius: 8,
                padding: '8px 10px',
                resize: 'vertical',
                color: '#101418',
                font: 'inherit',
              }}
            />
          </label>
          <span style={{ fontSize: 13, color: ok ? '#17733F' : '#3B424C' }} data-testid="rt-hint">
            {hint}
          </span>
          {err && (
            <span className="tms-field-error" role="alert">
              {err}
            </span>
          )}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            aria-disabled={!ok}
            style={{ ...OK_BTN, opacity: ok ? 1 : 0.5, cursor: ok ? 'pointer' : 'not-allowed' }}
          >
            {t('prt.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
