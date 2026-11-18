import { Icon, useEscapeLayer } from '@tms/ui';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { useSavedViewMutations, type SavedView, type SavedViewsBinding } from './useSavedViews';

const item: CSSProperties = {
  width: '100%',
  height: 36,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 10px',
  border: 0,
  borderRadius: 999,
  background: 'transparent',
  color: '#101418',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
};
const ellipsis: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

type Dialog =
  { kind: 'create' } | { kind: 'rename'; view: SavedView } | { kind: 'delete'; view: SavedView };

/**
 * ปุ่ม "มุมมอง: …" + เมนูของหน้ารายการ (ST9-T11) — ต้นแบบ TMS v4 `toggleView` :1113 (pill 32px ไอคอน bookmark,
 * เมนู 220px มุม 14 เงา, แถว 36px pill, ✓ สีน้ำเงิน) · รายการในเมนู: "ทั้งหมด" (ล้างตัวกรอง — ต้นแบบ) + มุมมองที่ผู้ใช้บันทึก
 * [DECISION — ตามคำแนะนำ, PO อนุมัติล่วงหน้า 17 พ.ย. 2569 — ย้อนได้] ต้นแบบไม่วาดการบันทึก/เปลี่ยนชื่อ/ตั้งค่าเริ่มต้น
 * (docs/03 §"Saved views + filter badge" ระบุไว้) → ต่อท้ายเมนูด้วยเส้นคั่นแบบแผง "คอลัมน์ที่แสดง" + แถวคำสั่งรูปเดียวกัน
 * "ทั้งทีม" (แชร์ในทีม) = P1 ยังไม่แสดง · "ของฉันวันนี้" = ข้อมูลตัวอย่างของต้นแบบ (ผู้ใช้ตั้งชื่อเอง)
 */
export function SavedViewMenu({
  b,
  onToast,
}: {
  b: SavedViewsBinding;
  onToast: (m: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const m = useSavedViewMutations(b.page);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEscapeLayer(open, () => {
    setOpen(false);
    btn.current?.focus();
  });

  const fail = (e: unknown) =>
    onToast(
      e instanceof ApiError && e.problem.code === 'precondition_failed'
        ? t('sv.conflict')
        : (problemText(e, t) ?? t('sv.error')),
    );
  const a = b.active;
  const label = a
    ? b.modified
      ? t('sv.modified', { n: a.name })
      : a.name
    : b.isAll
      ? t('sv.all')
      : t('sv.custom');

  const run = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  const overwrite = (v: SavedView) =>
    m.update.mutate(
      {
        id: v.id,
        version: v.version,
        body: { state: b.current.state, hiddenColumns: b.current.hidden },
      },
      { onSuccess: (x) => onToast(t('sv.toast.updated', { n: x.name })), onError: fail },
    );
  const toggleDefault = (v: SavedView) =>
    m.update.mutate(
      { id: v.id, version: v.version, body: { isDefault: !v.isDefault } },
      {
        onSuccess: (x) =>
          onToast(t(x.isDefault ? 'sv.toast.default' : 'sv.toast.undefault', { n: x.name })),
        onError: fail,
      },
    );

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', minWidth: 0 }}>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="tms-viewbtn"
        style={{
          height: 32,
          maxWidth: 360,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 10px',
          border: '1px solid #D9DCD4',
          borderRadius: 999,
          background: '#FFFFFF',
          color: '#101418',
          cursor: 'pointer',
          font: 'inherit',
          fontWeight: 500,
        }}
      >
        <Icon n="bookmark" s={16} style={{ color: '#59606B', flexShrink: 0 }} />
        <span style={ellipsis}>{t('sv.btn', { v: label })}</span>
        <Icon n="chevron-down" s={16} style={{ color: '#59606B', flexShrink: 0 }} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 38,
            left: 0,
            zIndex: 20,
            width: 220,
            maxHeight: 420,
            overflowY: 'auto',
            background: '#FFFFFF',
            border: '1px solid #D9DCD4',
            borderRadius: 14,
            boxShadow: '0 12px 32px rgba(16,24,40,.12)',
            padding: 4,
            boxSizing: 'border-box',
          }}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!a && b.isAll}
            className="tms-viewitem"
            style={item}
            onClick={run(() => b.select(null))}
          >
            <span style={ellipsis}>{t('sv.all')}</span>
            {!a && b.isAll && <Icon n="check" s={16} style={{ color: '#2257C4' }} />}
          </button>
          {b.views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitemradio"
              aria-checked={a?.id === v.id}
              className="tms-viewitem"
              style={item}
              title={v.name}
              onClick={run(() => b.select(v))}
            >
              <span style={ellipsis}>{v.name}</span>
              {v.isDefault && (
                <span style={{ fontSize: 12.5, color: '#59606B', flexShrink: 0 }}>
                  {t('sv.default')}
                </span>
              )}
              {a?.id === v.id && (
                <Icon n="check" s={16} style={{ color: '#2257C4', flexShrink: 0 }} />
              )}
            </button>
          ))}
          {b.error && (
            <div style={{ padding: '6px 10px', fontSize: 12.5, color: '#B3322A' }}>
              {t('sv.loadError')}
            </div>
          )}
          <div style={{ margin: '6px 10px', borderTop: '1px solid #E4E6E0' }} />
          <button
            type="button"
            role="menuitem"
            className="tms-viewitem"
            style={item}
            onClick={run(() => setDialog({ kind: 'create' }))}
          >
            <span style={ellipsis}>{t('sv.saveNew')}</span>
          </button>
          {a && (
            <>
              <button
                type="button"
                role="menuitem"
                className="tms-viewitem"
                disabled={!b.modified || m.update.isPending}
                style={{
                  ...item,
                  ...(!b.modified ? { color: '#8A9099', cursor: 'default' } : {}),
                }}
                onClick={run(() => overwrite(a))}
              >
                <span style={ellipsis}>{t('sv.overwrite')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="tms-viewitem"
                style={item}
                onClick={run(() => setDialog({ kind: 'rename', view: a }))}
              >
                <span style={ellipsis}>{t('sv.rename')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="tms-viewitem"
                disabled={m.update.isPending}
                style={item}
                onClick={run(() => toggleDefault(a))}
              >
                <span style={ellipsis}>{t(a.isDefault ? 'sv.unsetDefault' : 'sv.setDefault')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="tms-viewitem"
                style={{ ...item, color: '#B3322A' }}
                onClick={run(() => setDialog({ kind: 'delete', view: a }))}
              >
                <span style={ellipsis}>{t('sv.delete')}</span>
              </button>
            </>
          )}
        </div>
      )}
      {dialog?.kind === 'delete' ? (
        <DeleteDialog
          view={dialog.view}
          onClose={() => setDialog(null)}
          onDone={(n) => {
            setDialog(null);
            b.setActiveId(null);
            onToast(t('sv.toast.deleted', { n }));
          }}
          onError={(e) => {
            setDialog(null);
            fail(e);
          }}
          remove={m.remove}
        />
      ) : dialog ? (
        <NameDialog
          view={dialog.kind === 'rename' ? dialog.view : null}
          onClose={() => setDialog(null)}
          submit={(name, isDefault) =>
            dialog.kind === 'rename'
              ? m.update.mutateAsync({
                  id: dialog.view.id,
                  version: dialog.view.version,
                  body: { name },
                })
              : m.create.mutateAsync({
                  page: b.page,
                  name,
                  state: b.current.state,
                  hiddenColumns: b.current.hidden,
                  isDefault,
                })
          }
          onDone={(v) => {
            setDialog(null);
            b.setActiveId(v.id);
            onToast(
              t(dialog.kind === 'rename' ? 'sv.toast.renamed' : 'sv.toast.saved', { n: v.name }),
            );
          }}
          onConflict={(e) => {
            setDialog(null);
            fail(e);
          }}
        />
      ) : null}
    </div>
  );
}

