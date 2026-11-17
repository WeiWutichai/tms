import { Badge, Icon, ReasonDialog, useEscapeLayer } from '@tms/ui';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { useDateTimeText } from '../rate-cards/rateFormat';
import type { TripDetail } from '../trips/useTrips';
import { openDocFile } from '../vehicles/useVehicleDocs';
import { podFieldName } from './PodChecklistTable';
import {
  POD_FILE_MIME,
  POD_FILES_MAX,
  POD_IMAGE_MIME,
  POD_PHOTOS_MAX,
  POD_REASON_MIN,
  uploadPodFile,
  useDoPods,
  useSavePod,
  weightDiff,
  type DoPod,
  type PodBody,
  type PodDoc,
  type PodMissing,
} from './usePod';

type T = (k: MessageKey, p?: Record<string, string | number>) => string;

/* ค่าสไตล์จากต้นแบบ TMS v4 (vPanel แท็บ "เอกสาร"/"หลักฐานส่ง" ของ DO) */
const H3: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };
const PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 32,
  padding: '0 12px',
  border: '1px solid #9DB6E3',
  borderRadius: 999,
  background: '#FFFFFF',
  color: '#2257C4',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const DOC_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: 12,
  border: '1px solid #D9DCD4',
  borderRadius: 8,
};
const ROUND_BTN: CSSProperties = {
  width: 32,
  height: 32,
  border: 0,
  borderRadius: 999,
  background: 'transparent',
  color: '#3B424C',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};
const LABEL: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' };
const INPUT: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};
const SECTION: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };

const POD_TONE = { NONE: 'off', PARTIAL: 'warn', COMPLETE: 'ok' } as const;
const POD_ICON = { NONE: 'circle-dashed', PARTIAL: 'circle-alert', COMPLETE: 'circle-check' };
const RELATIONS = ['SELF', 'SECURITY', 'STAFF', 'OTHER'] as const;

