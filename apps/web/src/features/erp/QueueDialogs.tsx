import { Field, ReasonDialog, TextInput } from '@tms/ui';
import { useState } from 'react';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { queueErrorText, type QueueItem } from './queue';
import { useQueueAction } from './useQueue';

/** กลุ่มที่ระบบบัญชีแยกใบ (ชนิด VAT) → ป้ายเดียวกับหน้ารายการค่าบริการ · ไม่รู้จัก = ค่าเดิม */
export function groupLabel(t: T, g: string): string {
  const k = `svc.vat.${g}` as MessageKey;
  return t(k) === k ? g : t(k);
}

export type QueueDialogKind = 'skip' | 'externalId' | 'approve';

/**
 * dialog ทำรายการในแท็บล้มเหลว (ReasonDialog แบบ vDialog ของต้นแบบ — เหตุผล ≥ 10 ตัวอักษร ลง audit) — PO #86 24 พ.ย. 2569
 * - `skip` "ข้ามพร้อมเหตุผล" (docs/01 §6.4 "Skip พร้อมเหตุผล") → `POST …/queue/{id}/skip` · ย้ายไปแท็บสำเร็จ
 * - `externalId` "กรอกเลขเอง" (docs/01 §6.4 "กรอก external id มือ") → `POST …/queue/{id}/external-id` — ระบบอ่านเอกสารจากระบบบัญชีมาเทียบก่อน ไม่ส่งซ้ำ
 *   เอกสารที่ระบบบัญชีแยกหลายใบ (KRS แยกตามชนิด VAT — `x.documents` ≥ 2 ใบ) = ช่องกรอกต่อใบ (ใบที่ระบบยืนยันเลขแล้วแสดงอย่างเดียว)
 *   → `documents[]` [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ: ช่องแบบ Field/TextInput เดิมใน extra ของ ReasonDialog]
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
  // ใบตามแผนการแยกของระบบบัญชี (≥ 2 ใบ) — ค่าเริ่ม = เลขที่คนกรอกไว้ก่อน (ยังไม่ยืนยัน แก้ทับได้)
  const parts = kind === 'externalId' ? (x.documents ?? []) : [];
  const split = parts.length > 1;
  const [docs, setDocs] = useState<Record<string, { id: string; no: string }>>(() =>
    Object.fromEntries(
      parts.map((p) => [p.ref, { id: p.externalId ?? '', no: p.externalDocNo ?? '' }]),
    ),
  );
  const entered = parts.filter((p) => !p.confirmed && docs[p.ref]?.id.trim());
  const no = x.documentNo ?? x.id;
  const needExt = kind === 'externalId' && (split ? entered.length === 0 : !ext.trim());
  const setDoc = (ref: string, k: 'id' | 'no', v: string) =>
    setDocs((d) => ({ ...d, [ref]: { ...(d[ref] ?? { id: '', no: '' }), [k]: v } }));
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
        kind === 'externalId' && split ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ fontSize: 13, color: '#3B424C' }}>
              {t('erpq.q.splitD', { erp, n: parts.length })}
            </span>
            {parts.map((p, i) => (
              <div
                key={p.ref}
                data-testid="erpq-part"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '10px 12px',
                  border: '1px solid #D9DCD4',
                  borderRadius: 8,
                }}
              >
                <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{t('erpq.q.part', { n: i + 1 })}</span>
                  <span className="tms-num" style={{ fontSize: 13, color: '#2257C4' }}>
                    {p.ref}
                  </span>
                  <span style={{ fontSize: 12.5, color: '#59606B' }}>
                    {[
                      p.group ? groupLabel(t, p.group) : '',
                      p.lineNos.length ? t('erpq.q.partLines', { l: p.lineNos.join(', ') }) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {p.confirmed ? (
                  <span style={{ fontSize: 13, color: '#17733F' }}>
                    {t('erpq.q.partKnown', { ext: p.externalDocNo ?? p.externalId ?? '' })}
                  </span>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                      gap: 8,
                    }}
                  >
                    <Field label={t('erpq.q.extIdL', { erp })}>
                      {(f) => (
                        <TextInput
                          {...f}
                          value={docs[p.ref]?.id ?? ''}
                          maxLength={100}
                          onChange={(e) => setDoc(p.ref, 'id', e.target.value)}
                        />
                      )}
                    </Field>
                    <Field label={t('erpq.q.extNoL', { erp })}>
                      {(f) => (
                        <TextInput
                          {...f}
                          value={docs[p.ref]?.no ?? ''}
                          maxLength={60}
                          onChange={(e) => setDoc(p.ref, 'no', e.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                )}
              </div>
            ))}
            <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('erpq.q.splitH', { erp })}</span>
          </div>
        ) : kind === 'externalId' ? (
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
      onOk={(reason) => {
        const done = (ext: string) =>
          onDone(
            kind === 'externalId'
              ? t('erpq.qt.externalId', { no, ext, erp })
              : t(`erpq.qt.${kind}` as 'erpq.qt.skip', { no, erp }),
          );
        if (kind === 'externalId' && split) {
          const documents = entered.map((p) => ({
            ref: p.ref,
            externalId: docs[p.ref]!.id.trim(),
            ...(docs[p.ref]!.no.trim() ? { externalDocNo: docs[p.ref]!.no.trim() } : {}),
          }));
          m.mutate(
            { action: 'externalDocuments', id: x.id, reason, documents },
            { onSuccess: () => done(documents.map((d) => d.externalId).join(', ')) },
          );
          return;
        }
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
          { onSuccess: () => done(ext.trim()) },
        );
      }}
    />
  );
}
