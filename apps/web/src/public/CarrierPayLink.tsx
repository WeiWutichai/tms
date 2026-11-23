import { useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { formatMoney, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { day } from './OfferLink';
import { initials } from './offerTime';
import { payVoucherUrl, usePayView, type PaySettlement, type PayTrip } from './carrierPayLinkApi';
import './carrier-link.css';
import './offer-link.css';
import './settlement-link.css';
import './carrier-pay-link.css';

/* สีป้ายงวด — ต้นแบบ TMS Subcon การ์ดงวด: รอตรวจ #FCF0DC/#8F5500 · อนุมัติแล้ว · รอจ่าย #E9F0FA/#2257C4 · จ่ายแล้ว #E6F4EC/#17733F */
const CHIP: Record<string, { bg: string; c: string }> = {
  SENT_TO_CARRIER: { bg: '#FCF0DC', c: '#8F5500' },
  APPROVED: { bg: '#E9F0FA', c: '#2257C4' },
  PAID: { bg: '#E6F4EC', c: '#17733F' },
};

/** ช่วงงวดแบบต้นแบบ "1–15 ต.ค. 2569" — เดือน/ปีเดียวกันย่อ · ต่างปีแสดงเต็มทั้งสองฝั่ง */
export function periodText(from: string, to: string): string {
  const [d1, m1, y1] = day(from).split(' ');
  const [d2, m2, y2] = day(to).split(' ');
  if (from === to) return day(to);
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${m2} ${y2}`;
  if (y1 === y2) return `${d1} ${m1} – ${d2} ${m2} ${y2}`;
  return `${day(from)} – ${day(to)}`;
}

/**
 * หน้า "ค่าเที่ยวของฉัน" ของรถร่วม (ST6-T11; docs/04 F7 "คนขับ/รถร่วมดูค่าเที่ยวของตัวเอง" — ลิงก์ P0, ย่อตาม D-54) — มือถือ ไม่ต้อง login
 * ต้นแบบ `TMS Subcon.dc.html` แท็บ "การเงิน": หัวพอร์ทัล · การ์ด "รอรับเงิน" (ยอด + n งวด · จ่ายภายใน N วันหลังอนุมัติ) ·
 * การ์ดงวด (เลข · ป้าย · งวด · n เที่ยว · ยอด · จ่ายแล้ว = ปุ่ม "ใบจ่ายเงิน")
 * ต่างจากต้นแบบ [spec/12 §3 แถว ST6-T11]: ไม่มีปุ่ม "หนังสือ 50 ทวิ" (D-54/D-58 ออกที่ระบบบัญชี — [OPEN — PO]) · แท็บ งาน/ส่ง POD ไม่มี
 * (ลิงก์ข้อเสนองาน/POD แยกต่อเที่ยว) · ใบยังไม่อนุมัติไม่มีเลข → "รอออกเลขเมื่ออนุมัติ" · หมายเหตุยอดหลังหัก ณ ที่จ่าย/ประมาณการ (D-54) ·
 * ส่วน "เที่ยวที่จบ · ยังไม่เข้างวด" ใช้แถวแบบ "ส่งแล้ว" ของแท็บ ส่ง POD [DECISION — ย้อนได้; OPEN Claude Design] · สถานะว่าง/โหลด/ผิดพลาดแบบหน้าลิงก์อื่น
 */
export function CarrierPayLinkPage() {
  const { t } = useI18n();
  const { token = '' } = useParams();
  const q = usePayView(token);
  const v = q.data;
  const bad = q.error instanceof ApiError && q.error.problem.status === 404;

  const card = (s: PaySettlement) => {
    const chip = CHIP[s.status] ?? CHIP.SENT_TO_CARRIER!;
    return (
      <div key={s.id} className="cdl__card" data-testid={`cpl-stl-${s.id}`}>
        <div className="stl__top">
          <span className="stl__no">{s.settlementNo ?? t('stl.draftNo')}</span>
          <span className="cdl__chip" style={{ background: chip.bg, color: chip.c }}>
            {t(`stl.st.${s.status}` as MessageKey)}
          </span>
        </div>
        <div className="cpl__per">
          <span>
            {periodText(s.periodFrom, s.periodTo)} · {t('stl.trips', { n: s.tripCount })}
          </span>
          <span className="stl__amt" data-testid="cpl-amt">
            {/* ยังคำนวณยอดหลังหัก ณ ที่จ่ายไม่ได้ (ไม่รู้ประเภทรถร่วม) → "—" ไม่ใช้ยอดก่อนหัก */}
            {s.amount === null ? '—' : formatMoney(s.amount)}
          </span>
        </div>
        {s.status === 'PAID' && (
          // ต้นแบบ: ปุ่ม "ใบจ่ายเงิน" + "หนังสือ 50 ทวิ" — 50 ทวิ ออกที่ระบบบัญชี (D-54/D-58) ไม่ทำ
          <div className="stl__acts">
            <a
              className="stl__acc stl__pv"
              href={payVoucherUrl(token, s.id)}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="cpl-pdf"
            >
              {t('stl.pdf')}
            </a>
          </div>
        )}
      </div>
    );
  };
  const tripRow = (x: PayTrip, i: number) => (
    <div key={`${x.tripNo ?? ''}-${i}`} className="cdl__row" data-testid="cpl-trip">
      <div className="cdl__rowtop">
        <span>{x.tripNo ?? '—'}</span>
        <span className="stl__amt">{formatMoney(x.amount)}</span>
      </div>
      <span className="cdl__muted">
        {[day(x.tripDate), [x.origin, x.destination].filter(Boolean).join(' → ')]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </div>
  );

  return (
    <div className="cdl">
      <div className="cdl__phone">
        <div className="cdl__hd">
          <div className="cdl__mark">{v ? initials(v.company) : ''}</div>
          <div className="cdl__hdtxt">
            <b>{v ? t('cdl.title', { c: v.company }) : ' '}</b>
            <span>{v ? t('cdl.sub', { n: v.carrierName }) : ' '}</span>
          </div>
        </div>
        {v && (
          <div className="cdl__tabs" role="tablist">
            <button type="button" role="tab" className="cdl__tab" aria-selected>
              {t('stl.tab')}
            </button>
          </div>
        )}
        <div className="cdl__body">
          {q.isLoading && <span className="cdl__muted">{t('cdl.loading')}</span>}
          {q.isError && (
            <div className="cdl__empty" role="alert">
              <i>⌕</i>
              <b>{t(bad ? 'cdl.bad' : 'cdl.loadError')}</b>
              {bad ? (
                <span className="cdl__muted">{t('cdl.badD')}</span>
              ) : (
                <button type="button" className="cdl__ghost" onClick={() => void q.refetch()}>
                  {t('cdl.retry')}
                </button>
              )}
            </div>
          )}
          {v && (
            <>
              <div className="cpl__due" data-testid="cpl-due">
                <span>{t('cpl.due')}</span>
                <span className="cpl__dueamt">{formatMoney(v.dueAmount)}</span>
                <span className="cdl__muted">
                  {t('cpl.dueSub', { n: v.dueCount, d: v.paymentTermDays })}
                </span>
              </div>
              {v.settlements.length > 0 && (
                // หมายเหตุยอดหลังหัก ณ ที่จ่ายอยู่กับกลุ่มการ์ดงวด (review M1) — ยอดเที่ยวด้านล่างเป็นก่อนหัก
                <div className="cpl__stls" data-testid="cpl-stls">
                  {v.settlements.map(card)}
                  <span className="cpl__note">{t('cpl.note')}</span>
                </div>
              )}
              {v.trips.length > 0 && (
                <div className="cdl__sent" data-testid="cpl-trips">
                  <span className="cdl__senthd">{t('cpl.secTrips')}</span>
                  <span className="cpl__note">{t('cpl.tripsNote')}</span>
                  {v.trips.map(tripRow)}
                </div>
              )}
              {!v.settlements.length && !v.trips.length && (
                <div className="cdl__empty">
                  <i>⌕</i>
                  <b>{t('cpl.empty')}</b>
                  <span className="cdl__muted">{t('cpl.emptyD')}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
