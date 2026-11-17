import type { CSSProperties, ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { useReasonCodes } from '../settings/useReasonCodes';
import { anyShort, milli, qtyStr, rejectOf, type LinesDraft } from './actualQty';
import type { DoPod } from './usePod';

/*
 * ST4-T10 "จำนวนที่ส่งจริง" ในฟอร์มหลักฐานส่ง (เว็บ) — หัวข้อ/ข้อความ "แผน …" จาก TMS Driver App M4 (f.pd.items)
 * รายการ + เหตุผล + โน้ต ใช้สไตล์ dialog "ตีกลับบางส่วน" ของ TMS v4 (vRt: กรอบรายการ, select เหตุผล *, textarea โน้ต)
 * เหตุผล/โน้ตชุดเดียวต่อ DO ใช้กับทุกบรรทัดที่ส่งน้อยกว่าแผน · รูปที่เหตุผลบังคับ = รูปหลักฐานส่งด้านบน
 */
const H3: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };
const LABEL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const FIELD: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
};

const fmt = (v: string) => {
  const m = milli(v);
  if (m === null) return v;
  const [w, f] = qtyStr(m).split('.') as [string, string?];
  return `${BigInt(w).toLocaleString('th-TH')}${f ? `.${f}` : ''}`;
};

export function ActualQtySection({
  pod,
  draft,
  readOnly,
  onChange,
  error,
}: {
  pod: DoPod;
  draft: LinesDraft;
  readOnly: boolean;
  onChange: (d: LinesDraft) => void;
  error?: ReactNode;
}) {
  const { t } = useI18n();
  const reasons = useReasonCodes();
  const opts = (reasons.data ?? []).filter(
    (r) =>
      r.category === 'REJECTED_BY_RECEIVER' && (r.status === 'active' || r.id === draft.reason),
  );
  const cur = opts.find((r) => r.id === draft.reason);
  const short = anyShort(pod, draft);
  const lines = pod.lines ?? [];
  // ค่าที่บันทึกแล้ว (อ่านอย่างเดียว) — เหตุผลเป็นข้อความ snapshot ของหลักฐาน
  const saved = lines.find((l) => l.rejectReason)?.rejectReason?.label;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="actual-qty">
      <h3 style={H3}>{t('pod.q.title')}</h3>
      <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
        {lines.map((l, i) => {
          const v = draft.qty[l.lineNo] ?? l.qtyPlanned;
          const rej = rejectOf(l, v);
          const bad = rej === null;
          return (
            <div
              key={l.lineNo}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderBottom: i < lines.length - 1 ? '1px solid #E4E6E0' : 0,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span>{l.description}</span>
                <span
                  style={{ fontSize: 13, color: '#3B424C', fontVariantNumeric: 'tabular-nums' }}
                >
                  {t('pod.q.plan', { n: fmt(l.qtyPlanned), u: l.unit })}
                  {rej !== null && rej > 0n && (
                    <span style={{ color: '#B3322A' }}>
                      {' · '}
                      {t('pod.q.reject', { n: fmt(qtyStr(rej)), u: l.unit })}
                    </span>
                  )}
                </span>
              </span>
              <input
                value={v}
                disabled={readOnly}
                inputMode="decimal"
                aria-label={t('pod.q.input', { name: l.description })}
                aria-invalid={bad || undefined}
                onChange={(e) =>
                  onChange({ ...draft, qty: { ...draft.qty, [l.lineNo]: e.target.value } })
                }
                style={{
                  ...FIELD,
                  width: 96,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  color: !bad && rej !== null && rej > 0n ? '#B3322A' : '#101418',
                  borderColor: bad ? '#B3322A' : '#C9CDC3',
                }}
              />
              <span style={{ color: '#3B424C', minWidth: 40 }}>{l.unit}</span>
            </div>
          );
        })}
      </div>
      {short && (
        <>
          <span style={{ fontSize: 13, color: '#B3322A', fontWeight: 500 }}>
            {t('pod.q.shortMsg')}
          </span>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={LABEL}>
              {t('pod.q.reason')} <span style={{ color: '#B3322A' }}>*</span>
            </span>
            <select
              value={draft.reason}
              disabled={readOnly}
              onChange={(e) => onChange({ ...draft, reason: e.target.value })}
              style={FIELD}
            >
              <option value="">{readOnly && saved ? saved : t('pod.q.reasonPick')}</option>
              {opts.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {cur?.requiresPhoto && (
            <span style={{ fontSize: 12.5, color: '#3B424C' }}>{t('pod.q.photoReq')}</span>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={LABEL}>{t(cur?.requiresNote ? 'pod.q.noteReq' : 'pod.q.noteOpt')}</span>
            <textarea
              value={draft.note}
              disabled={readOnly}
              rows={2}
              maxLength={500}
              placeholder={t('pod.q.notePh')}
              onChange={(e) => onChange({ ...draft, note: e.target.value })}
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
        </>
      )}
      {error}
    </div>
  );
}
