import { Icon } from '@tms/ui';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { formatDateTime, useI18n } from '../../i18n';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { codeLabel, groupDeliveries, okStatus, payloadText, resendToast } from './deliveries';
import {
  fetchDelivery,
  useRetryDelivery,
  useWebhookDeliveries,
  type WebhookDelivery,
} from './useWebhooks';

/**
 * "ประวัติการส่ง" ใน drawer webhook (ST7-T05) — ต้นแบบ TMS v4 vPanelApi hook `apx.dl`:
 * แถวละ event: ชื่อ event (+ " · ทดสอบ") · ป้ายรหัส HTTP (เขียว 2xx / แดง) · เวลา · ms · "ลอง N ครั้ง" · ดูข้อมูล · ส่งซ้ำ (ไม่สำเร็จ)
 * - "ส่งซ้ำ" ไม่แสดงกับ event ทดสอบ (ไม่มี event จริงให้ส่งซ้ำ — ใช้ "ส่ง event ทดสอบ") และผู้ที่ไม่มีสิทธิ์จัดการ [DECISION spec/12 §3]
 */
export function DeliveryHistory({
  endpointId,
  canWrite,
  toast,
}: {
  endpointId: string;
  canWrite: boolean;
  toast: (s: string) => void;
}) {
  const { t, lang } = useI18n();
  const me = useMe();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const q = useWebhookDeliveries(endpointId);
  const retry = useRetryDelivery();
  const [view, setView] = useState<{ title: string; sub: string; json: string } | null>(null);
  const rows = groupDeliveries(q.data?.data ?? []);
  const when = (d: WebhookDelivery) => formatDateTime(d.sentAt, lang, ys);

  const open = async (d: WebhookDelivery) => {
    try {
      const x = await fetchDelivery(d.id);
      setView({
        title: t('whk.dl.title', { ev: d.eventType }),
        sub: t('whk.dl.sub', {
          id: d.eventId,
          t: when(d),
          code: codeLabel(t, d),
        }),
        json: payloadText(t, x),
      });
    } catch (e) {
      toast(problemText(e, t) ?? '');
    }
  };
  const resend = (d: WebhookDelivery) =>
    retry.mutate(d.id, {
      onSuccess: (r) => toast(resendToast(t, r)),
      onError: (e) =>
        toast(
          e instanceof ApiError && e.problem.code === 'invalid_state_transition'
            ? t('whk.toast.reEnableFirst')
            : (problemText(e, t) ?? ''),
        ),
    });

  return (
    <section className="whk-dl">
      <div className="whk-dl__h">
        <span>{t('whk.dl.h')}</span>
      </div>
      <div className="whk-dl__list" aria-busy={q.isLoading}>
        {q.isError && <p className="whk-dl__msg">{problemText(q.error, t)}</p>}
        {rows.map((d) => {
          const ok = okStatus(d.responseStatus);
          const busy = retry.isPending && retry.variables === d.id;
          return (
            <div key={d.id} className="whk-dl__row" data-testid="whk-delivery">
              <span className="whk-dl__ev">
                {d.eventType}
                {d.test ? t('whk.dl.test') : ''}
              </span>
              <span className={`whk-dl__code${ok ? ' is-ok' : ''}`}>{codeLabel(t, d)}</span>
              <span className="whk-dl__meta">
                {when(d)} · {t('whk.dl.ms', { n: d.durationMs.toLocaleString('th-TH') })} ·{' '}
                {t('whk.dl.tries', { n: d.attempt })}
              </span>
              <span className="whk-dl__acts">
                <button type="button" onClick={() => void open(d)}>
                  {t('whk.dl.view')}
                </button>
                {!ok && !d.test && canWrite && (
                  <button type="button" disabled={busy} onClick={() => resend(d)}>
                    {t('whk.dl.resend')}
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {view && (
        <PayloadDialog
          {...view}
          onClose={() => setView(null)}
          onCopy={() => {
            void navigator.clipboard?.writeText(view.json).catch(() => undefined);
            toast(t('whk.toast.payloadCopied'));
          }}
        />
      )}
    </section>
  );
}

/** หน้าต่าง payload — ต้นแบบ TMS v4 PL (กว้าง 640, radius 20, กล่อง pre พื้น #EBEDE8, ปุ่ม ปิด / คัดลอก) · Esc/คลิกพื้นหลังปิด */
export function PayloadDialog({
  title,
  sub,
  json,
  onClose,
  onCopy,
}: {
  title: string;
  sub: string;
  json: string;
  onClose: () => void;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="whk-pl__scrim" onClick={onClose}>
      <div
        className="whk-pl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="whk-pl__head">
          <div>
            <h2>{title}</h2>
            <p>{sub}</p>
          </div>
          <button type="button" aria-label={t('drawer.close')} onClick={onClose}>
            <Icon n="x" s={18} />
          </button>
        </div>
        <pre>{json}</pre>
        <div className="whk-pl__foot">
          <button type="button" className="whk-pl__close" onClick={onClose}>
            {t('whk.dl.close')}
          </button>
          <button type="button" className="whk-pl__copy" onClick={onCopy}>
            <Icon n="copy" s={16} />
            {t('whk.copy')}
          </button>
        </div>
      </div>
    </div>
  );
}
