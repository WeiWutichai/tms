import {
  Button,
  Drawer,
  EmptyState,
  FormDrawer,
  FormField,
  Icon,
  ReasonDialog,
  StatusDot,
  Tag,
  TextInput,
} from '@tms/ui';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { fieldErrors, isStale, problemText } from '../master/problems';
import { num, unitConvText, unitKindLabel } from './productFormat';
import {
  UNIT_KINDS,
  useSaveUnit,
  useUnitAction,
  useUnits,
  type Unit,
  type UnitKind,
} from './useProducts';

const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;
const CODE_RE = /^[A-Z0-9][A-Z0-9_\-.]{0,9}$/;
const decOf = (s: string) => (/^\d{1,8}(\.\d{1,6})?$/.test(s.trim()) ? Number(s) : NaN);

const DIALOG = {
  deactivate: { title: 'unit.dlg.offT', desc: 'unit.dlg.offD', ok: 'prd.menu.off' },
  delete: { title: 'unit.dlg.delT', desc: 'unit.dlg.delD', ok: 'prd.menu.delete' },
} as const satisfies Record<string, Record<'title' | 'desc' | 'ok', MessageKey>>;

/**
 * จัดการหน่วยนับ (ST2-T10; spec/02 §3 "แท็บ สินค้า และ หน่วย ในหน้าเดียว") — ต้นแบบไม่มีหน้าหน่วย
 * → drawer จากปุ่ม "จัดการหน่วย" บนหน้าสินค้าและหน่วย [OPEN spec/12 §3]
 * หน่วยมาตรฐาน (ชุดเริ่มต้น) แก้ได้เฉพาะชื่อ ลบไม่ได้ · ปิดใช้ได้ทุกหน่วย (เหตุผล ≥ 10)
 */
