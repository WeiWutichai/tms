import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState } from '@tms/ui';
import { useEffect, useRef, useState } from 'react';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { isStale, problemText } from '../master/problems';
import { SaveBar } from './OrgSections';

type Prefs = Schemas['NotificationPreferencesDto'];
type EventKey = Prefs['events'][number]['event'];
type Cell = 'inApp' | 'email';
type Draft = {
  events: Partial<Record<EventKey, Partial<Record<Cell, boolean>>>>;
  dailyDigest?: boolean;
};

const KEY = ['me', 'notification-preferences'] as const;
const chk = {
  width: 16,
  height: 16,
  accentColor: '#2257C4',
  margin: 0,
  cursor: 'pointer',
} as const;
const off = { ...chk, cursor: 'not-allowed', opacity: 0.35 } as const;

/**
 * ตั้งค่า → การแจ้งเตือน (ST9-T08) — ต้นแบบ TMS v4 `st.is.noti`: หัวการ์ด "การแจ้งเตือน" + แท็บ ทีมภายใน / แจ้งลูกค้าปลายทาง
 * แท็บทีมภายใน = ตาราง เหตุการณ์ × ในระบบ / อีเมล / LINE ติ๊กแล้วกด "บันทึก" ลอย (เหมือนหัวข้อตั้งค่าอื่น)
 * ต่างจากต้นแบบ [DECISION spec/12 §3]: เป็นค่าของผู้ใช้ที่ login (docs/04 I "ผู้ใช้ตั้งว่ารับอะไรทางไหน") ทุก role เข้าได้ ·
 * แถวเหตุการณ์ตาม docs/04 I (ต้นแบบเป็นข้อมูลตัวอย่างรวม P1) + แถว "สรุปรายวัน 08:00 น." (อีเมลเท่านั้น) ·
 * LINE ทีมภายใน = P1 → ติ๊กไม่ได้ · แท็บแจ้งลูกค้าปลายทาง = P1 (ผู้สมัครเพิ่ม #12) → "ยังไม่เปิดใช้"
 */
