import { Icon } from '@tms/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

/** เหตุผลขั้นต่ำของการยกเว้น/ยืนยันกฎ (API `RULE_REASON_MIN_LENGTH` — CLAUDE.md ≥ 10) */
export const RULE_REASON_MIN = 10;

/**
 * ป้ายสั้นของกฎ (ต้นแบบ TMS v4 `issueOf` / `blockWhy`: "น้ำหนักเกิน", "เอกสารรถหมดอายุ", "ใบขับขี่ไม่ตรง", "รถซ่อม/จอด" …)
 * รหัสจาก API (`warnings[].code` / `pendingRules[].code`) — รหัสที่ไม่รู้จัก = "ติดเงื่อนไข"
 */
export function ruleTagKey(code: string): MessageKey {
  if (code === 'OVERWEIGHT') return 'plan.tag.weight';
  if (code === 'OVER_VOLUME') return 'plan.tag.volume';
  if (code === 'DOC_MISSING') return 'plan.tag.docMissing';
  if (code.startsWith('DOC_')) return 'plan.tag.doc';
  if (code === 'DRIVER_LICENCE_EXPIRED') return 'plan.tag.licExpired';
  if (code === 'DRIVER_LICENCE_MISSING') return 'plan.tag.licMissing';
  if (code === 'DRIVER_LICENCE_CLASS') return 'plan.tag.licClass';
  if (code.endsWith('_overlap')) return 'plan.tag.clash';
  if (code === 'DRIVING_HOURS_EXCEEDED') return 'plan.tag.hours';
  if (code === 'LOCATION_VEHICLE_LIMIT') return 'plan.tag.site';
  if (
    [
      'CAPABILITY_MISSING',
      'VEHICLE_SMALLER_THAN_REQUESTED',
      'TEMP_MISMATCH',
      'HAZMAT_NOT_ALLOWED',
    ].includes(code)
  )
    return 'plan.tag.compat';
  if (code === 'vehicle_not_ready') return 'plan.tag.notReady';
  if (code.endsWith('on_leave')) return 'plan.tag.leave';
  if (code.startsWith('stop_')) return 'plan.tag.stop';
  return 'plan.tag.other';
}

export interface BlockedReason {
  code: string;
  message: string;
  /** กุญแจของกฎ (409 `blocks[].key` / กระดาน `pendingRules[].key`) — ยกเว้นเฉพาะกฎที่แสดง; ป้ายรายวันของแถวรถไม่มี */
  key?: string;
}

/**
 * "ห้ามจ่ายงาน · {ทะเบียน}" — ต้นแบบ TMS v4 `BP` (vBp): รายการกฎที่ติด (ไอคอน ban + ป้าย + รายละเอียด + ลิงก์ไปแก้)
 * + "ยกเว้นกฎ (เฉพาะผู้จัดการ)" ช่องเหตุผล + "ยกเว้นและบันทึก log"
 * ต่างจากต้นแบบ: ไม่มีปุ่มสลับบทบาท "สิทธิ์ตัวอย่าง" (ใช้สิทธิ์จริง `trips:override` — D-07) · เหตุผล ≥ 10 ตัว (ต้นแบบ 5)
 */
export function BlockedDialog({
  open,
  plate,
  sub,
  reasons,
  canOverride,
  initialReason = '',
  nothing = false,
  busy,
  error,
  onLink,
  onOk,
  onClose,
}: {
  open: boolean;
  plate: string;
  sub: string;
  reasons: BlockedReason[];
  canOverride: boolean;
  /** เติมเหตุผลล่าสุด (ผู้ใช้ยังต้องกดยืนยันเอง) */
  initialReason?: string;
  /** ไม่มีเที่ยวให้ยกเว้น (เปิดจาก (i) ของแถวรถที่ยังไม่มีงานติดกฎ) → ยกเว้นไม่ได้ */
  nothing?: boolean;
  busy?: boolean;
  error?: string | null;
  onLink: (code: string) => void;
  /** `keys` = กุญแจของกฎที่แสดง (เฉพาะที่มี key) */
  onOk: (reason: string, keys: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [reason, setReason] = useState('');
  const sent = useRef(false);
  useEffect(() => {
    if (open) {
      setReason(initialReason);
      sent.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (error || !busy) sent.current = false;
  }, [busy, error]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  const allowed = canOverride && !nothing;
  const ok = allowed && reason.trim().length >= RULE_REASON_MIN && !busy;
  const btn = ok ? '#2257C4' : '#E4E6E0';
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(10,23,52,.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        data-testid="plan-blocked-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#FFFFFF',
          border: '1px solid #D9DCD4',
          borderRadius: 20,
          boxShadow: '0 18px 44px rgba(10,23,52,.10)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '20px 24px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 id={`${id}-t`} style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#13213F' }}>
            {t('plan.bp.title', { plate })}
          </h2>
          <span style={{ color: '#3B424C' }}>{sub}</span>
        </div>
        <div style={{ padding: '12px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {reasons.map((w, i) => (
            <div
              key={`${w.code}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                border: '1px solid #E4E6E0',
                borderRadius: 10,
              }}
            >
              <Icon n="ban" s={16} style={{ color: '#B3322A' }} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column', lineHeight: 1.5 }}>
                <span style={{ fontWeight: 600 }}>{t(ruleTagKey(w.code))}</span>
                <span style={{ color: '#3B424C' }}>{w.message}</span>
              </span>
              <button
                type="button"
                onClick={() => onLink(w.code)}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: '#2257C4',
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {t(w.code.startsWith('DRIVER_') ? 'plan.bp.link.driver' : 'plan.bp.link.doc')}
              </button>
            </div>
          ))}
        </div>
        <div
          style={{
            padding: '4px 24px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            borderTop: '1px solid #E4E6E0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 12 }}>
            <label
              htmlFor={id}
              style={{ fontSize: 12.5, fontWeight: 500, color: '#3B424C', flex: 1 }}
            >
              {t('plan.bp.overrideLabel')}
            </label>
          </div>
          <textarea
            id={id}
            rows={2}
            value={reason}
            disabled={!allowed}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('plan.bp.ph')}
            style={{
              border: '1px solid #D9DCD4',
              borderRadius: 8,
              padding: '8px 10px',
              resize: 'vertical',
              color: '#101418',
              font: 'inherit',
            }}
          />
          <span style={{ fontSize: 12.5, color: '#3B424C' }}>
            {t(!canOverride ? 'plan.bp.hintNo' : nothing ? 'plan.bp.noTrips' : 'plan.bp.hintYes')}
          </span>
          {error && <span className="tms-field-error">{error}</span>}
        </div>
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid #E4E6E0',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 36,
              padding: '0 14px',
              border: 0,
              borderRadius: 999,
              background: 'transparent',
              color: '#3B424C',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t('plan.bp.close')}
          </button>
          <button
            type="button"
            disabled={!ok}
            aria-busy={busy}
            onClick={() => {
              if (!ok || sent.current) return;
              sent.current = true;
              onOk(
                reason.trim(),
                reasons.flatMap((r) => (r.key ? [r.key] : [])),
              );
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              height: 36,
              padding: '0 18px',
              border: `1px solid ${btn}`,
              borderRadius: 999,
              background: btn,
              color: ok ? '#FFFFFF' : '#59606B',
              fontWeight: 500,
              cursor: ok ? 'pointer' : 'not-allowed',
            }}
          >
            <Icon n="shield-alert" s={16} />
            {t('plan.bp.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
