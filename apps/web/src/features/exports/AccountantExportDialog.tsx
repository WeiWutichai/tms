import { useQuery } from '@tanstack/react-query';
import { Icon, useEscapeLayer, useModalFocus } from '@tms/ui';
import { useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, unwrap } from '../../api';
import { TH_MONTHS, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { bangkokToday } from '../rate-cards/rateFormat';
import {
  runAccountantExport,
  xpPeriodTag,
  xpPeriods,
  type XpDataset,
  type XpFormat,
} from './accountantExport';

const LBL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const FIELD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
/** ต้นแบบ FM — ทั่วไปก่อน แล้วตามตัวอักษร · เปิดใช้เฉพาะรูปแบบที่ API มี (phase 0 = ทั่วไป) */
const FORMATS = [
  { k: 'generic', api: true },
  { k: 'express', api: false },
  { k: 'peak', api: false },
  { k: 'flowaccount', api: false },
] as const;
const FILE_TYPES: { k: XpFormat; l: string }[] = [
  { k: 'xlsx', l: 'Excel' },
  { k: 'csv', l: 'CSV' },
];

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={FIELD}>
      <span style={LBL}>{label}</span>
      {children}
    </div>
  );
}

/**
 * dialog "ส่งออกให้นักบัญชี" (ST7-T23; ต้นแบบ TMS v4 `openXp`/`vXp` — กรอบ 640 · งวด · ชนิดไฟล์ · ชุดข้อมูล · รูปแบบไฟล์ · ไฟล์ที่จะได้)
 * ความต่างจากต้นแบบ [DECISION spec/12 §3 แถว ST7-T23]: ชุด "หัก ณ ที่จ่าย (ภ.ง.ด.3/53)" ไม่มี (D-54/D-58 — ระบบบัญชี) ·
 * คำอธิบายชุดตามเอกสารที่ TMS มี (ไม่มีใบกำกับ/ใบลด-เพิ่มหนี้/ใบเสร็จ — D-54/D-56) · รูปแบบ Express/PEAK/FlowAccount แสดงแต่ปิด
 * (รอ template นำเข้าจริง — spec/07 INT-043) · จำนวนแถวในไฟล์ = แถวเอกสาร + แถวรายการ (layout กลาง) · แสดงเฉพาะชุดที่มีสิทธิ์อ่าน
 */
