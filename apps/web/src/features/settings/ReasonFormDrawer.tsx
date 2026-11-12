import { FormDrawer, FormField, Icon, TextInput } from '@tms/ui';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { fieldErrors, isStale, problemText } from '../master/problems';
import {
  CATEGORIES,
  FLAG_ALLOWED,
  useCreateReason,
  useUpdateReason,
  type ReasonCategory,
  type ReasonCode,
  type ReasonFlag,
  type ReasonInput,
} from './useReasonCodes';

interface Form {
  cat: ReasonCategory;
  label: string;
  code: string;
  flags: Record<ReasonFlag, boolean>;
}

/** ค่าเริ่มต้นตามต้นแบบ addReason(): หมวด ตีกลับ, บังคับรูป + บังคับโน้ต, ไม่นัดส่งใหม่ */
const EMPTY: Form = {
  cat: 'REJECTED_BY_RECEIVER',
  label: '',
  code: '',
  flags: { requiresPhoto: true, requiresNote: true, autoReschedule: false, showOnTracking: false },
};
const FLAGS: Array<[ReasonFlag, MessageKey]> = [
  ['requiresPhoto', 'rsn.col.photo'],
  ['requiresNote', 'rsn.col.note'],
  ['autoReschedule', 'rsn.col.rs'],
  ['showOnTracking', 'rsn.col.trk'],
];
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };

const toForm = (r: ReasonCode): Form => ({
  cat: r.category,
  label: r.label,
  code: r.code,
  flags: {
    requiresPhoto: r.requiresPhoto,
    requiresNote: r.requiresNote,
    autoReschedule: r.autoReschedule,
    showOnTracking: r.showOnTracking,
  },
});

/**
 * "เพิ่มเหตุผล" / "แก้ไขเหตุผล" — ต้นแบบ addReason() เพิ่มแถว "เหตุผลใหม่" (ตีกลับ, บังคับรูป+โน้ต) ในตารางโดยไม่มีที่แก้ข้อความ/หมวด
 * → ใช้ฟอร์ม drawer แบบเดียวกับ master อื่น (cfOpen) [OPEN spec/12 §3] · ค่าเริ่มต้นตามต้นแบบ
 * หมวดเปลี่ยนไม่ได้หลังสร้าง · รหัสของระบบเปลี่ยนไม่ได้ · ธงที่ใช้กับหมวดไม่ได้ถูกปิด (กฎเดียวกับ API)
 * ปุ่มปิดใช้/เปิดใช้/ลบ อยู่ที่แถบล่างของฟอร์มแก้ไข (ต้นแบบไม่มี — ไม่มี drawer รายละเอียดของเหตุผล)
 */
