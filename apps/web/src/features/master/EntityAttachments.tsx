import type { Schemas } from '@tms/contracts';
import { Icon, ReasonDialog, Toast } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, ApiError, unwrap } from '../../api';
import { formatDate, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useMe } from '../../shell/AppShell';
import { can } from '../../nav';
import { stepUpHeaders, StepUpCancelled, withStepUp } from '../stepup/stepUp';
import { problemText } from './problems';

type Attachment = Schemas['AttachmentDto'];
export type AttachOwner = 'driver' | 'carrier';
const TYPES: Record<AttachOwner, readonly string[]> = {
  driver: ['LICENCE', 'ID_CARD', 'OTHER'],
  carrier: ['VAT_REG', 'CONTRACT', 'ID_CARD', 'BANK_BOOK', 'OTHER'],
};
/**
 * ไฟล์ที่เป็นข้อมูลส่วนบุคคล (review round 2 #1 — D-67(4)/D-79/D-73): เปิดได้เฉพาะผู้มีสิทธิ์ดูค่าเต็ม
 * หน้าสมุดบัญชี = `settlements:pay` + ยืนยัน 2FA · บัตรประชาชน = `pii.national_id:read` (API ตรวจซ้ำ — ไม่มีสิทธิ์ = 404)
 */
const PII_SCOPE: Record<string, string> = {
  BANK_BOOK: 'settlements:pay',
  ID_CARD: 'pii.national_id:read',
};

