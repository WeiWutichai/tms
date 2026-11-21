import { Icon, useEscapeLayer, useModalFocus } from '@tms/ui';
import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { bangkokToday, money, useDateText } from '../rate-cards/rateFormat';
import { actionErrorText, amountRows } from './settle';
import { useMarkPaid, useSettlement, type SettlementPayInput } from './useSettlements';

const METHODS = ['TRANSFER', 'CHEQUE', 'CASH'] as const;
const LBL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const INPUT: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  font: 'inherit',
  boxSizing: 'border-box',
  width: '100%',
};

function F({ label, span, children }: { label: string; span?: boolean; children: ReactNode }) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
        gridColumn: span ? 'span 2' : undefined,
      }}
    >
      <span style={LBL}>{label}</span>
      {children}
    </label>
  );
}

/**
 * dialog "บันทึกจ่าย" (ST6-T09; ต้นแบบ TMS v4 vSp — กรอบ 520 · ตารางยอด + "จ่ายสุทธิ" · วิธีจ่าย / วันที่จ่าย / เลขอ้างอิง)
 * ความต่างจากต้นแบบ [DECISION spec/12 §3 แถวหน้า settle]: ตัดกล่อง "ออกหนังสือรับรอง 50 ทวิ" (D-54/D-58 — ออกที่ระบบบัญชี) ·
 * ไม่เพิ่มช่องธนาคาร (API ไม่บังคับ — ต้นแบบไม่มี) · error ของ API แสดงในกล่อง (D-60 ผู้อนุมัติจ่ายเอง 403 · สถานะเปลี่ยน 409 · 412 · ข้อมูลช่อง 422)
 */
export function MarkPaidDialog({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: (no: string) => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const q = useSettlement(id);
  const pay = useMarkPaid();
  const [method, setMethod] = useState<SettlementPayInput['method']>('TRANSFER');
  const [date, setDate] = useState(bangkokToday());
  const [ref, setRef] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const tid = useId();
  useEscapeLayer(true, onClose);
  useModalFocus(true, box);
  const s = q.data;
  const err = actionErrorText(pay.error, t);
  const submit = () => {
    if (!s || pay.isPending) return;
    pay.mutate(
      {
        id: s.id,
        version: s.version,
        body: {
          paidDate: date,
          method,
          ...(ref.trim() ? { reference: ref.trim() } : {}),
        },
      },
      {
        onSuccess: (r) => onDone(r.settlementNo ?? ''),
        // 412 = มีคนแก้ใบแล้ว → โหลดใบใหม่ให้กดครั้งถัดไปใช้ version ล่าสุด
        onError: () => void q.refetch(),
      },
    );
  };
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        ref={box}
        className="tms-dialog"
        style={{ width: 520 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={tid}
        tabIndex={-1}
        data-modal-focus=""
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 id={tid} className="tms-dialog__title">
              {t('settle.pay.title')}{' '}
              <span className="tms-num" style={{ color: '#2257C4' }}>
                {s?.settlementNo ?? ''}
              </span>
            </h2>
            <p className="tms-dialog__desc">{s?.carrier.legalName ?? '…'}</p>
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
        <div className="tms-dialog__body">
          {s && (
            <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
              {amountRows(t, s).map((r) => (
                <div
                  key={r.k}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderBottom: '1px solid #E4E6E0',
                  }}
                >
                  <span>{r.k}</span>
                  <span className="tms-num" style={{ fontSize: 13 }}>
                    {r.v}
                  </span>
                </div>
              ))}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  background: '#EEF0EC',
                }}
              >
                <span style={{ fontWeight: 600 }}>{t('settle.amt.net')}</span>
                <span className="tms-num" style={{ fontSize: 13, fontWeight: 600 }}>
                  {t('ord.baht', { n: money(s.buyNetAfterWht) })}
                </span>
              </div>
            </div>
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
              gap: 12,
            }}
          >
            <F label={t('settle.pay.method')}>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as SettlementPayInput['method'])}
                style={INPUT}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`settle.pay.m.${m}` as MessageKey)}
                  </option>
                ))}
              </select>
            </F>
            <F label={t('settle.pay.date')}>
              {/* ต้นแบบเป็นช่องข้อความวันที่ — ใช้ input date โปร่งใสทับ (แบบช่องวันที่ของหน้ารับชำระ) */}
              <span
                style={{ ...INPUT, position: 'relative', display: 'flex', alignItems: 'center' }}
              >
                <span className="tms-num">{dateText(date)}</span>
                <input
                  type="date"
                  aria-label={t('settle.pay.date')}
                  value={date}
                  max={bangkokToday()}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    opacity: 0,
                    width: '100%',
                    height: '100%',
                    border: 0,
                    padding: 0,
                    margin: 0,
                    cursor: 'pointer',
                  }}
                />
              </span>
            </F>
            <F label={t('settle.pay.ref')} span>
              <input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder={t('settle.pay.refPh')}
                maxLength={120}
                className="tms-num"
                style={{ ...INPUT, fontSize: 13 }}
              />
            </F>
          </div>
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
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={!s || pay.isPending}
            aria-busy={pay.isPending}
            onClick={submit}
          >
            <Icon n="banknote" s={16} />
            {t('settle.pay.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
