import { useRef, useState } from 'react';
import { ApiError } from '../api';
import { useI18n } from '../i18n';
import { podFieldName } from '../features/pod/PodChecklistTable';
import {
  currentPosition,
  linkMilli,
  linkQtyState,
  nowBangkokIso,
  podClientEventId,
  podLinkBody,
  podLinkLines,
  podLinkMissing,
  POD_LINK_IMAGE_MIME,
  retryOf,
  stepQty,
  uploadPodLinkFile,
  usePodCapture,
  usePodEvent,
  type PodDo,
  type PodLinkDraft,
  type PodLinkField,
  type PodStep,
} from './podLinkApi';

const EMPTY: Omit<PodLinkDraft, 'photos' | 'signed'> = {
  note: '',
  checks: {},
  choices: {},
  barcodes: '',
  pin: '',
  rating: null,
};

/**
 * ส่ง POD ของ DO ผ่านลิงก์งาน (ST4-T09 — docs/04 E2 "ePOD ผ่านลิงก์", E2.1 M10)
 * ต้นแบบ TMS Subcon แท็บ "ส่ง POD": รูป grid 3 คอลัมน์ "รูปที่ n" + "+ เพิ่มรูป" → ข้อความช่วย → ปุ่ม "ส่ง POD" (56px)
 * ส่วนที่ต้นแบบไม่มี [DECISION spec/12 §3]: แผ่นเซ็นแบบ TMS Driver App M4 ใต้ข้อความช่วย, ข้อบังคับอื่นของ checklist
 * (เฉพาะที่ "บังคับ"), ปุ่ม × ลบรูป · รูป ≤ 5 · CLOSE = ปิดงานจุดส่ง + POD ในคำขอเดียว (clientEventId คงที่) · SUBMIT = ส่ง POD อย่างเดียว
 */