function NameDialog(p: {
  view: SavedView | null;
  onClose: () => void;
  submit: (name: string, isDefault: boolean) => Promise<SavedView>;
  onDone: (v: SavedView) => void;
  onConflict: (e: unknown) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [name, setName] = useState(p.view?.name ?? '');
  const [def, setDef] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEscapeLayer(true, p.onClose);
  const n = name.trim();
  const ok = n.length > 0 && n.length <= 60 && !busy;
  const go = async () => {
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      p.onDone(await p.submit(n, def));
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.problem.code === 'duplicate') setErr(t('sv.dup'));
      else if (e instanceof ApiError && e.problem.code === 'precondition_failed') p.onConflict(e);
      else setErr(problemText(e, t) ?? t('sv.error'));
    }
  };
  return (
    <div className="tms-dialog__scrim" onClick={p.onClose}>
      <form
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 id={`${id}-t`} className="tms-dialog__title">
              {t(p.view ? 'sv.renameT' : 'sv.saveT')}
            </h2>
            {!p.view && <p className="tms-dialog__desc">{t('sv.saveD')}</p>}
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            aria-label={t('drawer.close')}
            title={t('drawer.close')}
            onClick={p.onClose}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-dialog__body">
          <label className="tms-field" htmlFor={id}>
            <span className="tms-label">
              {t('sv.name')} <span style={{ color: '#B3322A' }}>*</span>
            </span>
            <input
              id={id}
              className="tms-input"
              value={name}
              maxLength={60}
              autoFocus
              aria-invalid={!!err}
              onChange={(e) => {
                setName(e.target.value);
                setErr(null);
              }}
              style={{ height: 40, padding: '0 12px' }}
            />
          </label>
          {err && <span className="tms-field-error">{err}</span>}
          {!p.view && (
            <label
              style={{
                minHeight: 36,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={def}
                onChange={(e) => setDef(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: '#2257C4', margin: 0 }}
              />
              {t('sv.asDefault')}
            </label>
          )}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={p.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={!ok}
          >
            <Icon n={p.view ? 'pencil' : 'bookmark-plus'} s={16} />
            {t(p.view ? 'common.save' : 'sv.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteDialog(p: {
  view: SavedView;
  onClose: () => void;
  onDone: (name: string) => void;
  onError: (e: unknown) => void;
  remove: ReturnType<typeof useSavedViewMutations>['remove'];
}) {
  const { t } = useI18n();
  const id = useId();
  useEscapeLayer(true, p.onClose);
  return (
    <div className="tms-dialog__scrim" onClick={p.onClose}>
      <div
        className="tms-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 id={`${id}-t`} className="tms-dialog__title">
              {t('sv.delT', { n: p.view.name })}
            </h2>
            <p className="tms-dialog__desc">{t('sv.delD')}</p>
          </div>
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={p.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="tms-btn tms-btn--danger"
            disabled={p.remove.isPending}
            onClick={() =>
              p.remove.mutate(
                { id: p.view.id, version: p.view.version },
                { onSuccess: () => p.onDone(p.view.name), onError: p.onError },
              )
            }
          >
            <Icon n="trash-2" s={16} />
            {t('sv.delBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
