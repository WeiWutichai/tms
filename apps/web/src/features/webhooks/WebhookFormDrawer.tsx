import { FormDrawer, FormField, TextInput } from '@tms/ui';
import { useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { fieldErrors, problemText } from '../master/problems';
import {
  HOOK_URL_RE,
  parseHeaders,
  useCreateWebhook,
  useWebhookEventTypes,
  type WebhookCreate,
  type WebhookWithSecret,
} from './useWebhooks';

const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };

interface Form {
  url: string;
  events: string[];
  hdr: string;
}
const EMPTY: Form = { url: 'https://', events: [], hdr: '' };

/**
 * ฟอร์ม "เพิ่ม webhook endpoint" — ต้นแบบ TMS v4 cfHook (drawer ขวา):
 * Endpoint URL (https://) · โหมด (ครึ่งแถว) · Event ที่สมัคร (checkbox) · Header เพิ่มเติม (บรรทัดละ `Name: value`)
 * - รายการ event = event สาธารณะของระบบ (`GET /v1/webhooks/event-types`, docs/01 §5.3) แทน 14 ตัวอย่างของต้นแบบ
 * - โหมด Sandbox เลือกไม่ได้จนกว่าจะมี sandbox (ST7-T09) — เหมือน API key [DECISION spec/12 §3]
 */
export function WebhookFormDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (h: WebhookWithSecret) => void;
}) {
  const { t } = useI18n();
  const create = useCreateWebhook();
  const types = useWebhookEventTypes();
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState(false);
  const submitting = useRef(false);
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setF(EMPTY);
      setTried(false);
      submitting.current = false;
      create.reset();
    }
  }

  const headers = parseHeaders(f.hdr);
  const local: Record<string, string> = {};
  if (!HOOK_URL_RE.test(f.url.trim())) local.url = t('whk.v.url');
  if (!f.events.length) local.events = t('whk.v.events');
  if (!headers) local.extraHeaders = t('whk.v.hdr');
  const server = fieldErrors(create.error, t);
  if (create.error instanceof ApiError) {
    const errs = create.error.problem.errors ?? [];
    if (errs.some((e) => e.field === 'url' && e.code === 'duplicate')) server.url = t('whk.v.dup');
    else if (errs.some((e) => e.field === 'url' && e.code === 'url_not_allowed'))
      server.url = t('whk.v.ssrf');
    if (errs.some((e) => e.field === 'extraHeaders' && e.code === 'reserved_header'))
      server.extraHeaders = t('whk.v.reserved');
  }
  const errs = { ...(tried ? local : {}), ...server };
  const topErr = create.error && !Object.keys(server).length ? problemText(create.error, t) : null;

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current) return;
    submitting.current = true;
    create.mutate(
      {
        url: f.url.trim(),
        events: f.events as WebhookCreate['events'],
        extraHeaders: headers ?? [],
      },
      {
        onSettled: () => {
          submitting.current = false;
        },
        onSuccess: onCreated,
      },
    );
  };

  const all = (types.data?.data ?? []).map((x) => x.type);
  const toggle = (ev: string, on: boolean) =>
    setF((x) => ({
      ...x,
      events: on
        ? all.filter((y) => y === ev || x.events.includes(y))
        : x.events.filter((y) => y !== ev),
    }));

  return (
    <FormDrawer
      open={open}
      title={t('whk.create.title')}
      subtitle={t('whk.create.sub')}
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
            disabled={create.isPending}
          >
            {t('whk.add')}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          <FormField label={t('whk.f.url')} required span={2} error={errs.url}>
            {(p) => (
              <TextInput
                {...p}
                autoFocus
                maxLength={2048}
                value={f.url}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, url: v }));
                }}
              />
            )}
          </FormField>
          <FormField label={t('akey.f.mode')} required>
            {(p) => (
              <select {...p} className="tms-select" style={SEL} value="live" onChange={() => {}}>
                <option value="live">{t('akey.mode.live')}</option>
                <option value="test" disabled>
                  {t('akey.mode.testOff')}
                </option>
              </select>
            )}
          </FormField>
          <FormField label={t('whk.f.events')} required span={2} error={errs.events}>
            {(p) => (
              <div id={p.id} role="group" className="akey-chk" aria-invalid={p['aria-invalid']}>
                {all.map((ev) => (
                  <label key={ev}>
                    <input
                      type="checkbox"
                      checked={f.events.includes(ev)}
                      onChange={(e) => toggle(ev, e.target.checked)}
                    />
                    <span className="akey-chk__t">
                      <span>{ev}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </FormField>
          <FormField
            label={t('whk.f.hdr')}
            span={2}
            error={errs.extraHeaders}
            hint={t('whk.f.hdrHint')}
          >
            {(p) => (
              <textarea
                {...p}
                className="tms-textarea"
                rows={3}
                placeholder={t('whk.f.hdrPh')}
                value={f.hdr}
                onChange={(e) => {
                  const v = e.target.value;
                  setF((x) => ({ ...x, hdr: v }));
                }}
              />
            )}
          </FormField>
        </div>
      </section>
    </FormDrawer>
  );
}
