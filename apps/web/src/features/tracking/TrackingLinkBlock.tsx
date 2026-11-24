import type { Schemas } from '@tms/contracts';
import { Icon, ReasonDialog, Toast } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { formatDate, useI18n } from '../../i18n';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';

export type TrackingLinkState = Schemas['TrackingLinkStateDto'];
export type TrackingKind = 'do' | 'customer';

const key = (kind: TrackingKind, id: string) => ['tracking-link', kind, id];

/** ลิงก์ติดตามที่ใช้ได้ (GET …/tracking-link) */
export function useTrackingLink(kind: TrackingKind, id: string, enabled = true) {
  return useQuery({
    queryKey: key(kind, id),
    enabled,
    retry: false,
    queryFn: () =>
      unwrap(
        kind === 'do'
          ? api.GET('/v1/delivery-orders/{id}/tracking-link', { params: { path: { id } } })
          : api.GET('/v1/customers/{id}/tracking-link', { params: { path: { id } } }),
      ) as Promise<TrackingLinkState>,
  });
}

/** ออกลิงก์ใหม่ (ลิงก์เดิมถูกเพิกถอน) / เพิกถอน (เหตุผล ≥ 10) */
export function useTrackingLinkActions(kind: TrackingKind, id: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: key(kind, id) });
  // ออกใหม่แทนลิงก์ที่ใช้ได้ = เพิกถอนลิงก์เดิม → ส่งเหตุผล (review M2) · ลิงก์แรกไม่ต้องมีเหตุผล
  const issue = useMutation({
    mutationFn: (reason?: string) => {
      const body = reason ? { reason } : {};
      return unwrap(
        kind === 'do'
          ? api.POST('/v1/delivery-orders/{id}/tracking-link', { params: { path: { id } }, body })
          : api.POST('/v1/customers/{id}/tracking-link', { params: { path: { id } }, body }),
      );
    },
    onSuccess: done,
  });
  const revoke = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        kind === 'do'
          ? api.POST('/v1/delivery-orders/{id}/tracking-link/revoke', {
              params: { path: { id } },
              body: { reason },
            })
          : api.POST('/v1/customers/{id}/tracking-link/revoke', {
              params: { path: { id } },
              body: { reason },
            }),
      ),
    onSuccess: done,
  });
  return { issue, revoke };
}

/**
 * ลิงก์ติดตามสำหรับผู้รับ (ST4-T14; docs/04 E2, spec/04 §4) — [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ]
 * ต้นแบบมีปุ่ม "คัดลอกลิงก์ติดตาม" / "เปิดหน้าผู้รับ" (footer drawer ติดตามรถ — หน้านอกเฟส 0) แต่ไม่มีที่ออก/เพิกถอนลิงก์ →
 * ใช้แถวลิงก์ของแท็บเอกสารแนบผู้รับเหมา (ST2-T21 `tms-vdoc__*`): แถว URL + "คัดลอกลิงก์ติดตาม" + "เปิดหน้าผู้รับ" +
 * ⊘ เพิกถอน (เหตุผล ≥ 10) และปุ่ม "+ สร้างลิงก์ติดตาม" / "ออกลิงก์ใหม่" (ลิงก์เดิมใช้ไม่ได้ — 1 ลิงก์ต่อ DO/ลูกค้า)
 * ระบบไม่ส่งลิงก์ให้ผู้รับเอง (ออกอัตโนมัติตอนจ่ายงาน EXE-060 ยังไม่ทำ) · สิทธิ์ตาม API: DO = orders:write/trips:dispatch, ลูกค้า = master:write
 */