export function UnitsDrawer({
  canWrite,
  onClose,
  onToast,
}: {
  canWrite: boolean;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const units = useUnits();
  const action = useUnitAction();
  const [form, setForm] = useState<{ u: Unit | null } | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'deactivate' | 'delete'; u: Unit } | null>(null);
  const rows = units.data ?? [];

  const toggle = (u: Unit) => {
    if (u.status === 'active') return setDialog({ kind: 'deactivate', u });
    action.mutate(
      { id: u.id, version: u.version, action: 'activate' },
      {
        onSuccess: () => onToast(t('unit.toast.status', { n: u.name })),
        onError: (e) => onToast(problemText(e, t) ?? ''),
      },
    );
  };

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        kind={t('prd.kind')}
        title={t('unit.title')}
        labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <span style={{ color: '#3B424C', fontSize: 13, flex: 1 }}>{t('unit.sub')}</span>
          {canWrite && (
            <Button variant="secondary" icon="plus" onClick={() => setForm({ u: null })}>
              {t('unit.add')}
            </Button>
          )}
        </div>
        {units.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('unit.loadError')}
            description={problemText(units.error, t) ?? ''}
          />
        ) : (
          <div className="tms-table-wrap">
            <div className="tms-table-scroll">
              <table className="tms-table" aria-label={t('unit.title')}>
                <thead>
                  <tr>
                    <th>{t('unit.col.name')}</th>
                    <th>{t('unit.col.kind')}</th>
                    <th style={{ textAlign: 'right' }}>{t('unit.col.used')}</th>
                    <th>{t('unit.col.st')}</th>
                    {canWrite && <th aria-hidden />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
                          <span style={{ color: '#101418' }}>
                            {u.name}
                            {u.system && (
                              <span style={{ marginLeft: 8 }}>
                                <Tag>{t('unit.system')}</Tag>
                              </span>
                            )}
                          </span>
                          <span style={{ color: '#3B424C' }}>{u.code}</span>
                        </div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
                          <span style={{ color: '#101418' }}>{unitKindLabel(t, u.kind)}</span>
                          {u.kind !== 'COUNT' && (
                            <span style={{ color: '#3B424C' }}>{unitConvText(t, u)}</span>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {t('unit.items', { n: num(u.products, 0) })}
                      </td>
                      <td>
                        <StatusDot
                          label={t(u.status === 'active' ? 'prd.st.active' : 'prd.st.inactive')}
                          tone={u.status === 'active' ? 'ok' : 'off'}
                        />
                      </td>
                      {canWrite && (
                        <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          <button
                            type="button"
                            className="tms-iconbtn tms-iconbtn--plain"
                            title={t('prd.menu.edit')}
                            aria-label={`${t('prd.menu.edit')} ${u.name}`}
                            onClick={() => setForm({ u })}
                          >
                            <Icon n="pencil" s={16} />
                          </button>
                          <button
                            type="button"
                            className="tms-iconbtn tms-iconbtn--plain"
                            title={t(u.status === 'active' ? 'prd.menu.off' : 'prd.menu.on')}
                            aria-label={`${t(u.status === 'active' ? 'prd.menu.off' : 'prd.menu.on')} ${u.name}`}
                            onClick={() => toggle(u)}
                          >
                            <Icon n={u.status === 'active' ? 'ban' : 'circle-check'} s={16} />
                          </button>
                          {!u.system && (
                            <button
                              type="button"
                              className="tms-iconbtn tms-iconbtn--plain"
                              title={t('prd.menu.delete')}
                              aria-label={`${t('prd.menu.delete')} ${u.name}`}
                              onClick={() => setDialog({ kind: 'delete', u })}
                            >
                              <Icon n="trash-2" s={16} />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Drawer>
      <UnitFormDrawer
        open={!!form}
        unit={form?.u ?? null}
        onClose={() => setForm(null)}
        onSaved={(u, created) => {
          setForm(null);
          onToast(t(created ? 'unit.toast.created' : 'unit.toast.saved', { n: u.name }));
        }}
      />
      <ReasonDialog
        open={!!dialog}
        title={dialog ? t(DIALOG[dialog.kind].title, { n: dialog.u.name }) : ''}
        description={dialog ? t(DIALOG[dialog.kind].desc) : ''}
        label={t('prd.dlg.reason')}
        placeholder={t('prd.dlg.reasonPh')}
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
          const { u, kind } = dialog;
          action.mutate(
            { id: u.id, version: u.version, action: kind, reason },
            {
              onSuccess: () => {
                setDialog(null);
                onToast(
                  t(kind === 'delete' ? 'unit.toast.deleted' : 'unit.toast.status', { n: u.name }),
                );
              },
            },
          );
        }}
      />
    </>
  );
}

interface UForm {
  code: string;
  name: string;
  kind: UnitKind;
  factor: string;
}

function UnitFormDrawer({
  open,
  unit,
  onClose,
  onSaved,
}: {
  open: boolean;
  unit: Unit | null;
  onClose: () => void;
  onSaved: (u: Unit, created: boolean) => void;
}) {
  const { t } = useI18n();
  const save = useSaveUnit();
  const [f, setF] = useState<UForm>({ code: '', name: '', kind: 'COUNT', factor: '' });
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const openKey = open ? (unit?.id ?? 'new') : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (openKey !== shownFor) {
    setShownFor(openKey);
    if (openKey !== null) {
      setF(
        unit
          ? {
              code: unit.code,
              name: unit.name,
              kind: unit.kind,
              factor: String(unit.toKg ?? unit.toCbm ?? ''),
            }
          : { code: '', name: '', kind: 'COUNT', factor: '' },
      );
      setTried(false);
    }
  }
  useEffect(() => {
    if (open) {
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      save.reset();
    }
  }, [open, unit?.id]);

  /** หน่วยมาตรฐาน / หน่วยที่สินค้าใช้อยู่: แก้ได้เฉพาะชื่อ */
  const locked = !!unit && (unit.system || unit.products > 0);
  const local: Record<string, string> = {};
  const code = f.code.trim().toUpperCase();
  if (!CODE_RE.test(code)) local.code = t('unit.v.code');
  if (!f.name.trim()) local.name = t('unit.v.name');
  const factor = f.kind === 'COUNT' ? null : decOf(f.factor);
  if (factor !== null && !(factor > 0))
    local[f.kind === 'WEIGHT' ? 'toKg' : 'toCbm'] = t('unit.v.factor');
  const server = fieldErrors(save.error, t);
  const errs = { ...(tried ? local : {}), ...server };
  const topErr =
    save.error && !Object.keys(server).length
      ? isStale(save.error)
        ? t('prd.stale')
        : problemText(save.error, t)
      : null;

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current) return;
    submitting.current = true;
    const conv = {
      toKg: f.kind === 'WEIGHT' ? factor : null,
      toCbm: f.kind === 'VOLUME' ? factor : null,
    };
    const done = {
      onError: () => setIdemKey(crypto.randomUUID()),
      onSettled: () => {
        submitting.current = false;
      },
    };
    if (unit) {
      const body = locked
        ? { name: f.name.trim() }
        : { code, name: f.name.trim(), kind: f.kind, ...conv };
      save.mutate(
        { id: unit.id, version: unit.version, body },
        { ...done, onSuccess: (u) => onSaved(u, false) },
      );
    } else
      save.mutate(
        { idempotencyKey: idemKey, body: { code, name: f.name.trim(), kind: f.kind, ...conv } },
        { ...done, onSuccess: (u) => onSaved(u, true) },
      );
  };
  const factorKey = f.kind === 'WEIGHT' ? 'toKg' : 'toCbm';

  return (
    <FormDrawer
      open={open}
      title={unit ? t('unit.edit.title') : t('unit.create.title')}
      subtitle={unit ? unit.code : t('unit.sub')}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      {...(tried && Object.keys(local).length
        ? { alert: t('form.incomplete', { n: Object.keys(local).length }) }
        : {})}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="tms-fdrawer__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 40, padding: '0 18px' }}
            disabled={save.isPending}
          >
            {unit ? t('common.save') : t('unit.add')}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          <FormField label={t('unit.f.code')} required error={errs.code}>
            {(p) => (
              <TextInput
                {...p}
                maxLength={10}
                disabled={locked}
                placeholder={t('unit.f.codePh')}
                value={f.code}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, code: v }));
                }}
              />
            )}
          </FormField>
          <FormField label={t('unit.f.name')} required error={errs.name}>
            {(p) => (
              <TextInput
                {...p}
                autoFocus
                maxLength={30}
                placeholder={t('unit.f.namePh')}
                value={f.name}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, name: v }));
                }}
              />
            )}
          </FormField>
          <FormField label={t('unit.f.kind')} required error={errs.kind}>
            {(p) => (
              <select
                {...p}
                className="tms-select"
                style={SEL}
                disabled={locked}
                value={f.kind}
                onChange={(e) => {
                  const v = e.target.value as UnitKind;
                  setF((x) => ({ ...x, kind: v }));
                }}
              >
                {UNIT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {unitKindLabel(t, k)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {f.kind !== 'COUNT' && (
            <FormField
              label={t(f.kind === 'WEIGHT' ? 'unit.f.toKg' : 'unit.f.toCbm')}
              required
              error={errs[factorKey]}
            >
              {(p) => (
                <TextInput
                  {...p}
                  inputMode="decimal"
                  style={NUM}
                  disabled={locked}
                  value={f.factor}
                  onChange={(e) => {
                    const v = e.target.value;
                    setF((x) => ({ ...x, factor: v }));
                  }}
                />
              )}
            </FormField>
          )}
        </div>
      </section>
    </FormDrawer>
  );
}
