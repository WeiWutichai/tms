import type { Schemas } from '@tms/contracts';
import { Icon } from '@tms/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

export type PodField = Schemas['PodFieldDto'];
export type PodLevel = PodField['level'];

const LEVELS: PodLevel[] = ['DISABLED', 'ENABLED', 'REQUIRED'];
/** สูงสุดตาม API (ST4-T05: รูปขั้นต่ำ 1–5, ข้อยืนยัน ≤ 10 ข้อ) */
const MIN_COUNT_MAX = 5;
export const POD_BOOLEAN_MAX = 10;

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

/** key ใหม่ของข้อยืนยัน (BOOLEAN) — ไม่ซ้ำกับที่มี */
export function nextCheckKey(fields: PodField[]): string {
  let i = 1;
  while (fields.some((f) => f.key === `check_${i}`)) i++;
  return `check_${i}`;
}

/** สรุปอ่านง่ายสำหรับแท็บ กิจกรรม (ไม่แสดง JSON ดิบ — review T05 L3) */
export function podSummary(
  t: (k: MessageKey, p?: Record<string, string | number>) => string,
  v: unknown,
): string {
  const fields = (v as { success?: { fields?: PodField[] } } | null)?.success?.fields;
  if (!fields) return t('pod.cust.default');
  return fields
    .map((f) => {
      const name =
        f.type === 'BOOLEAN'
          ? f.label || t('pod.type.BOOLEAN')
          : t(`pod.type.${f.type}` as MessageKey);
      const lv = t(`pod.lv.${f.level}` as MessageKey);
      return f.type === 'PHOTO' && f.level === 'REQUIRED' && (f.minCount ?? 1) > 1
        ? `${name}: ${lv} (≥ ${f.minCount})`
        : `${name}: ${lv}`;
    })
    .join(' · ');
}

/** ข้อยืนยันที่ยังไม่กรอกข้อความ (API ตอบ 422 — ตรวจก่อนส่ง) */
export const podChecklistInvalid = (fields: PodField[]) =>
  fields.some((f) => f.type === 'BOOLEAN' && !(f.label ?? '').trim());

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
      ?.querySelector<HTMLInputElement>(
        `tr[data-pod="${focusKey}"] input[type="text"], tr[data-pod="${focusKey}"] input:not([type])`,
      )
      ?.focus();
    setFocusKey(null);
  }, [focusKey]);
  const ro = disabled || !onChange;
  const put = (i: number, p: Partial<PodField>) =>
    onChange?.(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const name = (f: PodField) =>
    f.type === 'BOOLEAN' ? f.label || t('pod.type.BOOLEAN') : t(`pod.type.${f.type}` as MessageKey);
  const checks = fields.filter((f) => f.type === 'BOOLEAN').length;
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
                  {f.type === 'BOOLEAN' && !ro ? (
                    <input
                      aria-label={t('pod.checkLabel')}
                      placeholder={t('pod.checkPh')}
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
                  {f.type === 'BOOLEAN' && (
                    <span style={{ color: '#59606B', fontSize: 12.5 }}>
                      {t('pod.type.BOOLEAN')}
                    </span>
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
                {f.type === 'BOOLEAN' && !ro && (
                  <button
                    type="button"
                    aria-label={`${t('pod.removeCheck')} — ${name(f)}`}
                    title={t('pod.removeCheck')}
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
          <span style={{ color: '#59606B', fontSize: 12.5 }}>
            {checks >= POD_BOOLEAN_MAX ? t('pod.max') : t('pod.checkHint')}
          </span>
        </div>
      )}
    </div>
  );
}
