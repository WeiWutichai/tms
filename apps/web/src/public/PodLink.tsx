import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { toBangkok } from '../features/orders/orderForm';
import { BADGE, day, Job } from './OfferLink';
import { initials } from './offerTime';
import { PodLinkCapture } from './PodLinkCapture';
import { PodLinkFail } from './PodLinkFail';
import {
  currentPosition,
  nextPodAction,
  normalizeDoNo,
  nowBangkokIso,
  podClientEventId,
  podFailed,
  podFailTarget,
  podHint,
  retryOf,
  stopState,
  usePodEvent,
  usePodView,
  type PodAction,
  type PodDo,
  type PodEventResult,
  type PodStop,
} from './podLinkApi';
import './carrier-link.css';
import './offer-link.css';

const hm = (iso: string | null) => (iso ? toBangkok(iso).time : '');

/**
 * หน้าลิงก์งานของรถร่วม (ST4-T08 — M10 ส่วนสถานะ; docs/04 E2 "ePOD ผ่านลิงก์", docs/01 §5.5) — มือถือ ไม่ต้อง login
 * ต้นแบบ `TMS Subcon.dc.html`: หัวพอร์ทัล + แท็บ "งาน" (ใบสั่งงาน + การ์ดรับงานแล้ว) / "ส่ง POD" (ค้นเลข DO → การ์ด DO)
 * ส่วนที่ต้นแบบไม่มี [DECISION spec/12 §3]: แถวจุดรับ/ส่งพร้อมสถานะ + ปุ่มสถานะถัดไป (spec/04 §5 S4) ใต้การ์ด DO ·
 * ST4-T09 รูป/ลายเซ็น/ส่ง POD (`PodLinkCapture`) + "ส่งแล้ว" ตามต้นแบบ · แท็บ "การเงิน" = ST6 ·
 * ไม่มี outbox — ส่งไม่สำเร็จ = แจ้งให้ลองใหม่ (clientEventId เดิม)
 */
