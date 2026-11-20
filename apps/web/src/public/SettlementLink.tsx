import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { formatDate, formatMoney, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { day } from './OfferLink';
import { initials } from './offerTime';
import {
  lineState,
  REVIEW_IMAGE_MIME,
  REVIEW_PHOTOS_MAX,
  uploadReviewPhoto,
  useRespond,
  useReviewView,
  type ReviewLine,
} from './settlementLinkApi';
import './carrier-link.css';
import './offer-link.css';
import './settlement-link.css';

/* สีป้ายสถานะ — ต้นแบบ TMS Subcon แท็บ "การเงิน" (รอตรวจ / อนุมัติแล้ว · รอจ่าย) + ป้ายรับงาน/ปฏิเสธของแท็บ "งาน" */
// ST6-T06: หัวใบ DISPUTED ใช้สีป้ายปฏิเสธ (เดียวกับรายการโต้แย้ง) · บรรทัดที่บริษัทยืนยันยอดเดิม ใช้สีป้ายอนุมัติแล้ว
const CHIP: Record<string, { bg: string; c: string }> = {
  SENT_TO_CARRIER: { bg: '#FCF0DC', c: '#8F5500' },
  APPROVED: { bg: '#E9F0FA', c: '#2257C4' },
  // ST6-T09 จ่ายแล้ว — ต้นแบบ TMS Subcon การ์ดงวด "จ่ายแล้ว" (#E6F4EC / #17733F)
  PAID: { bg: '#E6F4EC', c: '#17733F' },
  PENDING: { bg: '#FCF0DC', c: '#8F5500' },
  ACCEPTED: { bg: '#E6F4EC', c: '#17733F' },
  DISPUTED: { bg: '#FBE9E7', c: '#B3322A' },
  RESOLVED: { bg: '#E9F0FA', c: '#2257C4' },
};

const dayTh = (iso: string) => formatDate(new Date(iso), 'th', 'BE');

/**
 * หน้ารถร่วมตรวจใบสำคัญจ่าย (ST6-T05; docs/04 F6 "รถร่วมตรวจผ่านลิงก์", spec/05 §11.3 หน้ารถร่วม) — มือถือ ไม่ต้อง login
 * ต้นแบบ `TMS Subcon.dc.html` แท็บ "การเงิน" มีแค่การ์ดงวด (เลข · สถานะ · งวด · n เที่ยว · ยอด) — **ไม่มีหน้ารายการให้ตรวจ**
 * [DECISION spec/12 §3]: ประกอบจากชิ้นของต้นแบบเดียวกัน — การ์ดสรุปแบบใบสั่งงาน (แถว + "ยอดสุทธิ" แบบ "ราคาจ้าง") ·
 * แถบเตือนอายุลิงก์ · การ์ดรายการแบบการ์ดงวด + ปุ่ม ยอมรับ/โต้แย้ง · ฟอร์มโต้แย้งแบบ "เหตุผลที่ปฏิเสธ" + รูปแบบแท็บ "ส่ง POD" · toast
 */
export function SettlementLinkPage() {
  const { t } = useI18n();
  const { token = '' } = useParams();
  const q = useReviewView(token);
  const respond = useRespond(token);
  const [open, setOpen] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<{ line: string; text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(h);
  }, [toast]);

  const v = q.data;
  const bad = q.error instanceof ApiError && q.error.problem.status === 404;
  const trips = v?.lines.filter((l) => l.lineType !== 'DEDUCTION') ?? [];
  const deducts = v?.lines.filter((l) => l.lineType === 'DEDUCTION') ?? [];

  const fail = (lineId: string, e: unknown) => {
    let text = t('stl.e.failed');
    if (e instanceof ApiError) {
      if (e.problem.status === 429) text = t('cdl.v.tooMany');
      else if (e.problem.status === 404) text = t('cdl.badD');
      else if (e.problem.code === 'invalid_state_transition') text = t('stl.e.closed');
      else if (e.problem.code === 'settlement_line_resolved') text = t('stl.e.resolved');
    }
    setErr({ line: lineId, text });
    if (e instanceof ApiError && (e.problem.status === 404 || e.problem.status === 409)) {
      setOpen(null);
      void q.refetch();
    }
  };
  const reset = (id: string | null) => {
    setOpen(id);
    setWhy('');
    setPhotos([]);
    setErr(null);
  };
  const submit = (l: ReviewLine, response: 'ACCEPTED' | 'DISPUTED') => {
    if (response === 'DISPUTED' && !why.trim() && !photos.length) {
      setErr({ line: l.id, text: t('stl.d.req') });
      return;
    }
    if (sending.current || uploading) return;
    sending.current = true;
    setErr(null);
    respond.mutate(
      {
        lineId: l.id,
        body:
          response === 'ACCEPTED'
            ? { response }
            : { response, reason: why.trim() || null, photoDocumentIds: photos },
      },
      {
        onSuccess: () => {
          reset(null);
          setToast(
            t(`stl.toast.${response}` as MessageKey, {
              n: l.tripNo ?? String(l.lineNo),
              c: v?.company ?? '',
            }),
          );
        },
        onError: (e) => fail(l.id, e),
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  };
  const pick = async (l: ReviewLine, list: FileList | null) => {
    const files = [...(list ?? [])];
    if (fileRef.current) fileRef.current.value = '';
    if (!files.length) return;
    setErr(null);
    setUploading(true);
    try {
      for (const f of files.slice(0, Math.max(REVIEW_PHOTOS_MAX - photos.length, 0))) {
        const id = await uploadReviewPhoto(token, l.id, f);
        setPhotos((x) => [...x, id]);
      }
    } catch (e) {
      setErr({
        line: l.id,
        text:
          e instanceof ApiError && e.problem.status === 429
            ? t('cdl.v.tooMany')
            : t('pdl.pod.badFile'),
      });
    } finally {
      setUploading(false);
    }
  };

  const lineCard = (l: ReviewLine) => {
    const st = lineState(l);
    const chip = CHIP[st]!;
    const route =
      l.lineType === 'DEDUCTION'
        ? l.deductionType
          ? t(`stl.ln.deduct.${l.deductionType}` as MessageKey)
          : l.description
        : [l.origin, l.destination].filter(Boolean).join(' → ') || l.description;
    const sub =
      l.lineType === 'DEDUCTION'
        ? [l.description, l.reference ? t('stl.ln.ref', { r: l.reference }) : null]
        : [
            l.tripDate ? day(l.tripDate) : null,
            l.lineType === 'SURCHARGE' ? `${t('stl.ln.surcharge')} · ${l.description}` : null,
          ];
    const isOpen = open === l.id;
    return (
      <div key={l.id} className="cdl__card stl__line" data-testid={`stl-line-${l.lineNo}`}>
        <div className="stl__top">
          <span className="stl__no">{l.tripNo ?? `#${l.lineNo}`}</span>
          <span className="cdl__chip" style={{ background: chip.bg, color: chip.c }}>
            {t(`stl.ln.st.${st}` as MessageKey)}
          </span>
        </div>
        <div className="stl__mid">
          <div className="stl__what">
            <b>{route}</b>
            <span className="cdl__muted">{sub.filter(Boolean).join(' · ')}</span>
          </div>
          <span className="stl__amt">{formatMoney(l.amount)}</span>
        </div>
        {l.review?.response === 'DISPUTED' && (l.review.reason || l.review.photoCount > 0) && (
          <span className="cdl__why">
            {[
              l.review.reason,
              l.review.photoCount ? t('stl.ln.photos', { n: l.review.photoCount }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {l.resolution && (
          <span className="cdl__why" data-testid={`stl-resolved-${l.lineNo}`}>
            {t('stl.ln.resolvedWhy', { r: l.resolution.reason })}
          </span>
        )}
        {v?.canRespond && l.canRespond && !isOpen && (
          <div className="stl__acts">
            <button
              type="button"
              className="stl__acc"
              data-testid={`stl-accept-${l.lineNo}`}
              disabled={respond.isPending}
              onClick={() => {
                reset(null);
                submit(l, 'ACCEPTED');
              }}
            >
              {t('stl.accept')}
            </button>
            <button
              type="button"
              className="stl__dis"
              data-testid={`stl-dispute-${l.lineNo}`}
              onClick={() => reset(l.id)}
            >
              {t('stl.dispute')}
            </button>
          </div>
        )}
        {isOpen && (
          <div className="stl__form">
            <label className="cdl__label">
              <span>{t('stl.d.title')}</span>
              <textarea
                className="cdl__input pdl__area"
                data-testid="stl-why"
                value={why}
                maxLength={500}
                placeholder={t('stl.d.ph')}
                onChange={(e) => {
                  setWhy(e.target.value);
                  setErr(null);
                }}
              />
            </label>
            <input
              ref={fileRef}
              type="file"
              hidden
              multiple
              accept={REVIEW_IMAGE_MIME.join(',')}
              data-testid="stl-photo-input"
              onChange={(e) => void pick(l, e.target.files)}
            />
            <div className="cdl__photos">
              {photos.map((id, i) => (
                <div key={id} className="cdl__photo pdl__photo">
                  {t('pdl.pod.photoN', { n: i + 1 })}
                  <button
                    type="button"
                    className="pdl__x"
                    aria-label={t('pdl.pod.remove', { n: i + 1 })}
                    title={t('pdl.pod.remove', { n: i + 1 })}
                    onClick={() => setPhotos((x) => x.filter((y) => y !== id))}
                  >
                    ×
                  </button>
                </div>
              ))}
              {photos.length < REVIEW_PHOTOS_MAX && (
                <button
                  type="button"
                  className="cdl__add"
                  data-testid="stl-add-photo"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? t('pdl.pod.uploading') : t('pdl.pod.add')}
                </button>
              )}
            </div>
            <span className="cdl__muted">{t('stl.d.hint')}</span>
            {err?.line === l.id && (
              <span className="cdl__err" role="alert">
                {err.text}
              </span>
            )}
            <button
              type="button"
              className="ofl__decline"
              data-testid="stl-dispute-ok"
              disabled={respond.isPending || uploading}
              onClick={() => submit(l, 'DISPUTED')}
            >
              {t('stl.d.ok')}
            </button>
            <button type="button" className="cdl__ghost" onClick={() => reset(null)}>
              {t('stl.d.back')}
            </button>
          </div>
        )}
        {!isOpen && err?.line === l.id && (
          <span className="cdl__err" role="alert">
            {err.text}
          </span>
        )}
      </div>
    );
  };

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
              <div className="ofl__top">
                <span className="cdl__eyebrow">{t('stl.eyebrow')}</span>
                <span
                  className="cdl__chip"
                  data-testid="stl-status"
                  style={{ background: CHIP[v.status]?.bg, color: CHIP[v.status]?.c }}
                >
                  {t(`stl.st.${v.status}` as MessageKey)}
                </span>
              </div>
              <div className="ofl__job">
                <div className="ofl__head">
                  <span className="ofl__no">{v.settlementNo ?? t('stl.draftNo')}</span>
                  <span className="ofl__route">
                    {t('stl.period', { a: day(v.periodFrom), b: day(v.periodTo) })}
                  </span>
                  <span className="cdl__muted">{t('stl.trips', { n: v.tripCount })}</span>
                </div>
                <div className="ofl__row">
                  <span className="cdl__muted">{t('stl.gross')}</span>
                  <span className="cdl__num">{formatMoney(v.grossAmount)}</span>
                </div>
                <div className="ofl__row">
                  <span className="cdl__muted">{t('stl.deduction')}</span>
                  <span className="cdl__num">{formatMoney(v.deductionAmount)}</span>
                </div>
                {v.carrierInvoiceNo && (
                  <div className="ofl__row">
                    <span className="cdl__muted">{t('stl.invoice')}</span>
                    <span className="cdl__num">{v.carrierInvoiceNo}</span>
                  </div>
                )}
                <div className="ofl__price">
                  <span className="stl__netl">
                    <b>{t('stl.net')}</b>
                    <span className="cdl__muted">{t('stl.netNote')}</span>
                  </span>
                  <span className="ofl__amt" data-testid="stl-net">
                    {formatMoney(v.netAmount)}
                  </span>
                </div>
              </div>
              {v.canRespond ? (
                <div className="cdl__notice">
                  <span className="cdl__dot" style={{ background: '#8F5500' }} />
                  <span>{t('stl.notice', { d: dayTh(v.expiresAt) })}</span>
                </div>
              ) : (
                <div className="ofl__done">
                  <b>{t(v.status === 'PAID' ? 'stl.doneNote.PAID' : 'stl.doneNote')}</b>
                </div>
              )}
              <span className="cdl__senthd">{t('stl.secTrips')}</span>
              {trips.map(lineCard)}
              {deducts.length > 0 && (
                <>
                  <span className="cdl__senthd">{t('stl.secDeduct')}</span>
                  {deducts.map(lineCard)}
                </>
              )}
            </>
          )}
        </div>
        {toast && (
          <div className="cdl__toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
