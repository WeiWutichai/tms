import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { formatDate, useI18n, type T } from '../i18n';
import type { MessageKey } from '../i18n/th';
import {
  uploadLinkFile,
  useLinkView,
  useSubmitDoc,
  type LinkItem,
  type LinkView,
} from '../features/carriers/useCarrierDocs';
import { DOC_FILE_MIME } from '../features/vehicles/useVehicleDocs';
import './carrier-link.css';

/* สี soft() ของต้นแบบ */
const TONE = {
  ok: { c: '#17733F', bg: '#E6F4EC' },
  warn: { c: '#8F5500', bg: '#FCF0DC' },
  err: { c: '#B3322A', bg: '#FBE9E7' },
  off: { c: '#3B424C', bg: '#ECEDEA' },
} as const;

const day = (iso: string) => formatDate(new Date(`${iso}T00:00:00`), 'th', 'BE');
const docLabel = (t: T, docType: string, title?: string | null) =>
  title ||
  (docType === 'DRIVER_LICENCE'
    ? t('cdl.type.DRIVER_LICENCE')
    : t(`vdoc.type.${docType}` as MessageKey));
/** ตัวย่อบนกล่องโลโก้ (ต้นแบบ "ศท") — 2 พยัญชนะแรก ข้ามสระ/วรรณยุกต์ */
/** สระบน/ล่าง วรรณยุกต์ ช่องว่าง จุด (ไม่ใช่ตัวหลัก) */
const MARK = new RegExp('[\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E\\s.]');
const initials = (name: string) =>
  [...name]
    .filter((ch) => !MARK.test(ch))
    .slice(0, 2)
    .join('');

type Target =
  | { kind: 'veh'; vehicleId: string; subject: string; item: LinkItem }
  | { kind: 'drv'; driverId: string; subject: string; item: LinkItem };

function StateChip({ item, t }: { item: LinkItem; t: T }) {
  if (item.state === 'pending_review')
    return (
      <span className="cdl__state" style={{ color: TONE.ok.c }}>
        <span className="cdl__dot" style={{ background: TONE.ok.c }} />
        {t('cdl.st.pending')}
      </span>
    );
  const d = item.currentExpiresOn ? day(item.currentExpiresOn) : '';
  const [tone, key]: [keyof typeof TONE, MessageKey] =
    item.state === 'expired'
      ? ['err', 'cdl.st.expired']
      : item.state === 'expiring'
        ? ['warn', 'cdl.st.expiring']
        : item.state === 'ok'
          ? ['ok', 'cdl.st.ok']
          : ['off', 'cdl.st.missing'];
  return (
    <span className="cdl__chip" style={{ background: TONE[tone].bg, color: TONE[tone].c }}>
      {t(key, { d })}
    </span>
  );
}

/**
 * ฟอร์มส่งเอกสาร 1 ฉบับ — รูปแบบการ์ดฟอร์ม "ข้อมูลรถที่จะมารับงาน" + ตาราง "+ เพิ่มรูป" ของหน้าส่ง POD (ต้นแบบ TMS Subcon)
 */
