import type { Schemas } from '@tms/contracts';
import { Icon } from '@tms/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

export type PodField = Schemas['PodFieldDto'];
export type PodLevel = PodField['level'];
/** ชุดต่อผลการส่ง (ST4-T06): success = ส่งสำเร็จ · failure = ส่งไม่สำเร็จ */
export type PodSetKey = 'success' | 'failure';
export const POD_SETS: PodSetKey[] = ['success', 'failure'];

const LEVELS: PodLevel[] = ['DISABLED', 'ENABLED', 'REQUIRED'];
/** สูงสุดตาม API (ST4-T05/T06: รูปขั้นต่ำ 1–5, ข้อยืนยัน/คำถาม ≤ 10 ข้อ, ตัวเลือก 2–10, PIN 4–8 หลัก, คะแนนเต็ม 3–10) */
const MIN_COUNT_MAX = 5;
export const POD_BOOLEAN_MAX = 10;
export const POD_CHOICE_MAX = 10;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 10;
const PIN_LENGTHS = [4, 5, 6, 7, 8];
const RATING_MAXES = [3, 4, 5, 6, 7, 8, 9, 10];
const CUSTOM = ['BOOLEAN', 'SINGLE_CHOICE'];

const chk = {
  width: 16,
  height: 16,
  accentColor: '#2257C4',
  margin: 0,
  cursor: 'pointer',
} as const;
const inp = {
  height: 32,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  font: 'inherit',
} as const;