export function PodLinkCapture({
  token,
  m,
  say,
  onDone,
}: {
  token: string;
  m: PodDo;
  say: (msg: string) => void;
  onDone: (doNo: string) => void;
}) {
  const { t } = useI18n();
  const pod = m.pod;
  const fields = pod.fields;
  const max = pod.photosMax;
  const sigField = fields.find((f) => f.type === 'SIGNATURE');
  const extras = fields.filter(
    (f) => f.level === 'REQUIRED' && !['PHOTO', 'SIGNATURE'].includes(f.type),
  );
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [signed, setSigned] = useState(false);
  const [sigId, setSigId] = useState<string | null>(null);
  const [d, setD] = useState(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  // ST4-T10 ยอดส่งจริง (ค่าเริ่ม = แผน) + เหตุผลปฏิเสธรับ
  const lines = pod.lines ?? [];
  const [qty, setQty] = useState<Record<number, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.lineNo, l.qtyPlanned])),
  );
  const [reason, setReason] = useState<string | null>(null);
  const [rNote, setRNote] = useState('');
  const qs = linkQtyState(lines, qty);
  const rsn = (pod.rejectReasons ?? []).find((r) => r.id === reason);
  const fileRef = useRef<HTMLInputElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const sending = useRef(false);
  const event = usePodEvent(token);
  const capture = usePodCapture(token);
  const busy = event.isPending || capture.isPending;

  const draft: PodLinkDraft = { ...d, photos: photos.length, signed };
  const missing = podLinkMissing(fields, draft);
  const photoMin = fields.find((f) => f.type === 'PHOTO' && f.level === 'REQUIRED');

  const pick = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (fileRef.current) fileRef.current.value = '';
    if (!files.length) return;
    setErr(null);
    const room = max - photos.length;
    // รูปที่ 6 ขึ้นไปไม่อัปโหลด (API ปฏิเสธเช่นกัน)
    if (files.length > room) setErr(t('pdl.pod.maxPhotos', { n: max }));
    setUploading(true);
    try {
      for (const f of files.slice(0, Math.max(room, 0))) {
        const id = await uploadPodLinkFile(token, m.doNo, f, 'POD_PHOTO', f.name || 'pod.jpg');
        setPhotos((x) => [...x, id]);
      }
    } catch (e) {
      setErr(
        e instanceof ApiError && e.problem.status === 429
          ? t('cdl.v.tooMany')
          : e instanceof ApiError && e.problem.code === 'pod_exists'
            ? t('pdl.pod.e.exists')
            : t('pdl.pod.badFile'),
      );
    } finally {
      setUploading(false);
    }
  };

  // แผ่นเซ็น (ต้นแบบ TMS Driver App M4) — วาดใหม่ = ต้องอัปโหลดลายเซ็นใหม่
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = cv.current!;
    const r = c.getBoundingClientRect();
    return [
      ((e.clientX - r.left) * c.width) / (r.width || 1),
      ((e.clientY - r.top) * c.height) / (r.height || 1),
    ] as const;
  };
  const g = () => {
    const x = cv.current?.getContext('2d');
    if (x) {
      x.lineWidth = 4;
      x.lineCap = 'round';
      x.lineJoin = 'round';
      x.strokeStyle = '#101418';
    }
    return x;
  };
  const clearSig = () => {
    const c = cv.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setSigned(false);
    setSigId(null);
  };
  const sigBlob = () =>
    new Promise<Blob | null>((resolve) => {
      const c = cv.current;
      if (!c?.toBlob) return resolve(null);
      c.toBlob((b) => resolve(b), 'image/png');
    });

  const errText = (e: unknown): string => {
    if (e instanceof Error && e.message === 'bad_file') return t('pdl.pod.badFile');
    if (!(e instanceof ApiError)) return t('pdl.e.failed');
    const p = e.problem as { status: number; code?: string; errors?: { field?: string }[] };
    if (p.status === 429) return t('cdl.v.tooMany');
    if (p.code === 'pod_incomplete') {
      const keys = new Set(
        ((p as { missing?: { key: string }[] }).missing ?? []).map((x) => x.key),
      );
      const list = fields.filter((f) => keys.has(f.key)).map((f) => podFieldName(t, f));
      return t('pdl.pod.e.incomplete', { list: list.join(', ') || '—' });
    }
    if (p.code === 'pod_exists') return t('pdl.pod.e.exists');
    const codes = (p.errors ?? []) as { field?: string; code?: string }[];
    if (codes.some((x) => x.code === 'reason_required')) return t('pdl.q.e.reason');
    if (codes.some((x) => x.code === 'note_required')) return t('pdl.q.e.note');
    if (codes.some((x) => x.code === 'photo_required')) return t('pdl.q.e.photo');
    if (codes.some((x) => /(^|\.)lines\./.test(x.field ?? ''))) return t('pdl.q.e.qty');
    if (p.code === 'stop_not_arrived') return t('pdl.pod.e.notArrived');
    if (p.code === 'stop_not_ready') return t('pdl.pod.e.notReady');
    if (p.code === 'stop_already_closed') return t('pdl.pod.e.alreadyClosed');
    if (p.code === 'pod_not_allowed') return t('pdl.pod.e.notAllowed');
    if (p.code === 'trip_not_in_progress') return t('pdl.e.notInProgress');
    if (p.code === 'validation_failed' && p.errors?.some((x) => /Document/.test(x.field ?? '')))
      return t('pdl.pod.e.files');
    return t('pdl.e.failed');
  };

  const submit = async () => {
    if (sending.current || uploading) return;
    setErr(null);
    // ต้นแบบ: ไม่มีรูป → toast "แนบรูปอย่างน้อย 1 รูป"
    const needPhoto = missing.find((f) => f.type === 'PHOTO');
    if (needPhoto) {
      const n = needPhoto.minCount ?? 1;
      say(n > 1 ? t('pdl.pod.needPhotoN', { n }) : t('pdl.pod.needPhoto'));
      return;
    }
    if (missing.some((f) => f.type === 'SIGNATURE')) {
      say(t('pdl.pod.needSig'));
      return;
    }
    if (missing.length) {
      setErr(t('pdl.pod.missing', { list: missing.map((f) => podFieldName(t, f)).join(', ') }));
      return;
    }
    // ST4-T10: ส่งน้อยกว่าแผนต้องเลือกเหตุผล (+ โน้ตตามที่เหตุผลบังคับ)
    if (qs.bad) return setErr(t('pdl.q.e.qty'));
    if (qs.short && !reason) return setErr(t('pdl.q.e.reason'));
    if (qs.short && rsn?.requiresNote && !rNote.trim()) return setErr(t('pdl.q.e.note'));
    sending.current = true;
    try {
      let sig = sigId;
      if (signed && !sig) {
        const b = await sigBlob();
        if (!b) throw new Error('bad_file');
        sig = await uploadPodLinkFile(token, m.doNo, b, 'POD_SIGNATURE', 'signature.png');
        setSigId(sig);
      }
      const body = podLinkBody(m.doNo, fields, draft, { photos, signature: sig });
      const ls = podLinkLines(lines, qty, reason, rNote);
      if (ls) body.lines = ls;
      if (pod.mode === 'CLOSE' && m.delivery) {
        const step: PodStep = { stopId: m.delivery.id, type: 'COMPLETE' };
        const p = await currentPosition();
        await event.mutateAsync({
          stopId: step.stopId,
          body: {
            type: 'COMPLETE',
            outcome: 'DELIVERED',
            // คงที่ต่อ (ลิงก์, จุด, COMPLETE) — เน็ตหลุดแล้วกดใหม่ได้ผลเดิม
            clientEventId: await podClientEventId(token, step, retryOf(m, step)),
            occurredAt: nowBangkokIso(),
            pod: body,
            ...(p ?? {}),
          },
        });
      } else await capture.mutateAsync(body);
      onDone(m.doNo);
    } catch (e) {
      setErr(errText(e));
    } finally {
      sending.current = false;
    }
  };

  const set = (patch: Partial<typeof EMPTY>) => setD((x) => ({ ...x, ...patch }));

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        hidden
        multiple
        accept={POD_LINK_IMAGE_MIME.join(',')}
        data-testid="pdl-photo-input"
        onChange={(e) => void pick(e.target.files)}
      />
      <div className="cdl__photos" data-testid="pdl-photos">
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
        {photos.length < max && (
          <button
            type="button"
            className="cdl__add"
            data-testid="pdl-add-photo"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? t('pdl.pod.uploading') : t('pdl.pod.add')}
          </button>
        )}
      </div>
      <span className="cdl__muted">{t('pdl.pod.hint')}</span>
      {sigField && (
        <div className="cdl__label">
          <span>{t('pdl.pod.sig')}</span>
          <div className="pdl__sig">
            <canvas
              ref={cv}
              width={716}
              height={320}
              aria-label={t('pdl.pod.sigPad')}
              data-testid="pdl-sig"
              onPointerDown={(e) => {
                drawing.current = true;
                cv.current!.setPointerCapture?.(e.pointerId);
                setSigned(true);
                setSigId(null);
                const x = g();
                if (!x) return;
                const [px, py] = pos(e);
                x.beginPath();
                x.moveTo(px, py);
                x.lineTo(px + 0.1, py + 0.1);
                x.stroke();
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return;
                const x = g();
                if (!x) return;
                const [px, py] = pos(e);
                x.lineTo(px, py);
                x.stroke();
              }}
              onPointerUp={() => (drawing.current = false)}
              onPointerLeave={() => (drawing.current = false)}
            />
            {!signed && <span className="pdl__sigph">{t('pdl.pod.sigHere')}</span>}
            {signed && (
              <button type="button" className="pdl__sigclr" onClick={clearSig}>
                {t('pdl.pod.sigClear')}
              </button>
            )}
          </div>
        </div>
      )}
      {lines.length > 0 && (
        <div className="cdl__label" data-testid="pdl-qty">
          <span>{t('pdl.q.title')}</span>
          <div className="pdl__qty">
            {lines.map((l) => {
              const v = qty[l.lineNo] ?? l.qtyPlanned;
              const a = linkMilli(v);
              const short = a !== null && a < (linkMilli(l.qtyPlanned) ?? 0n);
              return (
                <div key={l.lineNo} className="pdl__qrow">
                  <span className="pdl__qname">
                    <span>{l.description}</span>
                    <span className="pdl__qplan cdl__num">
                      {t('pdl.q.plan', { n: l.qtyPlanned, u: l.unit })}
                    </span>
                  </span>
                  <span className="pdl__step">
                    <button
                      type="button"
                      className="pdl__stepbtn"
                      title={t('pdl.q.dec')}
                      aria-label={`${t('pdl.q.dec')} ${l.description}`}
                      onClick={() =>
                        setQty((x) => ({ ...x, [l.lineNo]: stepQty(v, l.qtyPlanned, -1) }))
                      }
                    >
                      −
                    </button>
                    <input
                      className={`pdl__qin cdl__num${short ? ' pdl__qin--short' : ''}`}
                      inputMode="decimal"
                      aria-label={t('pdl.q.input', { name: l.description })}
                      value={v}
                      onChange={(e) => setQty((x) => ({ ...x, [l.lineNo]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="pdl__stepbtn"
                      title={t('pdl.q.inc')}
                      aria-label={`${t('pdl.q.inc')} ${l.description}`}
                      onClick={() =>
                        setQty((x) => ({ ...x, [l.lineNo]: stepQty(v, l.qtyPlanned, 1) }))
                      }
                    >
                      +
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
          {qs.short && <span className="pdl__short">{t('pdl.q.short')}</span>}
        </div>
      )}
      {lines.length > 0 && qs.short && (
        <div className="cdl__label" data-testid="pdl-reasons">
          <span>{t('pdl.q.reason')}</span>
          <div className="pdl__opts">
            {(pod.rejectReasons ?? []).map((r) => (
              <button
                key={r.id}
                type="button"
                className="pdl__opt"
                aria-pressed={reason === r.id}
                onClick={() => {
                  setReason(r.id);
                  // QA L2: ข้อความเตือนเรื่องเหตุผลของรอบก่อนไม่ค้าง
                  setErr(null);
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          {rsn?.requiresNote && (
            <textarea
              className="cdl__input pdl__area"
              maxLength={500}
              aria-label={t('pdl.q.note')}
              placeholder={t('pdl.q.note')}
              value={rNote}
              onChange={(e) => setRNote(e.target.value)}
            />
          )}
        </div>
      )}
      {extras.map((f) => (
        <Extra key={f.key} f={f} d={d} set={set} />
      ))}
      {err && (
        <span className="cdl__err" role="alert" data-testid="pdl-pod-err">
          {err}
        </span>
      )}
      <button
        type="button"
        className="cdl__primary"
        data-testid="pdl-pod-submit"
        disabled={busy}
        style={{ opacity: photoMin && photos.length === 0 ? 0.5 : undefined }}
        onClick={() => void submit()}
      >
        {t('pdl.pod.submit')}
      </button>
    </>
  );
}

/** ข้อบังคับอื่นของ checklist (ต้นแบบไม่มี — ใช้ช่อง/ปุ่มตัวเลือกของ TMS Subcon) */
function Extra({
  f,
  d,
  set,
}: {
  f: PodLinkField;
  d: typeof EMPTY;
  set: (p: Partial<typeof EMPTY>) => void;
}) {
  const { t } = useI18n();
  if (f.type === 'BOOLEAN')
    return (
      <div className="pdl__opts">
        <button
          type="button"
          className="pdl__opt"
          aria-pressed={d.checks[f.key] === true}
          onClick={() => set({ checks: { ...d.checks, [f.key]: d.checks[f.key] !== true } })}
        >
          {f.label}
        </button>
      </div>
    );
  if (f.type === 'SINGLE_CHOICE')
    return (
      <div className="cdl__label">
        <span>{f.label}</span>
        <div className="pdl__opts">
          {(f.options ?? []).map((o) => (
            <button
              key={o}
              type="button"
              className="pdl__opt"
              aria-pressed={d.choices[f.key] === o}
              onClick={() => set({ choices: { ...d.choices, [f.key]: o } })}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
    );
  if (f.type === 'RATING')
    return (
      <div className="cdl__label">
        <span>{t('pdl.pod.rating')}</span>
        <div className="pdl__opts pdl__opts--row">
          {Array.from({ length: f.max ?? 5 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              className="pdl__opt cdl__num"
              aria-pressed={d.rating === n}
              onClick={() => set({ rating: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    );
  if (f.type === 'PIN')
    return (
      <label className="cdl__label">
        <span>{t('pdl.pod.pin')}</span>
        <input
          className="cdl__input cdl__num"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={f.length ?? 4}
          placeholder={t('pdl.pod.pinPh', { n: f.length ?? 4 })}
          value={d.pin}
          onChange={(e) => set({ pin: e.target.value.replace(/\D/g, '') })}
        />
      </label>
    );
  const area = (label: string, key: 'note' | 'barcodes', ph?: string, max = 1000) => (
    <label className="cdl__label">
      <span>{label}</span>
      <textarea
        className="cdl__input pdl__area"
        maxLength={max}
        placeholder={ph}
        value={d[key]}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </label>
  );
  if (f.type === 'NOTE') return area(t('pdl.pod.note'), 'note', undefined, 500);
  if (f.type === 'BARCODE')
    return area(t('pdl.pod.barcodes'), 'barcodes', t('pdl.pod.barcodesPh'), 10_000);
  return null;
}
