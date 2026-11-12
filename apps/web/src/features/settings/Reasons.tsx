import { EmptyState, Icon, ReasonDialog, Toast } from '@tms/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { isStale, problemText } from '../master/problems';
import { SaveBar } from './OrgSections';
import { ReasonFormDrawer } from './ReasonFormDrawer';
import {
  FLAG_ALLOWED,
  flagLocked,
  useReasonAction,
  useReasonCodes,
  useSaveReasonFlags,
  type ReasonCode,
  type ReasonFlag,
} from './useReasonCodes';

/** คอลัมน์ธงตามต้นแบบ (บังคับรูป / บังคับโน้ต / นัดส่งใหม่อัตโนมัติ) + แสดงบน tracking (docs/04 B — ต้นแบบไม่มี [OPEN spec/12 §3]) */
const FLAGS: Array<[ReasonFlag, MessageKey]> = [
  ['requiresPhoto', 'rsn.col.photo'],
  ['requiresNote', 'rsn.col.note'],
  ['autoReschedule', 'rsn.col.rs'],
  ['showOnTracking', 'rsn.col.trk'],
];
type Draft = Record<string, Partial<Record<ReasonFlag, boolean>>>;
const DIALOG = {
  deactivate: { title: 'rsn.dlg.offT', desc: 'rsn.dlg.offD', ok: 'rsn.act.off' },
  delete: { title: 'rsn.dlg.delT', desc: 'rsn.dlg.delD', ok: 'rsn.act.delete' },
} as const satisfies Record<string, Record<'title' | 'desc' | 'ok', MessageKey>>;

const pill = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 24,
  padding: '0 8px',
  borderRadius: 999,
  background: '#EBEDE8',
  color: '#3B424C',
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: 'nowrap',
} as const;
const mini = { ...pill, height: 20, padding: '0 6px', fontSize: 12, marginLeft: 8 } as const;
const chk = {
  width: 16,
  height: 16,
  accentColor: '#2257C4',
  margin: 0,
  cursor: 'pointer',
} as const;

/**
 * ตั้งค่า → เหตุผล (ST2-T12) — ต้นแบบ TMS v4 `st.is.reason`: การ์ด "เหตุผล (reason master)" + ปุ่ม "เพิ่มเหตุผล"
 * ตาราง หมวด | เหตุผล | บังคับรูป | บังคับโน้ต | นัดส่งใหม่อัตโนมัติ (ติ๊กในตาราง แล้วกด "บันทึก" ลอยมุมขวาล่าง)
 * ต่างจากต้นแบบ [OPEN spec/12 §3]: คอลัมน์ "แสดงบน tracking" (ธงบังคับของ docs/04 B), ธงที่ใช้กับหมวดไม่ได้ปิดไว้,
 * ป้าย "ระบบ"/"ปิดใช้" หลังข้อความ, กดข้อความเพื่อแก้ไข (ฟอร์ม drawer) — ต้นแบบไม่มีที่แก้ข้อความ/หมวด/ลบ
 * สิทธิ์: อ่าน master:read · แก้ master:write (docs/04 A3 แถว Master data)
 */