export function TrackingLinkBlock({
  kind,
  id,
  onToast,
}: {
  kind: TrackingKind;
  id: string;
  onToast: (msg: string) => void;
}) {
  const { t, lang } = useI18n();
  const me = useMe();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const q = useTrackingLink(kind, id);
  const { issue, revoke } = useTrackingLinkActions(kind, id);
  const [revoking, setRevoking] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  const link = q.data?.link ?? null;
  const dt = (iso: string) => formatDate(new Date(iso), lang, ys);
  const copy = (url: string) => {
    // คัดลอกไม่ได้ (ไม่มีสิทธิ์ clipboard / ไม่ใช่ https) → แจ้งให้คัดลอกเองจากแถวลิงก์ (review L)
    const fail = () => onToast(t('trk.link.copyFailed'));
    if (!navigator.clipboard?.writeText) return fail();
    navigator.clipboard.writeText(url).then(() => onToast(t('trk.link.copied')), fail);
  };
  const create = () =>
    issue.mutate(undefined, {
      onSuccess: () => onToast(t('trk.link.issued')),
      onError: (e) => onToast(problemText(e, t) ?? t('trk.link.error')),
    });
  return (
    <section
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid={`trk-link-${kind}`}
    >
      <div className="tms-vdoc__text">
        <span style={{ fontWeight: 600 }}>{t('trk.link.title')}</span>
        <span className="tms-vdoc__sub">
          {t(kind === 'do' ? 'trk.link.descDo' : 'trk.link.descCust')}
        </span>
      </div>
      {q.isLoading && <div className="tms-vdoc__item tms-skel" style={{ height: 48 }} />}
      {q.isError && (
        <div className="tms-vdoc__empty" role="alert">
          {problemText(q.error, t) ?? t('trk.link.loadError')}
        </div>
      )}
      {link && (
        <>
          <div className="tms-vdoc__file" data-testid="trk-link-url">
            <Icon n="link" s={16} style={{ color: '#2257C4' }} />
            <span
              className="tms-num tms-ellipsis"
              style={{ flex: 1, fontSize: 13 }}
              title={link.url}
            >
              {link.url}
            </span>
            <button type="button" className="tms-vdoc__renew" onClick={() => copy(link.url)}>
              <Icon n="copy" s={14} />
              {t('trk.link.copy')}
            </button>
            <a
              className="tms-vdoc__renew"
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              style={{ textDecoration: 'none' }}
            >
              <Icon n="external-link" s={14} />
              {t('trk.link.open')}
            </a>
            <button
              type="button"
              className="tms-vdoc__dl"
              title={t('trk.link.revoke')}
              aria-label={t('trk.link.revoke')}
              onClick={() => setRevoking(true)}
            >
              <Icon n="ban" s={16} />
            </button>
          </div>
          <span className="tms-vdoc__sub">
            {t('trk.link.meta', {
              c: dt(link.createdAt),
              e: dt(link.expiresAt),
            })}
            {link.lastUsedAt ? ` · ${t('trk.link.used', { d: dt(link.lastUsedAt) })}` : ''}
          </span>
        </>
      )}
      {q.isSuccess && (
        <div className="tms-vdoc__bar">
          <button
            type="button"
            className="tms-vdoc__add"
            disabled={issue.isPending}
            onClick={() => (link ? setReissuing(true) : create())}
          >
            <Icon n={link ? 'refresh-cw' : 'plus'} s={16} />
            {t(link ? 'trk.link.reissue' : 'trk.link.create')}
          </button>
          {link && <span className="tms-vdoc__sub">{t('trk.link.reissueHint')}</span>}
        </div>
      )}
      <ReasonDialog
        open={reissuing}
        title={t('trk.link.reissueT')}
        description={t('trk.link.reissueD')}
        label={t('veh.dlg.reason')}
        placeholder={t('trk.link.reasonPh')}
        okLabel={t('trk.link.reissue')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={issue.isPending}
        error={problemText(issue.error, t)}
        onClose={() => {
          setReissuing(false);
          issue.reset();
        }}
        onOk={(reason) =>
          issue.mutate(reason, {
            onSuccess: () => {
              setReissuing(false);
              onToast(t('trk.link.reissued'));
            },
          })
        }
      />
      <ReasonDialog
        open={revoking}
        title={t('trk.link.revokeT')}
        description={t('trk.link.revokeD')}
        label={t('veh.dlg.reason')}
        placeholder={t('trk.link.reasonPh')}
        okLabel={t('trk.link.revoke')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={revoke.isPending}
        error={problemText(revoke.error, t)}
        onClose={() => {
          setRevoking(false);
          revoke.reset();
        }}
        onOk={(reason) =>
          revoke.mutate(reason, {
            onSuccess: () => {
              setRevoking(false);
              onToast(t('trk.link.revoked'));
            },
          })
        }
      />
    </section>
  );
}

/** ลิงก์ติดตามของลูกค้า (แท็บ "ที่อยู่ส่ง" ของ drawer ลูกค้า) — toast ของตัวเอง */
export function CustomerTrackingLink({ customerId }: { customerId: string }) {
  const { t } = useI18n();
  const [toast, setToast] = useState<string | null>(null);
  return (
    <>
      <TrackingLinkBlock kind="customer" id={customerId} onToast={setToast} />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}
