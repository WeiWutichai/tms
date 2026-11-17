import { FormDrawer, FormField, TextInput } from '@tms/ui';
import { useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { fieldErrors, problemText } from '../master/problems';
import {
  TTL_OPTIONS,
  useCreateApiKey,
  useScopeOptions,
  useUpdateApiKey,
  type ApiKey,
  type ApiKeyWithSecret,
} from './useApiKeys';

const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
const IPV6 = /^[0-9a-f]*:[0-9a-f:.]*(\/\d{1,3})?$/i;
const IP_MAX = 20;

/** ข้อความในช่อง IP (บรรทัดละรายการ / คั่นด้วย ,) → รายการ */
export const ipLines = (s: string) =>
  s
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);

interface Form {
  name: string;
  ttl: string;
  scopes: string[];
  ip: string;
}

/**
 * ฟอร์ม "สร้าง API key" (ต้นแบบ TMS v4 cfKey) และ "แก้ scope" (cfKeyScope) — drawer ขวา
 * สร้าง: ชื่อ key · โหมด · หมดอายุ (90/30/365 วัน/ไม่หมดอายุ) · Scope (checkbox 2 คอลัมน์) · IP ที่อนุญาต
 * แก้ scope: Scope + IP (การเปลี่ยนมีผลทันที)
 * - รายการ scope = PERMISSIONS ของระบบ (`resource:verb` ตัวเดียวกับบทบาท) แทนรายการตัวอย่างของต้นแบบ
 *   scope ที่ผู้ใช้ไม่มีเองเลือกไม่ได้ (INT-073) [DECISION spec/12 §3]
 * - โหมด Sandbox ยังเลือกไม่ได้จนกว่าจะมี sandbox (ST7-T09) [DECISION spec/12 §3]
 */
