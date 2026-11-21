import { ReasonDialog } from '@tms/ui';
import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { money } from '../rate-cards/rateFormat';
import { StepUpBox } from '../settings/OrgSections';
import { stepUp } from '../settings/useSettings';
import { isStale } from '../master/problems';
import { actionErrorText, isStepUp } from './settle';
import { useApproveSettlement, useSettlement } from './useSettlements';

/**
 * dialog อนุมัติ (ST6-T07; ต้นแบบ askApproveSa → vDialog: "อนุมัติ {เลข}" · "{ผู้รับเหมา} · สุทธิ ฿…" · เหตุผล ≥ 10 · ปุ่ม "อนุมัติ")
 * ร่างยังไม่มีเลข → หัวใช้ "ร่าง (ยังไม่มีเลข)" (เลข STL ออกตอนอนุมัติ) · ยอดเกินวงเงิน → API ตอบ `step_up_required` →
 * กล่องยืนยัน 2FA (`StepUpBox` เดิมของหน้าตั้งค่า — ต้นแบบไม่มี [DECISION spec/12 §3]) ใต้ช่องเหตุผล แล้วส่งซ้ำพร้อม token
 * error อื่น (ผู้เตรียมอนุมัติเอง 403 · มีรายการโต้แย้ง/ใบว่าง/ติดลบ/ต้องส่งรถร่วมตรวจ 409 · 412) = ข้อความไทยจาก problem
 * version อ่านจากใบล่าสุด (`useSettlement`) — 412 → โหลดใบใหม่ กดซ้ำ (รวมส่งซ้ำหลัง step-up) ใช้ version ใหม่ (review M1)
 */
export function ApproveDialog({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: (no: string) => void;
}) {
  const { t } = useI18n();
  const q = useSettlement(id);
  const s = q.data;
  const approve = useApproveSettlement();
  const reason = useRef('');
  const [needStepUp, setNeedStepUp] = useState(false);
  const [stepErr, setStepErr] = useState<string | null>(null);
  const send = (token?: string) => {
    if (!s) return;
    approve.mutate(
      { id: s.id, version: s.version, reason: reason.current, ...(token ? { stepUp: token } : {}) },
      {
        onSuccess: (r) => onDone(r.settlementNo ?? ''),
        onError: (e) => {
          if (isStepUp(e)) setNeedStepUp(true);
          if (isStale(e)) void q.refetch();
        },
      },
    );
  };
  const err = needStepUp && isStepUp(approve.error) ? null : actionErrorText(approve.error, t);
  return (
    <ReasonDialog
      open
      title={t('settle.appr.title', { no: s?.settlementNo ?? t('settle.draftNo') })}
      description={
        s
          ? t('settle.appr.desc', {
              c: s.carrier.legalName,
              n: s.buyNetAfterWht !== undefined ? money(s.buyNetAfterWht) : '—',
            })
          : '…'
      }
      label={t('ord.dlg.reason')}
      placeholder={t('ord.dlg.reasonPh')}
      hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
      okLabel={t('settle.appr.ok')}
      cancelLabel={t('common.cancel')}
      closeLabel={t('drawer.close')}
      busy={approve.isPending || !s}
      error={stepErr ?? err}
      extra={
        needStepUp ? (
          <StepUpBox
            onConfirm={(otp) => {
              setStepErr(null);
              stepUp(otp)
                .then((tok) => send(tok))
                .catch((e: unknown) => setStepErr(actionErrorText(e, t)));
            }}
            onCancel={() => setNeedStepUp(false)}
          />
        ) : undefined
      }
      onClose={onClose}
      onOk={(r) => {
        reason.current = r;
        setStepErr(null);
        send();
      }}
    />
  );
}