const kb = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
const ext = (d: PodDoc) =>
  ({ 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WEBP' })[
    d.mime
  ] ?? d.mime;

/** errors[] ของ API (field + code) → ข้อความไทยใต้ช่องนั้น (QA L3) */
export function podFieldError(
  t: T,
  e: { field: string; code: string },
  lim: { pin?: number; max?: number },
): string {
  if (e.code === 'document_in_use') return t('pod.e.v.inUse');
  if (e.code === 'not_ready') return t('pod.e.v.notReady');
  if (e.code === 'invalid_kind') return t('pod.e.badFile');
  if (e.code === 'not_found') return t('pod.e.v.docNotFound');
  if (e.code === 'required' || e.code === 'min_count') return t('pod.e.v.required');
  if (e.code === 'unknown_key') return t('pod.e.v.unknown');
  if (e.field === 'pin') return t('pod.e.v.pin', { n: lim.pin ?? 4 });
  if (e.field === 'rating') return t('pod.e.v.rating', { max: lim.max ?? 5 });
  if (e.field === 'barcodes' || e.field === 'scanCodes') return t('pod.e.v.barcode');
  if (e.field.startsWith('choices.')) return t('pod.e.v.choice');
  return t('pod.e.v.invalid');
}

/** รายการที่ขาด → ข้อความอ่านง่าย */
export function missingText(t: T, m: PodMissing, fields: DoPod['checklist']['fields']): string {
  const f = fields.find((x) => x.key === m.key);
  const name = f ? podFieldName(t, f) : m.key;
  if (m.code === 'min_count')
    return t('pod.e.missMin', { name, have: m.actual ?? 0, need: m.expected ?? 1 });
  if (m.code === 'invalid') return t('pod.e.missInvalid', { name });
  return name;
}

/**
 * แท็บ "เอกสาร" ของ drawer เที่ยวรถ (ST4-T07 — ต้นแบบ TMS v4 vPanel 'trp' แท็บ docs ป้าย "เอกสารแนบ")
 * แถวเอกสารของต้นแบบ (ใบคุมรถ) + หลักฐานส่งต่อ DO ใช้หน้าตาแท็บ "หลักฐานส่ง" ของ drawer DO ในต้นแบบ
 * (ระบบยังไม่มีหน้า/drawer DO — backlog ผู้สมัคร #24) [DECISION spec/12 §3]
 */
export function TripDocsTab({
  trip,
  canEdit,
  onPrintSheet,
  printBusy,
  onToast,
}: {
  trip: TripDetail;
  canEdit: boolean;
  /** ดาวน์โหลดใบคุมรถ (ST3-T20) — ไม่มีสิทธิ์/ยกเลิก = ไม่แสดงแถว */
  onPrintSheet?: () => void;
  printBusy?: boolean;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  // DO ที่มีจุดส่งในเที่ยว เรียงตามลำดับจุดส่ง
  const dos = useMemo(() => {
    const seq = new Map(trip.stops.map((s) => [s.id, s]));
    return trip.deliveryOrders
      .filter((d) => d.status !== 'CANCELLED' && d.status !== 'cancelled')
      .map((d) => ({ d, stop: d.dropStopId ? seq.get(d.dropStopId) : undefined }))
      .sort((a, b) => (a.stop?.sequence ?? 999) - (b.stop?.sequence ?? 999));
  }, [trip]);
  const pods = useDoPods(
    dos.map((x) => x.d.id),
    true,
  );
  const [open, setOpen] = useState<string | null>(null);
  // เปิด DO แรกที่ยังรอหลักฐาน (บันทึกได้และยังไม่ครบ) ครั้งแรกที่โหลดเสร็จ
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || pods.some((q) => q.isLoading)) return;
    picked.current = true;
    const first = pods.find((q) => q.data?.editable && q.data.podStatus !== 'COMPLETE')?.data;
    if (first) setOpen(first.deliveryOrderId);
  }, [pods]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {onPrintSheet && (
        <div style={DOC_ROW}>
          <Icon n="file-text" s={18} style={{ color: '#59606B' }} />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {t('pod.e.sheetFile', { no: trip.tripNo })}
            </span>
            <span style={{ fontSize: 12, color: '#3B424C' }}>PDF</span>
          </div>
          <button
            type="button"
            title={t('pod.e.download')}
            aria-label={`${t('pod.e.download')} ${t('pod.e.sheetFile', { no: trip.tripNo })}`}
            disabled={printBusy}
            onClick={onPrintSheet}
            style={ROUND_BTN}
          >
            <Icon n="download" s={18} />
          </button>
        </div>
      )}
      {dos.map(({ d, stop }, i) => {
        const q = pods[i]!;
        return (
          <DoPodBlock
            key={d.id}
            doNo={d.doNo}
            siteName={stop?.siteName ?? ''}
            pod={q.data}
            loading={q.isLoading}
            error={q.isError ? (problemText(q.error, t) ?? t('pod.e.loadError')) : null}
            open={open === d.id}
            onToggle={() => setOpen(open === d.id ? null : d.id)}
            doId={d.id}
            canEdit={canEdit}
            onToast={onToast}
          />
        );
      })}
      {!dos.length && <span style={{ color: '#3B424C' }}>{t('pod.e.noDo')}</span>}
    </div>
  );
}

