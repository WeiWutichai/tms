import { EmptyState, Icon, ReasonDialog, Toast } from '@tms/ui';
import { useState } from 'react';
import { ApiError } from '../../api';
import { formatDate, formatDateTime, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { openDocFile } from '../vehicles/useVehicleDocs';
import {
  useDocSubmissions,
  useIssueUploadLink,
  useReviewSubmission,
  useRevokeUploadLink,
  useUploadLinks,
  type DocSubmission,
  type IssuedUploadLink,
  type UploadLink,
} from './useCarrierDocs';
import {
  isSmsMobile,
  useCarrierMessages,
  useMessageChannels,
  useSendLink,
  type ChannelKey,
  type MessageDelivery,
} from './useLinkMessages';

/* สี soft() ของต้นแบบ TMS v4 */
const SOFT = {
  ok: { c: '#17733F', bg: '#E6F4EC' },
  warn: { c: '#8F5500', bg: '#FCF0DC' },
  err: { c: '#B3322A', bg: '#FBE9E7' },
  off: { c: '#3B424C', bg: '#ECEDEA' },
} as const;

const docLabel = (t: T, s: Pick<DocSubmission, 'docType' | 'title'>) =>
  s.title ||
  (s.docType === 'DRIVER_LICENCE'
    ? t('cdl.type.DRIVER_LICENCE')
    : t(`vdoc.type.${s.docType}` as MessageKey));
const subjectOf = (s: DocSubmission) => s.vehicle?.plate ?? s.driver?.name ?? '';
const nameOf = (t: T, s: DocSubmission) =>
  [subjectOf(s), docLabel(t, s), s.docNo].filter(Boolean).join(' · ');

const chName = (c: ChannelKey) => (c === 'line' ? 'LINE' : 'SMS');

/** บันทึกการส่ง 1 รายการ (ต้นแบบ: แถว log "ส่งข้อเสนอให้ … ผ่าน LINE" + ป้าย สำเร็จ/ล้มเหลว) */
function MessageRow({
  m,
  dt,
  t,
  copyable,
  canWrite,
}: {
  m: MessageDelivery;
  /** วัน + เวลา */
  dt: (iso: string) => string;
  t: T;
  copyable: boolean;
  canWrite: boolean;
}) {
  const title = t('cdoc.log.row', { ch: chName(m.channel), to: m.recipient });
  const sub =
    m.status === 'failed'
      ? // ผู้ที่สร้างลิงก์ไม่ได้ ไม่เห็นคำแนะนำให้สร้าง/คัดลอกลิงก์ (QA ST3-T21)
        t(!canWrite ? 'cdoc.log.failedPlain' : copyable ? 'cdoc.log.failedCopy' : 'cdoc.log.failed')
      : m.status === 'queued' && m.attempts > 0
        ? t('cdoc.log.retrying', { n: m.attempts + 1, code: m.errorCode ?? '-' })
        : t('cdoc.log.at', { d: dt(m.sentAt ?? m.createdAt) });
  return (
    <div className="tms-vdoc__item" data-testid="cdoc-msg" data-status={m.status}>
      <Icon n="send" s={18} style={{ color: '#59606B', flexShrink: 0 }} />
      <div className="tms-vdoc__text">
        <span className="tms-ellipsis" title={title}>
          {title}
        </span>
        <span className="tms-vdoc__sub tms-ellipsis" title={sub}>
          {sub}
        </span>
      </div>
      {m.status === 'sent' ? (
        <Pill tone="ok" label={t('cdoc.log.st.sent')} />
      ) : m.status === 'failed' ? (
        <Pill tone="err" label={t('cdoc.log.st.failed')} />
      ) : (
        <Pill tone="warn" label={t('cdoc.log.st.queued')} />
      )}
    </div>
  );
}

function Pill({ tone, label }: { tone: keyof typeof SOFT; label: string }) {
  return (
    <span className="tms-vdoc__pill" style={{ background: SOFT[tone].bg, color: SOFT[tone].c }}>
      {label}
    </span>
  );
}

/**
 * แท็บ "เอกสารแนบ" ของผู้รับเหมา (ST2-T21) — ลิงก์ให้รถร่วมอัปโหลดเอกสารเอง + ตรวจเอกสารที่ส่งมา
 * ต้นแบบไม่มีส่วนนี้ → ใช้ชิ้นเดียวกับแท็บเอกสารแนบของรถ (การ์ดไฟล์ ป้ายสถานะ ปุ่มเส้นขอบ) [OPEN spec/12 §3]
 * อนุมัติ/ไม่อนุมัติ = เหตุผล ≥ 10 ตัว (ReasonDialog เดียวกับทุก master)
 * ST3-T21: "ส่งผ่าน LINE" / "ส่ง SMS" ข้างปุ่มคัดลอกลิงก์ (แบบ footer ข้อเสนองานของต้นแบบ: คัดลอกลิงก์ + ส่งผ่าน LINE)
 * แสดงเฉพาะช่องที่ใช้ได้และผู้รับเหมามีผู้รับของช่องนั้น — ไม่มี/ล่ม = คัดลอกลิงก์ไปส่งเองได้เสมอ [OPEN spec/12 §3]
 */
export function CarrierDocsTab({
  carrierId,
  canWrite,
  contact,
}: {
  carrierId: string;
  canWrite: boolean;
  /** ผู้รับของผู้รับเหมา (เบอร์ / LINE userId) — ใช้ตัดสินว่าจะแสดงปุ่มส่งช่องไหน */
  contact?: { phone: string | null; lineContact: string | null };
}) {
  const { t, lang } = useI18n();
  const me = useMe();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const dt = (iso: string) =>
    formatDate(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), lang, ys);
  const links = useUploadLinks(carrierId);
  const subs = useDocSubmissions(carrierId);
  const issue = useIssueUploadLink(carrierId);
  const revoke = useRevokeUploadLink(carrierId);
  const review = useReviewSubmission();
  const [issued, setIssued] = useState<IssuedUploadLink | null>(null);
  const [revoking, setRevoking] = useState<UploadLink | null>(null);
  const [reviewing, setReviewing] = useState<{
    s: DocSubmission;
    action: 'approve' | 'reject';
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const channels = useMessageChannels();
  const log = useCarrierMessages(carrierId);
  const sendLink = useSendLink(carrierId);
  // LINE push ต้องใช้ userId (U + 32 hex) — LINE ID แบบ @ ที่กรอกเอง ส่งไม่ได้
  const sendable: ChannelKey[] = (['line', 'sms'] as const).filter(
    (c) =>
      channels.data?.has(c) &&
      (c === 'line'
        ? /^U[0-9a-f]{32}$/.test(contact?.lineContact ?? '')
        : isSmsMobile(contact?.phone)),
  );
  const send = (channel: ChannelKey, url: string) =>
    sendLink.mutate(
      { channel, url, idempotencyKey: crypto.randomUUID() },
      {
        onSuccess: () => setToast(t('cdoc.send.queued', { ch: chName(channel) })),
        onError: (e) => {
          const code =
            e instanceof ApiError
              ? (e.problem as { errors?: { code: string }[] }).errors?.[0]?.code
              : undefined;
          setToast(
            e instanceof ApiError && e.problem.code === 'channel_unavailable'
              ? t('cdoc.send.unavailable', { ch: chName(channel) })
              : code === 'recipient_missing' || code === 'recipient_invalid'
                ? t('cdoc.send.noRecipient', { ch: chName(channel) })
                : e instanceof ApiError && e.problem.code === 'rate_limited'
                  ? t('cdoc.send.limit')
                  : problemText(e, t),
          );
        },
      },
    );

  const active = (links.data ?? []).filter((l) => l.status === 'active');
  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    setToast(t('cdoc.link.copied'));
  };
  const download = (id: string) => openDocFile(id).catch(() => setToast(t('vdoc.downloadFailed')));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        data-testid="cdoc-links"
      >
        <div className="tms-vdoc__text">
          <span style={{ fontWeight: 600 }}>{t('cdoc.link.title')}</span>
          <span className="tms-vdoc__sub">{t('cdoc.link.desc')}</span>
        </div>
        {issued && (
          <div className="tms-vdoc__file" data-testid="cdoc-issued">
            <Icon n="link" s={16} style={{ color: '#2257C4' }} />
            <span
              className="tms-num tms-ellipsis"
              style={{ flex: 1, fontSize: 13 }}
              title={issued.url}
            >
              {issued.url}
            </span>
            <button type="button" className="tms-vdoc__renew" onClick={() => copy(issued.url)}>
              <Icon n="copy" s={14} />
              {t('cdoc.link.copy')}
            </button>
            {canWrite &&
              sendable.map((c) => (
                <button
                  key={c}
                  type="button"
                  // ต้นแบบมีปุ่มหลักเดียว "ส่งผ่าน LINE" — SMS เป็นปุ่มรอง [OPEN spec/12 §3]
                  className={
                    c === 'line' ? 'tms-vdoc__renew tms-vdoc__renew--pri' : 'tms-vdoc__renew'
                  }
                  disabled={sendLink.isPending}
                  onClick={() => send(c, issued.url)}
                >
                  <Icon n="send" s={14} />
                  {t(c === 'line' ? 'cdoc.send.line' : 'cdoc.send.sms')}
                </button>
              ))}
          </div>
        )}
        {issued && <span className="tms-vdoc__sub">{t('cdoc.link.once')}</span>}
        {active.map((l) => (
          <div key={l.id} className="tms-vdoc__item" data-testid="cdoc-link">
            <Icon n="link" s={18} style={{ color: '#59606B', flexShrink: 0 }} />
            <div className="tms-vdoc__text">
              <span className="tms-ellipsis">{t('cdoc.link.active', { d: dt(l.expiresAt) })}</span>
              <span className="tms-vdoc__sub">{t('cdoc.link.made', { d: dt(l.createdAt) })}</span>
            </div>
            {canWrite && (
              <button
                type="button"
                className="tms-vdoc__dl"
                title={t('cdoc.link.revoke')}
                aria-label={t('cdoc.link.revoke')}
                onClick={() => setRevoking(l)}
              >
                <Icon n="ban" s={16} />
              </button>
            )}
          </div>
        ))}
        {(log.data ?? []).map((m) => (
          <MessageRow
            key={m.id}
            m={m}
            dt={(iso) => formatDateTime(iso, lang, ys)}
            t={t}
            copyable={issued?.id === m.linkId}
            canWrite={canWrite}
          />
        ))}
        {canWrite && (
          <div className="tms-vdoc__bar">
            <button
              type="button"
              className="tms-vdoc__add"
              disabled={issue.isPending}
              onClick={() =>
                issue.mutate(undefined, {
                  onSuccess: (l) => setIssued(l),
                  onError: (e) =>
                    setToast(
                      e instanceof ApiError &&
                        (e.problem as { errors?: { code: string }[] }).errors?.[0]?.code ===
                          'link_limit'
                        ? t('cdoc.link.limit')
                        : problemText(e, t),
                    ),
                })
              }
            >
              <Icon n="plus" s={16} />
              {t('cdoc.link.create')}
            </button>
          </div>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{t('cdoc.sub.title')}</span>
        <div
          className="tms-vdoc__list"
          data-testid="cdoc-subs"
          aria-busy={subs.isLoading || undefined}
        >
          {subs.isLoading &&
            [0, 1].map((i) => (
              <div key={i} className="tms-vdoc__item tms-skel" style={{ height: 62 }} />
            ))}
          {subs.isError && (
            <div className="tms-vdoc__empty" role="alert">
              {t('cdoc.loadError')}{' '}
              <button type="button" className="tms-textlink" onClick={() => void subs.refetch()}>
                {t('veh.retry')}
              </button>
            </div>
          )}
          {(subs.data ?? []).map((s) => {
            const f = s.files[0];
            const name = nameOf(t, s);
            const sub =
              s.status === 'rejected' && s.reviewReason
                ? t('cdoc.why', { r: s.reviewReason })
                : t('cdoc.sub.meta', { s: dt(s.submittedAt), d: dt(s.expiresOn) });
            return (
              <div key={s.id} className="tms-vdoc__item" data-status={s.status}>
                <Icon
                  n={s.driver ? 'id-card' : f?.mime.startsWith('image/') ? 'image' : 'file-text'}
                  s={18}
                  style={{ color: '#59606B', flexShrink: 0 }}
                />
                <div className="tms-vdoc__text">
                  <span className="tms-ellipsis" title={name}>
                    {name}
                  </span>
                  <span className="tms-vdoc__sub tms-ellipsis" title={sub}>
                    {sub}
                  </span>
                </div>
                {s.status === 'pending_review' ? (
                  <Pill tone="warn" label={t('cdoc.st.pending')} />
                ) : s.status === 'approved' ? (
                  <Pill tone="ok" label={t('cdoc.st.approved')} />
                ) : (
                  <Pill tone="err" label={t('cdoc.st.rejected')} />
                )}
                {canWrite && s.status === 'pending_review' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      className="tms-vdoc__renew"
                      onClick={() => setReviewing({ s, action: 'approve' })}
                    >
                      <Icon n="check" s={14} />
                      {t('cdoc.approve')}
                    </button>
                    <button
                      type="button"
                      className="tms-vdoc__dl"
                      title={t('cdoc.reject')}
                      aria-label={t('cdoc.reject')}
                      onClick={() => setReviewing({ s, action: 'reject' })}
                    >
                      <Icon n="x" s={16} />
                    </button>
                  </span>
                )}
                {f && (
                  <button
                    type="button"
                    className="tms-vdoc__dl"
                    title={t('vdoc.download')}
                    aria-label={t('vdoc.download')}
                    onClick={() => download(f.id)}
                  >
                    <Icon n="download" s={18} />
                  </button>
                )}
              </div>
            );
          })}
          {subs.data && !subs.data.length && (
            <div className="tms-vdoc__empty">{t('cdoc.sub.empty')}</div>
          )}
        </div>
      </section>

      <EmptyState icon="file-text" title={t('cdoc.att.empty')} description={t('cdoc.att.emptyD')} />

      <ReasonDialog
        open={!!revoking}
        title={t('cdoc.link.revokeT')}
        description={t('cdoc.link.revokeD')}
        label={t('veh.dlg.reason')}
        placeholder={t('veh.dlg.reasonPh')}
        okLabel={t('cdoc.link.revoke')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={revoke.isPending}
        error={problemText(revoke.error, t)}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        onOk={(reason) => {
          if (!revoking) return;
          const id = revoking.id;
          revoke.mutate(
            { id, reason },
            {
              onSuccess: () => {
                setRevoking(null);
                setIssued((x) => (x?.id === id ? null : x));
                setToast(t('cdoc.link.revokeDone'));
              },
            },
          );
        }}
      />
      <ReasonDialog
        open={!!reviewing}
        title={
          reviewing
            ? t(reviewing.action === 'approve' ? 'cdoc.approveT' : 'cdoc.rejectT', {
                t: nameOf(t, reviewing.s),
              })
            : ''
        }
        description={t(reviewing?.action === 'reject' ? 'cdoc.rejectD' : 'cdoc.approveD')}
        label={t('veh.dlg.reason')}
        placeholder={t(reviewing?.action === 'reject' ? 'cdoc.rejectPh' : 'cdoc.reasonPh')}
        okLabel={t(reviewing?.action === 'reject' ? 'cdoc.reject' : 'cdoc.approve')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={review.isPending}
        error={problemText(review.error, t)}
        onClose={() => {
          setReviewing(null);
          review.reset();
        }}
        onOk={(reason) => {
          if (!reviewing) return;
          const { s, action } = reviewing;
          review.mutate(
            { id: s.id, reason, action },
            {
              onSuccess: () => {
                setReviewing(null);
                setToast(
                  t(action === 'approve' ? 'cdoc.approveDone' : 'cdoc.rejectDone', {
                    t: [subjectOf(s), docLabel(t, s)].join(' · '),
                  }),
                );
              },
            },
          );
        }}
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </div>
  );
}