function UploadForm({
  token,
  target,
  onDone,
  onCancel,
}: {
  token: string;
  target: Target;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const veh = target.kind === 'veh';
  const [docNo, setDocNo] = useState('');
  const [issuer, setIssuer] = useState('');
  const [startsOn, setStartsOn] = useState(target.item.currentExpiresOn ?? '');
  const [expiresOn, setExpiresOn] = useState('');
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const submit = useSubmitDoc(token);
  const sending = useRef(false);
  const label = docLabel(t, target.item.docType, target.item.title);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setBusy(true);
    try {
      const id = await uploadLinkFile(token, f);
      setFiles((x) => [...x, { id, name: f.name }]);
    } catch (e) {
      setErr(
        e instanceof ApiError && e.problem.status === 429 ? t('cdl.v.tooMany') : t('cdl.v.badFile'),
      );
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  };

  const missing =
    !docNo.trim() || !expiresOn
      ? t('cdl.v.required')
      : veh && !startsOn
        ? t('cdl.v.startsRequired')
        : !files.length
          ? t('cdl.v.file')
          : null;
  const serverMsg = (e: unknown): string => {
    if (!(e instanceof ApiError)) return t('cdl.v.failed');
    if (e.problem.status === 429) return t('cdl.v.tooMany');
    const code = (e.problem as { errors?: { code: string }[] }).errors?.[0]?.code;
    const map: Record<string, MessageKey> = {
      not_after_previous: 'cdl.v.notAfter',
      already_expired: 'cdl.v.expired',
      expires_before_start: 'cdl.v.beforeStart',
      pending_exists: 'cdl.v.pending',
      invalid_date: 'cdl.v.required',
    };
    return code && map[code] ? t(map[code]) : t('cdl.v.failed');
  };
  const send = () => {
    setTried(true);
    if (missing || busy || sending.current) return;
    sending.current = true;
    submit.mutate(
      {
        ...(veh ? { vehicleId: target.vehicleId } : { driverId: target.driverId }),
        docType: target.item.docType,
        ...(target.item.targetDocumentId ? { targetDocumentId: target.item.targetDocumentId } : {}),
        docNo: docNo.trim(),
        ...(veh ? { issuer: issuer.trim() || null, startsOn } : {}),
        expiresOn,
        fileDocumentIds: files.map((f) => f.id),
      },
      {
        onSuccess: () => onDone(),
        onError: (e) => setErr(serverMsg(e)),
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  };

  return (
    <div className="cdl__card" data-testid="cdl-form">
      <span style={{ fontWeight: 600 }}>{`${target.subject} · ${label}`}</span>
      <label className="cdl__label">
        <span>{t(veh ? 'cdl.f.docNo' : 'cdl.f.licNo')}</span>
        <input
          className="cdl__input cdl__num"
          value={docNo}
          maxLength={60}
          aria-invalid={tried && !docNo.trim()}
          placeholder={t(veh ? 'cdl.f.docNoPh' : 'cdl.f.licNoPh')}
          onChange={(e) => setDocNo(e.target.value)}
        />
      </label>
      {veh && (
        <label className="cdl__label">
          <span>{t('cdl.f.issuer')}</span>
          <input
            className="cdl__input"
            value={issuer}
            maxLength={120}
            placeholder={t('cdl.f.issuerPh')}
            onChange={(e) => setIssuer(e.target.value)}
          />
        </label>
      )}
      {veh && (
        <label className="cdl__label">
          <span>{t('cdl.f.starts')}</span>
          <input
            type="date"
            className="cdl__input cdl__num"
            value={startsOn}
            aria-invalid={tried && !startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
        </label>
      )}
      <label className="cdl__label">
        <span>{t('cdl.f.expires')}</span>
        <input
          type="date"
          className="cdl__input cdl__num"
          value={expiresOn}
          aria-invalid={tried && !expiresOn}
          onChange={(e) => setExpiresOn(e.target.value)}
        />
      </label>
      <input
        ref={ref}
        type="file"
        hidden
        accept={DOC_FILE_MIME.join(',')}
        data-testid="cdl-file"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <div className="cdl__photos">
        {files.map((f, i) => (
          <div key={f.id} className="cdl__photo" title={f.name}>
            {t('cdl.f.file', { n: i + 1 })}
          </div>
        ))}
        {files.length < 5 && (
          <button
            type="button"
            className="cdl__add"
            disabled={busy}
            onClick={() => ref.current?.click()}
          >
            {busy ? t('cdl.f.uploading') : t('cdl.f.add')}
          </button>
        )}
      </div>
      <span className="cdl__muted">{t('cdl.f.hint')}</span>
      {((tried && missing) || err) && <span className="cdl__err">{err ?? missing}</span>}
      <button
        type="button"
        className="cdl__primary"
        disabled={submit.isPending}
        style={{ opacity: missing ? 0.5 : undefined }}
        onClick={send}
      >
        {t('cdl.submit')}
      </button>
      <button type="button" className="cdl__ghost" onClick={onCancel}>
        {t('cdl.back')}
      </button>
    </div>
  );
}

function Sent({ v, t }: { v: LinkView; t: T }) {
  if (!v.submissions.length) return null;
  return (
    <div className="cdl__sent" data-testid="cdl-sent">
      <span className="cdl__senthd">{t('cdl.sent')}</span>
      {v.submissions.map((s) => {
        const tone =
          s.status === 'pending_review' || s.status === 'approved' ? TONE.ok.c : TONE.err.c;
        return (
          <div key={s.id} className="cdl__row" data-status={s.status}>
            <div className="cdl__rowtop">
              <span>{`${s.subject} · ${docLabel(t, s.docType, s.title)}`}</span>
              <span className="cdl__state" style={{ color: tone }}>
                <span className="cdl__dot" style={{ background: tone }} />
                {s.status === 'pending_review'
                  ? t('cdl.sent.pending', { n: s.fileCount })
                  : t(s.status === 'approved' ? 'cdl.sent.approved' : 'cdl.sent.rejected')}
              </span>
            </div>
            {s.status === 'rejected' && s.rejectReason && (
              <span className="cdl__why">{t('cdl.sent.why', { r: s.rejectReason })}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * หน้าลิงก์ของรถร่วม (ST2-T21) — เปิดบนมือถือไม่ต้อง login · ต้นแบบ TMS Subcon (กรอบ 390px, หัวพอร์ทัล, แท็บ pill,
 * การ์ด, ช่องกรอก 48px, ปุ่มหลัก 56px, ตาราง "+ เพิ่มรูป", รายการ "ส่งแล้ว · รอตรวจ", toast)
 * ต้นแบบไม่มีหน้าส่งเอกสาร → ประกอบจากชิ้นของหน้า "ส่ง POD" + "รับงาน" [OPEN spec/12 §3]
 */
export function CarrierDocsLinkPage() {
  const { t } = useI18n();
  const { token = '' } = useParams();
  const q = useLinkView(token);
  const [tab, setTab] = useState<'veh' | 'drv'>('veh');
  const [target, setTarget] = useState<Target | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(h);
  }, [toast]);

  const v = q.data;
  const bad = q.error instanceof ApiError && q.error.problem.status === 404;
  return (
    <div className="cdl">
      <div className="cdl__phone">
        <div className="cdl__hd">
          <div className="cdl__mark">{v ? initials(v.company) : ''}</div>
          <div className="cdl__hdtxt">
            <b>{v ? t('cdl.title', { c: v.company }) : ' '}</b>
            <span>{v ? t('cdl.sub', { n: v.carrierName }) : ' '}</span>
          </div>
        </div>
        {v && (
          <div className="cdl__tabs" role="tablist">
            {(['veh', 'drv'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                className="cdl__tab"
                aria-selected={tab === k}
                onClick={() => {
                  setTab(k);
                  setTarget(null);
                }}
              >
                {t(k === 'veh' ? 'cdl.tab.veh' : 'cdl.tab.drv')}
              </button>
            ))}
          </div>
        )}
        <div className="cdl__body">
          {q.isLoading && <span className="cdl__muted">{t('cdl.loading')}</span>}
          {(bad || (q.isError && !bad)) && (
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
              <span className="cdl__eyebrow">
                {t(tab === 'veh' ? 'cdl.head.veh' : 'cdl.head.drv')}
              </span>
              <div className="cdl__notice">
                <span className="cdl__dot" style={{ background: '#8F5500' }} />
                <span>
                  {t('cdl.notice', {
                    d: formatDate(new Date(v.expiresAt), 'th', 'BE'),
                    c: v.company,
                  })}
                </span>
              </div>
              {target ? (
                <UploadForm
                  key={`${target.kind}:${target.subject}:${target.item.docType}`}
                  token={token}
                  target={target}
                  onCancel={() => setTarget(null)}
                  onDone={() => {
                    setToast(
                      t('cdl.toast', {
                        t: docLabel(t, target.item.docType, target.item.title),
                        s: target.subject,
                        c: v.company,
                      }),
                    );
                    setTarget(null);
                  }}
                />
              ) : tab === 'veh' ? (
                v.vehicles.length ? (
                  v.vehicles.map((x) => (
                    <div key={x.id} className="cdl__card" data-testid="cdl-vehicle">
                      <span className="cdl__plate">{x.plate}</span>
                      {x.items.map((it) => (
                        <button
                          key={`${it.docType}:${it.targetDocumentId ?? ''}`}
                          type="button"
                          className="cdl__item"
                          disabled={it.state === 'pending_review'}
                          data-doc-type={it.docType}
                          onClick={() =>
                            setTarget({ kind: 'veh', vehicleId: x.id, subject: x.plate, item: it })
                          }
                        >
                          <span>{docLabel(t, it.docType, it.title)}</span>
                          <StateChip item={it} t={t} />
                        </button>
                      ))}
                    </div>
                  ))
                ) : (
                  <div className="cdl__empty">
                    <i>⌕</i>
                    <b>{t('cdl.noVeh')}</b>
                    <span className="cdl__muted">{t('cdl.noneD', { c: v.company })}</span>
                  </div>
                )
              ) : v.drivers.length ? (
                <div className="cdl__card">
                  {v.drivers.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="cdl__item"
                      disabled={d.licence.state === 'pending_review'}
                      data-testid="cdl-driver"
                      onClick={() =>
                        setTarget({ kind: 'drv', driverId: d.id, subject: d.name, item: d.licence })
                      }
                    >
                      <span>{d.name}</span>
                      <StateChip item={d.licence} t={t} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="cdl__empty">
                  <i>⌕</i>
                  <b>{t('cdl.noDrv')}</b>
                  <span className="cdl__muted">{t('cdl.noneD', { c: v.company })}</span>
                </div>
              )}
              {!target && <Sent v={v} t={t} />}
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
