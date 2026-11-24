import { ChoiceGroup, ReasonDialog } from '@tms/ui';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api';
import { useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { actionErrorText } from '../settlements/settle';
import { compareRows } from './erpq';
import { type CloseAction, type ReconcileResult, useCloseAction } from './useReconcile';

export type DialogKind = 'accept' | 'askFix' | 'useTms' | 'approve' | 'reject';

/** ข้อความผิดพลาด: 409 `invalid_state_transition` ที่มี `reason` ของหน้านี้ = ข้อความเฉพาะ · อื่น ๆ ตามกลาง */
export function closeErrorText(err: unknown, t: T): string | null {
  if (err instanceof ApiError && err.problem.code === 'invalid_state_transition') {
    const r = (err.problem as { reason?: unknown }).reason;
    const key = `erpq.err.${String(r)}` as MessageKey;
    if (typeof r === 'string' && t(key) !== key) return t(key);
  }
  return actionErrorText(err, t);
}

/**
 * dialog ปิดรายการไม่ตรง (ReasonDialog แบบ vDialog ของต้นแบบ — เหตุผล ≥ 10 ตัวอักษร ลง audit)
 * - `askFix` "ขออนุมัติแก้ {เลข}" = ต้นแบบ askFix ตรงตัว (ตาราง ฟิลด์ | ค่า {ERP} | ค่า TMS · ปุ่ม "ส่งขออนุมัติ") → ขออนุมัติส่งทับ
 * - `useTms` "ใช้ค่า TMS ส่งซ้ำ" = ส่งซ้ำตรง (docs/01 §6.5 — ลงบัญชีแล้ว/อายุเกินต้องอนุมัติตามประตูของ ST8-T13) · ต้นแบบส่งทันที → เพิ่มเหตุผล (audit)
 * - `approve` = ปุ่มเดียวกันบนรายการ "รออนุมัติ" ของผู้อนุมัติ (≠ ผู้ขอ / ผู้ออกใบ) → อนุมัติแล้วส่งทับ
 * - `reject` "ไม่อนุมัติ" (PO #94 24 พ.ย. 2569 — เพิ่มได้โดยไม่ส่ง Claude Design) = ผู้อนุมัติ (≠ ผู้ขอ) ปฏิเสธคำขอ → กลับเป็น "ไม่ตรง"
 * - `accept` "รับค่า {ERP}" = ไม่ส่งค่า TMS ทับ: เลือก ยอมรับความต่าง (ack) / แก้ที่ TMS แล้ว (D-54: ยกเลิกใบ + ออกใหม่ ST5-T10 — ต้องยกเลิกใบก่อน)
 *   ต้นแบบปิดทันที (toast) ไม่มี dialog — เพิ่มตัวเลือก + เหตุผลตาม docs/01 §6.5 "บันทึกคนและเหตุผลทุกครั้ง" [DECISION spec/12 §3 แถว ST8-T12]
 */
export function CloseDialog({
  kind,
  x,
  erp,
  onClose,
  onDone,
}: {
  kind: DialogKind;
  x: ReconcileResult;
  erp: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const m = useCloseAction();
  const voided = x.invoiceStatus === 'CANCELLED';
  const [how, setHow] = useState<'ack' | 'fix'>(voided ? 'fix' : 'ack');
  const no = x.localNumber ?? x.id;
  const diff = compareRows(t, x, erp)
    .filter((r) => r.diff)
    .map((r) => ({ f: r.f, b: r.erp, a: r.tms }));
  const action: CloseAction =
    kind === 'askFix'
      ? 'request'
      : kind === 'useTms'
        ? 'resend'
        : kind === 'approve'
          ? 'approve'
          : kind === 'reject'
            ? 'reject'
            : how === 'fix'
              ? 'resolve'
              : 'acknowledge';
  const fixBlocked = kind === 'accept' && how === 'fix' && !voided;
  const title =
    kind === 'askFix'
      ? t('erpq.dlg.askFix.title', { no })
      : kind === 'useTms'
        ? t('erpq.dlg.useTms.title', { no })
        : kind === 'approve'
          ? t('erpq.dlg.approve.title', { no })
          : kind === 'reject'
            ? t('erpq.dlg.reject.title', { no })
            : t('erpq.dlg.accept.title', { erp, no });
  const desc =
    kind === 'askFix'
      ? t('erpq.dlg.askFix.desc', { erp })
      : kind === 'useTms'
        ? t('erpq.dlg.useTms.desc', { erp })
        : kind === 'approve'
          ? t('erpq.dlg.approve.desc', { erp, r: x.overwrite?.reason ?? '—' })
          : kind === 'reject'
            ? t('erpq.dlg.reject.desc', { erp, r: x.overwrite?.reason ?? '—' })
            : t('erpq.dlg.accept.desc', { erp });
  const ok =
    kind === 'askFix'
      ? t('erpq.dlg.askFix.ok')
      : kind === 'useTms'
        ? t('erpq.dlg.useTms.ok')
        : kind === 'approve'
          ? t('erpq.dlg.approve.ok')
          : kind === 'reject'
            ? t('erpq.dlg.reject.ok')
            : t('erpq.dlg.accept.ok');
  return (
    <ReasonDialog
      open
      title={title}
      description={desc}
      label={t('ord.dlg.reason')}
      placeholder={t('ord.dlg.reasonPh')}
      hint={(n, okk) => (okk ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
      okLabel={ok}
      {...(kind === 'useTms' || kind === 'approve' ? { okIcon: 'refresh-cw' } : {})}
      cancelLabel={t('common.cancel')}
      closeLabel={t('drawer.close')}
      busy={m.isPending || fixBlocked}
      error={closeErrorText(m.error, t)}
      {...(kind !== 'accept'
        ? {
            diff: {
              rows: diff,
              labels: [
                t('erpq.cmp.field'),
                t('erpq.dlg.valErp', { erp }),
                t('erpq.dlg.valTms'),
              ] as [string, string, string],
            },
          }
        : {})}
      extra={
        kind === 'accept' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ChoiceGroup
              label={t('erpq.dlg.accept.how')}
              value={how}
              onChange={setHow}
              options={[
                { value: 'ack', label: t('erpq.dlg.accept.ack') },
                { value: 'fix', label: t('erpq.dlg.accept.fix') },
              ]}
            />
            {fixBlocked && (
              <span style={{ fontSize: 13, color: '#8F5500' }}>
                {t('erpq.dlg.accept.fixHint')}{' '}
                {x.invoiceId && (
                  <Link to={`/bill?invoice=${x.invoiceId}`}>{t('erpq.dlg.accept.openInv')}</Link>
                )}
              </span>
            )}
          </div>
        ) : undefined
      }
      onClose={onClose}
      onOk={(reason) =>
        m.mutate(
          { action, id: x.id, reason },
          {
            onSuccess: () =>
              onDone(
                action === 'request'
                  ? t('erpq.toast.asked', { no })
                  : action === 'reject'
                    ? t('erpq.toast.rejected', { no })
                    : action === 'approve' || action === 'resend'
                      ? t('erpq.toast.sent', { no, erp })
                      : action === 'resolve'
                        ? t('erpq.toast.fixed', { no })
                        : t('erpq.toast.acked', { no }),
              ),
          },
        )
      }
    />
  );
}