export function ApiKeyFormDrawer({
  open,
  edit,
  onClose,
  onCreated,
  onSaved,
}: {
  open: boolean;
  /** มีค่า = แก้ scope ของ key นี้ */
  edit?: ApiKey | null;
  onClose: () => void;
  onCreated: (k: ApiKeyWithSecret) => void;
  onSaved: (k: ApiKey) => void;
}) {
  const { t } = useI18n();
  const create = useCreateApiKey();
  const update = useUpdateApiKey();
  const opts = useScopeOptions();
  const m = edit ? update : create;
  const [f, setF] = useState<Form>({ name: '', ttl: '90', scopes: [], ip: '' });
  const [tried, setTried] = useState(false);
  const submitting = useRef(false);
  // ล้างฟอร์มตั้งแต่ render แรกที่เปิด (ไม่รอ effect — กันค่าเก่าค้าง)
  const openKey = open ? (edit?.id ?? 'new') : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (openKey !== shownFor) {
    setShownFor(openKey);
    if (openKey !== null) {
      setF(
        edit
          ? {
              name: edit.name,
              ttl: '90',
              scopes: [...edit.scopes],
              ip: edit.ipAllowlist.join('\n'),
            }
          : { name: '', ttl: '90', scopes: [], ip: '' },
      );
      setTried(false);
      submitting.current = false;
      create.reset();
      update.reset();
    }
  }

  const ips = ipLines(f.ip);
  const local: Record<string, string> = {};
  if (!edit && !f.name.trim()) local.name = t('akey.v.name');
  if (!f.scopes.length) local.scopes = t('akey.v.scope');
  if (ips.some((x) => !IPV4.test(x) && !IPV6.test(x))) local.ipAllowlist = t('akey.v.ip');
  else if (ips.length > IP_MAX) local.ipAllowlist = t('akey.v.ipMax');
  const server = fieldErrors(m.error, t);
  if (
    m.error instanceof ApiError &&
    m.error.problem.errors?.some((e) => e.field === 'name' && e.code === 'duplicate')
  )
    server.name = t('akey.v.dup');
  const errs = { ...(tried ? local : {}), ...server };
  const topErr = m.error && !Object.keys(server).length ? problemText(m.error, t) : null;

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current) return;
    submitting.current = true;
    const done = {
      onSettled: () => {
        submitting.current = false;
      },
    };
    if (edit) {
      const scopesChanged = [...edit.scopes].sort().join() !== [...f.scopes].sort().join();
      const ipChanged = edit.ipAllowlist.join() !== ips.join();
      if (!scopesChanged && !ipChanged) {
        submitting.current = false;
        return onClose();
      }
      update.mutate(
        {
          id: edit.id,
          version: edit.version,
          body: {
            ...(scopesChanged ? { scopes: f.scopes } : {}),
            ...(ipChanged ? { ipAllowlist: ips } : {}),
          },
        },
        { ...done, onSuccess: onSaved },
      );
    } else
      create.mutate(
        {
          name: f.name.trim(),
          mode: 'live',
          scopes: f.scopes,
          ipAllowlist: ips,
          expiresInDays: f.ttl === 'never' ? null : (Number(f.ttl) as 30 | 90 | 365),
        },
        { ...done, onSuccess: onCreated },
      );
  };

  const all = opts.data?.data ?? [];
  const toggle = (s: string, on: boolean) =>
    setF((x) => ({
      ...x,
      scopes: on
        ? all.map((o) => o.scope).filter((y) => y === s || x.scopes.includes(y))
        : x.scopes.filter((y) => y !== s),
    }));

  return (
    <FormDrawer
      open={open}
      title={edit ? t('akey.scope.title', { n: edit.name }) : t('akey.create.title')}
      subtitle={edit ? t('akey.scope.sub', { prefix: edit.prefix }) : t('akey.create.sub')}
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
            disabled={m.isPending}
          >
            {edit ? t('common.save') : t('akey.create.ok')}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          {!edit && (
            <>
              <FormField label={t('akey.f.name')} required span={2} error={errs.name}>
                {(p) => (
                  <TextInput
                    {...p}
                    autoFocus
                    maxLength={80}
                    placeholder={t('akey.f.namePh')}
                    value={f.name}
                    onChange={(e) => {
                      const v = e.target.value;
                      setF((x) => ({ ...x, name: v }));
                    }}
                  />
                )}
              </FormField>
              <FormField label={t('akey.f.mode')} required error={errs.mode}>
                {(p) => (
                  <select
                    {...p}
                    className="tms-select"
                    style={SEL}
                    value="live"
                    onChange={() => {}}
                  >
                    <option value="live">{t('akey.mode.live')}</option>
                    <option value="test" disabled>
                      {t('akey.mode.testOff')}
                    </option>
                  </select>
                )}
              </FormField>
              <FormField label={t('akey.f.exp')} required error={errs.expiresInDays}>
                {(p) => (
                  <select
                    {...p}
                    className="tms-select"
                    style={SEL}
                    value={f.ttl}
                    onChange={(e) => {
                      const v = e.target.value;
                      setF((x) => ({ ...x, ttl: v }));
                    }}
                  >
                    {TTL_OPTIONS.map((d) => (
                      <option key={String(d)} value={d === null ? 'never' : String(d)}>
                        {d === null ? t('akey.never') : t('akey.f.days', { n: d })}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            </>
          )}
          <FormField
            label={t('akey.f.scope')}
            required
            span={2}
            error={errs.scopes}
            {...(edit ? {} : { hint: t('akey.f.scopeHint') })}
          >
            {(p) => (
              <div id={p.id} role="group" className="akey-chk" aria-invalid={p['aria-invalid']}>
                {all.map((o) => {
                  const on = f.scopes.includes(o.scope);
                  const locked = !o.grantable && !(edit?.scopes.includes(o.scope) ?? false);
                  return (
                    <label
                      key={o.scope}
                      {...(locked ? { 'data-off': '', title: t('akey.f.scopeLocked') } : {})}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={locked}
                        onChange={(e) => toggle(o.scope, e.target.checked)}
                      />
                      <span className="akey-chk__t">
                        <span>{o.scope}</span>
                        <span>{t(`akey.sc.${o.scope}` as MessageKey)}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </FormField>
          <FormField
            label={t('akey.f.ip')}
            span={2}
            error={errs.ipAllowlist}
            hint={edit ? t('akey.f.ipHintEdit') : t('akey.f.ipHint')}
          >
            {(p) => (
              <textarea
                {...p}
                className="tms-textarea"
                rows={3}
                placeholder={edit ? t('akey.f.ipPhShort') : t('akey.f.ipPh')}
                value={f.ip}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, ip: v }));
                }}
              />
            )}
          </FormField>
        </div>
      </section>
    </FormDrawer>
  );
}
