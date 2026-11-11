import { useEffect, useState } from 'react';
import { markReviewed } from '../setup/SetupChecklist';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useSaveSequence, useSequences, type Sequence } from './useSettings';

/** ตั้งค่า → เลขที่เอกสาร (ST1-T15) — ตารางของต้นแบบ; ประเภทเอกสารตาม docs/01 §3.5 (ข้อยกเว้นประเภทเอกสารภาษี) */
export function NumbersSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const q = useSequences();
  // ST1-T21: ผู้ตั้งค่าเปิดดูชุดเลขเอกสารแล้ว = ยืนยันรูปแบบเริ่มต้น (หน้านี้ไม่มีปุ่มบันทึก — แก้แล้วบันทึกทันที)
  useEffect(() => {
    if (canWrite && q.data) void markReviewed('numbering');
  }, [canWrite, !!q.data]);
  return (
    <section className="set-card">
      <div className="set-card__hd set-card__hd--col">
        <h2>{t('set.menu.num')}</h2>
        <span>{t('num.hint')}</span>
      </div>
      <table className="set-tbl">
        <thead>
          <tr>
            <th>{t('num.col.type')}</th>
            <th>{t('num.col.prefix')}</th>
            <th>{t('num.col.pattern')}</th>
            <th>{t('num.col.next')}</th>
            <th>{t('num.col.reset')}</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.data ?? []).map((s) => (
            <Row key={s.id} s={s} canWrite={canWrite} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Row({ s, canWrite }: { s: Sequence; canWrite: boolean }) {
  const { t } = useI18n();
  const save = useSaveSequence();
  const [prefix, setPrefix] = useState(s.prefix);
  useEffect(() => setPrefix(s.prefix), [s.prefix]);
  const code = save.error instanceof ApiError ? save.error.problem.errors?.[0]?.code : undefined;
  const err = save.error ? t(code === 'series_in_use' ? 'num.inUse' : 'num.prefixInvalid') : '';
  const commit = (body: Record<string, unknown>) =>
    save.mutate({ id: s.id, version: s.version, body });
  return (
    <tr>
      <td>{t(`doc.${s.docType}` as MessageKey)}</td>
      <td>
        <input
          className="set-input"
          value={prefix}
          disabled={!canWrite}
          aria-label={`${t('num.col.prefix')} ${t(`doc.${s.docType}` as MessageKey)}`}
          aria-invalid={!!err || undefined}
          title={err || undefined}
          style={err ? { borderColor: '#B3322A' } : undefined}
          onChange={(e) => {
            setPrefix(e.target.value);
            save.reset();
          }}
          onBlur={() => prefix !== s.prefix && commit({ prefix })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </td>
      <td className="num" style={{ color: '#3B424C' }}>
        {s.pattern}
      </td>
      <td className="num" style={{ fontWeight: 500, color: '#2257C4' }}>
        {s.nextNumber ?? '—'}
      </td>
      <td>
        <select
          className="set-select"
          value={s.resetPolicy}
          disabled={!canWrite}
          aria-label={`${t('num.col.reset')} ${t(`doc.${s.docType}` as MessageKey)}`}
          title={err || undefined}
          style={err && code === 'series_in_use' ? { borderColor: '#B3322A' } : undefined}
          onChange={(e) => commit({ resetPolicy: e.target.value })}
        >
          {(['monthly', 'yearly', 'never'] as const).map((p) => (
            <option key={p} value={p}>
              {t(`num.reset.${p}`)}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}
