import { Icon, ReasonDialog, Toast, useEscapeLayer } from '@tms/ui';
import { useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { formatDate, formatMoney, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useMe } from '../../shell/AppShell';
import { problemText } from '../master/problems';
import { vehPlate, type Vehicle } from './useVehicles';
import {
  addYears,
  DOC_FILE_MIME,
  openDocFile,
  todayTh,
  uploadDocFile,
  useCancelVehicleDoc,
  useCreateVehicleDoc,
  useRenewVehicleDoc,
  useVehicleDocs,
  VEHICLE_DOC_TYPES,
  type VehicleDoc,
  type VehicleDocType,
} from './useVehicleDocs';

/* สี soft() ของต้นแบบ TMS v4 */
const SOFT = {
  ok: { c: '#17733F', bg: '#E6F4EC' },
  warn: { c: '#8F5500', bg: '#FCF0DC' },
  err: { c: '#B3322A', bg: '#FBE9E7' },
  off: { c: '#3B424C', bg: '#ECEDEA' },
} as const;
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
export const typeLabel = (t: T, k: VehicleDocType) => t(`vdoc.type.${k}` as MessageKey);
/** ชื่อเอกสาร: OTHER ใช้ชื่อที่ตั้งเอง */
export const docName = (t: T, d: VehicleDoc) =>
  (d.docType === 'OTHER' && d.title) || typeLabel(t, d.docType);
/** "1,234.50" → "1234.50" */
const moneyIn = (s: string) => s.replace(/,/g, '').trim();

export function useDocDate() {
  const { lang } = useI18n();
  const me = useMe();
  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  return (iso: string) => formatDate(new Date(`${iso}T00:00:00`), lang, ys);
}

/** ป้ายสถานะ — ต้นแบบ: "หมดแล้ว N วัน" (err) / "หมดใน N วัน" (warn เมื่อใกล้หมด, ok) */
export function StatusPill({ d, t }: { d: VehicleDoc; t: T }) {
  // สีตามต้นแบบ: หมดแล้ว = err, ≤ 30 วัน = warn, นอกนั้น ok (สถานะ API `expiring` = ≤ 60 วันตาม docs/01 §3.8)
  const k =
    d.status === 'superseded' || d.status === 'cancelled'
      ? 'off'
      : d.daysToExpiry < 0
        ? 'err'
        : d.daysToExpiry <= 30
          ? 'warn'
          : 'ok';
  const label =
    d.status === 'superseded'
      ? t('vdoc.st.superseded')
      : d.status === 'cancelled'
        ? t('vdoc.st.cancelled')
        : d.daysToExpiry < 0
          ? t('vdoc.over', { n: -d.daysToExpiry })
          : t('vdoc.left', { n: d.daysToExpiry });
  return (
    <span
      className="tms-vdoc__pill"
      style={{ background: SOFT[k].bg, color: SOFT[k].c }}
      data-status={d.status}
    >
      {label}
    </span>
  );
}

/**
 * แท็บ "เอกสารแนบ" ใน drawer รถ (ST2-T17) — ต้นแบบ TMS v4 vPanel veh `P.docs` (การ์ดไฟล์: ไอคอน · ชื่อ · "หมดอายุ {วันที่}" · ดาวน์โหลด)
 * + ป้ายสถานะ/ปุ่ม "ต่ออายุ" จากตารางเอกสารในโปรไฟล์รถ (`pr.docs`) + modal ต่ออายุ (`RNW`)
 * ปุ่ม "+ เพิ่มเอกสาร" (spec/06 FLT-C) และประวัติการต่ออายุ ไม่มีในต้นแบบ drawer → [OPEN spec/12 §3]
 */
export function VehicleDocsTab({
  v,
  canWrite,
  layout = 'cards',
}: {
  v: Vehicle;
  canWrite: boolean;
  /** cards = drawer รถ (`P.docs`) · table = โปรไฟล์รถแท็บ "เอกสาร" (`pr.docs` — ST2-T07) */
  layout?: 'cards' | 'table';
}) {
  const { t } = useI18n();
  const dt = useDocDate();
  const q = useVehicleDocs(v.id);
  const [renewing, setRenewing] = useState<VehicleDoc | null>(null);
  const [cancelling, setCancelling] = useState<VehicleDoc | null>(null);
  const cancel = useCancelVehicleDoc();
  const [adding, setAdding] = useState(false);
  const [showHist, setShowHist] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const writable = canWrite && v.status !== 'retired';

  if (q.isLoading && layout === 'table') return <DocTable loading t={t} rows={[]} dt={dt} />;
  if (q.isLoading)
    return (
      <div className="tms-vdoc__list" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="tms-vdoc__item tms-skel" style={{ height: 62 }} />
        ))}
      </div>
    );
  if (q.isError)
    return (
      <div className="tms-vdoc__empty" role="alert">
        {t('vdoc.loadError')}{' '}
        <button type="button" className="tms-textlink" onClick={() => q.refetch()}>
          {t('veh.retry')}
        </button>
      </div>
    );
  const all = q.data ?? [];
  const current = all.filter((d) => d.status !== 'superseded' && d.status !== 'cancelled');
  const hist = all.filter((d) => d.status === 'superseded' || d.status === 'cancelled');
  const download = (id: string) => openDocFile(id).catch(() => setToast(t('vdoc.downloadFailed')));

  // ต่ออายุ + ยกเลิกเอกสาร (บันทึกผิด / เอกสาร "อื่น ๆ" ที่ไม่ต้องต่อแล้ว — ต้นแบบไม่มีปุ่มนี้ [OPEN spec/12 §3])
  const renewBtn = (d: VehicleDoc) =>
    writable ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <button type="button" className="tms-vdoc__renew" onClick={() => setRenewing(d)}>
          <Icon n="refresh-cw" s={14} />
          {t('vdoc.renew')}
        </button>
        <button
          type="button"
          className="tms-vdoc__dl"
          title={t('vdoc.cancel')}
          aria-label={t('vdoc.cancel')}
          onClick={() => setCancelling(d)}
        >
          <Icon n="ban" s={16} />
        </button>
      </span>
    ) : undefined;

  return (
    <>
      {layout === 'table' ? (
        <DocTable t={t} rows={current} dt={dt} action={renewBtn} onDownload={download} />
      ) : (
        <div className="tms-vdoc__list" data-testid="vdoc-list">
          {current.map((d) => (
            <DocRow
              key={d.id}
              d={d}
              t={t}
              sub={t('vdoc.expires', { d: dt(d.expiresOn) })}
              onDownload={download}
              action={renewBtn(d)}
            />
          ))}
          {!current.length && <div className="tms-vdoc__empty">{t('vdoc.empty')}</div>}
        </div>
      )}
      {(writable || hist.length > 0) && (
        <div className={`tms-vdoc__bar${layout === 'table' ? ' tms-vdoc__bar--pad' : ''}`}>
          {writable && (
            <button type="button" className="tms-vdoc__add" onClick={() => setAdding(true)}>
              <Icon n="plus" s={16} />
              {t('vdoc.add')}
            </button>
          )}
          {hist.length > 0 && (
            <button type="button" className="tms-textlink" onClick={() => setShowHist((x) => !x)}>
              {showHist ? t('vdoc.historyHide') : t('vdoc.history', { n: hist.length })}
            </button>
          )}
        </div>
      )}
      {showHist && (
        <div
          className={`tms-vdoc__list${layout === 'table' ? ' tms-vdoc__bar--pad' : ''}`}
          data-testid="vdoc-history"
        >
          {hist.map((d) => (
            <DocRow
              key={d.id}
              d={d}
              t={t}
              muted
              sub={
                d.status === 'cancelled' && d.cancelReason
                  ? t('vdoc.cancelledWhy', { r: d.cancelReason })
                  : t('vdoc.period', { from: dt(d.startsOn), to: dt(d.expiresOn) })
              }
              onDownload={download}
            />
          ))}
        </div>
      )}
      <ReasonDialog
        open={!!cancelling}
        title={
          cancelling
            ? t('vdoc.cancelT', {
                t: [docName(t, cancelling), cancelling.docNo].filter(Boolean).join(' '),
              })
            : ''
        }
        description={t('vdoc.cancelD')}
        label={t('veh.dlg.reason')}
        placeholder={t('veh.dlg.reasonPh')}
        okLabel={t('vdoc.cancel')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={cancel.isPending}
        error={problemText(cancel.error, t)}
        onClose={() => {
          setCancelling(null);
          cancel.reset();
        }}
        onOk={(reason) => {
          if (!cancelling) return;
          const d = cancelling;
          cancel.mutate(
            { id: d.id, reason },
            {
              onSuccess: () => {
                setCancelling(null);
                setToast(t('vdoc.cancelDone', { t: docName(t, d), p: vehPlate(t, v) }));
              },
            },
          );
        }}
      />
      {renewing && (
        <RenewDialog
          d={renewing}
          plate={vehPlate(t, v)}
          onClose={() => setRenewing(null)}
          onDone={(n) => {
            setRenewing(null);
            setToast(
              t('vdoc.rnw.done', {
                t: docName(t, n),
                p: vehPlate(t, v),
                d: dt(n.expiresOn),
              }),
            );
          }}
        />
      )}
      {adding && (
        <AddDialog
          v={v}
          onClose={() => setAdding(false)}
          onDone={(n) => {
            setAdding(false);
            setToast(t('vdoc.add.done', { t: docName(t, n), p: vehPlate(t, v) }));
          }}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </>
  );
}

/**
 * ตารางเอกสารในโปรไฟล์รถ (ST2-T07) — ต้นแบบ TMS v4 `pr.docs`:
 * ประเภท · เลขที่ · บริษัท / หน่วยงาน · เริ่ม – หมด · เบี้ย / ค่าใช้จ่าย (฿) · ไฟล์แนบ · สถานะ · [ต่ออายุ]
 */
function DocTable({
  t,
  rows,
  dt,
  loading,
  action,
  onDownload,
}: {
  t: T;
  rows: VehicleDoc[];
  dt: (iso: string) => string;
  loading?: boolean;
  action?: (d: VehicleDoc) => ReactNode;
  onDownload?: (id: string) => void;
}) {
  return (
    <>
      <table className="tms-vprof__table" data-testid="vdoc-list" aria-busy={loading || undefined}>
        <thead>
          <tr>
            <th>{t('vprof.doc.type')}</th>
            <th>{t('vprof.doc.no')}</th>
            <th>{t('vprof.doc.issuer')}</th>
            <th>{t('vprof.doc.period')}</th>
            <th style={{ textAlign: 'right' }}>{t('vprof.doc.cost')}</th>
            <th>{t('vprof.doc.file')}</th>
            <th>{t('vprof.doc.status')}</th>
            <th style={{ width: '1%' }} />
          </tr>
        </thead>
        <tbody>
          {loading
            ? [0, 1, 2].map((i) => (
                <tr key={i}>
                  <td colSpan={8}>
                    <div className="tms-vprof__skel" />
                  </td>
                </tr>
              ))
            : rows.map((d) => {
                const f = d.files[0];
                const cost = d.premiumAmount ?? d.costAmount;
                return (
                  <tr key={d.id} data-doc-type={d.docType}>
                    <td style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{docName(t, d)}</td>
                    <td className="tms-num">{d.docNo ?? '—'}</td>
                    <td>{d.issuer ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {`${dt(d.startsOn)} – ${dt(d.expiresOn)}`}
                    </td>
                    <td className="tms-num" style={{ textAlign: 'right' }}>
                      {cost ? formatMoney(cost) : '—'}
                    </td>
                    <td>
                      {f ? (
                        <button
                          type="button"
                          className="tms-vprof__file"
                          title={t('vdoc.download')}
                          onClick={() => onDownload?.(f.id)}
                        >
                          <Icon n="paperclip" s={14} />
                          {f.filename ?? t('vdoc.download')}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <StatusPill d={d} t={t} />
                    </td>
                    <td>{action?.(d)}</td>
                  </tr>
                );
              })}
        </tbody>
      </table>
      {!loading && !rows.length && <div className="tms-vdoc__empty">{t('vdoc.empty')}</div>}
    </>
  );
}

function DocRow({
  d,
  t,
  sub,
  muted,
  action,
  onDownload,
}: {
  d: VehicleDoc;
  t: T;
  sub: string;
  muted?: boolean;
  action?: ReactNode;
  onDownload: (id: string) => void;
}) {
  const f = d.files[0];
  const icon =
    d.docType === 'INSURANCE' ? 'shield' : f?.mime.startsWith('image/') ? 'image' : 'file-text';
  const name = [docName(t, d), d.docNo].filter(Boolean).join(' · ');
  return (
    <div className="tms-vdoc__item" data-doc-type={d.docType} style={muted ? { opacity: 0.8 } : {}}>
      <Icon n={icon} s={18} style={{ color: '#59606B', flexShrink: 0 }} />
      <div className="tms-vdoc__text">
        <span className="tms-ellipsis" title={name}>
          {name}
        </span>
        <span className="tms-vdoc__sub tms-ellipsis" title={sub}>
          {sub}
        </span>
      </div>
      <StatusPill d={d} t={t} />
      {action}
      {f && (
        <button
          type="button"
          className="tms-vdoc__dl"
          title={t('vdoc.download')}
          aria-label={t('vdoc.download')}
          onClick={() => onDownload(f.id)}
        >
          <Icon n="download" s={18} />
        </button>
      )}
    </div>
  );
}

// ---------- dialog (ต้นแบบ RNW: กว้าง 560, มุม 20, หัว 18px) ----------

function Dialog({
  title,
  sub,
  children,
  foot,
  onClose,
}: {
  title: ReactNode;
  sub: ReactNode;
  children: ReactNode;
  foot: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  // Esc ปิดเฉพาะ modal นี้ (ไม่ปิด drawer ข้างหลัง)
  useEscapeLayer(true, onClose);
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 id={`${id}-t`} className="tms-dialog__title" style={{ fontSize: 18 }}>
              {title}
            </h2>
            <p className="tms-dialog__desc">{sub}</p>
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
        <div className="tms-dialog__body">{children}</div>
        <div className="tms-dialog__foot" style={{ borderTopColor: '#E4E6E0' }}>
          {foot}
        </div>
      </div>
    </div>
  );
}

function Fld({
  label,
  req,
  span,
  err,
  children,
}: {
  label: string;
  req?: boolean;
  span?: boolean;
  err?: string | undefined;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="tms-ffield" style={span ? { gridColumn: 'span 2' } : undefined}>
      <label htmlFor={id} className="tms-label">
        {label}
        {req && <span style={{ color: '#B3322A' }}> *</span>}
      </label>
      {children(id)}
      {err && <span className="tms-field-error">{err}</span>}
    </div>
  );
}

/** เลือก + อัปโหลดไฟล์ทันที (ต้นแบบ: ปุ่มเส้นประ "เลือกไฟล์ PDF หรือรูป" → แถวคลิปหนีบ + ✓) */
function FilePick({
  file,
  onFile,
  err,
}: {
  file: { id: string; name: string } | null;
  onFile: (f: { id: string; name: string } | null) => void;
  err?: string | undefined;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFail(null);
    setBusy(true);
    try {
      onFile({ id: await uploadDocFile(f), name: f.name });
    } catch (e) {
      // ไฟล์ไม่ผ่าน (ชนิดไม่ตรงเนื้อไฟล์ / ใหญ่เกิน / ว่าง) → ข้อความเดียวที่บอกเงื่อนไขไฟล์
      setFail(
        e instanceof ApiError && e.problem.code !== 'validation_failed'
          ? (problemText(e, t) ?? t('vdoc.v.badFile'))
          : t('vdoc.v.badFile'),
      );
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  };
  return (
    <div className="tms-ffield">
      <span className="tms-label">
        {t('vdoc.f.file')} <span style={{ color: '#B3322A' }}>*</span>
      </span>
      <input
        ref={ref}
        type="file"
        accept={DOC_FILE_MIME.join(',')}
        hidden
        data-testid="vdoc-file"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {file ? (
        <div className="tms-vdoc__file">
          <Icon n="paperclip" s={16} style={{ color: '#2257C4' }} />
          <span
            className="tms-num tms-ellipsis"
            style={{ flex: 1, fontSize: 13 }}
            title={file.name}
          >
            {file.name}
          </span>
          <Icon n="check" s={16} style={{ color: '#17733F' }} />
        </div>
      ) : (
        <button
          type="button"
          className="tms-vdoc__pick"
          disabled={busy}
          aria-invalid={!!err}
          onClick={() => ref.current?.click()}
        >
          <Icon n="upload" s={16} />
          {busy ? t('vdoc.f.uploading') : t('vdoc.f.pick')}
        </button>
      )}
      {(fail ?? err) && <span className="tms-field-error">{fail ?? err}</span>}
    </div>
  );
}

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

/**
 * กดบันทึกครั้งเดียว + Idempotency-Key ต่อการเปิดฟอร์ม (review ST2-T17)
 * - กันกดซ้ำแบบ synchronous (ref) ก่อน state isPending จะเปลี่ยน
 * - เปลี่ยน key เฉพาะเมื่อ server ตอบปฏิเสธชัดเจน (4xx) — เน็ตหลุด/5xx/ยังประมวลผล ใช้ key เดิมส่งซ้ำ (ได้ผลเดิม ไม่สร้างซ้ำ)
 */
function useSubmitOnce() {
  const busy = useRef(false);
  const key = useRef(newKey());
  return {
    start: () => {
      if (busy.current) return null;
      busy.current = true;
      return key.current;
    },
    done: (err?: unknown) => {
      busy.current = false;
      if (
        err instanceof ApiError &&
        err.problem.status >= 400 &&
        err.problem.status < 500 &&
        err.problem.code !== 'idempotency_in_progress'
      )
        key.current = newKey();
    },
  };
}

/** วันที่ที่รับ (API ตรวจซ้ำ 1980–2100) */
const DATE_MIN = '1980-01-01';
const DATE_MAX = '2100-12-31';

/** ข้อผิดพลาดจาก server → ข้อความใต้ช่อง · ช่องที่ฟอร์มนี้ไม่มี → ข้อความรวมด้านบน (`top`) */
function serverErrs(
  err: unknown,
  t: T,
  known: string[],
  d?: { t: string },
): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const e of err.problem.errors ?? []) {
    const f = e.field ?? '';
    if (e.code === 'expires_before_start') out.expiresOn = t('vdoc.v.period');
    else if (e.code === 'not_after_previous') out.expiresOn = t('vdoc.v.afterPrev');
    else if (e.code === 'out_of_range' && known.includes(f)) out[f] = t('vdoc.v.dateRange');
    else if (e.code === 'current_exists') out.docType = t('vdoc.v.exists', { t: d?.t ?? '' });
    else if (e.code === 'already_renewed') out.top = t('vdoc.v.renewed');
    else if (e.code === 'file_in_use') out.file = t('vdoc.v.fileInUse');
    else if (f === 'fileDocumentIds') out.file = t('vdoc.v.badFile');
    else if (f && known.includes(f)) out[f] = t('vdoc.v.invalid');
    else out.top ??= problemText(err, t) ?? t('vdoc.v.invalid');
  }
  if (!err.problem.errors?.length) out.top = problemText(err, t) ?? t('vdoc.v.invalid');
  return out;
}

export function RenewDialog({
  d,
  plate,
  onClose,
  onDone,
}: {
  d: VehicleDoc;
  plate: string;
  onClose: () => void;
  onDone: (n: VehicleDoc) => void;
}) {
  const { t } = useI18n();
  const dt = useDocDate();
  const renew = useRenewVehicleDoc();
  const today = todayTh();
  // ต้นแบบ: เริ่ม = วันหมดของฉบับเดิม (หมดไปแล้ว = วันนี้), หมด = +1 ปี, ค่าใช้จ่ายตั้งต้นจากฉบับเดิม
  const start0 = d.expiresOn > today ? d.expiresOn : today;
  const [no, setNo] = useState('');
  const [from, setFrom] = useState(start0);
  const [to, setTo] = useState(addYears(start0, 1));
  const [cost, setCost] = useState(d.costAmount ? formatMoney(d.costAmount) : '');
  const [issuer, setIssuer] = useState(d.issuer ?? '');
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const once = useSubmitOnce();
  const local: Record<string, string> = {};
  if (from && to && to <= from) local.expiresOn = t('vdoc.v.period');
  else if (to && to <= d.expiresOn) local.expiresOn = t('vdoc.v.afterPrev');
  if (cost && !MONEY_RE.test(moneyIn(cost))) local.costAmount = t('vdoc.v.money');
  const ok =
    (no.trim().length > 0 || d.docType === 'OTHER') &&
    !!file &&
    !!from &&
    !!to &&
    !Object.keys(local).length &&
    !renew.isPending;
  const srv = serverErrs(renew.error, t, [
    'docNo',
    'startsOn',
    'expiresOn',
    'costAmount',
    'issuer',
  ]);
  const errs = { ...srv, ...local };
  const top = srv.top ?? null;
  const badge = d.daysToExpiry < 0 ? 'err' : d.daysToExpiry <= 30 ? 'warn' : 'ok';

  const submit = () => {
    if (!ok) return;
    const idempotencyKey = once.start();
    if (!idempotencyKey) return;
    renew.mutate(
      {
        id: d.id,
        idempotencyKey,
        body: {
          ...(no.trim() ? { docNo: no.trim() } : {}),
          startsOn: from,
          expiresOn: to,
          issuer: issuer.trim() || null,
          costAmount: cost ? moneyIn(cost) : null,
          ...(d.docType === 'INSURANCE' ? { premiumAmount: cost ? moneyIn(cost) : null } : {}),
          fileDocumentIds: [file!.id],
        },
      },
      {
        onSuccess: (r) => {
          once.done();
          onDone(r.document);
        },
        onError: (e) => once.done(e),
      },
    );
  };

  return (
    <Dialog
      title={t('vdoc.rnw.title', { t: docName(t, d) })}
      sub={
        <span className="tms-num" style={{ fontSize: 13 }}>
          {t('vdoc.rnw.sub', { p: plate, no: d.docNo ?? '—', to: dt(d.expiresOn) })}
        </span>
      }
      onClose={onClose}
      foot={
        <>
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 18px', opacity: ok ? 1 : 0.5 }}
            disabled={!ok}
            aria-busy={renew.isPending}
            onClick={submit}
          >
            <Icon n="refresh-cw" s={16} />
            {t('vdoc.rnw.ok')}
          </button>
        </>
      }
    >
      <div>
        <span
          className="tms-vdoc__pill"
          style={{ background: SOFT[badge].bg, color: SOFT[badge].c }}
        >
          {d.daysToExpiry < 0
            ? t('vdoc.over', { n: -d.daysToExpiry })
            : t('vdoc.left', { n: d.daysToExpiry })}
        </span>
      </div>
      {top && <div className="tms-alert">{top}</div>}
      <div className="tms-vdoc__grid">
        <Fld label={t('vdoc.rnw.no')} req={d.docType !== 'OTHER'} span err={errs.docNo}>
          {(id) => (
            <input
              id={id}
              name="docNo"
              className="tms-input tms-num"
              value={no}
              placeholder={t('vdoc.rnw.noPh')}
              maxLength={60}
              aria-invalid={!!errs.docNo}
              onChange={(e) => setNo(e.target.value)}
              autoFocus
            />
          )}
        </Fld>
        <Fld label={t('vdoc.f.from')} req err={errs.startsOn}>
          {(id) => (
            <input
              id={id}
              name="startsOn"
              type="date"
              min={DATE_MIN}
              max={DATE_MAX}
              className="tms-input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          )}
        </Fld>
        <Fld label={t('vdoc.f.to')} req err={errs.expiresOn}>
          {(id) => (
            <input
              id={id}
              name="expiresOn"
              type="date"
              min={DATE_MIN}
              max={DATE_MAX}
              className="tms-input"
              value={to}
              aria-invalid={!!errs.expiresOn}
              onChange={(e) => setTo(e.target.value)}
            />
          )}
        </Fld>
        <Fld label={t('vdoc.f.cost')} err={errs.costAmount}>
          {(id) => (
            <input
              id={id}
              name="costAmount"
              className="tms-input tms-num"
              style={{ textAlign: 'right' }}
              inputMode="decimal"
              value={cost}
              aria-invalid={!!errs.costAmount}
              onChange={(e) => setCost(e.target.value)}
            />
          )}
        </Fld>
        <Fld label={t('vdoc.f.co')} err={errs.issuer}>
          {(id) => (
            <input
              id={id}
              name="issuer"
              className="tms-input"
              value={issuer}
              maxLength={120}
              onChange={(e) => setIssuer(e.target.value)}
            />
          )}
        </Fld>
      </div>
      <FilePick file={file} onFile={setFile} err={errs.file} />
      <span style={{ fontSize: 13, color: ok ? '#17733F' : '#3B424C' }}>
        {ok ? t('vdoc.rnw.hintOk', { d: dt(to) }) : t('vdoc.rnw.hint')}
      </span>
    </Dialog>
  );
}

function AddDialog({
  v,
  onClose,
  onDone,
}: {
  v: Vehicle;
  onClose: () => void;
  onDone: (n: VehicleDoc) => void;
}) {
  const { t } = useI18n();
  const create = useCreateVehicleDoc(v.id);
  const today = todayTh();
  const [type, setType] = useState<VehicleDocType>('INSURANCE');
  const [title, setTitle] = useState('');
  const [no, setNo] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addYears(today, 1));
  const [issuer, setIssuer] = useState('');
  const [cost, setCost] = useState('');
  const [klass, setKlass] = useState('');
  const [sum, setSum] = useState('');
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const once = useSubmitOnce();
  const ins = type === 'INSURANCE';
  const other = type === 'OTHER';
  const local: Record<string, string> = {};
  if (from && to && to <= from) local.expiresOn = t('vdoc.v.period');
  if (cost && !MONEY_RE.test(moneyIn(cost))) local.costAmount = t('vdoc.v.money');
  if (ins && sum && !MONEY_RE.test(moneyIn(sum))) local.sumInsured = t('vdoc.v.money');
  const ok =
    (other ? title.trim().length > 0 : no.trim().length > 0) &&
    !!file &&
    !!from &&
    !!to &&
    !Object.keys(local).length &&
    !create.isPending;
  const srv = serverErrs(
    create.error,
    t,
    [
      'docType',
      'title',
      'docNo',
      'startsOn',
      'expiresOn',
      'costAmount',
      'issuer',
      'insuranceClass',
      'sumInsured',
    ],
    { t: typeLabel(t, type) },
  );
  const errs = { ...srv, ...local };
  const top = srv.top ?? null;

  const submit = () => {
    if (!ok) return;
    const money = (s: string) => (s ? moneyIn(s) : null);
    const idempotencyKey = once.start();
    if (!idempotencyKey) return;
    create.mutate(
      {
        idempotencyKey,
        body: {
          docType: type,
          ...(other ? { title: title.trim() } : {}),
          ...(no.trim() ? { docNo: no.trim() } : {}),
          issuer: issuer.trim() || null,
          startsOn: from,
          expiresOn: to,
          costAmount: money(cost),
          ...(ins
            ? {
                insuranceClass: klass.trim() || null,
                sumInsured: money(sum),
                premiumAmount: money(cost),
              }
            : {}),
          fileDocumentIds: [file!.id],
        },
      },
      {
        onSuccess: (n) => {
          once.done();
          onDone(n);
        },
        onError: (e) => once.done(e),
      },
    );
  };

  return (
    <Dialog
      title={t('vdoc.add')}
      sub={
        <span className="tms-num" style={{ fontSize: 13 }}>
          {t('vdoc.add.sub', { p: vehPlate(t, v) })}
        </span>
      }
      onClose={onClose}
      foot={
        <>
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 18px', opacity: ok ? 1 : 0.5 }}
            disabled={!ok}
            aria-busy={create.isPending}
            onClick={submit}
          >
            <Icon n="save" s={16} />
            {t('vdoc.add.ok')}
          </button>
        </>
      }
    >
      {top && <div className="tms-alert">{top}</div>}
      <div className="tms-vdoc__grid">
        <Fld label={t('vdoc.f.type')} req span={!other} err={errs.docType}>
          {(id) => (
            <select
              id={id}
              name="docType"
              className="tms-select"
              value={type}
              aria-invalid={!!errs.docType}
              onChange={(e) => {
                setType(e.target.value as VehicleDocType);
                create.reset();
              }}
            >
              {VEHICLE_DOC_TYPES.map((k) => (
                <option key={k} value={k}>
                  {typeLabel(t, k)}
                </option>
              ))}
            </select>
          )}
        </Fld>
        {other && (
          <Fld label={t('vdoc.f.title')} req err={errs.title}>
            {(id) => (
              <input
                id={id}
                name="title"
                className="tms-input"
                value={title}
                maxLength={80}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Fld>
        )}
        <Fld label={t('vdoc.f.no')} req={!other} span err={errs.docNo}>
          {(id) => (
            <input
              id={id}
              name="docNo"
              className="tms-input tms-num"
              value={no}
              placeholder={t('vdoc.rnw.noPh')}
              maxLength={60}
              onChange={(e) => setNo(e.target.value)}
            />
          )}
        </Fld>
        <Fld label={t('vdoc.f.from')} req err={errs.startsOn}>
          {(id) => (
            <input
              id={id}
              name="startsOn"
              type="date"
              min={DATE_MIN}
              max={DATE_MAX}
              className="tms-input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          )}
        </Fld>
        <Fld label={t('vdoc.f.to')} req err={errs.expiresOn}>
          {(id) => (
            <input
              id={id}
              name="expiresOn"
              type="date"
              min={DATE_MIN}
              max={DATE_MAX}
              className="tms-input"
              value={to}
              aria-invalid={!!errs.expiresOn}
              onChange={(e) => setTo(e.target.value)}
            />
          )}
        </Fld>
        <Fld label={t('vdoc.f.premium')} err={errs.costAmount}>
          {(id) => (
            <input
              id={id}
              name="costAmount"
              className="tms-input tms-num"
              style={{ textAlign: 'right' }}
              inputMode="decimal"
              value={cost}
              aria-invalid={!!errs.costAmount}
              onChange={(e) => setCost(e.target.value)}
            />
          )}
        </Fld>
        <Fld label={t('vdoc.f.co')} err={errs.issuer}>
          {(id) => (
            <input
              id={id}
              name="issuer"
              className="tms-input"
              value={issuer}
              maxLength={120}
              onChange={(e) => setIssuer(e.target.value)}
            />
          )}
        </Fld>
        {ins && (
          <>
            <Fld label={t('vdoc.f.class')} err={errs.insuranceClass}>
              {(id) => (
                <input
                  id={id}
                  name="insuranceClass"
                  className="tms-input"
                  value={klass}
                  maxLength={20}
                  onChange={(e) => setKlass(e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('vdoc.f.sum')} err={errs.sumInsured}>
              {(id) => (
                <input
                  id={id}
                  name="sumInsured"
                  className="tms-input tms-num"
                  style={{ textAlign: 'right' }}
                  inputMode="decimal"
                  value={sum}
                  aria-invalid={!!errs.sumInsured}
                  onChange={(e) => setSum(e.target.value)}
                />
              )}
            </Fld>
          </>
        )}
      </div>
      <FilePick file={file} onFile={setFile} err={errs.file} />
      <span style={{ fontSize: 13, color: '#3B424C' }}>{!ok && t('vdoc.add.hint')}</span>
    </Dialog>
  );
}
