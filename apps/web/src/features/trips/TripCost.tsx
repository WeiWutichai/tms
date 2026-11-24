import { Icon, useEscapeLayer, useModalFocus } from '@tms/ui';
import { useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { useDateTimeText } from '../rate-cards/rateFormat';
import { useCloseTripCost, useTripCosts, useTripRevenue } from './useTripList';
import type { TripDetail } from './useTrips';

/** สถานะที่เกี่ยวกับต้นทุน: จบเที่ยว (ปิดได้) / ปิดแล้ว */
const COST_STATES = new Set(['COMPLETED', 'COSTED', 'SETTLED']);

const money = (v: string) =>
  Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** แถว "ยอดเงิน" (ต้นแบบ vPanel kvM: ป้ายซ้าย/ตัวเลขขวา · แถวกำไรตัวหนามีเส้นคั่นบน) */
function Row({ k, v, bold, warn }: { k: ReactNode; v: ReactNode; bold?: boolean; warn?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 0',
        borderTop: bold ? '1px solid #E4E6E0' : '0',
      }}
    >
      <span style={{ color: '#3B424C', fontWeight: bold ? 600 : 400 }}>{k}</span>
      <span
        className="tms-num"
        style={{
          fontWeight: bold ? 600 : 400,
          color: warn ? '#8F5500' : '#101418',
          textAlign: 'right',
        }}
      >
        {v}
      </span>
    </div>
  );
}

/**
 * ส่วน "ยอดเงิน" ของ drawer เที่ยว (ต้นแบบ vPanel 'trp' kvM: รายได้จาก DO / ค่าเที่ยวรถร่วม|ต้นทุนประเมิน / กำไรเที่ยวนี้)
 * [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ] — แทนแถว ST3-T16 "ยังไม่แสดงยอดเงิน (ST6)":
 * รายได้ = Σ รายได้ของ DO ในเที่ยว (`prices.sell:read`) · ค่าเที่ยว = ต้นทุนสุทธิ `GET /trips/{id}/costs` buyTotal (`prices.buy:read`)
 * · กำไร = รายได้ − ค่าเที่ยว แสดงเฉพาะผู้มี**ทั้งสองสิทธิ์** (API ไม่มี field กำไร — spec/12 §3 ST6-T01c "ผู้มีทั้งสองสิทธิ์คำนวณเอง")
 * + แถว "ต้นทุนเที่ยว" (ปิดแล้ว / ยังไม่ปิด / สิ่งที่ขวาง — ST6-T01 blockers) เมื่อเที่ยวจบแล้ว
 */
export function TripMoneySection({
  trip,
  canSeeBuy,
  canSeeSell,
}: {
  trip: TripDetail;
  canSeeBuy: boolean;
  canSeeSell: boolean;
}) {
  const { t } = useI18n();
  const dt = useDateTimeText();
  const relevant = COST_STATES.has(trip.status);
  const q = useTripCosts(trip.id, canSeeBuy || relevant);
  const rev = useTripRevenue(
    trip.deliveryOrders.map((d) => d.id),
    canSeeSell,
  );
  const s = q.data?.summary;
  const showRev = canSeeSell && rev !== undefined;
  const showBuy = canSeeBuy && s?.buyTotal !== undefined;
  if (!showRev && !showBuy && !(relevant && s)) return null;
  const blockers = (s?.blockers ?? []).filter((b) => b !== 'TRIP_NOT_COMPLETED');
  return (
    <section
      data-testid="trip-money"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingBottom: 20,
        borderBottom: '1px solid #E4E6E0',
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3B424C' }}>
        {t('trip.money.title')}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {showRev && <Row k={t('trip.money.rev')} v={money(rev)} />}
        {showBuy && (
          <Row
            k={t(trip.carrier ? 'trip.cost.kvSub' : 'trip.cost.kvOwn')}
            v={money(s!.buyTotal!)}
          />
        )}
        {showRev && showBuy && (
          <Row
            k={t('trip.money.profit')}
            v={money(
              (
                (Math.round(Number(rev) * 100) - Math.round(Number(s!.buyTotal!) * 100)) /
                100
              ).toFixed(2),
            )}
            bold
          />
        )}
        {relevant && s && (
          <Row
            k={t('trip.cost.kvState')}
            warn={!s.costedAt && blockers.length > 0}
            v={
              s.costedAt
                ? t('trip.cost.costed', { at: dt(s.costedAt) })
                : blockers.length
                  ? t('trip.cost.blocked', {
                      list: blockers.map((b) => t(`trip.cost.b.${b}` as MessageKey)).join(' · '),
                    })
                  : t('trip.cost.open')
            }
          />
        )}
      </div>
    </section>
  );
}

/**
 * ปุ่ม footer "ปิดต้นทุนเที่ยว" (เที่ยว COMPLETED + `trips:close`) + dialog ยืนยัน — ต้นแบบไม่มีปุ่มนี้
 * [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ]: ปุ่มหลักแบบ footer drawer (`tms-drawer__pri` ไอคอน lock เหมือน
 * "ออกเอกสาร") + กรอบ dialog ชุดเดียวกับ ReasonDialog (`tms-dialog`) ไม่ต้องใส่เหตุผล (API ไม่รับ — การปิดเป็นขั้นตามปกติ ลง audit)
 * ยังมีสิ่งที่ขวาง (blockers) → ปุ่มกดไม่ได้ (เหตุแสดงในแถว "ต้นทุนเที่ยว" ของส่วนยอดเงิน)
 */
export function TripCostCloseButton({
  trip,
  onDone,
}: {
  trip: TripDetail;
  onDone: (message: string) => void;
}) {
  const { t } = useI18n();
  const q = useTripCosts(trip.id, true);
  const close = useCloseTripCost();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blocked = !q.data || q.data.summary.blockers.length > 0;
  return (
    <>
      <button
        type="button"
        className="tms-drawer__pri"
        data-testid="trip-cost-close"
        disabled={blocked || close.isPending}
        onClick={() => {
          setErr(null);
          setOpen(true);
        }}
      >
        <Icon n="lock" s={16} />
        {t('trip.foot.cost')}
      </button>
      {open && (
        <CostDialog
          no={trip.tripNo}
          busy={close.isPending}
          error={err}
          onClose={() => setOpen(false)}
          onOk={() =>
            close.mutate(
              { id: trip.id, version: trip.version },
              {
                onSuccess: () => {
                  setOpen(false);
                  onDone(t('trip.cost.done', { no: trip.tripNo }));
                },
                onError: (e) => {
                  setErr(problemText(e, t) ?? t('trip.cost.blocked', { list: '' }));
                  void q.refetch();
                },
              },
            )
          }
        />
      )}
    </>
  );
}

function CostDialog({
  no,
  busy,
  error,
  onOk,
  onClose,
}: {
  no: string;
  busy: boolean;
  error: string | null;
  onOk: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEscapeLayer(true, onClose);
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(true, box);
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        ref={box}
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('trip.cost.title', { no })}
        tabIndex={-1}
        data-modal-focus=""
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{t('trip.cost.title', { no })}</h2>
            <p className="tms-dialog__desc">{t('trip.cost.desc')}</p>
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
        {error && (
          <div className="tms-dialog__body">
            <span className="tms-field-error" role="alert">
              {error}
            </span>
          </div>
        )}
        <div className="tms-dialog__foot">
          <button type="button" className="tms-drawer__sec" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="tms-drawer__pri" disabled={busy} onClick={onOk}>
            <Icon n="lock" s={16} />
            {t('trip.cost.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