function DoPodBlock({
  doId,
  doNo,
  siteName,
  pod,
  loading,
  error,
  open,
  onToggle,
  canEdit,
  onToast,
}: {
  doId: string;
  doNo: string;
  siteName: string;
  pod: DoPod | undefined;
  loading: boolean;
  error: string | null;
  open: boolean;
  onToggle: () => void;
  canEdit: boolean;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const st = (pod?.podStatus ?? 'NONE') as keyof typeof POD_TONE;
  const panelId = `pod-${doId}`;
  return (
    <div style={{ border: '1px solid #D9DCD4', borderRadius: 8 }} data-testid="do-pod">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        style={{
          ...DOC_ROW,
          border: 0,
          width: '100%',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          color: '#101418',
        }}
      >
        <Icon n="package" s={18} style={{ color: '#59606B' }} />
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {doNo}
          </span>
          <span style={{ fontSize: 12, color: '#3B424C' }}>
            {[siteName, t('pod.e.sub')].filter(Boolean).join(' · ')}
          </span>
        </div>
        {pod && (
          <Badge
            label={t(`pod.e.st.${st}` as MessageKey)}
            tone={POD_TONE[st]}
            icon={POD_ICON[st]}
          />
        )}
        <Icon n={open ? 'chevron-up' : 'chevron-down'} s={18} style={{ color: '#59606B' }} />
      </button>
      {open && (
        <div
          id={panelId}
          style={{
            borderTop: '1px solid #E4E6E0',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          {loading && <span style={{ color: '#59606B' }}>{t('table.loading')}</span>}
          {error && (
            <span className="tms-field-error" role="alert">
              {error}
            </span>
          )}
          {pod && (
            <PodForm
              key={doId}
              doId={doId}
              pod={pod}
              canEdit={canEdit && pod.editable}
              onToast={onToast}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** สถานะร่างในฟอร์ม (ไฟล์เก็บข้อมูลเอกสารไว้แสดงผล) */
interface Draft {
  photos: PodDoc[];
  files: PodDoc[];
  signature: PodDoc | null;
  receiverName: string;
  receiverRelation: string;
  weighedKg: string;
  customerRef: string;
  note: string;
  checks: Record<string, boolean>;
  choices: Record<string, string>;
  barcodes: string;
  pin: string;
  /** ล้าง PIN เดิม (ส่ง null) — ยืนยันแล้ว */
  pinClear: boolean;
  rating: string;
}

function draftOf(pod: DoPod): Draft {
  const c = pod.current;
  return {
    photos: c?.photos ?? [],
    files: c?.files ?? [],
    signature: c?.signature ?? null,
    receiverName: c?.receiverName ?? '',
    receiverRelation: c?.receiverRelation ?? '',
    weighedKg: c?.weighedKg ?? '',
    customerRef: c?.customerRef ?? '',
    note: c?.note ?? '',
    checks: { ...(c?.checks ?? {}) },
    choices: { ...(c?.choices ?? {}) },
    barcodes: (c?.barcodes ?? []).join('\n'),
    pin: '',
    pinClear: false,
    rating: c?.rating ? String(c.rating) : '',
  };
}

/** ร่าง → body ของ PUT (ส่งทั้งฉบับ — PIN ว่าง = คงของเดิม) */
export function bodyOfDraft(d: Draft): PodBody {
  const s = (v: string) => v.trim() || null;
  return {
    receiverName: s(d.receiverName),
    receiverRelation: (s(d.receiverRelation) as PodBody['receiverRelation']) ?? null,
    signatureDocumentId: d.signature?.id ?? null,
    photoDocumentIds: d.photos.map((p) => p.id),
    fileDocumentIds: d.files.map((p) => p.id),
    weighedKg: s(d.weighedKg.replace(/,/g, '')),
    customerRef: s(d.customerRef),
    note: s(d.note),
    checks: d.checks,
    choices: Object.fromEntries(Object.entries(d.choices).filter(([, v]) => v)),
    barcodes: d.barcodes
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean),
    ...(d.pin.trim() ? { pin: d.pin.trim() } : d.pinClear ? { pin: null } : {}),
    rating: d.rating ? Number(d.rating) : null,
  };
}

const same = (a: PodBody, b: PodBody) => JSON.stringify(a) === JSON.stringify(b);

function PodForm({
  doId,
  pod,
  canEdit,
  onToast,
}: {
  doId: string;
  pod: DoPod;
  canEdit: boolean;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const dt = useDateTimeText();
  const save = useSavePod();
  /** ฉบับที่ผู้ใช้แก้อยู่ (If-Match) — ฉบับใหม่มาขณะยังไม่แก้ = ตามทันที · แก้ค้างอยู่ = คงสิ่งที่แก้ + แจ้งให้โหลดใหม่ */
  const [base, setBase] = useState<DoPod>(pod);
  const [d, setD] = useState<Draft>(() => draftOf(pod));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const [sigOpen, setSigOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const photoIn = useRef<HTMLInputElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const fields = pod.checklist.fields;
  const on = (type: string) => fields.find((f) => f.type === type && f.level !== 'DISABLED');
  const photoF = fields.find((f) => f.type === 'PHOTO');
  const sigF = on('SIGNATURE');
  const noteF = on('NOTE');
  const barF = on('BARCODE');
  const pinF = on('PIN');
  const rateF = on('RATING');
  const customs = fields.filter(
    (f) => (f.type === 'BOOLEAN' || f.type === 'SINGLE_CHOICE') && f.level !== 'DISABLED',
  );
  const ro = !canEdit;
  const put = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const body = bodyOfDraft(d);
  // เปลี่ยนจากฉบับปัจจุบัน (หรือจากฟอร์มว่างเมื่อยังไม่มี) จึงบันทึกได้
  const dirty = !same(body, bodyOfDraft(draftOf(base)));
  const version = base.versions[0]?.version ?? 0;
  const latestV = pod.versions[0]?.version ?? 0;
  const stale = latestV !== version;
  useEffect(() => {
    if (latestV === version) return;
    if (!dirty) {
      setBase(pod);
      setD(draftOf(pod));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestV]);
  const reload = () => {
    setBase(pod);
    setD(draftOf(pod));
    setErr(null);
    setFieldErrs({});
  };
  /** ข้อความผิดของช่อง (errors[].field ของ API) */
  const fe = (...prefixes: string[]) => {
    const k = Object.keys(fieldErrs).find((f) =>
      prefixes.some((p) => f === p || f.startsWith(`${p}.`)),
    );
    return k ? (
      <span className="tms-field-error" role="alert">
        {fieldErrs[k]}
      </span>
    ) : null;
  };
  const req = (f?: { level: string }) =>
    f?.level === 'REQUIRED' ? <span style={{ color: '#B3322A' }}> *</span> : null;

  const upload = async (list: FileList | null, kind: 'POD_PHOTO' | 'POD_FILE') => {
    if (!list?.length) return;
    const room =
      kind === 'POD_PHOTO' ? POD_PHOTOS_MAX - d.photos.length : POD_FILES_MAX - d.files.length;
    const files = [...list].slice(0, Math.max(0, room));
    if (files.length < list.length) setErr(t('pod.e.tooMany'));
    setBusy(true);
    setErr(null);
    try {
      const done: PodDoc[] = [];
      for (const f of files) done.push(await uploadPodFile(f, kind, f.name));
      setD((x) =>
        kind === 'POD_PHOTO'
          ? { ...x, photos: [...x.photos, ...done] }
          : { ...x, files: [...x.files, ...done] },
      );
    } catch (e) {
      setErr(e instanceof ApiError ? problemText(e, t) : t('pod.e.badFile'));
    } finally {
      setBusy(false);
    }
  };

  const signed = async (png: Blob) => {
    setBusy(true);
    setErr(null);
    try {
      const doc = await uploadPodFile(png, 'POD_SIGNATURE', `signature-${Date.now()}.png`);
      put({ signature: doc });
      setSigOpen(false);
    } catch (e) {
      setErr(e instanceof ApiError ? problemText(e, t) : t('pod.e.badFile'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (reason?: string) => {
    setErr(null);
    save.mutate(
      { doId, version, body: { ...body, ...(reason ? { reason } : {}) } },
      {
        onSuccess: (r) => {
          setAsking(false);
          setBase(r);
          setD(draftOf(r));
          setFieldErrs({});
          onToast(
            t('pod.e.saved', {
              no: r.doNo,
              st: t(`pod.e.st.${r.podStatus}` as MessageKey),
            }),
          );
        },
        onError: (e) => {
          setAsking(false);
          if (!(e instanceof ApiError)) return setErr(t('pod.e.saveError'));
          if (e.problem.status === 412) return setErr(t('pod.e.stale'));
          const errs = (e.problem.errors ?? []) as { field: string; code: string }[];
          setFieldErrs(
            Object.fromEntries(
              errs.map((x) => [
                x.field,
                podFieldError(t, x, { pin: pinF?.length, max: rateF?.max }),
              ]),
            ),
          );
          setErr(
            e.problem.code === 'pod_incomplete'
              ? t('pod.e.v.billGate')
              : errs.length && e.problem.code === 'validation_failed'
                ? t('pod.e.v.fix')
                : (problemText(e, t) ?? t('pod.e.saveError')),
          );
        },
      },
    );
  };

  const wNote =
    d.weighedKg && weightDiff(d.weighedKg.replace(/,/g, ''), pod.plannedWeightKg) !== null
      ? t('pod.e.wDiff', { n: weightDiff(d.weighedKg.replace(/,/g, ''), pod.plannedWeightKg)! })
      : t('pod.e.wHint');
  const need = photoF?.level === 'REQUIRED' ? (photoF.minCount ?? 1) : 0;
  const last = pod.versions[0];

  return (
    <>
      {!pod.editable && (
        <span style={{ color: '#3B424C' }} role="note">
          {t(pod.doStatus === 'BILLED' ? 'pod.e.billed' : 'pod.e.notYet')}
        </span>
      )}
      {/* รูปหลักฐานส่ง (ต้นแบบ dox.photos) */}
      <div style={SECTION}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={H3}>
            {t('pod.e.photos')}
            {req(photoF)}
          </h3>
          {!ro && (
            <button
              type="button"
              style={PILL}
              disabled={busy || d.photos.length >= POD_PHOTOS_MAX}
              onClick={() => photoIn.current?.click()}
            >
              <Icon n="upload" s={16} />
              {t('pod.e.uploadPhoto')}
            </button>
          )}
          <input
            ref={photoIn}
            type="file"
            hidden
            multiple
            accept={POD_IMAGE_MIME.join(',')}
            aria-label={t('pod.e.uploadPhoto')}
            onChange={(e) => {
              void upload(e.target.files, 'POD_PHOTO');
              e.target.value = '';
            }}
          />
        </div>
        {d.photos.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8 }}>
            {d.photos.map((p, i) => (
              <div key={p.id} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => void openDocFile(p.id)}
                  title={p.filename ?? ''}
                  style={{
                    width: '100%',
                    aspectRatio: '4/3',
                    border: '1px solid #D9DCD4',
                    borderRadius: 999,
                    background: '#EBEDE8',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    color: '#3B424C',
                    cursor: 'pointer',
                  }}
                >
                  <Icon n="image" s={20} />
                  <span style={{ fontSize: 12 }}>
                    {t('pod.e.photoN', { n: i + 1, time: dt(p.createdAt).slice(-5) })}
                  </span>
                </button>
                {!ro && (
                  <button
                    type="button"
                    aria-label={t('pod.e.removePhoto', { n: i + 1 })}
                    title={t('pod.e.remove')}
                    onClick={() => put({ photos: d.photos.filter((x) => x.id !== p.id) })}
                    style={{
                      ...ROUND_BTN,
                      width: 24,
                      height: 24,
                      position: 'absolute',
                      top: 2,
                      right: 2,
                    }}
                  >
                    <Icon n="x" s={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div
            style={{
              border: '1px dashed #C9CDC3',
              borderRadius: 8,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              textAlign: 'center',
            }}
          >
            <Icon n="camera" s={40} style={{ color: '#C9CDC3' }} />
            <span style={{ fontWeight: 500 }}>{t('pod.e.noPhoto')}</span>
            {need > 0 && (
              <span style={{ color: '#3B424C' }}>{t('pod.e.needPhoto', { n: need })}</span>
            )}
          </div>
        )}
        {fe('photoDocumentIds')}
      </div>

      {/* ลายเซ็นผู้รับ (ต้นแบบ dox.sig) */}
      {(sigF || d.signature) && (
        <div style={SECTION}>
          <h3 style={H3}>
            {t('pod.e.sig')}
            {req(sigF)}
          </h3>
          {d.signature ? (
            <div
              style={{
                height: 72,
                border: '1px solid #D9DCD4',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 14px',
              }}
            >
              <Icon n="pen-line" s={18} style={{ color: '#2257C4' }} />
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{t('pod.e.signed')}</span>
                <span style={{ fontSize: 13, color: '#3B424C' }}>
                  {[
                    d.receiverName.trim() && t('pod.e.khun', { name: d.receiverName.trim() }),
                    dt(d.signature.createdAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <button
                type="button"
                title={t('pod.e.download')}
                aria-label={`${t('pod.e.download')} ${t('pod.e.sig')}`}
                onClick={() => void openDocFile(d.signature!.id)}
                style={ROUND_BTN}
              >
                <Icon n="download" s={18} />
              </button>
              {!ro && (
                <button
                  type="button"
                  title={t('pod.e.remove')}
                  aria-label={t('pod.e.removeSig')}
                  onClick={() => put({ signature: null })}
                  style={ROUND_BTN}
                >
                  <Icon n="x" s={16} />
                </button>
              )}
            </div>
          ) : ro ? (
            <span style={{ color: '#3B424C' }}>{t('pod.e.noSig')}</span>
          ) : (
            <button
              type="button"
              onClick={() => setSigOpen(true)}
              disabled={busy}
              style={{
                height: 72,
                border: '1px dashed #C9CDC3',
                borderRadius: 14,
                background: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: '#2257C4',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <Icon n="pen-line" s={16} />
              {t('pod.e.takeSig')}
            </button>
          )}
          {fe('signatureDocumentId')}
        </div>
      )}

      {/* น้ำหนักชั่ง (ต้นแบบ dox.w) */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={LABEL}>{t('pod.e.weight')}</span>
        <input
          value={d.weighedKg}
          aria-label={t('pod.e.weight')}
          disabled={ro}
          inputMode="decimal"
          placeholder="0"
          onChange={(e) => put({ weighedKg: e.target.value })}
          style={{ ...INPUT, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
        />
        <span style={{ fontSize: 13, color: '#3B424C' }}>{wNote}</span>
      </label>

      {/* ส่วนที่ต้นแบบไม่มี (docs/04 E2 ePOD เว็บ + checklist T05/T06) — DECISION spec/12 §3 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={LABEL}>{t('pod.e.receiver')}</span>
          <input
            value={d.receiverName}
            disabled={ro}
            maxLength={100}
            placeholder={t('pod.e.receiverPh')}
            onChange={(e) => put({ receiverName: e.target.value })}
            style={INPUT}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={LABEL}>{t('pod.e.relation')}</span>
          <select
            value={d.receiverRelation}
            disabled={ro}
            onChange={(e) => put({ receiverRelation: e.target.value })}
            style={INPUT}
          >
            <option value="">{t('pod.e.relationPick')}</option>
            {RELATIONS.map((r) => (
              <option key={r} value={r}>
                {t(`pod.e.rel.${r}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={LABEL}>{t('pod.e.custRef')}</span>
        <input
          value={d.customerRef}
          disabled={ro}
          maxLength={50}
          placeholder={t('pod.e.custRefPh')}
          onChange={(e) => put({ customerRef: e.target.value })}
          style={INPUT}
        />
      </label>

      {customs.map((f) =>
        f.type === 'BOOLEAN' ? (
          <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              disabled={ro}
              checked={d.checks[f.key] === true}
              onChange={(e) => put({ checks: { ...d.checks, [f.key]: e.target.checked } })}
              style={{ width: 16, height: 16, accentColor: '#2257C4' }}
            />
            <span>
              {f.label}
              {req(f)}
            </span>
            {fe(`checks.${f.key}`)}
          </label>
        ) : (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={LABEL}>
              {f.label}
              {req(f)}
            </span>
            <select
              value={d.choices[f.key] ?? ''}
              disabled={ro}
              onChange={(e) => put({ choices: { ...d.choices, [f.key]: e.target.value } })}
              style={INPUT}
            >
              <option value="">{t('pod.e.choicePick')}</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {fe(`choices.${f.key}`)}
          </label>
        ),
      )}
      {barF && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={LABEL}>
            {t('pod.type.BARCODE')}
            {req(barF)}
          </span>
          <textarea
            className="tms-textarea"
            rows={2}
            disabled={ro}
            value={d.barcodes}
            placeholder={t('pod.e.barcodePh')}
            onChange={(e) => put({ barcodes: e.target.value })}
          />
          {fe('barcodes', 'scanCodes')}
        </label>
      )}
      {(pinF || rateF) && (
        <div
          style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}
        >
          {pinF ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={LABEL}>
                {t('pod.type.PIN')}
                {req(pinF)}
              </span>
              <input
                type="password"
                autoComplete="off"
                inputMode="numeric"
                disabled={ro}
                maxLength={pinF.length ?? 8}
                value={d.pin}
                placeholder={pod.current?.pinMasked ?? t('pod.e.pinPh', { n: pinF.length ?? 4 })}
                onChange={(e) => put({ pin: e.target.value.replace(/\D/g, ''), pinClear: false })}
                style={{ ...INPUT, fontVariantNumeric: 'tabular-nums' }}
              />
              {fe('pin')}
              {!ro && base.current?.pinMasked && !d.pin && (
                <span style={{ fontSize: 12.5, color: '#3B424C' }}>
                  {d.pinClear ? t('pod.e.pinWillClear') : t('pod.e.pinKept')}{' '}
                  <button
                    type="button"
                    onClick={() => put({ pinClear: !d.pinClear })}
                    style={{
                      border: 0,
                      background: 'transparent',
                      padding: 0,
                      color: '#2257C4',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {d.pinClear ? t('pod.e.pinUndo') : t('pod.e.pinClear')}
                  </button>
                </span>
              )}
              {base.current?.pinUnreadable && (
                <span className="tms-field-error">{t('pod.e.pinUnreadable')}</span>
              )}
            </label>
          ) : (
            <span />
          )}
          {rateF && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={LABEL}>
                {t('pod.type.RATING')}
                {req(rateF)}
              </span>
              <select
                value={d.rating}
                disabled={ro}
                onChange={(e) => put({ rating: e.target.value })}
                style={INPUT}
              >
                <option value="">{t('pod.e.ratingPick')}</option>
                {Array.from({ length: rateF.max ?? 5 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {t('pod.e.ratingN', { n, max: rateF.max ?? 5 })}
                  </option>
                ))}
              </select>
              {fe('rating')}
            </label>
          )}
        </div>
      )}
      {(noteF || d.note) && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={LABEL}>
            {t('pod.type.NOTE')}
            {req(noteF)}
          </span>
          <textarea
            className="tms-textarea"
            rows={2}
            maxLength={500}
            disabled={ro}
            value={d.note}
            onChange={(e) => put({ note: e.target.value })}
          />
          {fe('note')}
        </label>
      )}

      {/* ไฟล์แนบอื่น (ใบส่งของที่เซ็นแล้ว ใบชั่ง) — แถวเอกสารแบบต้นแบบ */}
      <div style={SECTION}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={H3}>{t('pod.e.files')}</h3>
          {!ro && (
            <button
              type="button"
              style={PILL}
              disabled={busy || d.files.length >= POD_FILES_MAX}
              onClick={() => fileIn.current?.click()}
            >
              <Icon n="paperclip" s={16} />
              {t('pod.e.attach')}
            </button>
          )}
          <input
            ref={fileIn}
            type="file"
            hidden
            multiple
            accept={POD_FILE_MIME.join(',')}
            aria-label={t('pod.e.attach')}
            onChange={(e) => {
              void upload(e.target.files, 'POD_FILE');
              e.target.value = '';
            }}
          />
        </div>
        {d.files.map((f) => (
          <div key={f.id} style={DOC_ROW}>
            <Icon
              n={f.mime === 'application/pdf' ? 'file-text' : 'image'}
              s={18}
              style={{ color: '#59606B' }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {f.filename ?? f.id}
              </span>
              <span style={{ fontSize: 12, color: '#3B424C' }}>{`${ext(f)} · ${kb(f.bytes)}`}</span>
            </div>
            <button
              type="button"
              title={t('pod.e.download')}
              aria-label={`${t('pod.e.download')} ${f.filename ?? ''}`}
              onClick={() => void openDocFile(f.id)}
              style={ROUND_BTN}
            >
              <Icon n="download" s={18} />
            </button>
            {!ro && (
              <button
                type="button"
                title={t('pod.e.remove')}
                aria-label={`${t('pod.e.remove')} ${f.filename ?? ''}`}
                onClick={() => put({ files: d.files.filter((x) => x.id !== f.id) })}
                style={ROUND_BTN}
              >
                <Icon n="x" s={16} />
              </button>
            )}
          </div>
        ))}
        {!d.files.length && <span style={{ color: '#3B424C' }}>{t('pod.e.noFiles')}</span>}
        {fe('fileDocumentIds')}
      </div>

      {/* สถานะ + สิ่งที่ขาด + ฉบับ */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          paddingTop: 12,
          borderTop: '1px solid #E4E6E0',
        }}
      >
        {pod.missing.length > 0 ? (
          <span style={{ color: '#3B424C' }} data-testid="pod-missing">
            {t('pod.e.missing', {
              list: pod.missing.map((m) => missingText(t, m, fields)).join(', '),
            })}
          </span>
        ) : (
          <span style={{ color: '#17733F' }} data-testid="pod-missing">
            {t('pod.e.complete')}
          </span>
        )}
        {last && (
          <span style={{ fontSize: 12.5, color: '#59606B' }}>
            {t('pod.e.version', {
              v: last.version,
              who: last.recordedByName ?? t('pod.e.system'),
              at: dt(last.recordedAt),
            })}
            {last.reason ? ` · ${last.reason}` : ''}
          </span>
        )}
        {stale && dirty && (
          <span
            role="alert"
            style={{
              color: '#B3322A',
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {t('pod.e.stale')}
            <button type="button" style={PILL} onClick={reload}>
              <Icon n="refresh-cw" s={14} />
              {t('pod.e.reload')}
            </button>
          </span>
        )}
        {err && !(stale && dirty && err === t('pod.e.stale')) && (
          <span className="tms-field-error" role="alert">
            {err}
          </span>
        )}
        {!ro && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="tms-drawer__pri"
              style={{ height: 36, padding: '0 16px' }}
              disabled={busy || save.isPending || !dirty || stale}
              onClick={() => (base.current ? setAsking(true) : submit())}
            >
              <Icon n="circle-check" s={16} />
              {t('pod.e.save')}
            </button>
          </div>
        )}
      </div>
      {sigOpen && (
        <SignatureDialog busy={busy} onClose={() => setSigOpen(false)} onOk={signed} error={err} />
      )}
      <ReasonDialog
        open={asking}
        title={t('pod.e.amendTitle')}
        description={t('pod.e.amendDesc')}
        label={t('pod.e.amendReason')}
        placeholder={t('pod.e.amendPh')}
        okLabel={t('pod.e.save')}
        cancelLabel={t('trip.tl.dlg.cancel')}
        closeLabel={t('drawer.close')}
        minLength={POD_REASON_MIN}
        busy={save.isPending}
        error={err}
        onOk={(r) => submit(r)}
        onClose={() => setAsking(false)}
      />
    </>
  );
}

/**
 * dialog เก็บลายเซ็นบนจอ (กรอบ `tms-dialog`; แผ่นเซ็นตามต้นแบบ TMS Driver App M4: สูง 160 ขอบ #D9DCD4 มุม 12,
 * ข้อความ "ให้ผู้รับเซ็นชื่อในกรอบนี้", ปุ่ม "ล้าง" มุมขวาบน) — บันทึกเป็น PNG (kind POD_SIGNATURE)
 */
export function SignatureDialog({
  onOk,
  onClose,
  busy,
  error,
}: {
  onOk: (png: Blob) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const { t } = useI18n();
  const cv = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [has, setHas] = useState(false);
  useEscapeLayer(true, onClose);
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = cv.current!;
    const r = c.getBoundingClientRect();
    return [
      ((e.clientX - r.left) * c.width) / r.width,
      ((e.clientY - r.top) * c.height) / r.height,
    ] as const;
  };
  const ctx = () => {
    const g = cv.current?.getContext('2d');
    if (g) {
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#101418';
    }
    return g;
  };
  const clear = () => {
    const c = cv.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setHas(false);
  };
  const ok = () => {
    const c = cv.current;
    if (!c || !has) return;
    c.toBlob((b) => b && onOk(b), 'image/png');
  };
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('pod.e.takeSig')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{t('pod.e.takeSig')}</h2>
            <p className="tms-dialog__desc">{t('pod.e.sigDesc')}</p>
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
          <div
            style={{
              position: 'relative',
              height: 160,
              border: '1px solid #D9DCD4',
              borderRadius: 12,
              background: '#FFFFFF',
              overflow: 'hidden',
            }}
          >
            <canvas
              ref={cv}
              width={716}
              height={320}
              aria-label={t('pod.e.sigPad')}
              data-testid="sig-pad"
              style={{
                width: '100%',
                height: '100%',
                touchAction: 'none',
                cursor: 'crosshair',
                display: 'block',
              }}
              onPointerDown={(e) => {
                const g = ctx();
                if (!g) return;
                drawing.current = true;
                cv.current!.setPointerCapture?.(e.pointerId);
                const [x, y] = pos(e);
                g.beginPath();
                g.moveTo(x, y);
                g.lineTo(x + 0.1, y + 0.1);
                g.stroke();
                setHas(true);
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return;
                const g = ctx();
                if (!g) return;
                const [x, y] = pos(e);
                g.lineTo(x, y);
                g.stroke();
              }}
              onPointerUp={() => (drawing.current = false)}
              onPointerLeave={() => (drawing.current = false)}
            />
            {!has && (
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  textAlign: 'center',
                  color: '#59606B',
                  pointerEvents: 'none',
                }}
              >
                {t('pod.e.sigHere')}
              </span>
            )}
            {has && (
              <button
                type="button"
                onClick={clear}
                style={{
                  minHeight: 48,
                  padding: '0 12px',
                  border: 0,
                  borderRadius: 999,
                  background: 'transparent',
                  color: '#2257C4',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  position: 'absolute',
                  top: 2,
                  right: 2,
                }}
              >
                {t('pod.e.sigClear')}
              </button>
            )}
          </div>
          {error && (
            <span className="tms-field-error" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('trip.tl.dlg.cancel')}
          </button>
          <button
            type="button"
            className="tms-drawer__pri"
            style={{ height: 36, padding: '0 16px' }}
            disabled={!has || busy}
            onClick={ok}
          >
            {t('pod.e.sigOk')}
          </button>
        </div>
      </div>
    </div>
  );
}