export function AccountantExportDialog({
  onClose,
  onToast,
}: {
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const periods = useMemo(() => xpPeriods(bangkokToday()), []);
  const [per, setPer] = useState<string>(periods[0]!.key);
  const [ft, setFt] = useState<XpFormat>('xlsx');
  const [off, setOff] = useState<Set<XpDataset>>(new Set());
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const tid = useId();
  useEscapeLayer(true, onClose);
  useModalFocus(true, box);
  const p = periods.find((x) => x.key === per) ?? periods[0]!;
  const summary = useQuery({
    queryKey: ['accounting-exports', 'summary', p.from, p.to],
    queryFn: () =>
      unwrap(
        api.GET('/v1/accounting-exports/summary', {
          params: { query: { dateFrom: p.from, dateTo: p.to } },
        }),
      ),
  });
  const monthText = (m: number, y: number) => `${TH_MONTHS[m - 1]} ${y + 543}`;
  const perLabel = (x: (typeof periods)[number]) =>
    x.key === 'last'
      ? monthText(x.month, x.year)
      : x.key === 'this'
        ? t('xp.thisMonth', { m: monthText(x.month, x.year) })
        : t('xp.quarter', { q: x.q ?? 1, y: x.year + 543 });
  const tag = xpPeriodTag(
    p.from,
    p.to,
    (m) => TH_MONTHS[m - 1]!,
    (q, y) => t('xp.tagQuarter', { q, y }),
  );
  const sets = (summary.data?.datasets ?? []).map((d) => ({
    ...d,
    k: d.dataset as XpDataset,
    on: !off.has(d.dataset as XpDataset),
  }));
  const files = sets
    .filter((s) => s.on)
    .map((s) => ({
      n: `${t(`xp.set.${s.k}` as MessageKey)}_${tag}.${ft}`,
      r: t('xp.rows', { n: s.rows }),
      resource: s.resource,
    }));
  const toggle = (k: XpDataset) =>
    setOff((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const ok = async () => {
    if (!files.length || busy) return;
    setBusy(true);
    try {
      const r = await runAccountantExport(
        files.map((f) => f.resource),
        ft,
        { dateFrom: p.from, dateTo: p.to },
      );
      onClose();
      if (r.failed) onToast(t(r.failed === 'too_many_rows' ? 'export.tooMany' : 'export.failed'));
      else if (r.queued) onToast(t('export.queued'));
      else onToast(t('xp.done', { n: r.done, f: t('xp.fmt.generic') }));
    } catch {
      setBusy(false);
      onToast(t('export.failed'));
    }
  };

  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        ref={box}
        className="tms-dialog"
        style={{ width: 640 }}
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
              {t('bill.xp')}
            </h2>
            <p className="tms-dialog__desc">{t('xp.desc')}</p>
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
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ ...FIELD, width: 240 }}>
              <span style={LBL}>{t('xp.period')}</span>
              <select
                value={per}
                onChange={(e) => setPer(e.target.value)}
                style={{
                  height: 36,
                  padding: '0 10px',
                  border: '1px solid #C9CDC3',
                  borderRadius: 8,
                  background: '#FFFFFF',
                  color: '#101418',
                  font: 'inherit',
                }}
              >
                {periods.map((x) => (
                  <option key={x.key} value={x.key}>
                    {perLabel(x)}
                  </option>
                ))}
              </select>
            </label>
            <Block label={t('xp.fileType')}>
              <div
                role="radiogroup"
                aria-label={t('xp.fileType')}
                style={{
                  display: 'inline-flex',
                  gap: 2,
                  padding: 3,
                  background: '#EBEDE8',
                  border: '1px solid #D9DCD4',
                  borderRadius: 8,
                }}
              >
                {FILE_TYPES.map((o) => {
                  const on = ft === o.k;
                  return (
                    <button
                      key={o.k}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setFt(o.k)}
                      style={{
                        height: 28,
                        padding: '0 14px',
                        border: 0,
                        borderRadius: 999,
                        background: on ? '#FFFFFF' : 'transparent',
                        color: on ? '#2257C4' : '#3B424C',
                        fontWeight: on ? 600 : 500,
                        boxShadow: on ? '0 1px 2px rgba(16,24,40,.08), 0 0 0 1px #D9DCD4' : 'none',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 'inherit',
                      }}
                    >
                      {o.l}
                    </button>
                  );
                })}
              </div>
            </Block>
          </div>
          <Block label={t('xp.sets')}>
            <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
              {summary.isError && (
                <div style={{ padding: '10px 12px', color: '#B3322A' }} role="alert">
                  {t('xp.loadFailed')}
                </div>
              )}
              {sets.map((s) => (
                <label
                  key={s.k}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderBottom: '1px solid #E4E6E0',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={s.on}
                    onChange={() => toggle(s.k)}
                    style={{ width: 16, height: 16, accentColor: '#2257C4', margin: 0 }}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <span style={{ fontWeight: 500 }}>{t(`xp.set.${s.k}` as MessageKey)}</span>
                    <span style={{ color: '#3B424C' }}>{t(`xp.set.${s.k}.d` as MessageKey)}</span>
                  </span>
                  <span style={{ color: '#3B424C', whiteSpace: 'nowrap' }}>
                    {t('xp.items', { n: s.documents })}
                  </span>
                </label>
              ))}
            </div>
          </Block>
          <Block label={t('xp.format')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {FORMATS.map((f) => {
                const on = f.k === 'generic';
                return (
                  <button
                    key={f.k}
                    type="button"
                    disabled={!f.api}
                    aria-pressed={on}
                    title={f.api ? undefined : t('xp.fmtSoon')}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '10px 12px',
                      border: `1px solid ${on ? '#2257C4' : '#D9DCD4'}`,
                      background: on ? '#EEF0EC' : '#FFFFFF',
                      borderRadius: 14,
                      cursor: f.api ? 'pointer' : 'not-allowed',
                      opacity: f.api ? 1 : 0.5,
                      textAlign: 'left',
                      color: '#101418',
                      fontFamily: 'inherit',
                      fontSize: 'inherit',
                    }}
                  >
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        border: `1.5px solid ${on ? '#2257C4' : '#C9CDC3'}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        marginTop: 3,
                        boxSizing: 'border-box',
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: on ? '#2257C4' : 'transparent',
                        }}
                      />
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontWeight: 500 }}>{t(`xp.fmt.${f.k}` as MessageKey)}</span>
                      <span style={{ color: '#3B424C' }}>{t(`xp.fmt.${f.k}.d` as MessageKey)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Block>
          <Block label={t('xp.files')}>
            {files.length ? (
              <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
                {files.map((f) => (
                  <div
                    key={f.n}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      borderBottom: '1px solid #E4E6E0',
                    }}
                  >
                    <Icon n="file-spreadsheet" s={16} style={{ color: '#17733F' }} />
                    <span
                      className="tms-num"
                      style={{ fontSize: 13, flex: 1, minWidth: 0, wordBreak: 'break-all' }}
                    >
                      {f.n}
                    </span>
                    <span style={{ color: '#3B424C', whiteSpace: 'nowrap' }}>{f.r}</span>
                  </div>
                ))}
              </div>
            ) : (
              <span style={{ color: '#3B424C' }}>{t('xp.noFiles')}</span>
            )}
          </Block>
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px', opacity: files.length ? 1 : 0.5 }}
            disabled={!files.length || busy}
            aria-busy={busy}
            onClick={() => void ok()}
          >
            <Icon n="download" s={16} />
            {t('xp.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