/** key ใหม่ของข้อยืนยัน (BOOLEAN `check_N`) / คำถามเลือกตอบ (SINGLE_CHOICE `choice_N`) — ไม่ซ้ำกับที่มี */
export function nextCheckKey(fields: PodField[], prefix: 'check' | 'choice' = 'check'): string {
  let i = 1;
  while (fields.some((f) => f.key === `${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

/** ชื่อแถว: ข้อยืนยัน/คำถาม = ข้อความที่ตั้ง · อื่น = ชื่อชนิด */
export function podFieldName(
  t: (k: MessageKey, p?: Record<string, string | number>) => string,
  f: PodField,
): string {
  return CUSTOM.includes(f.type) && f.label ? f.label : t(`pod.type.${f.type}` as MessageKey);
}

/** สรุปอ่านง่ายสำหรับแท็บ กิจกรรม (ไม่แสดง JSON ดิบ — review T05 L3) */
export function podSummary(
  t: (k: MessageKey, p?: Record<string, string | number>) => string,
  v: unknown,
): string {
  const req = v as Partial<Record<PodSetKey, { fields?: PodField[] }>> | null;
  const one = (fields: PodField[]) =>
    fields
      // ชนิดที่ไม่ใช้ไม่แสดงในสรุป (แถวใหม่ของ T06 เป็น "ไม่ใช้" — ไม่ให้สรุปยาวเกิน)
      .filter((f) => f.level !== 'DISABLED' || ['PHOTO', 'SIGNATURE', 'NOTE'].includes(f.type))
      .map((f) => {
        const name = podFieldName(t, f);
        const lv = t(`pod.lv.${f.level}` as MessageKey);
        return f.type === 'PHOTO' && f.level === 'REQUIRED' && (f.minCount ?? 1) > 1
          ? `${name}: ${lv} (≥ ${f.minCount})`
          : `${name}: ${lv}`;
      })
      .join(' · ');
  const parts = POD_SETS.filter((k) => req?.[k]?.fields).map(
    (k) => `${t(`pod.set.${k}` as MessageKey)} — ${one(req![k]!.fields!) || '-'}`,
  );
  return parts.length ? parts.join(' | ') : t('pod.cust.default');
}

/** ตัวเลือกของคำถามเลือกตอบผิด: น้อยกว่า 2 / ว่าง / ซ้ำ */
export const podOptionsInvalid = (f: PodField) => {
  const o = (f.options ?? []).map((x) => x.trim());
  return o.length < OPTIONS_MIN || o.some((x) => !x) || new Set(o).size !== o.length;
};

/** ข้อยืนยัน/คำถามที่ยังไม่กรอกข้อความ หรือตัวเลือกไม่ครบ (API ตอบ 422 — ตรวจก่อนส่ง) */
export const podChecklistInvalid = (fields: PodField[]) =>
  fields.some(
    (f) =>
      (CUSTOM.includes(f.type) && !(f.label ?? '').trim()) ||
      (f.type === 'SINGLE_CHOICE' && podOptionsInvalid(f)),
  );

/** ตัดช่องว่างข้อความ/ตัวเลือกก่อนส่ง */
export const podTrim = (fields: PodField[]): PodField[] =>
  fields.map((f) => ({
    ...f,
    ...(f.label !== undefined ? { label: f.label.trim() } : {}),
    ...(f.options ? { options: f.options.map((o) => o.trim()) } : {}),
  }));

/** แท็บสลับชุด ส่งสำเร็จ / ส่งไม่สำเร็จ (ST4-T06) — รูปแบบแท็บของ ตั้งค่า → ผู้ใช้ (set-tabs) */
export function PodSetTabs({
  value,
  onChange,
  label,
}: {
  value: PodSetKey;
  onChange: (k: PodSetKey) => void;
  label: string;
}) {
  const { t } = useI18n();
  return (
    <div className="set-tabs" role="tablist" aria-label={label}>
      {POD_SETS.map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={value === k}
          onClick={() => onChange(k)}
        >
          {t(`pod.set.${k}` as MessageKey)}
        </button>
      ))}
    </div>
  );
}

const optBtn = {
  width: 24,
  height: 24,
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: '#59606B',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
} as const;

/** ตัวแก้ตัวเลือกของคำถามเลือกตอบ (SINGLE_CHOICE) */
function OptionsEditor({
  f,
  ro,
  onChange,
}: {
  f: PodField;
  ro: boolean;
  onChange: (options: string[]) => void;
}) {
  const { t } = useI18n();
  const opts = f.options ?? [];
  if (ro)
    return (
      <span style={{ color: '#3B424C' }}>
        {t('pod.options')}: {opts.join(' / ')}
      </span>
    );
  const bad = podOptionsInvalid(f);
  return (
    <div
      role="group"
      aria-label={`${t('pod.options')} — ${podFieldName(t, f)}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', width: '100%' }}
    >
      <span style={{ color: '#3B424C' }}>{t('pod.options')}</span>
      {opts.map((o, j) => (
        <span key={j} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input
            aria-label={t('pod.optionN', { n: j + 1 })}
            placeholder={t('pod.optionN', { n: j + 1 })}
            maxLength={50}
            value={o}
            onChange={(e) => onChange(opts.map((x, i) => (i === j ? e.target.value : x)))}
            style={{
              ...inp,
              width: 120,
              borderColor:
                !o.trim() || opts.filter((x) => x.trim() === o.trim()).length > 1
                  ? '#B3322A'
                  : '#C9CDC3',
            }}
          />
          {opts.length > OPTIONS_MIN && (
            <button
              type="button"
              aria-label={`${t('pod.removeOption')} ${j + 1}`}
              title={t('pod.removeOption')}
              onClick={() => onChange(opts.filter((_, i) => i !== j))}
              style={optBtn}
            >
              <Icon n="x" s={14} />
            </button>
          )}
        </span>
      ))}
      {opts.length < OPTIONS_MAX && (
        <button
          type="button"
          className="set-btn2"
          onClick={() => onChange([...opts, ''])}
          style={{ height: 32 }}
        >
          <Icon n="plus" s={14} />
          {t('pod.addOption')}
        </button>
      )}
      {bad && <span className="tms-field-error">{t('pod.v.options')}</span>}
    </div>
  );
}

/**
 * ตาราง POD checklist (ST4-T05; docs/04 E2) — ใช้ทั้ง ตั้งค่า → หลักฐานส่ง (ค่าองค์กร) และ drawer ลูกค้า แท็บ เงื่อนไข
 * ต้นแบบไม่มีหน้านี้ — ใช้รูปแบบตารางติ๊กของ ตั้งค่า → เหตุผล (set-tbl + checkbox 16px) [DECISION spec/12 §3]
 * แถว: รูปหลักฐาน (+ จำนวนขั้นต่ำเมื่อบังคับ) / ลายเซ็นผู้รับ / หมายเหตุ / ข้อยืนยันที่เพิ่มเอง · คอลัมน์ ไม่ใช้ / ไม่บังคับ / บังคับ
 */
export function PodChecklistTable({
  fields,
  onChange,
  disabled,
  label,
  inset,
}: {
  /** อยู่ในการ์ดตั้งค่า (ตารางชิดขอบ) → เว้นขอบแถวปุ่มเพิ่ม 20px */
  inset?: boolean;
  fields: PodField[];
  onChange?: (fields: PodField[]) => void;
  disabled?: boolean;
  /** ชื่อกลุ่มสำหรับ screen reader */
  label: string;
}) {
  const { t } = useI18n();
  const gid = useId();
  const box = useRef<HTMLDivElement>(null);
  // ข้อยืนยันที่เพิ่งเพิ่ม → ย้ายโฟกัสไปช่องข้อความ (QA L4)
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (!focusKey) return;
    box.current
      ?.querySelector<HTMLInputElement>(`tr[data-pod="${focusKey}"] input:not([type])`)
      ?.focus();
    setFocusKey(null);
  }, [focusKey]);
  const ro = disabled || !onChange;
  const put = (i: number, p: Partial<PodField>) =>
    onChange?.(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const name = (f: PodField) => podFieldName(t, f);
  const checks = fields.filter((f) => f.type === 'BOOLEAN').length;
  const choices = fields.filter((f) => f.type === 'SINGLE_CHOICE').length;
  const numSel = (
    f: PodField,
    i: number,
    prop: 'length' | 'max',
    values: number[],
    pre: MessageKey,
    unit: MessageKey,
    aria: MessageKey,
  ) =>
    ro ? (
      <span style={{ color: '#3B424C' }}>
        {t(pre)} {f[prop]} {t(unit)}
      </span>
    ) : (
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#3B424C' }}>
        {t(pre)}
        <select
          aria-label={t(aria)}
          value={f[prop]}
          onChange={(e) => put(i, { [prop]: Number(e.target.value) })}
          style={{ ...inp, padding: '0 6px' }}
        >
          {values.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {t(unit)}
      </label>
    );
  return (
    <div className="set-scroll" role="group" aria-label={label} ref={box}>
      <table className="set-tbl">
        <thead>
          <tr>
            <th>{t('pod.col.item')}</th>
            {LEVELS.map((l) => (
              <th key={l} className="c">
                {t(`pod.lv.${l}` as MessageKey)}
              </th>
            ))}
            <th aria-label={t('pod.col.actions')} />
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={f.key} data-pod={f.key}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  {CUSTOM.includes(f.type) && !ro ? (
                    <input
                      aria-label={t(f.type === 'BOOLEAN' ? 'pod.checkLabel' : 'pod.choiceLabel')}
                      placeholder={t(f.type === 'BOOLEAN' ? 'pod.checkPh' : 'pod.choicePh')}
                      maxLength={100}
                      value={f.label ?? ''}
                      onChange={(e) => put(i, { label: e.target.value })}
                      style={{
                        ...inp,
                        width: 280,
                        borderColor: (f.label ?? '').trim() ? '#C9CDC3' : '#B3322A',
                      }}
                    />
                  ) : (
                    <span style={{ fontWeight: 500 }}>{name(f)}</span>
                  )}
                  {CUSTOM.includes(f.type) && (
                    <span style={{ color: '#59606B', fontSize: 12.5 }}>
                      {t(`pod.type.${f.type}` as MessageKey)}
                    </span>
                  )}
                  {f.type === 'PIN' &&
                    f.level !== 'DISABLED' &&
                    numSel(
                      f,
                      i,
                      'length',
                      PIN_LENGTHS,
                      'pod.pinLen',
                      'pod.pinUnit',
                      'pod.pinLenLabel',
                    )}
                  {f.type === 'RATING' &&
                    f.level !== 'DISABLED' &&
                    numSel(
                      f,
                      i,
                      'max',
                      RATING_MAXES,
                      'pod.ratingMax',
                      'pod.ratingUnit',
                      'pod.ratingMaxLabel',
                    )}
                  {f.type === 'SINGLE_CHOICE' && (
                    <OptionsEditor f={f} ro={ro} onChange={(options) => put(i, { options })} />
                  )}
                  {f.type === 'PHOTO' && f.level === 'REQUIRED' && ro && (
                    // อ่านอย่างเดียว: แสดงเป็นข้อความ ไม่ใช่ select ที่กดไม่ได้ (QA L5)
                    <span style={{ color: '#3B424C' }}>
                      {t('pod.minCount')} {f.minCount ?? 1} {t('pod.photoUnit')}
                    </span>
                  )}
                  {f.type === 'PHOTO' && f.level === 'REQUIRED' && !ro && (
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        color: '#3B424C',
                      }}
                    >
                      {t('pod.minCount')}
                      <select
                        aria-label={t('pod.minCountLabel')}
                        value={f.minCount ?? 1}
                        disabled={ro}
                        onChange={(e) => put(i, { minCount: Number(e.target.value) })}
                        style={{ ...inp, padding: '0 6px' }}
                      >
                        {Array.from({ length: MIN_COUNT_MAX }, (_, n) => n + 1).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      {t('pod.photoUnit')}
                    </label>
                  )}
                </div>
              </td>
              {LEVELS.map((l) => (
                <td key={l} className="c">
                  <input
                    type="radio"
                    name={`${gid}-${f.key}`}
                    aria-label={`${t(`pod.lv.${l}` as MessageKey)} — ${name(f)}`}
                    checked={f.level === l}
                    disabled={ro}
                    onChange={() => put(i, { level: l })}
                    style={{ ...chk, ...(ro ? { cursor: 'not-allowed' } : {}) }}
                  />
                </td>
              ))}
              <td className="c" style={{ width: 48 }}>
                {CUSTOM.includes(f.type) && !ro && (
                  <button
                    type="button"
                    aria-label={`${t(f.type === 'BOOLEAN' ? 'pod.removeCheck' : 'pod.removeChoice')} — ${name(f)}`}
                    title={t(f.type === 'BOOLEAN' ? 'pod.removeCheck' : 'pod.removeChoice')}
                    onClick={() => onChange?.(fields.filter((_, j) => j !== i))}
                    style={{
                      width: 28,
                      height: 28,
                      border: 0,
                      borderRadius: 8,
                      background: 'transparent',
                      color: '#59606B',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon n="trash-2" s={16} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!ro && (
        <div
          style={{
            padding: inset ? '12px 20px 16px' : '12px 0 0',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <button
            type="button"
            className="set-btn2"
            disabled={checks >= POD_BOOLEAN_MAX}
            onClick={() => {
              const key = nextCheckKey(fields);
              onChange?.([...fields, { key, type: 'BOOLEAN', level: 'REQUIRED', label: '' }]);
              setFocusKey(key);
            }}
          >
            <Icon n="plus" s={16} />
            {t('pod.addCheck')}
          </button>
          <button
            type="button"
            className="set-btn2"
            disabled={choices >= POD_CHOICE_MAX}
            onClick={() => {
              const key = nextCheckKey(fields, 'choice');
              onChange?.([
                ...fields,
                { key, type: 'SINGLE_CHOICE', level: 'REQUIRED', label: '', options: ['', ''] },
              ]);
              setFocusKey(key);
            }}
          >
            <Icon n="plus" s={16} />
            {t('pod.addChoice')}
          </button>
          <span style={{ color: '#59606B', fontSize: 12.5 }}>
            {checks >= POD_BOOLEAN_MAX
              ? t('pod.max')
              : choices >= POD_CHOICE_MAX
                ? t('pod.maxChoice')
                : t('pod.checkHint')}
          </span>
        </div>
      )}
    </div>
  );
}
