import { Field, ReasonDialog, TextInput } from '@tms/ui';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { queueErrorText, type QueueItem } from './queue';
import { useQueueAction } from './useQueue';

export type QueueDialogKind = 'skip' | 'externalId' | 'approve';

/**
 * dialog ทำรายการในแท็บล้มเหลว (ReasonDialog แบบ vDialog ของต้นแบบ — เหตุผล ≥ 10 ตัวอักษร ลง audit) — PO #86 24 พ.ย. 2569
 * - `skip` "ข้ามพร้อมเหตุผล" (docs/01 §6.4 "Skip พร้อมเหตุผล") → `POST …/queue/{id}/skip` · ย้ายไปแท็บสำเร็จ
 * - `externalId` "กรอกเลขเอง" (docs/01 §6.4 "กรอก external id มือ") → `POST …/queue/{id}/external-id` — ระบบอ่านเอกสารจากระบบบัญชีมาเทียบก่อน ไม่ส่งซ้ำ
 *   เอกสารที่ระบบบัญชีแยกหลายใบ (KRS แยกตามชนิด VAT) = API ตอบ 422 ให้กรอกต่อใบ — ช่องกรอกต่อใบยังไม่มีในหน้านี้ [OPEN — PO]
 * - `approve` "อนุมัติแทนที่" (ST8-T13 `replace_requires_approval` — ผู้อนุมัติ ≠ ผู้ขอ) → `POST …/queue/{id}/approve`
 */
export function QueueDialog({
  kind,
  x,
  erp,
  connectorId,
  onClose,
  onDone,
}: {
  kind: QueueDialogKind;
  x: QueueItem;
  erp: string;
  connectorId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const m = useQueueAction(connectorId);
  const [ext, setExt] = useState('');
  const [extNo, setExtNo] = useState('');
  const no = x.documentNo ?? x.id;
  const needExt = kind === 'externalId' && !ext.trim();
  return (
    <ReasonDialog
      open
      title={t(`erpq.qdlg.${kind}.title`, { no, erp })}
      description={t(`erpq.qdlg.${kind}.desc`, { erp })}
      label={t('ord.dlg.reason')}
      placeholder={kind === 'skip' ? t('erpq.qdlg.skip.ph', { erp }) : t('ord.dlg.reasonPh')}
      hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
      okLabel={t(`erpq.qdlg.${kind}.ok`)}
      {...(kind === 'approve' ? { okIcon: 'refresh-cw' } : {})}
      cancelLabel={t('common.cancel')}
      closeLabel={t('drawer.close')}
      busy={m.isPending}
      okDisabled={needExt}
      error={queueErrorText(m.error, t)}
      extra={
        kind === 'externalId' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label={t('erpq.q.extIdL', { erp })} hint={t('erpq.q.extIdH', { erp })}>
              {(p) => (
                <TextInput
                  {...p}
                  value={ext}
                  maxLength={100}
                  onChange={(e) => setExt(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('erpq.q.extNoL', { erp })}>
              {(p) => (
                <TextInput
                  {...p}
                  value={extNo}
                  maxLength={60}
                  onChange={(e) => setExtNo(e.target.value)}
                />
              )}
            </Field>
          </div>
        ) : undefined
      }
      onClose={onClose}
      onOk={(reason) =>
        m.mutate(
          kind === 'externalId'
            ? {
                action: 'externalId',
                id: x.id,
                reason,
                externalId: ext.trim(),
                ...(extNo.trim() ? { externalDocNo: extNo.trim() } : {}),
              }
            : { action: kind, id: x.id, reason },
          {
            onSuccess: () =>
              onDone(
                kind === 'externalId'
                  ? t('erpq.qt.externalId', { no, ext: ext.trim(), erp })
                  : t(`erpq.qt.${kind}`, { no, erp }),
              ),
          },
        )
      }
    />
  );
}
