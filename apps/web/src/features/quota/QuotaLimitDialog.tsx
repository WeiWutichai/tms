import { color, Icon, useEscapeLayer, useModalFocus } from '@tms/ui';
import { useRef } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

/** 409 ของ hard limit (P1-ST1-T08 · spec/01 PLT-079) */
export const LIMIT_CODES = [
  'connector_limit_reached',
  'webhook_limit_reached',
  'seat_limit_reached',
] as const;

interface LimitProblem {
  code: (typeof LIMIT_CODES)[number];
  featureKey?: string;
  limit?: number;
  used?: number;
  upgradePlan?: { code: string; name: string; limit: number | null } | null;
}

/** problem ของ hard limit หรือ null */
export function limitProblem(err: unknown): LimitProblem | null {
  if (!(err instanceof ApiError)) return null;
  const p = err.problem as unknown as LimitProblem;
  return (LIMIT_CODES as readonly string[]).includes(p.code) ? p : null;
}

const UNIT: Record<string, MessageKey> = {
  conn: 'quota.unit.conn',
  webhook: 'quota.unit.webhook',
  users: 'quota.unit.users',
};

/**
 * dialog "ครบโควตาแพ็กเกจ" (P1-ST1-T08 · PLT-079 hard limit: สร้างรายการใหม่ไม่ได้ + เสนออัปเกรด)
 * กรอบ/ข้อความตามต้นแบบ TMS v4 modal `quota` (หัว + คำอธิบาย + บรรทัดไอคอน arrow-up-circle "อัปเกรดเป็น…" + ปุ่มปิด)
 * - บรรทัด "ซื้อ add-on" และปุ่ม "ดูการอัปเกรด"/ชำระเงินของต้นแบบยังไม่แสดง — หน้าแพ็กเกจ/add-on ของลูกค้ายังไม่มี (ขอบเขตเฟส —
 *   spec/12 §3 [DECISION — lead 2026-11-28, ย้อนได้]) → แนะนำให้ติดต่อทีมงาน
 */
export function QuotaLimitDialog({
  problem,
  onClose,
}: {
  problem: LimitProblem;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEscapeLayer(true, onClose);
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(true, box);
  const unit = t(UNIT[problem.featureKey ?? ''] ?? 'quota.unit.item');
  const n = (x: number | undefined) => (x ?? 0).toLocaleString('en-US');
  const up = problem.upgradePlan;
  const title = t(`problem.${problem.code}` as MessageKey);
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        ref={box}
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        data-modal-focus=""
        aria-label={title}
        data-testid="quota-limit-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{title}</h2>
            <p className="tms-dialog__desc">
              {t('quota.limit.sub', { limit: n(problem.limit), used: n(problem.used), unit })}
            </p>
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            aria-label={t('drawer.close')}
            title={t('drawer.close')}
            onClick={onClose}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-dialog__body">
          <span style={{ display: 'flex', gap: 8 }}>
            <Icon
              n="arrow-up-circle"
              s={16}
              style={{ color: color.accent, marginTop: 4, flexShrink: 0 }}
            />
            {up
              ? up.limit === null
                ? t('quota.limit.upgradeUnlimited', { plan: up.name, unit })
                : t('quota.limit.upgrade', { plan: up.name, limit: n(up.limit), unit })
              : t('quota.limit.contact')}
          </span>
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('drawer.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
