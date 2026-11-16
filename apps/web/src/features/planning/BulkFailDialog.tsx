import { Icon, useEscapeLayer } from '@tms/ui';
import { useI18n } from '../../i18n';
import type { BulkResults } from '../trips/useTrips';

/**
 * ผล bulk "จัดรถ" / "ปล่อยเที่ยว" ที่ไม่สำเร็จบางรายการ (ST3-T17 — ไม่ใช่ all-or-nothing): จำนวนที่สำเร็จ + รายการเที่ยวที่ไม่สำเร็จ
 * พร้อมเหตุผลจาก API (เช่น 409 คำเตือนที่ยังไม่ยืนยัน) และปุ่ม "เปิดเที่ยว" ไปแก้/ยืนยันทีละเที่ยวใน drawer
 * ต้นแบบไม่มี dialog นี้ (ต้นแบบปล่อยได้ทุกเที่ยว) — ใช้กรอบ dialog ชุดเดียวกับ ReasonDialog (`tms-dialog`) · spec/12 §3 DECISION
 */
export function BulkFailDialog({
  results,
  tripNo,
  onOpen,
  onClose,
}: {
  results: BulkResults['results'];
  /** เลขเที่ยวจากกระดาน (ผลที่ไม่สำเร็จไม่มีเลข) */
  tripNo: (id: string) => string;
  onOpen: (tripId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEscapeLayer(true, onClose);
  const failed = results.filter((r) => !r.trip);
  const ok = results.length - failed.length;
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('plan.bulk.failTitle', { n: failed.length })}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{t('plan.bulk.failTitle', { n: failed.length })}</h2>
            <p className="tms-dialog__desc">
              {ok > 0 && `${t('plan.bulk.ok', { n: ok })} · `}
              {t('plan.bulk.failDesc')}
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
          {failed.map((r) => (
            <div
              key={r.tripId}
              data-testid="bulk-fail"
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}
            >
              <Icon
                n="triangle-alert"
                s={16}
                style={{ color: '#8F5500', marginTop: 3, flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span className="tms-num" style={{ fontWeight: 500, color: '#2257C4' }}>
                  {tripNo(r.tripId) || r.tripId}
                </span>
                <span style={{ color: '#3B424C' }}>{problemLine(r.problem)}</span>
              </div>
              <button
                type="button"
                onClick={() => onOpen(r.tripId)}
                style={{
                  border: 0,
                  background: 'transparent',
                  padding: 0,
                  color: '#2257C4',
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('plan.bulk.open')}
              </button>
            </div>
          ))}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('plan.bulk.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** ข้อความเหตุผลของรายการ: หัวข้อ problem + กฎที่ค้าง (409) หรือช่องที่ผิด (422) */
function problemLine(p: BulkResults['results'][number]['problem']): string {
  if (!p) return '';
  const rules = [...(p.blocks ?? []), ...(p.warnings ?? [])]
    .map((x) => String((x as { message?: unknown }).message ?? ''))
    .filter(Boolean);
  const detail = rules.length ? rules.join(' · ') : (p.detail ?? '');
  return detail ? `${p.title} — ${detail}` : p.title;
}