export function PodLinkPage() {
  const { t } = useI18n();
  const { token = '' } = useParams();
  const [tab, setTab] = useState<'job' | 'pod'>('pod');
  const [q, setQ] = useState('');
  const [doNo, setDoNo] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const base = usePodView(token, null);
  const found = usePodView(token, doNo);
  const send = usePodEvent(token);
  const busy = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(h);
  }, [toast]);
  // ค้นเมื่อหยุดพิมพ์ (ต้นแบบค้นตามที่พิมพ์)
  useEffect(() => {
    const n = normalizeDoNo(q);
    const h = setTimeout(() => setDoNo(n.length >= 3 ? n : null), 300);
    return () => clearTimeout(h);
  }, [q]);

  const v = base.data;
  const bad = base.error instanceof ApiError && base.error.problem.status === 404;
  const res = doNo ? found.data : undefined;
  const match = res && res.query === doNo ? res.match : null;
  const notFound = !!doNo && !!res && res.query === doNo && !res.match;
  const recordable = (res ?? v)?.recordable ?? false;

  const errText = (e: unknown): string => {
    if (!(e instanceof ApiError)) return t('pdl.e.failed');
    if (e.problem.status === 429) return t('cdl.v.tooMany');
    if (e.problem.code === 'trip_not_in_progress') return t('pdl.e.notInProgress');
    return t('pdl.e.failed');
  };

  // QA L2: ข้อผิดพลาดของปุ่มหนึ่ง — โหลดใหม่แล้วปุ่มถัดไปเปลี่ยน (event ถึง server แล้ว) → ล้างข้อความแดง
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const nextKey = match && recordable ? (nextPodAction(match)?.key ?? null) : null;
  useEffect(() => {
    if (failedKey && nextKey !== failedKey) {
      setErr(null);
      setFailedKey(null);
    }
  }, [failedKey, nextKey]);

  const run = async (a: PodAction, m: PodDo) => {
    if (busy.current) return;
    busy.current = true;
    setErr(null);
    setFailedKey(null);
    try {
      const pos = await currentPosition();
      const occurredAt = nowBangkokIso();
      // ทีละขั้นตามลำดับ (ปิดงานจุดรับก่อน DEPART ของจุดถัดไป) · clientEventId คงที่ → กดซ้ำได้ผลเดิม
      const results: PodEventResult[] = [];
      for (const s of a.steps)
        results.push(
          await send.mutateAsync({
            stopId: s.stopId,
            body: {
              type: s.type,
              clientEventId: await podClientEventId(token, s, retryOf(m, s)),
              occurredAt,
              ...(s.type === 'COMPLETE' ? { outcome: 'DELIVERED' as const } : {}),
              ...(pos ?? {}),
            },
          }),
        );
      // QA M2: ไม่นับ (ธง/ขัดลำดับ) → แจ้งรอตรวจสอบ · ส่งซ้ำ = เวลาเดิมของ event ที่บันทึกไว้
      const last = results[results.length - 1];
      setToast(
        results.some((r) => r.counted === false)
          ? t('pdl.toast.pending')
          : t(`pdl.toast.${a.key}` as MessageKey, { t: hm(last?.occurredAt ?? occurredAt) }),
      );
    } catch (e) {
      setErr(errText(e));
      setFailedKey(a.key);
    } finally {
      busy.current = false;
      void found.refetch();
    }
  };

  return (
    <div className="cdl">
      <div className="cdl__phone">
        <div className="cdl__hd">
          <div className="cdl__mark">{v ? initials(v.job.company) : ''}</div>
          <div className="cdl__hdtxt">
            <b>{v ? t('cdl.title', { c: v.job.company }) : ' '}</b>
            <span>{v ? t('cdl.sub', { n: v.job.carrierName }) : ' '}</span>
          </div>
        </div>
        {v && (
          <div className="cdl__tabs" role="tablist">
            {(['job', 'pod'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                className="cdl__tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
              >
                {t(k === 'job' ? 'ofl.tab.job' : 'ofl.tab.pod')}
              </button>
            ))}
          </div>
        )}
        <div className="cdl__body">
          {base.isLoading && <span className="cdl__muted">{t('cdl.loading')}</span>}
          {base.isError && (
            <div className="cdl__empty" role="alert">
              <i>⌕</i>
              <b>{t(bad ? 'cdl.bad' : 'cdl.loadError')}</b>
              {bad ? (
                <span className="cdl__muted">{t('cdl.badD')}</span>
              ) : (
                <button type="button" className="cdl__ghost" onClick={() => void base.refetch()}>
                  {t('cdl.retry')}
                </button>
              )}
            </div>
          )}
          {v && tab === 'job' && (
            <>
              <div className="ofl__top">
                <span className="cdl__eyebrow">{t('ofl.eyebrow')}</span>
                <span
                  className="cdl__chip"
                  style={{ background: BADGE.ACCEPTED!.bg, color: BADGE.ACCEPTED!.c }}
                >
                  {t('ofl.st.ACCEPTED')}
                </span>
              </div>
              <Job v={v.job} />
              <div className="ofl__done ofl__done--ok">
                <b>{t('ofl.accd')}</b>
                <span>
                  {t('ofl.accdV', {
                    p: v.job.accepted?.plate ?? '—',
                    d: v.job.accepted?.driverName ?? '—',
                  })}
                </span>
                <span className="cdl__muted">{t('ofl.accdPod')}</span>
              </div>
            </>
          )}
          {v && tab === 'pod' && (
            <>
              <span className="cdl__eyebrow">{t('pdl.eyebrow')}</span>
              <label className="cdl__label">
                <span>{t('pdl.do')}</span>
                <input
                  className="cdl__input cdl__num pdl__q"
                  data-testid="pdl-q"
                  value={q}
                  maxLength={40}
                  autoComplete="off"
                  autoCapitalize="characters"
                  placeholder={t('pdl.doPh')}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setErr(null);
                  }}
                />
              </label>
              {match && (
                <DoStatus
                  key={match.doNo}
                  token={token}
                  company={v.job.company}
                  m={match}
                  recordable={recordable}
                  ended={(res ?? v).tripStatus !== 'ASSIGNED' && !recordable}
                  pending={send.isPending}
                  err={err}
                  onAct={(a) => void run(a, match)}
                  say={setToast}
                  onFail={(r) => {
                    setToast(
                      r.counted === false
                        ? t('pdl.toast.pending')
                        : t('pdl.f.toast', { t: hm(r.occurredAt) }),
                    );
                    void base.refetch();
                    void found.refetch();
                  }}
                  onPodDone={(no) => {
                    // ต้นแบบ: ส่งแล้ว → toast + ล้างช่องค้น + ขึ้นในรายการ "ส่งแล้ว"
                    setToast(t('pdl.pod.toast', { no }));
                    setQ('');
                    setDoNo(null);
                    void base.refetch();
                    void found.refetch();
                  }}
                />
              )}
              {notFound && (
                <div className="cdl__empty" data-testid="pdl-nf">
                  <i>⌕</i>
                  <b>{t('pdl.nf')}</b>
                  <span className="cdl__muted">
                    {v.doHint ? t('pdl.nfHint', { no: v.doHint }) : t('pdl.nfD')}
                  </span>
                </div>
              )}
              {v.sent.length > 0 && (
                <div className="cdl__sent" data-testid="pdl-sent">
                  <span className="cdl__senthd">{t('pdl.pod.sentHd')}</span>
                  {v.sent.map((x) => (
                    <div key={x.doNo} className="cdl__row">
                      <div className="cdl__rowtop">
                        <span>{x.doNo}</span>
                        <span className="cdl__state" style={{ color: '#17733F' }}>
                          <span className="cdl__dot" style={{ background: '#17733F' }} />
                          {t('pdl.pod.sentRow', { n: x.photoCount })}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
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

/** การ์ด DO (ต้นแบบ) + แถวจุดรับ/ส่ง + ปุ่มสถานะถัดไป + ส่ง POD (ST4-T09) */
function DoStatus({
  token,
  company,
  m,
  recordable,
  ended,
  pending,
  err,
  onAct,
  say,
  onFail,
  onPodDone,
}: {
  token: string;
  company: string;
  m: PodDo;
  recordable: boolean;
  ended: boolean;
  pending: boolean;
  err: string | null;
  onAct: (a: PodAction) => void;
  say: (msg: string) => void;
  onFail: (r: PodEventResult) => void;
  onPodDone: (doNo: string) => void;
}) {
  const { t } = useI18n();
  const route = `${m.pickup?.siteName ?? '—'} → ${m.delivery?.siteName ?? '—'}`;
  const action = recordable ? nextPodAction(m) : null;
  // ST4-T09: ถึงจุดส่งแล้ว (ปิดงาน + POD) หรือจุดส่งปิดแล้วยังไม่มี POD → ฟอร์มส่ง POD แทนข้อความ "แจ้งฝ่ายจัดรถ"
  const showPod = m.pod.mode === 'SUBMIT' || (m.pod.mode === 'CLOSE' && recordable);
  // Q-LINK: แจ้งไม่สำเร็จแล้ว → กล่องแจ้งผลแทน "ส่ง POD แล้ว" (รูปแจ้งไม่สำเร็จเป็นหลักฐานชุดไม่สำเร็จ)
  const failed = podFailed(m);
  const hint = showPod || m.pod.sent || failed ? null : podHint(m);
  const fail = recordable && !m.pod.sent ? podFailTarget(m) : null;
  return (
    <>
      <div className="cdl__card pdl__do" data-testid="pdl-do">
        <span className="ofl__no">{m.doNo}</span>
        <span style={{ fontWeight: 600 }}>{route}</span>
        <span className="cdl__muted">
          {[m.customerName, day(m.doDate)].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="cdl__sent">
        {[m.pickup, m.delivery]
          .filter((s): s is PodStop => !!s)
          .map((s) => (
            <StopRow key={`${s.role}-${s.id}`} s={s} />
          ))}
      </div>
      {!recordable && !showPod && !m.pod.sent && (
        <div className="cdl__notice" data-testid="pdl-locked">
          <span className="cdl__dot" style={{ background: '#8F5500' }} />
          <span>{t(ended ? 'pdl.ended' : 'pdl.notReady')}</span>
        </div>
      )}
      {showPod && <PodLinkCapture token={token} m={m} say={say} onDone={onPodDone} />}
      {failed && (
        <div className="cdl__empty" data-testid="pdl-fail-done">
          <i>⌕</i>
          <b>{t('pdl.f.done')}</b>
          <span className="cdl__muted">{t('pdl.f.doneD', { c: company })}</span>
        </div>
      )}
      {m.pod.sent && !failed && (
        <div className="cdl__empty" data-testid="pdl-pod-sent">
          <i>⌕</i>
          <b>{t('pdl.pod.sent')}</b>
          <span className="cdl__muted">{t('pdl.pod.sentD', { c: company })}</span>
        </div>
      )}
      {err && (
        <span className="cdl__err" role="alert">
          {err}
        </span>
      )}
      {action ? (
        <button
          type="button"
          className="cdl__primary"
          data-testid="pdl-act"
          disabled={pending}
          onClick={() => onAct(action)}
        >
          {t(`pdl.act.${action.key}` as MessageKey)}
        </button>
      ) : (
        recordable &&
        hint && (
          <span className="cdl__muted" data-testid="pdl-hint">
            {t(`pdl.hint.${hint}` as MessageKey)}
          </span>
        )
      )}
      {fail && (
        <PodLinkFail
          key={`${fail.stop.id}-${fail.stop.status}`}
          token={token}
          m={m}
          target={fail}
          pending={pending}
          onDone={onFail}
        />
      )}
    </>
  );
}

function StopRow({ s }: { s: PodStop }) {
  const { t } = useI18n();
  const st = stopState(s);
  return (
    <div className="cdl__row" data-testid={`pdl-stop-${s.role}`}>
      <div className="cdl__rowtop">
        <span style={{ fontVariantNumeric: 'normal', fontSize: 15, fontWeight: 600 }}>
          {s.siteName}
        </span>
        <span className="cdl__state" style={{ color: st.c }} data-testid="pdl-state">
          <span className="cdl__dot" style={{ background: st.c }} />
          {t(`pdl.st.${st.key}` as MessageKey, { t: hm(st.at) })}
        </span>
      </div>
      <span className="cdl__muted" style={{ fontSize: 13 }}>
        {t(`pdl.role.${s.role}` as MessageKey)}
      </span>
    </div>
  );
}