export function NotificationsSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'in' | 'cust'>('in');
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/v1/me/notification-preferences')),
  });
  const save = useMutation({
    mutationFn: (v: { version: number; body: Schemas['UpdateNotificationPreferencesDto'] }) =>
      unwrap(
        api.PATCH('/v1/me/notification-preferences', {
          params: { header: { 'If-Match': `"${v.version}"` } as never },
          body: v.body,
        }),
      ),
    onSuccess: (data) => qc.setQueryData(KEY, data),
    onError: (e) => {
      if (isStale(e)) void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const [draft, setDraft] = useState<Draft>({ events: {} });
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!saved && !error) return;
    const h = setTimeout(() => {
      setSaved(null);
      setError(null);
    }, 3600);
    return () => clearTimeout(h);
  }, [saved, error]);

  const data = q.data;
  const value = (e: Prefs['events'][number], c: Cell) => draft.events[e.event]?.[c] ?? e[c];
  const digest = draft.dailyDigest ?? data?.dailyDigest ?? true;
  const changes = (data?.events ?? [])
    .map((e) => {
      const d = draft.events[e.event] ?? {};
      const body: { event: EventKey; inApp?: boolean; email?: boolean } = { event: e.event };
      if (d.inApp !== undefined && d.inApp !== e.inApp) body.inApp = d.inApp;
      if (d.email !== undefined && d.email !== e.email) body.email = d.email;
      return body;
    })
    .filter((b) => b.inApp !== undefined || b.email !== undefined);
  const digestChanged = data !== undefined && digest !== data.dailyDigest;
  const dirty = changes.length > 0 || digestChanged;

  const saving = useRef(false);
  const onSave = () => {
    if (saving.current || !data) return;
    if (!dirty) return setSaved(t('set.saved', { section: t('set.menu.noti') }));
    saving.current = true;
    save.mutate(
      {
        version: data.version,
        body: {
          ...(changes.length ? { events: changes } : {}),
          ...(digestChanged ? { dailyDigest: digest } : {}),
        },
      },
      {
        onSuccess: () => {
          setDraft({ events: {} });
          setSaved(t('set.saved', { section: t('set.menu.noti') }));
        },
        onError: (e) => setError(isStale(e) ? t('noti.stale') : problemText(e, t)),
        onSettled: () => {
          saving.current = false;
        },
      },
    );
  };
  const toggle = (e: Prefs['events'][number], c: Cell) =>
    setDraft((d) => ({
      ...d,
      events: { ...d.events, [e.event]: { ...d.events[e.event], [c]: !value(e, c) } },
    }));

  return (
    <section className="set-card">
      <div className="set-tabs-hd">
        <h2>{t('set.menu.noti')}</h2>
        <div className="set-tabs" role="tablist">
          {(
            [
              ['in', 'noti.tab.in'],
              ['cust', 'noti.tab.cust'],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
            >
              {t(l)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'cust' ? (
        <EmptyState
          icon="construction"
          title={t('empty.notReady.title')}
          description={t('noti.custNotReady')}
        />
      ) : q.isError && !data ? (
        <EmptyState
          icon="triangle-alert"
          title={t('set.loadError')}
          action={
            <button type="button" className="set-btn2" onClick={() => void q.refetch()}>
              {t('rsn.retry')}
            </button>
          }
        />
      ) : !data ? (
        <div style={{ padding: 20, color: '#59606B' }}>{t('rsn.loading')}</div>
      ) : (
        <div className="set-scroll">
          <table className="set-tbl">
            <thead>
              <tr>
                <th>{t('noti.col.event')}</th>
                <th className="c" style={{ width: 120 }}>
                  {t('noti.col.inApp')}
                </th>
                <th className="c" style={{ width: 120 }}>
                  {t('noti.col.email')}
                </th>
                <th className="c" style={{ width: 120 }}>
                  {t('noti.col.line')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => {
                const label = t(`noti.ev.${e.event}` as MessageKey);
                return (
                  <tr key={e.event} data-event={e.event}>
                    <td
                      title={e.pendingTask ? t('noti.pending', { task: e.pendingTask }) : undefined}
                    >
                      {label}
                    </td>
                    {(['inApp', 'email'] as const).map((c) => (
                      <td key={c} className="c">
                        <input
                          type="checkbox"
                          aria-label={`${t(c === 'inApp' ? 'noti.col.inApp' : 'noti.col.email')} — ${label}`}
                          checked={value(e, c)}
                          disabled={save.isPending}
                          onChange={() => toggle(e, c)}
                          style={chk}
                        />
                      </td>
                    ))}
                    <td className="c">
                      <input
                        type="checkbox"
                        aria-label={`${t('noti.col.line')} — ${label}`}
                        title={t('noti.lineP1')}
                        checked={false}
                        disabled
                        readOnly
                        style={off}
                      />
                    </td>
                  </tr>
                );
              })}
              <tr data-event="daily-digest">
                <td>{t('noti.ev.digest')}</td>
                <td className="c">
                  <input
                    type="checkbox"
                    aria-label={`${t('noti.col.inApp')} — ${t('noti.ev.digest')}`}
                    title={t('noti.digestEmailOnly')}
                    checked={false}
                    disabled
                    readOnly
                    style={off}
                  />
                </td>
                <td className="c">
                  <input
                    type="checkbox"
                    aria-label={`${t('noti.col.email')} — ${t('noti.ev.digest')}`}
                    checked={digest}
                    disabled={save.isPending}
                    onChange={() => setDraft((d) => ({ ...d, dailyDigest: !digest }))}
                    style={chk}
                  />
                </td>
                <td className="c">
                  <input
                    type="checkbox"
                    aria-label={`${t('noti.col.line')} — ${t('noti.ev.digest')}`}
                    title={t('noti.lineP1')}
                    checked={false}
                    disabled
                    readOnly
                    style={off}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {tab === 'in' && data && (
        <SaveBar
          dirty={dirty}
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
    </section>
  );
}