export function ReasonsSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const q = useReasonCodes();
  const save = useSaveReasonFlags();
  const action = useReasonAction();
  const [draft, setDraft] = useState<Draft>({});
  const [form, setForm] = useState<{ r: ReasonCode | null } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; r: ReasonCode } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => q.data ?? [], [q.data]);
  useEffect(() => {
    if (!saved && !error) return;
    const h = setTimeout(() => {
      setSaved(null);
      setError(null);
    }, 3600);
    return () => clearTimeout(h);
  }, [saved, error]);

  const value = (r: ReasonCode, f: ReasonFlag) => draft[r.id]?.[f] ?? r[f];
  const dirtyRows = rows
    .map((r) => {
      const body = Object.fromEntries(
        Object.entries(draft[r.id] ?? {}).filter(([k, v]) => r[k as ReasonFlag] !== v),
      );
      return { r, body };
    })
    .filter((x) => Object.keys(x.body).length);

  /** กันกดบันทึกซ้ำแบบ synchronous ก่อน isPending เปลี่ยน (review ST2-T12) */
  const saving = useRef(false);
  const onSave = () => {
    if (saving.current) return;
    if (!dirtyRows.length) return setSaved(t('set.saved', { section: t('set.menu.reason') }));
    saving.current = true;
    const sent = dirtyRows.map(({ r, body }) => ({ id: r.id, version: r.version, body }));
    save.mutate(sent, {
      onSuccess: ({ ok, failed }) => {
        // ล้าง draft เฉพาะแถวที่ส่งสำเร็จ (ค่าที่ส่ง) — ติ๊กที่เปลี่ยนระหว่างบันทึกหรือแถวที่ล้มยังค้างให้ลองใหม่
        setDraft((d) => {
          const next = { ...d };
          for (const id of ok) {
            const body = sent.find((x) => x.id === id)!.body as Record<string, boolean>;
            const rest = Object.fromEntries(
              Object.entries(next[id] ?? {}).filter(([k, v]) => body[k] !== v),
            );
            if (Object.keys(rest).length) next[id] = rest;
            else delete next[id];
          }
          return next;
        });
        if (!failed.length) return setSaved(t('set.saved', { section: t('set.menu.reason') }));
        setError(
          failed
            .map((f) =>
              t('rsn.saveFailed', {
                n: rows.find((r) => r.id === f.id)?.label ?? f.id,
                e: problemText(f.error, t) ?? '',
              }),
            )
            .join(' · '),
        );
      },
      onError: (e) => setError(problemText(e, t)),
      onSettled: () => {
        saving.current = false;
      },
    });
  };

  const runAction = (r: ReasonCode, a: 'activate' | 'deactivate' | 'delete') => {
    if (a === 'activate')
      return action.mutate(
        { id: r.id, version: r.version, action: 'activate' },
        {
          onSuccess: () => {
            setForm(null);
            setToast(t('rsn.toast.status', { n: r.label }));
          },
          onError: (e) => setToast(problemText(e, t)),
        },
      );
    setDialog({ kind: a, r });
  };

  return (
    <section className="set-card">
      <div className="set-card__hd">
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h2>{t('rsn.title')}</h2>
          <span style={{ color: '#3B424C' }}>{t('rsn.sub')}</span>
        </div>
        {canWrite && (
          <button type="button" className="set-btn2" onClick={() => setForm({ r: null })}>
            <Icon n="plus" s={16} />
            {t('rsn.add')}
          </button>
        )}
      </div>
      {q.isError ? (
        <EmptyState
          icon="triangle-alert"
          title={t('rsn.loadError')}
          action={
            <button type="button" className="set-btn2" onClick={() => void q.refetch()}>
              {t('rsn.retry')}
            </button>
          }
        />
      ) : q.isLoading ? (
        <div style={{ padding: 20, color: '#59606B' }}>{t('rsn.loading')}</div>
      ) : !rows.length ? (
        <EmptyState
          icon="list-checks"
          title={t('rsn.emptyTitle')}
          description={t('rsn.emptyDesc')}
        />
      ) : (
        <div className="set-scroll">
          <table className="set-tbl">
            <thead>
              <tr>
                <th>{t('rsn.col.cat')}</th>
                <th>{t('rsn.col.label')}</th>
                {FLAGS.map(([k, l]) => (
                  <th key={k} className="c">
                    {t(l)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-code={r.code}>
                  <td>
                    <span style={pill}>{t(`rsn.cat.${r.category}` as MessageKey)}</span>
                  </td>
                  <td style={{ color: r.status === 'active' ? '#101418' : '#8A9099' }}>
                    {canWrite ? (
                      <button
                        type="button"
                        onClick={() => setForm({ r })}
                        style={{
                          font: 'inherit',
                          color: 'inherit',
                          background: 'none',
                          border: 0,
                          padding: 0,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        {r.label}
                      </button>
                    ) : (
                      r.label
                    )}
                    {r.system && (
                      <span style={mini} title={t('rsn.systemHint')}>
                        {t('rsn.system')}
                      </span>
                    )}
                    {r.status !== 'active' && <span style={mini}>{t('rsn.inactive')}</span>}
                  </td>
                  {FLAGS.map(([k, l]) => {
                    const na = !FLAG_ALLOWED[k](r.category);
                    const lock = flagLocked(r, k);
                    return (
                      <td key={k} className="c">
                        <input
                          type="checkbox"
                          aria-label={`${t(l)} — ${r.label}`}
                          title={na ? t('rsn.na') : lock ? t('rsn.otherNote') : undefined}
                          checked={!na && value(r, k)}
                          disabled={!canWrite || na || lock || save.isPending}
                          onChange={() =>
                            setDraft((d) => ({ ...d, [r.id]: { ...d[r.id], [k]: !value(r, k) } }))
                          }
                          style={{
                            ...chk,
                            ...(na || !canWrite
                              ? { cursor: 'not-allowed', opacity: na ? 0.35 : 1 }
                              : {}),
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canWrite && (
        <SaveBar
          dirty={dirtyRows.length > 0}
          busy={save.isPending}
          onSave={onSave}
          saved={saved}
          error={error}
          onDismiss={() => {
            setSaved(null);
            setError(null);
          }}
        />
      )}
      <ReasonFormDrawer
        open={!!form}
        item={form?.r ?? null}
        onClose={() => setForm(null)}
        onAction={runAction}
        onSaved={(r, created) => {
          setForm(null);
          setDraft((d) => {
            const { [r.id]: _x, ...rest } = d;
            return rest;
          });
          setToast(t(created ? 'rsn.toast.created' : 'rsn.toast.saved', { n: r.label }));
        }}
      />
      <ReasonDialog
        open={!!dialog}
        title={dialog ? t(DIALOG[dialog.kind].title, { n: dialog.r.label }) : ''}
        description={dialog ? t(DIALOG[dialog.kind].desc) : ''}
        label={t('rsn.dlg.reason')}
        placeholder={t('rsn.dlg.reasonPh')}
        okLabel={dialog ? t(DIALOG[dialog.kind].ok) : ''}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={action.isPending}
        error={problemText(action.error, t)}
        onClose={() => {
          setDialog(null);
          action.reset();
        }}
        onOk={(reason) => {
          if (!dialog) return;
          const { r, kind } = dialog;
          action.mutate(
            { id: r.id, version: r.version, action: kind, reason },
            {
              // 412 (ผู้อื่นแก้ไปแล้ว) → ปิด dialog แจ้งให้ลองใหม่ (hook โหลดรายการใหม่ให้แล้ว) — ไม่ค้าง dialog ที่ถือ version เก่า
              onError: (e) => {
                if (!isStale(e)) return;
                setDialog(null);
                setForm(null);
                action.reset();
                setToast(t('rsn.stale'));
              },
              onSuccess: () => {
                setDialog(null);
                setForm(null);
                setToast(
                  t(kind === 'delete' ? 'rsn.toast.deleted' : 'rsn.toast.status', { n: r.label }),
                );
              },
            },
          );
        }}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </section>
  );
}