/** เปิดไฟล์ (ลิงก์อายุสั้นจาก GET /v1/documents/{id}) — หน้าสมุดบัญชีขอยืนยัน 2FA ผ่านกล่องกลาง */
async function openAttachment(id: string): Promise<void> {
  const d = await withStepUp((tok) =>
    unwrap(
      api.GET('/v1/documents/{id}', { params: { path: { id } }, headers: stepUpHeaders(tok) }),
    ),
  );
  if (!d.downloadUrl) throw new Error('not_ready');
  const u = new URL(d.downloadUrl, location.origin);
  const a = document.createElement('a');
  a.href = u.pathname + u.search;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
const MAX = 10 * 1024 * 1024;

/**
 * แท็บ "เอกสารแนบ" ของคนขับ / ผู้รับเหมา (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ — แถวไฟล์ + "+ แนบไฟล์"
 * แบบแท็บเอกสารรถ/ลิงก์ส่งเอกสาร `tms-vdoc__*`) · API `/v1/{drivers|carriers}/{id}/attachments` · ไฟล์ PDF/รูป ≤ 10 MB
 * เอาออก = เหตุผล ≥ 10 (ไม่ลบไฟล์) · สิทธิ์แก้ = `master:write`
 */
export function EntityAttachments({
  owner,
  id,
  canWrite,
}: {
  owner: AttachOwner;
  id: string;
  canWrite: boolean;
}) {
  const { t, lang } = useI18n();
  const me = useMe();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const qc = useQueryClient();
  const key = ['attachments', owner, id];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        owner === 'driver'
          ? api.GET('/v1/drivers/{id}/attachments', { params: { path: { id } } })
          : api.GET('/v1/carriers/{id}/attachments', { params: { path: { id } } }),
      ),
  });
  const [type, setType] = useState(TYPES[owner][0]!);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Attachment | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const remove = useMutation({
    mutationFn: (v: { documentId: string; reason: string }) =>
      unwrap(
        owner === 'driver'
          ? api.POST('/v1/drivers/{id}/attachments/remove', { params: { path: { id } }, body: v })
          : api.POST('/v1/carriers/{id}/attachments/remove', { params: { path: { id } }, body: v }),
      ),
    onSuccess: (d) => qc.setQueryData(key, d),
  });
  const label = (k: string) => t(`att.type.${owner}.${k}` as MessageKey);
  const scopes = me.data?.scopes ?? [];
  const canOpen = (k: string) => !PII_SCOPE[k] || can(scopes, PII_SCOPE[k]);

  const upload = async (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    const mime = MIME.find((m) => m === f.type);
    if (!mime || f.size === 0 || f.size > MAX) return setToast(t('att.badFile'));
    setBusy(true);
    try {
      const doc = await unwrap(
        api.POST('/v1/documents', {
          body: {
            kind: type === 'CONTRACT' ? 'CONTRACT' : 'OTHER',
            mime,
            bytes: f.size,
            filename: f.name,
            entityType: owner,
          },
        }),
      );
      const u = new URL(doc.uploadUrl!, location.origin);
      const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
      if (!up.ok) throw new ApiError((await up.json()) as never);
      const body = { documentId: doc.id, attachType: type };
      const d = await unwrap(
        owner === 'driver'
          ? api.POST('/v1/drivers/{id}/attachments', {
              params: { path: { id } },
              body: body as Schemas['AddDriverAttachmentDto'],
            })
          : api.POST('/v1/carriers/{id}/attachments', {
              params: { path: { id } },
              body: body as Schemas['AddCarrierAttachmentDto'],
            }),
      );
      qc.setQueryData(key, d);
      setToast(t('att.added', { n: label(type) }));
    } catch (e) {
      setToast(problemText(e, t) ?? t('att.error'));
    } finally {
      setBusy(false);
    }
  };

  const rows = list.data?.data ?? [];
  return (
    <section
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid={`att-${owner}`}
    >
      <div className="tms-vdoc__text">
        <span style={{ fontWeight: 600 }}>{t(`att.title.${owner}` as MessageKey)}</span>
        <span className="tms-vdoc__sub">{t(`att.desc.${owner}` as MessageKey)}</span>
      </div>
      <div className="tms-vdoc__list" aria-busy={list.isLoading || undefined}>
        {list.isLoading && <div className="tms-vdoc__item tms-skel" style={{ height: 62 }} />}
        {list.isError && (
          <div className="tms-vdoc__empty" role="alert">
            {problemText(list.error, t) ?? t('att.loadError')}
          </div>
        )}
        {list.isSuccess && !rows.length && (
          <div className="tms-vdoc__empty">{t(`att.empty.${owner}` as MessageKey)}</div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="tms-vdoc__item" data-testid="att-row">
            <Icon
              n={r.mime === 'application/pdf' ? 'file-text' : 'image'}
              s={18}
              style={{ color: '#59606B', flexShrink: 0 }}
            />
            <div className="tms-vdoc__text">
              <span className="tms-ellipsis">
                {label(r.attachType)}
                {r.filename ? ` · ${r.filename}` : ''}
              </span>
              <span className="tms-vdoc__sub">
                {t('att.meta', { d: formatDate(new Date(r.createdAt), lang, ys) })}
              </span>
            </div>
            {canOpen(r.attachType) ? (
              <button
                type="button"
                className="tms-vdoc__dl"
                title={t('att.download')}
                aria-label={`${t('att.download')} ${label(r.attachType)}`}
                onClick={() =>
                  void openAttachment(r.id).catch((e: unknown) => {
                    if (!(e instanceof StepUpCancelled))
                      setToast(problemText(e, t) ?? t('att.error'));
                  })
                }
              >
                <Icon n="download" s={16} />
              </button>
            ) : (
              // ไม่มีสิทธิ์ดูข้อมูลส่วนบุคคลนี้ — เห็นในรายการแต่เปิดไม่ได้
              <span
                className="tms-vdoc__dl"
                role="img"
                title={t('att.locked')}
                aria-label={`${t('att.locked')} ${label(r.attachType)}`}
                style={{ color: '#8A9099', cursor: 'not-allowed' }}
              >
                <Icon n="lock" s={16} />
              </span>
            )}
            {canWrite && (
              <button
                type="button"
                className="tms-vdoc__dl"
                title={t('att.remove')}
                aria-label={`${t('att.remove')} ${label(r.attachType)}`}
                onClick={() => setRemoving(r)}
              >
                <Icon n="ban" s={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      {canWrite && (
        <div className="tms-vdoc__bar" style={{ gap: 8 }}>
          <select
            className="tms-select"
            aria-label={t('att.type')}
            value={type}
            onChange={(e) => setType(e.target.value)}
            style={{ height: 32, width: 180 }}
          >
            {TYPES[owner].map((k) => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </select>
          <input
            ref={file}
            type="file"
            hidden
            accept={MIME.join(',')}
            data-testid={`att-file-${owner}`}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          <button
            type="button"
            className="tms-vdoc__add"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            <Icon n="plus" s={16} />
            {busy ? t('att.uploading') : t('att.add')}
          </button>
        </div>
      )}
      <ReasonDialog
        open={!!removing}
        title={t('att.removeT', { n: removing ? label(removing.attachType) : '' })}
        description={t('att.removeD')}
        label={t('veh.dlg.reason')}
        placeholder={t('att.reasonPh')}
        okLabel={t('att.remove')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={remove.isPending}
        error={problemText(remove.error, t)}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        onOk={(reason) =>
          removing &&
          remove.mutate(
            { documentId: removing.id, reason },
            {
              onSuccess: () => {
                setToast(t('att.removed', { n: label(removing.attachType) }));
                setRemoving(null);
              },
            },
          )
        }
      />
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </section>
  );
}