export function ReasonFormDrawer({
  open,
  item,
  onClose,
  onSaved,
  onAction,
}: {
  open: boolean;
  item?: ReasonCode | null;
  onClose: () => void;
  onSaved: (r: ReasonCode, created: boolean) => void;
  onAction: (r: ReasonCode, a: 'activate' | 'deactivate' | 'delete') => void;
}) {
  const { t } = useI18n();
  const editing = !!item;
  const create = useCreateReason();
  const update = useUpdateReason();
  const m = editing ? update : create;
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const openKey = open ? (item?.id ?? 'new') : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (openKey !== shownFor) {
    setShownFor(openKey);
    if (openKey !== null) {
      setF(item ? toForm(item) : EMPTY);
      setTried(false);
    }
  }
  useEffect(() => {
    if (open) {
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      create.reset();
      update.reset();
    }
  }, [open, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const allowed = (k: ReasonFlag) => FLAG_ALLOWED[k](f.cat);
  const locked = (k: ReasonFlag) => k === 'requiresNote' && !!item?.system && item.code === 'OTHER';
  const code = f.code.trim().toUpperCase();

  const local: Record<string, string> = {};
  if (!f.label.trim()) local.label = t('rsn.v.label');
  if (code && !CODE_RE.test(code)) local.code = t('rsn.v.code');
  const server = fieldErrors(m.error, t);
  if (
    m.error instanceof ApiError &&
    m.error.problem.errors?.some((e) => e.field === 'label' && e.code === 'duplicate')
  )
    server.label = t('rsn.v.dup');
  const errs = { ...(tried ? local : {}), ...server };
  const topErr =
    m.error && !Object.keys(server).length
      ? isStale(m.error)
        ? t('rsn.stale')
        : problemText(m.error, t)
      : null;

  const flagsFor = (cat: ReasonCategory) =>
    Object.fromEntries(FLAGS.map(([k]) => [k, FLAG_ALLOWED[k](cat) && f.flags[k]])) as Record<
      ReasonFlag,
      boolean
    >;

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current) return;
    submitting.current = true;
    const done = {
      onError: () => setIdemKey(crypto.randomUUID()),
      onSettled: () => {
        submitting.current = false;
      },
    };
    const flags = flagsFor(f.cat);
    if (item) {
      const body: ReasonInput = {};
      if (f.label.trim() !== item.label) body.label = f.label.trim();
      if (!item.system && code && code !== item.code) body.code = code;
      for (const [k] of FLAGS) if (flags[k] !== item[k]) body[k] = flags[k];
      if (!Object.keys(body).length) {
        submitting.current = false;
        return onClose();
      }
      update.mutate(
        { id: item.id, version: item.version, body },
        { ...done, onSuccess: (r) => onSaved(r, false) },
      );
    } else
      create.mutate(
        {
          idempotencyKey: idemKey,
          body: { category: f.cat, label: f.label.trim(), ...(code ? { code } : {}), ...flags },
        },
        { ...done, onSuccess: (r) => onSaved(r, true) },
      );
  };

  const btn2: CSSProperties = { height: 40, padding: '0 14px' };
  return (
    <FormDrawer
      open={open}
      title={editing ? t('rsn.edit.title') : t('rsn.create.title')}
      subtitle={editing ? item?.code : t('rsn.create.sub')}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      {...(tried && Object.keys(local).length
        ? { alert: t('form.incomplete', { n: Object.keys(local).length }) }
        : {})}
      onSubmit={submit}
      footer={
        <>
          {item && !item.system && (
            <>
              <button
                type="button"
                className="tms-fdrawer__cancel"
                style={btn2}
                onClick={() => onAction(item, item.status === 'active' ? 'deactivate' : 'activate')}
              >
                {t(item.status === 'active' ? 'rsn.act.off' : 'rsn.act.on')}
              </button>
              <button
                type="button"
                className="tms-fdrawer__cancel"
                style={{ ...btn2, color: '#B3322A' }}
                onClick={() => onAction(item, 'delete')}
              >
                {t('rsn.act.delete')}
              </button>
            </>
          )}
          <button type="button" className="tms-fdrawer__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 40, padding: '0 18px' }}
            disabled={m.isPending}
          >
            {editing ? t('common.save') : t('rsn.add')}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      {item?.system && (
        <div
          role="note"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderRadius: 8,
            background: '#EEF0EC',
            color: '#3B424C',
          }}
        >
          <Icon n="lock" s={16} />
          {t('rsn.systemHint')}
        </div>
      )}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          <FormField label={t('rsn.f.cat')} required error={errs.category}>
            {(p) => (
              <select
                {...p}
                className="tms-select"
                style={SEL}
                value={f.cat}
                disabled={editing}
                onChange={(e) => setF((x) => ({ ...x, cat: e.target.value as ReasonCategory }))}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`rsn.cat.${c}` as MessageKey)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            label={t('rsn.f.code')}
            error={errs.code}
            {...(editing ? {} : { hint: t('rsn.f.codeHint') })}
          >
            {(p) => (
              <TextInput
                {...p}
                value={f.code}
                maxLength={40}
                disabled={!!item?.system}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, code: v }));
                }}
              />
            )}
          </FormField>
          <FormField label={t('rsn.f.label')} required span={2} error={errs.label}>
            {(p) => (
              <TextInput
                {...p}
                autoFocus
                maxLength={100}
                value={f.label}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, label: v }));
                }}
              />
            )}
          </FormField>
          <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="tms-label">{t('rsn.f.flags')}</span>
            {FLAGS.map(([k, l]) => {
              const ok = allowed(k) && !locked(k);
              const tip = !allowed(k) ? t('rsn.na') : locked(k) ? t('rsn.otherNote') : undefined;
              return (
                <label
                  key={k}
                  title={tip}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: ok ? '#101418' : '#8A9099',
                    cursor: ok ? 'pointer' : 'not-allowed',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allowed(k) && f.flags[k]}
                    disabled={!ok}
                    onChange={() =>
                      setF((x) => ({ ...x, flags: { ...x.flags, [k]: !x.flags[k] } }))
                    }
                    style={{ width: 16, height: 16, accentColor: '#2257C4', margin: 0 }}
                  />
                  {t(l)}
                  {tip && <span style={{ color: '#8A9099', fontSize: 12.5 }}>· {tip}</span>}
                </label>
              );
            })}
          </div>
        </div>
      </section>
    </FormDrawer>
  );
}
